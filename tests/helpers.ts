import { randomUUID } from "node:crypto";
import request from "supertest";
import { app } from "../src/app.js";
import { pool } from "../src/config/database.js";

export const api = () => request(app);

// A fresh request id for every call that does not care about it.
export const rid = () => randomUUID();

export interface TestAccount {
  id: string;
  name: string;
  apiKey: string;
}

export interface Limits {
  monthly: number;
  max: number;
}

export const auth = (account: TestAccount) => ({ "X-API-Key": account.apiKey });

const ADMIN_KEY = process.env.ADMIN_BOOTSTRAP_KEY ?? "";

const createdAccountIds: string[] = [];

function mustSucceed(
  res: { status: number; body: unknown },
  what: string
): void {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${what} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

// ---------- Setup helpers ----------

export async function createAccount(planName = "Starter"): Promise<TestAccount> {
  const name = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const res = await api()
    .post("/accounts")
    .set("X-Admin-Key", ADMIN_KEY)
    .send({ name, planName });

  mustSucceed(res, "create account");

  const id = res.body.account.id as string;
  createdAccountIds.push(id);

  return { id, name, apiKey: res.body.apiKey as string };
}

export async function predefinedPlanId(
  account: TestAccount,
  name: string,
  planType: "account" | "user"
): Promise<string> {
  const res = await api()
    .get(`/plans?type=${planType}`)
    .set(auth(account));

  mustSucceed(res, "list plans");

  const plan = (
    res.body.plans as Array<{ id: string; name: string; isPredefined: boolean }>
  ).find((p) => p.name === name && p.isPredefined);

  if (!plan) throw new Error(`Predefined ${planType} plan "${name}" not found`);
  return plan.id;
}

export async function createCustomPlan(
  account: TestAccount,
  name: string,
  planType: "account" | "user",
  limits: Limits
): Promise<{ id: string }> {
  const res = await api()
    .post("/plans")
    .set(auth(account))
    .send({
      name,
      planType,
      monthlyAllowance: limits.monthly,
      maxUnitsPerRequest: limits.max,
    });

  mustSucceed(res, `create plan ${name}`);
  return res.body.plan as { id: string };
}

export async function createUser(
  account: TestAccount,
  externalUserId: string,
  planId: string
): Promise<string> {
  const res = await api()
    .post("/users")
    .set(auth(account))
    .send({ externalUserId, planId });

  mustSucceed(res, `create user ${externalUserId}`);
  return res.body.user.id as string;
}

export interface Scenario {
  account: TestAccount;
  accountPlanId: string;
  userPlanId: string;
  // externalUserId -> internal user id
  users: Record<string, string>;
}

// A new account with its own account plan and one shared user plan,
// plus the requested users (all on that user plan).
export async function setupAccount(opts: {
  account: Limits;
  user: Limits;
  users?: string[];
}): Promise<Scenario> {
  const account = await createAccount();

  const accountPlan = await createCustomPlan(
    account,
    "account-plan",
    "account",
    opts.account
  );

  const switched = await api()
    .put("/accounts/me/plan")
    .set(auth(account))
    .send({ planId: accountPlan.id });
  mustSucceed(switched, "assign account plan");

  const userPlan = await createCustomPlan(account, "user-plan", "user", opts.user);

  const users: Record<string, string> = {};
  for (const externalUserId of opts.users ?? ["u1"]) {
    users[externalUserId] = await createUser(account, externalUserId, userPlan.id);
  }

  return {
    account,
    accountPlanId: accountPlan.id,
    userPlanId: userPlan.id,
    users,
  };
}

// ---------- Action helpers ----------

export const consume = (
  account: TestAccount,
  externalUserId: string,
  units: number,
  requestId: string
) =>
  api()
    .post("/usage/consume")
    .set(auth(account))
    .send({ externalUserId, units, requestId });

// ---------- Month helpers ----------

// "YYYY-MM" for the current UTC month plus an offset in months.
export function utcMonth(offset = 0): string {
  const now = new Date();
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)
  );
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Writes usage for the previous UTC month straight into the database,
// because the API can only ever record usage for the current month.
export async function seedPreviousMonthUsage(
  accountId: string,
  userId: string,
  units: number
): Promise<void> {
  await pool.query(
    `
    INSERT INTO usage_counters (account_id, user_id, month_start, consumed_units)
    VALUES
      ($1, NULL,
       (date_trunc('month', now() AT TIME ZONE 'UTC') - INTERVAL '1 month')::date,
       $3),
      ($1, $2,
       (date_trunc('month', now() AT TIME ZONE 'UTC') - INTERVAL '1 month')::date,
       $3)
    `,
    [accountId, userId, units]
  );
}

// Current-month counters straight from the database, to check the invariant
// "account total = sum of its users".
export async function counterTotals(accountId: string) {
  const res = await pool.query<{ account_total: number; users_sum: number }>(
    `
    SELECT
      COALESCE(MAX(consumed_units) FILTER (WHERE user_id IS NULL), 0)::bigint
        AS account_total,
      COALESCE(SUM(consumed_units) FILTER (WHERE user_id IS NOT NULL), 0)::bigint
        AS users_sum
    FROM usage_counters
    WHERE account_id = $1
      AND month_start = (date_trunc('month', now() AT TIME ZONE 'UTC'))::date
    `,
    [accountId]
  );

  return res.rows[0]!;
}

// ---------- Cleanup ----------

// Removes everything the test accounts created. Call it in afterAll.
export async function teardown(): Promise<void> {
  const ids = createdAccountIds.splice(0);

  if (ids.length > 0) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM consumption_requests WHERE account_id = ANY($1::uuid[])`,
        [ids]
      );
      await client.query(
        `DELETE FROM usage_counters WHERE account_id = ANY($1::uuid[])`,
        [ids]
      );
      await client.query(
        `DELETE FROM users WHERE account_id = ANY($1::uuid[])`,
        [ids]
      );
      // An account may point at its own custom plan, and that plan points back
      // at the account. Re-point the account at a predefined plan first.
      await client.query(
        `
        UPDATE accounts
        SET plan_id = (
          SELECT id FROM plans
          WHERE is_predefined = TRUE AND plan_type = 'account'
          LIMIT 1
        )
        WHERE id = ANY($1::uuid[])
        `,
        [ids]
      );
      await client.query(
        `DELETE FROM plans WHERE owner_account_id = ANY($1::uuid[])`,
        [ids]
      );
      await client.query(
        `DELETE FROM accounts WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.warn("Test cleanup failed:", error);
    } finally {
      client.release();
    }
  }

  await pool.end();
}
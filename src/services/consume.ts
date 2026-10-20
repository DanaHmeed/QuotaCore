import type { PoolClient } from "pg";
import { pool } from "../config/database.js";
import {
  evaluate,
  remainingUnits,
  type LevelState,
  type Rejection,
  type Rule,
  type Scope,
} from "../domain/quota.js";

// Current UTC calendar month. now() is fixed for the whole transaction,
// so every statement below agrees on which month it is.
const MONTH_START = `(date_trunc('month', now() AT TIME ZONE 'UTC'))::date`;

export interface ConsumeInput {
  accountId: string;
  externalUserId: string;
  units: number;
  requestId: string;
}

export interface ConsumeDecision {
  accepted: boolean;
  rejection: Rejection | null;
  replayed: boolean;
  remaining: { account: number; user: number };
}

export type ConsumeOutcome =
  | { kind: "decision"; decision: ConsumeDecision }
  | { kind: "user_not_found" }
  | { kind: "request_id_conflict" };

interface CounterRow {
  consumed_units: number;
}

// Current limits and, when this requestId was seen before, the stored
// decision. Both come back from one query.
interface StateRow {
  account_allowance: number;
  account_max: number;
  user_allowance: number;
  user_max: number;
  has_previous: boolean;
  previous_user_id: string | null;
  previous_units: number | null;
  previous_accepted: boolean | null;
  previous_scope: Scope | null;
  previous_rule: Rule | null;
}

function remainingAfter(level: LevelState, applied: number): number {
  return remainingUnits({
    ...level,
    consumedUnits: level.consumedUnits + applied,
  });
}

export async function consumeUnits(input: ConsumeInput): Promise<ConsumeOutcome> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const outcome = await decide(client, input);
    await client.query("COMMIT");
    return outcome;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function decide(
  client: PoolClient,
  input: ConsumeInput
): Promise<ConsumeOutcome> {
  const { accountId, externalUserId, units, requestId } = input;

  // 1. Resolve the user INSIDE the authenticated account.
  const userRes = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE account_id = $1 AND external_user_id = $2`,
    [accountId, externalUserId]
  );
  const userRow = userRes.rows[0];
  if (!userRow) {
    return { kind: "user_not_found" };
  }
  const userId = userRow.id;

  // 2. Make sure this month's counters exist (account-level and user-level).
  await client.query(
    `
    INSERT INTO usage_counters (account_id, user_id, month_start)
    VALUES ($1, NULL, ${MONTH_START}), ($1, $2, ${MONTH_START})
    ON CONFLICT DO NOTHING
    `,
    [accountId, userId]
  );

  // 3. Lock the counters. ALWAYS account first, then user: a fixed lock
  //    order means two transactions can never wait on each other (no deadlock).
  //    Because every request of an account locks the account counter first,
  //    requests of the same account are processed one at a time.
  const accountCounter = await client.query<CounterRow>(
    `
    SELECT consumed_units FROM usage_counters
    WHERE account_id = $1 AND user_id IS NULL
      AND month_start = ${MONTH_START}
    FOR UPDATE
    `,
    [accountId]
  );
  const userCounter = await client.query<CounterRow>(
    `
    SELECT consumed_units FROM usage_counters
    WHERE account_id = $1 AND user_id = $2
      AND month_start = ${MONTH_START}
    FOR UPDATE
    `,
    [accountId, userId]
  );

  // 4. One query, after the locks: the CURRENT limits (so plan changes that
  //    were already committed are always seen) and the stored decision for
  //    this requestId, if any. It runs after the account lock, so two
  //    concurrent retries of the same requestId can never both pass it.
  const stateRes = await client.query<StateRow>(
    `
    SELECT ap.monthly_allowance AS account_allowance,
           ap.max_units_per_request AS account_max,
           up.monthly_allowance AS user_allowance,
           up.max_units_per_request AS user_max,
           (r.id IS NOT NULL) AS has_previous,
           r.user_id AS previous_user_id,
           r.requested_units AS previous_units,
           r.accepted AS previous_accepted,
           r.rejection_scope AS previous_scope,
           r.rejection_rule AS previous_rule
    FROM accounts a
    JOIN plans ap ON ap.id = a.plan_id
    JOIN users u ON u.id = $2 AND u.account_id = a.id
    JOIN plans up ON up.id = u.plan_id
    LEFT JOIN consumption_requests r
      ON r.account_id = a.id AND r.request_id = $3
    WHERE a.id = $1
    `,
    [accountId, userId, requestId]
  );

  const state = stateRes.rows[0];
  const accountUsed = accountCounter.rows[0];
  const userUsed = userCounter.rows[0];

  if (!state || !accountUsed || !userUsed) {
    throw new Error("Inconsistent state: missing limits or counters");
  }

  const account: LevelState = {
    monthlyAllowance: state.account_allowance,
    maxUnitsPerRequest: state.account_max,
    consumedUnits: accountUsed.consumed_units,
  };
  const user: LevelState = {
    monthlyAllowance: state.user_allowance,
    maxUnitsPerRequest: state.user_max,
    consumedUnits: userUsed.consumed_units,
  };

  // 5. Idempotency.
  if (state.has_previous) {
    if (state.previous_user_id !== userId || state.previous_units !== units) {
      return { kind: "request_id_conflict" };
    }

    const wasAccepted = state.previous_accepted === true;

    return {
      kind: "decision",
      decision: {
        accepted: wasAccepted,
        // The CHECK constraint guarantees scope/rule exist when rejected.
        rejection: wasAccepted
          ? null
          : { scope: state.previous_scope!, rule: state.previous_rule! },
        replayed: true,
        remaining: {
          account: remainingUnits(account),
          user: remainingUnits(user),
        },
      },
    };
  }

  // 6. Decide.
  const rejection = evaluate(units, account, user);
  const accepted = rejection === null;
  const applied = accepted ? units : 0;

  // 7. Write everything in ONE statement: add the units to both counters
  //    (only when accepted) and record the outcome, accepted or rejected.
  //    A data-modifying CTE always runs to completion, even though the main
  //    INSERT does not read its output.
  await client.query(
    `
    WITH bump AS (
      UPDATE usage_counters
      SET consumed_units = consumed_units + $3
      WHERE $5::boolean
        AND account_id = $1
        AND month_start = ${MONTH_START}
        AND (user_id IS NULL OR user_id = $2)
      RETURNING 1
    )
    INSERT INTO consumption_requests (
      account_id, user_id, request_id, requested_units,
      accepted, rejection_scope, rejection_rule
    )
    VALUES ($1, $2, $4, $3, $5, $6, $7)
    `,
    [
      accountId,
      userId,
      units,
      requestId,
      accepted,
      rejection?.scope ?? null,
      rejection?.rule ?? null,
    ]
  );

  return {
    kind: "decision",
    decision: {
      accepted,
      rejection,
      replayed: false,
      remaining: {
        account: remainingAfter(account, applied),
        user: remainingAfter(user, applied),
      },
    },
  };
}
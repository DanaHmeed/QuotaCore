import { pool } from "../config/database.js";
import { remainingUnits } from "../domain/quota.js";
import type { Rule, Scope } from "../domain/quota.js";
import { isUuid } from "../utils/validation.js";

const MONTH_CTE = `
  WITH m AS (
    SELECT
      COALESCE($2::date, (date_trunc('month', now() AT TIME ZONE 'UTC'))::date)
        AS month_start,
      (date_trunc('month', now() AT TIME ZONE 'UTC'))::date AS current_month
  )
`;

const monthToDate = (month: string | null) => (month ? `${month}-01` : null);

export interface PlanView {
  id: string;
  name: string;
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
}

export interface LevelUsage {
  plan: PlanView;
  consumedUnits: number;
  remainingUnits: number | null;
}

interface LevelRow {
  month: string;
  is_current: boolean;
  plan_id: string;
  plan_name: string;
  monthly_allowance: number;
  max_units_per_request: number;
  consumed_units: number;
}

function toLevelUsage(row: LevelRow): LevelUsage {
  return {
    plan: {
      id: row.plan_id,
      name: row.plan_name,
      monthlyAllowance: row.monthly_allowance,
      maxUnitsPerRequest: row.max_units_per_request,
    },
    consumedUnits: row.consumed_units,
    remainingUnits: row.is_current
      ? remainingUnits({
          monthlyAllowance: row.monthly_allowance,
          maxUnitsPerRequest: row.max_units_per_request,
          consumedUnits: row.consumed_units,
        })
      : null,
  };
}


export async function getAccountUsage(accountId: string, month: string | null) {
  const res = await pool.query<LevelRow & { account_name: string }>(
    `
    ${MONTH_CTE}
    SELECT to_char(m.month_start, 'YYYY-MM') AS month,
           (m.month_start = m.current_month) AS is_current,
           a.name AS account_name,
           p.id AS plan_id, p.name AS plan_name,
           p.monthly_allowance, p.max_units_per_request,
           COALESCE(c.consumed_units, 0) AS consumed_units
    FROM m
    JOIN accounts a ON a.id = $1
    JOIN plans p ON p.id = a.plan_id
    LEFT JOIN usage_counters c
      ON c.account_id = a.id
     AND c.user_id IS NULL
     AND c.month_start = m.month_start
    `,
    [accountId, monthToDate(month)]
  );

  const row = res.rows[0];
  if (!row) throw new Error("Authenticated account not found");

  return {
    month: row.month,
    account: { id: accountId, name: row.account_name, ...toLevelUsage(row) },
  };
}

export async function listUserUsage(
  accountId: string,
  month: string | null,
  limit: number,
  offset: number
) {
  const [rowsRes, countRes] = await Promise.all([
    pool.query<LevelRow & { user_id: string; external_user_id: string }>(
      `
      ${MONTH_CTE}
      SELECT to_char(m.month_start, 'YYYY-MM') AS month,
             (m.month_start = m.current_month) AS is_current,
             u.id AS user_id, u.external_user_id,
             p.id AS plan_id, p.name AS plan_name,
             p.monthly_allowance, p.max_units_per_request,
             COALESCE(c.consumed_units, 0) AS consumed_units
      FROM m
      JOIN users u ON u.account_id = $1
      JOIN plans p ON p.id = u.plan_id
      LEFT JOIN usage_counters c
        ON c.account_id = u.account_id
       AND c.user_id = u.id
       AND c.month_start = m.month_start
      ORDER BY u.external_user_id, u.id
      LIMIT $3 OFFSET $4
      `,
      [accountId, monthToDate(month), limit, offset]
    ),
    pool.query<{ total: number }>(
      `SELECT count(*) AS total FROM users WHERE account_id = $1`,
      [accountId]
    ),
  ]);

  return {
    items: rowsRes.rows.map((row) => ({
      id: row.user_id,
      externalUserId: row.external_user_id,
      ...toLevelUsage(row),
    })),
    total: countRes.rows[0]?.total ?? 0,
    limit,
    offset,
  };
}

export async function getUserUsage(
  accountId: string,
  externalUserId: string,
  month: string | null
) {
  const res = await pool.query<
    LevelRow & { user_id: string; external_user_id: string }
  >(
    `
    ${MONTH_CTE}
    SELECT to_char(m.month_start, 'YYYY-MM') AS month,
           (m.month_start = m.current_month) AS is_current,
           u.id AS user_id, u.external_user_id,
           p.id AS plan_id, p.name AS plan_name,
           p.monthly_allowance, p.max_units_per_request,
           COALESCE(c.consumed_units, 0) AS consumed_units
    FROM m
    JOIN users u ON u.account_id = $1 AND u.external_user_id = $3
    JOIN plans p ON p.id = u.plan_id
    LEFT JOIN usage_counters c
      ON c.account_id = u.account_id
     AND c.user_id = u.id
     AND c.month_start = m.month_start
    `,
    [accountId, monthToDate(month), externalUserId]
  );

  const row = res.rows[0];
  if (!row) return null;

  return {
    user: {
      id: row.user_id,
      externalUserId: row.external_user_id,
      ...toLevelUsage(row),
    },
  };
}


// Microsecond precision is kept on purpose: PostgreSQL timestamps have
// microseconds, JavaScript Dates only milliseconds, and a truncated cursor
// would skip or repeat rows.

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface HistoryCursor {
  t: string;
  id: string;
}

export function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(raw: string): HistoryCursor | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8")
    );
    if (typeof parsed === "object" && parsed !== null) {
      const { t, id } = parsed as { t?: unknown; id?: unknown };
      if (typeof t === "string" && TS_RE.test(t) && isUuid(id)) {
        return { t, id };
      }
    }
    return null;
  } catch {
    return null;
  }
}

export interface HistoryFilters {
  accountId: string;
  month: string | null;
  externalUserId: string | null;
  accepted: boolean | null;
  cursor: HistoryCursor | null;
  limit: number;
}

interface HistoryRow {
  id: string;
  request_id: string;
  external_user_id: string;
  requested_units: number;
  accepted: boolean;
  rejection_scope: Scope | null;
  rejection_rule: Rule | null;
  created_at: string;
}

export async function getHistory(filters: HistoryFilters) {
  const { accountId, month, externalUserId, accepted, cursor, limit } = filters;

  // Fetch one extra row to know whether another page exists.
  const res = await pool.query<HistoryRow>(
    `
    SELECT r.id, r.request_id, u.external_user_id, r.requested_units,
           r.accepted, r.rejection_scope, r.rejection_rule,
           to_char(r.created_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
    FROM consumption_requests r
    JOIN users u ON u.id = r.user_id AND u.account_id = r.account_id
    WHERE r.account_id = $1
      AND ($2::date IS NULL OR (
            r.created_at >= (($2::date)::timestamp AT TIME ZONE 'UTC')
        AND r.created_at <  ((($2::date) + INTERVAL '1 month')::timestamp
                             AT TIME ZONE 'UTC')
          ))
      AND ($3::text IS NULL OR u.external_user_id = $3)
      AND ($4::boolean IS NULL OR r.accepted = $4)
      AND ($5::timestamptz IS NULL
           OR (r.created_at, r.id) < ($5::timestamptz, $6::uuid))
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT $7
    `,
    [
      accountId,
      monthToDate(month),
      externalUserId,
      accepted,
      cursor?.t ?? null,
      cursor?.id ?? null,
      limit + 1,
    ]
  );

  const page = res.rows.slice(0, limit);
  const last = page[page.length - 1];
  const hasMore = res.rows.length > limit;

  return {
    items: page.map((row) => ({
      id: row.id,
      requestId: row.request_id,
      externalUserId: row.external_user_id,
      units: row.requested_units,
      accepted: row.accepted,
      rejection: row.accepted
        ? null
        : { scope: row.rejection_scope, rule: row.rejection_rule },
      createdAt: row.created_at,
    })),
    nextCursor:
      hasMore && last
        ? encodeCursor({ t: last.created_at, id: last.id })
        : null,
  };
}
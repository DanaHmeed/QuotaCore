# QuotaCore — Usage Metering and Quota Service

A backend service that other applications call to track usage and decide whether their users may perform an action. Every request is checked against **two plans at once**: the calling application's (account) plan and the individual user's plan. A request is accepted in full or rejected, and a rejection consumes nothing.

Built with TypeScript, Express and PostgreSQL. The whole stack, including a small example application, starts with one command.

## Quick start

Requirements: Docker with Docker Compose.

```
docker compose up --build
```

This starts PostgreSQL, applies the database migrations, seeds the predefined plans, starts QuotaCore and starts the example client. No manual setup is needed. The first start takes a minute or two.

| Service | URL |
|---|---|
| QuotaCore API | http://localhost:3000 (health check at `/health`) |
| Example client (DocuFlow) | http://localhost:4000 |
| PostgreSQL | localhost:5433 (user `quotacore`, password `quotacore`, database `quotacore_db`) |

Open http://localhost:4000 and press **Run all steps** to watch the demo (see [Example client](#example-client)).

To start from scratch (removes the database and the demo account):

```
docker compose down -v
docker compose up --build
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_BOOTSTRAP_KEY` | `dev-admin-key-change-me` | Key needed to create accounts. Put your own value in `.env` (see `.env.example`). The default is for local development only. |
| `DATABASE_URL` | set by `docker-compose.yml` | PostgreSQL connection string. Needed in `.env` only when running outside Docker. |
| `PORT` | `3000` | Port of the API |
| `DB_POOL_MAX` | `10` | Size of the PostgreSQL connection pool |

### Running without Docker for the API

```
docker compose up -d db
cp .env.example .env        # then set a real ADMIN_BOOTSTRAP_KEY
npm install
npm run db:setup            # migrations and predefined plans
npm run dev
```

## Concepts

| Concept | Meaning |
|---|---|
| **Account** | An application or company calling the service. Its plan defines limits shared by all its users. |
| **User** | A user of that application, registered under one account. Its plan defines its individual limits. |
| **Plan** | A named set of rules (monthly allowance, maximum units per request) assigned to an account or a user. A plan has a type: `account` or `user`. |
| **Units** | The single resource being metered (for example document-processing credits). |

### Rules

Both plan types support the same two rules:

- **Monthly allowance**: total units available in one UTC calendar month.
- **Maximum units per request**: the largest amount a single request may consume.

Every request must satisfy **all four** checks: account per-request, user per-request, account monthly, user monthly.

Example: the account plan allows 10,000 per month and 100 per request; the user plan allows 1,000 per month and 20 per request.

- A request for 25 units is rejected by the **user** per-request limit, even if both monthly allowances have room.
- A request for 10 units is accepted if both have room. It adds 10 to the user's usage and 10 to the account's shared usage.
- If the account has only 5 units left, that 10-unit request is rejected even if the user has plenty left.

The account's usage is the sum of accepted usage across its users. Users on the same plan definition do **not** share allowance; each has their own counter. A larger user allowance never enlarges the account's shared allowance.

### Predefined plans

Created at startup. They are read-only.

| Name | Type | Monthly allowance | Max per request |
|---|---|---|---|
| Starter | account | 1000 | 100 |
| Pro | account | 10000 | 500 |
| Basic | user | 100 | 20 |
| Premium | user | 1000 | 100 |

## Authentication

| Endpoint group | Header | Notes |
|---|---|---|
| `POST /accounts` | `X-Admin-Key` | The bootstrap key from `ADMIN_BOOTSTRAP_KEY`. Used only to create accounts. |
| Everything else | `X-API-Key` | The account's key. Identifies the calling account and grants access only to that account's data. |

- API keys are 32 random bytes (hex). Only the **SHA-256 hash** is stored; the key is returned **once**, at account creation. A lost key cannot be recovered (key rotation is not implemented).
- The account is always taken from the API key, never from the request body.
- A missing or unknown key returns `401`.
- Resources that belong to another account are reported as `404`, so their existence is not revealed.

## API reference

All bodies are JSON. Examples use `curl`; replace `$KEY` with an account API key.

### Accounts

**Create an account**: `POST /accounts` (admin key)

```
curl -X POST http://localhost:3000/accounts \
  -H "X-Admin-Key: $ADMIN_BOOTSTRAP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"CloudDocs","planName":"Starter"}'
```

Returns `201` with the account and its API key in `apiKey`. Store the key immediately; it is not shown again.

**Get the authenticated account**: `GET /accounts/me`

**Get the account plan in effect**: `GET /accounts/me/plan`

**Switch the account plan**: `PUT /accounts/me/plan` with `{ "planId": "<account-type plan id>" }`. The plan must be a predefined account plan or one of the caller's own custom account plans. Consumed units are preserved.

### Plans

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/plans?type=account\|user` | Predefined plans plus the caller's custom plans |
| `GET` | `/plans/:id` | One plan (predefined or the caller's own) |
| `POST` | `/plans` | Create a custom plan |
| `PATCH` | `/plans/:id` | Update name and/or limits of a custom plan |

Create:

```
curl -X POST http://localhost:3000/plans \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"name":"Team","planType":"user","monthlyAllowance":300,"maxUnitsPerRequest":30}'
```

Validation: `name` 1–100 characters; `planType` is `account` or `user`; `monthlyAllowance` an integer ≥ 0; `maxUnitsPerRequest` an integer > 0. Numbers must be JSON numbers, not strings.

Update (any subset of fields):

```
curl -X PATCH http://localhost:3000/plans/<id> \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"monthlyAllowance":500,"maxUnitsPerRequest":50}'
```

- Predefined plans: `403 Predefined plans are read-only`.
- Another account's plan: `404`.
- Duplicate custom name for the same account and type: `409`.
- `planType` cannot be changed after creation.
- Takes effect for the **next** consume request, with no restart. Every user (or the account) assigned to that plan is affected; usage counters are untouched.
- There is no plan deletion in this version.

### Users

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/users` | Register a user |
| `GET` | `/users` | List the account's users with their plan limits |
| `GET` | `/users/:id` | One user (by internal id) |
| `PATCH` | `/users/:id/plan` | Change a user's plan |

Register:

```
curl -X POST http://localhost:3000/users \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"externalUserId":"user_101","planId":"<user-type plan id>"}'
```

`externalUserId` is the user's identifier inside the calling application (max 150 characters). It is unique **per account**: two accounts may both have `user_101`. Registering it twice in one account returns `409`.

Change plan:

```
curl -X PATCH http://localhost:3000/users/<id>/plan \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"planId":"<user-type plan id>"}'
```

Switching plans keeps units already consumed. It does not grant a fresh allowance.

### Consume units

`POST /usage/consume`

```
curl -X POST http://localhost:3000/usage/consume \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"externalUserId":"user_101","units":10,"requestId":"req-001"}'
```

| Field | Rules |
|---|---|
| `externalUserId` | Non-empty string, registered under the calling account |
| `units` | Positive integer (JSON number) |
| `requestId` | Non-empty string, max 150 characters, unique per account. Used for safe retries. |

Accepted:

```json
{
  "accepted": true,
  "requestId": "req-001",
  "units": 10,
  "replayed": false,
  "rejection": null,
  "remaining": { "account": 4990, "user": 90 }
}
```

Rejected (the call itself succeeded, so the status is still `200`):

```json
{
  "accepted": false,
  "requestId": "req-002",
  "units": 25,
  "replayed": false,
  "rejection": { "scope": "user", "rule": "max_units_per_request" },
  "remaining": { "account": 4990, "user": 90 }
}
```

`rejection.scope` is `account` or `user`; `rejection.rule` is `max_units_per_request` or `monthly_allowance`.

Other responses: `400` invalid input, `401` missing or invalid key, `404` user not found in this account, `409` the `requestId` was already used with a different user or units.

### Usage and history

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/usage?month=YYYY-MM&limit=&offset=` | Account totals plus one entry per user (default: current UTC month) |
| `GET` | `/usage/users/:externalUserId?month=YYYY-MM` | One user together with the account it counts against |
| `GET` | `/usage/history?month=&externalUserId=&accepted=&limit=&cursor=` | Request outcomes, newest first |

```json
{
  "month": "2026-10",
  "account": {
    "id": "…", "name": "CloudDocs",
    "plan": { "id": "…", "name": "Pro", "monthlyAllowance": 10000, "maxUnitsPerRequest": 500 },
    "consumedUnits": 35, "remainingUnits": 9965
  },
  "users": {
    "items": [
      {
        "id": "…", "externalUserId": "user_101",
        "plan": { "id": "…", "name": "Basic", "monthlyAllowance": 100, "maxUnitsPerRequest": 20 },
        "consumedUnits": 5, "remainingUnits": 95
      }
    ],
    "total": 1, "limit": 100, "offset": 0
  }
}
```

- Each level (account or user) returns the `plan` currently applied, `consumedUnits` and `remainingUnits`.
- `remainingUnits` is computed only for the **current** UTC month. For past months it is `null`: plan history is not stored, so measuring an old month against today's plan would be misleading. `consumedUnits` is always exact.
- A user with no usage in the month reports `0`.
- `/usage` paginates users with `limit` (1–500, default 100) and `offset`.
- `/usage/history` uses keyset pagination: pass the returned `nextCursor` as `cursor` to get the next page; it is `null` on the last page. Limit is 1–200 (default 50). The cursor is opaque; do not build or parse it. Each item has `requestId`, `externalUserId`, `units`, `accepted`, `rejection` (scope and rule, or `null`) and `createdAt`.

### Health and errors

`GET /health` returns `{ "status": "ok" }` and needs no key.

Errors always look like `{ "error": "human-readable message" }`.

| Status | Meaning |
|---|---|
| 400 | Invalid input (including malformed UUIDs, malformed JSON) |
| 401 | Missing or invalid API key (or admin key) |
| 403 | Attempt to modify a read-only predefined plan |
| 404 | Not found, or belongs to another account (also unknown routes) |
| 409 | Conflict (duplicate user, duplicate plan name, reused `requestId` with different data) |
| 500 | Unexpected server error |

## How a consume request is decided

1. Validate input (`400`).
2. Start a transaction.
3. Find the user **inside the authenticated account** (`404` otherwise).
4. Create this UTC month's counters if they do not exist.
5. Lock the account counter row, then the user counter row (`SELECT ... FOR UPDATE`).
6. Read the **current** account and user plan limits.
7. If this `requestId` already exists for the account: return the stored decision (`replayed: true`), or `409` if user or units differ.
8. Evaluate the rules. If accepted, add the units to both counters.
9. Record the outcome (accepted or rejected) in the request history.
10. Commit.

### Which rule is reported when several fail

One rule is reported, chosen by a fixed priority:

1. account per-request
2. user per-request
3. account monthly
4. user monthly

Reasoning: per-request rules do not depend on current usage, so retrying later never helps; and the account is the broader limit, so reporting it first avoids "fix the user plan, then hit the account limit".

### Retries (idempotency)

- A retry with the same `requestId`, same user and same units returns the **original decision** and consumes nothing again (`replayed: true`).
- The same `requestId` with a different user or units returns `409`.
- Rejected requests are remembered too. To try again after changing a plan, send a **new** `requestId`.
- The duplicate check runs after the account counter is locked, so two concurrent retries of one `requestId` cannot both be applied.
- A client should retry network errors and `5xx` answers with the same `requestId`, and treat `4xx` answers as final. The example client does exactly this.

### Concurrency

- Row-level locks on the usage counters (`SELECT ... FOR UPDATE`) make check-then-update atomic.
- Locks are always taken in the same order (account counter, then user counter), so transactions cannot deadlock on each other.
- Because every request locks its account's counter, requests of the **same account are processed one at a time**. Different accounts do not block each other. This is the main throughput limit and the focus of the performance tests.
- Limits are read from the database on every request, after the locks are held. A plan change that has committed is seen by every later request, without a restart.

### Plan changes

- New requests use the latest plan values.
- Switching plans, or editing a plan, never resets usage.
- If an allowance is reduced below existing usage, remaining shows `0` and further consumption at that level is rejected until allowance is available again.
- Past request history is never rewritten.

## Data model

| Table | Purpose |
|---|---|
| `plans` | Predefined and custom plans (`plan_type`, `monthly_allowance`, `max_units_per_request`, `owner_account_id`, `is_predefined`) |
| `accounts` | Account name, API key hash, current account plan |
| `users` | Users per account (`external_user_id` unique per account), current user plan |
| `usage_counters` | Consumed units per account (and per user) per UTC month, created on first use |
| `consumption_requests` | Every decision, accepted or rejected, with the rule that rejected it. Unique per `(account_id, request_id)`. |
| `schema_migrations` | Which migration files have been applied |

### Database initialisation

`scripts/db-setup.ts` runs every time the API container starts. It applies the SQL files in `migrations/` in filename order, records them in `schema_migrations` so they are never applied twice, and inserts the predefined plans when they are missing. An advisory lock makes two instances that start at the same time take turns. Run it by hand with `npm run db:setup`.

## Product assumptions

| Topic | Decision |
|---|---|
| Month boundary | UTC calendar month. Usage belongs to the month in which the request is processed (taken from the database clock at transaction start). Each month starts at zero; earlier months stay queryable. |
| Units | Positive safe integers only. |
| Rejected requests | Stored in history, consume nothing. |
| HTTP status of a rejection | `200` with `accepted: false`. A rejection is a normal, recorded business outcome, not an API error. |
| Duplicate `requestId` | Original decision returned. A different payload gives `409`. |
| Multiple violated rules | A single rule is reported, by a fixed priority (see above). |
| User identifier | The calling app's own id (`externalUserId`), unique per account. |
| Plan ownership | An account can read and modify only its own custom plans. Predefined plans are read-only. |
| Cross-account access | Reported as `404`, not `403`, so a resource's existence is not revealed. |
| Plan names | Unique among predefined plans per type, and unique among one account's custom plans per type. Assignment uses `planId`, never the name. |
| Plan deletion | Not supported. |
| Past-month "remaining" | `null`: plan history is not stored. Consumed units are exact. |
| History pagination | Keyset on `(created_at, id)`, with microsecond precision preserved in the cursor. |
| Account creation | Protected by a bootstrap admin key. A real sign-up flow is out of scope. |
| API key storage | SHA-256 hash only; shown once. |

## Design decisions

- **Plain SQL with `pg`.** Locking and atomic updates are explicit and easy to trace through the code.
- **Three layers.** `domain/` holds the rules as pure functions, `services/` holds the transaction and accounting, `routes/` holds HTTP handling.
- **Defence in depth for isolation.** Every query filters by the authenticated account. The database also enforces account ownership with composite foreign keys, so a request or counter can never reference another account's user.
- **Validation in two places.** Handlers return clear `400` messages; `CHECK` constraints protect the data if a handler ever misses something.
- **`BIGINT` as JavaScript `Number`.** The driver returns `BIGINT` as a string by default. A type parser converts it to `Number`, which is exact up to 2^53 − 1, far above any realistic quota. Handlers also reject non-safe integers.
- **Counters per UTC month.** One account-level row (`user_id IS NULL`) and one row per user per month, created lazily on first use. Old months are kept as history.
- **App separate from server.** `app.ts` builds the Express app and `server.ts` starts it, so tests import the app without opening a port.
- **One `DATABASE_URL`.** The same setting works locally, in tests and in containers.

## Example client

`client/` contains DocuFlow, a small application that meters (simulated) document processing with QuotaCore. It runs two users on different plans under one account and walks through an accepted request, a rejection by a user limit, a rejection by the shared account limit, and plan changes that alter what users can do without touching the client code. See `client/README.md`.

The account's API key stays on the client's server; the browser never sees it. Failed calls are retried with the same `requestId`, and a button resends the last request to show that QuotaCore answers with the original decision.

## Testing

Tests use Vitest and Supertest and run the real app against PostgreSQL.

```
docker compose up -d db
npm run db:setup      # first time only
npm test
```

Each test creates its own accounts (named `test-...`) and removes them afterwards, so runs do not interfere with each other.

| File | Covers |
|---|---|
| `auth-isolation.test.ts` | API key validation, admin key, account isolation |
| `rules.test.ts` | Both plans applied together, rule priority, accounting, monthly reset |
| `plans.test.ts` | Plan edits and switches, usage preserved, read-only predefined plans, validation |
| `idempotency.test.ts` | Retries, replayed decisions, 409 conflicts, concurrent duplicates |
| `concurrency.test.ts` | No over-consumption under parallel requests, account total equals sum of users |
| `reports.test.ts` | Usage reports, previous months, history pagination and filters |

## Performance

### What was tested and how

Tool: [autocannon](https://github.com/mcollina/autocannon), driven by `scripts/loadtest.mjs`. Each scenario creates its own accounts through the public API, sends `POST /usage/consume` requests of 1 unit each, and afterwards reads the usage back through the API to check the numbers. Because every request is 1 unit, "units counted" equals "requests accepted".

| Scenario | What it shows |
|---|---|
| **A.** 20 accounts × 10 users, huge allowances | Throughput when accounts do not contend with each other |
| **B.** 1 account × 50 users, huge allowances | Throughput when every request needs the same account counter |
| **C.** 1 account, allowance 1000, users capped at 150 | Limits hold exactly when far more requests arrive than the allowance |
| **D.** One `requestId` sent over and over | A retry storm is counted once |

Checks after each run: the account total equals the sum of its users; no limit is exceeded (scenario C must accept **exactly** 1000 units and no user more than 150); a retry storm counts exactly 1 unit; no request fails. The script exits with an error if any check fails.

Reproduce (needs Node.js 18+ and the stack running):

```
docker compose up -d --build
npm install
npm run loadtest
```

PowerShell, if you changed `ADMIN_BOOTSTRAP_KEY` in `.env`, the script reads it from `.env` itself. Settings: `LOADTEST_DURATION` (seconds per scenario, default 15), `LOADTEST_CONNECTIONS` (default 50), `LOADTEST_LABEL` (name of the run and of the file written to `loadtest-results/`).

### Results

#### Baseline

- Date: 2026-10-20T08:17:20.958Z
- Machine: 12th Gen Intel(R) Core(TM) i7-1255U, 12 logical cores, 16 GB RAM, win32
- Node.js: v22.15.0
- Target: http://localhost:3000 (docker compose stack)
- 15 s per scenario, 50 connections (scenario D: at most 20 connections and 5 s)

| Scenario | Connections | Requests | Requests/s | Latency p50 / p99 (ms) | Failed | Correctness check |
|---|---|---|---|---|---|---|
| A. 20 accounts x 10 users | 50 | 6658 | 444 | 104 / 250 | 0 | pass: 6708 units counted, every account total equals the sum of its users: true |
| B. 1 hot account x 50 users | 50 | 2740 | 183 | 264 / 399 | 0 | pass: 2790 units counted, account total equals the sum of users: true |
| C. Limits under load (account 1000, users 150) | 50 | 3269 | 218 | 219 / 345 | 0 | pass: accepted 1000 of 1000 allowed, busiest user 128 of 150, 3269 requests sent |
| D. Retry storm (one request id) | 20 | 1299 | 260 | 74 / 105 | 0 | pass: 1299 identical requests, counted once: true |


### Bottleneck

Inside the transaction, a request holds the account counter's row lock from the moment it locks it until `COMMIT`. A single account therefore cannot go faster than `1 / (time the lock is held)`, however many connections are open. Scenario A (many accounts) shows the service scaling across accounts; scenario B (one account) shows the ceiling of a single account. While the lock is held, the baseline implementation makes 10 round trips to PostgreSQL (`BEGIN`, user lookup, counter creation, two locks, limits read, duplicate check, counter update, history insert, `COMMIT`), and the transaction ends with a commit that has to be flushed to disk. The experiment below tests how much the number of round trips matters.

With a single account (scenario B), throughput was 183 requests/s with a p99 latency of 399 ms. Spread over 20 accounts (scenario A), it was 444 requests/s (about 2.4 times more) with a p99 of 250 ms. At 183 requests/s, a single account spends roughly 5.5 ms of serialised time per request (1000 / 183), and 50 connections waiting for the same lock explain the median latency of 264 ms (50 × 5.5 ms is about 270 ms; scenario A's median was 104 ms). The retry storm (scenario D) points the same way: a replayed request skips the counter update and the history insert, so it holds the lock for less time, and it reached 260 requests/s on the same single account. Scenario A scaled only 2.4 times, not 20 times, so the lock is not the only limit. Likely causes are that the API is one Node.js process with a pool of 10 database connections, and that the load generator, the API and PostgreSQL all share one laptop running Docker Desktop, but I did not measure which of these matters most.

### Optimisation experiment:

The change reduces the round trips made while the lock is held from 10 to 8, without touching the locking order or the transaction boundaries:

1. The limits read and the duplicate check became one query (a `LEFT JOIN` on the request history).
2. The counter update and the history insert became one statement (a data-modifying CTE).

Correctness is unchanged because the same locks are taken in the same order inside the same transaction, and the duplicate check still runs after the account lock. The full test suite and the load test's correctness checks were run again after the change.

#### After thr optimisation

- Date: 2026-10-20T08:33:07.567Z
- Machine: 12th Gen Intel(R) Core(TM) i7-1255U, 12 logical cores, 16 GB RAM, win32
- Node.js: v22.15.0
- Target: http://localhost:3000 (docker compose stack)
- 15 s per scenario, 50 connections (scenario D: at most 20 connections and 5 s)

| Scenario | Connections | Requests | Requests/s | Latency p50 / p99 (ms) | Failed | Correctness check |
|---|---|---|---|---|---|---|
| A. 20 accounts x 10 users | 50 | 6561 | 437 | 108 / 200 | 0 | pass: 6611 units counted, every account total equals the sum of its users: true |
| B. 1 hot account x 50 users | 50 | 2723 | 182 | 261 / 411 | 0 | pass: 2773 units counted, account total equals the sum of users: true |
| C. Limits under load (account 1000, users 150) | 50 | 3437 | 229 | 212 / 297 | 0 | pass: accepted 1000 of 1000 allowed, busiest user 122 of 150, 3437 requests sent |
| D. Retry storm (one request id) | 20 | 1247 | 249 | 76 / 130 | 0 | pass: 1247 identical requests, counted once: true |

Result: no measurable improvement. Throughput on the hot account was 183 requests/s before and 182 after. The other scenarios moved by between -4% and +5% in both directions (A 444 to 437, C 218 to 229, D 260 to 249), which is within the variation I would expect between two runs on a laptop; each configuration was run once, so I cannot put a number on that variation. The correctness checks passed in both runs, and the test suite passed after the change. Removing two of the ten round trips is therefore not what limits a single account.

### Other ideas, not implemented

- **Larger connection pool** (`DB_POOL_MAX`): should help scenario A when connections wait for the pool, does nothing for one hot account, which is bound by the lock.
- **Caching the API key lookup**: removes one query per request outside the lock. Not done because the cached account row includes the plan id, which can change.
- **Sharded counters**: split a hot account's counter into several rows to reduce contention. It makes the exact limit check much harder, so it trades correctness for speed and was rejected.

### What I learned

- A single account is limited by how long each transaction holds that account's counter lock: about 5.5 ms per request here, or roughly 180 requests per second, whatever the number of connections. Different accounts do not wait for each other, which is why spreading the load over 20 accounts gave 2.4 times the throughput.
- My first idea was that the time under the lock was mostly round trips, so I removed two of the ten. The result did not move (183 to 182 requests/s). My explanation was wrong, or at least incomplete: the number of statements is not what limits one account. I kept the change because it is just as correct, but I do not claim it is faster.
- My hypothesis for what does limit it is the commit itself: the row locks make every transaction a write transaction that must be flushed to disk before the lock is released, and disk flushes are slow under Docker Desktop on Windows. I have not tested this. The experiment would be to run the database with `synchronous_commit=off` for one run and compare scenario B.
- Correctness was easier to protect than speed. The same checks passed in every run, including 50 connections hammering a 1000-unit allowance, which accepted exactly 1000.

## Security notes

- Keys are generated with cryptographic randomness; only hashes are stored.
- Account creation is protected by a bootstrap admin key. It needs additional hardening (rotation, rate limiting, network restriction) before any public deployment.
- Do not commit `.env` or any API key.

## Known limitations

- Requests of one account are serialised by the account-counter lock. Throughput per account is bounded by transaction latency; different accounts scale independently.
- API key rotation and recovery are not implemented. A lost key means creating a new account.
- No plan deletion.
- A request that waits on a lock across a month boundary is attributed to the month in which its transaction began.
- The remaining allowance shown on a replayed response reflects current usage, not usage at the time of the original request.
- `POST /accounts` and `GET /accounts/me` still return `snake_case` fields (`plan_id`, `created_at`), while every other endpoint uses `camelCase`.
- The default admin key in `docker-compose.yml` and the fixed database password are for local development only.
- Performance numbers come from one machine running Docker Desktop and will differ elsewhere.

## Project structure

```
src/
  app.ts, server.ts   Express app and entry point
  config/             database pool
  middleware/         authenticateAccount (API key -> account)
  domain/             quota.ts (pure rule evaluation)
  services/           consume.ts (transaction, locking, idempotency), reports.ts
  routes/             accounts, accountPlan, plans, users, usage
  utils/              validation helpers
migrations/           SQL schema and constraints, applied in filename order
scripts/              db-setup.ts (migrations and seeding), loadtest.mjs
tests/                Vitest and Supertest tests
client/               DocuFlow example application
Dockerfile, docker-compose.yml, .env.example
```
// Load tests for QuotaCore, using autocannon.
//
//   docker compose up -d --build
//   npm run loadtest
//
// Every scenario creates its own accounts through the public API, fires
// POST /usage/consume requests of 1 unit each, and then reads the usage back
// through the API to check that the numbers are exactly right. Speed alone
// proves nothing: a fast service that over-counts is a broken service.
//
// Settings (environment variables):
//   BASE_URL              default http://localhost:3000
//   ADMIN_BOOTSTRAP_KEY   default: read from .env, else the compose default
//   LOADTEST_DURATION     seconds per scenario, default 15
//   LOADTEST_CONNECTIONS  concurrent connections, default 50
//   LOADTEST_LABEL        name of the run, used for the result file, default "baseline"

import autocannon from "autocannon";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const DURATION = Number(process.env.LOADTEST_DURATION ?? 15);
const CONNECTIONS = Number(process.env.LOADTEST_CONNECTIONS ?? 50);
const LABEL = process.env.LOADTEST_LABEL ?? "baseline";

const HUGE = 1_000_000_000_000; // an allowance that is never reached

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = (items) => items[Math.floor(Math.random() * items.length)];

function readAdminKey() {
  if (process.env.ADMIN_BOOTSTRAP_KEY) return process.env.ADMIN_BOOTSTRAP_KEY;

  if (existsSync(".env")) {
    const match = readFileSync(".env", "utf8").match(
      /^ADMIN_BOOTSTRAP_KEY=(.*)$/m
    );
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  }

  return "dev-admin-key-change-me";
}

const ADMIN_KEY = readAdminKey();

// ---------------------------------------------------------------------------
// Talking to QuotaCore (setup and verification)
// ---------------------------------------------------------------------------

async function call(method, path, { key, admin, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers["X-API-Key"] = key;
  if (admin) headers["X-Admin-Key"] = admin;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function waitForApi() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new Error(`QuotaCore is not reachable at ${BASE_URL}. Run: docker compose up -d --build`);
}

let tenantCounter = 0;

// One account with its own account plan, one user plan and N users.
async function createTenant({ accountMonthly, userMonthly, userCount }) {
  tenantCounter += 1;

  const created = await call("POST", "/accounts", {
    admin: ADMIN_KEY,
    body: { name: `load-${Date.now()}-${tenantCounter}`, planName: "Starter" },
  });
  const key = created.apiKey;

  const accountPlan = await call("POST", "/plans", {
    key,
    body: {
      name: "load-account",
      planType: "account",
      monthlyAllowance: accountMonthly,
      maxUnitsPerRequest: 100,
    },
  });
  await call("PUT", "/accounts/me/plan", { key, body: { planId: accountPlan.plan.id } });

  const userPlan = await call("POST", "/plans", {
    key,
    body: {
      name: "load-user",
      planType: "user",
      monthlyAllowance: userMonthly,
      maxUnitsPerRequest: 100,
    },
  });

  const users = [];
  for (let i = 0; i < userCount; i++) {
    const externalUserId = `u${i}`;
    await call("POST", "/users", {
      key,
      body: { externalUserId, planId: userPlan.plan.id },
    });
    users.push(externalUserId);
  }

  return { key, users };
}

async function readTotals(tenant) {
  const usage = await call("GET", "/usage?limit=500", { key: tenant.key });
  const perUser = usage.users.items.map((u) => u.consumedUnits);

  return {
    account: usage.account.consumedUnits,
    perUser,
    sum: perUser.reduce((total, units) => total + units, 0),
    maxUser: Math.max(...perUser),
  };
}

// ---------------------------------------------------------------------------
// Firing requests
// ---------------------------------------------------------------------------

// `build()` returns { key, externalUserId, requestId } for every request.
function fire({ connections, duration, build }) {
  return autocannon({
    url: BASE_URL,
    connections,
    duration,
    requests: [
      {
        method: "POST",
        path: "/usage/consume",
        setupRequest: (request) => {
          const { key, externalUserId, requestId } = build();
          return {
            ...request,
            headers: { "content-type": "application/json", "x-api-key": key },
            body: JSON.stringify({ externalUserId, units: 1, requestId }),
          };
        },
      },
    ],
  });
}

const failures = (result) => result.non2xx + result.errors + result.timeouts;

// Requests the server answered with 200. Requests still in flight when the
// run ends may be committed without the client ever seeing the answer, so the
// accepted total can exceed this number by at most the connection count.
const answered = (result) => result["2xx"];

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

// A. Load spread over many accounts: accounts never wait on each other.
async function spreadAcrossAccounts() {
  const tenants = [];
  for (let i = 0; i < 20; i++) {
    tenants.push(await createTenant({ accountMonthly: HUGE, userMonthly: HUGE, userCount: 10 }));
  }

  const result = await fire({
    connections: CONNECTIONS,
    duration: DURATION,
    build: () => {
      const tenant = pick(tenants);
      return { key: tenant.key, externalUserId: pick(tenant.users), requestId: randomUUID() };
    },
  });

  await sleep(1000);

  let accepted = 0;
  let consistent = true;
  for (const tenant of tenants) {
    const totals = await readTotals(tenant);
    accepted += totals.account;
    if (totals.account !== totals.sum) consistent = false;
  }

  const ok =
    consistent &&
    failures(result) === 0 &&
    accepted >= answered(result) &&
    accepted <= answered(result) + CONNECTIONS;

  return {
    title: "A. 20 accounts x 10 users",
    connections: CONNECTIONS,
    result,
    ok,
    detail: `${accepted} units counted, every account total equals the sum of its users: ${consistent}`,
  };
}

// B. All load on one account: every request needs the same account counter.
async function hotAccount() {
  const tenant = await createTenant({ accountMonthly: HUGE, userMonthly: HUGE, userCount: 50 });

  const result = await fire({
    connections: CONNECTIONS,
    duration: DURATION,
    build: () => ({
      key: tenant.key,
      externalUserId: pick(tenant.users),
      requestId: randomUUID(),
    }),
  });

  await sleep(1000);
  const totals = await readTotals(tenant);

  const ok =
    totals.account === totals.sum &&
    failures(result) === 0 &&
    totals.account >= answered(result) &&
    totals.account <= answered(result) + CONNECTIONS;

  return {
    title: "B. 1 hot account x 50 users",
    connections: CONNECTIONS,
    result,
    ok,
    detail: `${totals.account} units counted, account total equals the sum of users: ${totals.account === totals.sum}`,
  };
}

// C. Limits under pressure: far more requests than the allowance.
async function limitsUnderLoad() {
  const ACCOUNT_LIMIT = 1000;
  const USER_LIMIT = 150;
  const tenant = await createTenant({
    accountMonthly: ACCOUNT_LIMIT,
    userMonthly: USER_LIMIT,
    userCount: 10,
  });

  const result = await fire({
    connections: CONNECTIONS,
    duration: DURATION,
    build: () => ({
      key: tenant.key,
      externalUserId: pick(tenant.users),
      requestId: randomUUID(),
    }),
  });

  await sleep(1000);
  const totals = await readTotals(tenant);

  const ok =
    totals.account === ACCOUNT_LIMIT &&
    totals.sum === totals.account &&
    totals.maxUser <= USER_LIMIT &&
    failures(result) === 0;

  return {
    title: "C. Limits under load (account 1000, users 150)",
    connections: CONNECTIONS,
    result,
    ok,
    detail:
      `accepted ${totals.account} of ${ACCOUNT_LIMIT} allowed, ` +
      `busiest user ${totals.maxUser} of ${USER_LIMIT}, ` +
      `${result.requests.total} requests sent`,
  };
}

// D. A retry storm: the same request id, over and over.
async function retryStorm() {
  const tenant = await createTenant({ accountMonthly: HUGE, userMonthly: HUGE, userCount: 1 });
  const requestId = randomUUID();

  const result = await fire({
    connections: Math.min(CONNECTIONS, 20),
    duration: Math.min(DURATION, 5),
    build: () => ({ key: tenant.key, externalUserId: tenant.users[0], requestId }),
  });

  await sleep(1000);
  const totals = await readTotals(tenant);

  const ok = totals.account === 1 && totals.sum === 1 && failures(result) === 0;

  return {
    title: "D. Retry storm (one request id)",
    connections: Math.min(CONNECTIONS, 20),
    result,
    ok,
    detail: `${result.requests.total} identical requests, counted once: ${totals.account === 1}`,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function renderReport(scenarios) {
  const cpu = os.cpus()[0]?.model ?? "unknown CPU";
  const memoryGb = Math.round(os.totalmem() / 1024 ** 3);

  const rows = scenarios.map((s) => {
    const r = s.result;
    return (
      `| ${s.title} | ${s.connections} | ${r.requests.total} | ` +
      `${Math.round(r.requests.average)} | ${r.latency.p50} / ${r.latency.p99} | ` +
      `${failures(r)} | ${s.ok ? "pass" : "FAIL"}: ${s.detail} |`
    );
  });

  return [
    `## Load test results: ${LABEL}`,
    "",
    `- Date: ${new Date().toISOString()}`,
    `- Machine: ${cpu}, ${os.cpus().length} logical cores, ${memoryGb} GB RAM, ${os.platform()}`,
    `- Node.js: ${process.version}`,
    `- Target: ${BASE_URL} (docker compose stack)`,
    `- ${DURATION} s per scenario, ${CONNECTIONS} connections (scenario D: at most 20 connections and 5 s)`,
    "",
    "| Scenario | Connections | Requests | Requests/s | Latency p50 / p99 (ms) | Failed | Correctness check |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

async function main() {
  await waitForApi();
  console.log(`Load test "${LABEL}" against ${BASE_URL}\n`);

  const scenarios = [];
  for (const scenario of [spreadAcrossAccounts, hotAccount, limitsUnderLoad, retryStorm]) {
    console.log(`Running ${scenario.name} ...`);
    scenarios.push(await scenario());
  }

  const report = renderReport(scenarios);
  console.log(`\n${report}`);

  mkdirSync("loadtest-results", { recursive: true });
  const file = `loadtest-results/${LABEL}.md`;
  writeFileSync(file, report);
  console.log(`Saved to ${file}`);

  if (scenarios.some((s) => !s.ok)) {
    console.error("\nAt least one correctness check FAILED.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

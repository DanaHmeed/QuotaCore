import express from "express";
import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bootstrapDemo, waitForQuotaCore, type DemoState } from "./demo.js";
import {
  QuotaCoreClient,
  QuotaCoreError,
  type ConsumeResponse,
  type UsageResponse,
} from "./quotacore.js";

const QUOTACORE_URL = process.env.QUOTACORE_URL ?? "http://localhost:3000";
const ADMIN_KEY = process.env.QUOTACORE_ADMIN_KEY ?? "";
const PORT = Number(process.env.PORT ?? 4000);
const STATE_FILE = process.env.STATE_FILE ?? ".demo-state.json";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Demo account. The API key lives only on this server; the browser never
// sees it

let client: QuotaCoreClient | null = null;

function requireClient(): QuotaCoreClient {
  if (!client) throw new Error("The demo account is not ready yet");
  return client;
}

async function createDemoAccount(): Promise<void> {
  if (!ADMIN_KEY) {
    throw new Error(
      "QUOTACORE_ADMIN_KEY is required to create the demo account"
    );
  }

  const state = await bootstrapDemo(QUOTACORE_URL, ADMIN_KEY);
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  client = new QuotaCoreClient(QUOTACORE_URL, state.apiKey);
  lastRequest = null;
}

// Reuse the account from the previous run when its key still works;
// otherwise (first run, or the database was wiped) create a new one.
async function loadOrCreateDemoAccount(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(STATE_FILE, "utf8")) as DemoState;
    const candidate = new QuotaCoreClient(QUOTACORE_URL, saved.apiKey);
    await candidate.getUsage();
    client = candidate;
    console.log("Reusing the demo account from the previous run.");
    return;
  } catch {
    // fall through
  }

  await createDemoAccount();
  console.log("Created a new demo account.");
}

// Processing a document (the business action is simulated).


interface SentRequest {
  externalUserId: string;
  units: number;
  requestId: string;
  documentName: string;
}

interface DocumentResult extends ConsumeResponse {
  externalUserId: string;
  documentName: string;
  message: string;
}

let lastRequest: SentRequest | null = null;
let documentCounter = 0;

// Network errors and 5xx answers are retried with the SAME requestId, so
// QuotaCore can never count one document twice. Answers in the 4xx range are
// final decisions or mistakes and are not retried.
async function sendWithRetry(
  quotaCore: QuotaCoreClient,
  request: SentRequest
): Promise<ConsumeResponse> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await quotaCore.consume(
        request.externalUserId,
        request.units,
        request.requestId
      );
    } catch (error) {
      if (error instanceof QuotaCoreError && error.status < 500) throw error;
      lastError = error;
      await sleep(200 * attempt);
    }
  }

  throw lastError;
}

function explain(
  decision: ConsumeResponse,
  usage: UsageResponse,
  externalUserId: string
): string {
  const name = capitalize(externalUserId);

  if (decision.accepted) {
    return decision.replayed
      ? `This request was already handled: ${name}'s document was processed the first time and nothing was counted again.`
      : `${name}'s ${decision.units}-page document was processed.`;
  }

  const rejection = decision.rejection;
  if (!rejection) return "The request was rejected.";

  const level =
    rejection.scope === "account"
      ? usage.account
      : usage.users.items.find((u) => u.externalUserId === externalUserId);
  if (!level) return "The request was rejected.";

  const who =
    rejection.scope === "account" ? "The shared account plan" : `${name}'s plan`;

  return rejection.rule === "max_units_per_request"
    ? `${who} allows at most ${level.plan.maxUnitsPerRequest} units per request, and this document needs ${decision.units}.`
    : `${who} has only ${level.remainingUnits ?? 0} units left this month, and this document needs ${decision.units}.`;
}

async function processDocument(
  quotaCore: QuotaCoreClient,
  request: SentRequest
): Promise<DocumentResult> {
  // 1. Ask QuotaCore first.
  const decision = await sendWithRetry(quotaCore, request);

  // 2. Only do the work when the answer is yes (simulated here).
  if (decision.accepted && !decision.replayed) await sleep(250);

  const usage = await quotaCore.getUsage();

  return {
    ...decision,
    externalUserId: request.externalUserId,
    documentName: request.documentName,
    message: explain(decision, usage, request.externalUserId),
  };
}

// HTTP API used by the web page

const app = express();
app.use(express.json());
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

const route =
  (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    handler(req, res).catch(next);
  };

app.get(
  "/api/state",
  route(async (_req, res) => {
    const quotaCore = requireClient();
    const [usage, history, plans] = await Promise.all([
      quotaCore.getUsage(),
      quotaCore.getHistory(10),
      quotaCore.listPlans(),
    ]);

    res.json({
      month: usage.month,
      account: usage.account,
      users: usage.users.items,
      history: history.items,
      plans: {
        account: plans.filter((p) => p.planType === "account"),
        user: plans.filter((p) => p.planType === "user"),
      },
    });
  })
);

app.post(
  "/api/documents",
  route(async (req, res) => {
    const { externalUserId, pages } = req.body ?? {};

    if (
      typeof externalUserId !== "string" ||
      !Number.isSafeInteger(pages) ||
      pages < 1 ||
      pages > 1000
    ) {
      res
        .status(400)
        .json({ error: "externalUserId and pages (1-1000) are required" });
      return;
    }

    documentCounter += 1;
    const request: SentRequest = {
      externalUserId,
      units: pages,
      requestId: randomUUID(),
      documentName: `document-${documentCounter}.pdf`,
    };
    lastRequest = request;

    res.json(await processDocument(requireClient(), request));
  })
);

// Sends the previous request again with the same requestId, the way a client
// would after a lost response. QuotaCore answers with the original decision.
app.post(
  "/api/documents/retry",
  route(async (_req, res) => {
    if (!lastRequest) {
      res.status(400).json({ error: "There is no previous request to retry" });
      return;
    }

    res.json(await processDocument(requireClient(), lastRequest));
  })
);

app.post(
  "/api/users/:externalUserId/plan",
  route(async (req, res) => {
    const { planId } = req.body ?? {};
    if (typeof planId !== "string") {
      res.status(400).json({ error: "planId is required" });
      return;
    }

    const quotaCore = requireClient();
    const detail = await quotaCore.getUserUsage(String(req.params.externalUserId));
    await quotaCore.switchUserPlan(detail.user.id, planId);
    res.json({ ok: true });
  })
);

app.post(
  "/api/account/plan",
  route(async (req, res) => {
    const { planId } = req.body ?? {};
    if (typeof planId !== "string") {
      res.status(400).json({ error: "planId is required" });
      return;
    }

    await requireClient().switchAccountPlan(planId);
    res.json({ ok: true });
  })
);

app.post(
  "/api/plans/:planId",
  route(async (req, res) => {
    const { monthlyAllowance, maxUnitsPerRequest } = req.body ?? {};

    if (
      !Number.isSafeInteger(monthlyAllowance) ||
      !Number.isSafeInteger(maxUnitsPerRequest)
    ) {
      res.status(400).json({
        error: "monthlyAllowance and maxUnitsPerRequest must be whole numbers",
      });
      return;
    }

    await requireClient().updatePlan(String(req.params.planId), {
      monthlyAllowance,
      maxUnitsPerRequest,
    });
    res.json({ ok: true });
  })
);

// Starts over with a brand-new demo account (usage only resets monthly).
app.post(
  "/api/reset",
  route(async (_req, res) => {
    await createDemoAccount();
    res.json({ ok: true });
  })
);

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof QuotaCoreError) {
    const body =
      typeof error.body === "object" && error.body !== null
        ? error.body
        : { error: "QuotaCore returned an error" };
    res.status(error.status).json(body);
    return;
  }

  console.error(error);
  res.status(502).json({
    error: error instanceof Error ? error.message : "Unexpected error",
  });
};

app.use(errorHandler);


await waitForQuotaCore(QUOTACORE_URL);
await loadOrCreateDemoAccount();

app.listen(PORT, () => {
  console.log(`DocuFlow demo client: http://localhost:${PORT}`);
});
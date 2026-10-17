import { Router } from "express";
import { authenticateAccount } from "../middleware/authenticateAccount.js";
import { consumeUnits } from "../services/consume.js";
import {
  decodeCursor,
  getAccountUsage,
  getHistory,
  getUserUsage,
  listUserUsage,
  type HistoryCursor,
} from "../services/reports.js";
import { isMonth, parseIntParam } from "../utils/validation.js";

export const usageRouter = Router();

usageRouter.use(authenticateAccount);

// POST /usage/consume
usageRouter.post("/consume", async (req, res) => {
  const accountId = res.locals.account.id;
  const { externalUserId, units, requestId } = req.body ?? {};

  if (
    typeof externalUserId !== "string" ||
    externalUserId.trim().length === 0 ||
    externalUserId.length > 150 ||
    typeof requestId !== "string" ||
    requestId.trim().length === 0 ||
    requestId.length > 150 ||
    typeof units !== "number" ||
    !Number.isSafeInteger(units) ||
    units <= 0
  ) {
    res.status(400).json({
      error:
        "externalUserId (string), requestId (string) and " +
        "units (positive integer) are required",
    });
    return;
  }

  try {
    const outcome = await consumeUnits({
      accountId,
      externalUserId: externalUserId.trim(),
      units,
      requestId: requestId.trim(),
    });

    if (outcome.kind === "user_not_found") {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (outcome.kind === "request_id_conflict") {
      res.status(409).json({
        error: "requestId was already used with a different user or units",
      });
      return;
    }

    const { decision } = outcome;

    res.status(200).json({
      accepted: decision.accepted,
      requestId: requestId.trim(),
      units,
      replayed: decision.replayed,
      rejection: decision.rejection,
      remaining: decision.remaining,
    });
  } catch (error) {
    console.error("Consumption failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /usage?month=YYYY-MM&limit=&offset=
// Account totals plus one entry per user.
usageRouter.get("/", async (req, res) => {
  const accountId = res.locals.account.id;

  const rawMonth = req.query.month;
  const limit = parseIntParam(req.query.limit, 100, 1, 500);
  const offset = parseIntParam(req.query.offset, 0, 0, 1_000_000);

  if (
    (rawMonth !== undefined && !isMonth(rawMonth)) ||
    limit === null ||
    offset === null
  ) {
    res.status(400).json({
      error:
        "month must be YYYY-MM, limit an integer 1-500, offset an integer >= 0",
    });
    return;
  }

  const month = typeof rawMonth === "string" ? rawMonth : null;

  try {
    const [accountUsage, users] = await Promise.all([
      getAccountUsage(accountId, month),
      listUserUsage(accountId, month, limit, offset),
    ]);

    res.status(200).json({
      month: accountUsage.month,
      account: accountUsage.account,
      users,
    });
  } catch (error) {
    console.error("Failed to fetch usage:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /usage/users/:externalUserId?month=YYYY-MM
// One user together with the account it counts against.
usageRouter.get("/users/:externalUserId", async (req, res) => {
  const accountId = res.locals.account.id;
  const rawMonth = req.query.month;

  if (rawMonth !== undefined && !isMonth(rawMonth)) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }

  const month = typeof rawMonth === "string" ? rawMonth : null;

  try {
    const [accountUsage, userUsage] = await Promise.all([
      getAccountUsage(accountId, month),
      getUserUsage(accountId, req.params.externalUserId, month),
    ]);

    if (!userUsage) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.status(200).json({
      month: accountUsage.month,
      account: accountUsage.account,
      user: userUsage.user,
    });
  } catch (error) {
    console.error("Failed to fetch user usage:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /usage/history?month=&externalUserId=&accepted=&limit=&cursor=
// Request outcomes, newest first, keyset-paginated.
usageRouter.get("/history", async (req, res) => {
  const accountId = res.locals.account.id;

  const rawMonth = req.query.month;
  const rawUser = req.query.externalUserId;
  const rawAccepted = req.query.accepted;
  const rawCursor = req.query.cursor;
  const limit = parseIntParam(req.query.limit, 50, 1, 200);

  if (limit === null) {
    res.status(400).json({ error: "limit must be an integer 1-200" });
    return;
  }
  if (rawMonth !== undefined && !isMonth(rawMonth)) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }
  if (rawUser !== undefined && typeof rawUser !== "string") {
    res.status(400).json({ error: "externalUserId must be a string" });
    return;
  }
  if (
    rawAccepted !== undefined &&
    rawAccepted !== "true" &&
    rawAccepted !== "false"
  ) {
    res.status(400).json({ error: "accepted must be 'true' or 'false'" });
    return;
  }

  let cursor: HistoryCursor | null = null;
  if (rawCursor !== undefined) {
    cursor = typeof rawCursor === "string" ? decodeCursor(rawCursor) : null;
    if (!cursor) {
      res.status(400).json({ error: "Invalid cursor" });
      return;
    }
  }

  try {
    const history = await getHistory({
      accountId,
      month: typeof rawMonth === "string" ? rawMonth : null,
      externalUserId: typeof rawUser === "string" ? rawUser : null,
      accepted: rawAccepted === undefined ? null : rawAccepted === "true",
      cursor,
      limit,
    });

    res.status(200).json(history);
  } catch (error) {
    console.error("Failed to fetch history:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
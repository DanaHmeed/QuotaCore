import { Router } from "express";
import { pool } from "../config/database.js";
import { authenticateAccount } from "../middleware/authenticateAccount.js";
import { isUuid, isUniqueViolation } from "../utils/validation.js";

export const plansRouter = Router();

plansRouter.use(authenticateAccount);

const PLAN_COLUMNS = `
  id, name, plan_type, monthly_allowance, max_units_per_request,
  is_predefined, created_at
`;

const isValidName = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.trim().length <= 100;

const isValidAllowance = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

const isValidMaxPerRequest = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;

// GET /plans?type=account|user — predefined plans + this account's custom plans
plansRouter.get("/", async (req, res) => {
  const accountId = res.locals.account.id;
  const type = req.query.type;

  if (type !== undefined && type !== "account" && type !== "user") {
    res.status(400).json({ error: "type must be 'account' or 'user'" });
    return;
  }

  try {
    const result = await pool.query(
      `
      SELECT ${PLAN_COLUMNS}
      FROM plans
      WHERE (is_predefined = TRUE OR owner_account_id = $1)
        AND ($2::text IS NULL OR plan_type = $2)
      ORDER BY is_predefined DESC, plan_type, name
      `,
      [accountId, type ?? null]
    );

    res.status(200).json({ plans: result.rows });
  } catch (error) {
    console.error("Failed to list plans:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /plans/:id
plansRouter.get("/:id", async (req, res) => {
  const accountId = res.locals.account.id;
  const planId = req.params.id;

  if (!isUuid(planId)) {
    res.status(400).json({ error: "Invalid plan id" });
    return;
  }

  try {
    const result = await pool.query(
      `
      SELECT ${PLAN_COLUMNS}
      FROM plans
      WHERE id = $1
        AND (is_predefined = TRUE OR owner_account_id = $2)
      `,
      [planId, accountId]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }

    res.status(200).json({ plan: result.rows[0] });
  } catch (error) {
    console.error("Failed to fetch plan:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /plans — create a custom plan owned by the authenticated account
plansRouter.post("/", async (req, res) => {
  const accountId = res.locals.account.id;
  const { name, planType, monthlyAllowance, maxUnitsPerRequest } =
    req.body ?? {};

  if (
    !isValidName(name) ||
    (planType !== "account" && planType !== "user") ||
    !isValidAllowance(monthlyAllowance) ||
    !isValidMaxPerRequest(maxUnitsPerRequest)
  ) {
    res.status(400).json({
      error:
        "name (1-100 chars), planType ('account'|'user'), " +
        "monthlyAllowance (integer >= 0) and " +
        "maxUnitsPerRequest (integer > 0) are required",
    });
    return;
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO plans (
        name, plan_type, monthly_allowance, max_units_per_request,
        owner_account_id, is_predefined
      )
      VALUES ($1, $2, $3, $4, $5, FALSE)
      RETURNING ${PLAN_COLUMNS}
      `,
      [name.trim(), planType, monthlyAllowance, maxUnitsPerRequest, accountId]
    );

    res.status(201).json({
      message: "Plan created successfully",
      plan: result.rows[0],
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      res.status(409).json({
        error: "A custom plan with this name and type already exists",
      });
      return;
    }

    console.error("Plan creation failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /plans/:id — update name and/or limits of a custom plan
plansRouter.patch("/:id", async (req, res) => {
  const accountId = res.locals.account.id;
  const planId = req.params.id;
  const { name, monthlyAllowance, maxUnitsPerRequest } = req.body ?? {};

  if (!isUuid(planId)) {
    res.status(400).json({ error: "Invalid plan id" });
    return;
  }

  if (
    name === undefined &&
    monthlyAllowance === undefined &&
    maxUnitsPerRequest === undefined
  ) {
    res.status(400).json({
      error: "Provide at least one of: name, monthlyAllowance, maxUnitsPerRequest",
    });
    return;
  }

  if (
    (name !== undefined && !isValidName(name)) ||
    (monthlyAllowance !== undefined && !isValidAllowance(monthlyAllowance)) ||
    (maxUnitsPerRequest !== undefined &&
      !isValidMaxPerRequest(maxUnitsPerRequest))
  ) {
    res.status(400).json({ error: "One or more fields are invalid" });
    return;
  }

  try {
    // Distinguish "read-only predefined plan" from "not yours / not found".
    const existing = await pool.query(
      `SELECT is_predefined, owner_account_id FROM plans WHERE id = $1`,
      [planId]
    );

    const plan = existing.rows[0];

    if (!plan || (!plan.is_predefined && plan.owner_account_id !== accountId)) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }

    if (plan.is_predefined) {
      res.status(403).json({ error: "Predefined plans are read-only" });
      return;
    }

    const result = await pool.query(
      `
      UPDATE plans
      SET name = COALESCE($3, name),
          monthly_allowance = COALESCE($4, monthly_allowance),
          max_units_per_request = COALESCE($5, max_units_per_request)
      WHERE id = $1
        AND owner_account_id = $2
        AND is_predefined = FALSE
      RETURNING ${PLAN_COLUMNS}
      `,
      [
        planId,
        accountId,
        name === undefined ? null : name.trim(),
        monthlyAllowance ?? null,
        maxUnitsPerRequest ?? null,
      ]
    );

    res.status(200).json({
      message: "Plan updated",
      plan: result.rows[0],
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      res.status(409).json({
        error: "A custom plan with this name and type already exists",
      });
      return;
    }

    console.error("Plan update failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
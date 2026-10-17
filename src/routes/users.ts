import { Router } from "express";
import { pool } from "../config/database.js";
import { authenticateAccount } from "../middleware/authenticateAccount.js";
import { isUniqueViolation, isUuid } from "../utils/validation.js";

export const usersRouter = Router();

usersRouter.use(authenticateAccount);

// a user together with the plan currently applied to it.
const USER_WITH_PLAN = `
  u.id,
  u.external_user_id AS "externalUserId",
  p.id AS "planId",
  p.name AS "planName",
  p.monthly_allowance AS "monthlyAllowance",
  p.max_units_per_request AS "maxUnitsPerRequest",
  u.created_at AS "createdAt"
`;

// POST /users — register a user under the authenticated account
usersRouter.post("/", async (req, res) => {
  const accountId = res.locals.account.id;
  const { externalUserId, planId } = req.body ?? {};

  if (
    typeof externalUserId !== "string" ||
    externalUserId.trim().length === 0 ||
    externalUserId.length > 150 ||
    !isUuid(planId)
  ) {
    res.status(400).json({
      error: "Valid externalUserId and planId are required",
    });
    return;
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO users (account_id, external_user_id, plan_id)
      SELECT $1, $2, p.id
      FROM plans p
      WHERE p.id = $3
        AND p.plan_type = 'user'
        AND (p.is_predefined = TRUE OR p.owner_account_id = $1)
      RETURNING
        id,
        account_id AS "accountId",
        external_user_id AS "externalUserId",
        plan_id AS "planId",
        created_at AS "createdAt"
      `,
      [accountId, externalUserId.trim(), planId]
    );

    if (result.rowCount === 0) {
      res.status(400).json({
        error: "User plan not found or not accessible",
      });
      return;
    }

    res.status(201).json({
      message: "User created successfully",
      user: result.rows[0],
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      res.status(409).json({
        error: "User already exists in this account",
      });
      return;
    }

    console.error("User creation failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /users — list users of the authenticated account only
usersRouter.get("/", async (_req, res) => {
  const accountId = res.locals.account.id;

  try {
    const result = await pool.query(
      `
      SELECT ${USER_WITH_PLAN}
      FROM users u
      JOIN plans p ON u.plan_id = p.id
      WHERE u.account_id = $1
      ORDER BY u.created_at DESC, u.id DESC
      `,
      [accountId]
    );

    res.status(200).json({ users: result.rows });
  } catch (error) {
    console.error("Failed to fetch users:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /users/:id — one user, only if it belongs to the account
usersRouter.get("/:id", async (req, res) => {
  const accountId = res.locals.account.id;
  const userId = req.params.id;

  if (!isUuid(userId)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  try {
    const result = await pool.query(
      `
      SELECT ${USER_WITH_PLAN}
      FROM users u
      JOIN plans p ON u.plan_id = p.id
      WHERE u.id = $1
        AND u.account_id = $2
      `,
      [userId, accountId]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.status(200).json({ user: result.rows[0] });
  } catch (error) {
    console.error("Failed to fetch user:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /users/:id/plan — switch plan; usage counters are untouched,
// so already-consumed units are preserved.
usersRouter.patch("/:id/plan", async (req, res) => {
  const accountId = res.locals.account.id;
  const userId = req.params.id;
  const { planId } = req.body ?? {};

  if (!isUuid(userId) || !isUuid(planId)) {
    res.status(400).json({
      error: "Valid user id and planId are required",
    });
    return;
  }

  try {
    const result = await pool.query(
      `
      UPDATE users u
      SET plan_id = p.id
      FROM plans p
      WHERE u.id = $1
        AND u.account_id = $2
        AND p.id = $3
        AND p.plan_type = 'user'
        AND (p.is_predefined = TRUE OR p.owner_account_id = $2)
      RETURNING
        u.id,
        u.external_user_id AS "externalUserId",
        u.plan_id AS "planId"
      `,
      [userId, accountId, planId]
    );

    if (result.rowCount === 0) {
      res.status(404).json({
        error: "User not found, or plan not found or not accessible",
      });
      return;
    }

    res.status(200).json({
      message: "User plan updated",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Failed to update user plan:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
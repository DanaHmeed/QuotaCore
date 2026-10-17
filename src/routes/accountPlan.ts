import { Router } from "express";
import { pool } from "../config/database.js";
import { authenticateAccount } from "../middleware/authenticateAccount.js";
import { isUuid } from "../utils/validation.js";

export const accountPlanRouter = Router();

// GET /accounts/me/plan — the account plan currently applied
accountPlanRouter.get("/me/plan", authenticateAccount, async (_req, res) => {
  const accountId = res.locals.account.id;

  try {
    const result = await pool.query(
      `
      SELECT p.id,
             p.name,
             p.monthly_allowance AS "monthlyAllowance",
             p.max_units_per_request AS "maxUnitsPerRequest",
             p.is_predefined AS "isPredefined"
      FROM accounts a
      JOIN plans p ON p.id = a.plan_id
      WHERE a.id = $1
      `,
      [accountId]
    );

    res.status(200).json({ plan: result.rows[0] });
  } catch (error) {
    console.error("Failed to fetch account plan:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /accounts/me/plan — switch the account plan; usage is preserved
accountPlanRouter.put("/me/plan", authenticateAccount, async (req, res) => {
  const accountId = res.locals.account.id;
  const { planId } = req.body ?? {};

  if (!isUuid(planId)) {
    res.status(400).json({ error: "Valid planId is required" });
    return;
  }

  try {
    const result = await pool.query(
      `
      UPDATE accounts a
      SET plan_id = p.id
      FROM plans p
      WHERE a.id = $1
        AND p.id = $2
        AND p.plan_type = 'account'
        AND (p.is_predefined = TRUE OR p.owner_account_id = $1)
      RETURNING p.id,
                p.name,
                p.monthly_allowance AS "monthlyAllowance",
                p.max_units_per_request AS "maxUnitsPerRequest"
      `,
      [accountId, planId]
    );

    if (result.rowCount === 0) {
      res.status(400).json({
        error: "Account plan not found or not accessible",
      });
      return;
    }

    res.status(200).json({
      message: "Account plan updated",
      plan: result.rows[0],
    });
  } catch (error) {
    console.error("Failed to update account plan:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
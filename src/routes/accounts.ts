import { Router } from "express";
import {
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { pool } from "../config/database.js";
import { authenticateAccount } from "../middleware/authenticateAccount.js";

export const accountsRouter = Router();

// Convert a secret into a SHA-256 hash
function hashSecret(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

// Check the administrator bootstrap key
accountsRouter.post("/", async (req, res) => {
  const adminKey = process.env.ADMIN_BOOTSTRAP_KEY;
  const suppliedKey = req.header("X-Admin-Key");

  if (
    !adminKey ||
    !suppliedKey ||
    !timingSafeEqual(
      hashSecret(suppliedKey),
      hashSecret(adminKey)
    )
  ) {
    res.status(401).json({
      error: "Invalid administrator key",
    });
    return;
  }

  const { name, planName } = req.body ?? {};

  if (
    typeof name !== "string" ||
    name.trim().length === 0 ||
    name.length > 150 ||
    typeof planName !== "string"
  ) {
    res.status(400).json({
      error: "Valid name and planName are required",
    });
    return;
  }

  try {
    // Generate a unique API key for this account
    const apiKey = randomBytes(32).toString("hex");

    const apiKeyHash = createHash("sha256")
      .update(apiKey)
      .digest("hex");

    // Create account using an existing account plan
    const result = await pool.query(
      `
      INSERT INTO accounts (name, api_key_hash, plan_id)
      SELECT $1, $2, id
      FROM plans
      WHERE name = $3
        AND plan_type = 'account'
        AND is_predefined = TRUE
      RETURNING id, name, plan_id, created_at
      `,
      [name.trim(), apiKeyHash, planName]
    );

    if (result.rowCount === 0) {
      res.status(400).json({
        error: "Account plan not found",
      });
      return;
    }

    res.status(201).json({
      message: "Account created successfully",
      account: result.rows[0],
      apiKey,
    });
  } catch (error) {
    console.error("Account creation failed:", error);

    res.status(500).json({
      error: "Internal server error",
    });
  }
});

accountsRouter.get(
  "/me",
  authenticateAccount,
  (req, res) => {
    res.status(200).json({
      account: res.locals.account,
    });
  }
);
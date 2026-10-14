import type { RequestHandler } from "express";
import { createHash } from "node:crypto";
import { pool } from "../config/database.js";

export const authenticateAccount: RequestHandler = async (
  req,
  res,
  next
) => {
  const apiKey = req.header("X-API-Key");

  if (!apiKey) {
    res.status(401).json({
      error: "API key is required",
    });
    return;
  }

  const apiKeyHash = createHash("sha256")
    .update(apiKey)
    .digest("hex");

  try {
    const result = await pool.query(
      `
      SELECT id, name, plan_id
      FROM accounts
      WHERE api_key_hash = $1
      `,
      [apiKeyHash]
    );

    if (result.rowCount !== 1) {
      res.status(401).json({
        error: "Invalid API key",
      });
      return;
    }

    res.locals.account = result.rows[0];

    next();
  } catch (error) {
    console.error("Authentication failed:", error);

    res.status(500).json({
      error: "Internal server error",
    });
  }
};
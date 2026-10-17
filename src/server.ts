import express from "express";
import { pool } from "./config/database.js";
import { accountsRouter } from "./routes/accounts.js";
import { usersRouter } from "./routes/users.js";
import { plansRouter } from "./routes/plans.js";
import { accountPlanRouter } from "./routes/accountPlan.js";
import { usageRouter } from "./routes/usage.js";

const app = express();
const PORT = 3000;

app.use(express.json());
app.use("/accounts", accountsRouter);
app.use("/accounts", accountPlanRouter);
app.use("/users", usersRouter);
app.use("/plans", plansRouter);
app.use("/usage", usageRouter);

// Check application health
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "QuotaCore",
  });
});

// Check database connectivity
app.get("/health/db", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.status(200).json({
      status: "ok",
      database: "connected",
    });
  } catch (error) {
    console.error("Database health check failed:", error);

    res.status(503).json({
      status: "error",
      database: "unavailable",
    });
  }
});

app.listen(PORT, () => {
  console.log(`QuotaCore running on port ${PORT}`);
});
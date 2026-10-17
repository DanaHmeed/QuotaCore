import express from "express";
import type { ErrorRequestHandler } from "express";
import { accountsRouter } from "./routes/accounts.js";
import { accountPlanRouter } from "./routes/accountPlan.js";
import { plansRouter } from "./routes/plans.js";
import { usageRouter } from "./routes/usage.js";
import { usersRouter } from "./routes/users.js";

// The app is built here and started in server.ts, so tests can import it
// without opening a port.
export const app = express();

app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use("/accounts", accountsRouter);
app.use("/accounts", accountPlanRouter);
app.use("/users", usersRouter);
app.use("/plans", plansRouter);
app.use("/usage", usageRouter);

// Unknown routes get a JSON 404 instead of Express's default HTML page.
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  // Malformed JSON body.
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
};

app.use(errorHandler);
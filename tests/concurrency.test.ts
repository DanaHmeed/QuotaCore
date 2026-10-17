import { afterAll, describe, expect, it } from "vitest";
import {
  api,
  auth,
  consume,
  counterTotals,
  rid,
  setupAccount,
  teardown,
} from "./helpers.js";

afterAll(teardown);

describe("concurrent consumption", () => {
  it("never accepts more than the user's allowance when 50 requests arrive together", async () => {
    const s = await setupAccount({
      account: { monthly: 1_000, max: 10 },
      user: { monthly: 20, max: 5 },
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => consume(s.account, "u1", 1, rid()))
    );

    const accepted = results.filter((r) => r.body.accepted).length;

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(accepted).toBe(20);

    const totals = await counterTotals(s.account.id);
    expect(totals).toEqual({ account_total: 20, users_sum: 20 });

    const usage = await api().get("/usage/users/u1").set(auth(s.account));
    expect(usage.body.user.remainingUnits).toBe(0);
  });

  it("never accepts more than the shared account allowance across many users", async () => {
    const users = ["u1", "u2", "u3", "u4", "u5"];
    const s = await setupAccount({
      account: { monthly: 30, max: 10 },
      user: { monthly: 100, max: 10 },
      users,
    });

    const calls = users.flatMap((user) =>
      Array.from({ length: 10 }, () => consume(s.account, user, 1, rid()))
    );
    const results = await Promise.all(calls);

    const accepted = results.filter((r) => r.body.accepted).length;
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(accepted).toBe(30);

    // Every rejection came from the shared account limit, not a user limit.
    const rejected = results.filter((r) => !r.body.accepted);
    expect(
      rejected.every(
        (r) =>
          r.body.rejection.scope === "account" &&
          r.body.rejection.rule === "monthly_allowance"
      )
    ).toBe(true);

    const totals = await counterTotals(s.account.id);
    expect(totals).toEqual({ account_total: 30, users_sum: 30 });
  });

  it("counts requests of several units exactly", async () => {
    const s = await setupAccount({
      account: { monthly: 100, max: 50 },
      user: { monthly: 1_000, max: 50 },
    });

    const results = await Promise.all(
      Array.from({ length: 40 }, () => consume(s.account, "u1", 5, rid()))
    );

    const accepted = results.filter((r) => r.body.accepted).length;
    expect(accepted).toBe(20);

    const totals = await counterTotals(s.account.id);
    expect(totals).toEqual({ account_total: 100, users_sum: 100 });
  });

  it("keeps account total equal to the sum of users after mixed concurrent load", async () => {
    const users = ["u1", "u2", "u3"];
    const s = await setupAccount({
      account: { monthly: 200, max: 20 },
      user: { monthly: 80, max: 20 },
      users,
    });

    const calls = users.flatMap((user) =>
      Array.from({ length: 12 }, (_, i) =>
        consume(s.account, user, (i % 4) + 1, rid())
      )
    );
    await Promise.all(calls);

    const totals = await counterTotals(s.account.id);

    expect(totals.account_total).toBe(totals.users_sum);
    expect(totals.account_total).toBeLessThanOrEqual(200);
  });
});
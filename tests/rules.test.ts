import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  auth,
  consume,
  rid,
  seedPreviousMonthUsage,
  setupAccount,
  teardown,
  type Scenario,
} from "./helpers.js";

afterAll(teardown);

const BIG = { monthly: 1_000_000, max: 1000 };

describe("how both plans apply to a request", () => {
  it("rejects with the user per-request limit even when both monthly allowances have room", async () => {
    const s = await setupAccount({
      account: { monthly: 10_000, max: 100 },
      user: { monthly: 1_000, max: 20 },
    });

    const res = await consume(s.account, "u1", 25, rid());

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(false);
    expect(res.body.rejection).toEqual({
      scope: "user",
      rule: "max_units_per_request",
    });
    expect(res.body.remaining).toEqual({ account: 10_000, user: 1_000 });
  });

  it("accepts a request and counts it at both levels", async () => {
    const s = await setupAccount({
      account: { monthly: 10_000, max: 100 },
      user: { monthly: 1_000, max: 20 },
    });

    const res = await consume(s.account, "u1", 10, rid());

    expect(res.body.accepted).toBe(true);
    expect(res.body.rejection).toBeNull();
    expect(res.body.remaining).toEqual({ account: 9_990, user: 990 });
  });

  it("rejects when the account has only 5 units left, even if the user has plenty", async () => {
    const s = await setupAccount({
      account: { monthly: 15, max: 100 },
      user: { monthly: 1_000, max: 20 },
    });

    const first = await consume(s.account, "u1", 10, rid());
    expect(first.body.accepted).toBe(true);
    expect(first.body.remaining.account).toBe(5);

    const second = await consume(s.account, "u1", 10, rid());
    expect(second.body.accepted).toBe(false);
    expect(second.body.rejection).toEqual({
      scope: "account",
      rule: "monthly_allowance",
    });
    expect(second.body.remaining).toEqual({ account: 5, user: 990 });
  });

  it("rejects when the user's monthly allowance is used up, without affecting other users", async () => {
    const s = await setupAccount({
      account: { monthly: 1_000, max: 100 },
      user: { monthly: 15, max: 20 },
      users: ["a", "b"],
    });

    expect((await consume(s.account, "a", 10, rid())).body.accepted).toBe(true);

    const blocked = await consume(s.account, "a", 10, rid());
    expect(blocked.body.accepted).toBe(false);
    expect(blocked.body.rejection).toEqual({
      scope: "user",
      rule: "monthly_allowance",
    });

    const other = await consume(s.account, "b", 10, rid());
    expect(other.body.accepted).toBe(true);
    expect(other.body.remaining.user).toBe(5);
  });

  it("accepts exactly the remaining amount and then rejects one more unit", async () => {
    const s = await setupAccount({
      account: BIG,
      user: { monthly: 10, max: 10 },
    });

    const exact = await consume(s.account, "u1", 10, rid());
    expect(exact.body.accepted).toBe(true);
    expect(exact.body.remaining.user).toBe(0);

    const extra = await consume(s.account, "u1", 1, rid());
    expect(extra.body.accepted).toBe(false);
    expect(extra.body.rejection).toEqual({
      scope: "user",
      rule: "monthly_allowance",
    });
  });

  it("rejects with the account per-request limit", async () => {
    const s = await setupAccount({
      account: { monthly: 1_000, max: 5 },
      user: { monthly: 1_000, max: 20 },
    });

    const res = await consume(s.account, "u1", 6, rid());

    expect(res.body.accepted).toBe(false);
    expect(res.body.rejection).toEqual({
      scope: "account",
      rule: "max_units_per_request",
    });
  });
});

describe("which rule is reported when several fail", () => {
  it("reports the account when both per-request limits are exceeded", async () => {
    const s = await setupAccount({
      account: { monthly: 1_000, max: 5 },
      user: { monthly: 1_000, max: 3 },
    });

    const res = await consume(s.account, "u1", 10, rid());

    expect(res.body.rejection).toEqual({
      scope: "account",
      rule: "max_units_per_request",
    });
  });

  it("reports a per-request rule before a monthly rule", async () => {
    // 10 units breaks the user per-request limit (3) and the account
    // monthly allowance (5). Per-request rules come first.
    const s = await setupAccount({
      account: { monthly: 5, max: 100 },
      user: { monthly: 1_000, max: 3 },
    });

    const res = await consume(s.account, "u1", 10, rid());

    expect(res.body.rejection).toEqual({
      scope: "user",
      rule: "max_units_per_request",
    });
  });

  it("reports the account when both monthly allowances are exhausted", async () => {
    const s = await setupAccount({
      account: { monthly: 10, max: 100 },
      user: { monthly: 10, max: 100 },
    });

    expect((await consume(s.account, "u1", 10, rid())).body.accepted).toBe(true);

    const res = await consume(s.account, "u1", 1, rid());

    expect(res.body.rejection).toEqual({
      scope: "account",
      rule: "monthly_allowance",
    });
  });
});

describe("accounting", () => {
  it("a rejected request consumes nothing", async () => {
    const s = await setupAccount({
      account: BIG,
      user: { monthly: 100, max: 5 },
    });

    const rejected = await consume(s.account, "u1", 6, rid());
    expect(rejected.body.accepted).toBe(false);

    const usage = await api().get("/usage/users/u1").set(auth(s.account));
    expect(usage.body.user.consumedUnits).toBe(0);
    expect(usage.body.account.consumedUnits).toBe(0);
  });

  it("users on the same plan do not share their allowance", async () => {
    const s = await setupAccount({
      account: BIG,
      user: { monthly: 10, max: 10 },
      users: ["a", "b"],
    });

    expect((await consume(s.account, "a", 10, rid())).body.accepted).toBe(true);
    expect((await consume(s.account, "b", 10, rid())).body.accepted).toBe(true);

    expect((await consume(s.account, "a", 1, rid())).body.accepted).toBe(false);
    expect((await consume(s.account, "b", 1, rid())).body.accepted).toBe(false);
  });

  it("account usage is the sum of accepted usage across its users", async () => {
    const s = await setupAccount({
      account: BIG,
      user: { monthly: 100, max: 50 },
      users: ["a", "b", "c"],
    });

    await consume(s.account, "a", 3, rid());
    await consume(s.account, "b", 4, rid());
    await consume(s.account, "c", 5, rid());
    await consume(s.account, "c", 60, rid()); // rejected: over per-request limit

    const res = await api().get("/usage").set(auth(s.account));
    const items = res.body.users.items as Array<{ consumedUnits: number }>;
    const sum = items.reduce((total, item) => total + item.consumedUnits, 0);

    expect(res.body.account.consumedUnits).toBe(12);
    expect(sum).toBe(12);
  });

  it("starts each month at zero: last month's usage does not count", async () => {
    const s = await setupAccount({
      account: { monthly: 10, max: 10 },
      user: { monthly: 10, max: 10 },
    });

    // Last month the user and account used their full allowance.
    await seedPreviousMonthUsage(s.account.id, s.users["u1"]!, 10);

    const res = await consume(s.account, "u1", 10, rid());

    expect(res.body.accepted).toBe(true);
    expect(res.body.remaining).toEqual({ account: 0, user: 0 });
  });
});

describe("input validation", () => {
  let s: Scenario;

  beforeAll(async () => {
    s = await setupAccount({ account: BIG, user: { monthly: 100, max: 50 } });
  });

  it.each([
    ["zero units", { externalUserId: "u1", units: 0, requestId: "x" }],
    ["negative units", { externalUserId: "u1", units: -5, requestId: "x" }],
    ["fractional units", { externalUserId: "u1", units: 1.5, requestId: "x" }],
    ["units sent as a string", { externalUserId: "u1", units: "5", requestId: "x" }],
    ["a missing requestId", { externalUserId: "u1", units: 1 }],
    ["a missing user", { units: 1, requestId: "x" }],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await api().post("/usage/consume").set(auth(s.account)).send(body);

    expect(res.status).toBe(400);
  });

  it("returns 404 for a user that is not registered", async () => {
    const res = await consume(s.account, "nobody", 1, rid());

    expect(res.status).toBe(404);
  });
});
import { afterAll, describe, expect, it } from "vitest";
import {
  api,
  auth,
  consume,
  createAccount,
  createCustomPlan,
  createUser,
  predefinedPlanId,
  rid,
  setupAccount,
  teardown,
} from "./helpers.js";

afterAll(teardown);

const BIG = { monthly: 1_000_000, max: 1000 };

describe("changing plans", () => {
  it("applies an edited plan to the next request, without a restart", async () => {
    const s = await setupAccount({
      account: BIG,
      user: { monthly: 10, max: 10 },
    });

    expect((await consume(s.account, "u1", 10, rid())).body.accepted).toBe(true);
    expect((await consume(s.account, "u1", 1, rid())).body.accepted).toBe(false);

    const edit = await api()
      .patch(`/plans/${s.userPlanId}`)
      .set(auth(s.account))
      .send({ monthlyAllowance: 20 });
    expect(edit.status).toBe(200);
    expect(edit.body.plan.monthlyAllowance).toBe(20);

    const after = await consume(s.account, "u1", 5, rid());
    expect(after.body.accepted).toBe(true);
    expect(after.body.remaining.user).toBe(5);
  });

  it("updates every user that shares the edited plan", async () => {
    const s = await setupAccount({
      account: BIG,
      user: { monthly: 100, max: 50 },
      users: ["a", "b"],
    });

    await api()
      .patch(`/plans/${s.userPlanId}`)
      .set(auth(s.account))
      .send({ maxUnitsPerRequest: 3 });

    for (const user of ["a", "b"]) {
      const res = await consume(s.account, user, 5, rid());
      expect(res.body.accepted).toBe(false);
      expect(res.body.rejection).toEqual({
        scope: "user",
        rule: "max_units_per_request",
      });
    }
  });

  it("keeps consumed units when a user switches plan", async () => {
    const s = await setupAccount({
      account: BIG,
      user: { monthly: 10, max: 10 },
    });

    expect((await consume(s.account, "u1", 8, rid())).body.accepted).toBe(true);

    const big = await createCustomPlan(s.account, "big", "user", {
      monthly: 100,
      max: 50,
    });
    const tiny = await createCustomPlan(s.account, "tiny", "user", {
      monthly: 5,
      max: 5,
    });
    const userId = s.users["u1"]!;

    // Bigger plan: the 8 used units still count, no fresh allowance.
    let switched = await api()
      .patch(`/users/${userId}/plan`)
      .set(auth(s.account))
      .send({ planId: big.id });
    expect(switched.status).toBe(200);

    let usage = await api().get("/usage/users/u1").set(auth(s.account));
    expect(usage.body.user.consumedUnits).toBe(8);
    expect(usage.body.user.remainingUnits).toBe(92);

    // Smaller plan than the usage: remaining is zero and consumption is rejected.
    switched = await api()
      .patch(`/users/${userId}/plan`)
      .set(auth(s.account))
      .send({ planId: tiny.id });
    expect(switched.status).toBe(200);

    usage = await api().get("/usage/users/u1").set(auth(s.account));
    expect(usage.body.user.consumedUnits).toBe(8);
    expect(usage.body.user.remainingUnits).toBe(0);

    const blocked = await consume(s.account, "u1", 1, rid());
    expect(blocked.body.accepted).toBe(false);
    expect(blocked.body.rejection).toEqual({
      scope: "user",
      rule: "monthly_allowance",
    });

    // Back to the bigger plan: allowed again.
    await api()
      .patch(`/users/${userId}/plan`)
      .set(auth(s.account))
      .send({ planId: big.id });
    expect((await consume(s.account, "u1", 1, rid())).body.accepted).toBe(true);
  });

  it("shows zero remaining when an allowance is reduced below existing usage", async () => {
    const s = await setupAccount({
      account: BIG,
      user: { monthly: 100, max: 50 },
    });

    await consume(s.account, "u1", 30, rid());

    await api()
      .patch(`/plans/${s.userPlanId}`)
      .set(auth(s.account))
      .send({ monthlyAllowance: 10 });

    const usage = await api().get("/usage/users/u1").set(auth(s.account));
    expect(usage.body.user.consumedUnits).toBe(30);
    expect(usage.body.user.remainingUnits).toBe(0);

    const blocked = await consume(s.account, "u1", 1, rid());
    expect(blocked.body.accepted).toBe(false);
  });

  it("keeps account usage when the account switches plan", async () => {
    const s = await setupAccount({
      account: { monthly: 100, max: 50 },
      user: { monthly: 100, max: 50 },
    });

    await consume(s.account, "u1", 10, rid());

    const small = await createCustomPlan(s.account, "small", "account", {
      monthly: 8,
      max: 50,
    });

    const switched = await api()
      .put("/accounts/me/plan")
      .set(auth(s.account))
      .send({ planId: small.id });
    expect(switched.status).toBe(200);

    const usage = await api().get("/usage").set(auth(s.account));
    expect(usage.body.account.consumedUnits).toBe(10);
    expect(usage.body.account.remainingUnits).toBe(0);

    const blocked = await consume(s.account, "u1", 1, rid());
    expect(blocked.body.rejection).toEqual({
      scope: "account",
      rule: "monthly_allowance",
    });

    await api()
      .put("/accounts/me/plan")
      .set(auth(s.account))
      .send({ planId: s.accountPlanId });

    expect((await consume(s.account, "u1", 1, rid())).body.accepted).toBe(true);
  });

  it("preserves past request history when a plan changes", async () => {
    const s = await setupAccount({
      account: BIG,
      user: { monthly: 10, max: 5 },
    });

    const okId = rid();
    const rejectedId = rid();
    await consume(s.account, "u1", 5, okId);
    await consume(s.account, "u1", 6, rejectedId);

    await api()
      .patch(`/plans/${s.userPlanId}`)
      .set(auth(s.account))
      .send({ monthlyAllowance: 1000, maxUnitsPerRequest: 100 });

    const history = await api().get("/usage/history").set(auth(s.account));
    const byId = new Map(
      (history.body.items as Array<{ requestId: string; accepted: boolean }>).map(
        (item) => [item.requestId, item.accepted]
      )
    );

    expect(history.body.items).toHaveLength(2);
    expect(byId.get(okId)).toBe(true);
    // The old rejection stays recorded as a rejection, even though the same
    // request would be accepted under the new plan.
    expect(byId.get(rejectedId)).toBe(false);
  });
});

describe("plan management", () => {
  it("keeps predefined plans read-only", async () => {
    const account = await createAccount();
    const basicId = await predefinedPlanId(account, "Basic", "user");

    const res = await api()
      .patch(`/plans/${basicId}`)
      .set(auth(account))
      .send({ monthlyAllowance: 999_999 });

    expect(res.status).toBe(403);
  });

  it.each([
    ["a missing name", { planType: "user", monthlyAllowance: 10, maxUnitsPerRequest: 5 }],
    ["an unknown planType", { name: "x", planType: "team", monthlyAllowance: 10, maxUnitsPerRequest: 5 }],
    ["zero maxUnitsPerRequest", { name: "x", planType: "user", monthlyAllowance: 10, maxUnitsPerRequest: 0 }],
    ["a negative allowance", { name: "x", planType: "user", monthlyAllowance: -1, maxUnitsPerRequest: 5 }],
    ["a string allowance", { name: "x", planType: "user", monthlyAllowance: "10", maxUnitsPerRequest: 5 }],
    ["a fractional allowance", { name: "x", planType: "user", monthlyAllowance: 1.5, maxUnitsPerRequest: 5 }],
  ])("rejects a plan with %s", async (_label, body) => {
    const account = await createAccount();

    const res = await api().post("/plans").set(auth(account)).send(body);

    expect(res.status).toBe(400);
  });

  it("rejects a duplicate custom plan name for the same type but allows it for the other type", async () => {
    const account = await createAccount();
    const limits = { monthly: 10, max: 5 };

    await createCustomPlan(account, "Team", "user", limits);

    const duplicate = await api()
      .post("/plans")
      .set(auth(account))
      .send({
        name: "Team",
        planType: "user",
        monthlyAllowance: 10,
        maxUnitsPerRequest: 5,
      });
    expect(duplicate.status).toBe(409);

    const otherType = await api()
      .post("/plans")
      .set(auth(account))
      .send({
        name: "Team",
        planType: "account",
        monthlyAllowance: 10,
        maxUnitsPerRequest: 5,
      });
    expect(otherType.status).toBe(201);
  });

  it("assigns by planId, so a custom plan may reuse a predefined plan's name", async () => {
    const account = await createAccount();

    const custom = await createCustomPlan(account, "Basic", "user", {
      monthly: 7,
      max: 7,
    });
    const userId = await createUser(account, "u1", custom.id);

    const res = await api().get(`/users/${userId}`).set(auth(account));

    expect(res.status).toBe(200);
    expect(res.body.user.planId).toBe(custom.id);
    expect(res.body.user.monthlyAllowance).toBe(7);
  });

  it("does not accept a user plan for an account and vice versa", async () => {
    const account = await createAccount();
    const userPlan = await createCustomPlan(account, "u-plan", "user", {
      monthly: 10,
      max: 5,
    });
    const accountPlan = await createCustomPlan(account, "a-plan", "account", {
      monthly: 10,
      max: 5,
    });

    const wrongForAccount = await api()
      .put("/accounts/me/plan")
      .set(auth(account))
      .send({ planId: userPlan.id });
    expect(wrongForAccount.status).toBe(400);

    const wrongForUser = await api()
      .post("/users")
      .set(auth(account))
      .send({ externalUserId: "u1", planId: accountPlan.id });
    expect(wrongForUser.status).toBe(400);
  });

  it("requires at least one valid field to update a plan and ignores planType changes", async () => {
    const account = await createAccount();
    const plan = await createCustomPlan(account, "p", "user", {
      monthly: 10,
      max: 5,
    });

    const empty = await api()
      .patch(`/plans/${plan.id}`)
      .set(auth(account))
      .send({ planType: "account" });

    expect(empty.status).toBe(400);
  });

  it("returns 400 for malformed ids", async () => {
    const account = await createAccount();

    const plan = await api().get("/plans/not-a-uuid").set(auth(account));
    const user = await api().get("/users/not-a-uuid").set(auth(account));

    expect(plan.status).toBe(400);
    expect(user.status).toBe(400);
  });
});
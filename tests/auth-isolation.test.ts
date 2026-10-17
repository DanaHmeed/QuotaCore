import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  auth,
  consume,
  createAccount,
  createCustomPlan,
  createUser,
  predefinedPlanId,
  rid,
  teardown,
  type TestAccount,
} from "./helpers.js";

afterAll(teardown);

describe("API key validation", () => {
  let account: TestAccount;

  beforeAll(async () => {
    account = await createAccount();
  });

  it.each([
    ["GET", "/accounts/me"],
    ["GET", "/accounts/me/plan"],
    ["GET", "/users"],
    ["GET", "/plans"],
    ["GET", "/usage"],
    ["GET", "/usage/history"],
    ["POST", "/usage/consume"],
  ])("%s %s without an API key returns 401", async (method, path) => {
    const res =
      method === "GET"
        ? await api().get(path)
        : await api().post(path).send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBeTruthy();
  });

  it("rejects an unknown API key", async () => {
    const res = await api()
      .get("/accounts/me")
      .set("X-API-Key", "0".repeat(64));

    expect(res.status).toBe(401);
  });

  it("rejects an empty API key", async () => {
    const res = await api().get("/accounts/me").set("X-API-Key", "");

    expect(res.status).toBe(401);
  });

  it("accepts a valid API key and identifies the account", async () => {
    const res = await api().get("/accounts/me").set(auth(account));

    expect(res.status).toBe(200);
    expect(res.body.account.id).toBe(account.id);
  });

  it("does not accept an account API key as the admin key", async () => {
    const res = await api()
      .post("/accounts")
      .set("X-Admin-Key", account.apiKey)
      .send({ name: "should-not-exist", planName: "Starter" });

    expect([401, 403]).toContain(res.status);
  });

  it("rejects account creation without the admin key", async () => {
    const res = await api()
      .post("/accounts")
      .send({ name: "should-not-exist", planName: "Starter" });

    expect([401, 403]).toContain(res.status);
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await api().get("/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });

  it("returns 400 for a malformed JSON body", async () => {
    const res = await api()
      .post("/usage/consume")
      .set(auth(account))
      .set("Content-Type", "application/json")
      .send("{ not json");

    expect(res.status).toBe(400);
  });
});

describe("account isolation", () => {
  let a: TestAccount;
  let b: TestAccount;
  let aliceId: string;
  let aPrivateUserPlanId: string;
  let aPrivateAccountPlanId: string;

  beforeAll(async () => {
    a = await createAccount();
    b = await createAccount();

    const basicId = await predefinedPlanId(a, "Basic", "user");
    aliceId = await createUser(a, "alice", basicId);

    aPrivateUserPlanId = (
      await createCustomPlan(a, "a-private-user", "user", { monthly: 50, max: 5 })
    ).id;
    aPrivateAccountPlanId = (
      await createCustomPlan(a, "a-private-account", "account", {
        monthly: 500,
        max: 50,
      })
    ).id;
  });

  it("does not let B read A's user", async () => {
    const res = await api().get(`/users/${aliceId}`).set(auth(b));

    expect(res.status).toBe(404);
  });

  it("does not list A's users for B", async () => {
    const res = await api().get("/users").set(auth(b));

    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
  });

  it("does not let B change the plan of A's user", async () => {
    const basicId = await predefinedPlanId(b, "Premium", "user");
    const res = await api()
      .patch(`/users/${aliceId}/plan`)
      .set(auth(b))
      .send({ planId: basicId });

    expect(res.status).toBe(404);
  });

  it("does not let B consume for A's user, and A's usage is untouched", async () => {
    const res = await consume(b, "alice", 1, rid());
    expect(res.status).toBe(404);

    const usage = await api().get("/usage/users/alice").set(auth(a));
    expect(usage.status).toBe(200);
    expect(usage.body.user.consumedUnits).toBe(0);
    expect(usage.body.account.consumedUnits).toBe(0);
  });

  it("does not show B a user that exists only in A through usage endpoints", async () => {
    const res = await api().get("/usage/users/alice").set(auth(b));

    expect(res.status).toBe(404);
  });

  it("does not let B read or edit A's custom plans", async () => {
    const read = await api().get(`/plans/${aPrivateUserPlanId}`).set(auth(b));
    expect(read.status).toBe(404);

    const edit = await api()
      .patch(`/plans/${aPrivateUserPlanId}`)
      .set(auth(b))
      .send({ monthlyAllowance: 1 });
    expect(edit.status).toBe(404);
  });

  it("does not list A's custom plans for B", async () => {
    const res = await api().get("/plans").set(auth(b));
    const names = (res.body.plans as Array<{ name: string }>).map((p) => p.name);

    expect(names).not.toContain("a-private-user");
    expect(names).not.toContain("a-private-account");
  });

  it("does not let B assign A's custom user plan to a B user", async () => {
    const res = await api()
      .post("/users")
      .set(auth(b))
      .send({ externalUserId: "bob", planId: aPrivateUserPlanId });

    expect(res.status).toBe(400);
  });

  it("does not let B use A's custom account plan", async () => {
    const res = await api()
      .put("/accounts/me/plan")
      .set(auth(b))
      .send({ planId: aPrivateAccountPlanId });

    expect(res.status).toBe(400);
  });

  it("allows the same externalUserId in two accounts with separate usage", async () => {
    const premiumId = await predefinedPlanId(b, "Premium", "user");
    await createUser(b, "alice", premiumId);

    const aConsume = await consume(a, "alice", 5, rid());
    expect(aConsume.body.accepted).toBe(true);

    const aUsage = await api().get("/usage/users/alice").set(auth(a));
    const bUsage = await api().get("/usage/users/alice").set(auth(b));

    expect(aUsage.body.user.consumedUnits).toBe(5);
    expect(bUsage.body.user.consumedUnits).toBe(0);
  });

  it("does not leak history across accounts", async () => {
    const aHistory = await api().get("/usage/history").set(auth(a));
    const bHistory = await api().get("/usage/history").set(auth(b));

    expect(aHistory.body.items.length).toBeGreaterThan(0);
    expect(bHistory.body.items).toEqual([]);
  });
});
import { afterAll, describe, expect, it } from "vitest";
import {
  api,
  auth,
  consume,
  rid,
  setupAccount,
  teardown,
} from "./helpers.js";

afterAll(teardown);

const BIG = { monthly: 1_000_000, max: 1000 };

describe("safe retries", () => {
  it("returns the original decision for a retry and consumes nothing twice", async () => {
    const s = await setupAccount({
      account: BIG,
      user: { monthly: 100, max: 50 },
    });
    const requestId = rid();

    const first = await consume(s.account, "u1", 10, requestId);
    expect(first.body.accepted).toBe(true);
    expect(first.body.replayed).toBe(false);
    expect(first.body.remaining.user).toBe(90);

    const retry = await consume(s.account, "u1", 10, requestId);
    expect(retry.status).toBe(200);
    expect(retry.body.accepted).toBe(true);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.remaining.user).toBe(90);

    const usage = await api().get("/usage/users/u1").set(auth(s.account));
    expect(usage.body.user.consumedUnits).toBe(10);
  });

  it("replays a rejection too, even after the plan would now allow the request", async () => {
    const s = await setupAccount({
      account: BIG,
      user: { monthly: 100, max: 5 },
    });
    const requestId = rid();

    const first = await consume(s.account, "u1", 10, requestId);
    expect(first.body.accepted).toBe(false);

    await api()
      .patch(`/plans/${s.userPlanId}`)
      .set(auth(s.account))
      .send({ maxUnitsPerRequest: 50 });

    // Same requestId: the stored decision is returned.
    const retry = await consume(s.account, "u1", 10, requestId);
    expect(retry.body.accepted).toBe(false);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.rejection).toEqual({
      scope: "user",
      rule: "max_units_per_request",
    });

    // A new requestId is evaluated against the new plan.
    const fresh = await consume(s.account, "u1", 10, rid());
    expect(fresh.body.accepted).toBe(true);
    expect(fresh.body.replayed).toBe(false);
  });

  it("returns 409 when a requestId is reused with different units", async () => {
    const s = await setupAccount({
      account: BIG,
      user: { monthly: 100, max: 50 },
    });
    const requestId = rid();

    await consume(s.account, "u1", 10, requestId);
    const conflict = await consume(s.account, "u1", 3, requestId);

    expect(conflict.status).toBe(409);

    const usage = await api().get("/usage/users/u1").set(auth(s.account));
    expect(usage.body.user.consumedUnits).toBe(10);
  });

  it("returns 409 when a requestId is reused for a different user", async () => {
    const s = await setupAccount({
      account: BIG,
      user: { monthly: 100, max: 50 },
      users: ["a", "b"],
    });
    const requestId = rid();

    await consume(s.account, "a", 10, requestId);
    const conflict = await consume(s.account, "b", 10, requestId);

    expect(conflict.status).toBe(409);
  });

  it("treats the same requestId in two accounts as unrelated requests", async () => {
    const first = await setupAccount({
      account: BIG,
      user: { monthly: 100, max: 50 },
    });
    const second = await setupAccount({
      account: BIG,
      user: { monthly: 100, max: 50 },
    });
    const requestId = rid();

    const a = await consume(first.account, "u1", 10, requestId);
    const b = await consume(second.account, "u1", 10, requestId);

    expect(a.body.accepted).toBe(true);
    expect(a.body.replayed).toBe(false);
    expect(b.body.accepted).toBe(true);
    expect(b.body.replayed).toBe(false);
  });

  it("applies a request once when 20 identical retries arrive at the same time", async () => {
    const s = await setupAccount({
      account: BIG,
      user: { monthly: 100, max: 50 },
    });
    const requestId = rid();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => consume(s.account, "u1", 7, requestId))
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.body.accepted === true)).toBe(true);
    expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1);
    expect(results.filter((r) => r.body.replayed === true)).toHaveLength(19);

    const usage = await api().get("/usage/users/u1").set(auth(s.account));
    expect(usage.body.user.consumedUnits).toBe(7);
    expect(usage.body.account.consumedUnits).toBe(7);
  });
});
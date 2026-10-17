import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  auth,
  consume,
  rid,
  seedPreviousMonthUsage,
  setupAccount,
  teardown,
  utcMonth,
  type Scenario,
} from "./helpers.js";

afterAll(teardown);

describe("usage reports", () => {
  let s: Scenario;

  beforeAll(async () => {
    s = await setupAccount({
      account: { monthly: 1_000, max: 100 },
      user: { monthly: 100, max: 50 },
      users: ["u1", "u2"],
    });

    await consume(s.account, "u1", 3, rid());
    await consume(s.account, "u2", 4, rid());

    // Last month u1 used 6 units (written directly: the API only records
    // usage for the current month).
    await seedPreviousMonthUsage(s.account.id, s.users["u1"]!, 6);
  });

  it("shows consumed and remaining units for the account and each user", async () => {
    const res = await api().get("/usage").set(auth(s.account));

    expect(res.status).toBe(200);
    expect(res.body.month).toBe(utcMonth());
    expect(res.body.account.consumedUnits).toBe(7);
    expect(res.body.account.remainingUnits).toBe(993);
    expect(res.body.account.plan.monthlyAllowance).toBe(1_000);
    expect(res.body.users.total).toBe(2);

    const byUser = new Map(
      (
        res.body.users.items as Array<{
          externalUserId: string;
          consumedUnits: number;
          remainingUnits: number;
        }>
      ).map((item) => [item.externalUserId, item])
    );

    expect(byUser.get("u1")).toMatchObject({ consumedUnits: 3, remainingUnits: 97 });
    expect(byUser.get("u2")).toMatchObject({ consumedUnits: 4, remainingUnits: 96 });
  });

  it("shows a single user together with its account", async () => {
    const res = await api().get("/usage/users/u1").set(auth(s.account));

    expect(res.status).toBe(200);
    expect(res.body.user.externalUserId).toBe("u1");
    expect(res.body.user.consumedUnits).toBe(3);
    expect(res.body.user.plan.maxUnitsPerRequest).toBe(50);
    expect(res.body.account.consumedUnits).toBe(7);
  });

  it("returns 404 for an unknown user", async () => {
    const res = await api().get("/usage/users/nobody").set(auth(s.account));

    expect(res.status).toBe(404);
  });

  it("shows previous months' usage, without a remaining figure", async () => {
    const res = await api()
      .get(`/usage?month=${utcMonth(-1)}`)
      .set(auth(s.account));

    expect(res.status).toBe(200);
    expect(res.body.month).toBe(utcMonth(-1));
    expect(res.body.account.consumedUnits).toBe(6);
    expect(res.body.account.remainingUnits).toBeNull();

    const byUser = new Map(
      (
        res.body.users.items as Array<{
          externalUserId: string;
          consumedUnits: number;
          remainingUnits: number | null;
        }>
      ).map((item) => [item.externalUserId, item])
    );

    expect(byUser.get("u1")).toMatchObject({ consumedUnits: 6, remainingUnits: null });
    expect(byUser.get("u2")).toMatchObject({ consumedUnits: 0, remainingUnits: null });
  });

  it("keeps the current month separate from previous months", async () => {
    const res = await api().get("/usage").set(auth(s.account));

    expect(res.body.account.consumedUnits).toBe(7);
  });

  it("reports zero for a month with no usage", async () => {
    const res = await api()
      .get(`/usage?month=${utcMonth(1)}`)
      .set(auth(s.account));

    expect(res.status).toBe(200);
    expect(res.body.account.consumedUnits).toBe(0);
    expect(res.body.account.remainingUnits).toBeNull();
  });

  it("paginates the user list", async () => {
    const first = await api().get("/usage?limit=1").set(auth(s.account));
    const second = await api().get("/usage?limit=1&offset=1").set(auth(s.account));

    expect(first.body.users.items).toHaveLength(1);
    expect(second.body.users.items).toHaveLength(1);
    expect(first.body.users.items[0].externalUserId).not.toBe(
      second.body.users.items[0].externalUserId
    );
    expect(first.body.users.total).toBe(2);
  });

  it.each([
    ["an invalid month", "/usage?month=2026-13"],
    ["a month in the wrong format", "/usage?month=October"],
    ["limit 0", "/usage?limit=0"],
    ["limit over the maximum", "/usage?limit=501"],
    ["a negative offset", "/usage?offset=-1"],
    ["an invalid month on a user", "/usage/users/u1?month=abc"],
  ])("rejects %s with 400", async (_label, path) => {
    const res = await api().get(path).set(auth(s.account));

    expect(res.status).toBe(400);
  });
});

describe("request history", () => {
  let s: Scenario;
  const requestIds: string[] = [];
  const TOTAL = 23;

  beforeAll(async () => {
    s = await setupAccount({
      account: { monthly: 1_000_000, max: 1000 },
      user: { monthly: 1_000, max: 5 },
      users: ["u1", "u2"],
    });

    // Sequential on purpose, so creation order is well defined.
    // Even index: 1 unit (accepted). Odd index: 6 units (over the limit of 5).
    for (let i = 0; i < TOTAL; i++) {
      const requestId = rid();
      requestIds.push(requestId);
      await consume(s.account, "u1", i % 2 === 0 ? 1 : 6, requestId);
    }

    await consume(s.account, "u2", 1, rid());
    await consume(s.account, "u2", 1, rid());
  });

  it("pages through every request exactly once, newest first", async () => {
    const seen: Array<{ id: string; requestId: string; createdAt: string }> = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url: string =
        `/usage/history?limit=5` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const res = await api().get(url).set(auth(s.account));

      expect(res.status).toBe(200);
      seen.push(...res.body.items);
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);

    const total = TOTAL + 2;
    expect(seen).toHaveLength(total);
    expect(new Set(seen.map((item) => item.id)).size).toBe(total);
    expect(pages).toBe(Math.ceil(total / 5));

    const times = seen.map((item) => item.createdAt);
    expect(times).toEqual([...times].sort().reverse());
  });

  it("returns a null cursor when everything fits in one page", async () => {
    const res = await api().get("/usage/history?limit=200").set(auth(s.account));

    expect(res.body.items).toHaveLength(TOTAL + 2);
    expect(res.body.nextCursor).toBeNull();
  });

  it("describes rejected requests with their scope and rule", async () => {
    const res = await api()
      .get("/usage/history?accepted=false&limit=200")
      .set(auth(s.account));

    expect(res.body.items).toHaveLength(11);
    for (const item of res.body.items) {
      expect(item.accepted).toBe(false);
      expect(item.units).toBe(6);
      expect(item.rejection).toEqual({
        scope: "user",
        rule: "max_units_per_request",
      });
    }
  });

  it("filters accepted requests", async () => {
    const res = await api()
      .get("/usage/history?accepted=true&limit=200")
      .set(auth(s.account));

    expect(res.body.items).toHaveLength(12 + 2);
    expect(res.body.items.every((item: { accepted: boolean }) => item.accepted)).toBe(
      true
    );
    expect(res.body.items[0].rejection).toBeNull();
  });

  it("filters by user", async () => {
    const res = await api()
      .get("/usage/history?externalUserId=u2&limit=200")
      .set(auth(s.account));

    expect(res.body.items).toHaveLength(2);
    expect(
      res.body.items.every(
        (item: { externalUserId: string }) => item.externalUserId === "u2"
      )
    ).toBe(true);
  });

  it("filters by month", async () => {
    const current = await api()
      .get(`/usage/history?month=${utcMonth()}&limit=200`)
      .set(auth(s.account));
    const previous = await api()
      .get(`/usage/history?month=${utcMonth(-1)}&limit=200`)
      .set(auth(s.account));

    expect(current.body.items).toHaveLength(TOTAL + 2);
    expect(previous.body.items).toEqual([]);
    expect(previous.body.nextCursor).toBeNull();
  });

  it.each([
    ["limit 0", "/usage/history?limit=0"],
    ["limit over the maximum", "/usage/history?limit=201"],
    ["an invalid month", "/usage/history?month=2026-00"],
    ["an invalid accepted flag", "/usage/history?accepted=maybe"],
    ["a garbage cursor", "/usage/history?cursor=garbage"],
  ])("rejects %s with 400", async (_label, path) => {
    const res = await api().get(path).set(auth(s.account));

    expect(res.status).toBe(400);
  });
});
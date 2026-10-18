
export class QuotaCoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(`QuotaCore responded with status ${status}`);
  }
}

export interface PlanView {
  id: string;
  name: string;
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
}

export interface Level {
  plan: PlanView;
  consumedUnits: number;
  remainingUnits: number | null;
}

export type AccountLevel = Level & { id: string; name: string };
export type UserLevel = Level & { id: string; externalUserId: string };

export interface UsageResponse {
  month: string;
  account: AccountLevel;
  users: { items: UserLevel[]; total: number };
}

export interface UserUsageResponse {
  month: string;
  account: AccountLevel;
  user: UserLevel;
}

export interface Rejection {
  scope: "account" | "user";
  rule: "max_units_per_request" | "monthly_allowance";
}

export interface ConsumeResponse {
  accepted: boolean;
  requestId: string;
  units: number;
  replayed: boolean;
  rejection: Rejection | null;
  remaining: { account: number; user: number };
}

export interface HistoryItem {
  id: string;
  requestId: string;
  externalUserId: string;
  units: number;
  accepted: boolean;
  rejection: Rejection | null;
  createdAt: string;
}

export interface PlanSummary {
  id: string;
  name: string;
  planType: "account" | "user";
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
  isPredefined: boolean;
}

export class QuotaCoreClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "X-API-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    const data: unknown = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new QuotaCoreError(response.status, data);
    }

    return data as T;
  }


  consume(
    externalUserId: string,
    units: number,
    requestId: string
  ): Promise<ConsumeResponse> {
    return this.call("POST", "/usage/consume", {
      externalUserId,
      units,
      requestId,
    });
  }

  // ---- Reading usage and history ----

  getUsage(): Promise<UsageResponse> {
    return this.call("GET", "/usage");
  }

  getUserUsage(externalUserId: string): Promise<UserUsageResponse> {
    return this.call(
      "GET",
      `/usage/users/${encodeURIComponent(externalUserId)}`
    );
  }

  async getHistory(limit: number): Promise<{ items: HistoryItem[] }> {
    return this.call("GET", `/usage/history?limit=${limit}`);
  }

  // Plans and users (used by the demo setup and the configuration panel) 

  async listPlans(): Promise<PlanSummary[]> {
    const res = await this.call<{ plans: PlanSummary[] }>("GET", "/plans");
    return res.plans;
  }

  async createPlan(
    name: string,
    planType: "account" | "user",
    monthlyAllowance: number,
    maxUnitsPerRequest: number
  ): Promise<{ id: string }> {
    const res = await this.call<{ plan: { id: string } }>("POST", "/plans", {
      name,
      planType,
      monthlyAllowance,
      maxUnitsPerRequest,
    });
    return res.plan;
  }

  async createUser(externalUserId: string, planId: string): Promise<void> {
    await this.call("POST", "/users", { externalUserId, planId });
  }

  async switchUserPlan(userId: string, planId: string): Promise<void> {
    await this.call("PATCH", `/users/${userId}/plan`, { planId });
  }

  async switchAccountPlan(planId: string): Promise<void> {
    await this.call("PUT", "/accounts/me/plan", { planId });
  }

  async updatePlan(
    planId: string,
    patch: { monthlyAllowance?: number; maxUnitsPerRequest?: number }
  ): Promise<void> {
    await this.call("PATCH", `/plans/${planId}`, patch);
  }
}
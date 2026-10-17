export type Scope = "account" | "user";
export type Rule = "max_units_per_request" | "monthly_allowance";

export interface Rejection {
  scope: Scope;
  rule: Rule;
}

export interface LevelState {
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
  consumedUnits: number;
}

export function remainingUnits(level: LevelState): number {
  return Math.max(0, level.monthlyAllowance - level.consumedUnits);
}

export function evaluate(
  units: number,
  account: LevelState,
  user: LevelState
): Rejection | null {
  if (units > account.maxUnitsPerRequest) {
    return { scope: "account", rule: "max_units_per_request" };
  }
  if (units > user.maxUnitsPerRequest) {
    return { scope: "user", rule: "max_units_per_request" };
  }
  if (units > remainingUnits(account)) {
    return { scope: "account", rule: "monthly_allowance" };
  }
  if (units > remainingUnits(user)) {
    return { scope: "user", rule: "monthly_allowance" };
  }
  return null;
}
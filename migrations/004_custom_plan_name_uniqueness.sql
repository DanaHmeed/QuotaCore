CREATE UNIQUE INDEX uq_custom_plans
ON plans (owner_account_id, name, plan_type)
WHERE is_predefined = FALSE;
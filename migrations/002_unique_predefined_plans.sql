CREATE UNIQUE INDEX uq_predefined_plans
ON plans (name, plan_type)
WHERE is_predefined = TRUE;
-- Plans
CREATE TABLE plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name VARCHAR(100) NOT NULL,

    plan_type VARCHAR(20) NOT NULL
        CHECK (plan_type IN ('account', 'user')),

    monthly_allowance BIGINT NOT NULL
        CHECK (monthly_allowance >= 0),

    max_units_per_request BIGINT NOT NULL
        CHECK (max_units_per_request > 0),

    owner_account_id UUID,

    is_predefined BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        (is_predefined = TRUE AND owner_account_id IS NULL)
        OR
        (is_predefined = FALSE AND owner_account_id IS NOT NULL)
    )
);

-- Accounts
CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name VARCHAR(150) NOT NULL,

    api_key_hash TEXT NOT NULL UNIQUE,

    plan_id UUID NOT NULL REFERENCES plans(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Plan ownership references an existing account.
ALTER TABLE plans
ADD CONSTRAINT fk_plans_owner
FOREIGN KEY (owner_account_id) REFERENCES accounts(id);

-- Users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL REFERENCES accounts(id),

    external_user_id VARCHAR(150) NOT NULL,

    plan_id UUID NOT NULL REFERENCES plans(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (account_id, external_user_id)
);

-- Usage Counters
CREATE TABLE usage_counters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL REFERENCES accounts(id),

    user_id UUID REFERENCES users(id),

    month_start DATE NOT NULL,

    consumed_units BIGINT NOT NULL DEFAULT 0
        CHECK (consumed_units >= 0),

    CHECK (
        EXTRACT(DAY FROM month_start) = 1
    )
);

-- One account-wide counter per month
CREATE UNIQUE INDEX uq_account_month_usage
ON usage_counters(account_id, month_start)
WHERE user_id IS NULL;

-- One individual counter per user per month
CREATE UNIQUE INDEX uq_user_month_usage
ON usage_counters(account_id, user_id, month_start)
WHERE user_id IS NOT NULL;

-- Consumption Requests
CREATE TABLE consumption_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL REFERENCES accounts(id),

    user_id UUID NOT NULL REFERENCES users(id),

    request_id VARCHAR(150) NOT NULL,

    requested_units BIGINT NOT NULL
        CHECK (requested_units > 0),

    accepted BOOLEAN NOT NULL,

    rejection_scope VARCHAR(20)
        CHECK (rejection_scope IN ('account', 'user')),

    rejection_rule VARCHAR(50),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (account_id, request_id),

    CHECK (
        (accepted = TRUE AND rejection_scope IS NULL
         AND rejection_rule IS NULL)
        OR
        (accepted = FALSE AND rejection_scope IS NOT NULL
         AND rejection_rule IS NOT NULL)
    )
);

CREATE INDEX idx_consumption_history
ON consumption_requests(account_id, created_at DESC);
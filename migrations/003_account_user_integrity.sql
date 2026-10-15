-- Allow composite foreign keys to reference users by
-- their ID together with their owning account.

ALTER TABLE users
ADD CONSTRAINT uq_users_account_id_id
UNIQUE (account_id, id);

-- Prevent consumption requests from referring to a user
-- belonging to a different account.

ALTER TABLE consumption_requests
ADD CONSTRAINT fk_consumption_user_account
FOREIGN KEY (account_id, user_id)
REFERENCES users(account_id, id);

-- Apply the same account ownership rule to usage counters.

ALTER TABLE usage_counters
ADD CONSTRAINT fk_usage_user_account
FOREIGN KEY (account_id, user_id)
REFERENCES users(account_id, id);
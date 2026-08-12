CREATE TABLE inventory_easy_manager_commits (
    id INTEGER NOT NULL PRIMARY KEY,
    idempotency_key VARCHAR(100) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    response_json TEXT NOT NULL,
    created_by_user_id INTEGER NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    FOREIGN KEY(created_by_user_id) REFERENCES users (id)
);

CREATE UNIQUE INDEX ix_inventory_easy_manager_commits_idempotency_key
ON inventory_easy_manager_commits (idempotency_key);

CREATE INDEX ix_inventory_easy_manager_commits_created_by_user_id
ON inventory_easy_manager_commits (created_by_user_id);

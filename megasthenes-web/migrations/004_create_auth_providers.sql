-- Create auth_providers table for OAuth connections
-- Supports multiple providers per user (GitHub, GitLab, Google, etc.)
CREATE TABLE auth_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider INTEGER NOT NULL,             -- 1=GitHub, 2=GitLab, 3=Google
    provider_user_id TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TEXT NOT NULL,        -- Tokens expire after 30 days
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider, provider_user_id)
);

CREATE INDEX idx_auth_providers_user_id ON auth_providers(user_id);
CREATE INDEX idx_auth_providers_provider ON auth_providers(provider, provider_user_id);

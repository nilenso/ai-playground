-- Create repositories table to store unique repository URLs and their metadata
CREATE TABLE repositories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_input_url TEXT NOT NULL,
    git_url TEXT NOT NULL UNIQUE,
    -- NOTE: The concept of a "default commit" for a repository is problematic.
    -- Repositories don't really have a single default commit - they have branches
    -- (like main/master) that move over time. This field stores what was resolved
    -- as the default at the time of first connection, but its meaning is unclear.
    -- TODO: Reconsider this field - perhaps we should store default_branch instead,
    -- or remove this entirely and always require explicit commit specification.
    default_commit TEXT NOT NULL,
    summary TEXT,
    repository_name TEXT NOT NULL,
    username_or_organization TEXT NOT NULL,
    forge_domain TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    summary_last_computed_at TEXT,
    summary_last_computed_for TEXT
);

CREATE INDEX idx_repositories_git_url ON repositories(git_url);
CREATE INDEX idx_repositories_forge_domain ON repositories(forge_domain);

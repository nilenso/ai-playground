CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    host TEXT NOT NULL,
    owner TEXT NOT NULL,
    repository TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(host, owner, repository)
);

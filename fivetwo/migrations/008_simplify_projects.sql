-- Create new table with simplified schema
CREATE TABLE projects_new (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    repository_url TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(repository_url)
);

-- Drop old table and rename new one
DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

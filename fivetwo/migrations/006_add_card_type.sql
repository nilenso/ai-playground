-- Add type column to cards table
ALTER TABLE cards ADD COLUMN type TEXT NOT NULL DEFAULT 'task' 
  CHECK(type IN ('story', 'bug', 'task', 'epic', 'spike', 'chore'));

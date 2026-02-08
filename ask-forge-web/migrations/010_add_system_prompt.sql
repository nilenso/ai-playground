-- Add system_prompt column to sessions table to store the prompt used for each session
ALTER TABLE sessions ADD COLUMN system_prompt TEXT;

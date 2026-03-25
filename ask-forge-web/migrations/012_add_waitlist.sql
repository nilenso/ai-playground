-- Replace the hard allowlist with a waitlist system.
-- Anyone can sign up but new users land in 'waitlisted' status.
-- Admins can approve them.

-- Add status and admin columns to users
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'waitlisted';
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- All existing users are already approved (they passed the old allowlist)
UPDATE users SET status = 'approved';

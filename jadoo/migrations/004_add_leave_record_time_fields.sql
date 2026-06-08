-- Add optional time fields for time-specific leave requests
ALTER TABLE leave_records ADD COLUMN start_time TEXT;
ALTER TABLE leave_records ADD COLUMN end_time TEXT;

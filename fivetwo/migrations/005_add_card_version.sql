-- Add version column to cards table
ALTER TABLE cards ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- Trigger for card updates (exclude version-only updates to prevent infinite loop)
CREATE TRIGGER increment_card_version_on_update
AFTER UPDATE ON cards
WHEN OLD.title != NEW.title 
  OR OLD.description IS NOT NEW.description 
  OR OLD.status != NEW.status 
  OR OLD.priority != NEW.priority
BEGIN
  UPDATE cards SET version = version + 1 WHERE id = NEW.id;
END;

-- Trigger for comment insert
CREATE TRIGGER increment_card_version_on_comment_add
AFTER INSERT ON comments
BEGIN
  UPDATE cards SET version = version + 1 WHERE id = NEW.card_id;
END;

-- Trigger for comment soft-delete (status change to 'deleted')
CREATE TRIGGER increment_card_version_on_comment_delete
AFTER UPDATE ON comments
WHEN OLD.status != 'deleted' AND NEW.status = 'deleted'
BEGIN
  UPDATE cards SET version = version + 1 WHERE id = NEW.card_id;
END;

-- Trigger for reference insert
CREATE TRIGGER increment_card_version_on_reference_add
AFTER INSERT ON card_references
BEGIN
  UPDATE cards SET version = version + 1 WHERE id = NEW.source_card_id;
END;

-- Trigger for reference delete
CREATE TRIGGER increment_card_version_on_reference_delete
AFTER DELETE ON card_references
BEGIN
  UPDATE cards SET version = version + 1 WHERE id = OLD.source_card_id;
END;

-- Full-text search virtual table for cards
CREATE VIRTUAL TABLE cards_fts USING fts5(
    title,
    description,
    content='cards',
    content_rowid='id'
);

-- Triggers to keep FTS index in sync with cards table
CREATE TRIGGER cards_fts_insert AFTER INSERT ON cards BEGIN
    INSERT INTO cards_fts(rowid, title, description)
    VALUES (NEW.id, NEW.title, NEW.description);
END;

CREATE TRIGGER cards_fts_delete AFTER DELETE ON cards BEGIN
    INSERT INTO cards_fts(cards_fts, rowid, title, description)
    VALUES ('delete', OLD.id, OLD.title, OLD.description);
END;

CREATE TRIGGER cards_fts_update AFTER UPDATE ON cards BEGIN
    INSERT INTO cards_fts(cards_fts, rowid, title, description)
    VALUES ('delete', OLD.id, OLD.title, OLD.description);
    INSERT INTO cards_fts(rowid, title, description)
    VALUES (NEW.id, NEW.title, NEW.description);
END;

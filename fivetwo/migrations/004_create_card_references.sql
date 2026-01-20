CREATE TABLE card_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_card_id INTEGER NOT NULL REFERENCES cards(id),
    target_card_id INTEGER NOT NULL REFERENCES cards(id),
    reference_type TEXT NOT NULL CHECK(reference_type IN (
        'blocks', 'blocked_by',
        'relates_to',
        'duplicates', 'duplicated_by',
        'parent_of', 'child_of',
        'follows', 'precedes',
        'clones', 'cloned_by'
    )),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_card_id, target_card_id, reference_type),
    CHECK(source_card_id != target_card_id)
);

CREATE INDEX idx_card_references_source ON card_references(source_card_id);
CREATE INDEX idx_card_references_target ON card_references(target_card_id);

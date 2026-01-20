-- Add card_number column for per-project card numbering
ALTER TABLE cards ADD COLUMN card_number INTEGER;

-- Populate existing cards with card_numbers based on creation order within each project
-- Using a CTE to calculate the row number per project, ordered by creation time
WITH numbered_cards AS (
  SELECT 
    id,
    ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at, id) as rn
  FROM cards
)
UPDATE cards 
SET card_number = (
  SELECT rn FROM numbered_cards WHERE numbered_cards.id = cards.id
);

-- Create unique index for project_id + card_number
CREATE UNIQUE INDEX idx_cards_project_card_number ON cards(project_id, card_number);

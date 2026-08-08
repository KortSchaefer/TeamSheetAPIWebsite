-- Preserve the menu-category seed introduced by Alembic revision 0005.
INSERT INTO menu_categories
  (name, description, active, display_order)
VALUES
  ('Drinks', 'POS V1 category', 1, 1),
  ('Apps', 'POS V1 category', 1, 2),
  ('Apps as Meal', 'POS V1 category', 1, 3),
  ('Salads', 'POS V1 category', 1, 4),
  ('Steaks', 'POS V1 category', 1, 5),
  ('Chicken', 'POS V1 category', 1, 6),
  ('Ribs', 'POS V1 category', 1, 7),
  ('Combos', 'POS V1 category', 1, 8),
  ('Prime', 'POS V1 category', 1, 9),
  ('Special', 'POS V1 category', 1, 10),
  ('Seafood', 'POS V1 category', 1, 11)
ON CONFLICT(name) DO UPDATE SET
  description = excluded.description,
  active = excluded.active,
  display_order = excluded.display_order;

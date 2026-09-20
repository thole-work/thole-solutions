-- Business-type modules seed (Step 3: module-gated workspaces).
-- Idempotent — run in the Supabase SQL editor; safe to re-run after edits.
--
-- Each business type gets a module set; the frontend (TAB_MODULES in app.js)
-- hides any nav tab whose module is not in the set, so a business only ever
-- touches the tables its type owns:
--   kitchen    -> restaurant_tables, dine_in orders, KDS
--   inventory  -> raw_materials, recipe_items, stock_movements
--   production -> produce_batches, waste_log, labor_shifts
--   pos / crm / finance / procurement are seeded for every current type so
--   they stay universal; uncomment the commented TAB_MODULES lines in app.js
--   once you want owners to be able to turn them off per business.

-- 1) Module catalog (harmless no-op for keys already present).
INSERT INTO modules (key, display_name, description) VALUES
  ('pos', 'Point of Sale', 'Sales, orders and payments at the counter.'),
  ('kitchen', 'Kitchen & Tables', 'Dine-in tables, kitchen display and send-to-kitchen flow.'),
  ('inventory', 'Inventory & Recipes', 'Raw materials, recipe build and stock movements.'),
  ('production', 'Production & Efficiency', 'Batches, waste tracking and staff shifts.'),
  ('crm', 'Customers & Suppliers', 'Customer and supplier records.'),
  ('finance', 'Finance', 'Payments, expenses and reports.'),
  ('procurement', 'Procurement', 'Purchase orders.')
ON CONFLICT (key) DO NOTHING;

-- 2) Type -> module assignments.
-- Production is granted to restaurants as well as factories because the
-- efficiency tab aggregates waste_log + labor_shifts, which restaurants use.
--        type_key      module_key
INSERT INTO business_type_modules (business_type_id, module_key, is_default)
SELECT bt.id, v.module_key, true
FROM business_types bt
JOIN (VALUES
  ('retail',     'pos'),
  ('retail',     'crm'),
  ('retail',     'finance'),
  ('retail',     'procurement'),

  ('restaurant', 'pos'),
  ('restaurant', 'kitchen'),
  ('restaurant', 'inventory'),
  ('restaurant', 'production'),
  ('restaurant', 'crm'),
  ('restaurant', 'finance'),
  ('restaurant', 'procurement'),

  ('salon',      'pos'),
  ('salon',      'crm'),
  ('salon',      'finance'),
  ('salon',      'procurement'),

  ('factory',    'pos'),
  ('factory',    'inventory'),
  ('factory',    'production'),
  ('factory',    'crm'),
  ('factory',    'finance'),
  ('factory',    'procurement')
) AS v(type_key, module_key) ON v.type_key = bt.type_key
ON CONFLICT (business_type_id, module_key) DO NOTHING;

-- Sanity check: which types still have no module rows (they fall back to
-- legacy type_key gating and stay fully visible).
SELECT bt.type_key, count(btm.module_key) AS modules
FROM business_types bt
LEFT JOIN business_type_modules btm ON btm.business_type_id = bt.id
GROUP BY bt.type_key
ORDER BY bt.type_key;
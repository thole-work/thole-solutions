-- ============================================================
-- Thole D1 backend — full schema (port of database/database map.txt)
-- SQLite dialect for Cloudflare D1. One migration, idempotent-ish:
-- expects an EMPTY database (apply fresh, or drop the old DB first).
-- Run: npx wrangler d1 migrations apply thole-d1 --local   (dev)
--      npx wrangler d1 migrations apply thole-d1 --remote  (prod)
-- ============================================================

PRAGMA foreign_keys = OFF;

-- ------------------------------------------------------------------
-- AUTH (replaces Supabase auth.users)
-- ------------------------------------------------------------------
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name     TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ------------------------------------------------------------------
-- BUSINESS TYPES / MODULES (global config, no business scoping)
-- ------------------------------------------------------------------
CREATE TABLE business_types (
  id           TEXT PRIMARY KEY,
  type_key     TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE modules (
  key          TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description  TEXT
);

CREATE TABLE business_type_modules (
  business_type_id TEXT NOT NULL REFERENCES business_types(id),
  module_key       TEXT NOT NULL REFERENCES modules(key),
  is_default       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (business_type_id, module_key)
);

-- ------------------------------------------------------------------
-- TENANT
-- ------------------------------------------------------------------
CREATE TABLE businesses (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  business_type_id TEXT NOT NULL REFERENCES business_types(id),
  invite_code      TEXT NOT NULL UNIQUE,
  settings         TEXT,             -- jsonb port -> JSON text
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  address          TEXT,
  phone            TEXT,
  tax_id           TEXT
);

CREATE TABLE branches (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  branch_key  TEXT NOT NULL,
  name        TEXT NOT NULL,
  address     TEXT,
  phone       TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- role/status enums are TEXT + CHECK (Postgres enums -> SQLite)
CREATE TABLE business_members (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  branch_id   TEXT REFERENCES branches(id),
  role        TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended')),
  full_name   TEXT,
  invited_by  TEXT,
  accepted_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT
);

CREATE TABLE app_users (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  role        TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
  full_name   TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  branch_id   TEXT REFERENCES branches(id),
  invited_by  TEXT,
  email       TEXT,
  phone       TEXT,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
  token       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  expires_at  TEXT NOT NULL,
  accepted_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ------------------------------------------------------------------
-- EVENTS (fire-and-forget logging)
-- ------------------------------------------------------------------
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  business_id TEXT REFERENCES businesses(id),
  branch_id   TEXT REFERENCES branches(id),
  user_id     TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  before_data TEXT,        -- jsonb -> JSON text
  after_data  TEXT,
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE usage_events (
  id          TEXT PRIMARY KEY,
  business_id TEXT REFERENCES businesses(id),
  branch_id   TEXT REFERENCES branches(id),
  user_id     TEXT,
  event_type  TEXT NOT NULL,
  page_key    TEXT,
  entity_type TEXT,
  entity_id   TEXT,
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ------------------------------------------------------------------
-- OPERATIONS
-- ------------------------------------------------------------------
CREATE TABLE customers (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  name        TEXT,
  phone       TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  branch_id   TEXT REFERENCES branches(id)
);

CREATE TABLE suppliers (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  name        TEXT NOT NULL,
  phone       TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  branch_id   TEXT REFERENCES branches(id)
);

CREATE TABLE products (
  id                 TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id),
  name               TEXT NOT NULL,
  category           TEXT,
  price              REAL NOT NULL DEFAULT 0,
  unit               TEXT,
  stock_qty          REAL,
  low_stock_threshold REAL,
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  product_type       TEXT NOT NULL DEFAULT 'resale',
  total_sold         REAL NOT NULL DEFAULT 0,
  stock_limit        REAL,
  sku                TEXT,
  cost_price         REAL
);

CREATE TABLE raw_materials (
  id                 TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id),
  name               TEXT NOT NULL,
  unit               TEXT NOT NULL,
  stock_qty          REAL NOT NULL DEFAULT 0,
  low_stock_threshold REAL,
  cost_per_unit      REAL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kitchen_stock_qty  REAL NOT NULL DEFAULT 0
);

-- Child table of products (no business_id column)
CREATE TABLE recipe_items (
  id                TEXT PRIMARY KEY,
  product_id        TEXT NOT NULL REFERENCES products(id),
  raw_material_id   TEXT NOT NULL REFERENCES raw_materials(id),
  quantity_required REAL NOT NULL DEFAULT 0
);

CREATE TABLE restaurant_tables (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id),
  table_number    TEXT NOT NULL,
  name            TEXT,
  capacity        INTEGER,
  status          TEXT DEFAULT 'available',
  current_order_id TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  branch_id       TEXT REFERENCES branches(id)
);

CREATE TABLE orders (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id),
  customer_id    TEXT REFERENCES customers(id),
  created_by     TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  total_amount   REAL NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  table_id       TEXT REFERENCES restaurant_tables(id),
  order_type     TEXT NOT NULL DEFAULT 'takeout',
  subtotal       REAL NOT NULL DEFAULT 0,
  discount       REAL NOT NULL DEFAULT 0,
  discount_type  TEXT DEFAULT 'amount',
  tax_rate       REAL NOT NULL DEFAULT 0,
  tax            REAL NOT NULL DEFAULT 0,
  tip            REAL NOT NULL DEFAULT 0,
  change_given   REAL,
  receipt_number INTEGER,
  payment_method TEXT,
  branch_id      TEXT REFERENCES branches(id)
);

-- Child table of orders (no business_id column)
CREATE TABLE order_items (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity   REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL DEFAULT 0
);

CREATE TABLE purchase_orders (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  supplier_id  TEXT REFERENCES suppliers(id),
  status       TEXT NOT NULL DEFAULT 'pending',
  total_amount REAL NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  received_at  TEXT
);

-- Child table of purchase_orders (no business_id column)
CREATE TABLE purchase_order_items (
  id                 TEXT PRIMARY KEY,
  purchase_order_id  TEXT NOT NULL REFERENCES purchase_orders(id),
  product_id         TEXT REFERENCES products(id),
  raw_material_id    TEXT REFERENCES raw_materials(id),
  quantity           REAL NOT NULL DEFAULT 1,
  unit_cost          REAL NOT NULL DEFAULT 0,
  line_total         REAL NOT NULL DEFAULT 0
);

CREATE TABLE expenses (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  category     TEXT NOT NULL,
  description  TEXT,
  amount       REAL NOT NULL DEFAULT 0,
  expense_date TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  branch_id    TEXT REFERENCES branches(id)
);

CREATE TABLE payments (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  direction         TEXT NOT NULL DEFAULT 'in',
  party_type        TEXT NOT NULL DEFAULT 'customer',
  customer_id       TEXT REFERENCES customers(id),
  supplier_id       TEXT REFERENCES suppliers(id),
  order_id          TEXT REFERENCES orders(id),
  purchase_order_id TEXT REFERENCES purchase_orders(id),
  amount            REAL NOT NULL DEFAULT 0,
  method            TEXT,
  created_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  branch_id         TEXT REFERENCES branches(id)
);

CREATE TABLE stock_movements (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id),
  item_type      TEXT NOT NULL,
  product_id     TEXT REFERENCES products(id),
  raw_material_id TEXT REFERENCES raw_materials(id),
  quantity_change REAL NOT NULL DEFAULT 0,
  reason         TEXT NOT NULL,
  reference_type TEXT,
  reference_id   TEXT,
  created_by     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  location       TEXT NOT NULL DEFAULT 'store',
  branch_id      TEXT REFERENCES branches(id)
);

CREATE TABLE labor_shifts (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  user_id      TEXT,
  role         TEXT NOT NULL,
  hourly_rate  REAL NOT NULL DEFAULT 0,
  clock_in     TEXT NOT NULL,
  clock_out    TEXT,
  break_minutes INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  branch_id    TEXT REFERENCES branches(id)
);

CREATE TABLE produce_batches (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id),
  product_id    TEXT NOT NULL REFERENCES products(id),
  batch_qty     REAL NOT NULL DEFAULT 0,
  actual_yield  REAL,
  status        TEXT,
  started_by    TEXT,
  completed_by  TEXT,
  started_at    TEXT,
  completed_at  TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE waste_log (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id),
  product_id     TEXT REFERENCES products(id),
  raw_material_id TEXT REFERENCES raw_materials(id),
  quantity       REAL NOT NULL DEFAULT 0,
  unit_cost      REAL,
  reason         TEXT NOT NULL,
  notes          TEXT,
  recorded_by    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE pos_sessions (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id),
  opened_by     TEXT,
  closed_by     TEXT,
  opening_float REAL,
  expected_cash REAL,
  actual_cash   REAL,
  status        TEXT,
  opened_at     TEXT,
  closed_at     TEXT,
  branch_id     TEXT REFERENCES branches(id)
);

-- Per-business sequential receipt numbers (Step 8 port)
CREATE TABLE receipt_number_counters (
  business_id  TEXT PRIMARY KEY REFERENCES businesses(id),
  last_number  INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------------
-- INDEXES (the hot query paths the app uses)
-- ------------------------------------------------------------------
CREATE INDEX idx_orders_business_at    ON orders (business_id, created_at);
CREATE INDEX idx_orders_status         ON orders (status);
CREATE INDEX idx_order_items_order     ON order_items (order_id);
CREATE INDEX idx_order_items_product   ON order_items (product_id);
CREATE INDEX idx_payments_business     ON payments (business_id, created_at);
CREATE INDEX idx_expenses_business     ON expenses (business_id, created_at);
CREATE INDEX idx_products_business     ON products (business_id);
CREATE INDEX idx_raw_materials_business ON raw_materials (business_id);
CREATE INDEX idx_customers_business    ON customers (business_id);
CREATE INDEX idx_suppliers_business    ON suppliers (business_id);
CREATE INDEX idx_purchase_orders_business ON purchase_orders (business_id, created_at);
CREATE INDEX idx_stock_movements_business ON stock_movements (business_id, created_at);
CREATE INDEX idx_restaurant_tables_business ON restaurant_tables (business_id);
CREATE INDEX idx_members_user          ON business_members (user_id, status);
CREATE INDEX idx_members_business      ON business_members (business_id);
CREATE INDEX idx_app_users_user        ON app_users (user_id);

-- ------------------------------------------------------------------
-- TRIGGERS (Step 8 port: total_sold + cost_price).
-- Receipt numbering is NOT a trigger here: SQLite cannot modify NEW rows.
-- It is implemented in the API layer (crud.ts PATCH on orders) using a
-- D1 batch so the counter increment + order update stay atomic.
-- ------------------------------------------------------------------

-- Keep products.total_sold in sync with non-voided sales volume.
CREATE TRIGGER trg_oi_ins_total_sold AFTER INSERT ON order_items
FOR EACH ROW
WHEN (SELECT status FROM orders WHERE id = NEW.order_id) <> 'voided'
BEGIN
  UPDATE products SET total_sold = MAX(COALESCE(total_sold,0) + NEW.quantity, 0)
  WHERE id = NEW.product_id;
END;

CREATE TRIGGER trg_oi_del_total_sold AFTER DELETE ON order_items
FOR EACH ROW
WHEN (SELECT status FROM orders WHERE id = OLD.order_id) <> 'voided'
BEGIN
  UPDATE products SET total_sold = MAX(COALESCE(total_sold,0) - OLD.quantity, 0)
  WHERE id = OLD.product_id;
END;

CREATE TRIGGER trg_orders_void_total_sold AFTER UPDATE OF status ON orders
FOR EACH ROW
WHEN OLD.status <> 'voided' AND NEW.status = 'voided'
BEGIN
  UPDATE products SET total_sold = MAX(COALESCE(total_sold,0) - (
    SELECT SUM(quantity) FROM order_items WHERE order_id = NEW.id AND product_id = products.id
  ), 0)
  WHERE id IN (SELECT product_id FROM order_items WHERE order_id = NEW.id);
END;

-- Maintain products.cost_price from recipe ingredient costs.
CREATE TRIGGER trg_recipe_items_cost_price_ins AFTER INSERT ON recipe_items
FOR EACH ROW BEGIN
  UPDATE products SET cost_price = COALESCE((
    SELECT SUM(ri.quantity_required * rm.cost_per_unit)
    FROM recipe_items ri JOIN raw_materials rm ON rm.id = ri.raw_material_id
    WHERE ri.product_id = NEW.product_id AND rm.cost_per_unit IS NOT NULL), 0)
  WHERE id = NEW.product_id;
END;

CREATE TRIGGER trg_recipe_items_cost_price_del AFTER DELETE ON recipe_items
FOR EACH ROW BEGIN
  UPDATE products SET cost_price = COALESCE((
    SELECT SUM(ri.quantity_required * rm.cost_per_unit)
    FROM recipe_items ri JOIN raw_materials rm ON rm.id = ri.raw_material_id
    WHERE ri.product_id = OLD.product_id AND rm.cost_per_unit IS NOT NULL), 0)
  WHERE id = OLD.product_id;
END;

CREATE TRIGGER trg_recipe_items_cost_price_upd AFTER UPDATE ON recipe_items
FOR EACH ROW BEGIN
  UPDATE products SET cost_price = COALESCE((
    SELECT SUM(ri.quantity_required * rm.cost_per_unit)
    FROM recipe_items ri JOIN raw_materials rm ON rm.id = ri.raw_material_id
    WHERE ri.product_id = NEW.product_id AND rm.cost_per_unit IS NOT NULL), 0)
  WHERE id = NEW.product_id;
  UPDATE products SET cost_price = COALESCE((
    SELECT SUM(ri.quantity_required * rm.cost_per_unit)
    FROM recipe_items ri JOIN raw_materials rm ON rm.id = ri.raw_material_id
    WHERE ri.product_id = OLD.product_id AND rm.cost_per_unit IS NOT NULL), 0)
  WHERE id = OLD.product_id;
END;

-- ------------------------------------------------------------------
-- SEED: business types (mirrors the web onboarding: retail/restaurant/salon/factory)
-- ------------------------------------------------------------------
INSERT INTO business_types (id, type_key, display_name) VALUES
  ('type-retail',     'retail',     'Retail shop'),
  ('type-restaurant', 'restaurant', 'Restaurant'),
  ('type-salon',      'salon',      'Salon / service'),
  ('type-factory',    'factory',    'Factory / production');

-- SEED: module catalog (app.js TAB_MODULES consume these keys)
INSERT INTO modules (key, display_name, description) VALUES
  ('pos', 'Point of Sale', 'Sales, orders and payments at the counter.'),
  ('kitchen', 'Kitchen & Tables', 'Dine-in tables, kitchen display and send-to-kitchen flow.'),
  ('inventory', 'Inventory & Recipes', 'Raw materials, recipe build and stock movements.'),
  ('production', 'Production & Efficiency', 'Batches, waste tracking and staff shifts.'),
  ('crm', 'Customers & Suppliers', 'Customer and supplier records.'),
  ('finance', 'Finance', 'Payments, expenses and reports.'),
  ('procurement', 'Procurement', 'Purchase orders.');

-- SEED: type -> modules (must match database/business_type_modules_seed.sql)
INSERT INTO business_type_modules (business_type_id, module_key, is_default) VALUES
  ('type-retail',     'pos', 1), ('type-retail',    'crm', 1),
  ('type-retail',     'finance', 1), ('type-retail', 'procurement', 1),

  ('type-restaurant', 'pos', 1), ('type-restaurant', 'kitchen', 1),
  ('type-restaurant', 'inventory', 1), ('type-restaurant', 'production', 1),
  ('type-restaurant', 'crm', 1), ('type-restaurant', 'finance', 1),
  ('type-restaurant', 'procurement', 1),

  ('type-salon',      'pos', 1), ('type-salon',      'crm', 1),
  ('type-salon',      'finance', 1), ('type-salon',  'procurement', 1),

  ('type-factory',    'pos', 1), ('type-factory',   'inventory', 1),
  ('type-factory',    'production', 1), ('type-factory', 'crm', 1),
  ('type-factory',    'finance', 1), ('type-factory', 'procurement', 1);
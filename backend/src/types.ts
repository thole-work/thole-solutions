export interface Env {
  DB: D1Database;
  REALTIME: DurableObjectNamespace;
  APP_ORIGINS: string;
  JWT_SECRET: string;
}

export interface Membership {
  business_id: string;
  role: string;
  user_id: string;
}

export interface Ctx {
  userId: string;
  email: string;
  membership: Membership | null;
}

export const JWT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// ---------------------------------------------------------------------------
// Column registry — every column the app may select, filter, insert or update.
// Identifier validation against these sets prevents SQL injection.
// ---------------------------------------------------------------------------
export const COLUMNS: Record<string, string[]> = {
  users: ['id', 'email', 'password_hash', 'full_name', 'created_at'],
  business_types: ['id', 'type_key', 'display_name', 'created_at'],
  modules: ['key', 'display_name', 'description'],
  business_type_modules: ['business_type_id', 'module_key', 'is_default'],
  businesses: ['id', 'name', 'business_type_id', 'invite_code', 'settings', 'is_active', 'created_at', 'address', 'phone', 'tax_id'],
  branches: ['id', 'business_id', 'branch_key', 'name', 'address', 'phone', 'is_active', 'created_at'],
  business_members: ['id', 'user_id', 'business_id', 'branch_id', 'role', 'status', 'full_name', 'invited_by', 'accepted_at', 'created_at', 'updated_at'],
  app_users: ['id', 'user_id', 'business_id', 'role', 'full_name', 'is_active', 'created_at'],
  invites: ['id', 'business_id', 'branch_id', 'invited_by', 'email', 'phone', 'role', 'token', 'status', 'expires_at', 'accepted_at', 'created_at'],
  audit_log: ['id', 'business_id', 'branch_id', 'user_id', 'action', 'entity_type', 'entity_id', 'before_data', 'after_data', 'metadata', 'created_at'],
  usage_events: ['id', 'business_id', 'branch_id', 'user_id', 'event_type', 'page_key', 'entity_type', 'entity_id', 'metadata', 'created_at'],
  customers: ['id', 'business_id', 'name', 'phone', 'notes', 'created_at', 'branch_id'],
  suppliers: ['id', 'business_id', 'name', 'phone', 'notes', 'created_at', 'branch_id'],
  products: ['id', 'business_id', 'name', 'category', 'price', 'unit', 'stock_qty', 'low_stock_threshold', 'is_active', 'created_at', 'product_type', 'total_sold', 'stock_limit', 'sku', 'cost_price'],
  raw_materials: ['id', 'business_id', 'name', 'unit', 'stock_qty', 'low_stock_threshold', 'cost_per_unit', 'created_at', 'kitchen_stock_qty'],
  recipe_items: ['id', 'product_id', 'raw_material_id', 'quantity_required'],
  restaurant_tables: ['id', 'business_id', 'table_number', 'name', 'capacity', 'status', 'current_order_id', 'created_at', 'branch_id'],
  orders: ['id', 'business_id', 'customer_id', 'created_by', 'status', 'total_amount', 'created_at', 'table_id', 'order_type', 'subtotal', 'discount', 'discount_type', 'tax_rate', 'tax', 'tip', 'change_given', 'receipt_number', 'payment_method', 'branch_id'],
  order_items: ['id', 'order_id', 'product_id', 'quantity', 'unit_price', 'line_total'],
  purchase_orders: ['id', 'business_id', 'supplier_id', 'status', 'total_amount', 'created_by', 'created_at', 'received_at'],
  purchase_order_items: ['id', 'purchase_order_id', 'product_id', 'raw_material_id', 'quantity', 'unit_cost', 'line_total'],
  expenses: ['id', 'business_id', 'category', 'description', 'amount', 'expense_date', 'created_by', 'created_at', 'branch_id'],
  payments: ['id', 'business_id', 'direction', 'party_type', 'customer_id', 'supplier_id', 'order_id', 'purchase_order_id', 'amount', 'method', 'created_by', 'created_at', 'branch_id'],
  stock_movements: ['id', 'business_id', 'item_type', 'product_id', 'raw_material_id', 'quantity_change', 'reason', 'reference_type', 'reference_id', 'created_by', 'created_at', 'location', 'branch_id'],
  labor_shifts: ['id', 'business_id', 'user_id', 'role', 'hourly_rate', 'clock_in', 'clock_out', 'break_minutes', 'created_at', 'branch_id'],
  produce_batches: ['id', 'business_id', 'product_id', 'batch_qty', 'actual_yield', 'status', 'started_by', 'completed_by', 'started_at', 'completed_at', 'notes', 'created_at'],
  waste_log: ['id', 'business_id', 'product_id', 'raw_material_id', 'quantity', 'unit_cost', 'reason', 'notes', 'recorded_by', 'created_at'],
  pos_sessions: ['id', 'business_id', 'opened_by', 'closed_by', 'opening_float', 'expected_cash', 'actual_cash', 'status', 'opened_at', 'closed_at', 'branch_id'],
  receipt_number_counters: ['business_id', 'last_number'],
};

// Tables that carry a business_id and must always be scoped to the caller's
// business. 'businesses' itself is scoped by id == business_id.
export const BUSINESS_TABLES = new Set<string>(
  Object.keys(COLUMNS).filter((t) => COLUMNS[t]!.includes('business_id'))
);
export const GLOBAL_TABLES = new Set<string>(['business_types', 'modules', 'business_type_modules']);

// Child tables (rows belong to a parent row, no business_id column). They are
// scoped via a subquery on their parent table's business_id.
export const CHILD_TABLES: Record<string, { parent: string; childCol: string }> = {
  order_items: { parent: 'orders', childCol: 'order_id' },
  purchase_order_items: { parent: 'purchase_orders', childCol: 'purchase_order_id' },
  recipe_items: { parent: 'products', childCol: 'product_id' },
};

// Columns stored as JSON text in SQLite, exposed as objects to the app.
export const JSON_COLS: Record<string, string[]> = {
  businesses: ['settings'],
  audit_log: ['before_data', 'after_data', 'metadata'],
  usage_events: ['metadata'],
};

export function allColumns(table: string): string[] {
  if (!COLUMNS[table]) return [];
  return ['*', ...COLUMNS[table]];
}
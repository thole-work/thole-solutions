select
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid) as return_type,
  p.prosecdef as security_definer,
  p.provolatile as volatility
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'has_module';

select
  bt.type_key,
  coalesce(string_agg(btm.module_key, ', ' order by btm.module_key), '(none)') as modules
from business_types bt
left join business_type_modules btm
  on btm.business_type_id = bt.id
group by bt.type_key
order by bt.type_key;

select
  b.id as business_id,
  b.name,
  bt.type_key,
  has_module(b.id, 'kitchen') as has_kitchen,
  has_module(b.id, 'inventory') as has_inventory,
  has_module(b.id, 'production') as has_production,
  has_module(b.id, 'pos') as has_pos,
  has_module(b.id, 'crm') as has_crm,
  has_module(b.id, 'finance') as has_finance,
  has_module(b.id, 'procurement') as has_procurement
from businesses b
join business_types bt on bt.id = b.business_type_id
order by bt.type_key, b.name;

select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in (
    'restaurant_tables',
    'raw_materials',
    'stock_movements',
    'recipe_items',
    'produce_batches',
    'waste_log',
    'labor_shifts',
    'orders',
    'order_items',
    'pos_sessions',
    'customers',
    'suppliers',
    'payments',
    'expenses',
    'purchase_orders',
    'purchase_order_items'
  )
order by c.relname;

select
  tablename,
  policyname,
  permissive,
  cmd
from pg_policies
where schemaname = 'public'
  and tablename in (
    'restaurant_tables',
    'raw_materials',
    'stock_movements',
    'recipe_items',
    'produce_batches',
    'waste_log',
    'labor_shifts',
    'orders',
    'order_items',
    'pos_sessions',
    'customers',
    'suppliers',
    'payments',
    'expenses',
    'purchase_orders',
    'purchase_order_items'
  )
order by tablename, cmd, policyname;

with expected(table_name, policy_name, command_name) as (
  values
    ('restaurant_tables', 'restaurant_tables_module_gate_ins', 'INSERT'),
    ('restaurant_tables', 'restaurant_tables_module_gate_upd', 'UPDATE'),
    ('raw_materials', 'raw_materials_module_gate_ins', 'INSERT'),
    ('raw_materials', 'raw_materials_module_gate_upd', 'UPDATE'),
    ('stock_movements', 'stock_movements_module_gate_ins', 'INSERT'),
    ('recipe_items', 'recipe_items_module_gate_ins', 'INSERT'),
    ('recipe_items', 'recipe_items_module_gate_upd', 'UPDATE'),
    ('produce_batches', 'produce_batches_module_gate_ins', 'INSERT'),
    ('produce_batches', 'produce_batches_module_gate_upd', 'UPDATE'),
    ('waste_log', 'waste_log_module_gate_ins', 'INSERT'),
    ('labor_shifts', 'labor_shifts_module_gate_ins', 'INSERT'),
    ('labor_shifts', 'labor_shifts_module_gate_upd', 'UPDATE'),
    ('orders', 'orders_module_gate_ins', 'INSERT'),
    ('orders', 'orders_module_gate_upd', 'UPDATE'),
    ('pos_sessions', 'pos_sessions_module_gate_ins', 'INSERT'),
    ('order_items', 'order_items_module_gate_ins', 'INSERT'),
    ('customers', 'customers_module_gate_ins', 'INSERT'),
    ('suppliers', 'suppliers_module_gate_ins', 'INSERT'),
    ('payments', 'payments_module_gate_ins', 'INSERT'),
    ('expenses', 'expenses_module_gate_ins', 'INSERT'),
    ('purchase_orders', 'purchase_orders_module_gate_ins', 'INSERT'),
    ('purchase_orders', 'purchase_orders_module_gate_upd', 'UPDATE'),
    ('purchase_order_items', 'po_items_module_gate_ins', 'INSERT')
)
select
  e.table_name,
  e.policy_name,
  e.command_name as expected_command,
  coalesce(p.permissive, 'MISSING') as deployed_permissive,
  coalesce(p.cmd, 'MISSING') as deployed_command,
  case
    when p.policyname is null then 'MISSING'
    when upper(p.permissive) <> 'RESTRICTIVE' then 'NOT_RESTRICTIVE'
    when upper(p.cmd) <> e.command_name then 'WRONG_COMMAND'
    else 'OK'
  end as status
from expected e
left join pg_policies p
  on p.schemaname = 'public'
  and p.tablename = e.table_name
  and p.policyname = e.policy_name
order by e.table_name, e.policy_name;

select
  p.proname as function_name,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'has_module';

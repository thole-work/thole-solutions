# Task 3 — RLS for `pos`, `crm`, `finance`, `procurement`

## Goal
These 4 modules are seeded per business type in
`database/business_type_modules_seed.sql` but are currently universal
everywhere — no UI gate and no database gate. This task adds the database
gate. (Task 4 adds the matching UI gate after this is verified.)

## Requires
Task 1 done and verified.

## Files to touch
- New file: `database/module_gate_pos_crm_finance_procurement.sql`
- Run it in the Supabase SQL editor

## Do NOT touch
- `app.js`, `index.html` — that's Task 4, after this is verified
- Any existing RLS policy (same RESTRICTIVE reasoning as Task 2)

## Exact change

```sql
-- pos: orders, pos_sessions (business_id directly)
create policy orders_module_gate_ins on public.orders
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'pos'));

create policy orders_module_gate_upd on public.orders
  as restrictive for update to authenticated
  using (has_module(business_id, 'pos'))
  with check (has_module(business_id, 'pos'));

create policy pos_sessions_module_gate_ins on public.pos_sessions
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'pos'));

-- pos: order_items (NO business_id — reach it via order_id)
create policy order_items_module_gate_ins on public.order_items
  as restrictive for insert to authenticated
  with check (
    exists (
      select 1 from orders o
      where o.id = order_items.order_id
        and has_module(o.business_id, 'pos')
    )
  );

-- crm: customers, suppliers (business_id directly)
create policy customers_module_gate_ins on public.customers
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'crm'));

create policy suppliers_module_gate_ins on public.suppliers
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'crm'));

-- finance: payments, expenses (business_id directly)
create policy payments_module_gate_ins on public.payments
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'finance'));

create policy expenses_module_gate_ins on public.expenses
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'finance'));

-- procurement: purchase_orders (business_id directly)
create policy purchase_orders_module_gate_ins on public.purchase_orders
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'procurement'));

create policy purchase_orders_module_gate_upd on public.purchase_orders
  as restrictive for update to authenticated
  using (has_module(business_id, 'procurement'))
  with check (has_module(business_id, 'procurement'));

-- procurement: purchase_order_items (NO business_id — reach it via purchase_order_id)
create policy po_items_module_gate_ins on public.purchase_order_items
  as restrictive for insert to authenticated
  with check (
    exists (
      select 1 from purchase_orders po
      where po.id = purchase_order_items.purchase_order_id
        and has_module(po.business_id, 'procurement')
    )
  );
```

## Note on `receipt_number_counters`
Not gated here — it's keyed by `business_id` as primary key and looks
system-maintained (likely a trigger, per `schema_drift_cleanup.sql`'s
receipt-number counter note), not something written directly by a user
action. Leave it alone unless verification shows otherwise.

## Verification
Follow `05-verification-checklist.md`, scoped to: orders, order_items,
pos_sessions, customers, suppliers, payments, expenses, purchase_orders,
purchase_order_items — testing across all 4 business types per
`business_type_modules_seed.sql`'s assignments (currently every type has
all 4 of these modules, so nothing should actually break — this step is
about closing the hole, not changing today's behavior).

Commit as: `db: RLS-gate pos/crm/finance/procurement tables by module`

# Task 2 — RLS for `kitchen`, `inventory`, `production`

## Goal
These 3 modules already hide their tabs in the UI per business type
(`TAB_MODULES` in `app.js`), but nothing stops a direct write at the
database level. Close that gap without touching any existing policy.

## Requires
Task 1 done and verified (`has_module()` exists).

## Files to touch
- New file: `database/module_gate_kitchen_inventory_production.sql`
- Run it in the Supabase SQL editor

## Do NOT touch
- `app.js`, `index.html`
- Any existing RLS policy (see "Why RESTRICTIVE" below — do not drop or
  edit anything that already exists)

## Why RESTRICTIVE policies
Postgres OR's together multiple PERMISSIVE policies for the same
command — adding a normal policy next to an existing one would only
*loosen* access, not gate it. A `RESTRICTIVE` policy ANDs with whatever
permissive policy already allows the write, so it can only narrow access,
never widen it. This lets you add module gating without reading, editing,
or risking the existing tenant-isolation policies.

## Exact change

```sql
-- kitchen: restaurant_tables (has business_id directly)
create policy restaurant_tables_module_gate_ins on public.restaurant_tables
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'kitchen'));

create policy restaurant_tables_module_gate_upd on public.restaurant_tables
  as restrictive for update to authenticated
  using (has_module(business_id, 'kitchen'))
  with check (has_module(business_id, 'kitchen'));

-- inventory: raw_materials, stock_movements (business_id directly)
create policy raw_materials_module_gate_ins on public.raw_materials
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'inventory'));

create policy raw_materials_module_gate_upd on public.raw_materials
  as restrictive for update to authenticated
  using (has_module(business_id, 'inventory'))
  with check (has_module(business_id, 'inventory'));

create policy stock_movements_module_gate_ins on public.stock_movements
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'inventory'));

-- inventory: recipe_items (NO business_id column — reach it via product_id)
create policy recipe_items_module_gate_ins on public.recipe_items
  as restrictive for insert to authenticated
  with check (
    exists (
      select 1 from products p
      where p.id = recipe_items.product_id
        and has_module(p.business_id, 'inventory')
    )
  );

create policy recipe_items_module_gate_upd on public.recipe_items
  as restrictive for update to authenticated
  using (
    exists (
      select 1 from products p
      where p.id = recipe_items.product_id
        and has_module(p.business_id, 'inventory')
    )
  )
  with check (
    exists (
      select 1 from products p
      where p.id = recipe_items.product_id
        and has_module(p.business_id, 'inventory')
    )
  );

-- production: produce_batches, waste_log, labor_shifts (business_id directly)
create policy produce_batches_module_gate_ins on public.produce_batches
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'production'));

create policy produce_batches_module_gate_upd on public.produce_batches
  as restrictive for update to authenticated
  using (has_module(business_id, 'production'))
  with check (has_module(business_id, 'production'));

create policy waste_log_module_gate_ins on public.waste_log
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'production'));

create policy labor_shifts_module_gate_ins on public.labor_shifts
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'production'));

create policy labor_shifts_module_gate_upd on public.labor_shifts
  as restrictive for update to authenticated
  using (has_module(business_id, 'production'))
  with check (has_module(business_id, 'production'));
```

## Verification
Follow `05-verification-checklist.md`, scoped to: restaurant_tables,
raw_materials, stock_movements, recipe_items, produce_batches, waste_log,
labor_shifts — testing as a **retail** business (should be blocked from
all of these) and a **restaurant** business (should succeed on all of
these).

Commit as: `db: RLS-gate kitchen/inventory/production tables by module`

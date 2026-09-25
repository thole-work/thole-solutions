create policy restaurant_tables_module_gate_ins on public.restaurant_tables
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'kitchen'));

create policy restaurant_tables_module_gate_upd on public.restaurant_tables
  as restrictive for update to authenticated
  using (has_module(business_id, 'kitchen'))
  with check (has_module(business_id, 'kitchen'));

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

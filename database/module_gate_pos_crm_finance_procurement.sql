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

create policy order_items_module_gate_ins on public.order_items
  as restrictive for insert to authenticated
  with check (
    exists (
      select 1 from orders o
      where o.id = order_items.order_id
        and has_module(o.business_id, 'pos')
    )
  );

create policy customers_module_gate_ins on public.customers
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'crm'));

create policy suppliers_module_gate_ins on public.suppliers
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'crm'));

create policy payments_module_gate_ins on public.payments
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'finance'));

create policy expenses_module_gate_ins on public.expenses
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'finance'));

create policy purchase_orders_module_gate_ins on public.purchase_orders
  as restrictive for insert to authenticated
  with check (has_module(business_id, 'procurement'));

create policy purchase_orders_module_gate_upd on public.purchase_orders
  as restrictive for update to authenticated
  using (has_module(business_id, 'procurement'))
  with check (has_module(business_id, 'procurement'));

create policy po_items_module_gate_ins on public.purchase_order_items
  as restrictive for insert to authenticated
  with check (
    exists (
      select 1 from purchase_orders po
      where po.id = purchase_order_items.purchase_order_id
        and has_module(po.business_id, 'procurement')
    )
  );

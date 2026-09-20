-- ============================================================
-- Transactional integrity RPCs — frontend-improvement-plan.md Step 5.
-- Safe to apply while the old frontend is running: these only ADD
-- functions. Frontend adopts them behind FEATURES.atomicRpc and
-- falls back to the legacy await-chains on error.
--
-- All functions are SECURITY INVOKER (RLS still applies) and
-- re-check active business_members explicitly as defense in depth.
-- ============================================================

begin;

-- --------------------------------------------------------------------
-- place_order: insert order + items + occupy table atomically (new order),
-- or replace items + refresh totals atomically (append to an open order).
-- p_order fields (all optional except totals):
--   table_id, customer_id, order_type, subtotal, discount, discount_type,
--   tax_rate, tax, tip, total_amount, payment_method
-- p_items: [{"product_id": uuid, "quantity": num, "unit_price": num}, ...]
-- Returns jsonb: {"order_id": uuid, "items_count": int, "created": bool}
-- --------------------------------------------------------------------
create or replace function public.place_order(
  p_business_id uuid,
  p_order jsonb,
  p_items jsonb,
  p_order_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_order_id uuid;
  v_created boolean := false;
  v_table_id uuid;
  v_existing_status text;
  v_items_count int;
begin
  if not exists (
    select 1 from public.business_members m
    where m.business_id = p_business_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  ) then
    raise exception 'Not an active member of this business';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Cart must be a non-empty array';
  end if;

  if p_order_id is null then
    -- NEW ORDER ------------------------------------------------------
    insert into public.orders (
      business_id, branch_id, table_id, customer_id, order_type, status,
      subtotal, discount, discount_type, tax_rate, tax, tip,
      total_amount, payment_method, created_by
    ) values (
      p_business_id,
      nullif(p_order->>'branch_id', '')::uuid,
      nullif(p_order->>'table_id', '')::uuid,
      nullif(p_order->>'customer_id', '')::uuid,
      coalesce(nullif(p_order->>'order_type', ''), 'takeout'),
      'pending',
      (p_order->>'subtotal')::numeric,
      coalesce((p_order->>'discount')::numeric, 0),
      coalesce(nullif(p_order->>'discount_type', ''), 'amount'),
      coalesce((p_order->>'tax_rate')::numeric, 0),
      coalesce((p_order->>'tax')::numeric, 0),
      coalesce((p_order->>'tip')::numeric, 0),
      (p_order->>'total_amount')::numeric,
      nullif(p_order->>'payment_method', ''),
      auth.uid()
    )
    returning id into v_order_id;
    v_created := true;
    v_table_id := nullif(p_order->>'table_id', '')::uuid;
  else
    -- APPEND / REPLACE ITEMS ON AN OPEN ORDER ------------------------
    select o.status into v_existing_status
    from public.orders o
    where o.id = p_order_id
      and o.business_id = p_business_id;
    if v_existing_status is null then
      raise exception 'Order not found in this business';
    end if;
    if v_existing_status in ('voided', 'completed') then
      raise exception 'Order is already %', v_existing_status;
    end if;

    update public.orders set
      subtotal        = (p_order->>'subtotal')::numeric,
      discount        = coalesce((p_order->>'discount')::numeric, 0),
      discount_type   = coalesce(nullif(p_order->>'discount_type', ''), 'amount'),
      tax_rate        = coalesce((p_order->>'tax_rate')::numeric, 0),
      tax             = coalesce((p_order->>'tax')::numeric, 0),
      total_amount    = (p_order->>'total_amount')::numeric
    where id = p_order_id
      and business_id = p_business_id
    returning id into v_order_id;

    delete from public.order_items where order_id = v_order_id;
  end if;

  -- ITEMS (line_total computed server-side, never trusted from client)
  insert into public.order_items (order_id, product_id, quantity, unit_price, line_total)
  select
    v_order_id,
    (item->>'product_id')::uuid,
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    (item->>'quantity')::numeric * (item->>'unit_price')::numeric
  from jsonb_array_elements(p_items) as item;

  get diagnostics v_items_count = row_count;

  -- TABLE OCCUPANCY (new dine-in orders only; appends keep current state)
  if v_created and v_table_id is not null then
    update public.restaurant_tables
       set status = 'occupied', current_order_id = v_order_id
     where id = v_table_id
       and business_id = p_business_id;
  end if;

  return jsonb_build_object('order_id', v_order_id, 'items_count', v_items_count, 'created', v_created);
end;
$$;

-- --------------------------------------------------------------------
-- record_payments: single-transaction multi-payment insert.
-- p_payments: [{"order_id": uuid|null, "customer_id": uuid|null,
--               "amount": num, "method": text}, ...]
-- Every row gets direction='in', party_type='customer', created_by=caller.
-- Returns jsonb: {"inserted": int, "ids": [uuid, ...]}
-- --------------------------------------------------------------------
create or replace function public.record_payments(
  p_business_id uuid,
  p_payments jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_ids uuid[];
  v_row jsonb;
  v_payment_id uuid;
  v_inserted int := 0;
begin
  if not exists (
    select 1 from public.business_members m
    where m.business_id = p_business_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  ) then
    raise exception 'Not an active member of this business';
  end if;

  if jsonb_typeof(p_payments) <> 'array' or jsonb_array_length(p_payments) = 0 then
    raise exception 'Payments must be a non-empty array';
  end if;

  for v_row in select * from jsonb_array_elements(p_payments) loop
    insert into public.payments (
      business_id, branch_id, direction, party_type, customer_id, order_id,
      amount, method, created_by
    ) values (
      p_business_id,
      nullif(v_row->>'branch_id', '')::uuid,
      'in',
      'customer',
      nullif(v_row->>'customer_id', '')::uuid,
      nullif(v_row->>'order_id', '')::uuid,
      (v_row->>'amount')::numeric,
      nullif(v_row->>'method', ''),
      auth.uid()
    )
    returning id into v_payment_id;
    v_ids := v_ids || v_payment_id;
    v_inserted := v_inserted + 1;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'ids', to_jsonb(v_ids));
end;
$$;

commit;

-- --------------------------------------------------------------------
-- Post-apply verification snippets (run manually):
--   select proname, prosecdef from pg_proc
--    where proname in ('place_order','record_payments');   -- expect f (invoker)
-- Grant execute to authenticated (default is public — tighten):
--   revoke execute on function public.place_order(uuid, jsonb, jsonb, uuid) from public, anon;
--   revoke execute on function public.record_payments(uuid, jsonb) from public, anon;
--   grant  execute on function public.place_order(uuid, jsonb, jsonb, uuid) to authenticated;
--   grant  execute on function public.record_payments(uuid, jsonb) to authenticated;
-- --------------------------------------------------------------------

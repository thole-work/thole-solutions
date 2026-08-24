-- ============================================================
-- Schema drift cleanup — frontend-improvement-plan.md Step 8.
-- Decisions (2026-08-24):
--   1. Drop customer_balances / supplier_balances (nothing maintains them;
--      app keeps client-side math).
--   2. Assign orders.receipt_number via per-business counter + trigger
--      when an order transitions to 'completed'.
--   3. Maintain products.total_sold via triggers on order_items/orders
--      (enables top-product reporting straight from the DB).
--   4. Drop products.automation_rules (dead); backfill + auto-maintain
--      products.cost_price from recipe ingredient costs.
--
-- Trigger functions are SECURITY DEFINER so bookkeeping can NEVER fail a
-- user action through RLS (e.g. a cashier completing a sale must not need
-- products UPDATE rights just to bump total_sold). All functions pin
-- search_path and touch only their own tables — standard definer hardening.
--
-- Safe to apply while the old frontend runs: the app already prefers
-- orders.receipt_number for receipts and ignores the dropped columns.
-- ============================================================

begin;

-- --------------------------------------------------------------------
-- 1) Drop unused balance tables (client-side math stays the source of truth)
-- --------------------------------------------------------------------
drop table if exists public.customer_balances cascade;
drop table if exists public.supplier_balances cascade;

-- --------------------------------------------------------------------
-- 2) orders.receipt_number — per-business sequential numbers
-- --------------------------------------------------------------------
create table if not exists public.receipt_number_counters (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  last_number integer not null default 0
);

create or replace function public.assign_receipt_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_num integer;
begin
  -- Only number an order the first time it completes; never renumber.
  if new.receipt_number is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and coalesce(old.status, '') = 'completed' then
    return new; -- already completed before: keep existing number state untouched
  end if;
  if new.status is distinct from 'completed' then
    return new;
  end if;

  insert into public.receipt_number_counters as c (business_id, last_number)
  values (new.business_id, 1)
  on conflict (business_id) do update
    set last_number = c.last_number + 1
  returning last_number into v_num;

  new.receipt_number := v_num;
  return new;
end;
$$;

drop trigger if exists trg_orders_receipt_number on public.orders;
create trigger trg_orders_receipt_number
  before insert or update of status on public.orders
  for each row execute function public.assign_receipt_number();

-- --------------------------------------------------------------------
-- 3) products.total_sold — mirrors non-voided sales volume
--    (append-to-order deletes+reinserts items: net effect stays correct)
-- --------------------------------------------------------------------
create or replace function public.bump_total_sold(p_product_id uuid, p_delta numeric)
returns void
language sql
security definer
set search_path = public
as $$
  update public.products
     set total_sold = greatest(total_sold + p_delta, 0)
   where id = p_product_id;
$$;

create or replace function public.order_items_inserted_total_sold()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select o.status into v_status from public.orders o where o.id = new.order_id;
  if v_status is distinct from 'voided' then
    perform public.bump_total_sold(new.product_id, new.quantity);
  end if;
  return null;
end;
$$;

create or replace function public.order_items_deleted_total_sold()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select o.status into v_status from public.orders o where o.id = old.order_id;
  if v_status is distinct from 'voided' then
    perform public.bump_total_sold(old.product_id, -old.quantity);
  end if;
  return null;
end;
$$;

create or replace function public.orders_voided_total_sold()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status is distinct from 'voided' and new.status = 'voided' then
    update public.products p
       set total_sold = greatest(p.total_sold - x.qty, 0)
      from (
        select oi.product_id, sum(oi.quantity) as qty
        from public.order_items oi
        where oi.order_id = new.id
        group by oi.product_id
      ) x
     where p.id = x.product_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_oi_ins_total_sold on public.order_items;
create trigger trg_oi_ins_total_sold
  after insert on public.order_items
  for each row execute function public.order_items_inserted_total_sold();

drop trigger if exists trg_oi_del_total_sold on public.order_items;
create trigger trg_oi_del_total_sold
  after delete on public.order_items
  for each row execute function public.order_items_deleted_total_sold();

drop trigger if exists trg_orders_void_total_sold on public.orders;
create trigger trg_orders_void_total_sold
  after update of status on public.orders
  for each row execute function public.orders_voided_total_sold();

-- --------------------------------------------------------------------
-- 4a) Drop dead column
-- --------------------------------------------------------------------
alter table public.products drop column if exists automation_rules;

-- --------------------------------------------------------------------
-- 4b) products.cost_price — backfill from recipes, then keep fresh
-- --------------------------------------------------------------------
update public.products p
   set cost_price = agg.total_cost
  from (
    select ri.product_id, sum(ri.quantity_required * rm.cost_per_unit) as total_cost
    from public.recipe_items ri
    join public.raw_materials rm on rm.id = ri.raw_material_id
    where rm.cost_per_unit is not null
    group by ri.product_id
  ) agg
 where p.id = agg.product_id;

create or replace function public.recipe_items_recalc_cost_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id uuid := coalesce(new.product_id, old.product_id);
begin
  update public.products p
     set cost_price = agg.total_cost
    from (
      select sum(ri.quantity_required * rm.cost_per_unit) as total_cost
      from public.recipe_items ri
      join public.raw_materials rm on rm.id = ri.raw_material_id
      where ri.product_id = v_product_id
    ) agg
   where p.id = v_product_id;
  return null;
end;
$$;

drop trigger if exists trg_recipe_items_cost_price on public.recipe_items;
create trigger trg_recipe_items_cost_price
  after insert or update or delete on public.recipe_items
  for each row execute function public.recipe_items_recalc_cost_price();

commit;

-- --------------------------------------------------------------------
-- Post-apply verification snippets (run manually):
--   -- triggers present:
--   select tgname from pg_trigger
--    where tgrelid in ('public.orders'::regclass,
--                      'public.order_items'::regclass,
--                      'public.recipe_items'::regclass)
--      and not tgisinternal;
--   -- receipt numbering smoke test (authenticated):
--   --   complete an order, then:  select id, status, receipt_number
--   --                             from orders order by created_at desc limit 3;
--   -- cost price spot check:
--   --   select name, product_type, cost_price from products where product_type='recipe';
-- --------------------------------------------------------------------

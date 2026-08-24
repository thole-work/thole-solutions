-- ============================================================
-- Server-side aggregation — frontend-improvement-plan.md Step 6.
-- Replaces the dashboard/efficiency full-history table scans with
-- a single round-trip. Safe to apply while the old frontend runs:
-- adds one read-only function only.
--
-- SECURITY INVOKER: RLS applies to every underlying SELECT.
-- STABLE: no writes, same input -> same result within a statement.
-- ============================================================

begin;

create or replace function public.dashboard_summary(p_business_id uuid, p_branch_id uuid default null)
returns jsonb
language sql
security invoker
stable
set search_path = public
as $$
  select jsonb_build_object(
    -- Revenue metrics (status = 'completed' mirrors the client-side math)
    'revenue', coalesce((
      select sum(o.total_amount) from orders o
      where o.business_id = p_business_id and o.status = 'completed'
        and (p_branch_id is null or o.branch_id = p_branch_id)), 0),
    'today_sales', coalesce((
      select sum(o.total_amount) from orders o
      where o.business_id = p_business_id and o.status = 'completed'
        and (o.created_at at time zone 'utc')::date = (now() at time zone 'utc')::date
        and (p_branch_id is null or o.branch_id = p_branch_id)), 0),
    'today_orders', coalesce((
      select count(*) from orders o
      where o.business_id = p_business_id and o.status = 'completed'
        and (o.created_at at time zone 'utc')::date = (now() at time zone 'utc')::date
        and (p_branch_id is null or o.branch_id = p_branch_id)), 0),
    'sales_count', (
      select count(*) from orders o
      where o.business_id = p_business_id and o.status = 'completed'
        and (p_branch_id is null or o.branch_id = p_branch_id)),
    -- Cost breakdown (purchase_total excludes voided POs, like the client)
    'expense_total', coalesce((
      select sum(e.amount) from expenses e
      where e.business_id = p_business_id
        and (p_branch_id is null or e.branch_id = p_branch_id)), 0),
    'purchase_total', coalesce((
      select sum(po.total_amount) from purchase_orders po
      where po.business_id = p_business_id and po.status <> 'voided'), 0),
    'waste_cost', coalesce((
      select sum(w.quantity * w.unit_cost) from waste_log w
      where w.business_id = p_business_id), 0),
    -- Efficiency extras: closed-shift labor cost and average production yield
    'labor_cost', coalesce((
      select sum(
        greatest(
          extract(epoch from (s.clock_out - s.clock_in)) / 3600.0
            - coalesce(s.break_minutes, 0) / 60.0,
          0)
        * coalesce(s.hourly_rate, 0))
      from labor_shifts s
      where s.business_id = p_business_id and s.clock_out is not null
        and (p_branch_id is null or s.branch_id = p_branch_id)), 0),
    'avg_yield_pct', (
      select avg(b.actual_yield / nullif(b.batch_qty, 0) * 100)
      from produce_batches b
      where b.business_id = p_business_id and b.actual_yield is not null)
  );
$$;

commit;

-- --------------------------------------------------------------------
-- Post-apply verification snippets (run manually):
--   select prosecdef, provolatile from pg_proc where proname = 'dashboard_summary';
--     -- expect prosecdef = f (invoker), provolatile = 's' (stable)
--   revoke execute on function public.dashboard_summary(uuid) from public, anon;
--   grant  execute on function public.dashboard_summary(uuid) to authenticated;
--
-- Smoke test while authenticated:
--   select * from dashboard_summary('<business uuid>');
--   select * from dashboard_summary('<business uuid>', '<branch uuid>');
-- --------------------------------------------------------------------

-- ============================================================
-- Event logging fix v2 — grants first.
-- Live probe showed 42501 "permission denied for table audit_log":
-- policies alone don't help unless the role has INSERT privilege.
-- Run ALL of this in Supabase SQL editor (safe to re-run).
-- ============================================================

begin;

-- 1) Privileges (the actual suspected blocker)
grant insert, select on public.audit_log     to authenticated;
grant insert, select on public.usage_events to authenticated;

-- 2) Policies — drop & recreate so this file always applies cleanly
drop policy if exists audit_insert on public.audit_log;
create policy audit_insert on public.audit_log
  for insert to authenticated
  with check (
    business_id is not null
    and exists (
      select 1 from business_members m
      where m.business_id = audit_log.business_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

drop policy if exists usage_insert on public.usage_events;
create policy usage_insert on public.usage_events
  for insert to authenticated
  with check (
    business_id is not null
    and exists (
      select 1 from business_members m
      where m.business_id = usage_events.business_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

commit;

-- --------------------------------------------------------------------
-- Verify after applying:
--   1) Refresh the app while logged in, click through POS/dashboard once.
--   2) Re-run the count check:
--        select 'audit_log' as src, count(*), max(created_at) from audit_log
--        union all
--        select 'usage_events', count(*), max(created_at) from usage_events;
--   3) If STILL zero: F12 -> Console in the app, look for
--      "audit_log write failed: ..." / "usage_events write failed: ..."
--      and paste the message.
-- --------------------------------------------------------------------

-- ============================================================
-- Event logging diagnostics — why are audit_log / usage_events empty
-- even though INSERT policies exist?
-- Run each block in Supabase SQL editor, read results top to bottom.
-- ============================================================

-- 1) What policies actually exist? Check roles + cmd columns:
--    must say {authenticated} and INSERT. If cmd/roles differ, that's the bug.
select tablename, policyname, cmd, roles, permissive, qual, with_check
from pg_policies
where tablename in ('audit_log', 'usage_events');

-- 2) Is RLS actually enabled on both tables?
--    relrowsecurity must be true. If false, inserts would land regardless
--    of policies (and emptiness would mean the app never fires them).
select c.relname,
       c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('audit_log', 'usage_events');

-- 3) Membership gate: the policies require an ACTIVE business_members row
--    for your logged-in user. Find your row here (match user_id against
--    your auth user) — status MUST be 'active' and business_id NOT NULL:
select m.business_id, m.user_id, m.role, m.status, m.created_at
from business_members m
order by m.created_at desc;

-- --------------------------------------------------------------------
-- 4) If 1–3 all look right, the answer is in the browser:
--    log into the app, press F12 -> Console tab, click through
--    POS/dashboard once, and look for lines like
--      "audit_log write failed: <message>"   (index.html:2049)
--      "usage_events write failed: <message>" (index.html:2063)
--    Paste that <message> back — it names the exact failing check
--    (e.g. "new row violates row-level security policy").
-- --------------------------------------------------------------------

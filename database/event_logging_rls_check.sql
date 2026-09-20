-- ============================================================
-- Audit & usage event write checks — run in Supabase SQL editor
-- BEFORE trusting frontend event logging (frontend-improvement-plan.md Step 4).
-- Read-only diagnostics; nothing here mutates data.
-- ============================================================

-- 1) Is RLS enabled on the event tables, and what policies exist?
SELECT c.relname, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('audit_log', 'usage_events');

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies WHERE tablename IN ('audit_log', 'usage_events');

-- Expected minimum for the frontend to log successfully (INSERT is all the app does today):
--   INSERT for authenticated users, scoped to their own business.
-- If policies are missing, suggested baseline:
--
-- CREATE POLICY audit_insert ON audit_log FOR INSERT TO authenticated
--   WITH CHECK (business_id IS NOT NULL
--          AND EXISTS (SELECT 1 FROM business_members m
--                      WHERE m.business_id = audit_log.business_id
--                        AND m.user_id = auth.uid() AND m.status = 'active'));
--
-- CREATE POLICY usage_insert ON usage_events FOR INSERT TO authenticated
--   WITH CHECK (business_id IS NOT NULL
--          AND EXISTS (SELECT 1 FROM business_members m
--                      WHERE m.business_id = usage_events.business_id
--                        AND m.user_id = auth.uid() AND m.status = 'active'));
--
-- Reads are needed later by the admin dashboard (Step 9); add SELECT policies then,
-- restricted to platform admins / owners as appropriate.

-- 2) Sanity: NOT NULL metadata columns must always receive a value —
--    confirm no other NOT NULL column lacks an app-side default.
SELECT column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN ('audit_log', 'usage_events')
ORDER BY table_name, ordinal_position;

-- 3) Recent flow check — after exercising the app, both should show rows.
SELECT 'audit_log' AS src, count(*), max(created_at) FROM audit_log
UNION ALL
SELECT 'usage_events', count(*), max(created_at) FROM usage_events;

-- ============================================================
-- Membership cutover checks — run in Supabase SQL editor BEFORE
-- relying on business_members reads (frontend-improvement-plan.md Step 2).
-- Read-only diagnostics; nothing here mutates data.
-- ============================================================

-- 1) What are the actual enum values? Frontend assumes
--    status includes 'active' and roles are owner|manager|staff.
SELECT n.nspname AS schema, t.typname AS enum_name,
       array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.typname IN ('business_member_role', 'member_role', 'membership_status', 'member_status')
GROUP BY 1, 2;

-- 2) Is RLS enabled on business_members, and what policies exist?
SELECT c.relname, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'business_members';

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies WHERE tablename = 'business_members';

-- Expected minimum policies for the frontend to work:
--   SELECT: auth.uid() = user_id OR is_business_owner(business_id)  (member sees own row; owner sees team)
--   INSERT/UPDATE/DELETE: owner/admin of that business only.
-- If policies are missing, suggested baseline:

-- CREATE POLICY bm_select ON business_members FOR SELECT TO authenticated
--   USING (user_id = auth.uid()
--          OR EXISTS (SELECT 1 FROM business_members m
--                     WHERE m.business_id = business_members.business_id
--                       AND m.user_id = auth.uid() AND m.role = 'owner' AND m.status = 'active'));
--
-- CREATE POLICY bm_write ON business_members FOR ALL TO authenticated
--   USING (EXISTS (SELECT 1 FROM business_members m
--                  WHERE m.business_id = business_members.business_id
--                    AND m.user_id = auth.uid() AND m.role = 'owner' AND m.status = 'active'))
--   WITH CHECK (EXISTS (SELECT 1 FROM business_members m
--                  WHERE m.business_id = business_members.business_id
--                    AND m.user_id = auth.uid() AND m.role = 'owner' AND m.status = 'active'));

-- 3) Migration completeness — anyone with legacy access but no business_members row
--    will silently keep using the fallback path. This lists them.
SELECT au.business_id, au.user_id, au.role, au.full_name
FROM app_users au
LEFT JOIN business_members bm
       ON bm.user_id = au.user_id AND bm.business_id = au.business_id
WHERE bm.id IS NULL
ORDER BY au.business_id, au.created_at;

-- 4) Same, reversed: business_members rows with no legacy twin (fallback would deny them
--    if the feature flag were switched off).
SELECT bm.business_id, bm.user_id, bm.role, bm.full_name
FROM business_members bm
LEFT JOIN app_users au
       ON au.user_id = bm.user_id AND au.business_id = bm.business_id
WHERE au.id IS NULL
ORDER BY bm.business_id, bm.created_at;

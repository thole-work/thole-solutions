-- business_types RLS fix
--
-- The app resolves a member's business type via the embed used in
-- fetchActiveMembership():
--
--   business_members.businesses.business_types(display_name, type_key,
--     business_type_modules(module_key))
--
-- business_type_modules is readable, but the parent reference table
-- business_types has NO SELECT policy for authenticated, so the embed
-- resolves to null. Result: businessTypeKey stays null, businessModules
-- stays null, and every type/module-gated tab (kitchen, materials,
-- stock-movements, efficiency, produce) is hidden or disabled for all
-- users — even though the module rows (database/business_type_modules_seed.sql)
-- are present and correct.
--
-- Run this in the Supabase SQL editor (Project -> SQL -> New query).

-- Let signed-in users read the reference table.
drop policy if exists business_types_select on public.business_types;
create policy business_types_select on public.business_types
  for select to authenticated
  using (true);

-- Let unauthenticated lookups work too (reference data, no secrets).
drop policy if exists business_types_select_anon on public.business_types;
create policy business_types_select_anon on public.business_types
  for select to anon
  using (true);

-- Sanity check: should now return the full list of business types.
-- select type_key, display_name from public.business_types order by type_key;
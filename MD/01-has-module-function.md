# Task 1 — Create the `has_module()` SQL helper

## Goal
Add one SQL function. Nothing else depends on it yet, so this cannot break
anything currently working. This is the foundation the next two tasks
build on.

## Files to touch
- New file: `database/has_module_function.sql`
- Run it in the Supabase SQL editor (Project → SQL → New query)

## Do NOT touch
- `app.js`, `index.html`, or any other file
- Any existing RLS policy

## Exact change

```sql
-- has_module(): true if the given business's type has the given module
-- assigned in business_type_modules. Used by RLS WITH CHECK policies to
-- gate writes on module-scoped tables.
create or replace function public.has_module(p_business_id uuid, p_module_key text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from businesses b
    join business_type_modules btm on btm.business_type_id = b.business_type_id
    where b.id = p_business_id
      and btm.module_key = p_module_key
  );
$$;

grant execute on function public.has_module(uuid, text) to authenticated;
```

## Verification
Run in the SQL editor after creating it:

```sql
-- Should return true for a restaurant business + 'kitchen',
-- false for a retail business + 'kitchen'.
select
  b.name, bt.type_key,
  has_module(b.id, 'kitchen') as has_kitchen,
  has_module(b.id, 'pos') as has_pos
from businesses b
join business_types bt on bt.id = b.business_type_id
limit 10;
```

Confirm the `has_kitchen` / `has_pos` columns match what
`database/business_type_modules_seed.sql` assigns per type. If they
don't, stop — do not proceed to Task 2 until this checks out.

Commit as: `db: add has_module() RLS helper function`

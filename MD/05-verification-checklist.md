# Verification checklist (used by Tasks 2, 3, 4)

Run this after every task, before merging that task's branch.

## 1. Syntax check (frontend tasks only)
```
node -e "require('acorn').parse(require('fs').readFileSync('app.js','utf8'), {ecmaVersion:2022})"
```
Must exit clean before doing anything else.

## 2. SQL applied cleanly
In the Supabase SQL editor, confirm no errors on run, then:
```sql
select tablename, policyname, permissive, cmd
from pg_policies
where tablename = '<table_from_this_task>'
order by policyname;
```
Confirm the new policy/policies show `permissive = false` (i.e. they're
RESTRICTIVE) and are listed alongside whatever existing policy already
covers that table.

## 3. Cross-business-type smoke test
Log in (or use the SQL editor as a stand-in) as one user per business
type — retail, restaurant, salon, factory — and for each table touched by
the task:
- **A business type that HAS the module**: the write should succeed
  exactly as before.
- **A business type that LACKS the module** (e.g. retail + `kitchen`):
  the write should now fail with a policy violation, and did NOT fail
  before this task.

Use `database/business_type_modules_seed.sql`'s VALUES list to know which
type has which module.

## 4. No regression on unrelated tables
Spot-check one write on a table NOT touched by this task (e.g.
`products`) still works normally — confirms the RESTRICTIVE policies
didn't accidentally apply somewhere unintended.

## 5. Record the result
In the task's branch/PR description, note: which business types were
tested, which passed, and paste the `pg_policies` output from step 2.

Only merge once all four checks pass. If anything fails, fix it on the
same branch — don't move to the next numbered task file.

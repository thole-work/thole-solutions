# Restaurant SaaS Foundation Rollout

## Goal
Ship a safe multi-tenant restaurant SaaS foundation without breaking the current app.

## Phase 1: Database foundation
- Add `branches`.
- Add `business_members`.
- Add `invites`.
- Add `audit_log`.
- Add `usage_events`.
- Add `branch_id` to branch-aware operational tables.
- Keep existing `businesses` and `app_users` behavior working.

## Phase 2: App compatibility
- Read membership from `business_members` first.
- Fall back to `app_users` until the migration is fully adopted.
- Keep the existing invite-code onboarding path as a compatibility bridge.
- Start writing audit and usage events from the app.

## Phase 3: Branch-aware UI
- Let an owner choose a branch at login or from the top bar.
- Filter branch-scoped tables and transactions by `branch_id`.
- Default new records to the selected branch.

## Phase 4: Admin and monitoring
- Add a platform admin dashboard.
- Show business count, active user count, sessions, invites, and usage totals.
- Add a simple activity feed from `usage_events` and `audit_log`.

## Safety rules
- Every tenant-owned row must include `business_id`.
- Every branch-scoped row must include `branch_id` when the row belongs to a specific location.
- No cross-business access without platform admin rights.
- Keep legacy flows alive until the new flow is verified.

## Next execution order
1. Apply the SQL migration.
2. Update auth and membership reads in `index.html`.
3. Add branch selection and default branch handling.
4. Add audit and usage event writes around create/update/delete actions.
5. Build the admin monitoring views.

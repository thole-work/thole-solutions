# Frontend Improvement Plan — index.html vs Database Foundation
**Date**: 2026-08-24 · **Inputs**: `database/database map.txt` (29 tables), `database/saas_foundation_implementation.md`, full audit of `index.html` (5,840 lines)
**Status**: Ordered build list — awaiting go-ahead. `pos_sessions` intentionally deferred (not in scope).

---

## 0. Current State: DB vs Frontend

Of 29 tables, these are **never touched by index.html**:

| Unused table | Impact |
|---|---|
| `business_members` | Auth/team still run entirely on legacy `app_users` |
| `branches` (+ all `branch_id` columns) | Zero occurrences of "branch" in index.html |
| `audit_log` / `usage_events` | No writes from app |
| `customer_balances` / `supplier_balances` | Balances computed client-side instead |
| `modules` / `business_type_modules` | Nav gating hardcodes `"restaurant"/"factory"` strings (index.html:3794–3796) |
| `invites` | Only reached indirectly via `redeem_invite_code` RPC (acceptable bridge per rollout doc) |

Column-level drift:
- `products.total_sold` (NOT NULL): never written by frontend — needs trigger verification
- `products.cost_price`: exists but no UI (while recipe costing exists via `getAvgProductCost`)
- `products.automation_rules` (jsonb): dead column
- `orders.receipt_number`: read-only in UI (index.html:2953), never written — verify DB trigger/sequence

---

## Ordered Build List

### Step 1 — Hygiene quick wins (~1 day)
Unblocks everything else safely.
- [x] UX F-1/F-2 from `ux-eval-index.md`: remove `maximum-scale=1.0, user-scalable=no` (index.html:8); darken `--ink-faint` to `#676C87` (line 21)
- [x] Add `sb.auth.onAuthStateChange` → handle `SIGNED_OUT` / expired tokens reactively
- [x] Unsubscribe realtime channels on logout; rebuild after membership check (index.html:4109–4137, 2190–2200)
- [x] Surface swallowed errors: `pagedLoad` (2009), `saveSettings` success-toast-in-catch (3354–3371), `logStockMovement` (1982)
- [x] Extract Supabase URL/anon key from HTML into `config.js`

### Step 2 — Membership alignment (`business_members`) (~2 days)
Completes Phase 2 of the rollout doc.
- [x] `checkMembership()` reads active `business_members` first, falls back to `app_users` (index.html:3753–3784)
- [x] Team page: list/role-change/remove against `business_members` (5164–5200); keep invite-code RPC bridge alive
- [x] Feature flag: `const FEATURES = { businessMembers: true }` at top of script

### Step 3 — Business-type module alignment (~1 day)
- [x] Replace hardcoded `"restaurant"/"factory"` gating (3794–3796) with reads of `business_type_modules` / `modules`
- [x] Nav visibility derives from the module list returned with membership

Implementation notes (2026-08-24): `MEMBERSHIP_SELECT` nests `business_types(display_name, type_key, business_type_modules(module_key))` so modules arrive with membership in one round-trip. Gating helpers: `hasModule(key)` + `businessUsesRawMaterials()` → `inventory` module + `isProductionBusiness()` → `production` module (replaces both `=== "factory"` checks). Behind `FEATURES.typeModules`; falls back to legacy type-key strings when the module list is unavailable/empty. Conservative scope: only the two already-gated nav items (`stock-movements`, `efficiency`) follow modules today — extending to purchasing/store tabs deferred until validated.

Extended (2026-08-30): registry-driven gating in app.js — `TAB_MODULES` maps any tab → required module (kitchen, materials, stock-movements, efficiency bound; sales/customers/suppliers/payments/expenses/reports/purchases commented until `business_type_modules` is seeded for every type). `applyBusinessTypeVisibility()` now toggles every bound tab's nav item + panel, `switchTab()` refuses module-less tabs (redirects to dashboard), and `loadEverything()` + realtime subscriptions skip raw_materials/stock_movements/waste_log/labor_shifts/produce_batches when the business lacks the module — so a type never queries tables it doesn't own. Seed at `database/business_type_modules_seed.sql` (pos/kitchen/inventory/production/crm/finance/procurement per the four onboarding types). Legacy fallback: `LEGACY_TAB_TYPE_KEYS` reproduces old type-key behaviour when the module list is unavailable; unknown types stay fully visible.

### Step 4 — Audit & usage events (~2 days)
- [x] Thin helpers: `logAudit(action, entityType, entityId, before, after)` + `logUsage(eventType, pageKey)`
- [x] Wire into create/update/delete for highest-value entities first: orders, payments, products, stock_movements
- [x] Fire-and-forget (never block or fail the user action on log errors)

Implementation notes (2026-08-24): helpers live beside `logStockMovement`; both behind `FEATURES.eventLogging`, guarded on membership/session, `.then/.catch` so failures only `console.warn`. Wired: order create (POS + offline sync, tagged `source:'offline_sync'`), order append-update (after-only snapshot + `items_replaced` count), KDS status transitions, payment completion (order update audit + one summary usage event with method split), `voidSale` (with before status), payments CRUD (before from cache when editing; writes now use `.select().single()` to capture entity ids), product create/update/duplicate/soft-delete via generic `deleteRecord`, `page_view` per tab switch, `session_start`, and a lightweight usage ping inside `logStockMovement` (the movements table is itself the audit trail — no duplicate audit rows). RLS INSERT policies for `audit_log`/`usage_events` must exist for events to actually land — diagnostic added at `database/event_logging_rls_check.sql` (anon insert currently 401s as expected).

### Step 5 — Transactional integrity via SQL RPCs (~2 days)
Requires DB migrations.
- [x] `place_order(cart jsonb, table_id)` RPC: inserts order + items + updates table atomically; replaces await chain (2777–2815) and delete-all/reinsert append (2719–2728)
- [x] `record_payments(payments jsonb)` RPC: single-transaction multi-payment insert (2907–2921)
- [x] Retry loop around stock compare-and-set (1959–1967)
- [x] Add `.eq('business_id', bid)` to child-table queries: `order_items` (2719), `recipe_items` (5593, 5623–5659), `purchase_order_items` (5071, 3161)

Implementation notes (2026-08-24): migration at `database/transactional_integrity.sql` — `place_order(p_business_id, p_order, p_items, p_order_id default null)` handles both create (+ table occupancy) and append/replace-items in one SECURITY INVOKER transaction; `line_total` computed server-side; rejects voided/completed appends; membership re-checked in-function. Frontend adopts behind `FEATURES.atomicRpc` (`placeOrderViaRpc` helper) and falls back to the legacy await-chains on any RPC error; offline-sync path intentionally left on legacy inserts. `record_payments` mirrors the exact client-side allocation math. Stock CAS now detects 0-row updates via `.select()` and retries up to 3× (previously silent no-op on race). **Deviation on bullet 4**: live DB confirms `order_items`/`recipe_items`/`purchase_order_items` have **no** `business_id` column (42703), so `.eq('business_id')` there would error — implemented as parent-scoped verification instead: fixed the one real gap (`voidSale`'s orders fetch lacked the filter); all other child queries verified safe (ids originate from business-scoped cache/queries, e.g. reports' `validOrderIds`). Post-apply: run the grant/tighten statements in the migration footer before enabling the flag in production traffic.

### Step 6 — Server-side aggregation (~2 days)
- [x] `dashboard_summary(business_id, date_from, date_to)` SQL function returning revenue/today sales/orders/expenses/purchases/waste in one round-trip; replace full-history fetches (4142–4158)
- [x] Efficiency tab totals move to same RPC pattern (3304–3330)
- [x] KDS open-orders query gets explicit ordering + sensible cap (2174)

Implementation notes (2026-08-24): migration at `database/dashboard_summary.sql` — single STABLE SECURITY INVOKER function (no date params: the UI only ever showed all-time totals + UTC-today, which the function mirrors exactly via `(now() at time zone 'utc')::date`). Also returns `labor_cost` and `avg_yield_pct` so the efficiency tab's full `labor_shifts`/`produce_batches`/`waste_log` scans are gone too. Frontend: shared `fetchDashboardSummary()` helper behind `FEATURES.serverAggregation`; both `renderDashboard` and `renderEfficiency` consume it and fall back to the original fetch+reduce code on any RPC error. Net effect on the happy path: dashboard 4 full-table queries → 1 RPC; efficiency 4 full-table queries → 0 extra. KDS query already ordered oldest-first; added `.limit(100)` ceiling. Post-apply: run revoke/grant statements in the migration footer before production traffic.

### Step 7 — Branch-aware UI (~3 days)
Completes Phase 3 of the rollout doc.
- [x] Branch selector in topbar (owner/manager), persisted per business (`thole:branch:<bizId>`), default = first active branch or "All branches"
- [x] Write-path: stamp `selectedBranchId` on inserts into `orders`, `payments`, `expenses`, `stock_movements`, `waste_log`, `labor_shifts`, `produce_batches`, `customers`, `suppliers`, `restaurant_tables`
- [x] Read-path: filter lists by selection when a specific branch chosen

Implementation notes (2026-08-24): **Deviation** — live DB confirms `waste_log` and `produce_batches` have no `branch_id` column (42703), so those two inserts can't be stamped until a migration adds the column; all other 8 tables verified and stamped via a single `stampBranch()` helper (covers POS orders incl. RPC + offline sync + legacy, payments via `record_payments` rows + legacy loop + CRUD modal, expenses, stock movements via `logStockMovement`, customers ×2, suppliers, restaurant_tables, labor_shifts). Selector appears only when the business has ≥2 active branches AND role owner/manager — single-branch businesses see zero change; default falls back to "All branches" rather than first-active for that same reason (plan-literal default kept for ≥2 branches). Read-path via `applyBranchFilter(query, table)` + `BRANCH_SCOPED_TABLES` set, applied inside `pagedLoad` (covers sales/payments/expenses/customers/suppliers/movements lists), KDS queue, dashboard/efficiency fallback fetches, and `dashboard_summary` (new optional `p_branch_id` param; unfiltered tables without the column documented in SQL). Selection persisted per business in localStorage, validated against loaded branches on every login.

### Step 8 — Balances & schema drift cleanup (~1 day)
- [x] Adopt `customer_balances` / `supplier_balances` if maintained server-side; otherwise drop tables from schema and keep client-side math
- [x] Verify/implement `orders.receipt_number` assignment (trigger or write from app)
- [x] Decide: `products.cost_price` UI field vs drop; `total_sold` trigger vs drop; `automation_rules` keep-or-drop

Implementation notes (2026-08-24): decisions confirmed with owner → migration at `database/schema_drift_cleanup.sql`. Drops both balance tables (verified empty + unmaintained). Receipt numbering: per-business counter table (`receipt_number_counters`) + BEFORE trigger assigning on the pending→completed transition only — matches the app's actual flow (POS orders are created 'pending', completed at payment), never renumbers, and receipts immediately show real sequential numbers via the existing read path. `total_sold`: three triggers (order_items insert/delete, order→voided) keeping non-voided sales volume accurate; append-to-order's delete+reinsert nets out correctly; clamped at 0. `automation_rules` dropped; `cost_price` backfilled from recipe ingredient costs and auto-maintained by a recipe_items trigger (future margins UI can read it for free). All trigger functions are SECURITY DEFINER with pinned search_path so bookkeeping can never break a user action through RLS (e.g. cashiers completing sales don't need products UPDATE rights). No frontend changes required this step.

### Step 9 — Admin monitoring (Phase 4 of rollout doc) (~2 days)
- [ ] Platform admin dashboard: business count, active users, sessions, invites, usage totals
- [ ] Activity feed from `usage_events` + `audit_log` (now flowing since Step 4)

### Backlog (not scheduled)
- Split monolith into JS modules with minimal build
- Keyboard shortcuts for POS loop (ux-eval F-6), type-scale tokens (F-5)
- One-tap reorder from low-stock strip

---

## Execution cadence

```
Week 1:  Steps 1–3   (hygiene, membership, modules)
Week 2:  Steps 4–5   (events, atomic RPCs — needs migration window)
Week 3:  Steps 6–7   (aggregation, branches)
Week 4:  Steps 8–9   (cleanup, admin) → then run validation-plan.md sprint
```

Safety rule (from rollout doc, still applies): keep legacy flows alive until new paths are verified; ship behind feature flags where feasible.

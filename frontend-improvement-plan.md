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
- [ ] Replace hardcoded `"restaurant"/"factory"` gating (3794–3796) with reads of `business_type_modules` / `modules`
- [ ] Nav visibility derives from the module list returned with membership

### Step 4 — Audit & usage events (~2 days)
- [ ] Thin helpers: `logAudit(action, entityType, entityId, before, after)` + `logUsage(eventType, pageKey)`
- [ ] Wire into create/update/delete for highest-value entities first: orders, payments, products, stock_movements
- [ ] Fire-and-forget (never block or fail the user action on log errors)

### Step 5 — Transactional integrity via SQL RPCs (~2 days)
Requires DB migrations.
- [ ] `place_order(cart jsonb, table_id)` RPC: inserts order + items + updates table atomically; replaces await chain (2777–2815) and delete-all/reinsert append (2719–2728)
- [ ] `record_payments(payments jsonb)` RPC: single-transaction multi-payment insert (2907–2921)
- [ ] Retry loop around stock compare-and-set (1959–1967)
- [ ] Add `.eq('business_id', bid)` to child-table queries: `order_items` (2719), `recipe_items` (5593, 5623–5659), `purchase_order_items` (5071, 3161)

### Step 6 — Server-side aggregation (~2 days)
- [ ] `dashboard_summary(business_id, date_from, date_to)` SQL function returning revenue/today sales/orders/expenses/purchases/waste in one round-trip; replace full-history fetches (4142–4158)
- [ ] Efficiency tab totals move to same RPC pattern (3304–3330)
- [ ] KDS open-orders query gets explicit ordering + sensible cap (2174)

### Step 7 — Branch-aware UI (~3 days)
Completes Phase 3 of the rollout doc.
- [ ] Branch selector in topbar (owner/manager), persisted per business (`thole:branch:<bizId>`), default = first active branch or "All branches"
- [ ] Write-path: stamp `selectedBranchId` on inserts into `orders`, `payments`, `expenses`, `stock_movements`, `waste_log`, `labor_shifts`, `produce_batches`, `customers`, `suppliers`, `restaurant_tables`
- [ ] Read-path: filter lists by selection when a specific branch chosen

### Step 8 — Balances & schema drift cleanup (~1 day)
- [ ] Adopt `customer_balances` / `supplier_balances` if maintained server-side; otherwise drop tables from schema and keep client-side math
- [ ] Verify/implement `orders.receipt_number` assignment (trigger or write from app)
- [ ] Decide: `products.cost_price` UI field vs drop; `total_sold` trigger vs drop; `automation_rules` keep-or-drop

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

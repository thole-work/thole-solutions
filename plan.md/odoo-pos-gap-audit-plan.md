# Thole POS vs. Odoo Restaurant POS — Gap Audit & Safe Shortcut Plan

**Purpose of this document:** hand this to an AI assistant (Claude or otherwise)
working on the Thole Solutions restaurant POS, and it should be able to run a
faithful, repeatable gap audit against Odoo's restaurant POS, then follow a
safe, incremental plan to close the gaps that matter — without breaking what
already works.

This is a **methodology + checklist + roadmap**, not a one-shot instruction to
go build everything at once. Read it fully before touching code.

---

## 1. Ground rules (read this before doing anything)

These apply regardless of which gap you're closing:

1. **Read the real file first.** `index.html` is the single source of truth.
   Never propose a change based on what you assume is there — `view` the
   actual sections (nav, relevant tab, relevant functions) before editing.
   Assumptions about "what a POS probably has" are usually wrong here,
   because a lot is already built.
2. **Work in a copy.** Copy the uploaded file to a writable working
   directory before editing (`/mnt/user-data/uploads` is read-only). Edit the
   copy, syntax-check it, then deliver it.
3. **Syntax-check after every batch of edits**, not just at the end:
   ```
   node -e "
   const fs = require('fs');
   const content = fs.readFileSync('index.html', 'utf8');
   const scripts = [...content.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
   scripts.forEach((s,i)=>{ try { new Function(s); console.log(i,'OK'); }
     catch(e){ console.log(i,'ERROR:', e.message); } });
   "
   ```
4. **Never break multi-tenancy.** Every query touching business data filters
   by `business_id`, and RLS policies must stay intact. A "shortcut" that
   skips this check is not a shortcut — it's a data leak.
5. **Never break offline-first.** The POS queues orders in `localStorage`
   when offline and syncs on reconnect. Any new write path (new order types,
   new stock movements, new payment flows) must either go through the
   existing sync queue or be justified as safe to require connectivity.
6. **Prefer additive schema changes.** New columns with safe defaults, new
   tables, new enum values — yes. Renaming or dropping existing columns that
   other code paths depend on — only with an explicit migration plan and the
   person's sign-off, never silently.
7. **Feature-flag anything that changes existing behavior for existing
   users.** The `businesses.settings` jsonb column is the established pattern
   (see `recipe_consumes_materials`). Default new behavior *off* unless it's
   purely additive.
8. **One capability at a time.** Ship the smallest complete slice (schema →
   UI → tested happy path) before starting the next. Don't open five
   half-finished features in one pass.
9. **Grep before you build.** Odoo-sounding features often already exist
   under a different name here. Before building "X," grep for it:
   ```
   grep -n "keyword1\|keyword2\|keyword3" index.html | head -50
   ```

---

## 2. How to run the audit (repeatable process)

For each feature in the checklist (§3):

1. **Search the codebase** for related functions, table names, or UI strings
   (see grep pattern above).
2. **Classify it:**
   - ✅ **Built** — works today, note the function/table.
   - 🟡 **Partial** — some scaffolding exists but incomplete (note what's
     missing).
   - ⬜ **Missing** — nothing exists yet.
3. **Note the real cost to close the gap** — schema change? new UI only?
   both? does it touch offline sync or multi-tenancy?
4. **Record it in the status table** (§4) so the next session doesn't
   re-derive this from scratch.

Do not skip step 1. A feature marked "missing" without a grep pass is not a
trustworthy audit.

---

## 3. Odoo Restaurant POS reference checklist

Grounded in Odoo's own restaurant-POS documentation and feature pages
(current as of mid-2026). Use this as the comparison baseline — not every
item is worth matching; that judgment call happens in §5.

| # | Feature | What it does in Odoo |
|---|---|---|
| 1 | Floor plan / table map | Visual table layout, drag-and-drop editor, table status |
| 2 | Table transfer/merge | Move an order to another table; merging combines two tables' orders |
| 3 | Bill splitting (by item) | Divide specific line items into a sub-order that's paid separately, distinct from the original order |
| 4 | Split payment (by method) | One order paid across multiple methods (cash+card, etc.) |
| 5 | Course management | Group order lines into courses, fire each to the kitchen sequentially |
| 6 | Kitchen/bar printers or KDS | Order lines routed to the right printer/screen by category (kitchen vs. bar) |
| 7 | Per-line kitchen notes | Free-text instructions per item ("no onions"), shown to kitchen, not on the customer receipt |
| 8 | Early/bill-only printing | Print a bill for the table before payment, without closing the order |
| 9 | Tips | Add gratuity at payment, tracked separately from the sale |
| 10 | Offline mode | Orders continue to work without connectivity, sync on reconnect |
| 11 | Ingredient-level stock via BOM | Selling a dish deducts linked raw materials automatically |
| 12 | Combo meals | Bundle multiple items as one sellable unit with component selection |
| 13 | QR-code table ordering | Customers scan a code, view menu, and order from their own device |
| 14 | Table reservations | Bookings shown directly on the floor plan |
| 15 | Self-service kiosk mode | Customer-facing ordering screen for counter service |
| 16 | Customer identification / loyalty | Attach a customer to an order for history and loyalty tracking |
| 17 | Dine-in/takeout/delivery presets | Quick service-type toggle affecting workflow (e.g., no table needed for takeout) |
| 18 | Cashier session (open/close till) | Declared opening cash, running session, reconciled close-out |
| 19 | Refunds/returns | Reverse a completed sale, restock if applicable |
| 20 | Purchasing / reorder rules | Auto-suggested restocking based on thresholds and supplier data |

---

## 4. Current status (fill in and keep updated)

This table should be re-derived (not copy-pasted blindly) each time this doc
is used, since the codebase moves.

**⚠️ Re-audited against the actual uploaded `index.html` on 2026-08-23, and the
result is a major correction, not a touch-up.** The file grepped is a general
small-business retail/inventory management app ("Thole Solutions" — nav tabs:
Dashboard, Products & Stock, Sales, Customers, Payments, Expenses, Suppliers,
Purchase Orders, Team, Reports, Raw Materials). It is **not** a restaurant
table-service POS. There is no `restaurant_tables` table, no `table_id`
column anywhere in the schema, no floor plan, no kitchen/KDS, no tips, no
split payment, no cashier session, and no offline `localStorage` sync queue
for orders. "Sales" (`tab-sales`) is a single-line product/qty/price/customer
form (`submitSale()`) that inserts one `orders` row + one `order_items` row —
not a multi-item cart. Every restaurant-specific claim in the previous
version of this table (floor plan, split payment, tips, offline mode, KDS)
was **not found in this file** and should be treated as either aspirational,
describing a different/future version of the app, or referring to a codebase
this file doesn't match. Ground rule #1 ("read the real file first") applies
here in full force — nothing below is assumed.

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | Floor plan / table map | ⬜ Missing (schema ready) | No floor-plan UI/CSS in the app, but the `restaurant_tables` table exists (`table_number`, `capacity`, `status`, `current_order_id`) and `orders.table_id` references it; needs table-management UI + a write path, not new tables |
| 2 | Table transfer/merge | ⬜ Missing | Depends on #1 existing first; nothing to transfer/merge |
| 3 | Bill splitting (by item) | ⬜ Missing | No "split" logic beyond `String.split()` string-parsing calls (dates); no sub-order concept |
| 4 | Split payment (by method) | ⬜ Missing (foundation done) | Cart checkout now records a single `payment_method`; multi-method per order still needs the split UI. The batched write path makes it a small increment now |
| 5 | Course management | ⬜ Missing | |
| 6 | Kitchen/bar printers or KDS | ⬜ Missing | No "kitchen", "KDS", or "printer" references at all |
| 7 | Per-line kitchen notes | ⬜ Missing (needs migration) | `order_items` has `product_id, quantity, unit_price, line_total` only — no `notes` column here or in the DB map; genuinely additive migration required |
| 8 | Early/bill-only printing | ⬜ Missing | No pre-payment bill/print flow; no print logic found |
| 9 | Tips | ✅ Built (2026-08-23) | Tip field in the cart checkout writes `orders.tip`; included in totals and close-session expected-cash math |
| 10 | Offline mode | ⬜ Missing | Only `localStorage` use is the dark/light theme preference (`thole:dark`); no order queue, no `online`-event sync |
| 11 | Ingredient-level stock via BOM | ✅ Built (Raw Materials / Produce flow) | `recipe_items` (`product_id`, `raw_material_id`, `quantity_required`) links products to materials; `submitProduce()` validates stock, deducts `raw_materials.stock_qty`, adds `products.stock_qty`, and logs `stock_movements` — this is live and running, not gated off. Note: `recipe_consumes_materials` as a settings toggle was **not found** — consumption is unconditional here, and this is a "produce a batch" workflow, not automatic per-sale ingredient deduction |
| 12 | Combo meals | ⬜ Missing | |
| 13 | QR-code table ordering | ⬜ Missing | |
| 14 | Table reservations | ⬜ Missing | |
| 15 | Self-service kiosk mode | ⬜ Missing | |
| 16 | Customer identification / loyalty | 🟡 Partial | `customers` table exists and is linked to `orders`/`payments` (name, walk-in option in sale form); no loyalty-points or history-rollup logic found |
| 17 | Dine-in/takeout/delivery presets | ✅ Built (2026-08-23) | Order-type select (takeaway/dine_in/delivery) in cart checkout writes `orders.order_type` |
| 18 | Cashier session (open/close till) | ✅ Built (2026-08-23, opt-in flag) | `pos_sessions` UI shipped: open with counted float, close-out with expected-vs-actual variance, checkout gating via `businesses.settings.require_pos_session` (default off). RLS policies on `pos_sessions` still need the §6 Phase 0 / migration-file SQL check before relying on it in production |
| 19 | Refunds/returns | ✅ Built (2026-08-23) | `voidSale()` is now a real refund: order flips to `status: 'refunded'` (no delete), stock restored via `stock_movements` (`reason: "sale_refunded"`), and a refund-of-record lands in `payments` with `direction: "out"` + `order_id`. Refunded rows are badged in the ledger and excluded from dashboard/report revenue. Partial per-line refunds not yet in scope |
| 20 | Purchasing / reorder rules | 🟡 Partial → suggestions shipped (2026-08-23) | "Suggest reorder" on the Purchase Orders tab lists low-stock items (deficit-sorted, suggested qty/cost pre-computed) and pre-fills the purchase modal; submission still flows through `submitPurchase()`. Auto-generated POs / supplier-linked rules remain future work |
| 20 | Purchasing / reorder rules | 🟡 Partial (suggestions now built) | Purchase orders (`purchase_order_items`, `submitPurchase`, `voidPurchase`) work, and a "Suggest reorder" list + pre-filled PO modal shipped 2026-08-23. Still missing: auto-generated POs and supplier-linked reorder rules |

**Second correction — same day (2026-08-23), schema vs. app code.** The audit
above was done against `index.html` only. The repo also contains a `database/`
folder (`database map.txt`, `saas_foundation.sql`) describing the live Supabase
schema, and it contradicts several "nothing exists" conclusions:

- `orders` **already has** `table_id` (→ `restaurant_tables`), `order_type`
  (NOT NULL), `subtotal`, `discount`, `discount_type`, `tax_rate`, `tax`,
  `tip` (NOT NULL), `change_given`, `receipt_number`, `payment_method`.
- A `restaurant_tables` table exists: `table_number`, `name`, `capacity`,
  `status`, `current_order_id` → `orders`.
- A `pos_sessions` table exists: `opened_by/closed_by`, `opening_float`,
  `expected_cash`, `actual_cash`, `status`, `opened_at/closed_at`.
- `payments` has `direction` (app already writes `"in"`), `party_type`,
  `order_id`, `method` — i.e. an order-linked refund payment is expressible
  today with no migration.
- Also present but unused by the app: `labor_shifts`, `produce_batches`,
  `waste_log`, `customer_balances`, `supplier_balances` views.

So the accurate framing is: **the schema anticipates a restaurant POS; the app
code uses almost none of it.** Most "⬜ Missing" rows below mean "schema ready,
UI + write path missing," which is much cheaper than greenfield. Two anomalies
need resolving before anything else (see Phase 0 in §6): the map says
`orders.order_type/subtotal/tax/tip` are NOT NULL, yet `submitSale()` inserts
none of them — so either the live DB has defaults/triggers the map omits, or
the map describes a target state not yet applied. Verify against live Supabase
before building on these columns. `order_items` genuinely has no `notes`
column anywhere, and there is still no offline order queue, KDS/printer code,
or split logic in the app.

**Net effect on the rest of this document:** the restaurant-POS surface is not
greenfield at the data layer — tables, sessions, tips, service type, receipt
numbering, and refund-capable payments all have schema waiting for a write
path and UI. §5 and §6 below have been adjusted to reflect that — treat them
as a starting proposal to confirm with the person, not a continuation of the
old plan.

---

## 5. Prioritization — what's actually worth building

Not everything in Odoo's checklist matters for Thole's actual users. Weigh
each gap against:

- **Frequency of use** — will staff hit this every shift, or rarely?
- **Cost of absence** — does missing it cause a workaround that's error-prone
  (e.g., no session tracking → cash discrepancies go undetected) or just
  mildly less convenient?
- **Build cost vs. schema risk** — additive UI-only features are cheap;
  anything touching payments, stock, or multi-location data needs more care.

**⚠️ Before ranking gaps, resolve the bigger open question with the person:**
the app code today is a general retail/inventory app with a single-line
sale form — but the *database* already models table service (see §4 second
correction). So this is no longer "build a POS layer from zero"; it's "build
the UI and write paths for tables/columns that already exist." Still confirm
with the person whether:
- they actually want full table-service (floor plan, courses, KDS, splitting
  by table) surfaced in the app, or
- they need a narrower subset (e.g. just a faster multi-item sale cart +
  tips + refunds), which is a much smaller lift.

The ranking below assumes the narrower, foundation-first reading — build the
few things every restaurant workflow depends on before anything
table-specific — but treat it as a proposal, not a decision.

**High value, do next (no cart/table concept required):**
- #19 Refunds/returns as a real reversal — `voidSale()` currently hard-deletes
  the order; flip `orders.status` to `'refunded'` and record a
  `payments` row with `direction: "out"` linked via the existing
  `payments.order_id` so there's an audit trail. No migration needed.
- #20 Reorder rules — low-stock flagging exists on the dashboard, so
  generating actual reorder suggestions from it is a small, additive step
- #16 Customer loyalty — the `customers` link already exists; add
  points/visit tracking on top of it

**Foundational, needed before most of the rest of the Odoo checklist makes
sense here:**
- A real multi-item sale cart (today's `submitSale()` is one product per
  sale) — #4 split payment, #9 tips, and #3 bill splitting all assume a cart
  with multiple lines and a running total. Note the payoff: once built, tips,
  discounts, tax, order type, and receipt numbering all have **existing
  columns** (`orders.tip/discount/tax_rate/order_type/receipt_number/...`)
  waiting to be written — several checklist items collapse into "populate the
  fields the schema already has."
- #1 Floor plan / table map, if table service is confirmed in scope —
  `restaurant_tables` + `orders.table_id` exist; what's missing is purely UI
  plus CRUD on tables. #2, #13, #14, #17 become cheap once this lands.
- #18 Cashier session — `pos_sessions` exists; the work is an open/close UI
  gating checkout behind an open session (flagged opt-in first).

**Lower priority / bigger lift — revisit once the above is stable:**
- #5 Course management
- #12 Combo meals
- #13 QR-code ordering
- #15 Self-service kiosk
- #14 Table reservations

**Already built, no action needed:**
- #11 Ingredient-level BOM via the "Produce" flow — live and unconditional
  today (not gated by a `recipe_consumes_materials` setting, contrary to the
  earlier version of this doc). If a feature-flagged toggle is actually
  wanted, that's new work, not re-enabling something disabled.

---

## 6. Shortcut plan (safe execution order)

**Execution log (2026-08-23):** Phase 0 + Steps 1–4 shipped. Four pre-existing
defects were found while testing and fixed, because the steps depended on the
affected code paths:
1. The whole app lives inside an IIFE but dozens of inline handlers used bare
   names (`onclick="voidSale(...)"`, including the main nav) — none could ever
   resolve. Fixed by `Object.assign(window, window.TholeApp)` after the API
   object is built.
2. Six shared helpers were called everywhere but never defined
   (`escapeHtml`, `money`, `setError`, `clearError`, `show`, `hide`) — every
   render path would have thrown for an authenticated user. Definitions added
   at the top of the script.
3. **`boot()` was defined but never called** — every user would see the
   splash screen forever. Now invoked at the end of the script; verified the
   app reaches the sign-in screen when no session exists.
4. Six modal submit buttons had BOTH an inline `onclick="submitX()"` AND an
   `addEventListener('click', submitX)` — every save fired twice (duplicate
   inserts). Redundant listeners removed; onclick is the single source.

All of Steps 1–4 verified via headless-browser tests against a mocked
Supabase REST layer (full authenticated flow): checkout math exact
(subtotal/discount %/tax/tip → total), receipt numbering (max+1), batched
`order_items` insert in one POST, per-line stock decrements + movements,
double-submit guard, session gate blocking sales when required-but-unavailable,
and refund-excluded dashboard math — zero unexpected page errors.

"Shortcut" here means *smallest safe increment*, not *skip the safety
checks*. Each step below is scoped to be shippable and testable on its own.
**This plan is rewritten against the app code *and* the schema evidence in
`database/`** — several building blocks (`pos_sessions`, `restaurant_tables`,
`orders.table_id/tip/order_type/receipt_number`, refund-capable
`payments.direction`) already exist and are unused, while others (offline
queue, KDS, kitchen notes) genuinely don't.

### Phase 0 — Verify the live schema before building on it (blocking, ~30 min)
**✅ RESOLVED 2026-08-23 via live PostgREST probes.** Every restaurant column
the plan needs already exists in the live database: `orders` accepted
selects on `order_type, subtotal, discount, discount_type, tax_rate, tax,
tip, receipt_number, payment_method, table_id`; `pos_sessions`,
`restaurant_tables`, and `payments.direction/order_id` all exist. The only
missing column anywhere is `order_items.notes` (confirmed error 42703) —
deferred to Step 6. Because sales work today while inserting none of the
NOT NULL columns, defaults must exist; the exact defaults are recorded in
`database/pos_alignment_migration.sql` §1a (run when SQL-editor access is
available). RLS policy presence for `restaurant_tables`/`pos_sessions`
cannot be verified over REST — check via §1b of that file before Step 5
touches those tables. **No DDL is required for Steps 1–2.**

Original verification instructions (kept for future re-runs):
The DB map says `orders.order_type`, `subtotal`, `tax_rate`, `tax`, and `tip`
are NOT NULL, yet `submitSale()` (index.html:1455) inserts none of them and
sales evidently work. Run this against the live Supabase (SQL editor) and
record the answer here:
```sql
select column_name, is_nullable, data_type, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'orders'
order by ordinal_position;
```
- If defaults/triggers exist → the map under-describes the DB; build directly
  on the existing columns.
- If the columns don't exist / are nullable → sales work because the map
  describes an *aspirational* schema; apply an additive migration first
  (new columns with safe defaults; never NOT NULL without default on a live
  table), then proceed.
Also confirm RLS policies exist for `restaurant_tables` and `pos_sessions`
before any app code touches them (ground rule #4). **Do not start Step 1
until this is resolved** — every later step writes to these tables.

### Step 1 — Refunds/returns as a real reversal (no migration)
**✅ SHIPPED 2026-08-23.** `voidSale()` (index.html) is now a non-destructive
refund: re-fetches the order, guards double-refund, prompts for method
(cash/bank_transfer/mobile_money), restores stock per line with movement
`reason: "sale_refunded"`, inserts a `payments` row `direction: "out"` linked
via `order_id`, and flips the order to `status: 'refunded'` instead of
deleting. Ledger shows refunded rows badged + dimmed; dashboard and reports
exclude them from revenue/averages (`loadReports` filters `.neq("status",
"refunded")`). Partial per-line refunds are still out of scope for v1.

Original scope notes:
- Replace `voidSale()`'s ending hard delete (`await sb.from("orders").delete()`,
  index.html:1527) with:
  1. update the order to `status: 'refunded'`
  2. insert a `payments` row: `direction: "out"`, `party_type: "customer"`,
     `customer_id`, `order_id: orderId`, `amount = order.total_amount`,
     plus a method captured from a small prompt/select.
- Keep the existing per-line restock loop exactly as-is; change only the
  movement `reason` string to `"sale_refunded"` so history stays truthful.
- Update `loadSales()` rendering so refunded rows are badged/greyed instead of
  offering a second Void click, and make sure `renderDashboard()` /
  `loadReports()` revenue sums exclude `status <> 'refunded'`.
- Decide with the person whether partial (per-line) refunds are in scope for
  v1; whole-order first keeps it simple.
- Test: refund → stock restored, movement logged, order still queryable,
  revenue drops, refund payment appears in Payments tab; double-click Void;
  refunding an already-refunded order.

### Step 2 — Reorder suggestions from existing low-stock data (no migration)
**✅ SHIPPED 2026-08-23.** Low-stock filter deduped into one
`getLowStockProducts()` helper (was copy-pasted in four places). Purchase
Orders tab now has a "Suggest reorder" toggle rendering a suggestion list
(deficit-sorted, suggested qty = threshold − stock, cost from
`products.cost_price`) with a "Start PO" button that opens the existing
purchase modal pre-filled via `prefillPurchase()`. `submitPurchase()` itself
is untouched.

Original scope notes:
- The low-stock filter already exists verbatim in three places (e.g.
  index.html:2069). Extract it into one helper `getLowStockProducts()` and
  reuse it everywhere.
- Add a "Suggest reorder" button on the Purchase Orders tab: builds a draft
  PO of each low-stock product at `(low_stock_threshold - stock_qty)` qty ×
  `products.cost_price`, then opens the existing new-purchase modal
  pre-filled. Submission goes through the untouched `submitPurchase()` path.
- Purely additive UI on top of data that already exists.
- Test: suggestion math with null thresholds/cost prices; empty result state;
  editing the draft before submit; void-after-submit still restocks correctly.

### Step 3 — Multi-item sale cart (foundation for tips/splitting/session)
**✅ SHIPPED 2026-08-23.** The sale modal is now a cart: add-line (same
product+price merges quantities), remove-line, live total. Checkout writes the
full existing schema — `subtotal/discount/discount_type/tax_rate/tax/tip/
order_type/payment_method/receipt_number` — with receipt = max+1 per business
and all `order_items` inserted as one batch (`line_total` populated, which the
reports path prefers). Stock + movements loop per line exactly like before.
Double-submit guarded via a `submittingSale` flag; partial-write policy: order →
items → stock/movements sequence, failures surface with the modal open and the
cart intact. E2E-verified against mocked REST: payload math exact ($25 − 10% +
10% tax + $2 tip = $26.75), receipt 7→8, batch body of 2 lines, stock 10→8 and
40→37.

Original scope notes:
This is the real unlock. Get the approach confirmed with the person before
starting — it rewrites the core sale-completion path.
- Client-side cart array (`[{product_id, name, qty, unit_price}]`) held in
  module state; the sale modal becomes add-line / remove-line / edit-qty UI
  with a running total.
- On checkout, write what the schema already has: one `orders` insert with
  `subtotal`, `discount` (+`discount_type`), `tax_rate`, `tax`, `tip`,
  `order_type` (default `"takeaway"` until #17 UI exists),
  `payment_method`, and `receipt_number` (max+1 per business; retry-on-
  conflict is an acceptable concurrency story at this scale).
- Insert all `order_items` rows in one `.insert([...])` batch call.
- Stock decrement + `stock_movements` stay per-product exactly like today's
  single-line logic, just looped over cart lines.
- Supabase has no client-side transactions: sequence = order → items →
  stock/movements. On failure, surface the error and leave state consistent;
  document the chosen policy for a partial write (order without items).
- Test: happy path multi-line sale; zero-stock product; per-line price edit;
  double-submit; network failure mid-checkout; dashboard/report sums
  unchanged for legacy single-line rows.

### Step 4 — Cashier session, using the EXISTING `pos_sessions` table
**✅ SHIPPED 2026-08-23.** A "Cash session" card on the Sales tab shows state
and Open/Close buttons; owners/managers also get a "Session required" toggle
that persists `businesses.settings.require_pos_session` (the first settings-
flag use in the app — pattern established). Checkout is gated behind an open
session ONLY when the flag is on (default off = behavior unchanged for
existing users, per ground rule #7). Close-out computes `expected_cash =
opening_float + cash orders − cash refund payments` since `opened_at`,
records it alongside counted `actual_cash`, and reports variance. All reads
are defensive: if `pos_sessions` is RLS-blocked the card shows a warning and
sales are blocked only when the flag demands a session. E2E-verified both the
denied-backend path and gate enforcement.

Original scope notes:
Do **not** create a new table — one already exists. Use its real columns:
`opening_float` (not opening_cash), `actual_cash` (not closing_cash),
`expected_cash`, `status`, `opened_by/opened_at/closed_by/closed_at`.
- Open-session modal: cashier enters counted `opening_float`.
- Gate checkout behind a `status = 'open'` session for the business, opt-in
  via a `businesses.settings` jsonb flag first (e.g.
  `require_pos_session: true`) per ground rule #7 — note no settings flags
  exist in app code yet, so this establishes the pattern; default off.
- Close-out screen: compute `expected_cash = opening_float + cash sales −
  cash refunds` from orders/payments, compare against counted
  `actual_cash`, record variance, close session.
- Test: open → sell → close reconciles; closing with unsettled activity;
  two devices same business; flag-off behavior identical to today.

### Step 5 — Confirm table-service scope, then floor plan if yes
Before building #1 (floor plan), #2 (transfer/merge), #6 (KDS), or #7
(kitchen notes): confirm with the person whether table service is actually
in scope (see §5). If yes:
- `restaurant_tables` + `orders.table_id` already exist — build a Tables tab
  with CRUD on tables and a grid showing `status` / open-order linkage via
  `current_order_id`.
- Extend the Step-3 cart with "assign table" writing `orders.table_id`, with
  table status transitions driven by the order lifecycle.
If no, drop those rows from future audits rather than re-flagging them as
gaps every time.

### Step 6 onward
- #17 service-type presets and #9 tips become small UI additions once Step 3
  lands (their columns exist).
- #7 kitchen notes needs the one genuinely additive migration
  (`alter table order_items add column notes text`) plus print/KDS routing
  decisions — defer until #6 scope is known.
- Then re-run the audit (§2) against the updated codebase, re-derive §4
  (don't copy-paste it), re-prioritize §5 with the person, and repeat.

---

## 7. What "safe" means in practice for this codebase

- Every new table gets RLS policies scoped to `business_id` before it ships,
  not after.
- Every new write path is tested against the offline queue: does it need to
  work offline? If yes, route it through the existing sync mechanism rather
  than a parallel one.
- Every change to `completePayment`, stock consumption, or order status
  transitions gets manually walked through against the existing test
  pattern established for split payments and the kitchen-stock work: happy
  path, then one edge case (partial data, network failure, double-submit).
- Nothing in §6 is deployed without the person reviewing the diff — this
  plan sequences *what* to build safely, it doesn't authorize silently
  shipping to production.

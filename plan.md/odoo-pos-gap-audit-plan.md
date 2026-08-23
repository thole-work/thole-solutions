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
| 1 | Floor plan / table map | ⬜ Missing | No `restaurant_tables`, `table_id`, or floor-plan UI/CSS found anywhere in the file |
| 2 | Table transfer/merge | ⬜ Missing | Depends on #1 existing first; nothing to transfer/merge |
| 3 | Bill splitting (by item) | ⬜ Missing | No "split" logic beyond `String.split()` string-parsing calls (dates); no sub-order concept |
| 4 | Split payment (by method) | ⬜ Missing | `payment_method` only appears as a plain select option list (e.g. "Bank transfer"); no multi-method single-sale payment UI |
| 5 | Course management | ⬜ Missing | |
| 6 | Kitchen/bar printers or KDS | ⬜ Missing | No "kitchen", "KDS", or "printer" references at all |
| 7 | Per-line kitchen notes | ⬜ Missing | `order_items` has `product_id, quantity, unit_price` only — no `notes` column |
| 8 | Early/bill-only printing | ⬜ Missing | No pre-payment bill/print flow; no print logic found |
| 9 | Tips | ⬜ Missing | No "tip"/"gratuity" references anywhere |
| 10 | Offline mode | ⬜ Missing | Only `localStorage` use is the dark/light theme preference (`thole:dark`); no order queue, no `online`-event sync |
| 11 | Ingredient-level stock via BOM | ✅ Built (Raw Materials / Produce flow) | `recipe_items` (`product_id`, `raw_material_id`, `quantity_required`) links products to materials; `submitProduce()` validates stock, deducts `raw_materials.stock_qty`, adds `products.stock_qty`, and logs `stock_movements` — this is live and running, not gated off. Note: `recipe_consumes_materials` as a settings toggle was **not found** — consumption is unconditional here, and this is a "produce a batch" workflow, not automatic per-sale ingredient deduction |
| 12 | Combo meals | ⬜ Missing | |
| 13 | QR-code table ordering | ⬜ Missing | |
| 14 | Table reservations | ⬜ Missing | |
| 15 | Self-service kiosk mode | ⬜ Missing | |
| 16 | Customer identification / loyalty | 🟡 Partial | `customers` table exists and is linked to `orders`/`payments` (name, walk-in option in sale form); no loyalty-points or history-rollup logic found |
| 17 | Dine-in/takeout/delivery presets | ⬜ Missing | No service-type field on `orders` |
| 18 | Cashier session (open/close till) | ⬜ Missing | No session/till table or open/close-shift UI |
| 19 | Refunds/returns | 🟡 Partial (as void, not refund) | `voidSale()` / `voidPurchase()` exist: delete the order, restore stock via `stock_movements` (`reason: "sale_voided"`). This is a hard void/delete, not a refund-of-record with a payment reversal or `refund_of_order_id` link — there's no partial refund and no audit trail once the order is deleted |
| 20 | Purchasing / reorder rules | 🟡 Partial | Purchase orders (`purchase_order_items`, `submitPurchase`, `voidPurchase`) exist and work; low-stock is only a dashboard **flag** (`stock_qty <= low_stock_threshold`) — no auto-generated reorder suggestions or supplier-linked reorder rules |

**Net effect on the rest of this document:** almost the entire restaurant-POS
surface (table map, KDS, tips, split payment/bill, offline queue, cashier
session, kitchen notes) is greenfield here, not a gap-closing exercise on top
of existing scaffolding. §5 and §6 below have been adjusted to reflect that —
treat them as a starting proposal to confirm with the person, not a
continuation of the old plan.

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
this codebase today is a general retail/inventory app with a single-line
sale form, not a table-service restaurant POS. Closing gaps #1–#17 isn't a
series of small increments on existing scaffolding — it's building a
table-service POS layer from zero on top of an app that currently has no
concept of a table, a cart, or an in-progress order. That's a much bigger
scope than the old version of this table implied. Confirm with the person
whether:
- they actually want full table-service (floor plan, courses, KDS, splitting
  by table) built here, or
- they need a narrower subset (e.g. just a faster multi-item sale cart +
  tips + refunds), which is a much smaller lift.

The ranking below assumes the narrower, foundation-first reading — build the
few things every restaurant workflow depends on before anything
table-specific — but treat it as a proposal, not a decision.

**High value, do next (works today with zero table/cart concept required):**
- #19 Refunds/returns as a real reversal — `voidSale()` currently hard-deletes
  the order; replace with a non-destructive refund record so there's an
  audit trail
- #20 Reorder rules — low-stock flagging exists on the dashboard, so
  generating actual reorder suggestions from it is a small, additive step
- #16 Customer loyalty — the `customers` link already exists; add
  points/visit tracking on top of it

**Foundational, needed before most of the rest of the Odoo checklist makes
sense here:**
- A real multi-item sale cart (today's `submitSale()` is one product per
  sale) — #4 split payment, #9 tips, and #3 bill splitting all assume a cart
  with multiple lines and a running total
- #1 Floor plan / table map, if table service is confirmed in scope — nothing
  in #2, #5, #6, #7, #13, #14, or #17 can exist without a table concept first
- #18 Cashier session — straightforward once there's a cart/checkout flow to
  gate

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

"Shortcut" here means *smallest safe increment*, not *skip the safety
checks*. Each step below is scoped to be shippable and testable on its own.
**This plan is rewritten from scratch against what's actually in
`index.html`** — the previous version assumed several of these (session,
restock-on-refund reuse, `table_id`) already existed as building blocks, and
they don't.

### Step 1 — Refunds/returns as a real reversal
- Replace (or supplement) `voidSale()`'s hard delete with a non-destructive
  path: either an order `status: 'refunded'` value or a `refund_of_order_id`
  link on `orders`, so the original sale record survives.
- Reuse the existing restock logic already in `voidSale()` (it deducts back
  into `products.stock_qty` and logs a `stock_movements` row with
  `reason: "sale_voided"`) — adapt the reason string, don't duplicate the
  logic.
- Decide with the person whether partial (per-line) refunds are in scope for
  v1, or whether whole-order refund is enough to start.

### Step 2 — Reorder suggestions from existing low-stock data
- The dashboard already computes `stock_qty <= low_stock_threshold` per
  product — surface that same set as a "suggested reorder" list on the
  Purchase Orders tab, pre-filling a draft PO the user can edit before
  submitting via the existing `submitPurchase()` path.
- Purely additive UI on top of data that already exists; no schema change
  needed for a first version.

### Step 3 — Multi-item sale cart (foundation for tips/splitting/session)
- This is the real unlock: replace the single-line `submitSale()` flow with
  a cart that holds multiple `order_items` under one `orders` row before
  checkout.
- Get this reviewed and confirmed with the person before starting — it
  touches the core sale-completion path, so treat it like the "every change
  to `completePayment`, stock consumption, or order status transitions"
  guidance in §7: happy path, then edge cases (partial data, double-submit).

### Step 4 — Cashier session (once a checkout flow exists to gate)
- New `pos_sessions` table: `opened_by`, `opened_at`, `opening_cash`,
  `closed_by`, `closed_at`, `closing_cash`, `expected_cash`, `business_id`.
- Gate checkout behind an open session, opt-in via a setting first (per
  ground rule #7), default-on once tested.
- Close-out screen reconciles `expected_cash` vs. `closing_cash`, flags
  variance.

### Step 5 — Confirm table-service scope, then re-audit
Before building #1 (floor plan), #2 (transfer/merge), #6 (KDS), or #7
(kitchen notes): confirm with the person whether table service is actually
in scope (see the note at the top of §5). If yes, floor plan (`tables` table
+ `table_id` on `orders`) is the prerequisite for nearly everything else in
the checklist and deserves its own dedicated planning pass, not a bullet
here. If no, drop those rows from future audits rather than re-flagging them
as gaps every time.

### Step 6 onward
Re-run the audit (§2) against the updated codebase, re-derive §4 (don't
copy-paste it), re-prioritize §5 with the person, and repeat.

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

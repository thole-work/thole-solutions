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
is used, since the codebase moves. As of the last audit:

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | Floor plan / table map | ✅ Built | `restaurant_tables`, table-map modal |
| 2 | Table transfer/merge | ⬜ Missing | No transfer/merge function found |
| 3 | Bill splitting (by item) | 🟡 Partial | "Split bill" exists but confirm whether it splits by *item* into a real sub-order, or is closer to #4 |
| 4 | Split payment (by method) | ✅ Built | Multi-line payment UI, one `payments` row per method |
| 5 | Course management | ⬜ Missing | |
| 6 | Kitchen/bar printers or KDS | 🟡 Partial | Real-time KDS with sound alerts exists (now on its own Kitchen tab); no bar-specific routing, no physical printer integration |
| 7 | Per-line kitchen notes | ⬜ Missing (verify) | |
| 8 | Early/bill-only printing | 🟡 Partial | Receipt printing exists post-payment; confirm whether a pre-payment "print bill" exists |
| 9 | Tips | ✅ Built | Tip buttons + custom tip in payment modal |
| 10 | Offline mode | ✅ Built | `localStorage` queue, syncs on `online` event |
| 11 | Ingredient-level stock via BOM | 🟡 Partial, intentionally disabled | `recipe_items` linkage exists; consumption gated off via `recipe_consumes_materials` setting, feeding from kitchen stock when re-enabled |
| 12 | Combo meals | ⬜ Missing (verify) | |
| 13 | QR-code table ordering | ⬜ Missing | |
| 14 | Table reservations | ⬜ Missing (verify — table status may include "reserved") | |
| 15 | Self-service kiosk mode | ⬜ Missing | |
| 16 | Customer identification / loyalty | 🟡 Partial | `customers` table exists, linked to orders/payments; confirm loyalty tracking |
| 17 | Dine-in/takeout/delivery presets | ⬜ Missing (verify) | |
| 18 | Cashier session (open/close till) | ⬜ Missing | Flagged in an earlier session |
| 19 | Refunds/returns | ⬜ Missing | Flagged in an earlier session |
| 20 | Purchasing / reorder rules | 🟡 Partial | Purchase orders exist; auto-reorder-suggestion logic not confirmed |

**Before acting on this table, re-run the grep audit** — statuses marked
"(verify)" have not been confirmed against the live file and may already
exist.

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

A reasonable ranking for a single-location-to-small-chain restaurant (adjust
with the person, don't assume):

**High value, do next:**
- #18 Cashier session (open/close till) — cash accountability gap
- #19 Refunds/returns — currently no safe way to reverse a bad sale
- #7 Per-line kitchen notes — cheap, high daily-use value
- #2 Table transfer/merge — common real-world need (parties move, tables combine)

**Medium value, do after the above:**
- #3 Bill splitting by item (verify current behavior first — may already be
  close)
- #8 Early/bill-only printing
- #17 Service-type presets (dine-in/takeout/delivery)

**Lower priority / bigger lift — revisit once the above is stable:**
- #5 Course management
- #12 Combo meals
- #13 QR-code ordering
- #15 Self-service kiosk
- #14 Table reservations
- #20 Automated reorder rules

**Explicitly deferred by design (already decided):**
- #11 Ingredient-level BOM consumption — intentionally disabled until recipes
  are ready to reconnect; don't re-enable as a side effect of another feature.

---

## 6. Shortcut plan (safe execution order)

"Shortcut" here means *smallest safe increment*, not *skip the safety
checks*. Each step below is scoped to be shippable and testable on its own.

### Step 1 — Cashier session
- New `pos_sessions` table: `opened_by`, `opened_at`, `opening_cash`,
  `closed_by`, `closed_at`, `closing_cash`, `expected_cash`,
  `business_id`.
- Require an open session before the table map / cart is usable (soft
  gate — don't lock out existing flows if no session concept existed
  before; make it opt-in via a setting first, then default-on once tested).
- Close-out screen reconciles `expected_cash` (opening + cash payments -
  cash refunds) vs. `closing_cash`, flags variance.

### Step 2 — Refunds/returns
- New order status or a `refund_of_order_id` link on `orders`.
- Restock logic mirrors the void-sale path already built (see
  `recipeConsumesMaterials()` gated restock for recipe items, direct restock
  for `resale` items) — reuse it, don't duplicate it.
- Refund payment record: negative `payments` row, `direction: 'out'`.

### Step 3 — Per-line kitchen notes
- Add `notes` text column to `order_items` (nullable, additive).
- Cart UI: small note field per line item.
- KDS ticket rendering: show the note, don't print it on the customer
  receipt.

### Step 4 — Table transfer/merge
- Transfer: update `orders.table_id` to the new table, free the old one.
- Merge: reassign all `order_items` from table B's order to table A's order,
  close table B's order, free table B.
- Guard: block merge/transfer onto a table that already has an active order,
  unless explicitly merging.

### Step 5 onward
Re-run the audit (§2) against the updated codebase, re-prioritize §5 with
the person, and repeat.

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

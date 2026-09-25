# Task 4 — Match the UI gate to the database gate

## Goal
Now that Task 3's RLS is live, uncomment the matching lines in `app.js`
so owners can actually toggle `pos`/`crm`/`finance`/`procurement` off per
business and have the tab disappear along with the write access.

## Requires
Task 3 done and verified.

## Files to touch
- `app.js` only — the `TAB_MODULES` constant (search for
  `MODULE-BASED WORKSPACE GATING` to find it)

## Do NOT touch
- Anything else in `app.js`, no other file

## Exact change
Find this block in `app.js`:

```js
const TAB_MODULES = {
  kitchen: "kitchen",              // restaurant_tables, dine_in, KDS
  materials: "inventory",          // raw_materials, recipe_items
  "stock-movements": "inventory",  // stock_movements
  efficiency: "production",        // produce_batches, waste_log, labor_shifts
  // Business-growth gates — uncomment once business_type_modules is seeded
  // for every type (the seed file already assigns them):
  //   sales: "pos",                      // orders, order_items
  //   customers: "crm", suppliers: "crm",// customers, suppliers
  //   payments: "finance", expenses: "finance", reports: "finance",
  //   purchases: "procurement",          // purchase_orders
};
```

Replace the commented block with the uncommented version:

```js
const TAB_MODULES = {
  kitchen: "kitchen",              // restaurant_tables, dine_in, KDS
  materials: "inventory",          // raw_materials, recipe_items
  "stock-movements": "inventory",  // stock_movements
  efficiency: "production",        // produce_batches, waste_log, labor_shifts
  sales: "pos",                      // orders, order_items
  customers: "crm", suppliers: "crm",// customers, suppliers
  payments: "finance", expenses: "finance", reports: "finance",
  purchases: "procurement",          // purchase_orders
};
```

That's the entire change — one constant, no logic edits needed, since
`tabEnabled()` already reads from this map.

## Verification
Follow `05-verification-checklist.md`. Since every business type
currently has all 4 of these modules assigned (per
`business_type_modules_seed.sql`), **no tab should actually disappear for
any existing business** — this step only wires up the toggle mechanism
for the future. If any tab vanishes unexpectedly, that means a business's
`business_type_modules` row is missing, not that this change is wrong —
report it rather than reverting.

Commit as: `frontend: enable pos/crm/finance/procurement tab gating`

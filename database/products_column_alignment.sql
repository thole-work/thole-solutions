-- ============================================================================
-- PRODUCTS COLUMN ALIGNMENT MIGRATION
-- Companion to: database/database map.txt (validated 2026-08-23)
--
-- RESULT OF MAP VALIDATION (static cross-check of index.html vs map):
--   All 16 tables queried by the UI exist and match the map          ✅
--   products.sku        -> used by UI (product form p-sku field,
--                          duplicate-product insert)  MISSING IN DB ❌
--   products.cost_price -> used by UI (product form, duplicate-product
--                          insert, produce-batch cost math) MISSING IN DB ❌
--
-- CONCLUSION: run this once in the Supabase SQL Editor to bring the live
-- schema in line with database map.txt. Idempotent — safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. ADD MISSING COLUMNS (idempotent)
-- ----------------------------------------------------------------------------

alter table public.products
  add column if not exists sku text;

alter table public.products
  add column if not exists cost_price numeric;

-- Notes:
--   * Both columns are nullable — matches the UI, which sends null when the
--     fields are left empty (index.html submitProduct / duplicateProduct).
--   * No default and no NOT NULL: existing rows must keep working as-is.
--   * RLS is unchanged: policies are per-table, new columns inherit them.

-- ----------------------------------------------------------------------------
-- 2. VERIFY (run after the ALTERs — expected: both rows present)
-- ----------------------------------------------------------------------------

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'products'
  and column_name in ('sku', 'cost_price')
order by column_name;

-- ----------------------------------------------------------------------------
-- 3. OPTIONAL (deferred): enforce uniqueness of sku per business.
--    NOT applied now — the UI currently permits duplicate/empty SKUs and a
--    hard constraint would break existing flows. Revisit with app changes:
--
-- create unique index if not exists products_business_sku_key
--   on public.products (business_id, sku)
--   where sku is not null;
-- ============================================================================

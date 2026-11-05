-- =============================================================================
-- 20261105000000_categories_access_and_supplier_order_number.sql
-- =============================================================================
--
-- STATUS (when written, 2026-11-05): NOT APPLIED to any real Supabase project.
--   Applying it to the Health Center project needs separate, explicit
--   authorization from the project owner. It has only been run against
--   throwaway local PostgreSQL databases, by supabase/tests/run.sh.
--
-- WHY
--   1. Categories do not persist.
--      On the deployed database, row level security (RLS) is ENABLED on
--      public.categories but NO policy exists on it. The app uses the anon key,
--      so reading categories returns an empty list with HTTP 200 (no error)
--      and creating one fails with SQLSTATE 42501.
--      This migration adds the two policies the app needs, both for role anon:
--        - SELECT  (the category list, and joining items to their category)
--        - INSERT  (the "+ Create new category" field)
--      INSERT alone is not enough: the app reads the new row back with
--      INSERT ... RETURNING, which also needs the SELECT policy.
--      UPDATE and DELETE are deliberately NOT granted: the app never renames
--      or deletes categories.
--   2. Supplier ordering number.
--      Adds medications.supplier_order_number, the number a supplier uses when
--      ordering an item, typed in by staff. It is TEXT, so leading zeros,
--      letters and punctuation survive exactly as typed. It is separate from
--      the barcode and from the item name. It is nullable: existing items stay
--      NULL and the app shows them as "Not set".
--
-- WHAT IT DOES NOT DO (supabase/tests/run.sh checks each of these)
--   - It does not enable or disable row level security on any table.
--   - It does not change any column type, constraint, index, trigger or function.
--   - It does not insert, update, delete, rename or merge any row.
--   - It does not touch the policies on medications or transactions.
--   - It does not grant or revoke any privilege (see BEFORE YOU APPLY below).
--   - It works whether categories.id is uuid (the Health Center database) or
--     bigint (supabase/schema.sql): no id type is mentioned anywhere below.
--
-- SAFE TO RE-RUN
--   Additive and idempotent. The column uses ADD COLUMN IF NOT EXISTS and each
--   policy is created only when a policy with that name does not exist yet, so
--   a second run changes nothing (it only prints a "skipping" notice).
--   A column of that name that already exists must already be text. Any other
--   type (an integer column would turn '0092' into 92) stops the migration with
--   an error before anything is changed: the migration never alters a column,
--   so it cannot repair one. Only the type is checked: the nullability and
--   default of an existing text column are left as they are (the app expects
--   NULL to mean "Not set"). The column comment is set only while the column
--   has none, so a comment someone wrote is never overwritten.
--   Everything runs in one transaction: it fully applies or not at all.
--   lock_timeout makes it give up after 5 seconds instead of queueing behind a
--   long-running query and stalling the app; just run it again in that case.
--
-- DEPLOY ORDER
--   The app works both before and after this migration: it never lists
--   supplier_order_number in a select list, and it reports a clear message if
--   the column is missing. Categories only become usable once the policies
--   exist.
--
-- BEFORE YOU APPLY (read-only: it only reads the catalog)
--   The policies and the column are all this migration adds. It deliberately
--   issues no GRANT, so it only fixes categories if anon already holds the
--   plain table privileges. Supabase gives anon those on every new table by
--   default, but a project can have revoked them. If it has, saving a category
--   keeps failing even after this migration succeeds. Both cases are SQLSTATE
--   42501, so the code alone cannot tell them apart; the message can (the app's
--   error response carries it in its "detail" field):
--     new row violates row-level security policy for table "categories"
--         the missing policy: this migration fixes it.
--     permission denied for table categories
--         a missing privilege: this migration does not fix it.
--   Run the query below on the target project before applying.
--   supabase/tests/run.sh executes this exact block, so it cannot silently rot.
--
-- <precheck-sql>
--   select c.relrowsecurity                                    as rls_enabled,
--          has_table_privilege('anon', c.oid, 'SELECT')        as anon_can_select,
--          has_table_privilege('anon', c.oid, 'INSERT')        as anon_can_insert,
--          has_sequence_privilege('anon', pg_get_serial_sequence('public.categories', 'id'), 'USAGE')
--                                                              as anon_can_use_id_sequence
--     from pg_class c
--    where c.oid = 'public.categories'::regclass;
-- </precheck-sql>
--
--   Expected with Supabase's default privileges and uuid ids (Health Center):
--     true | true | true | (empty)
--   Expected with bigint ids (supabase/schema.sql):  true or false | true | true | true
--     rls_enabled              true: the policies below take effect.
--                              false: RLS is off on categories. anon already has
--                              full table access and these policies are not
--                              enforced (see supabase/rls.sql, section 4).
--     anon_can_select          must be true.
--     anon_can_insert          must be true.
--     anon_can_use_id_sequence true, or empty when the ids have no sequence
--                              (uuid ids). false means that with bigint ids
--                              creating a category fails with "permission
--                              denied for sequence categories_id_seq".
--   If a value that must be true is false, do not count on this migration to fix
--   categories. Granting the privilege is a separate change that needs its own
--   explicit authorization, for example:
--     grant select, insert on public.categories to anon;
--     grant usage on sequence public.categories_id_seq to anon;   -- bigint ids only
--   It stays inside the SELECT/INSERT limit above, but it is not part of this file.
--
-- HOW TO APPLY (only once authorized)
--   Paste this file into the Supabase SQL Editor and run it, or use the
--   Supabase CLI (supabase db push). The last statement asks PostgREST to
--   reload its schema cache so the new column is visible to the API straight
--   away.
--
-- HOW TO CHECK IT WORKED (read-only)
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'medications'
--      and column_name = 'supplier_order_number';          -- one row: text, YES
--   select policyname, cmd, roles from pg_policies
--    where schemaname = 'public' and tablename = 'categories';  -- SELECT + INSERT, {anon}
--
-- HOW TO ROLL BACK
--   Run the SQL between the <rollback-sql> markers below.
--   Read this first:
--     - Dropping the column DELETES every supplier order number staff entered
--       since the migration. Export them first if any exist:
--         select id, barcode, supplier_order_number from public.medications
--          where supplier_order_number is not null;
--     - Dropping the policies brings the "categories do not persist" defect
--       back. On a database whose policies came from supabase/rls.sql (not from
--       this migration) do NOT drop them.
--   supabase/tests/run.sh extracts and executes this exact block, so it cannot
--   silently rot.
--
-- <rollback-sql>
--   begin;
--   drop policy if exists "anon: read categories"   on public.categories;
--   drop policy if exists "anon: insert categories" on public.categories;
--   alter table public.medications drop column if exists supplier_order_number;
--   notify pgrst, 'reload schema';
--   commit;
-- </rollback-sql>
-- =============================================================================

begin;

set local lock_timeout = '5s';

-- 1) Supplier ordering number: nullable text, no default, no constraint.
--    First refuse a same-named column of another type. ADD COLUMN IF NOT EXISTS
--    would skip it without a word and staff would then type codes into, say, an
--    integer column that drops their leading zeros. This only reads the catalog.
do $$
declare
  existing_type text;
begin
  select format_type(a.atttypid, a.atttypmod)
    into existing_type
    from pg_attribute a
   where a.attrelid = 'public.medications'::regclass
     and a.attname = 'supplier_order_number'
     and a.attnum > 0
     and not a.attisdropped
     and a.atttypid <> 'text'::regtype;
  if existing_type is not null then
    raise exception 'medications.supplier_order_number already exists as %, but it must be text so that leading zeros and letters survive. Nothing was changed. Fix that column yourself, then run this migration again.', existing_type
      using errcode = '42804';
  end if;
end
$$;

alter table public.medications
  add column if not exists supplier_order_number text;

-- Describe the column, unless a comment is already there: one that someone else
-- wrote is never overwritten.
do $$
declare
  col_attnum smallint;
begin
  select a.attnum into col_attnum
    from pg_attribute a
   where a.attrelid = 'public.medications'::regclass
     and a.attname = 'supplier_order_number'
     and not a.attisdropped;
  if col_description('public.medications'::regclass, col_attnum) is null then
    comment on column public.medications.supplier_order_number is
      'Supplier ordering number entered manually by staff. Free text (leading zeros, letters, punctuation preserved). Distinct from barcode.';
  end if;
end
$$;

-- 2) Categories access: SELECT + INSERT for anon only. The existence check by
--    policy name is what makes a re-run a no-op. Row level security itself is
--    deliberately left as it is on every table.
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'categories'
       and policyname = 'anon: read categories'
  ) then
    create policy "anon: read categories" on public.categories
      for select to anon using (true);
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'categories'
       and policyname = 'anon: insert categories'
  ) then
    create policy "anon: insert categories" on public.categories
      for insert to anon with check (true);
  end if;
end
$$;

-- 3) Make PostgREST pick up the new column immediately (delivered on commit).
notify pgrst, 'reload schema';

commit;

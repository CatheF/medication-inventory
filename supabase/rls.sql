-- =============================================================
-- MedInventory — Row Level Security
-- Paste this entire file into the Supabase SQL Editor and run it.
-- Run AFTER schema.sql if setting up fresh, or run standalone
-- on an existing database.
-- =============================================================


-- ── 1. Enable RLS on both tables ─────────────────────────────
--
-- Once enabled, ALL access is denied by default until a policy
-- explicitly permits it. The policies below restore exactly the
-- access the app needs via the publishable (anon) key.

ALTER TABLE medications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;


-- ── 2. medications policies ───────────────────────────────────
--
-- The dashboard, admin, scanner, and report pages all read and
-- write medications directly using the anon key.
--
-- Operations needed:
--   SELECT — dashboard list, barcode lookup, admin list, report
--   INSERT — admin "Add Medication", CSV import
--   UPDATE — admin "Edit Medication", CSV import (upsert)
--   DELETE — admin "Delete Medication"

CREATE POLICY "anon: read all medications"
  ON medications
  FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "anon: insert medications"
  ON medications
  FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "anon: update medications"
  ON medications
  FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "anon: delete medications"
  ON medications
  FOR DELETE
  TO anon
  USING (true);


-- ── 3. transactions policies ──────────────────────────────────
--
-- SELECT is needed by the report page and the transaction history
-- endpoint. INSERT is handled inside record_transaction(), which
-- is SECURITY DEFINER and therefore runs as the function owner
-- (postgres), bypassing RLS entirely — no INSERT policy is needed
-- on this table for the scanner to work.
--
-- ON DELETE CASCADE (when a medication is deleted) also runs as
-- postgres internally, so no DELETE policy is needed here either.

CREATE POLICY "anon: read all transactions"
  ON transactions
  FOR SELECT
  TO anon
  USING (true);


-- ── 4. RPC function execute permission ───────────────────────
--
-- record_transaction() is SECURITY DEFINER, so its body runs as
-- postgres and ignores RLS. But the anon role still needs EXECUTE
-- permission to call the function in the first place. Without this,
-- supabase.rpc("record_transaction", ...) will return a 403.

GRANT EXECUTE ON FUNCTION record_transaction(BIGINT, TEXT, INTEGER, TEXT) TO anon;


-- ── Summary of what this achieves ────────────────────────────
--
-- BEFORE these policies: enabling RLS locks out all anon access,
-- breaking every page in the app.
--
-- AFTER these policies:
--   Dashboard    ✓  reads medications (SELECT)
--   Admin        ✓  reads, creates, edits, deletes medications
--   Scanner      ✓  looks up barcode (SELECT), calls record_transaction RPC
--   Report       ✓  reads medications + transactions (SELECT)
--   CSV import   ✓  upserts medications (INSERT + UPDATE)
--
-- The anon key (publishable key) is intentionally allowed full
-- CRUD on medications because this is an internal staff tool with
-- no per-user data isolation. If you add Supabase Auth later,
-- replace USING (true) / WITH CHECK (true) with auth.uid()-based
-- expressions to scope access per user or role.

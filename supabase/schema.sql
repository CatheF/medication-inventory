-- =============================================================
-- MedInventory — Supabase Schema
-- Paste this entire file into the Supabase SQL Editor and run it.
-- For EXISTING databases, skip to the migration block at the bottom.
-- =============================================================

-- ── Tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS categories (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS medications (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT,
  barcode     TEXT UNIQUE NOT NULL,
  photo_url   TEXT,
  stock       INTEGER NOT NULL DEFAULT 0,
  threshold   INTEGER NOT NULL DEFAULT 10,
  vendor_url  TEXT,
  unit        TEXT NOT NULL DEFAULT 'units',
  notes       TEXT,
  category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
  is_unnamed  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id              BIGSERIAL PRIMARY KEY,
  medication_id   BIGINT NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('receive', 'dispense')),
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_medications_barcode         ON medications (barcode);
CREATE INDEX IF NOT EXISTS idx_medications_category        ON medications (category_id);
CREATE INDEX IF NOT EXISTS idx_medications_unnamed         ON medications (is_unnamed) WHERE is_unnamed = true;
CREATE INDEX IF NOT EXISTS idx_transactions_medication_id  ON transactions (medication_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at     ON transactions (created_at);

-- ── Auto-update updated_at ────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_medications_updated_at ON medications;
CREATE TRIGGER trg_medications_updated_at
  BEFORE UPDATE ON medications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Atomic transaction recording ─────────────────────────────
-- Called by the /api/transactions POST endpoint.
-- Checks stock, inserts the transaction row, and updates stock
-- atomically inside a single database transaction.

CREATE OR REPLACE FUNCTION record_transaction(
  p_medication_id BIGINT,
  p_type          TEXT,
  p_quantity      INTEGER,
  p_note          TEXT DEFAULT NULL
)
RETURNS SETOF medications
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_stock INTEGER;
  v_delta INTEGER;
BEGIN
  -- Lock the row so concurrent requests don't race
  SELECT stock INTO v_stock
  FROM medications
  WHERE id = p_medication_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Medication not found';
  END IF;

  IF p_type = 'dispense' AND v_stock < p_quantity THEN
    RAISE EXCEPTION 'Insufficient stock. Current stock: %', v_stock;
  END IF;

  v_delta := CASE WHEN p_type = 'receive' THEN p_quantity ELSE -p_quantity END;

  INSERT INTO transactions (medication_id, type, quantity, note)
  VALUES (p_medication_id, p_type, p_quantity, p_note);

  UPDATE medications
  SET stock = stock + v_delta
  WHERE id = p_medication_id;

  RETURN QUERY
  SELECT * FROM medications WHERE id = p_medication_id;
END;
$$;

-- =============================================================
-- MIGRATION — run this block if upgrading an existing database
-- that was created before categories and is_unnamed were added.
-- =============================================================
--
-- ALTER TABLE medications
--   ADD COLUMN IF NOT EXISTS category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
--   ADD COLUMN IF NOT EXISTS is_unnamed   BOOLEAN NOT NULL DEFAULT false;
--
-- CREATE INDEX IF NOT EXISTS idx_medications_category ON medications (category_id);
-- CREATE INDEX IF NOT EXISTS idx_medications_unnamed  ON medications (is_unnamed) WHERE is_unnamed = true;
--
-- -- Allow medications to be saved without a name (barcode is the only required field):
-- ALTER TABLE medications ALTER COLUMN name DROP NOT NULL;

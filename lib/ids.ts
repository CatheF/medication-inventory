// Identifier helpers. Category ids are OPAQUE strings: the live database uses UUIDs, supabase/schema.sql uses
// bigint. Never call Number() on them — Number("<uuid>") is NaN, which JSON.stringify turns into null
// (that is exactly how category assignments were being silently dropped).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_RE = /^[0-9]{1,18}$/;
const MEDICATION_ID_RE = /^[1-9][0-9]{0,14}$/;

export type ParsedId = { ok: true; value: string | null } | { ok: false; reason: string };

const INVALID_CATEGORY = "Category id must be a UUID or a positive whole number.";

/**
 * Validates a category id coming from a client. Empty / null / undefined mean "no category".
 * Accepts a UUID string (returned lowercased), a digit string (leading zeros stripped, "0" rejected),
 * or a positive safe integer. Everything else (NaN, "NaN", "undefined", objects, floats…) is rejected.
 */
export function parseCategoryId(input: unknown): ParsedId {
  if (input === null || input === undefined) return { ok: true, value: null };

  if (typeof input === "string") {
    const s = input.trim();
    if (s === "") return { ok: true, value: null };
    if (UUID_RE.test(s)) return { ok: true, value: s.toLowerCase() };
    if (DIGITS_RE.test(s)) {
      const stripped = s.replace(/^0+/, "");
      return stripped === "" ? { ok: false, reason: INVALID_CATEGORY } : { ok: true, value: stripped };
    }
    return { ok: false, reason: INVALID_CATEGORY };
  }

  if (typeof input === "number") {
    return Number.isSafeInteger(input) && input > 0
      ? { ok: true, value: String(input) }
      : { ok: false, reason: INVALID_CATEGORY };
  }

  return { ok: false, reason: INVALID_CATEGORY };
}

/** Normalizes a database id (uuid string or bigint number) to a string; null/undefined/non-finite → null. */
export function toIdString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  return null;
}

/** Null-safe id equality ("3" equals 3; UUIDs compare case-insensitively; null equals null). */
export function sameId(a: unknown, b: unknown): boolean {
  const x = toIdString(a);
  const y = toIdString(b);
  if (x === null || y === null) return x === y;
  return x.toLowerCase() === y.toLowerCase();
}

/**
 * Comparison key for a category id: String() equality, trimmed and lower-cased (UUIDs are case-insensitive), blank and
 * non-finite numbers = null. The view logic (lib/inventory-view.ts), the filter chips (lib/filter-chips.ts) and the Inventory
 * components all compare category ids through this one rule, so they cannot disagree about which items belong together.
 * It never folds accents or look-alike forms the way search text is folded (lib/search-text.ts): an id is an identity.
 */
export function idKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const key = String(value).trim().toLowerCase();
  return key === "" ? null : key;
}

/** Parses a medication id from a route param or number. Returns null when it is not a positive safe integer. */
export function parseMedicationId(input: unknown): number | null {
  if (typeof input === "number") {
    return Number.isSafeInteger(input) && input > 0 ? input : null;
  }
  if (typeof input === "string") {
    const s = input.trim();
    return MEDICATION_ID_RE.test(s) ? Number(s) : null;
  }
  return null;
}

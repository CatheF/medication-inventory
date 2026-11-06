// Pure order-sheet logic: quantity/unit normalization and joining the staff's rows to the inventory.
// No React, no I/O, no database access. Type-only import of Medication so this module never pulls in the
// Supabase client (lib/db.ts throws at import time when its environment variables are missing).

import type { Medication } from "../db";
import { ORDER_SHEET_LIMITS } from "./types";
import type { BuiltSheet, SheetOptions, SheetRow, SheetRowInput } from "./types";

// ── Text helpers (shared by the draft store, the export route and the XLSX writer) ───────────────────────────────

/** Truncates to at most `max` Unicode code points (never splits a surrogate pair). Cheap for huge inputs. */
export function clampText(input: string, max: number): string {
  if (input.length <= max) return input; // N UTF-16 units can never be more than N code points
  let out = "";
  let count = 0;
  for (const ch of input) {
    if (count >= max) break;
    out += ch;
    count += 1;
  }
  return out;
}

/** True when `input` has more than `max` Unicode code points. */
export function exceedsLength(input: string, max: number): boolean {
  if (input.length <= max) return false;
  return Array.from(input).length > max;
}

// C0 and C1 control characters (includes tab, CR, LF, DEL) plus the Unicode line and paragraph separators.
// Written as numeric ranges, not a regex literal: some tooling rewrites \u escapes inside regex literals.
function isControlCodePoint(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029;
}

// ── Quantity and unit ─────────────────────────────────────────────────────────────────────────────────────────────

export type NormalizedQty = { ok: true; value: string } | { ok: false; reason: string };

/**
 * The largest order quantity as people read it (nine 9s with thousands separators). Built from the number of digits in
 * ORDER_SHEET_LIMITS (the one place the limit is defined), so no message can ever name a different limit than the rule enforces.
 */
export const MAX_QTY_TEXT: string = "9".repeat(ORDER_SHEET_LIMITS.qtyDigits).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const QTY_REASON = `Order quantity must be a whole number from 1 to ${MAX_QTY_TEXT} (digits only), or left blank.`;
const DIGITS_ONLY = /^[0-9]+$/;

/** The digits of an already trimmed, digits-only quantity without the zeros in front ("" when it was zero). */
function withoutLeadingZeros(digits: string): string {
  return digits.replace(/^0+/, "");
}

/**
 * True for a quantity that is only digits but has more of them than the largest quantity (zeros in front do not count). It is
 * not malformed, it is too big: the page says so instead of telling the person to "use digits only".
 */
export function isQtyTooLarge(input: string): boolean {
  if (typeof input !== "string") return false;
  const trimmed = input.trim();
  return DIGITS_ONLY.test(trimmed) && withoutLeadingZeros(trimmed).length > ORDER_SHEET_LIMITS.qtyDigits;
}

/**
 * Normalizes what staff typed into the "Order quantity" box.
 *  - Surrounding whitespace is ignored. Blank is valid: staff may fill the quantity in by hand after printing.
 *  - Otherwise digits only; leading zeros are stripped ("007" becomes "7"); the number must be 1 up to the largest quantity.
 *  - Decimals, negatives, signs, separators, letters, "0" and everything else are rejected (never "fixed" silently).
 */
export function normalizeQty(input: string): NormalizedQty {
  if (typeof input !== "string") return { ok: false, reason: QTY_REASON };
  const trimmed = input.trim();
  if (trimmed === "") return { ok: true, value: "" };
  if (!DIGITS_ONLY.test(trimmed)) return { ok: false, reason: QTY_REASON };
  const stripped = withoutLeadingZeros(trimmed);
  // "" means the value was zero. More digits than the largest quantity has is above the maximum (checked by length, never by Number()).
  if (stripped === "" || stripped.length > ORDER_SHEET_LIMITS.qtyDigits) return { ok: false, reason: QTY_REASON };
  return { ok: true, value: stripped };
}

/**
 * Normalizes the free-text "Order unit" (box, case, pack…): control characters and line breaks become a space,
 * the ends are trimmed, nothing else is collapsed, and the result is cut to 40 characters.
 * The unit is whatever staff typed; it is never converted to or from the stock unit.
 */
export function normalizeUnit(input: string): string {
  if (typeof input !== "string") return "";
  let replaced = "";
  for (const ch of input) {
    replaced += isControlCodePoint(ch.codePointAt(0) ?? 0) ? " " : ch;
  }
  return clampText(replaced.trim(), ORDER_SHEET_LIMITS.unit).trimEnd();
}

// ── Building the sheet ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Joins the staff's rows to the inventory and produces exactly the rows that will be printed / exported.
 *  - Input order is kept. Duplicate ids: the first wins, later ones are reported once each in duplicateIds.
 *  - Ids that are not in `items` are reported in missingIds and are NOT emitted.
 *  - `n` is the 1-based position among the emitted rows.
 *  - An invalid typed quantity becomes "" and its id is reported in invalidQtyIds.
 *  - Unnamed items get a visible fallback name (nameIsFallback = true). The supplier order number is the stored
 *    value (trimmed) or null; it is never inferred from the barcode or the name.
 *  - `onHand` / `stockUnit` are read-only copies of the stock and are never mixed with `qty` / `unit`.
 *  - A `name` on an input row (the draft's remembered item name) is display text for the builder page only: it is ignored
 *    here. Names on the sheet always come from `items`, so the printed sheet and the Excel file can never show a stale one.
 */
export function buildSheet(
  items: readonly Medication[],
  inputs: readonly SheetRowInput[],
  options: SheetOptions
): BuiltSheet {
  const byId = new Map<number, Medication>();
  for (const item of items) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }

  const seen = new Set<number>();
  const rows: SheetRow[] = [];
  const missingIds: number[] = [];
  const duplicateIds: number[] = [];
  const invalidQtyIds: number[] = [];

  for (const input of inputs) {
    if (seen.has(input.id)) {
      if (!duplicateIds.includes(input.id)) duplicateIds.push(input.id);
      continue;
    }
    seen.add(input.id);

    const item = byId.get(input.id);
    if (!item) {
      missingIds.push(input.id);
      continue;
    }

    const qty = normalizeQty(input.qty);
    if (!qty.ok) invalidQtyIds.push(input.id);

    const barcode = typeof item.barcode === "string" ? item.barcode : String(item.barcode ?? "");
    const trimmedName = typeof item.name === "string" ? item.name.trim() : "";
    const supplier = typeof item.supplier_order_number === "string" ? item.supplier_order_number.trim() : "";

    rows.push({
      n: rows.length + 1,
      id: item.id,
      name: trimmedName !== "" ? trimmedName : `Unnamed item (barcode ${barcode})`,
      nameIsFallback: trimmedName === "",
      supplierOrderNumber: supplier !== "" ? supplier : null,
      qty: qty.ok ? qty.value : "",
      unit: normalizeUnit(input.unit),
      onHand: Number.isFinite(item.stock) ? item.stock : 0,
      stockUnit: typeof item.unit === "string" ? item.unit : "",
      barcode,
    });
  }

  return { options: { ...options }, rows, missingIds, duplicateIds, invalidQtyIds };
}

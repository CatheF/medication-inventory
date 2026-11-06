// The supplier's ordering number is free TEXT, entered manually by staff. It is distinct from the barcode.
// Leading zeros, letters and punctuation must survive exactly as typed — so it is never coerced to a number,
// never case-folded and never inferred from anything else.
//
// Characters that are invisible or change how the surrounding text is laid out (control characters, zero-width
// characters, direction marks and bidi embeddings/overrides/isolates, ...) are rejected: a code containing them reads
// differently on screen and on the printed sheet, so a human could never match it. See lib/text-safety.ts for the
// exact rule.
import { SUPPLIER_ORDER_NUMBER_MAX_LENGTH, exceedsLength } from "./limits";
import { hasInvisibleOrControlCharacter } from "./text-safety";

// The limit lives with the other size limits in lib/limits.ts; it is re-exported because the Admin form and the tests import
// it from here.
export { SUPPLIER_ORDER_NUMBER_MAX_LENGTH };

/**
 * The reason given when a code contains invisible or control characters. Exported so the Admin page can recognise this
 * exact rejection and show a "type it by hand" hint without matching on free text that someone might reword.
 */
export const SUPPLIER_ORDER_NUMBER_INVISIBLE_REASON =
  "Supplier order number can’t contain line breaks, tabs or other invisible control characters.";

export type ParsedSupplierOrderNumber = { ok: true; value: string | null } | { ok: false; reason: string };

/**
 * null / undefined / empty / whitespace-only → null (meaning "not set").
 * A string is trimmed at both ends only; internal characters, case and leading zeros are kept.
 * Non-strings (numbers, booleans, objects) are rejected rather than silently coerced.
 */
export function parseSupplierOrderNumber(input: unknown): ParsedSupplierOrderNumber {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== "string") {
    return { ok: false, reason: "Supplier order number must be text." };
  }

  const trimmed = input.trim();
  if (trimmed === "") return { ok: true, value: null };

  if (hasInvisibleOrControlCharacter(trimmed)) {
    return {
      ok: false,
      reason: SUPPLIER_ORDER_NUMBER_INVISIBLE_REASON,
    };
  }
  if (exceedsLength(trimmed, SUPPLIER_ORDER_NUMBER_MAX_LENGTH)) {
    return {
      ok: false,
      reason: `Supplier order number is too long (maximum ${SUPPLIER_ORDER_NUMBER_MAX_LENGTH} characters).`,
    };
  }
  return { ok: true, value: trimmed };
}

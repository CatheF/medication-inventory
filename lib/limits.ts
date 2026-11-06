// Size limits the API enforces on what staff (or anything else that can reach the API) send, in one place so the routes,
// the tests and the screens that explain a refusal quote the same numbers.
//
// Text lengths count Unicode code points, not UTF-16 units, so one emoji is one character everywhere. They are generous for
// real inventory data (the longest item name in the live data is 113 characters) and exist so that a request cannot store or
// return megabytes of text: every item is sent to every browser by GET /api/medications, so one huge field would slow down
// every screen for everybody.

/** A barcode as stored. Bounded, but far above anything a scanner reads, because a cap as low as 128 characters refused real codes. */
export const BARCODE_MAX_LENGTH = 1024;
export const NAME_MAX_LENGTH = 300;
export const NOTES_MAX_LENGTH = 5000;
export const VENDOR_URL_MAX_LENGTH = 2048;
export const PHOTO_URL_MAX_LENGTH = 2048;
export const UNIT_MAX_LENGTH = 40;
export const CATEGORY_NAME_MAX_LENGTH = 60;
export const SUPPLIER_ORDER_NUMBER_MAX_LENGTH = 64;

/**
 * The largest JSON request body the item and category routes read, in bytes. A legitimate request is a few kilobytes (all
 * the text fields together are under 20 KB); anything larger is refused with 413 before the body is read.
 */
export const MAX_JSON_BODY_BYTES = 1_000_000;

/** True when `text` has more than `max` Unicode code points. Cheap for the common case of a short string. */
export function exceedsLength(text: string, max: number): boolean {
  if (text.length <= max) return false; // a code point is at least one UTF-16 unit, so this many units cannot be too long
  if (text.length > max * 2) return true; // and at most two, so this many units must be too long
  return Array.from(text).length > max; // at most 2 * max units here, so this copy is small
}

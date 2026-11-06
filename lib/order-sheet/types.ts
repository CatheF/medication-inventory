// Shared types and limits for the supplier order sheet. Pure data: safe to import from server and client code.
//
// The order sheet is a *document staff prepare*. Nothing in this folder places an order, emails anyone or touches
// stock. Order quantity and order unit are typed by staff and are never calculated; they are kept strictly apart
// from the read-only on-hand stock (`onHand` / `stockUnit`).

export type PaperSize = "letter" | "a4";

/**
 * One sheet row exactly as staff typed it. `qty` and `unit` are plain strings; the draft never converts them.
 *
 * `name` is OPTIONAL and only ever exists in the browser-side draft: the last known name of the item, kept so that a row
 * whose item is deleted later can still say which item it was. It is display text for staff, nothing more: buildSheet()
 * ignores it (the printed sheet and the Excel file always use the inventory's current name), it is never sent to the
 * server, and a draft saved before it existed (no `name`) loads unchanged. At most ORDER_SHEET_LIMITS.name characters.
 */
export type SheetRowInput = { id: number; qty: string; unit: string; name?: string };

export type SheetOptions = {
  title: string;
  /** Calendar date, YYYY-MM-DD */
  date: string;
  preparedBy: string;
  notes: string;
  showOnHand: boolean;
  showBarcode: boolean;
};

export type SheetRow = {
  /** 1-based position among the rows that are actually emitted */
  n: number;
  id: number;
  /** Item name, or `Unnamed item (barcode …)` when the item has no name (see nameIsFallback) */
  name: string;
  nameIsFallback: boolean;
  /** The supplier's ordering number exactly as stored (trimmed); null when not set. Never inferred from anything else. */
  supplierOrderNumber: string | null;
  /** Normalized order quantity: "" (left blank) or digits without leading zeros */
  qty: string;
  /** Order unit as typed by staff (control characters removed, max 40 chars) */
  unit: string;
  /** Read-only copy of the current stock. Never mixed with qty. */
  onHand: number;
  /** Read-only copy of the item's stock unit. Never mixed with `unit`. */
  stockUnit: string;
  barcode: string;
};

export type BuiltSheet = {
  options: SheetOptions;
  rows: SheetRow[];
  /** Ids that were requested but are not in the inventory (they are NOT in rows) */
  missingIds: number[];
  /** Ids that appeared more than once in the input (only the first occurrence is used) */
  duplicateIds: number[];
  /** Ids whose typed quantity was not a valid quantity (their qty is "") */
  invalidQtyIds: number[];
};

/**
 * Length limits shared by the draft store, the UI inputs and the export API so the three can never disagree.
 * Lengths count Unicode code points, not UTF-16 units.
 */
export const ORDER_SHEET_LIMITS = {
  title: 120,
  preparedBy: 80,
  notes: 1000,
  unit: 40,
  /** The remembered item name of a draft row (display text only, see SheetRowInput) */
  name: 120,
  /**
   * How many digits the largest valid order quantity has (it is that many 9s). This is the ONLY definition of that limit: the
   * words that name it (MAX_QTY_TEXT in ./build) and the check in normalizeQty are both derived from it.
   */
  qtyDigits: 9,
  /**
   * The most characters the draft keeps of a typed quantity. Deliberately far above qtyDigits: a longer number is a mistake that
   * the page explains next to the box, and cutting it down to a valid-looking number would silently change what was meant. This
   * only stops an absurd paste from filling the stored draft.
   */
  qtyTyped: 40,
  /** Maximum number of rows on one sheet */
  rows: 500,
} as const;

// Pure helpers for the Order sheet page: wording, dates, the printed column plan. No React, no DOM, no fetch.

import type { Category, Medication } from "@/lib/db";
import { sameId } from "@/lib/ids";
import { MAX_QTY_TEXT, isQtyTooLarge, normalizeQty } from "@/lib/order-sheet/build";
import { MAX_SHEET_YEAR, MIN_SHEET_YEAR, isValidISODate } from "@/lib/order-sheet/draft";
import type { SheetOptions } from "@/lib/order-sheet/types";

export function pluralize(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * The words staff see wherever the inventory could not be loaded (Scan tab, Inventory tab, Order sheet and Admin say the
 * same): the title, then the reassurance line, then the server's own error text, then a Retry button. The same two texts
 * live in app/components/inventory/LoadErrorNotice.tsx; keep them identical.
 */
export const LOAD_ERROR_TITLE = "Couldn’t load the inventory";
export const LOAD_ERROR_REASSURANCE = "This does not mean the inventory is empty.";

/** The name staff see for an item. Same rule as buildSheet(): an unnamed item is shown with its barcode. */
export function displayName(item: Pick<Medication, "name" | "barcode">): string {
  const name = typeof item.name === "string" ? item.name.trim() : "";
  return name !== "" ? name : `Unnamed item (barcode ${item.barcode})`;
}

// ── Categories (display only; the sheet itself never uses them) ──────────────────────────────────────────────────

export type CategoryList = { status: "loading" } | { status: "error" } | { status: "ready"; categories: readonly Category[] };

/**
 * The category label shown next to a search result. Returns null while the categories are still loading (say
 * nothing rather than guess). An item whose category cannot be resolved is "Category unavailable", never
 * "Uncategorized": that label is only for items that really have no category.
 */
export function categoryLabel(item: Pick<Medication, "category_id">, list: CategoryList): string | null {
  if (item.category_id === null) return "Uncategorized";
  if (list.status === "loading") return null;
  if (list.status === "error") return "Category unavailable";
  const match = list.categories.find((category) => sameId(category.id, item.category_id));
  return match ? match.name : "Category unavailable";
}

// ── Quantity ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The line printed above the table while some typed quantity is not a valid number (see PrintSheet): Print / Save as PDF is
 * disabled in that state, but Ctrl/Cmd+P still prints the page, and the quantity cell of such a row is printed as "?".
 */
export const INVALID_QTY_PRINT_NOTE = "Some quantities are not valid numbers (marked ?). Fix them before using this sheet.";

/** "1 to <largest quantity>": the range of a valid order quantity, for the notes that say a quantity is not valid. */
export const QTY_RANGE_WORDS = `1 to ${MAX_QTY_TEXT}`;

/**
 * Explains why a typed order quantity is not valid (null when it is valid or blank). The text is never changed
 * for the person: this only describes the problem. normalizeQty() is the rule; this only words it.
 * A number that is only digits but longer than any valid quantity is called too large and names the limit: telling the person to
 * "use digits only" would be wrong, and the box keeps every digit that was pasted instead of cutting it down to a valid number.
 */
export function qtyProblem(typed: string): string | null {
  if (normalizeQty(typed).ok) return null;
  if (isQtyTooLarge(typed)) return `Too large. Enter ${MAX_QTY_TEXT} or less.`;
  return /^[\s0]+$/.test(typed) ? "Enter 1 or more, or leave blank." : "Digits only, for example 12.";
}

// ── Dates and titles ─────────────────────────────────────────────────────────────────────────────────────────────

/** The first and last date a sheet can carry. An order date outside this range is a typing mistake (a year typed as "26"). */
export const SHEET_DATE_MIN = `${MIN_SHEET_YEAR}-01-01`;
export const SHEET_DATE_MAX = `${MAX_SHEET_YEAR}-12-31`;

/**
 * True for a real calendar date (YYYY-MM-DD) from 2000 to 2099. This is the only kind of date the page saves, so a year
 * typed as "26" (the browser reads that as year 0026) or "20265" is never stored and never printed as another year.
 * The draft store and the export route apply the very same rule (isValidISODate), so the three can never disagree.
 */
export function isSheetDate(value: string): boolean {
  return isValidISODate(value);
}

/**
 * "2026-11-05" -> "Nov 5, 2026" (in the browser's language). Built in UTC so the day never shifts with the time zone.
 * A year before 1000 (only possible when the computer's own clock is wrong: the draft and the export accept 2000-2099)
 * is shown exactly as stored ("0026-11-05"): Date.UTC would read year 26 as 1926 and the formatter would print it as "26",
 * which looks like 2026. The printed sheet must never show a different date than the field.
 */
export function formatSheetDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const year = Number(match[1]);
  if (year < 1000) return iso;
  // setUTCFullYear (unlike Date.UTC) never maps a small year onto the 1900s.
  const date = new Date(0);
  date.setUTCFullYear(year, Number(match[2]) - 1, Number(match[3]));
  try {
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
  } catch {
    return iso;
  }
}

/** "2:41 PM" (in the browser's language): the time the inventory was last read. */
export function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  } catch {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
}

/** Footer line printed under the table on every page: the sheet title and the date. */
export function sheetFooter(title: string, dateText: string): string {
  return [title.trim(), dateText].filter((part) => part !== "").join(" · ");
}

/** Browsers suggest the page title as the file name when "Save as PDF" is chosen, so it is set while printing. */
export function printDocumentTitle(options: Pick<SheetOptions, "title" | "date">): string {
  const title = options.title.trim() || "Order sheet";
  return `${title} - ${formatSheetDate(options.date)}`;
}

/** The @page rule for the chosen paper. Margins are 14 mm; the page number is an enhancement (ignored where unsupported). */
export function pageStyleText(paper: "letter" | "a4"): string {
  const size = paper === "a4" ? "A4" : "letter";
  return (
    `@page { size: ${size} portrait; margin: 14mm; }\n` +
    `@page { @bottom-right { content: "Page " counter(page) " of " counter(pages); ` +
    `font: 9pt Arial, Helvetica, "Liberation Sans", sans-serif; color: #000; } }`
  );
}

// ── Printed columns ──────────────────────────────────────────────────────────────────────────────────────────────

export type ColumnKey = "item" | "supplier" | "qty" | "unit" | "onHand" | "barcode";
export type Column = { key: ColumnKey; label: string; weight: number };

/** Columns of the printed table. On hand and Barcode only appear when staff switch them on. */
export function planColumns(options: Pick<SheetOptions, "showOnHand" | "showBarcode">): Column[] {
  const columns: Column[] = [
    { key: "item", label: "Item", weight: 5 },
    { key: "supplier", label: "Supplier order no.", weight: 2.7 },
    { key: "qty", label: "Order qty", weight: 1.35 },
    { key: "unit", label: "Unit", weight: 1.7 },
  ];
  if (options.showOnHand) columns.push({ key: "onHand", label: "On hand", weight: 2 });
  if (options.showBarcode) columns.push({ key: "barcode", label: "Barcode", weight: 2.7 });
  return columns;
}

/** Column widths as percentages (the table uses table-layout: fixed, so these are exact). */
export function columnWidths(columns: readonly Column[]): string[] {
  const total = columns.reduce((sum, column) => sum + column.weight, 0);
  return columns.map((column) => `${((column.weight / total) * 100).toFixed(2)}%`);
}

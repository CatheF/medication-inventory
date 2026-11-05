// The order-sheet DRAFT: what staff have ticked and typed so far, kept in the browser (localStorage) only.
// This module is pure (no React, no window access at import time) so it can be unit-tested in plain Node.
// The React hook that persists it lives in ./use-order-draft.ts.
//
// Nothing here talks to the database or changes stock: a draft is just a list of item ids plus the text staff typed
// (and, per row, the last known name of the item, so a row whose item is deleted later can still say what it was).

import { parseMedicationId } from "../ids";
import { clampText } from "./build";
import { ORDER_SHEET_LIMITS } from "./types";
import type { PaperSize, SheetRowInput } from "./types";

export const STORAGE_KEY = "medinventory.orderSheet.v1";

/** Same-tab change notification. (The browser's own "storage" event only fires in OTHER tabs.) */
export const DRAFT_EVENT = "medinventory:orderDraft";

export type OrderDraft = {
  version: 1;
  rows: SheetRowInput[];
  title: string;
  /** null = "today" (resolved at render/export time with resolveDate) */
  date: string | null;
  preparedBy: string;
  notes: string;
  showOnHand: boolean;
  showBarcode: boolean;
  paper: PaperSize;
};

const BASE_DEFAULT: OrderDraft = {
  version: 1,
  rows: [],
  title: "Supply order",
  date: null,
  preparedBy: "",
  notes: "",
  showOnHand: false,
  showBarcode: false,
  paper: "letter",
};

/**
 * The empty draft. Deeply frozen: it is also the server snapshot of the hook, so it must be one stable object
 * that nothing can mutate.
 */
export const DEFAULT_DRAFT: OrderDraft = Object.freeze({
  ...BASE_DEFAULT,
  rows: Object.freeze([...BASE_DEFAULT.rows]) as SheetRowInput[],
});

// ── Parsing / sanitizing ─────────────────────────────────────────────────────────────────────────────────────────

/** Stored drafts are small (500 rows with their remembered names is ~250 KB at most). Anything bigger than this is not ours; do not even parse it. */
const MAX_RAW_CHARS = 2000000;
/** Upper bound on array entries inspected, so a hostile `rows` array cannot burn CPU. */
const MAX_SCANNED_ENTRIES = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The remembered name of a draft row: display text, cut to ORDER_SHEET_LIMITS.name characters (Unicode code points, so an
 * emoji is never split), or undefined when there is nothing usable (not text, or blank). Never throws, and cleaning an
 * already clean name returns it unchanged. It is never interpreted: it is only ever shown as plain text.
 */
export function cleanRowName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clamped = clampText(value, ORDER_SHEET_LIMITS.name);
  return clamped.trim() === "" ? undefined : clamped;
}

function sanitizeRows(value: unknown): SheetRowInput[] {
  if (!Array.isArray(value)) return [];
  const rows: SheetRowInput[] = [];
  const seen = new Set<number>();
  const scan = Math.min(value.length, MAX_SCANNED_ENTRIES);
  for (let i = 0; i < scan && rows.length < ORDER_SHEET_LIMITS.rows; i += 1) {
    const entry: unknown = value[i];
    if (!isRecord(entry)) continue;
    const id = parseMedicationId(entry.id);
    if (id === null || seen.has(id)) continue; // wrong type / not a positive whole number / duplicate
    seen.add(id);
    const row: SheetRowInput = {
      id,
      // Kept exactly as typed (even if it is not a valid quantity yet); only the length is bounded.
      qty: typeof entry.qty === "string" ? clampText(entry.qty, ORDER_SHEET_LIMITS.qtyInput) : "",
      unit: typeof entry.unit === "string" ? clampText(entry.unit, ORDER_SHEET_LIMITS.unit) : "",
    };
    // A draft saved before names existed has none: the key is simply absent (never `name: undefined`).
    const name = cleanRowName(entry.name);
    if (name !== undefined) row.name = name;
    rows.push(row);
  }
  return rows;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/**
 * The first and last year an order date may have. The date box only ever saves dates in this range (a year typed as "26" is
 * read by the browser as year 0026), so a stored draft or a direct API request with another year is a typing mistake or a
 * stale value, never a real order date.
 */
export const MIN_SHEET_YEAR = 2000;
export const MAX_SHEET_YEAR = 2099;

/**
 * True for a real calendar date written YYYY-MM-DD in the years MIN_SHEET_YEAR..MAX_SHEET_YEAR (so "2026-02-30",
 * "2026-1-5" and "0026-11-05" are rejected).
 */
export function isValidISODate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_SHEET_YEAR || year > MAX_SHEET_YEAR || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

/**
 * Forces any value into a valid draft: wrong types fall back to defaults, ids are validated and de-duplicated,
 * lengths are clamped. Never throws. Text is NOT trimmed (a controlled input must be able to hold a trailing space).
 */
export function sanitizeDraft(value: unknown): OrderDraft {
  if (!isRecord(value)) return DEFAULT_DRAFT;
  return {
    version: 1,
    rows: sanitizeRows(value.rows),
    title: typeof value.title === "string" ? clampText(value.title, ORDER_SHEET_LIMITS.title) : BASE_DEFAULT.title,
    date: isValidISODate(value.date) ? value.date : null,
    preparedBy: typeof value.preparedBy === "string" ? clampText(value.preparedBy, ORDER_SHEET_LIMITS.preparedBy) : "",
    notes: typeof value.notes === "string" ? clampText(value.notes, ORDER_SHEET_LIMITS.notes) : "",
    showOnHand: value.showOnHand === true,
    showBarcode: value.showBarcode === true,
    paper: value.paper === "a4" ? "a4" : "letter",
  };
}

/**
 * Reads a stored draft. NEVER throws: null, "", broken JSON, arrays, other versions, wrong types and oversized
 * strings all yield DEFAULT_DRAFT (or a sanitized draft when the shape is recognisable).
 */
export function parseDraft(raw: string | null | undefined): OrderDraft {
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_RAW_CHARS) return DEFAULT_DRAFT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_DRAFT;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return DEFAULT_DRAFT;
  return sanitizeDraft(parsed);
}

export function serializeDraft(d: OrderDraft): string {
  return JSON.stringify(sanitizeDraft(d));
}

// ── Row operations (all immutable; a no-op returns the SAME object so callers can detect "nothing changed") ─────────

export function hasRow(d: OrderDraft, id: number): boolean {
  return d.rows.some((row) => row.id === id);
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function";
}

/** The usable name for `id` in a names map, or undefined. Total: a missing map, a non-map or a non-text value is "no name". */
function nameFor(names: ReadonlyMap<number, string> | undefined, id: number): string | undefined {
  if (!(names instanceof Map)) return undefined;
  const value: unknown = names.get(id);
  return cleanRowName(value);
}

/**
 * Appends the ids that are not on the sheet yet, in the order given. Never creates a duplicate row.
 * `names` (optional) holds the item names by id: a NEW row remembers its name (see SheetRowInput.name). A row that is
 * already on the sheet is never touched, whatever `names` says (use rememberNames to refresh names).
 */
export function addRows(d: OrderDraft, ids: readonly number[], names?: ReadonlyMap<number, string>): OrderDraft {
  if (!isIterable(ids)) return d; // total: "no ids" (undefined, null, a number, an object) adds nothing
  const present = new Set<number>(d.rows.map((row) => row.id));
  const added: SheetRowInput[] = [];
  for (const candidate of ids) {
    if (d.rows.length + added.length >= ORDER_SHEET_LIMITS.rows) break;
    const id = parseMedicationId(candidate);
    if (id === null || present.has(id)) continue;
    present.add(id);
    const name = nameFor(names, id);
    added.push(name === undefined ? { id, qty: "", unit: "" } : { id, qty: "", unit: "", name });
  }
  return added.length === 0 ? d : { ...d, rows: [...d.rows, ...added] };
}

export function removeRow(d: OrderDraft, id: number): OrderDraft {
  if (!hasRow(d, id)) return d;
  return { ...d, rows: d.rows.filter((row) => row.id !== id) };
}

/** Removes the row when it is on the sheet, otherwise adds it (remembering `name` when it is text). */
export function toggleRow(d: OrderDraft, id: number, name?: string): OrderDraft {
  if (hasRow(d, id)) return removeRow(d, id);
  const parsed = parseMedicationId(id);
  // A caller that hands `toggle` straight to forEach/map passes an index here: anything but text is "no name".
  const names = parsed !== null && typeof name === "string" ? new Map<number, string>([[parsed, name]]) : undefined;
  return addRows(d, [id], names);
}

/**
 * Stores what staff typed for one row. Only the length is bounded (like a maxLength); nothing is interpreted.
 * The row's id and remembered name are never changed by it (a patch can only carry `qty` and `unit`).
 */
export function updateRow(
  d: OrderDraft,
  id: number,
  patch: Partial<Pick<SheetRowInput, "qty" | "unit">>
): OrderDraft {
  if (!isRecord(patch)) return d; // total: no patch, nothing to store
  let changed = false;
  const rows = d.rows.map((row) => {
    if (row.id !== id) return row;
    const qty = typeof patch.qty === "string" ? clampText(patch.qty, ORDER_SHEET_LIMITS.qtyInput) : row.qty;
    const unit = typeof patch.unit === "string" ? clampText(patch.unit, ORDER_SHEET_LIMITS.unit) : row.unit;
    if (qty === row.qty && unit === row.unit) return row;
    changed = true;
    return { ...row, qty, unit };
  });
  return changed ? { ...d, rows } : d;
}

/**
 * Refreshes the remembered names: every row whose id is in `names` (item id -> its current display name) gets that name.
 *  - A row that is not in `names` (its item is gone, or the inventory did not load) keeps the name it has: the whole point
 *    is to remember what the item was called when it could still be read.
 *  - A blank or non-text name never replaces a known one.
 *  - Quantity, unit and the order of the rows are never touched.
 * Returns the SAME object when nothing changes, so applying it again is a no-op (no write, no re-render).
 */
export function rememberNames(d: OrderDraft, names: ReadonlyMap<number, string>): OrderDraft {
  if (!(names instanceof Map) || names.size === 0) return d;
  let changed = false;
  const rows = d.rows.map((row) => {
    const next = nameFor(names, row.id);
    if (next === undefined || next === row.name) return row;
    changed = true;
    return { ...row, name: next };
  });
  return changed ? { ...d, rows } : d;
}

/** Removes every row. Title, date, notes and the other options are kept. */
export function clearRows(d: OrderDraft): OrderDraft {
  return d.rows.length === 0 ? d : { ...d, rows: [] };
}

// ── Dates ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Today's date in the LOCAL time zone as YYYY-MM-DD (never UTC, so an evening order is not dated tomorrow). */
export function todayISO(now: Date = new Date()): string {
  const date = Number.isNaN(now.getTime()) ? new Date() : now;
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function resolveDate(d: OrderDraft, todayStr: string): string {
  return d.date ?? todayStr;
}

// What the Inventory tab remembers between visits: the search text, stock level, category, sort order and grouping.
// Pure functions (no React, no browser APIs) so they can be tested on their own; the hook that stores the text in
// sessionStorage is in useInventoryView.ts.
//
// The stored text is untrusted: another version of the app, a browser extension or a person with the developer tools
// open may have written anything. Every field is checked on its own, and a field that is not understood falls back
// to its default instead of throwing the whole view away or breaking the page.

import { parseCategoryId } from "@/lib/ids";
import {
  DEFAULT_VIEW,
  UNKNOWN_CATEGORY_FILTER,
  UNKNOWN_CATEGORY_ID,
  type CategoryFilter,
  type SortKey,
  type StockFilter,
  type ViewState,
} from "@/lib/inventory-view";

/** sessionStorage key. Session storage belongs to one browser tab and is gone when the tab is closed. */
export const VIEW_STORAGE_KEY = "medinventory.inventoryView.v1";

/** Longest search text kept (the search box itself stops at the same length). */
export const SEARCH_MAX_LENGTH = 200;

const STOCK_VALUES: readonly StockFilter[] = ["all", "low", "ok"];
const SORT_VALUES: readonly SortKey[] = ["name", "stock-asc", "category"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCategory(value: unknown): CategoryFilter {
  if (!isRecord(value)) return DEFAULT_VIEW.category;
  if (value.kind === "uncategorized") return { kind: "uncategorized" };
  if (value.kind === "category" && typeof value.id === "string") {
    // "Category unavailable" is a reserved pseudo id (see lib/inventory-view.ts); every other id must look like a real one.
    if (value.id.trim().toLowerCase() === UNKNOWN_CATEGORY_ID) return UNKNOWN_CATEGORY_FILTER;
    const parsed = parseCategoryId(value.id);
    if (parsed.ok && parsed.value !== null) return { kind: "category", id: parsed.value };
  }
  return DEFAULT_VIEW.category;
}

/** Turns anything into a valid ViewState, field by field. Never throws. */
export function sanitizeView(value: unknown): ViewState {
  if (!isRecord(value)) return DEFAULT_VIEW;
  const stock = STOCK_VALUES.find((candidate) => candidate === value.stock);
  const sort = SORT_VALUES.find((candidate) => candidate === value.sort);
  return {
    search: typeof value.search === "string" ? value.search.slice(0, SEARCH_MAX_LENGTH) : DEFAULT_VIEW.search,
    stock: stock ?? DEFAULT_VIEW.stock,
    category: parseCategory(value.category),
    sort: sort ?? DEFAULT_VIEW.sort,
    grouped: typeof value.grouped === "boolean" ? value.grouped : DEFAULT_VIEW.grouped,
  };
}

/** Reads the stored text. Empty, missing or damaged text gives the default view. Never throws. */
export function parseStoredView(raw: string | null | undefined): ViewState {
  if (typeof raw !== "string" || raw === "") return DEFAULT_VIEW;
  try {
    return sanitizeView(JSON.parse(raw));
  } catch {
    return DEFAULT_VIEW;
  }
}

/** The text to store for a view (the view is sanitized first, so only valid values are ever written). */
export function serializeView(view: ViewState): string {
  return JSON.stringify(sanitizeView(view));
}

// The words on the filter chips under the search box of the Inventory tab and of the Admin list: "Category: Antibiotics",
// "Stock: Low", "Search: “ibuprofen”". Pure: no React, no DOM, no fetch.
//
// ONE implementation, used by both screens, so the wording cannot drift. It did: the Admin chip left out the curly quotes that
// the Inventory chip and both "Showing X of Y items" lines use. What a chip says about the search (invisible characters
// dropped, ends trimmed, inner whitespace collapsed to single spaces) is exactly what lib/inventory-view.ts quotes in the
// summary line, because both call displaySearchText (lib/search-text.ts); tests/unit/filter-chips.test.ts still compares the
// two over many inputs.
//
// Category ids are opaque strings (uuid in the live database, digit strings for the bigint schema). They are compared as
// strings and nothing in here calls Number() on them.

import type { Category } from "./db";
import { idKey } from "./ids";
import {
  UNKNOWN_CATEGORY_ID,
  isUnknownCategoryFilter,
  type CategoryFilter,
  type StockFilter,
  type ViewState,
} from "./inventory-view";
import { displaySearchText } from "./search-text";

const OPEN_QUOTE = "“";
const CLOSE_QUOTE = "”";

const UNCATEGORIZED_TITLE = "Uncategorized";
const UNAVAILABLE_TITLE = "Category unavailable";
const UNNAMED_CATEGORY_TITLE = "Unnamed category";

// ── Category titles ─────────────────────────────────────────────────────────────

// The comparison key for a category id (trimmed, lower-cased, blank = null) is defined once, in lib/ids.ts. It is re-exported
// from here because the Inventory components import it from this module (through app/components/inventory/helpers.ts).
export { idKey };

/** One category a chip, a tag or a group heading can name. `key` is idKey(id); `position` is its place in the list. */
export type CategoryTitle = { id: string; key: string; title: string; position: number };

/**
 * The categories that can be named, in list order, each with the title people read: the trimmed name, or "Unnamed category"
 * for a blank one. Same filtering as lib/inventory-view.ts: blank ids, the reserved "unknown" id and repeated ids (the first
 * one wins) are left out, because no item can point at them. Sorting is the caller's business (the Inventory tab sorts the
 * category chips by title; see orderCategories in app/components/inventory/helpers.ts, which builds on this).
 */
export function categoryTitles(categories: readonly Category[]): CategoryTitle[] {
  const seen = new Set<string>();
  const entries: CategoryTitle[] = [];
  categories.forEach((category, position) => {
    const key = idKey(category.id);
    if (key === null || key === UNKNOWN_CATEGORY_ID || seen.has(key)) return;
    seen.add(key);
    const name = typeof category.name === "string" ? category.name.trim() : "";
    entries.push({ id: String(category.id), key, title: name === "" ? UNNAMED_CATEGORY_TITLE : name, position });
  });
  return entries;
}

/** idKey -> title for every category that can be named: what describeActiveFilters needs to name the selected category. */
export function categoryTitleByKey(categories: readonly Category[]): Map<string, string> {
  return new Map(categoryTitles(categories).map((entry) => [entry.key, entry.title] as const));
}

// ── The chips ───────────────────────────────────────────────────────────────────

/**
 * The search as the summary line quotes it: invisible characters dropped, ends trimmed, inner whitespace collapsed to single
 * spaces, accents and everything else as typed. "" means "no search" (and then there is no Search chip either), which includes
 * a search with nothing left to look for once accents are ignored. Whole: the chip cuts a long value short with CSS and keeps
 * the full text in its title.
 */
export function searchChipText(search: unknown): string {
  return displaySearchText(search);
}

/** What the Search chip says after "Search: ": the text between curly quotes, or null while there is no search. */
export function searchChipValue(search: unknown): string | null {
  const text = searchChipText(search);
  return text === "" ? null : `${OPEN_QUOTE}${text}${CLOSE_QUOTE}`;
}

/** What the Stock chip says after "Stock: ", or null while the stock filter is off. */
export function stockChipValue(stock: StockFilter): string | null {
  if (stock === "low") return "Low";
  if (stock === "ok") return "Adequate";
  return null;
}

/**
 * What the Category chip says after "Category: ": the category's name, "Uncategorized", or "Category unavailable" (the pseudo
 * category, or an id the list cannot name); null while the filter is off. `titleByKey` is categoryTitleByKey(categories).
 */
export function categoryChipValue(filter: CategoryFilter, titleByKey: ReadonlyMap<string, string>): string | null {
  if (filter.kind === "uncategorized") return UNCATEGORIZED_TITLE;
  if (filter.kind !== "category") return null; // "all": not a filter
  const key = isUnknownCategoryFilter(filter) ? null : idKey(filter.id);
  return (key === null ? undefined : titleByKey.get(key)) ?? UNAVAILABLE_TITLE;
}

export type ActiveFilterKey = "category" | "stock" | "search";

/** One applied filter, as the chips show it: "<label>: <value>". `key` doubles as the chip's test id suffix. */
export type ActiveFilterSpec = { key: ActiveFilterKey; label: string; value: string };

/**
 * The filters that are on, in the order the summary line lists them: Category, Stock, Search. A filter that is not narrowing
 * the list (All, stock All, an empty or invisible-only search) has no entry. A screen without a stock filter passes
 * `stock: "all"` and simply never gets that chip.
 */
export function describeActiveFilters(
  view: Pick<ViewState, "search" | "stock" | "category">,
  titleByKey: ReadonlyMap<string, string>
): ActiveFilterSpec[] {
  const specs: ActiveFilterSpec[] = [];
  const category = categoryChipValue(view.category, titleByKey);
  if (category !== null) specs.push({ key: "category", label: "Category", value: category });
  const stock = stockChipValue(view.stock);
  if (stock !== null) specs.push({ key: "stock", label: "Stock", value: stock });
  const search = searchChipValue(view.search);
  if (search !== null) specs.push({ key: "search", label: "Search", value: search });
  return specs;
}

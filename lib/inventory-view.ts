// Pure view logic behind the Inventory tab: search, stock filter, category filter, sorting, grouping, chip
// counts, the result summary line and the empty-state copy. No React, no DOM, no fetch. Nothing here mutates
// its inputs, and every function returns new arrays.
//
// Category ids are opaque strings (uuid in the live database, digit strings for the bigint schema in
// supabase/schema.sql). They are only ever compared as strings and never go through Number(): that was the
// root cause of category assignments being dropped.
//
// Invariants this module guarantees (and tests/unit/inventory-view.test.ts checks):
//   * Items are never lost or duplicated: `visible` holds exactly the input items that match search, stock
//     and category; in grouped mode the group sizes add up to `visible.length`.
//   * An item whose category_id is set but missing from `categories` is "unknown" (group "Category
//     unavailable"). It is never counted or shown as Uncategorized and never hidden.
//   * Chip counts reflect search + stock, not the category filter.
//   * Search ignores characters that render as nothing (zero-width spaces and joiners, soft hyphen, direction marks,
//     variation selectors...) in the typed text and in the item text, so a pasted blank is "no search" and never an
//     empty-quotes message, and it treats look-alike forms as equal (NFKC: "µg" = "μg", full-width letters, ligatures).

import type { Category, Medication } from "./db";

// ── Public types ────────────────────────────────────────────────────────────────

/** low: stock <= threshold; ok: stock > threshold (the same rule as the Out/Low/OK status pill). */
export type StockFilter = "all" | "low" | "ok";
export type SortKey = "name" | "stock-asc" | "category";
export type CategoryFilter =
  | { kind: "all" }
  | { kind: "uncategorized" }
  | { kind: "category"; id: string };

export type ViewState = {
  search: string;
  stock: StockFilter;
  category: CategoryFilter;
  sort: SortKey;
  grouped: boolean;
};

// Frozen so a stray mutation of the shared default throws instead of silently changing every later reset.
export const DEFAULT_VIEW: ViewState = Object.freeze({
  search: "",
  stock: "all" as const,
  category: Object.freeze({ kind: "all" as const }),
  sort: "name" as const,
  grouped: true,
});

export type CategoryCounts = {
  /** Items matching search + stock (the number on the "All" chip). */
  all: number;
  /** Items with no category at all. */
  uncategorized: number;
  /** Items whose category_id is set but not present in the categories list. */
  unknown: number;
  /** One entry per category in the list (0 when it has no matching items), keyed by the category's own id. */
  byId: Record<string, number>;
};

export type ItemGroup = {
  /** The category id for real categories, otherwise "unknown" / "uncategorized". Unique within a result. */
  key: string;
  kind: "category" | "unknown" | "uncategorized";
  /** The category id for real categories, null for the unknown and uncategorized groups. */
  id: string | null;
  title: string;
  items: Medication[];
};

export type ResultSummary = { total: number; shown: number; filtersActive: boolean; text: string };
export type EmptyKind = "no-items" | "category-empty" | "no-match";

/**
 * Reserved pseudo category id: `{ kind: "category", id: UNKNOWN_CATEGORY_ID }` (ready-made as UNKNOWN_CATEGORY_FILTER)
 * selects the items whose category is not in the categories list: the "Category unavailable" chip and group.
 * SPEC 2.7's CategoryFilter has no variant for them, so this id is the contract. It is also the `key` of that group.
 *
 * It cannot collide with a real category: ids are uuids or digit strings and parseCategoryId (lib/ids.ts) rejects
 * anything else (tests/unit/inventory-view.test.ts pins that). A category that did carry this id would be left out
 * of the chips and groups. If id validation is ever loosened, replace this with a typed CategoryFilter variant.
 *
 * What the Inventory UI has to do with it:
 *   - import the constant (or the filter), never write the string: any other id selects nothing and nothing at
 *     compile time says so;
 *   - draw the chip while `counts.unknown > 0` OR while isUnknownCategoryFilter(view.category) is true, so a chip the
 *     user selected does not vanish when the categories finish loading and its count drops to 0;
 *   - set aria-pressed with isUnknownCategoryFilter, not with a string comparison;
 *   - call selectView only after BOTH /api/medications and /api/categories have settled: while the categories are
 *     still loading every categorized item is briefly "unavailable";
 *   - report a categories load error on its own (a Notice): a failed fetch that becomes [] looks exactly like "no
 *     category is known" here.
 */
export const UNKNOWN_CATEGORY_ID = "unknown";

/** The filter that selects the "Category unavailable" bucket. Use it instead of spelling the pseudo id out. */
export const UNKNOWN_CATEGORY_FILTER: CategoryFilter = Object.freeze({
  kind: "category" as const,
  id: UNKNOWN_CATEGORY_ID,
});

// ── Text helpers ────────────────────────────────────────────────────────────────

const OPEN_QUOTE = "“";
const CLOSE_QUOTE = "”";
const SEPARATOR = " · ";

const UNCATEGORIZED_TITLE = "Uncategorized";
const UNKNOWN_TITLE = "Category unavailable";
const UNNAMED_CATEGORY_TITLE = "Unnamed category";

// One shared collator instead of String.prototype.localeCompare(b, undefined, options): by ECMA-402 the two are
// equivalent (localeCompare builds exactly this collator on every call), but a call per comparison is roughly
// 20x slower and this runs on every keystroke. Numeric: "Item 2" sorts before "Item 10". Base sensitivity:
// case (and accents) never decide the order.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural, case-insensitive string order. Same result as `a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })`. */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

/**
 * Characters that render as nothing: zero-width spaces and joiners, the soft hyphen, direction marks and isolates,
 * the word joiner, variation selectors, Hangul fillers, tag characters... (Unicode "format" characters plus the
 * Default_Ignorable_Code_Point set). Text pasted from web pages, PDFs, chat apps and email carries them. They are not
 * whitespace, so left alone a search made only of them would count as real text (every item hidden behind an
 * empty-looking “” message) and one inside a word would stop it from matching.
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

/**
 * Case-insensitive form used for search, applied to the typed search and to the searched text alike:
 *   1. invisible characters are dropped first, so an accent that one separated from its letter still composes;
 *   2. NFKC: canonical equivalence ("é" as one character equals "e" + combining accent) and compatibility forms
 *      (the micro sign and the Greek mu in "µg"/"μg", full-width letters, ligatures like "ﬁ", the one-character "㎎");
 *   3. lower case.
 * NFKC never produces an invisible character from a visible one, so one strip pass is enough.
 */
function fold(text: string): string {
  return stripInvisible(text).normalize("NFKC").toLowerCase();
}

/**
 * The search as staff see it: invisible characters dropped, trimmed, inner whitespace collapsed to single spaces.
 * "" means "no search". Everything else stays as typed (full-width letters stay full-width). When it is not empty at
 * least one search term survives folding, so "a filter is active" and "the search has a term" never disagree (the
 * unit tests sweep every BMP character). Not treated as invisible: C0/C1 control characters and U+2800 (Braille
 * blank) still count as text.
 */
function displaySearch(search: unknown): string {
  return typeof search === "string" ? stripInvisible(search).trim().replace(/\s+/g, " ") : "";
}

function pluralItems(count: number): string {
  return count === 1 ? "item" : "items";
}

// ── Category index (shared by counts, filter, sort and grouping so they cannot disagree) ──────────────────

/** Comparison key for a category id: String() equality, trimmed and lower-cased (uuids are case-insensitive). */
function idKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const key = String(value).trim().toLowerCase();
  return key === "" ? null : key;
}

type CategoryEntry = {
  key: string;
  /** The category's own id string, as given in the categories list. */
  id: string;
  title: string;
  /** Position in the categories list; breaks ties between equally named categories. */
  position: number;
  /** Position in title order. */
  rank: number;
};

type CategoryIndex = {
  byKey: ReadonlyMap<string, CategoryEntry>;
  /** Title order: natural, case-insensitive, then list position. */
  ordered: readonly CategoryEntry[];
  /** Rank given to the "Category unavailable" bucket (after every real category). */
  unknownRank: number;
  /** Rank given to the "Uncategorized" bucket (last). */
  uncategorizedRank: number;
};

// Bucket markers for items without a (resolvable) category; they double as the group keys of those two groups.
const UNCATEGORIZED = "uncategorized";
const UNKNOWN = UNKNOWN_CATEGORY_ID;
type Bucket = CategoryEntry | typeof UNCATEGORIZED | typeof UNKNOWN;

function categoryTitle(category: Category): string {
  const name = typeof category.name === "string" ? category.name.trim() : "";
  return name === "" ? UNNAMED_CATEGORY_TITLE : name;
}

function indexCategories(categories: readonly Category[]): CategoryIndex {
  const entries: CategoryEntry[] = [];
  const seen = new Set<string>();
  categories.forEach((category, position) => {
    const key = idKey(category.id);
    // Blank ids can't be referenced by any item; the reserved pseudo id never names a real category;
    // a repeated id keeps its first occurrence.
    if (key === null || key === UNKNOWN_CATEGORY_ID || seen.has(key)) return;
    seen.add(key);
    entries.push({ key, id: String(category.id), title: categoryTitle(category), position, rank: 0 });
  });
  entries.sort((a, b) => naturalCompare(a.title, b.title) || a.position - b.position);
  entries.forEach((entry, rank) => {
    entry.rank = rank;
  });
  return {
    byKey: new Map(entries.map((entry) => [entry.key, entry])),
    ordered: entries,
    unknownRank: entries.length,
    uncategorizedRank: entries.length + 1,
  };
}

function bucketOf(item: Medication, index: CategoryIndex): Bucket {
  const key = idKey(item.category_id);
  if (key === null) return UNCATEGORIZED;
  return index.byKey.get(key) ?? UNKNOWN;
}

function rankOf(bucket: Bucket, index: CategoryIndex): number {
  if (bucket === UNCATEGORIZED) return index.uncategorizedRank;
  if (bucket === UNKNOWN) return index.unknownRank;
  return bucket.rank;
}

// ── Search and stock ────────────────────────────────────────────────────────────

/** low: stock <= threshold. Everything that is not low is "ok", so the two filters always partition the list. */
export function isLowStock(item: Pick<Medication, "stock" | "threshold">): boolean {
  return item.stock <= item.threshold;
}

function searchTerms(search: unknown): string[] {
  const text = displaySearch(search);
  if (text === "") return [];
  // Split AFTER folding: NFKC can turn one character into several and some of them are spaces (the diaeresis "¨"
  // becomes " ̈"), which would otherwise leave a term with a space in it or an empty one.
  return fold(text).split(/\s+/).filter((term) => term !== "");
}

function matchesTerms(item: Medication, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  // The single spaces keep a term from matching across two fields (terms never contain whitespace).
  const haystack = fold(`${item.name ?? ""} ${item.barcode ?? ""} ${item.supplier_order_number ?? ""}`);
  return terms.every((term) => haystack.includes(term));
}

/**
 * Trimmed, split on whitespace; EVERY term must appear (case-insensitive substring) in
 * "<name> <barcode> <supplier order number>". An empty search matches everything, and so does one made only of
 * invisible characters. Invisible characters are ignored and look-alike forms are equal (see `fold`). Unnamed items
 * match on their barcode (a missing name contributes nothing, never the text "null").
 */
export function matchesSearch(item: Medication, search: string): boolean {
  return matchesTerms(item, searchTerms(search));
}

function matchesStock(item: Medication, stock: StockFilter): boolean {
  if (stock === "low") return isLowStock(item);
  if (stock === "ok") return !isLowStock(item);
  return true;
}

export function applySearchAndStock(
  items: readonly Medication[],
  view: Pick<ViewState, "search" | "stock">
): Medication[] {
  const terms = searchTerms(view.search);
  return items.filter((item) => matchesStock(item, view.stock) && matchesTerms(item, terms));
}

// ── Category counts and filter ──────────────────────────────────────────────────

function countCategories(items: readonly Medication[], index: CategoryIndex): CategoryCounts {
  const perKey = new Map<string, number>();
  let uncategorized = 0;
  let unknown = 0;
  for (const item of items) {
    const bucket = bucketOf(item, index);
    if (bucket === UNCATEGORIZED) uncategorized += 1;
    else if (bucket === UNKNOWN) unknown += 1;
    else perKey.set(bucket.key, (perKey.get(bucket.key) ?? 0) + 1);
  }
  return {
    all: items.length,
    uncategorized,
    unknown,
    byId: Object.fromEntries(index.ordered.map((entry) => [entry.id, perKey.get(entry.key) ?? 0])),
  };
}

/**
 * Counts for the category chips. Pass the items AFTER search and stock filtering (and before the category
 * filter) so the numbers describe what each chip would show.
 * Invariant: all = uncategorized + unknown + the sum of byId.
 */
export function categoryCounts(
  itemsAfterSearchAndStock: readonly Medication[],
  categories: readonly Category[]
): CategoryCounts {
  return countCategories(itemsAfterSearchAndStock, indexCategories(categories));
}

function isCategoryFilterActive(filter: CategoryFilter): boolean {
  return filter.kind === "uncategorized" || filter.kind === "category";
}

function filterByCategory(items: readonly Medication[], filter: CategoryFilter, index: CategoryIndex): Medication[] {
  if (filter.kind === "uncategorized") {
    return items.filter((item) => bucketOf(item, index) === UNCATEGORIZED);
  }
  if (filter.kind === "category") {
    const key = idKey(filter.id);
    if (key === null) return []; // a blank id refers to no category; it must not behave like "Uncategorized"
    if (key === UNKNOWN_CATEGORY_ID) return items.filter((item) => bucketOf(item, index) === UNKNOWN);
    // Direct id match, even for an id that is missing from the list: such items stay reachable.
    return items.filter((item) => idKey(item.category_id) === key);
  }
  return items.slice();
}

export function applyCategoryFilter(
  items: readonly Medication[],
  filter: CategoryFilter,
  categories: readonly Category[]
): Medication[] {
  return filterByCategory(items, filter, indexCategories(categories));
}

/**
 * True when `filter` selects the "Category unavailable" bucket (the pressed state of its chip). It reads the id the
 * same way applyCategoryFilter does (trimmed, case-insensitive), so the two can never disagree.
 */
export function isUnknownCategoryFilter(filter: CategoryFilter): boolean {
  return filter.kind === "category" && idKey(filter.id) === UNKNOWN_CATEGORY_ID;
}

// ── Sorting ─────────────────────────────────────────────────────────────────────

type SortRow = {
  item: Medication;
  /** Position in the input; the final tie-breaker, which is what makes the sort stable. */
  position: number;
  /** Trimmed name; null when the item has no usable name. */
  name: string | null;
  barcode: string;
  stock: number;
  rank: number;
};

function compareNumbers(a: number, b: number): number {
  const aNaN = Number.isNaN(a);
  const bNaN = Number.isNaN(b);
  if (aNaN || bNaN) return aNaN === bNaN ? 0 : aNaN ? 1 : -1; // bad data sorts last instead of breaking the order
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Named items by natural name order, then unnamed items (name null or blank) by barcode. */
function compareNames(a: SortRow, b: SortRow): number {
  if (a.name === null) return b.name === null ? naturalCompare(a.barcode, b.barcode) : 1;
  if (b.name === null) return -1;
  return naturalCompare(a.name, b.name);
}

const COMPARATORS: Record<SortKey, (a: SortRow, b: SortRow) => number> = {
  name: compareNames,
  "stock-asc": (a, b) => compareNumbers(a.stock, b.stock) || compareNames(a, b),
  // Real categories by name, then "Category unavailable", then Uncategorized: the same order the groups use.
  category: (a, b) => a.rank - b.rank || compareNames(a, b),
};

function toRows(items: readonly Medication[], index: CategoryIndex): SortRow[] {
  return items.map((item, position) => {
    const name = typeof item.name === "string" ? item.name.trim() : "";
    return {
      item,
      position,
      name: name === "" ? null : name,
      barcode: String(item.barcode ?? ""),
      stock: item.stock,
      rank: rankOf(bucketOf(item, index), index),
    };
  });
}

function sortWithIndex(items: readonly Medication[], sort: SortKey, index: CategoryIndex): Medication[] {
  const compare = COMPARATORS[sort] ?? compareNames;
  return toRows(items, index)
    .sort((a, b) => compare(a, b) || a.position - b.position)
    .map((row) => row.item);
}

/**
 * Returns a new, sorted array (stable: items that compare equal keep their input order).
 *   name       natural, case-insensitive; unnamed items last, ordered by barcode
 *   stock-asc  lowest stock first, then by name
 *   category   category name, then item name; "Category unavailable" after the real categories, Uncategorized last
 */
export function sortItems(items: readonly Medication[], sort: SortKey, categories: readonly Category[]): Medication[] {
  return sortWithIndex(items, sort, indexCategories(categories));
}

// ── Grouping ────────────────────────────────────────────────────────────────────

function groupWithIndex(items: readonly Medication[], index: CategoryIndex, sort: SortKey): ItemGroup[] {
  // Inside one group every item shares the category, so "category" order falls back to name order.
  const inGroup: SortKey = sort === "category" ? "name" : sort;
  const byKey = new Map<string, Medication[]>();
  const unknown: Medication[] = [];
  const uncategorized: Medication[] = [];

  for (const item of items) {
    const bucket = bucketOf(item, index);
    if (bucket === UNCATEGORIZED) uncategorized.push(item);
    else if (bucket === UNKNOWN) unknown.push(item);
    else {
      const list = byKey.get(bucket.key);
      if (list) list.push(item);
      else byKey.set(bucket.key, [item]);
    }
  }

  const groups: ItemGroup[] = [];
  for (const entry of index.ordered) {
    const list = byKey.get(entry.key);
    if (list) {
      groups.push({
        key: entry.id,
        kind: "category",
        id: entry.id,
        title: entry.title,
        items: sortWithIndex(list, inGroup, index),
      });
    }
  }
  if (unknown.length > 0) {
    groups.push({
      key: UNKNOWN,
      kind: "unknown",
      id: null,
      title: UNKNOWN_TITLE,
      items: sortWithIndex(unknown, inGroup, index),
    });
  }
  if (uncategorized.length > 0) {
    groups.push({
      key: UNCATEGORIZED,
      kind: "uncategorized",
      id: null,
      title: UNCATEGORIZED_TITLE,
      items: sortWithIndex(uncategorized, inGroup, index),
    });
  }
  return groups;
}

/**
 * One group per non-empty category. Group order: real categories by title (natural, case-insensitive), then
 * "Category unavailable", then "Uncategorized" last. Items inside a group follow `sort`.
 */
export function groupByCategory(items: readonly Medication[], categories: readonly Category[], sort: SortKey): ItemGroup[] {
  return groupWithIndex(items, indexCategories(categories), sort);
}

// ── Summary and empty states ────────────────────────────────────────────────────

const STOCK_LABEL: Record<Exclude<StockFilter, "all">, string> = { low: "Low", ok: "Adequate" };

/** Label for the selected category: its name, "Uncategorized", or "Category unavailable" when it can't be named. */
function categoryFilterLabel(filter: CategoryFilter, index: CategoryIndex): { label: string; resolved: boolean } {
  if (filter.kind === "uncategorized") return { label: UNCATEGORIZED_TITLE, resolved: true };
  if (filter.kind === "category") {
    const key = idKey(filter.id);
    const entry = key === null ? undefined : index.byKey.get(key);
    if (entry) return { label: entry.title, resolved: true };
  }
  return { label: UNKNOWN_TITLE, resolved: false };
}

/** The active filters as short labels, in a fixed order: Category, Stock, Search. */
function describeFilters(view: ViewState, index: CategoryIndex): string[] {
  const parts: string[] = [];
  if (isCategoryFilterActive(view.category)) {
    parts.push(`Category: ${categoryFilterLabel(view.category, index).label}`);
  }
  if (view.stock === "low" || view.stock === "ok") parts.push(`Stock: ${STOCK_LABEL[view.stock]}`);
  const search = displaySearch(view.search);
  if (search !== "") parts.push(`Search ${OPEN_QUOTE}${search}${CLOSE_QUOTE}`);
  return parts;
}

function summarize(total: number, shown: number, view: ViewState, index: CategoryIndex): ResultSummary {
  const parts = describeFilters(view, index);
  const filtersActive = parts.length > 0;
  const text = filtersActive
    ? [`Showing ${shown} of ${total} ${pluralItems(total)}`, ...parts].join(SEPARATOR)
    : `Showing all ${total} ${pluralItems(total)}.`;
  return { total, shown, filtersActive, text };
}

/**
 * Explains an empty result. Call it when nothing is visible; `totalItems` is the size of the whole inventory.
 *   no-items        the inventory itself is empty
 *   category-empty  a category (or Uncategorized) is selected, with no search and stock "all", and it holds nothing
 *   no-match        any other empty result: the message lists the active filters, never empty quotes
 */
export function describeEmpty(
  totalItems: number,
  view: ViewState,
  categories: readonly Category[]
): { kind: EmptyKind; title: string; detail: string } {
  if (!(totalItems > 0)) {
    return {
      kind: "no-items",
      title: "No items in the inventory yet.",
      detail: `Use ${OPEN_QUOTE}+ Add${CLOSE_QUOTE} to create the first item.`,
    };
  }

  const index = indexCategories(categories);
  const filters = describeFilters(view, index);
  const searching = displaySearch(view.search) !== "";

  if (isCategoryFilterActive(view.category) && !searching && view.stock === "all") {
    const { label, resolved } = categoryFilterLabel(view.category, index);
    const detail =
      view.category.kind === "uncategorized"
        ? "Every item has a category."
        : resolved
          ? "Assign items to this category from the Admin page."
          : "No item points to a category that can’t be found.";
    return { kind: "category-empty", title: `No items in ${label} yet.`, detail };
  }

  if (filters.length === 0) {
    // Nothing is filtered, so the view can't explain an empty list. Avoid a dangling "No items match ."
    return { kind: "no-match", title: "No items to show.", detail: "Reload the page to check again." };
  }

  const advice = searching ? "Check the spelling or try fewer words. " : "";
  return {
    kind: "no-match",
    title: `No items match ${filters.join(SEPARATOR)}.`,
    detail: `${advice}Clear the filters to see all ${totalItems} ${pluralItems(totalItems)}.`,
  };
}

// ── Whole pipeline ──────────────────────────────────────────────────────────────

/**
 * search + stock -> chip counts (these ignore the category filter) -> category filter -> sort ->
 * groups (only when `view.grouped`, otherwise null).
 * `visible` is the flat list in `view.sort` order; the groups hold exactly the same items.
 */
export function selectView(
  allItems: readonly Medication[],
  categories: readonly Category[],
  view: ViewState
): {
  visible: Medication[];
  groups: ItemGroup[] | null;
  counts: CategoryCounts;
  summary: ResultSummary;
} {
  const index = indexCategories(categories);
  const afterSearchAndStock = applySearchAndStock(allItems, view);
  const counts = countCategories(afterSearchAndStock, index);
  const filtered = filterByCategory(afterSearchAndStock, view.category, index);
  const visible = sortWithIndex(filtered, view.sort, index);
  const groups = view.grouped ? groupWithIndex(visible, index, view.sort) : null;
  return { visible, groups, counts, summary: summarize(allItems.length, visible.length, view, index) };
}

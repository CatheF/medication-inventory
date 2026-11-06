// An INDEPENDENT oracle for the Inventory tab's browse behavior (tests/e2e/inventory-browse.spec.ts).
//
// It answers "which items must be on screen, in which order, under which headings, with which numbers" for a given set of
// synthetic items, categories and view, using plain code written from the written rules (below, and the requirement to
// browse the inventory by category). It deliberately imports NOTHING from lib/inventory-view.ts (only types), so a bug in the
// app's view logic cannot hide behind the same bug in the check.
//
// Rules, as written down:
//   search   split on whitespace; EVERY term must be a substring of "name barcode supplier order no.", ignoring case and accents
//            ("creme" finds "Crème"; the accent may be one character or a letter plus a combining mark)
//   stock    low: stock <= threshold; ok: stock > threshold; all: no filter
//   category all | uncategorized (no category_id) | unknown (category_id set but not in the category list) | one category
//   sort     name: natural case-insensitive, unnamed last (by barcode); stock-asc: stock then name; category: category name, then name
//   groups   real categories by title, then "Category unavailable", then "Uncategorized" last; only non-empty groups
//   counts   chip numbers follow search + stock, NOT the category filter
import type { Category, Medication } from "@/lib/db";

export type OracleStock = "all" | "low" | "ok";
export type OracleSort = "name" | "stock-asc" | "category";
export type OracleCategory = { kind: "all" } | { kind: "uncategorized" } | { kind: "unknown" } | { kind: "category"; id: string };
export type OracleView = { search: string; stock: OracleStock; category: OracleCategory; sort: OracleSort; grouped: boolean };

export const ALL_ITEMS: OracleView = { search: "", stock: "all", category: { kind: "all" }, sort: "name", grouped: true };

export const UNCATEGORIZED_TITLE = "Uncategorized";
export const UNAVAILABLE_TITLE = "Category unavailable";
export const SEPARATOR = " · ";

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const compareText = (a: string, b: string): number => collator.compare(a, b);

// The comparison form: NFKC, lower case, then accents out (NFD without the Latin combining marks U+0300 to U+036F). Written out
// here on purpose, and with a narrower rule than the app's (no final NFC, Latin marks only), so the oracle is a separate
// statement of what the search should find, not a copy of the app's recipe.
const lower = (text: string): string => text.normalize("NFKC").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const sameId = (a: unknown, b: unknown): boolean => a !== null && a !== undefined && b !== null && b !== undefined && String(a).toLowerCase() === String(b).toLowerCase();

export function searchTerms(search: string): string[] {
  return lower(search).split(/\s+/).filter((term) => term !== "");
}

export function matchesSearch(item: Medication, search: string): boolean {
  const text = lower(`${item.name ?? ""} ${item.barcode} ${item.supplier_order_number ?? ""}`);
  return searchTerms(search).every((term) => text.includes(term));
}

export const isLow = (item: Medication): boolean => item.stock <= item.threshold;

export type Bucket = { kind: "category"; id: string; title: string } | { kind: "unknown" } | { kind: "uncategorized" };

export function bucketOf(item: Medication, categories: readonly Category[]): Bucket {
  if (item.category_id === null || item.category_id === undefined || String(item.category_id).trim() === "") return { kind: "uncategorized" };
  const found = categories.find((category) => sameId(category.id, item.category_id));
  return found ? { kind: "category", id: found.id, title: found.name.trim() } : { kind: "unknown" };
}

function bucketRank(bucket: Bucket, categories: readonly Category[]): number {
  if (bucket.kind === "uncategorized") return 2_000_000;
  if (bucket.kind === "unknown") return 1_000_000;
  const ordered = [...categories].sort((a, b) => compareText(a.name.trim(), b.name.trim()));
  return ordered.findIndex((category) => sameId(category.id, bucket.id));
}

function compareNames(a: Medication, b: Medication): number {
  const an = (a.name ?? "").trim();
  const bn = (b.name ?? "").trim();
  if (an === "" && bn === "") return compareText(a.barcode, b.barcode);
  if (an === "") return 1;
  if (bn === "") return -1;
  return compareText(an, bn);
}

export function afterSearchAndStock(items: readonly Medication[], view: Pick<OracleView, "search" | "stock">): Medication[] {
  return items.filter((item) => {
    if (!matchesSearch(item, view.search)) return false;
    if (view.stock === "low") return isLow(item);
    if (view.stock === "ok") return !isLow(item);
    return true;
  });
}

function inCategory(item: Medication, filter: OracleCategory, categories: readonly Category[]): boolean {
  const bucket = bucketOf(item, categories);
  switch (filter.kind) {
    case "all":
      return true;
    case "uncategorized":
      return bucket.kind === "uncategorized";
    case "unknown":
      return bucket.kind === "unknown";
    case "category":
      return bucket.kind === "category" && sameId(bucket.id, filter.id);
  }
}

function sortItems(items: readonly Medication[], sort: OracleSort, categories: readonly Category[]): Medication[] {
  const copy = [...items];
  copy.sort((a, b) => {
    if (sort === "stock-asc") return a.stock - b.stock || compareNames(a, b);
    if (sort === "category") {
      return bucketRank(bucketOf(a, categories), categories) - bucketRank(bucketOf(b, categories), categories) || compareNames(a, b);
    }
    return compareNames(a, b);
  });
  return copy;
}

/** The items the list must show, in the order it must show them when it is a flat list. */
export function expectedVisible(items: readonly Medication[], categories: readonly Category[], view: OracleView): Medication[] {
  const filtered = afterSearchAndStock(items, view).filter((item) => inCategory(item, view.category, categories));
  return sortItems(filtered, view.sort, categories);
}

/** "item" for exactly one, "items" for every other number (including 0): the word that follows a count on screen. */
export const itemsWord = (total: number): string => (total === 1 ? "item" : "items");

export type ExpectedGroup = { key: string; title: string; ids: number[] };

/** The headings the grouped list must show, with their item ids in order. A heading reads "<title> · <n> item(s)" (see itemsWord). */
export function expectedGroups(items: readonly Medication[], categories: readonly Category[], view: OracleView): ExpectedGroup[] {
  const visible = expectedVisible(items, categories, view);
  const byKey = new Map<string, ExpectedGroup>();
  for (const item of visible) {
    const bucket = bucketOf(item, categories);
    const key = bucket.kind === "category" ? bucket.id : bucket.kind;
    const title = bucket.kind === "category" ? bucket.title : bucket.kind === "unknown" ? UNAVAILABLE_TITLE : UNCATEGORIZED_TITLE;
    const group = byKey.get(key) ?? { key, title, ids: [] };
    group.ids.push(item.id);
    byKey.set(key, group);
  }
  const groups = [...byKey.values()];
  const rank = (group: ExpectedGroup): number => (group.key === "uncategorized" ? 2 : group.key === "unknown" ? 1 : 0);
  groups.sort((a, b) => rank(a) - rank(b) || compareText(a.title, b.title));
  return groups;
}

export type ExpectedCounts = { all: number; uncategorized: number; unknown: number; byId: Record<string, number> };

/** The numbers on the chips: they follow search and stock, never the category filter. */
export function expectedCounts(items: readonly Medication[], categories: readonly Category[], view: Pick<OracleView, "search" | "stock">): ExpectedCounts {
  const pool = afterSearchAndStock(items, view);
  const counts: ExpectedCounts = { all: pool.length, uncategorized: 0, unknown: 0, byId: {} };
  for (const category of categories) counts.byId[category.id] = 0;
  for (const item of pool) {
    const bucket = bucketOf(item, categories);
    if (bucket.kind === "uncategorized") counts.uncategorized += 1;
    else if (bucket.kind === "unknown") counts.unknown += 1;
    else counts.byId[bucket.id] += 1;
  }
  return counts;
}

const cleanSearch = (search: string): string => search.trim().replace(/\s+/g, " ");

/** The words of the filters that are on, in the order the summary lists them: Category, Stock, Search. */
export function filterWords(view: OracleView, categories: readonly Category[]): string[] {
  const words: string[] = [];
  if (view.category.kind === "uncategorized") words.push(`Category: ${UNCATEGORIZED_TITLE}`);
  else if (view.category.kind === "unknown") words.push(`Category: ${UNAVAILABLE_TITLE}`);
  else if (view.category.kind === "category") {
    const id = view.category.id;
    const found = categories.find((category) => sameId(category.id, id));
    words.push(`Category: ${found ? found.name.trim() : UNAVAILABLE_TITLE}`);
  }
  if (view.stock === "low") words.push("Stock: Low");
  if (view.stock === "ok") words.push("Stock: Adequate");
  const search = cleanSearch(view.search);
  if (search !== "") words.push(`Search “${search}”`);
  return words;
}

/** The results line, e.g. "Showing 9 of 38 items · Category: Antibiotics" or "Showing all 38 items." */
export function expectedSummary(total: number, shown: number, view: OracleView, categories: readonly Category[]): string {
  const words = filterWords(view, categories);
  if (words.length === 0) return `Showing all ${total} ${itemsWord(total)}.`;
  return [`Showing ${shown} of ${total} ${itemsWord(total)}`, ...words].join(SEPARATOR);
}

/**
 * The line under the list (only drawn while there are rows). With no filter it repeats "Showing all 38 items."; with filters it
 * also says how many items they hide, in the singular for one: "Showing 1 of 2 items. 1 item is hidden by the filters above."
 */
export function expectedFooter(total: number, shown: number, view: OracleView, categories: readonly Category[]): string {
  if (filterWords(view, categories).length === 0) return `Showing all ${total} ${itemsWord(total)}.`;
  const hidden = total - shown;
  return `Showing ${shown} of ${total} ${itemsWord(total)}. ${hidden} ${hidden === 1 ? "item is" : "items are"} hidden by the filters above.`;
}

export type ExpectedEmpty = { kind: "no-items" | "category-empty" | "no-match"; title: string };

/** What the list says when nothing is left to show. */
export function expectedEmpty(total: number, view: OracleView, categories: readonly Category[]): ExpectedEmpty {
  if (total === 0) return { kind: "no-items", title: "No items in the inventory yet." };
  const words = filterWords(view, categories);
  if (view.category.kind !== "all" && cleanSearch(view.search) === "" && view.stock === "all") {
    const label = (words[0] ?? "").replace(/^Category: /, "");
    return { kind: "category-empty", title: `No items in ${label} yet.` };
  }
  return { kind: "no-match", title: `No items match ${words.join(SEPARATOR)}.` };
}

/** Status text of an item's pill: Out (no stock), Low (at or below the threshold) or OK. */
export function expectedStatus(item: Medication): "out" | "low" | "ok" {
  if (item.stock === 0) return "out";
  return item.stock <= item.threshold ? "low" : "ok";
}

// Small pure helpers for the Inventory tab. No React, no fetch.
//
// Category ids are opaque strings (uuid in the live database, digit strings for the bigint schema). They are only
// ever compared as strings; nothing in here calls Number() on them.

import type { Category, Medication } from "@/lib/db";
import {
  UNKNOWN_CATEGORY_ID,
  isUnknownCategoryFilter,
  naturalCompare,
  type ItemGroup,
  type ViewState,
} from "@/lib/inventory-view";

export type StockStatus = "out" | "low" | "ok";

/** The rule the old cards used: 0 is Out, at or below the threshold is Low, everything else is OK. */
export function stockStatus(item: Pick<Medication, "stock" | "threshold">): StockStatus {
  if (item.stock === 0) return "out";
  return item.stock <= item.threshold ? "low" : "ok";
}

export function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * One press, one action. Enter on a button "clicks" it on keydown, and a key that is HELD sends a keydown with `repeat` set
 * every few dozen milliseconds, each of which would click again. That is harmless for a button that stays as it is, but not
 * for one that changes what is on screen: a disclosure flips open and shut on every repeat, and a button that moves keyboard
 * focus as it acts (Undo -> Dismiss, a category chip -> the "Category" button) hands the key to the NEXT button, whose
 * handler then runs too. Cancelling the repeats (preventDefault on keydown also cancels the click) makes a held Enter press
 * once; a new press is a new keydown and works as usual. (ActiveFilterChips does the same for its own buttons.)
 * Use as `onKeyDown={ignoreHeldEnter}` on a button, or on a wrapper around several.
 */
export function ignoreHeldEnter(event: { key: string; repeat: boolean; preventDefault(): void }): void {
  if (event.repeat && event.key === "Enter") event.preventDefault();
}

/** Comparison key for a category id, written exactly like the view logic does it: trimmed, lower-cased, blank = null. */
export function idKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const key = String(value).trim().toLowerCase();
  return key === "" ? null : key;
}

export type CategoryOption = { id: string; key: string; title: string };

const UNNAMED_CATEGORY_TITLE = "Unnamed category";

/**
 * The categories in the order the chips and the groups use: natural, case-insensitive title order, ties by list
 * position. Same filtering as lib/inventory-view.ts: blank ids, the reserved "unknown" id and repeated ids are left
 * out (an item can never point at them, so a chip for them would always read 0).
 */
export function orderCategories(categories: readonly Category[]): CategoryOption[] {
  const seen = new Set<string>();
  const entries: Array<CategoryOption & { position: number }> = [];
  categories.forEach((category, position) => {
    const key = idKey(category.id);
    if (key === null || key === UNKNOWN_CATEGORY_ID || seen.has(key)) return;
    seen.add(key);
    const name = typeof category.name === "string" ? category.name.trim() : "";
    entries.push({ id: String(category.id), key, title: name === "" ? UNNAMED_CATEGORY_TITLE : name, position });
  });
  entries.sort((a, b) => naturalCompare(a.title, b.title) || a.position - b.position);
  return entries.map(({ id, key, title }) => ({ id, key, title }));
}

/** Same three kinds the view logic gives its groups. */
export type CategoryKind = ItemGroup["kind"];
export type CategoryLabel = { kind: CategoryKind; title: string };

/** What an item's category tag says: its category name, "Category unavailable" or "Uncategorized". Never blank. */
export function categoryLabelFor(
  item: Pick<Medication, "category_id">,
  titleByKey: ReadonlyMap<string, string>
): CategoryLabel {
  const key = idKey(item.category_id);
  if (key === null) return { kind: "uncategorized", title: "Uncategorized" };
  const title = titleByKey.get(key);
  return title === undefined ? { kind: "unknown", title: "Category unavailable" } : { kind: "category", title };
}

/** The item's name, or null when it has none (blank counts as none). */
export function displayName(item: Pick<Medication, "name">): string | null {
  if (typeof item.name !== "string") return null;
  const name = item.name.trim();
  return name === "" ? null : name;
}

/**
 * What an order sheet row remembers about its item, so a row whose item is deleted later can still say which item it was.
 * The same rule the Order sheet page uses for the names it remembers (and buildSheet() for the printed name): the item's
 * name, or "Unnamed item (barcode …)" when it has none.
 */
export function rememberedName(item: Pick<Medication, "name" | "barcode">): string {
  return displayName(item) ?? `Unnamed item (barcode ${item.barcode})`;
}

// ── Active filters (the chips under the toolbar) ──────────────────────────────────────────────────────────────

const OPEN_QUOTE = "“";
const CLOSE_QUOTE = "”";

// Characters that render as nothing (zero-width spaces and joiners, soft hyphen, direction marks, variation selectors...).
// The same set lib/inventory-view.ts ignores in a search, so the chip and the summary line quote the same text.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * The search as the summary line quotes it: invisible characters dropped, trimmed, inner whitespace collapsed to single
 * spaces. "" means "no search" (and then there is no Search chip either).
 */
export function searchChipText(search: unknown): string {
  return typeof search === "string" ? search.replace(INVISIBLE, "").trim().replace(/\s+/g, " ") : "";
}

/** One applied filter, as the chips show it. `key` doubles as the chip's test id suffix. */
export type ActiveFilterSpec = { key: "category" | "stock" | "search"; label: string; value: string };

/**
 * The filters that are on, in the order the summary line lists them: Category, Stock, Search. A filter that is not
 * narrowing the list (All, stock All, an empty search) has no entry. Category values: the category's name,
 * "Uncategorized", or "Category unavailable" (the pseudo category, or an id the list cannot name).
 */
export function describeActiveFilters(view: ViewState, titleByKey: ReadonlyMap<string, string>): ActiveFilterSpec[] {
  const specs: ActiveFilterSpec[] = [];
  const category = view.category;
  if (category.kind === "uncategorized") {
    specs.push({ key: "category", label: "Category", value: "Uncategorized" });
  } else if (category.kind === "category") {
    const key = isUnknownCategoryFilter(category) ? null : idKey(category.id);
    const title = key === null ? undefined : titleByKey.get(key);
    specs.push({ key: "category", label: "Category", value: title ?? "Category unavailable" });
  }
  if (view.stock === "low") specs.push({ key: "stock", label: "Stock", value: "Low" });
  else if (view.stock === "ok") specs.push({ key: "stock", label: "Stock", value: "Adequate" });
  const search = searchChipText(view.search);
  if (search !== "") specs.push({ key: "search", label: "Search", value: `${OPEN_QUOTE}${search}${CLOSE_QUOTE}` });
  return specs;
}

/**
 * A link target that is safe to put in href: only http(s). A bare "shop.example.com/reorder" is read as https.
 * Anything else (javascript:, mailto:, plain text) yields null and the row shows no link.
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "") return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    // not an absolute URL; try the bare-domain form below
  }
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text)) {
    try {
      return new URL(`https://${text}`).toString();
    } catch {
      return null;
    }
  }
  return null;
}

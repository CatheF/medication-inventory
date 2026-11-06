// Small pure helpers for the Inventory tab. No React, no fetch.
//
// Category ids are opaque strings (uuid in the live database, digit strings for the bigint schema). They are only
// ever compared as strings; nothing in here calls Number() on them.

import type { Category, Medication } from "@/lib/db";
import { categoryTitles, idKey } from "@/lib/filter-chips";
import { naturalCompare, type ItemGroup } from "@/lib/inventory-view";
import { safeHttpUrl } from "@/lib/safe-url";

export type StockStatus = "out" | "low" | "ok";

/** The stock status rule: 0 is Out, at or below the threshold is Low, everything else is OK. */
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

// The comparison key for a category id (trimmed, lower-cased, blank = null) is defined once, in lib/filter-chips.ts, because the
// filter chips on both screens need it too. It is re-exported so the Inventory components can import it from here.
export { idKey };

// The link guard (http and https only) is defined in lib/safe-url.ts because the API applies the same rule when it stores a
// vendor link or a photo address. It is re-exported so the Inventory components can import it from here.
export { safeHttpUrl };

export type CategoryOption = { id: string; key: string; title: string };

/**
 * The categories in the order the chips and the groups use: natural, case-insensitive title order, ties by list
 * position. Which categories count, and what each one is called, comes from categoryTitles (lib/filter-chips.ts): blank ids,
 * the reserved "unknown" id and repeated ids are left out (an item can never point at them, so a chip for them would always
 * read 0), and a blank name reads "Unnamed category". The same rules as lib/inventory-view.ts.
 */
export function orderCategories(categories: readonly Category[]): CategoryOption[] {
  const entries = categoryTitles(categories);
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

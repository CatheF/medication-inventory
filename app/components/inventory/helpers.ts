// Small pure helpers for the Inventory tab. No React, no fetch.
//
// Category ids are opaque strings (uuid in the live database, digit strings for the bigint schema). They are only
// ever compared as strings; nothing in here calls Number() on them.

import type { Category, Medication } from "@/lib/db";
import { UNKNOWN_CATEGORY_ID, naturalCompare, type ItemGroup } from "@/lib/inventory-view";

export type StockStatus = "out" | "low" | "ok";

/** The rule the old cards used: 0 is Out, at or below the threshold is Low, everything else is OK. */
export function stockStatus(item: Pick<Medication, "stock" | "threshold">): StockStatus {
  if (item.stock === 0) return "out";
  return item.stock <= item.threshold ? "low" : "ok";
}

export function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
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

// Pure logic behind <Combobox> (app/components/Combobox.tsx): which options a typed query keeps, how the highlighted
// option moves, which option is highlighted when the list opens, what the screen-reader status line says, whether the
// second click of a double-click on an option is swallowed, and where the popup goes. No React, no DOM, no fetch.
// Nothing here mutates its inputs and every function returns new arrays.
//
// The searchable picker replaces a native <select> once a list is long. Callers switch with
// shouldUseCombobox(realOptionCount): a native select up to 10 real options, the Combobox from 11.

import { foldSearchText } from "./search-text";

// ── Public types ────────────────────────────────────────────────────────────────

/** Callers switch from a native <select> to the Combobox when they have at least this many real options. */
export const COMBOBOX_MIN_OPTIONS = 11;

/**
 * `value` is what the caller stores ("" is a legitimate value, for example "Uncategorized"); `label` is what people read
 * and search. `description` is an optional second line that is searched too. `kind: "action"` marks a command that is
 * listed with the options ("+ Create new category…"): choosing it reports its `value` like any option and the caller
 * decides what it means; an action is never filtered out.
 */
export type ComboboxOption = { value: string; label: string; description?: string; kind?: "option" | "action" };

/** The keys that move the highlighted option. */
export type ActiveKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/** True when a list of `realOptionCount` options (actions such as "+ Create…" excluded) should use the Combobox. */
export function shouldUseCombobox(realOptionCount: number): boolean {
  return Number.isFinite(realOptionCount) && realOptionCount >= COMBOBOX_MIN_OPTIONS;
}

// ── Search folding ──────────────────────────────────────────────────────────────

// The SAME folding as the Inventory search (foldSearchText in lib/search-text.ts, the one definition both share: invisible
// characters dropped, look-alike forms equal, accents ignored, lower case; tests/unit/combobox.test.ts still compares the two
// searches so they cannot drift apart). On top of that, whitespace runs become one space and the ends are trimmed.

/**
 * Case- and accent-insensitive search form of `text`: invisible and format characters removed, NFKC, lower case, accents
 * dropped, whitespace collapsed to single spaces, trimmed. "" means "nothing to search for".
 */
export function foldForSearch(text: string): string {
  return foldSearchText(text).replace(/\s+/g, " ").trim();
}

function searchTerms(query: string): string[] {
  const folded = foldForSearch(query);
  return folded === "" ? [] : folded.split(" ");
}

function matchesTerms(option: ComboboxOption, terms: readonly string[]): boolean {
  const label = typeof option.label === "string" ? option.label : "";
  const description = typeof option.description === "string" ? option.description : "";
  // One haystack with a single space between label and description. Terms never contain whitespace, so a term cannot
  // match across the join, and a term may be found in either part.
  const haystack = foldForSearch(description === "" ? label : `${label} ${description}`);
  return terms.every((term) => haystack.includes(term));
}

/**
 * The options a typed query keeps. Every whitespace-separated term of the query must occur in the folded label or
 * description (any order, any of the two fields). An empty query, one made of spaces, or one made only of invisible
 * characters keeps everything. Options with kind "action" are NEVER filtered out: they come last, in their own
 * relative order, after the matching regular options (which keep their order). The result is a new array of the same
 * option objects; `options` is never changed.
 */
export function filterOptions<T extends ComboboxOption>(options: readonly T[], query: string): T[] {
  const terms = searchTerms(query);
  const kept: T[] = [];
  const actions: T[] = [];
  for (const option of options) {
    if (option.kind === "action") actions.push(option);
    else if (terms.length === 0 || matchesTerms(option, terms)) kept.push(option);
  }
  return actions.length === 0 ? kept : kept.concat(actions);
}

// ── Highlighted option ──────────────────────────────────────────────────────────

/**
 * Where the highlight goes for a key press. `current` is the highlighted index, -1 for none; `count` is how many
 * options are listed. ArrowDown from none goes to the first option, ArrowUp from none to the last; both wrap around at
 * the ends; Home and End go to the first and the last. An empty list gives -1. The answer is always -1 or a valid
 * index: a `current` that is not a valid index for `count` (negative, too large, fractional, NaN) counts as none.
 */
export function moveActive(current: number, count: number, key: ActiveKey): number {
  if (!Number.isInteger(count) || count <= 0) return -1;
  const from = Number.isInteger(current) && current >= 0 && current < count ? current : -1;
  switch (key) {
    case "ArrowDown":
      return from === -1 ? 0 : (from + 1) % count;
    case "ArrowUp":
      return from === -1 ? count - 1 : (from - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return from; // not one of the four keys (an untyped caller): leave the highlight where it is
  }
}

/** The first option with this value (any kind), or undefined. "" is a value like any other. */
export function findOptionByValue<T extends ComboboxOption>(options: readonly T[], value: string): T | undefined {
  return options.find((option) => option.value === value);
}

/** Index of `selected` in the listed `results` (same object), or -1: the option that starts highlighted when the list opens. */
export function initialActiveIndex(results: readonly ComboboxOption[], selected: ComboboxOption | undefined): number {
  return selected === undefined ? -1 : results.indexOf(selected);
}

/**
 * Enter with nothing highlighted: when the query leaves exactly ONE regular option, that is the one meant, so its
 * index is returned; otherwise -1. Actions never count (typing a name must not trigger "+ Create new…" by accident).
 */
export function singleMatchIndex(results: readonly ComboboxOption[]): number {
  let found = -1;
  for (let index = 0; index < results.length; index += 1) {
    if (results[index].kind === "action") continue;
    if (found !== -1) return -1;
    found = index;
  }
  return found;
}

/**
 * The line a screen reader hears after the list is filtered: "3 results", "1 result", or `emptyText` when no regular
 * option is left (an action does not count as a result: it is a command, not a match).
 */
export function resultsMessage(results: readonly ComboboxOption[], emptyText: string): string {
  let count = 0;
  for (const option of results) if (option.kind !== "action") count += 1;
  if (count === 0) return emptyText;
  return count === 1 ? "1 result" : `${count} results`;
}

// ── Double-click on an option ───────────────────────────────────────────────────

/** Whether to stop one pointer event, and whether the guard stays armed for the next one. */
export type RepeatClickStep = { swallow: boolean; armed: boolean };

/**
 * The popup closes on the first click of a pick, so the SECOND click of a double-click (or a triple-click) would land on
 * whatever lies under the popup: a button, a checkbox, a link, some text that then gets selected. A native <select> does
 * not do that, and the Combobox is meant to be a drop-in for one. After a pointer pick the component arms this guard and
 * feeds it every mousedown / mouseup / click / dblclick (type and `detail`, the browser's click count) until it disarms:
 *   - armed and `detail` > 1: the browser counts clicks itself (same spot, inside the system's double-click time), so the
 *     event belongs to the multi-click that began at the pick. Swallow it, whatever the person's double-click speed.
 *   - armed, a mousedown and `detail` <= 1: a NEW click sequence begins (a deliberate click elsewhere, or a second click
 *     that came too late to count). The guard disarms and the event goes through, and so does everything after it: a
 *     double-click on another control right after a pick works.
 *   - armed, anything else (a mouseup or click that counts as a first click, a keyboard click with detail 0): let it
 *     through and stay armed.
 *   - not armed: nothing is ever swallowed.
 * There is no clock in here; the component adds a timeout that disarms the guard, so it can never outlive one gesture.
 */
export function repeatClickGuard(armed: boolean, type: string, detail: number): RepeatClickStep {
  if (!armed) return { swallow: false, armed: false };
  if (detail > 1) return { swallow: true, armed: true };
  return { swallow: false, armed: type !== "mousedown" };
}

// ── Popup placement ─────────────────────────────────────────────────────────────

/** The input's box in viewport coordinates (what getBoundingClientRect() reports). */
export type AnchorBox = { top: number; left: number; bottom: number; width: number };

/**
 * What the popup may use, in the same coordinates. left/top/width/height describe the VISIBLE area (the visual
 * viewport: smaller while the on-screen keyboard is up or the page is pinch-zoomed); layoutHeight is the height the
 * `bottom` offset of a fixed element is measured from.
 */
export type ViewportBox = { left: number; top: number; width: number; height: number; layoutHeight: number };

export type PopupPlacement = {
  side: "below" | "above";
  left: number;
  width: number;
  /** Fixed `top` offset when the popup opens below the input, otherwise null. */
  top: number | null;
  /** Fixed `bottom` offset when the popup opens above the input, otherwise null. */
  bottom: number | null;
  /** The tallest the popup may be on that side. */
  maxHeight: number;
};

export type PlacementOptions = {
  /** Space between input and popup (default 4). */
  gap?: number;
  /** Space kept free at the viewport edges (default 8). */
  margin?: number;
  /** Tallest the popup ever gets (default 258: a 256px list plus its border). */
  preferredHeight?: number;
  /**
   * The popup is never shorter than this (default 48: about one option row). It only matters on a very short screen: the
   * popup shrinks to the room that is left and stops here, so it can only run past the visible area when the room on
   * BOTH sides of the input is smaller than this. A fixed popup cannot be scrolled into view, and a row that sits
   * outside the screen cannot be reached, so the floor must stay small.
   */
  minHeight?: number;
  /** The popup is at least this wide even over a narrow input (default 192). */
  minWidth?: number;
};

/**
 * Where a position:fixed popup goes under (or, when there is no room, over) its input. It opens below when there is
 * room for a comfortable list (200px, or the preferred height when that is smaller) or at least as much room as above;
 * otherwise above. The height shrinks to the room on that side, down to `minHeight`; a screen too short even for that
 * overhangs by the missing amount and no more. Horizontally it matches the input's width and is pulled back inside the
 * viewport.
 */
export function placePopup(anchor: AnchorBox, viewport: ViewportBox, options: PlacementOptions = {}): PopupPlacement {
  const gap = options.gap ?? 4;
  const margin = options.margin ?? 8;
  const preferredHeight = options.preferredHeight ?? 258;
  const minHeight = Math.min(options.minHeight ?? 48, preferredHeight);
  const minWidth = options.minWidth ?? 192;

  const spaceBelow = viewport.top + viewport.height - anchor.bottom - gap - margin;
  const spaceAbove = anchor.top - viewport.top - gap - margin;
  const comfortable = Math.min(preferredHeight, 200);
  const below = spaceBelow >= comfortable || spaceBelow >= spaceAbove;
  const room = below ? spaceBelow : spaceAbove;
  const maxHeight = Math.max(Math.min(preferredHeight, room), minHeight);

  const available = Math.max(viewport.width - 2 * margin, 0);
  const width = Math.min(Math.max(anchor.width, minWidth), available);
  const leftEdge = viewport.left + margin;
  const rightEdge = viewport.left + viewport.width - margin - width;
  const left = Math.max(leftEdge, Math.min(anchor.left, rightEdge));

  return {
    side: below ? "below" : "above",
    left,
    width,
    top: below ? anchor.bottom + gap : null,
    bottom: below ? null : viewport.layoutHeight - anchor.top + gap,
    maxHeight,
  };
}

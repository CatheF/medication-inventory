"use client";

import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  UNKNOWN_CATEGORY_FILTER,
  UNKNOWN_CATEGORY_ID,
  isUnknownCategoryFilter,
  type CategoryCounts,
  type CategoryFilter,
} from "@/lib/inventory-view";
import { CheckIcon, ChevronIcon, WarnIcon } from "./Icons";
import { idKey, ignoreHeldEnter, type CategoryOption } from "./helpers";

type CategoryChipsProps = {
  categories: readonly CategoryOption[];
  counts: CategoryCounts;
  selected: CategoryFilter;
  onSelect: (filter: CategoryFilter) => void;
  /** id of the element that names the group (the "Category" label) */
  labelledBy: string;
};

type Variant = "normal" | "dashed" | "warning";

/** With more chips than this (All, every category, Uncategorized, Category unavailable) a phone gets a button instead of the chip rows. */
export const MAX_INLINE_CHIPS = 8;

const PANEL_ID = "inventory-category-panel";

function chipClass(pressed: boolean, variant: Variant): string {
  const base =
    "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-[15px] font-semibold transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700";
  if (pressed) return `${base} border-blue-700 bg-blue-700 text-white hover:bg-blue-800`;
  if (variant === "warning") return `${base} border-dashed border-amber-600 bg-amber-50 text-amber-900 hover:bg-amber-100`;
  if (variant === "dashed") return `${base} border-dashed border-gray-500 bg-white text-gray-800 hover:bg-gray-50`;
  return `${base} border-gray-400 bg-white text-gray-800 hover:bg-gray-50`;
}

function Chip({
  testId,
  label,
  count,
  pressed,
  variant = "normal",
  onClick,
}: {
  testId: string;
  label: string;
  count: number;
  pressed: boolean;
  variant?: Variant;
  onClick: () => void;
}) {
  return (
    <button type="button" data-testid={testId} aria-pressed={pressed} onClick={onClick} className={chipClass(pressed, variant)}>
      {pressed ? <CheckIcon className="h-4 w-4" /> : variant === "warning" ? <WarnIcon className="h-4 w-4" /> : null}
      {/* One text run ("Antibiotics (6)"): the name and the number stay together for screen readers and wrapping. */}
      <span className="[overflow-wrap:anywhere]">
        {label}{" "}
        <span className={`font-medium tabular-nums ${pressed ? "text-blue-100" : "text-gray-600"}`}>({count})</span>
      </span>
    </button>
  );
}

/**
 * Category chips: All, every category, Uncategorized, and "Category unavailable" while it has items (or is
 * selected, so a selected chip never vanishes). Numbers reflect the current search and stock filter.
 * Choosing the chip that is already selected keeps it selected (this is a single choice, not a toggle).
 *
 * PHONE VERSION (more than MAX_INLINE_CHIPS chips): below 640px the wrapping chip rows would fill the screen, so they are
 * replaced by one button, "Category: Antibiotics (6)", that opens a panel holding the very same chips. The switch is pure
 * CSS (Tailwind's sm: breakpoint), never a JavaScript media query, so the server render and the first client render agree.
 * That means ONE set of chips in the page: the panel is `display:none` on a phone until it is opened (and so is out of the
 * Tab order), and always shown from 640px up, where the button is hidden. With 8 chips or fewer nothing changes.
 *   - The button is a disclosure: aria-expanded and aria-controls (the panel).
 *   - Choosing a chip applies it, closes the panel and puts focus on the button (the chip that had it is gone).
 *   - Escape closes the panel and puts focus back on the button.
 *   - A held Enter presses ONE control (a chip, or the button), not each one focus lands on in turn (ignoreHeldEnter).
 * The applied filter stays visible as a removable chip under the toolbar (ActiveFilterChips), whether the panel is open or not.
 */
export function CategoryChips({ categories, counts, selected, onSelect, labelledBy }: CategoryChipsProps) {
  const selectedKey = selected.kind === "category" && !isUnknownCategoryFilter(selected) ? idKey(selected.id) : null;
  const unknownSelected = isUnknownCategoryFilter(selected);
  const showUnknown = counts.unknown > 0 || unknownSelected;
  const collapsible = categories.length + 2 + (showUnknown ? 1 : 0) > MAX_INLINE_CHIPS;

  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const select = (filter: CategoryFilter) => {
    onSelect(filter);
    if (collapsible && open) {
      setOpen(false);
      // The chip that was pressed is hidden now. (From 640px up the button is hidden too and focus() does nothing, so the
      // chip keeps focus there: the panel is not a popup on a wide screen.)
      toggleRef.current?.focus();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // One press, one action: a held Enter would press the chip (which closes the panel and moves focus to the button), then the
    // button (which opens the panel again), and so on. The button flips the panel on every repeat as well.
    ignoreHeldEnter(event);
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    toggleRef.current?.focus();
  };

  const chips = (
    <>
      <Chip
        testId="category-chip-all"
        label="All"
        count={counts.all}
        pressed={selected.kind === "all"}
        onClick={() => select({ kind: "all" })}
      />
      {categories.map((category) => (
        <Chip
          key={category.key}
          testId={`category-chip-${category.id}`}
          label={category.title}
          count={counts.byId[category.id] ?? 0}
          pressed={selectedKey === category.key}
          onClick={() => select({ kind: "category", id: category.id })}
        />
      ))}
      <Chip
        testId="category-chip-uncategorized"
        label="Uncategorized"
        count={counts.uncategorized}
        pressed={selected.kind === "uncategorized"}
        variant="dashed"
        onClick={() => select({ kind: "uncategorized" })}
      />
      {showUnknown && (
        <Chip
          testId={`category-chip-${UNKNOWN_CATEGORY_ID}`}
          label="Category unavailable"
          count={counts.unknown}
          pressed={unknownSelected}
          variant="warning"
          onClick={() => select(UNKNOWN_CATEGORY_FILTER)}
        />
      )}
    </>
  );

  if (!collapsible) {
    return (
      <div role="group" aria-labelledby={labelledBy} className="flex flex-wrap gap-2">
        {chips}
      </div>
    );
  }

  const current = selectionSummary(selected, categories, counts);
  return (
    <div onKeyDown={handleKeyDown}>
      <button
        ref={toggleRef}
        type="button"
        data-testid="category-filter-toggle"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        onClick={() => setOpen((previous) => !previous)}
        className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-[10px] border bg-white px-3 py-2 text-left text-base text-gray-900 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-700 sm:hidden ${
          open ? "border-blue-700" : "border-gray-400"
        }`}
      >
        <span className="min-w-0 [overflow-wrap:anywhere]">
          Category: <strong className="font-semibold">{current.label}</strong>{" "}
          <span className="font-medium tabular-nums text-gray-600">({current.count})</span>
        </span>
        <ChevronIcon
          className={`h-[18px] w-[18px] text-gray-600 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div
        id={PANEL_ID}
        role="group"
        aria-labelledby={labelledBy}
        data-testid="category-filter-panel"
        className={`flex-wrap gap-2 ${open ? "mt-2 flex sm:mt-0" : "hidden sm:flex"}`}
      >
        {chips}
      </div>
    </div>
  );
}

/** What the phone button says about the current choice: its name and the number its chip shows. */
function selectionSummary(
  selected: CategoryFilter,
  categories: readonly CategoryOption[],
  counts: CategoryCounts
): { label: string; count: number } {
  if (selected.kind === "all") return { label: "All", count: counts.all };
  if (selected.kind === "uncategorized") return { label: "Uncategorized", count: counts.uncategorized };
  if (isUnknownCategoryFilter(selected)) return { label: "Category unavailable", count: counts.unknown };
  const key = idKey(selected.id);
  const category = key === null ? undefined : categories.find((option) => option.key === key);
  // An id the list cannot name reads as "Category unavailable", the same as the summary line and the chip under the toolbar.
  return category === undefined
    ? { label: "Category unavailable", count: 0 }
    : { label: category.title, count: counts.byId[category.id] ?? 0 };
}

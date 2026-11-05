"use client";

import {
  UNKNOWN_CATEGORY_FILTER,
  UNKNOWN_CATEGORY_ID,
  isUnknownCategoryFilter,
  type CategoryCounts,
  type CategoryFilter,
} from "@/lib/inventory-view";
import { CheckIcon, WarnIcon } from "./Icons";
import { idKey, type CategoryOption } from "./helpers";

type CategoryChipsProps = {
  categories: readonly CategoryOption[];
  counts: CategoryCounts;
  selected: CategoryFilter;
  onSelect: (filter: CategoryFilter) => void;
  /** id of the element that names the group (the "Category" label) */
  labelledBy: string;
};

type Variant = "normal" | "dashed" | "warning";

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
 */
export function CategoryChips({ categories, counts, selected, onSelect, labelledBy }: CategoryChipsProps) {
  const selectedKey = selected.kind === "category" && !isUnknownCategoryFilter(selected) ? idKey(selected.id) : null;
  const unknownSelected = isUnknownCategoryFilter(selected);

  return (
    <div role="group" aria-labelledby={labelledBy} className="flex flex-wrap gap-2">
      <Chip
        testId="category-chip-all"
        label="All"
        count={counts.all}
        pressed={selected.kind === "all"}
        onClick={() => onSelect({ kind: "all" })}
      />
      {categories.map((category) => (
        <Chip
          key={category.key}
          testId={`category-chip-${category.id}`}
          label={category.title}
          count={counts.byId[category.id] ?? 0}
          pressed={selectedKey === category.key}
          onClick={() => onSelect({ kind: "category", id: category.id })}
        />
      ))}
      <Chip
        testId="category-chip-uncategorized"
        label="Uncategorized"
        count={counts.uncategorized}
        pressed={selected.kind === "uncategorized"}
        variant="dashed"
        onClick={() => onSelect({ kind: "uncategorized" })}
      />
      {(counts.unknown > 0 || unknownSelected) && (
        <Chip
          testId={`category-chip-${UNKNOWN_CATEGORY_ID}`}
          label="Category unavailable"
          count={counts.unknown}
          pressed={unknownSelected}
          variant="warning"
          onClick={() => onSelect(UNKNOWN_CATEGORY_FILTER)}
        />
      )}
    </div>
  );
}

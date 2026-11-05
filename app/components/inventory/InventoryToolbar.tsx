"use client";

import Link from "next/link";
import type { CategoryCounts, CategoryFilter, SortKey, StockFilter, ViewState } from "@/lib/inventory-view";
import { CategoryChips } from "./CategoryChips";
import { CheckIcon, ChevronIcon, SearchIcon } from "./Icons";
import type { CategoryOption } from "./helpers";
import { SEARCH_MAX_LENGTH } from "./view-state";

type InventoryToolbarProps = {
  view: ViewState;
  categories: readonly CategoryOption[];
  counts: CategoryCounts;
  onChange: (patch: Partial<ViewState>) => void;
};

const STOCK_OPTIONS: ReadonlyArray<{ value: StockFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "low", label: "Low" },
  { value: "ok", label: "Adequate" },
];

const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "name", label: "Name" },
  { value: "stock-asc", label: "Lowest stock" },
  { value: "category", label: "Category" },
];

const FIELD_LABEL = "mb-1.5 block text-base font-semibold text-gray-900";
const CONTROL =
  "min-h-11 w-full rounded-[10px] border border-gray-400 bg-white py-2 text-base text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-700";

function isSortKey(value: string): value is SortKey {
  return value === "name" || value === "stock-asc" || value === "category";
}

/**
 * Category chips, the "Group by category" switch, search, stock level, sort and "+ Add".
 * Every control has a visible label; every control is at least 44px tall.
 */
export function InventoryToolbar({ view, categories, counts, onChange }: InventoryToolbarProps) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p id="inventory-category-label" className="text-base font-semibold text-gray-900">
          Category
        </p>
        <label className="relative inline-flex min-h-11 cursor-pointer items-center gap-3 font-semibold text-gray-900">
          <input
            type="checkbox"
            role="switch"
            data-testid="group-toggle"
            checked={view.grouped}
            onChange={(event) => onChange({ grouped: event.target.checked })}
            className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
          <span
            aria-hidden="true"
            className="relative h-[30px] w-[50px] shrink-0 rounded-full bg-gray-500 transition-colors peer-checked:bg-blue-700 peer-focus-visible:outline-[3px] peer-focus-visible:outline-offset-2 peer-focus-visible:outline-blue-700 after:absolute after:top-[3px] after:left-[3px] after:h-6 after:w-6 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5 motion-reduce:transition-none motion-reduce:after:transition-none"
          />
          <span>Group by category</span>
          <span aria-hidden="true" className="min-w-7 text-sm font-bold text-gray-600">
            {view.grouped ? "On" : "Off"}
          </span>
        </label>
      </div>

      <div className="mt-2">
        <CategoryChips
          categories={categories}
          counts={counts}
          selected={view.category}
          onSelect={(category: CategoryFilter) => onChange({ category })}
          labelledBy="inventory-category-label"
        />
      </div>

      <div className="mt-5 flex flex-wrap items-end gap-x-5 gap-y-4">
        <div className="min-w-[240px] flex-1 basis-64">
          <label htmlFor="inventory-search" className={FIELD_LABEL}>
            Search
          </label>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-[18px] w-[18px] -translate-y-1/2 text-gray-500" />
            <input
              id="inventory-search"
              data-testid="search-input"
              type="search"
              value={view.search}
              onChange={(event) => onChange({ search: event.target.value })}
              placeholder="Name, barcode or supplier no."
              autoComplete="off"
              spellCheck={false}
              maxLength={SEARCH_MAX_LENGTH}
              className={`${CONTROL} pr-3 pl-10 placeholder:text-gray-500`}
            />
          </div>
        </div>

        <div role="group" aria-labelledby="inventory-stock-label">
          <p id="inventory-stock-label" className={FIELD_LABEL}>
            Stock level
          </p>
          <div className="inline-flex overflow-hidden rounded-[10px] ring-1 ring-gray-400">
            {STOCK_OPTIONS.map((option) => {
              const pressed = view.stock === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  data-testid={`stock-filter-${option.value}`}
                  aria-pressed={pressed}
                  onClick={() => onChange({ stock: option.value })}
                  className={`inline-flex min-h-11 items-center gap-1.5 border-l border-gray-400 px-4 text-base font-semibold first:border-l-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none ${
                    pressed
                      ? "bg-blue-700 text-white hover:bg-blue-800 focus-visible:ring-white"
                      : "bg-white text-gray-800 hover:bg-gray-100 focus-visible:ring-blue-700"
                  }`}
                >
                  {pressed && <CheckIcon className="h-4 w-4" />}
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label htmlFor="inventory-sort" className={FIELD_LABEL}>
            Sort by
          </label>
          <div className="relative">
            <select
              id="inventory-sort"
              data-testid="sort-select"
              value={view.sort}
              onChange={(event) => {
                const next = event.target.value;
                if (isSortKey(next)) onChange({ sort: next });
              }}
              className={`${CONTROL} appearance-none pr-10 pl-3`}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronIcon className="pointer-events-none absolute top-1/2 right-3 h-[18px] w-[18px] -translate-y-1/2 text-gray-600" />
          </div>
        </div>

        <Link
          href="/admin"
          className="inline-flex min-h-11 items-center justify-center rounded-[10px] bg-blue-700 px-5 text-base font-semibold text-white hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
        >
          + Add
        </Link>
      </div>
    </div>
  );
}

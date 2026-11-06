"use client";

import { useId, useMemo, useState } from "react";
import type { Ref } from "react";
import type { Medication } from "@/lib/db";
import { matchesSearch, sortItems } from "@/lib/inventory-view";
import { categoryLabel, displayName, pluralize } from "./format";
import type { CategoryList } from "./format";
import { CheckIcon, PlusIcon, SearchIcon } from "./icons";
import { HELP, INPUT, LABEL } from "./ui";

// "Add an item": a search box and a short list of matches, each with an Add button. Nothing is ever added unless
// the person presses a button, or presses Enter while exactly one item matches (what a handheld barcode scanner sends after
// the code). An item that is already on the sheet is shown as "On sheet" and cannot be added again (pressing it takes you to
// its row instead; Enter does the same for a single match).

const MAX_RESULTS = 8;

const HELP_TEXT =
  "Type to find an item, then press Add. When only one item matches (for example after scanning its barcode), press Enter to " +
  "add it. An item that is already on the sheet is marked and is never added twice.";

export type Announcement = { text: string; tick: number };

type AddItemsProps = {
  items: readonly Medication[];
  categories: CategoryList;
  isOnSheet: (id: number) => boolean;
  onAdd: (item: Medication) => void;
  /** Result of the last action ("Added …", "Already on the sheet …"), announced to screen readers and shown. */
  status: Announcement;
  searchRef: Ref<HTMLInputElement>;
};

export function AddItems({ items, categories, isOnSheet, onAdd, status, searchRef }: AddItemsProps) {
  const [query, setQuery] = useState("");
  const inputId = useId();
  const helpId = useId();
  const trimmed = query.trim();

  const matches = useMemo(
    () => (trimmed === "" ? [] : sortItems(items.filter((item) => matchesSearch(item, trimmed)), "name", [])),
    [items, trimmed]
  );
  const shown = matches.slice(0, MAX_RESULTS);

  let countText = "";
  if (trimmed !== "") {
    if (matches.length === 0) countText = `No items match “${trimmed}”.`;
    else if (matches.length > MAX_RESULTS) countText = `Showing ${MAX_RESULTS} of ${matches.length} matches. Keep typing to narrow the list.`;
    else countText = `${matches.length} ${pluralize(matches.length, "match", "matches")}`;
  }

  return (
    <div>
      <label htmlFor={inputId} className={LABEL}>
        Add an item
      </label>
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-5 w-5 -translate-y-1/2 text-gray-500" />
        <input
          ref={searchRef}
          id={inputId}
          data-testid="add-search"
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="Name, barcode or supplier order no."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // Whatever surrounds the box, Enter here never submits anything.
            event.preventDefault();
            // The Enter that confirms a text composition (IME), or a key that is held down, is not a scan.
            if (event.nativeEvent.isComposing || event.repeat) return;
            // Exactly one item is listed: it is the one that was meant. Zero or several: nothing happens, the query and the list stay.
            const only = matches.length === 1 ? matches[0] : null;
            if (only === null) return;
            onAdd(only);
            // Empty the box so the next scan starts clean instead of being glued onto this code.
            setQuery("");
          }}
          aria-describedby={helpId}
          className={`${INPUT} pl-10`}
        />
      </div>
      <p id={helpId} className={HELP}>
        {HELP_TEXT}
      </p>

      <p role="status" data-testid="add-status" className="mt-2 min-h-5 text-sm font-medium text-gray-900">
        <span key={status.tick}>{status.text}</span>
      </p>

      {trimmed !== "" ? (
        <div className="mt-2">
          <p aria-live="polite" className="text-sm text-gray-600">
            {countText}
          </p>
          {shown.length > 0 ? (
            <ul role="list" className="mt-2 space-y-2">
              {shown.map((item) => {
                const onSheet = isOnSheet(item.id);
                const name = displayName(item);
                const category = categoryLabel(item, categories);
                const supplier = typeof item.supplier_order_number === "string" ? item.supplier_order_number.trim() : "";
                // When the typed text is found in the barcode, say so: a scanned or typed code matches its barcode, and the person
                // can then see why this item is listed. (Searched like the list itself, so the two always agree.)
                const matchedBarcode = matchesSearch({ ...item, name: null, supplier_order_number: null }, trimmed);
                const barcodeNote = matchedBarcode ? ` (barcode ${item.barcode})` : "";
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      data-testid={`add-result-${item.id}`}
                      aria-disabled={onSheet ? true : undefined}
                      aria-label={onSheet ? `On sheet: ${name}${barcodeNote}. Press to go to its row.` : `Add ${name}${barcodeNote} to the sheet`}
                      onClick={() => onAdd(item)}
                      className={
                        "flex min-h-14 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left focus-visible:outline-2 " +
                        "focus-visible:outline-offset-2 focus-visible:outline-blue-600 " +
                        (onSheet
                          ? "border-gray-200 bg-gray-50 text-gray-600"
                          : "border-gray-300 bg-white hover:border-blue-600 hover:bg-blue-50")
                      }
                    >
                      <span className="min-w-0 flex-1">
                        <span className={`block font-medium wrap-anywhere ${onSheet ? "text-gray-700" : "text-gray-900"}`}>{name}</span>
                        <span className="mt-0.5 block text-sm text-gray-600 wrap-anywhere">
                          Supplier order no.:{" "}
                          {supplier !== "" ? <span className="sheet-mono text-gray-800">{supplier}</span> : <span className="italic">Not set</span>}
                          {category ? ` · ${category}` : ""}
                          {matchedBarcode ? (
                            <>
                              {" · Barcode: "}
                              <span className="sheet-mono text-gray-800">{item.barcode}</span>
                            </>
                          ) : null}
                        </span>
                      </span>
                      <span
                        className={
                          "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm font-semibold " +
                          (onSheet ? "border-gray-300 bg-white text-gray-700" : "border-blue-700 bg-blue-700 text-white")
                        }
                      >
                        {onSheet ? <CheckIcon className="h-4 w-4" /> : <PlusIcon className="h-4 w-4" />}
                        {onSheet ? "On sheet" : "Add"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

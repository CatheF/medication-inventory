"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import type { Category, Medication } from "@/lib/db";
import {
  DEFAULT_VIEW,
  describeEmpty,
  isLowStock,
  isUnknownCategoryFilter,
  selectView,
  type ViewState,
} from "@/lib/inventory-view";
import { addRows, removeRow } from "@/lib/order-sheet/draft";
import { ORDER_SHEET_LIMITS } from "@/lib/order-sheet/types";
import { useOrderDraft } from "@/lib/order-sheet/use-order-draft";
import { ActiveFilterChips, type ActiveFilter } from "../ActiveFilterChips";
import { Notice } from "../Notice";
import { BulkAddButton } from "./BulkAddButton";
import { EmptyState } from "./EmptyState";
import { GroupSection } from "./GroupSection";
import { CheckIcon, InfoIcon } from "./Icons";
import { InventorySkeleton } from "./InventorySkeleton";
import { InventoryToolbar } from "./InventoryToolbar";
import { ItemRow } from "./ItemRow";
import { LoadErrorNotice } from "./LoadErrorNotice";
import { OrderBar } from "./OrderBar";
import { RetryButton } from "./RetryButton";
import { StatCard } from "./StatCard";
import {
  categoryLabelFor,
  describeActiveFilters,
  idKey,
  orderCategories,
  plural,
  rememberedName,
  type ActiveFilterSpec,
} from "./helpers";

export type InventoryStatus = "loading" | "error" | "ready";

export type InventoryTabProps = {
  /**
   * loading: the first load has not finished (both the items and the categories must have settled).
   * error:   the items could not be loaded and there is nothing to show. The list is NOT drawn.
   * ready:   there is a list to show (possibly empty, possibly with a warning about a failed refresh).
   */
  status: InventoryStatus;
  /** Why the items could not be loaded (status "error"). */
  errorMessage: string | null;
  medications: readonly Medication[];
  categories: readonly Category[];
  /** Why the categories could not be loaded. The items are still listed; they fall into "Category unavailable". */
  categoriesError: string | null;
  /** Why the latest refresh failed after the list had already loaded. The old list stays on screen. */
  refreshError: string | null;
  /** True while a (re)load is in flight. */
  refreshing: boolean;
  view: ViewState;
  onViewChange: Dispatch<SetStateAction<ViewState>>;
  /** Loads the items and the categories again. */
  onRetry: () => void;
  /** Shows the Scan tab (the "Scan a barcode" button of the empty inventory). */
  onScan: () => void;
};

/** The message after "Add all" or its Undo. `addedIds` are exactly the rows THAT action put on the sheet (Undo takes only those off). */
type BulkState = { text: string; canUndo: boolean; addedIds: readonly number[] };

const UNKNOWN_GROUP_NOTE =
  "These items point to a category that is not in the category list, so no category name can be shown for them.";

// Every control of the page keeps this much room below it when the browser scrolls it into view by keyboard focus, so the
// floating order bar (OrderBar) never covers the control that has focus. The variable is published by useBarClearance
// and is unset while there is no bar, so this costs nothing then. The order bar itself sits outside the element that
// carries this class.
const KEEP_CLEAR_OF_BAR = "[&_:is(a,button,input,select,textarea,[tabindex])]:scroll-mb-(--order-bar-space)";

const LINK_BUTTON =
  "inline-flex min-h-11 items-center rounded-md px-2 text-base font-semibold text-blue-700 underline underline-offset-4 hover:bg-blue-50 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-700";

/**
 * The Inventory tab: summary numbers and alerts, category chips with counts, search / stock / sort / grouping,
 * the filters that are on as removable chips, and the items as compact rows (grouped by category or as one flat list).
 * It never shows an API error as an empty inventory and never hides an item: what the filters leave out is counted and stated.
 */
export function InventoryTab({
  status,
  errorMessage,
  medications,
  categories,
  categoriesError,
  refreshError,
  refreshing,
  view,
  onViewChange,
  onRetry,
  onScan,
}: InventoryTabProps) {
  const sheet = useOrderDraft();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [fullMessage, setFullMessage] = useState<string | null>(null);
  const [bulk, setBulk] = useState<BulkState | null>(null);

  const summaryRef = useRef<HTMLParagraphElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // How the person last used the filter chips: "touch" (a tap), "pointer" (mouse or pen) or "keyboard" (also a screen
  // reader's activation, which sends no pointer events). Only a tap changes what happens to focus (see removeFilter).
  const chipInputRef = useRef<"touch" | "pointer" | "keyboard">("keyboard");
  const loadingRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef(false);

  const categoryOptions = useMemo(() => orderCategories(categories), [categories]);
  const titleByKey = useMemo(
    () => new Map(categoryOptions.map((option) => [option.key, option.title] as const)),
    [categoryOptions]
  );

  // A category filter that was restored from the browser's session storage can name a category that does not exist any
  // more (deleted since, or an id from another database). It would show "Category unavailable" with no chip pressed and
  // an empty list. Once the category list HAS loaded, such a filter is dropped: the view is All, and the stored view is
  // corrected right after. While the categories could not be loaded nothing is known, so the stored choice is kept.
  const staleCategoryId = useMemo(() => {
    if (status !== "ready" || categoriesError !== null) return null;
    const filter = view.category;
    if (filter.kind !== "category" || isUnknownCategoryFilter(filter)) return null;
    const key = idKey(filter.id);
    return key !== null && titleByKey.has(key) ? null : filter.id;
  }, [status, categoriesError, view.category, titleByKey]);
  const effectiveView = useMemo<ViewState>(
    () => (staleCategoryId === null ? view : { ...view, category: { kind: "all" } }),
    [view, staleCategoryId]
  );
  useEffect(() => {
    if (staleCategoryId === null) return;
    onViewChange((previous) =>
      previous.category.kind === "category" && previous.category.id === staleCategoryId
        ? { ...previous, category: { kind: "all" } }
        : previous
    );
  }, [staleCategoryId, onViewChange]);

  // Groups a person folds stay folded while they sort and browse, but a new search, stock level or category opens them
  // again: a match inside a folded group would be counted in the summary and yet not be on screen.
  const filterKey = `${effectiveView.search}\u0000${effectiveView.stock}\u0000${effectiveView.category.kind}\u0000${effectiveView.category.kind === "category" ? effectiveView.category.id : ""}`;
  const [foldedForFilter, setFoldedForFilter] = useState(filterKey);
  if (foldedForFilter !== filterKey) {
    setFoldedForFilter(filterKey);
    setCollapsed((previous) => (previous.size === 0 ? previous : new Set()));
  }

  // Only after BOTH requests have settled (status "ready"): while the categories are still loading every
  // categorized item would briefly read "Category unavailable".
  const model = useMemo(
    () => (status === "ready" ? selectView(medications, categories, effectiveView) : null),
    [status, medications, categories, effectiveView]
  );

  const update = (patch: Partial<ViewState>) => onViewChange((previous) => ({ ...previous, ...patch }));

  // ── Order sheet ticks ──────────────────────────────────────────────────────────────────────────
  // The latest sheet is read through a ref so the row handler keeps one identity (rows are memoized).
  const sheetRef = useRef(sheet);
  useEffect(() => {
    sheetRef.current = sheet;
  });
  const handleToggle = useCallback((id: number, name: string) => {
    const current = sheetRef.current;
    if (!current.has(id) && current.count >= ORDER_SHEET_LIMITS.rows) {
      setFullMessage(`The sheet is full (${ORDER_SHEET_LIMITS.rows} items). Remove an item before adding another.`);
      return;
    }
    setFullMessage(null);
    setBulk(null); // a tick or untick by hand ends the "Added ..." message and its Undo
    current.toggle(id, name);
  }, []);

  // ── "Add all" and Undo ─────────────────────────────────────────────────────────────────────────
  // Adds the items the list (or a group) shows that are not on the sheet yet. The draft is read INSIDE the update, so
  // "which rows did this action add" is exact even if the sheet changed in another tab a moment ago: addRows appends,
  // so the new rows are the ones after the old length. addRows stops at the row limit; when that cuts the action short
  // the message says so, and Undo only takes off what was really added.
  const handleAddAll = useCallback((items: readonly Medication[], scopeTitle: string | null) => {
    const names = new Map(items.map((item) => [item.id, rememberedName(item)] as const));
    let requested = 0;
    let added: number[] = [];
    sheetRef.current.update((draft) => {
      const present = new Set(draft.rows.map((row) => row.id));
      const ids = items.filter((item) => !present.has(item.id)).map((item) => item.id);
      requested = ids.length;
      const next = addRows(draft, ids, names);
      added = next.rows.slice(draft.rows.length).map((row) => row.id);
      return next;
    });
    if (requested === 0) return; // everything was on the sheet already (the button is drawn as a status then)
    setFullMessage(null);
    const count = added.length;
    const text =
      count < requested
        ? `Added ${count} of ${requested}. The sheet is full (${ORDER_SHEET_LIMITS.rows} items).`
        : scopeTitle === null
          ? `Added ${count} ${plural(count, "item", "items")} to the order sheet.`
          : `Added ${count} ${plural(count, "item", "items")} from ${scopeTitle} to the order sheet.`;
    setBulk({ text, canUndo: count > 0, addedIds: added });
  }, []);

  const handleUndo = () => {
    if (bulk === null) return;
    const ids = new Set(bulk.addedIds);
    let removed = 0;
    sheetRef.current.update((draft) => {
      let next = draft;
      for (const row of draft.rows) if (ids.has(row.id)) next = removeRow(next, row.id);
      removed = draft.rows.length - next.rows.length;
      return next;
    });
    setFullMessage(null);
    setBulk({
      text: removed > 0 ? `Undid adding ${removed} ${plural(removed, "item", "items")}.` : "Nothing to undo: those items are no longer on the order sheet.",
      canUndo: false,
      addedIds: [],
    });
  };

  const handleDismissBulk = () => {
    setBulk(null);
    // With rows on the sheet the bar stays and has already put focus on one of its own controls; without rows the bar
    // goes away, so focus goes to the results line.
    if (sheetRef.current.count === 0) summaryRef.current?.focus();
  };

  const sheetRows = sheet.draft.rows;
  const sheetCounts = useMemo(() => {
    if (model === null) return null;
    const known = new Set(medications.map((item) => item.id));
    const shown = new Set(model.visible.map((item) => item.id));
    let hidden = 0;
    let missing = 0;
    for (const row of sheetRows) {
      if (!known.has(row.id)) missing += 1;
      else if (!shown.has(row.id)) hidden += 1;
    }
    return { hidden, missing };
  }, [model, medications, sheetRows]);

  // ── Retry and focus ────────────────────────────────────────────────────────────────────────────
  // A retry removes the button that was focused (the error becomes a skeleton, a warning disappears). When the
  // retry has finished and focus fell back to <body>, put it somewhere meaningful instead of at the page start.
  const handleRetry = () => {
    if (refreshing && status === "ready") return;
    pendingFocusRef.current = true;
    onRetry();
  };
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    if (status === "loading") {
      loadingRef.current?.focus();
      return;
    }
    if (refreshing) return;
    pendingFocusRef.current = false;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (status === "error" ? errorRef.current : summaryRef.current)?.focus();
  }, [status, refreshing, refreshError, categoriesError]);

  // ── Active filter chips ────────────────────────────────────────────────────────────────────────
  // Removing a chip puts back ONLY that filter; the other filters, the sort, the grouping and every tick stay. The chips'
  // own focus rule covers a chip that has neighbours (focus moves to the next or previous chip). When the LAST chip goes,
  // the chips disappear with the focused button, so focus is placed here: on the search box, which is where a person
  // starts over. Not after a tap on a touch screen: focusing a text box there raises the on-screen keyboard over the list
  // the person just widened, and a tap has no keyboard focus to keep.
  const removeFilter = useCallback(
    (key: ActiveFilterSpec["key"], isLast: boolean) => {
      if (key === "category") onViewChange((previous) => ({ ...previous, category: { kind: "all" } }));
      else if (key === "stock") onViewChange((previous) => ({ ...previous, stock: "all" }));
      else onViewChange((previous) => ({ ...previous, search: "" }));
      if (isLast && chipInputRef.current !== "touch") searchInputRef.current?.focus();
    },
    [onViewChange]
  );
  const activeFilters = useMemo<ActiveFilter[]>(() => {
    const specs = describeActiveFilters(effectiveView, titleByKey);
    return specs.map((spec) => ({
      key: spec.key,
      label: spec.label,
      value: spec.value,
      onRemove: () => removeFilter(spec.key, specs.length === 1),
    }));
  }, [effectiveView, titleByKey, removeFilter]);

  const ready = status === "ready";
  const lowCount = ready ? medications.filter(isLowStock).length : 0;
  const adequateCount = ready ? medications.length - lowCount : 0;
  const unnamedCount = ready ? medications.filter((item) => item.is_unnamed).length : 0;

  const renderRow = (item: Medication) => {
    const label = categoryLabelFor(item, titleByKey);
    return (
      <ItemRow
        key={item.id}
        item={item}
        categoryKind={label.kind}
        categoryTitle={label.title}
        checked={sheet.has(item.id)}
        onToggle={handleToggle}
      />
    );
  };

  const toggleGroup = (key: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const clearFilters = () => {
    onViewChange((previous) => ({ ...DEFAULT_VIEW, sort: previous.sort, grouped: previous.grouped }));
    summaryRef.current?.focus();
  };

  // "Show all items" of an empty category: drop the category filter, nothing else (the empty-category message is only
  // given when no search and no stock level are on). The button goes away with the message, so focus goes to the results line.
  const showAllItems = () => {
    update({ category: { kind: "all" } });
    summaryRef.current?.focus();
  };

  const flatPending = model !== null && model.groups === null ? model.visible.filter((item) => !sheet.has(item.id)).length : 0;

  return (
    <div data-testid="inventory-tab">
      <div className={KEEP_CLEAR_OF_BAR}>
        <h1 className="sr-only">Inventory</h1>

        {/* Stats: an em dash (never 0) until the numbers are known.
            The third card is "Adequate" (stock above the threshold, the same rule as the "Adequate" stock filter), not
            "In Stock": the Scan tab's "In Stock" counts every item with stock above 0, a different number. */}
        <div className="mb-4 grid grid-cols-3 gap-4">
          <StatCard label="Total" value={ready ? medications.length : null} color="blue" />
          <StatCard label="Low Stock" value={ready ? lowCount : null} color={!ready ? "blue" : lowCount > 0 ? "amber" : "green"} />
          <StatCard label="Adequate" value={ready ? adequateCount : null} color={ready ? "green" : "blue"} />
        </div>

        {/* Alerts */}
        {lowCount > 0 && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="text-[15px] font-medium text-amber-900">
              {lowCount} {plural(lowCount, "medication is", "medications are")} at or below threshold.
            </p>
            {/* One button that stays in the page (a swapped-out button drops keyboard focus). Pressed = the list is
                limited to low stock; pressing it again shows everything. The check mark, not only the colour, says it is on. */}
            <button
              type="button"
              data-testid="show-low-stock"
              aria-pressed={effectiveView.stock === "low"}
              onClick={() => update({ stock: effectiveView.stock === "low" ? "all" : "low" })}
              className={`inline-flex min-h-10 items-center gap-1.5 rounded-md border px-3 text-sm font-semibold text-amber-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-amber-700 ${
                effectiveView.stock === "low"
                  ? "border-amber-700 bg-amber-200 hover:bg-amber-300"
                  : "border-transparent underline underline-offset-2 hover:bg-amber-100"
              }`}
            >
              {effectiveView.stock === "low" && <CheckIcon className="h-4 w-4" />}
              Show only low stock
            </button>
          </div>
        )}
        {unnamedCount > 0 && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="text-[15px] font-medium text-amber-900">
              {unnamedCount} unnamed {plural(unnamedCount, "item needs", "items need")} staff review.
            </p>
            <Link
              href="/admin"
              className="inline-flex min-h-10 items-center rounded-md px-3 text-sm font-semibold text-amber-900 underline underline-offset-2 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-amber-700"
            >
              Review in Admin
            </Link>
          </div>
        )}

        {status === "loading" && <InventorySkeleton ref={loadingRef} />}

        {status === "error" && (
          <LoadErrorNotice ref={errorRef} data-testid="inventory-error" message={errorMessage} onRetry={handleRetry} className="mt-2" />
        )}

        {model !== null && (
          <>
            {refreshError !== null && (
              <Notice
                data-testid="inventory-refresh-warning"
                tone="warning"
                title="Inventory could not be refreshed."
                className="mb-3"
              >
                <span className="block [overflow-wrap:anywhere]">{refreshError}</span>
                <span className="mt-1 block">The list below is the last one that loaded. It may be out of date.</span>
                <RetryButton onClick={handleRetry} busy={refreshing} />
              </Notice>
            )}
            {categoriesError !== null && (
              <Notice
                data-testid="categories-error"
                tone="warning"
                className="mb-3"
              >
                {categories.length === 0
                  ? "Categories could not be loaded, so items are listed without category names."
                  : "Categories could not be refreshed, so category names may be out of date."}{" "}
                Items whose category is unknown appear under “Category unavailable”.
                <span className="mt-1 block [overflow-wrap:anywhere]">{categoriesError}</span>
                <RetryButton onClick={handleRetry} busy={refreshing} />
              </Notice>
            )}

            <InventoryToolbar
              view={effectiveView}
              categories={categoryOptions}
              counts={model.counts}
              onChange={update}
              searchRef={searchInputRef}
            />

            {/* The filters that are on, each one removable. Right under the toolbar and above the results line; nothing is
                drawn while no filter is on. Not a live region: the results line below speaks the result. There is no
                "clear all" here on purpose: the results line already has the one "Clear filters" button. */}
            <div
              onPointerDownCapture={(event) => {
                chipInputRef.current = event.pointerType === "touch" ? "touch" : "pointer";
              }}
              onKeyDownCapture={() => {
                chipInputRef.current = "keyboard";
              }}
            >
              <ActiveFilterChips filters={activeFilters} className="mt-3" />
            </div>

            <section aria-labelledby="inventory-results-heading" className={activeFilters.length > 0 ? "mt-4" : "mt-5"}>
              <h2 id="inventory-results-heading" className="sr-only">
                Inventory items
              </h2>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <p
                  ref={summaryRef}
                  tabIndex={-1}
                  data-testid="inventory-summary"
                  aria-live="polite"
                  aria-atomic="true"
                  className="min-w-0 flex-1 basis-64 rounded text-base font-semibold text-gray-900 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
                >
                  {model.summary.text}
                </p>
                {model.summary.filtersActive && (
                  <button type="button" data-testid="clear-filters" onClick={clearFilters} className={LINK_BUTTON}>
                    Clear filters
                  </button>
                )}
                {model.groups !== null && model.groups.length > 0 && (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      data-testid="collapse-all"
                      onClick={() => setCollapsed(new Set(model.groups?.map((group) => group.key)))}
                      className={LINK_BUTTON}
                    >
                      Collapse all
                    </button>
                    <button type="button" data-testid="expand-all" onClick={() => setCollapsed(new Set())} className={LINK_BUTTON}>
                      Expand all
                    </button>
                  </div>
                )}
                {model.groups === null && model.visible.length > 0 && (
                  <BulkAddButton
                    scope="flat"
                    shown={model.visible.length}
                    pending={flatPending}
                    onAdd={() => handleAddAll(model.visible, null)}
                  />
                )}
              </div>

              <p className="mt-1 mb-4 flex items-start gap-1.5 text-sm text-gray-600">
                <InfoIcon className="mt-0.5 h-4 w-4" />
                <span>Tick “Add to order sheet” on any item. Your ticks are kept when you change filters or search.</span>
              </p>

              {model.visible.length === 0 ? (
                <EmptyState
                  {...describeEmpty(medications.length, effectiveView, categories)}
                  onClearFilters={clearFilters}
                  onShowAll={showAllItems}
                  onScan={onScan}
                />
              ) : model.groups !== null ? (
                model.groups.map((group) => (
                  <GroupSection
                    key={group.key}
                    groupKey={group.key}
                    title={group.title}
                    count={group.items.length}
                    onSheetCount={group.items.filter((item) => sheet.has(item.id)).length}
                    open={!collapsed.has(group.key)}
                    onToggle={() => toggleGroup(group.key)}
                    onAddAll={() => handleAddAll(group.items, group.title)}
                    note={group.kind === "unknown" ? UNKNOWN_GROUP_NOTE : undefined}
                  >
                    {group.items.map(renderRow)}
                  </GroupSection>
                ))
              ) : (
                <div className="overflow-hidden rounded-xl border border-gray-300 bg-white">
                  <ul role="list" aria-label="Inventory items" data-testid="flat-list" className="@container">
                    {model.visible.map(renderRow)}
                  </ul>
                </div>
              )}

              {model.visible.length > 0 && (
                <p data-testid="inventory-footer" className="mt-4 text-center font-medium text-gray-600">
                  {model.summary.filtersActive
                    ? `Showing ${model.summary.shown} of ${model.summary.total} ${plural(model.summary.total, "item", "items")}. ${
                        model.summary.total - model.summary.shown
                      } ${plural(model.summary.total - model.summary.shown, "item is", "items are")} hidden by the filters above.`
                    : `Showing all ${model.summary.total} ${plural(model.summary.total, "item", "items")}.`}
                </p>
              )}
            </section>
          </>
        )}
      </div>

      <OrderBar
        count={sheet.count}
        hidden={sheetCounts?.hidden ?? null}
        missing={sheetCounts?.missing ?? null}
        storage={sheet.storage}
        fullMessage={fullMessage}
        onClear={() => {
          setFullMessage(null);
          setBulk(null);
          sheet.clear();
          summaryRef.current?.focus();
        }}
        bulk={bulk === null ? null : { text: bulk.text, canUndo: bulk.canUndo }}
        onUndo={handleUndo}
        onDismissBulk={handleDismissBulk}
      />
    </div>
  );
}

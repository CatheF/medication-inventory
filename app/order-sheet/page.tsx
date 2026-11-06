"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import Link from "next/link";
import { EmptyStateCard } from "@/app/components/EmptyStateCard";
import { Notice } from "@/app/components/Notice";
import type { Medication } from "@/lib/db";
import { isLowStock, sortItems } from "@/lib/inventory-view";
import { buildSheet } from "@/lib/order-sheet/build";
import { addRows, hasRow, rememberNames, removeRow, removeRows, resolveDate, restoreRow, updateRow } from "@/lib/order-sheet/draft";
import { ORDER_SHEET_LIMITS } from "@/lib/order-sheet/types";
import type { PaperSize, SheetRow, SheetRowInput } from "@/lib/order-sheet/types";
import { useOrderDraft } from "@/lib/order-sheet/use-order-draft";
import { ignoreHeldEnter } from "@/app/components/inventory/helpers";
import { AddItems } from "./AddItems";
import type { Announcement } from "./AddItems";
import { InventoryFreshness } from "./InventoryFreshness";
import { PrintActions } from "./PrintActions";
import { PrintSheet, PrintUnavailable } from "./PrintSheet";
import { SheetDetails } from "./SheetDetails";
import { SheetLoadError } from "./SheetLoadError";
import { SheetRows } from "./SheetRows";
import { UndoLine } from "./UndoLine";
import { QTY_RANGE_WORDS, displayName, pageStyleText, pluralize, printDocumentTitle } from "./format";
import type { CategoryList } from "./format";
import { useCategories, useMedications, useToday } from "./hooks";
import { InfoIcon, PlusIcon, SpinnerIcon, TrashIcon, WarnIcon } from "./icons";
import { BTN_DANGER, BTN_DANGER_SOLID, BTN_SECONDARY, CARD, FOCUS, H2, HELP } from "./ui";

// The Order sheet page. Staff pick the items to order, type an order quantity and unit for each, and then print the
// sheet (or save it as a PDF from the browser's print window) or download it as an Excel file.
//
// Nothing here places an order, emails anyone, or changes stock: the draft lives in this browser, and the only server
// call besides reading the inventory is the read-only Excel export. Order quantity and unit start empty and are never
// calculated; the on-hand stock is shown separately and is never mixed with them.

const NO_ITEMS: Medication[] = [];
/** Opens the Inventory tab of the main page (the tab is chosen through the address). */
const INVENTORY_TAB_HREF = "/?tab=inventory";
const TEXT_LINK = `rounded font-medium text-blue-700 underline underline-offset-2 hover:text-blue-800 ${FOCUS}`;
const FLASH_MS = 2400;
/** How long the screen-reader message about a manual refresh stays in the page. */
const REFRESH_NOTE_MS = 6000;

/**
 * What one press of Undo does. There is ONE level: the most recent "Add all low-stock items" or Remove; a newer action replaces
 * it, and it is gone once used. `added` takes off exactly the rows that action put on the sheet (rows that were there before it,
 * and what was typed in them, stay). `removed` puts one row back where it was, with its quantity, unit and remembered name.
 */
type UndoStep =
  | { kind: "added"; ids: readonly number[] }
  | { kind: "removed"; row: SheetRowInput; index: number; name: string };

/**
 * The message under "Add all low-stock items" and whether it carries Undo / Dismiss. The rules for when Undo stops being offered are
 * the Inventory tab's: it ends when it is used, dismissed or replaced by a newer action, when the sheet is cleared and when an item
 * is added by hand; typing a quantity does not end it and there is no timer. `reveal` scrolls the message into view (an "Add all"
 * inserts its rows ABOVE the button, so the message would otherwise be far below the screen).
 */
type StatusLine = { text: string; tick: number; undo: UndoStep | null; dismissable: boolean; reveal: boolean };
const NO_LINE: StatusLine = { text: "", tick: 0, undo: null, dismissable: false, reveal: false };

export default function OrderSheetPage() {
  const { draft, update, add, clear, has, count, storage } = useOrderDraft();
  const medications = useMedications();
  const categoriesLoad = useCategories();
  const today = useToday();
  const mounted = today !== "";

  const [announcement, setAnnouncement] = useState<Announcement>({ text: "", tick: 0 });
  // The result of "Add all low-stock items" and of Remove has its own message, shown right under that button (see UndoLine).
  const [line, setLine] = useState<StatusLine>(NO_LINE);
  // The same message, readable from an event handler without waiting for a render: Undo must act exactly once, and "is an offer
  // on screen" decides where an explanation goes. Only ever written by setStatusLine.
  const lineRef = useRef<StatusLine>(NO_LINE);
  // The result of the Refresh button (automatic refreshes stay quiet). A failed refresh is remembered as the load time of
  // the data that is still on screen, so the failure note disappears by itself as soon as newer data arrives.
  const [refreshNote, setRefreshNote] = useState<Announcement>({ text: "", tick: 0 });
  const [refreshFailedFor, setRefreshFailedFor] = useState<number | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const clearButtonRef = useRef<HTMLButtonElement>(null);
  const addLowStockRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const loadingRef = useRef<HTMLDivElement>(null);
  const loadErrorRef = useRef<HTMLDivElement>(null);
  /** Set when Retry was pressed on the load error, so focus can follow the page through loading to the result. */
  const focusAfterRetry = useRef(false);
  const flashTimer = useRef<number | null>(null);
  const refreshNoteTimer = useRef<number | null>(null);

  const announce = useCallback((text: string) => setAnnouncement((previous) => ({ text, tick: previous.tick + 1 })), []);
  /** Shows a message under "Add all low-stock items" (null: nothing to say, which also ends any Undo that was on offer). */
  const setStatusLine = useCallback((next: Pick<StatusLine, "text" | "undo" | "dismissable"> & { reveal?: boolean } | null) => {
    const previous = lineRef.current;
    const written: StatusLine =
      next === null
        ? { ...NO_LINE, tick: previous.tick }
        : { text: next.text, undo: next.undo, dismissable: next.dismissable, reveal: next.reveal === true, tick: previous.tick + 1 };
    lineRef.current = written;
    setLine(written);
  }, []);

  // ── What the page knows ────────────────────────────────────────────────────────────────────────────────────────
  // The rows are only listed once the page has mounted (the first client render shows the empty draft, then the stored
  // one) AND the inventory has loaded, so there is never a flash of "no items" for a sheet that has items.
  const loadStatus = medications.state.status;
  const ready = mounted && loadStatus === "ready";
  const items = medications.state.status === "ready" ? medications.state.data : NO_ITEMS;
  const loadedAt = medications.state.status === "ready" ? medications.state.loadedAt : null;
  const resolvedDate = resolveDate(draft, today);

  const categories: CategoryList = useMemo(() => {
    if (categoriesLoad.state.status === "ready") return { status: "ready", categories: categoriesLoad.state.data };
    return { status: categoriesLoad.state.status === "error" ? "error" : "loading" };
  }, [categoriesLoad.state]);

  const sheet = useMemo(
    () =>
      buildSheet(items, draft.rows, {
        title: draft.title,
        date: resolvedDate,
        preparedBy: draft.preparedBy,
        notes: draft.notes,
        showOnHand: draft.showOnHand,
        showBarcode: draft.showBarcode,
      }),
    [items, draft.rows, draft.title, resolvedDate, draft.preparedBy, draft.notes, draft.showOnHand, draft.showBarcode]
  );
  const details = useMemo(() => new Map<number, SheetRow>(sheet.rows.map((row) => [row.id, row])), [sheet.rows]);

  const missingCount = sheet.missingIds.length;
  const invalidCount = sheet.invalidQtyIds.length;
  const noSupplierCount = sheet.rows.filter((row) => row.supplierOrderNumber === null).length;
  const invalidIds = new Set(sheet.invalidQtyIds);
  const noQtyCount = sheet.rows.filter((row) => row.qty === "" && !invalidIds.has(row.id)).length;

  let disabledReason: string | null = null;
  if (count === 0) disabledReason = "Add at least one item to print or download the sheet.";
  else if (sheet.rows.length === 0) {
    disabledReason = "None of the items on the sheet are in the inventory any more. Remove them, then add items to print or download.";
  } else if (invalidCount > 0) {
    disabledReason = `Fix the order quantity on ${invalidCount} ${pluralize(invalidCount, "row", "rows")} first: digits only, ${QTY_RANGE_WORDS}.`;
  }

  // The browser suggests the page title as the file name for "Save as PDF", so give it a useful one while printing. Only when
  // there is a sheet to print: before that (or after a failed load) the paper holds just a notice, and a file that is named
  // like an order sheet would be mistaken for one.
  const printTitle = printDocumentTitle({ title: draft.title, date: resolvedDate });
  useEffect(() => {
    if (!ready) return;
    let original: string | null = null;
    const before = () => {
      original = document.title;
      document.title = printTitle;
    };
    const after = () => {
      if (original !== null) {
        document.title = original;
        original = null;
      }
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
      after();
    };
  }, [printTitle, ready]);

  // Remember what each item on the sheet is called, so a row whose item is deleted later can still say which item it was.
  // Runs every time the inventory has been read (first load, Retry, Refresh, coming back to the tab). A row whose item is not
  // in the list keeps the name it already has; an inventory that could not be read changes nothing. Applying it twice is a
  // no-op (rememberNames returns the same draft), so it never writes without a reason. It deliberately does NOT depend on
  // the draft: two tabs that disagree about a name would otherwise keep overwriting each other.
  useEffect(() => {
    if (items.length === 0) return;
    const names = new Map<number, string>();
    for (const item of items) {
      if (!names.has(item.id)) names.set(item.id, displayName(item)); // the first record of an id wins, like buildSheet()
    }
    update((d) => rememberNames(d, names));
  }, [items, update]);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
      if (refreshNoteTimer.current !== null) window.clearTimeout(refreshNoteTimer.current);
    },
    []
  );

  // After "Retry" on the load error the button (and the message around it) is replaced by the loading box, so keyboard
  // focus would fall to <body>. Follow the page instead: loading box -> the new error message, or the page heading.
  useEffect(() => {
    if (!focusAfterRetry.current) return;
    if (loadStatus === "loading") {
      loadingRef.current?.focus();
      return;
    }
    focusAfterRetry.current = false;
    if (loadStatus === "error") loadErrorRef.current?.focus();
    else headingRef.current?.focus();
  }, [loadStatus]);

  // The "Add all low-stock items" rows are inserted ABOVE the button, which pushes the button (and the message under it)
  // far below the screen on a long sheet. Bring the message back into view so the result is seen. Only that message asks for it:
  // a Remove must not move the page away from the row the person is working on.
  useEffect(() => {
    if (!line.reveal) return;
    const frame = window.requestAnimationFrame(() => statusRef.current?.scrollIntoView({ block: "nearest" }));
    return () => window.cancelAnimationFrame(frame);
  }, [line]);

  // ── Actions ────────────────────────────────────────────────────────────────────────────────────────────────────
  const retryLoad = () => {
    focusAfterRetry.current = true;
    medications.reload();
  };

  const handleRefresh = async () => {
    const shownSince = loadedAt;
    const refreshed = await medications.refresh();
    setRefreshFailedFor(refreshed ? null : shownSince);
    setRefreshNote((previous) => ({
      text: refreshed ? "Inventory refreshed." : "Couldn’t refresh the inventory. The page still shows the earlier data.",
      tick: previous.tick + 1,
    }));
    // The message is for screen readers (the page itself already shows the new time or the failure note). Remove it once it
    // has been spoken, so a stale "Couldn’t refresh" never sits in the page after the situation has changed.
    if (refreshNoteTimer.current !== null) window.clearTimeout(refreshNoteTimer.current);
    refreshNoteTimer.current = window.setTimeout(() => setRefreshNote((previous) => ({ text: "", tick: previous.tick })), REFRESH_NOTE_MS);
  };

  const focusRow = useCallback((id: number) => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
    if (!row) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
    setFlashId(id);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashId(null), FLASH_MS);
  }, []);

  // "Find an item here" on the empty-sheet card: puts the keyboard in the "Add an item" search box. A plain focus() is the whole
  // job, on purpose: the browser scrolls the box into view only when it is not fully on screen (on a phone the card is taller
  // than the screen, so the box can start below the fold) and leaves the page where it is otherwise. A forced, centred, smooth
  // scroll moved the page under a pointer or finger that had not moved, so a quick second tap landed on another control ("Add all
  // low-stock items", the link to the Inventory tab) or on plain content, which took the focus out of the box again.
  const findItemHere = () => {
    searchRef.current?.focus();
  };

  const handleAdd = (item: Medication) => {
    const name = displayName(item);
    if (has(item.id)) {
      announce(`Already on the sheet: ${name}.`);
      focusRow(item.id);
      return;
    }
    if (count >= ORDER_SHEET_LIMITS.rows) {
      announce(`The sheet is full (${ORDER_SHEET_LIMITS.rows} items). ${name} was not added.`);
      return;
    }
    add([item.id], new Map([[item.id, name]])); // the row remembers the item's name
    setStatusLine(null); // an item added by hand ends the Undo that was on offer (the Inventory tab's rule for an item ticked by hand)
    announce(`Added ${name}. ${count + 1} ${pluralize(count + 1, "item", "items")} on the sheet.`);
  };

  // A press of "Add all low-stock items" that changed nothing says why. An Undo that is on screen is still exact and must not be
  // lost to a double tap, so then the reason goes to the line under the search box; with nothing on offer it goes under the button.
  const explainNothingChanged = (text: string) => {
    if (lineRef.current.undo !== null) announce(text);
    else setStatusLine({ text, undo: null, dismissable: false });
  };

  // The result is written under the "Add all low-stock items" button (not under the search box at the top), so it is
  // seen where the person pressed, however long the sheet is. The rows this action adds are read INSIDE the update, so "which rows
  // did it add" stays exact even when another tab changed the sheet a moment ago: addRows appends, so the new rows are the ones
  // after the old length. Undo takes off exactly those.
  const handleAddLowStock = () => {
    const low = items.filter(isLowStock);
    if (low.length === 0) {
      explainNothingChanged("No items are at or below their low-stock level.");
      return;
    }
    const notOnSheet = sortItems(
      low.filter((item) => !has(item.id)),
      "name",
      []
    );
    const alreadyOnSheet = `All ${low.length} low-stock ${pluralize(low.length, "item is", "items are")} already on the sheet. Nothing was added.`;
    if (notOnSheet.length === 0) {
      explainNothingChanged(alreadyOnSheet);
      return;
    }
    const room = Math.max(0, ORDER_SHEET_LIMITS.rows - count);
    const batch = notOnSheet.slice(0, room);
    if (batch.length === 0) {
      explainNothingChanged(`The sheet is full (${ORDER_SHEET_LIMITS.rows} items). Nothing was added.`);
      return;
    }
    const names = new Map(batch.map((item) => [item.id, displayName(item)]));
    const result: { added: number[] } = { added: [] };
    update((current) => {
      const next = addRows(current, batch.map((item) => item.id), names);
      result.added = next.rows.slice(current.rows.length).map((row) => row.id);
      return next;
    });
    if (result.added.length === 0) {
      explainNothingChanged(alreadyOnSheet); // another tab put them on the sheet a moment ago
      return;
    }
    const added = result.added.length;
    const alreadyThere = low.length - notOnSheet.length;
    const skipped = notOnSheet.length - added;
    let text = `Added ${added} low-stock ${pluralize(added, "item", "items")}`;
    if (alreadyThere > 0) text += ` (${alreadyThere} already on the sheet)`;
    text += skipped > 0 ? `. The sheet is full (${ORDER_SHEET_LIMITS.rows} items), so ${skipped} could not be added.` : ". Order quantities are left empty.";
    setStatusLine({ text, undo: { kind: "added", ids: result.added }, dismissable: true, reveal: true });
  };

  const handleRemove = useCallback(
    (id: number, name: string) => {
      const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []);
      const index = rows.findIndex((row) => row.dataset.rowId === String(id));
      // The row is read from the latest draft, inside the update, so Undo puts back exactly what was typed in it at this moment.
      const result: { row: SheetRowInput | null; position: number; left: number } = { row: null, position: -1, left: 0 };
      update((current) => {
        const position = current.rows.findIndex((row) => row.id === id);
        if (position < 0) return current; // already gone (another tab removed it): nothing to take off, nothing to offer back
        const next = removeRow(current, id);
        result.row = current.rows[position];
        result.position = position;
        result.left = next.rows.length;
        return next;
      });
      if (result.row !== null) {
        setStatusLine({
          text: `Removed ${name}. ${result.left} ${pluralize(result.left, "item", "items")} left.`,
          undo: { kind: "removed", row: result.row, index: result.position, name },
          dismissable: true,
        });
      }
      // Put keyboard focus on the next row's Remove button (or the search box when the sheet is now empty).
      window.setTimeout(() => {
        const remaining = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []);
        const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
        const target = next?.querySelector<HTMLElement>("[data-remove]") ?? searchRef.current;
        target?.focus();
      }, 0);
    },
    [setStatusLine, update]
  );

  // Undo of the latest "Add all" or Remove. The offer is read from the ref and used up before anything else can run, so a second
  // press (a double-click, a repeated key) can never undo twice; what was typed in other rows is never touched.
  const handleUndo = () => {
    const step = lineRef.current.undo;
    if (step === null) return;
    if (step.kind === "added") {
      const result = { removed: 0 };
      update((current) => {
        const next = removeRows(current, step.ids);
        result.removed = current.rows.length - next.rows.length;
        return next;
      });
      setStatusLine({
        text:
          result.removed > 0
            ? `Undid adding ${result.removed} ${pluralize(result.removed, "item", "items")}.`
            : "Nothing to undo: those items are no longer on the sheet.",
        undo: null,
        dismissable: true,
      });
      return;
    }
    const result = { onSheet: false, restored: false, total: 0 };
    update((current) => {
      if (hasRow(current, step.row.id)) {
        result.onSheet = true;
        return current;
      }
      const next = restoreRow(current, step.row, step.index);
      result.restored = next !== current;
      result.total = next.rows.length;
      return next;
    });
    if (result.restored) {
      setStatusLine({
        text: `Put ${step.name} back on the sheet. ${result.total} ${pluralize(result.total, "item", "items")} on the sheet.`,
        undo: null,
        dismissable: true,
      });
    } else if (result.onSheet) {
      setStatusLine({ text: `Nothing to undo: ${step.name} is already on the sheet.`, undo: null, dismissable: true });
    } else {
      // The sheet filled up meanwhile (another tab), so the row cannot be put back. Like every Undo, this one is used up: the offer
      // cannot wait for room, because removing an item would replace it with that removal's own Undo.
      setStatusLine({
        text: `The sheet is full (${ORDER_SHEET_LIMITS.rows} items), so ${step.name} could not be put back.`,
        undo: null,
        dismissable: true,
      });
    }
  };

  const handleDismissLine = () => {
    // The Dismiss button goes away with the message: keep keyboard focus on the button the message belongs to.
    addLowStockRef.current?.focus();
    setStatusLine(null);
  };

  const handleQty = useCallback((id: number, qty: string) => update((d) => updateRow(d, id, { qty })), [update]);
  const handleUnit = useCallback((id: number, unit: string) => update((d) => updateRow(d, id, { unit })), [update]);

  const askToClear = () => {
    setConfirmingClear(true);
  };
  const cancelClear = () => {
    clearButtonRef.current?.focus();
    setConfirmingClear(false);
  };
  const confirmClear = () => {
    clear();
    setConfirmingClear(false);
    setStatusLine(null); // "Added 27 low-stock items" is no longer true of an empty sheet, and there is nothing left to undo
    announce("Sheet cleared. No items on the sheet.");
    searchRef.current?.focus();
  };

  const setPaper = (paper: PaperSize) => update((d) => ({ ...d, paper }));

  // ── Page ───────────────────────────────────────────────────────────────────────────────────────────────────────
  // "Remove all N items?" belongs to the moment it was asked. If the sheet is emptied another way meanwhile (the last
  // row's Remove button, another tab), forget the question, or it would reappear by itself when an item is added later.
  if (count === 0 && confirmingClear) setConfirmingClear(false);
  const showClearConfirm = confirmingClear && count > 0;

  return (
    <div className="print-reset space-y-6">
      <div className="space-y-6 print:hidden">
        <header>
          <h1 ref={headingRef} tabIndex={-1} className={`text-2xl font-bold text-gray-900 ${FOCUS}`}>
            Order sheet
          </h1>
          <p className="mt-1 text-base text-gray-600">Build a list of what to order, then print it or save it as a PDF.</p>
          {ready ? (
            <p className="mt-1 text-sm">
              <a href="#actions-heading" className={`${TEXT_LINK} inline-flex min-h-11 items-center`}>
                Go to print and download
              </a>
            </p>
          ) : null}
        </header>

        <p
          data-testid="sheet-disclaimer"
          className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5 text-sm text-blue-900"
        >
          <InfoIcon className="mt-0.5 h-5 w-5 text-blue-600" />
          <span>Preparing, printing or exporting this sheet does not place an order, email anyone, or change stock.</span>
        </p>

        {storage === "memory" ? (
          <Notice tone="warning" data-testid="storage-warning">
            This browser is not saving your order sheet. It will be lost if you close or reload this page. Download the Excel
            file or print it before you leave.
          </Notice>
        ) : (
          <p className="-mt-2 text-sm text-gray-600">Your draft is saved in this browser only.</p>
        )}

        {!ready && medications.state.status !== "error" ? <SheetLoading ref={loadingRef} /> : null}

        {medications.state.status === "error" ? (
          <SheetLoadError
            ref={loadErrorRef}
            message={medications.state.message}
            savedCount={storage === "browser" ? count : 0}
            onRetry={retryLoad}
          />
        ) : null}

        {ready ? (
          <>
            <section aria-labelledby="items-heading" className={CARD}>
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <h2 id="items-heading" className={H2}>
                  Items on this sheet <span className="font-normal text-gray-600">({count})</span>
                </h2>
                {/* With no rows the empty card right below offers the very same link as its main action (same text, same
                    target): two identical links at once are noise for everyone and a puzzle for a screen reader's link list. So
                    the heading row carries it only while the sheet has rows. */}
                {count > 0 ? (
                  <Link href={INVENTORY_TAB_HREF} data-testid="inventory-tab-link" className={`${TEXT_LINK} inline-flex min-h-11 items-center`}>
                    Pick items on the Inventory tab
                  </Link>
                ) : null}
              </div>

              {/* Static card (not a live region): "Sheet cleared" is announced by the status line of the search box below it and
                  "Removed … 0 items left" by the message under "Add all low-stock items", so the card itself says nothing when it
                  appears. */}
              {count === 0 ? (
                <EmptyStateCard
                  testId="sheet-empty"
                  icon="cart"
                  title="No items on the order sheet yet"
                  description="Pick items on the Inventory tab, or find one here by name, barcode or supplier order number."
                  primaryAction={{ label: "Pick items on the Inventory tab", href: INVENTORY_TAB_HREF, testId: "empty-inventory-link" }}
                  secondaryAction={{ label: "Find an item here", onClick: findItemHere, testId: "empty-find-item" }}
                  className="mt-4"
                />
              ) : null}

              <div className="mt-4">
                <AddItems
                  items={items}
                  categories={categories}
                  isOnSheet={has}
                  onAdd={handleAdd}
                  status={announcement}
                  searchRef={searchRef}
                />
              </div>

              {count > 0 ? (
                <div className="mt-6">
                  <SheetRows
                    rows={draft.rows}
                    details={details}
                    showBarcode={draft.showBarcode}
                    flashId={flashId}
                    listRef={listRef}
                    onQty={handleQty}
                    onUnit={handleUnit}
                    onRemove={handleRemove}
                  />
                  {missingCount > 0 || invalidCount > 0 || noSupplierCount > 0 || noQtyCount > 0 ? (
                    <ul role="list" className="mt-4 space-y-2 text-sm text-gray-800">
                      {missingCount > 0 ? (
                        <NoteLine icon={<WarnIcon className="h-5 w-5 text-amber-700" />} testId="missing-items-summary">
                          <strong>
                            {missingCount} {pluralize(missingCount, "item is", "items are")} no longer in the inventory.
                          </strong>{" "}
                          {pluralize(missingCount, "It is", "They are")} left out of the preview, the print-out and the Excel file.
                          Remove {pluralize(missingCount, "it", "them")} from the list.
                        </NoteLine>
                      ) : null}
                      {invalidCount > 0 ? (
                        <NoteLine icon={<WarnIcon className="h-5 w-5 text-red-700" />} testId="invalid-qty-summary">
                          <strong>
                            {invalidCount} {pluralize(invalidCount, "row has", "rows have")} an order quantity that isn’t valid.
                          </strong>{" "}
                          Use digits only ({QTY_RANGE_WORDS}), or leave it blank. Print and the Excel file are unavailable until this is
                          fixed.
                        </NoteLine>
                      ) : null}
                      {noSupplierCount > 0 ? (
                        <NoteLine icon={<WarnIcon className="h-5 w-5 text-amber-700" />} testId="missing-supplier-summary">
                          <strong>
                            {noSupplierCount} {pluralize(noSupplierCount, "item has", "items have")} no supplier order number.
                          </strong>{" "}
                          {pluralize(noSupplierCount, "It prints", "They print")} as “—”. Add the number on the{" "}
                          <Link href="/admin" className={TEXT_LINK}>
                            Admin
                          </Link>{" "}
                          page.
                        </NoteLine>
                      ) : null}
                      {noQtyCount > 0 ? (
                        <NoteLine icon={<InfoIcon className="h-5 w-5 text-blue-600" />} testId="empty-qty-summary">
                          <strong>
                            {noQtyCount} {pluralize(noQtyCount, "row has", "rows have")} no order quantity yet.
                          </strong>{" "}
                          {pluralize(noQtyCount, "It prints", "They print")} with an empty box to fill in by hand.
                        </NoteLine>
                      ) : null}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-6 flex flex-col gap-4 border-t border-gray-200 pt-5 sm:flex-row sm:items-start sm:justify-between">
                <div className="max-w-xl">
                  <button
                    ref={addLowStockRef}
                    type="button"
                    data-testid="add-low-stock"
                    onKeyDown={ignoreHeldEnter}
                    onClick={handleAddLowStock}
                    className={BTN_SECONDARY}
                  >
                    <PlusIcon className="h-4 w-4" />
                    Add all low-stock items
                  </button>
                  {/* The result of the latest "Add all" or Remove, with Undo and Dismiss. The message is a live region that is always
                      in the page; it is invisible until there is a result. */}
                  <UndoLine
                    text={line.text}
                    tick={line.tick}
                    canUndo={line.undo !== null}
                    canDismiss={line.dismissable}
                    rootRef={statusRef}
                    onUndo={handleUndo}
                    onDismiss={handleDismissLine}
                  />
                  <p className={HELP}>
                    Optional shortcut. Adds every item at or below its low-stock level (including out of stock) that is not already
                    on the sheet. Nothing is added unless you press this button.
                  </p>
                </div>
                <div className="shrink-0">
                  <button
                    ref={clearButtonRef}
                    type="button"
                    data-testid="clear-sheet"
                    disabled={count === 0}
                    aria-expanded={showClearConfirm}
                    onClick={askToClear}
                    className={`${BTN_DANGER} whitespace-nowrap`}
                  >
                    <TrashIcon className="h-4 w-4" />
                    Clear sheet
                  </button>
                </div>
              </div>

              {showClearConfirm ? (
                <div
                  role="group"
                  aria-labelledby="clear-question"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") cancelClear();
                  }}
                  className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4"
                >
                  <p id="clear-question" className="font-semibold text-amber-900">
                    Remove all {count} {pluralize(count, "item", "items")} from this sheet?
                  </p>
                  <p className="mt-1 text-sm text-amber-900">The quantities and units you typed will be lost. Stock is not changed.</p>
                  <div className="mt-3 flex flex-wrap gap-3">
                    <button type="button" data-testid="clear-sheet-confirm" onClick={confirmClear} className={BTN_DANGER_SOLID}>
                      Yes, clear sheet
                    </button>
                    {/* Keep is the safe default, so it gets the keyboard focus. */}
                    <button type="button" autoFocus onClick={cancelClear} className={BTN_SECONDARY}>
                      Keep items
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            <SheetDetails draft={draft} resolvedDate={resolvedDate} today={today} update={update} />

            <PrintActions
              sheet={sheet}
              draftKey={draft}
              disabledReason={disabledReason}
              onInventoryChanged={() => void medications.refresh()}
            />
          </>
        ) : null}
      </div>

      {ready ? (
        <section aria-labelledby="preview-heading" className={`print-reset ${CARD}`}>
          <style>{pageStyleText(draft.paper)}</style>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-4 print:hidden">
            <div>
              <h2 id="preview-heading" className={H2}>
                Preview of the printed sheet
              </h2>
              <p className={HELP}>This is exactly what prints. Nothing else on this page is included.</p>
              {/* Where staff decide to print: how old the item names, supplier numbers and stock on this sheet are. */}
              {loadedAt !== null ? (
                <div className="mt-2">
                  <InventoryFreshness
                    loadedAt={loadedAt}
                    refreshing={medications.refreshing}
                    failed={refreshFailedFor !== null && refreshFailedFor === loadedAt}
                    announcement={refreshNote}
                    onRefresh={() => void handleRefresh()}
                  />
                </div>
              ) : null}
            </div>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-gray-800">Paper size</legend>
              <div className="flex gap-2">
                <PaperChoice testId="paper-letter" value="letter" label="Letter" checked={draft.paper === "letter"} onSelect={() => setPaper("letter")} />
                <PaperChoice testId="paper-a4" value="a4" label="A4" checked={draft.paper === "a4"} onSelect={() => setPaper("a4")} />
              </div>
            </fieldset>
          </div>

          <div
            role="region"
            aria-label="Order sheet preview (scrolls sideways on narrow screens)"
            tabIndex={0}
            className={`print-reset overflow-x-auto rounded-lg border border-gray-200 bg-gray-100 p-3 sm:p-4 ${FOCUS}`}
          >
            <PrintSheet sheet={sheet} paper={draft.paper} />
          </div>

          <p className="mt-3 text-sm text-gray-600 print:hidden">
            The preview is one continuous page. When printed, a long sheet continues onto more pages: the column headings repeat at the
            top of every page and a row is never split across two pages.{" "}
            <span className="sm:hidden">On a narrow screen, swipe the preview sideways to see every column.</span>
          </p>
        </section>
      ) : (
        // Ctrl/Cmd+P before there is a sheet (the inventory is loading, or could not be loaded): the paper explains why
        // it is not the order sheet instead of coming out blank. Hidden on screen.
        <PrintUnavailable loadFailed={loadStatus === "error"} />
      )}
    </div>
  );
}

function SheetLoading({ ref }: { ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} tabIndex={-1} data-testid="sheet-loading" role="status" className={`${CARD} ${FOCUS}`}>
      <p className="flex items-center gap-2 font-medium text-gray-800">
        <SpinnerIcon className="h-5 w-5 text-blue-700" />
        Loading the inventory…
      </p>
      <div aria-hidden="true" className="mt-4 space-y-3">
        {[0, 1, 2].map((index) => (
          <div key={index} className="h-14 animate-pulse rounded-lg bg-gray-100 motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}

function NoteLine({ icon, testId, children }: { icon: ReactNode; testId: string; children: ReactNode }) {
  return (
    <li data-testid={testId} className="flex items-start gap-2">
      <span className="mt-px">{icon}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function PaperChoice({
  testId,
  value,
  label,
  checked,
  onSelect,
}: {
  testId: string;
  value: PaperSize;
  label: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={
        "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-semibold " +
        (checked ? "border-blue-700 bg-blue-50 text-blue-900" : "border-gray-300 bg-white text-gray-800 hover:bg-gray-50")
      }
    >
      <input
        type="radio"
        name="paper"
        value={value}
        data-testid={testId}
        checked={checked}
        onChange={onSelect}
        className={`h-5 w-5 accent-blue-700 ${FOCUS}`}
      />
      {label}
    </label>
  );
}

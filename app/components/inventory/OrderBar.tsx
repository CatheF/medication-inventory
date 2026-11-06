"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Notice } from "../Notice";
import { ignoreHeldEnter, plural } from "./helpers";
import { useBarClearance } from "./useBarClearance";

/** The result of the latest "Add all" (or of its Undo): what to say, and whether Undo still applies. */
export type BulkNotice = { text: string; canUndo: boolean };

type OrderBarProps = {
  /** Number of rows on the order sheet. */
  count: number;
  /** Sheet items that exist but are filtered out of the list right now. null = not known (inventory not loaded). */
  hidden: number | null;
  /** Sheet items that are no longer in the inventory. null = not known (inventory not loaded). */
  missing: number | null;
  /** "memory": the browser refused to save the sheet. */
  storage: "browser" | "memory";
  /** Shown when the sheet is full and an item could not be added. */
  fullMessage: string | null;
  onClear: () => void;
  /** The message of the latest "Add all" or Undo. It stays until the next one, a tick, Undo or Dismiss (no timer). */
  bulk: BulkNotice | null;
  onUndo: () => void;
  onDismissBulk: () => void;
};

const BAR_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-[10px] px-5 text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";
const SMALL_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-[10px] px-4 text-[15px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

/**
 * Sticky bar shown while the order sheet has items. It says how many are on the sheet and how many of them the
 * current filters hide (ticks are kept when filters change), links to the sheet, and clears it after a second step.
 * Under that it carries the result of the latest "Add all" with Undo and Dismiss.
 *
 * It floats over the bottom of the page, so two things keep it from getting in the way:
 *  - useBarClearance keeps keyboard focus out from under it (WCAG 2.2 SC 2.4.11);
 *  - in short windows (a phone held sideways, or a page zoomed to 400%) it stops floating and sits at the end of
 *    the list like any other block, because there it would cover half of what is left of the screen.
 *
 * THE MESSAGE IS A LIVE REGION THAT IS ALWAYS IN THE PAGE. A polite region only speaks changes to a region that already
 * exists; one that is created together with its text is often not read. The bar is therefore always rendered: with no sheet
 * rows and no message it is visually hidden (sr-only) and holds just the empty region, so the first "Add all" fills a region
 * the screen reader already knows. With rows it is the visible bar; with a message but no rows (after Undo emptied the sheet)
 * it is the visible bar without the sheet line, so "Undid adding 3 items." can still be read. `order-bar` marks the bar
 * only while the sheet has rows (`bulk-bar` marks the message-only bar).
 *
 * ONE PRESS, ONE ACTION. The bar moves keyboard focus as its buttons act (Undo -> Dismiss, Dismiss -> "Review order sheet",
 * Clear -> "Keep items" and back), because the button that was pressed goes away or changes. A HELD Enter repeats keydown, so
 * without a guard every repeat would press the button focus has just moved to: Undo would also Dismiss its own message, and
 * Clear / Keep items would open and close the question for as long as the key is down. Repeats of Enter are ignored on every
 * control of the bar (ignoreHeldEnter); a new press works as usual.
 */
export function OrderBar({ count, hidden, missing, storage, fullMessage, onClear, bulk, onUndo, onDismissBulk }: OrderBarProps) {
  const [confirming, setConfirming] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  useBarClearance(barRef);
  const clearRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const reviewRef = useRef<HTMLAnchorElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(false);

  const onSheet = count > 0;
  // The sheet emptied while the question was open (another tab cleared it): the question goes with it.
  if (!onSheet && confirming) setConfirming(false);

  // Moving into the confirmation puts focus on the safe choice; leaving it by cancelling puts focus back on "Clear".
  useEffect(() => {
    if (confirming) {
      keepRef.current?.focus();
    } else if (returnFocusRef.current) {
      returnFocusRef.current = false;
      clearRef.current?.focus();
    }
  }, [confirming]);

  const cancel = () => {
    returnFocusRef.current = true;
    setConfirming(false);
  };

  const undo = () => {
    // The Undo button is replaced by the "Undid adding..." text: keep keyboard focus on a button that stays.
    dismissRef.current?.focus();
    onUndo();
  };

  const dismiss = () => {
    // While the sheet has rows the bar stays, so focus goes to its first control (the link to the sheet); with no rows the
    // bar goes away and the caller (InventoryTab) decides where focus goes. (Dismiss is not drawn while the "Clear"
    // question is open, so this never runs then.)
    if (onSheet) reviewRef.current?.focus();
    onDismissBulk();
  };

  const parts: string[] = [];
  if (hidden !== null && hidden > 0) parts.push(`${hidden} hidden by current filters`);
  if (missing !== null && missing > 0) parts.push(`${missing} no longer in the inventory`);

  const visible = onSheet || bulk !== null;
  const showBulk = bulk !== null && !confirming;

  return (
    <div
      ref={barRef}
      data-testid={onSheet ? "order-bar" : bulk !== null ? "bulk-bar" : undefined}
      className={
        visible
          ? "sticky bottom-3 z-30 mt-5 rounded-2xl bg-blue-800 px-5 py-3 text-white shadow-lg [@media(max-height:480px)]:static print:hidden"
          : "sr-only"
      }
      onKeyDown={(event) => {
        ignoreHeldEnter(event);
        if (event.key === "Escape" && confirming) cancel();
      }}
    >
      {onSheet &&
        (confirming ? (
          <div role="group" aria-label="Confirm clearing the order sheet" className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="min-w-0 flex-1 basis-64 font-semibold">
              Remove all {count} {plural(count, "item", "items")} from the order sheet?
              <span className="block text-sm font-normal text-blue-100">
                Quantities and units typed on the order sheet page are removed too. Stock is not changed.
              </span>
            </p>
            <button
              type="button"
              data-testid="order-bar-clear-confirm"
              onClick={() => {
                setConfirming(false);
                onClear();
              }}
              className={`${BAR_BUTTON} bg-red-600 text-white hover:bg-red-700`}
            >
              Yes, clear order sheet
            </button>
            <button
              ref={keepRef}
              type="button"
              data-testid="order-bar-clear-cancel"
              onClick={cancel}
              className={`${BAR_BUTTON} border border-white/70 text-white hover:bg-white/10`}
            >
              Keep items
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {/* A live region: a tick or untick by hand changes the count and the count is read out. While an "Add all" / Undo
                message is up it says the same thing already ("Added 5 items ... "), so the count stays quiet then (aria-live
                "off" overrides the role's own "polite"): one action, one announcement. */}
            <p id="order-bar-text" role="status" aria-live={bulk !== null ? "off" : undefined} className="min-w-0 flex-1 basis-64 font-semibold">
              <strong className="font-bold">
                {count} {plural(count, "item", "items")}
              </strong>{" "}
              on the order sheet
              {parts.length > 0 && <span className="font-normal text-blue-100"> ({parts.join(", ")})</span>}
            </p>
            <Link
              ref={reviewRef}
              href="/order-sheet"
              data-testid="order-bar-review"
              className={`${BAR_BUTTON} bg-white text-blue-900 hover:bg-blue-100`}
            >
              Review order sheet
            </Link>
            <button
              ref={clearRef}
              type="button"
              data-testid="order-bar-clear"
              aria-describedby="order-bar-text"
              onClick={() => setConfirming(true)}
              className={`${BAR_BUTTON} border border-white/70 text-white hover:bg-white/10`}
            >
              Clear
            </button>
          </div>
        ))}

      {onSheet && fullMessage && (
        <p role="alert" data-testid="order-bar-full" className="mt-1.5 text-sm font-semibold text-white">
          {fullMessage}
        </p>
      )}

      {onSheet && storage === "memory" && !confirming && (
        <Notice tone="warning" className="mt-2.5" data-testid="order-bar-storage-warning">
          This browser is not saving your order sheet. It will be lost if you close or reload this page. Download the Excel
          file or print it before you leave.
        </Notice>
      )}

      {/* The result of "Add all" / Undo. The <p> is the polite live region and is always in the page (empty when there is
          no message); it gets its test id and its looks only while it has a message. The buttons are outside of it so that
          only the sentence is read out. While the "Clear" question is open the message steps aside (its text stays in the
          page for screen readers, unchanged, so nothing is announced again; Undo and Dismiss are not drawn): a question
          about removing everything should not compete with an older message, and the bar stays compact on a phone. */}
      <div className={showBulk ? `flex flex-wrap items-center gap-x-3 gap-y-1 ${onSheet ? "mt-2.5 border-t border-white/25 pt-2.5" : ""}` : undefined}>
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid={bulk !== null ? "bulk-status" : undefined}
          className={showBulk ? "min-w-0 flex-1 basis-56 text-[15px] font-semibold [overflow-wrap:anywhere]" : bulk !== null ? "sr-only" : undefined}
        >
          {bulk?.text}
        </p>
        {showBulk && bulk !== null && (
          <div className="flex flex-wrap gap-x-2 gap-y-1">
            {bulk.canUndo && (
              <button
                type="button"
                data-testid="bulk-undo"
                onClick={undo}
                className={`${SMALL_BUTTON} border border-white/70 text-white hover:bg-white/10`}
              >
                Undo
              </button>
            )}
            <button
              ref={dismissRef}
              type="button"
              data-testid="bulk-dismiss"
              // After a double-click on Undo the second click would land on Dismiss (the Undo button is gone and Dismiss slides
              // into its place): the browser's click count (detail) is 2 then, and that click is not meant for Dismiss.
              onClick={(event) => {
                if (event.detail > 1) return;
                dismiss();
              }}
              className={`${SMALL_BUTTON} text-white underline underline-offset-2 hover:bg-white/10`}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

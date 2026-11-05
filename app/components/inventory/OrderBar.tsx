"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Notice } from "../Notice";
import { plural } from "./helpers";
import { useBarClearance } from "./useBarClearance";

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
};

const BAR_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-[10px] px-5 text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

/**
 * Sticky bar shown while the order sheet has items. It says how many are on the sheet and how many of them the
 * current filters hide (ticks are kept when filters change), links to the sheet, and clears it after a second step.
 *
 * It floats over the bottom of the page, so two things keep it from getting in the way:
 *  - useBarClearance keeps keyboard focus out from under it (WCAG 2.2 SC 2.4.11);
 *  - in short windows (a phone held sideways, or a page zoomed to 400%) it stops floating and sits at the end of
 *    the list like any other block, because there it would cover half of what is left of the screen.
 */
export function OrderBar({ count, hidden, missing, storage, fullMessage, onClear }: OrderBarProps) {
  const [confirming, setConfirming] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  useBarClearance(barRef);
  const clearRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(false);

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

  const parts: string[] = [];
  if (hidden !== null && hidden > 0) parts.push(`${hidden} hidden by current filters`);
  if (missing !== null && missing > 0) parts.push(`${missing} no longer in the inventory`);

  return (
    <div
      ref={barRef}
      data-testid="order-bar"
      className="sticky bottom-3 z-30 mt-5 rounded-2xl bg-blue-800 px-5 py-3 text-white shadow-lg [@media(max-height:480px)]:static print:hidden"
      onKeyDown={(event) => {
        if (event.key === "Escape" && confirming) cancel();
      }}
    >
      {confirming ? (
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
          <p id="order-bar-text" role="status" className="min-w-0 flex-1 basis-64 font-semibold">
            <strong className="font-bold">
              {count} {plural(count, "item", "items")}
            </strong>{" "}
            on the order sheet
            {parts.length > 0 && <span className="font-normal text-blue-100"> ({parts.join(", ")})</span>}
          </p>
          <Link
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
      )}

      {fullMessage && (
        <p role="alert" data-testid="order-bar-full" className="mt-1.5 text-sm font-semibold text-white">
          {fullMessage}
        </p>
      )}

      {storage === "memory" && !confirming && (
        <Notice tone="warning" className="mt-2.5" data-testid="order-bar-storage-warning">
          This browser is not saving your order sheet. It will be lost if you close or reload this page. Download the Excel
          file or print it before you leave.
        </Notice>
      )}
    </div>
  );
}

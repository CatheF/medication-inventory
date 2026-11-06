"use client";

import { useRef } from "react";
import type { Ref } from "react";
import { ignoreHeldEnter } from "@/app/components/inventory/helpers";
import { BTN_SECONDARY, FOCUS } from "./ui";

// The message under "Add all low-stock items": what the latest "Add all" or Remove did, with Undo and Dismiss. It works like the
// Inventory tab's bar (app/components/inventory/OrderBar.tsx): a polite live region that is always in the page, with the buttons
// outside of it so that only the sentence is read out, and focus kept on a button that stays.

export type StatusLineView = {
  text: string;
  /** Changes with every new message, so the same words said twice are still announced twice. */
  tick: number;
  canUndo: boolean;
  canDismiss: boolean;
};

type UndoLineProps = StatusLineView & {
  /** The message together with its buttons: what the page scrolls into view after an "Add all" (on a phone the buttons wrap below the sentence). */
  rootRef: Ref<HTMLDivElement>;
  onUndo: () => void;
  onDismiss: () => void;
};

export function UndoLine({ text, tick, canUndo, canDismiss, rootRef, onUndo, onDismiss }: UndoLineProps) {
  const dismissRef = useRef<HTMLButtonElement>(null);
  const shown = text !== "";

  const undo = () => {
    // The Undo button is replaced by the result ("Undid adding ..."): keep keyboard focus on a button that stays.
    dismissRef.current?.focus();
    onUndo();
  };

  return (
    <div
      ref={rootRef}
      className={
        shown
          ? "sticky bottom-3 z-20 mt-4 flex scroll-mb-10 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-gray-300 bg-white px-3 py-1.5 shadow-lg"
          : undefined
      }
    >
      {/* Always mounted, so screen readers announce the text when it appears; invisible until there is a message. */}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="low-stock-status"
        className={shown ? "min-w-0 text-sm font-medium text-gray-900 wrap-anywhere" : "sr-only"}
      >
        <span key={tick}>{text}</span>
      </p>
      {shown && (canUndo || canDismiss) ? (
        // One press, one action: a held Enter would otherwise press the button that focus has just moved to (Undo -> Dismiss).
        <div className="flex flex-wrap gap-x-2 gap-y-1" onKeyDown={ignoreHeldEnter}>
          {canUndo ? (
            <button type="button" data-testid="bulk-undo" onClick={undo} className={BTN_SECONDARY}>
              Undo
            </button>
          ) : null}
          {canDismiss ? (
            <button
              ref={dismissRef}
              type="button"
              data-testid="bulk-dismiss"
              // After a double-click on Undo the second click would land on Dismiss (the Undo button is gone and Dismiss slides
              // into its place): the browser's click count (detail) is 2 then, and that click is not meant for Dismiss.
              onClick={(event) => {
                if (event.detail > 1) return;
                onDismiss();
              }}
              className={`inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-gray-800 underline underline-offset-2 hover:bg-gray-100 ${FOCUS}`}
            >
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

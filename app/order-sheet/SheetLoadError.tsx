"use client";

import type { Ref } from "react";
import { Notice } from "@/app/components/Notice";
import { RetryButton } from "@/app/components/inventory/RetryButton";
import { LOAD_ERROR_REASSURANCE, LOAD_ERROR_TITLE, pluralize } from "./format";

// "The inventory could not be loaded" on the Order sheet. It is built exactly like the notice on the Scan tab, the Inventory
// tab and Admin (see app/components/inventory/LoadErrorNotice.tsx): the shared Notice, the title, the reassurance line, the
// server's own text and the shared Retry button UNDER the message, never beside it. LoadErrorNotice itself has no place for
// the extra line this page needs (what happened to the draft), so the same pieces are put together here.

type SheetLoadErrorProps = {
  /** The server's own error text (or the one the page wrote for a network failure). */
  message: string;
  /** How many items are on the draft AND safely stored by the browser. 0 (or a draft that is only in memory) says nothing. */
  savedCount: number;
  onRetry: () => void;
  /** Lets the page move keyboard focus to the message after a failed retry. */
  ref?: Ref<HTMLDivElement>;
};

export function SheetLoadError({ message, savedCount, onRetry, ref }: SheetLoadErrorProps) {
  return (
    <Notice ref={ref} tone="error" title={LOAD_ERROR_TITLE} data-testid="sheet-error">
      <span className="block">{LOAD_ERROR_REASSURANCE}</span>
      <span className="mt-1 block [overflow-wrap:anywhere]">{message}</span>
      {savedCount > 0 ? (
        <span className="mt-1 block">
          Your order sheet ({savedCount} {pluralize(savedCount, "item", "items")}) is still saved in this browser.
        </span>
      ) : null}
      <RetryButton onClick={onRetry} />
    </Notice>
  );
}

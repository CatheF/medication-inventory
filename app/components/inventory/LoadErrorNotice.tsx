"use client";

import type { Ref } from "react";
import { Notice } from "../Notice";
import { RetryButton } from "./RetryButton";

/** The words staff see wherever the inventory could not be loaded: same title and same reassurance on every screen. */
export const LOAD_ERROR_TITLE = "Couldn’t load the inventory";
export const LOAD_ERROR_REASSURANCE = "This does not mean the inventory is empty.";
const LOAD_ERROR_FALLBACK = "The server did not send the inventory.";

type LoadErrorNoticeProps = {
  /** The server's own error text (or the one the page wrote for a network failure). */
  message: string | null;
  onRetry: () => void;
  /** True while a retry is running. */
  busy?: boolean;
  className?: string;
  "data-testid"?: string;
  /** Lets the caller move keyboard focus to the message after a failed retry. */
  ref?: Ref<HTMLDivElement>;
};

/**
 * The inventory could not be loaded: title, the reassurance that this is not an empty inventory, the server's text,
 * and a Retry button. An error notice, so it is announced at once (role="alert").
 * Used by the Scan tab and the Inventory tab, which show one load result between them.
 */
export function LoadErrorNotice({ message, onRetry, busy = false, className, ref, "data-testid": testId }: LoadErrorNoticeProps) {
  return (
    <Notice ref={ref} data-testid={testId} tone="error" title={LOAD_ERROR_TITLE} className={className}>
      <span className="block">{LOAD_ERROR_REASSURANCE}</span>
      <span className="mt-1 block [overflow-wrap:anywhere]">{message ?? LOAD_ERROR_FALLBACK}</span>
      <RetryButton onClick={onRetry} busy={busy} />
    </Notice>
  );
}

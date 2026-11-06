"use client";

import type { Announcement } from "./AddItems";
import { formatClockTime } from "./format";
import { SpinnerIcon, WarnIcon } from "./icons";
import { FOCUS } from "./ui";

// "Inventory as of 2:41 PM. Refresh": says how old the names, supplier numbers and on-hand stock on this page are, and
// lets staff read them again before printing. The page also refreshes by itself when staff come back to the tab (see
// hooks.ts); only the result of the Refresh button is announced to screen readers, so automatic refreshes stay quiet.

type InventoryFreshnessProps = {
  /** When the inventory was last read from the server (milliseconds since 1970) */
  loadedAt: number;
  refreshing: boolean;
  /** The last manual refresh did not work: the page still shows the earlier data */
  failed: boolean;
  /** Result of the last press of Refresh, for screen readers */
  announcement: Announcement;
  onRefresh: () => void;
};

export function InventoryFreshness({ loadedAt, refreshing, failed, announcement, onRefresh }: InventoryFreshnessProps) {
  const time = formatClockTime(loadedAt);
  return (
    <div data-testid="inventory-freshness" className="flex flex-wrap items-center gap-x-1 text-sm text-gray-600">
      {refreshing ? (
        <span className="inline-flex items-center gap-1.5">
          <SpinnerIcon className="h-4 w-4 text-blue-700" />
          Refreshing…
        </span>
      ) : failed ? (
        <span className="inline-flex items-start gap-1.5 text-amber-900">
          <WarnIcon className="mt-0.5 h-4 w-4" />
          <span>Couldn’t refresh. Still showing the inventory as of {time}.</span>
        </span>
      ) : (
        <span>Inventory as of {time}.</span>
      )}
      {/* -my-2 keeps the 44px touch target from making the heading row taller than the heading. Not disabled while
          refreshing: a disabled button drops keyboard focus, and a second press just joins the refresh already running. */}
      <button
        type="button"
        aria-label="Refresh inventory"
        onClick={onRefresh}
        className={`-my-2 inline-flex min-h-11 items-center rounded px-2 font-medium text-blue-700 underline underline-offset-2 hover:text-blue-800 ${FOCUS}`}
      >
        Refresh
      </button>
      <p role="status" className="sr-only">
        <span key={announcement.tick}>{announcement.text}</span>
      </p>
    </div>
  );
}

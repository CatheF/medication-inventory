"use client";

import type { ReactNode } from "react";
import { BulkAddButton } from "./BulkAddButton";
import { CheckIcon, ChevronIcon } from "./Icons";
import { plural } from "./helpers";

type GroupSectionProps = {
  /** Group key: the category id, or "unknown" / "uncategorized". Used for the heading's and the buttons' test ids. */
  groupKey: string;
  title: string;
  count: number;
  /** How many of this group's visible items are on the order sheet. */
  onSheetCount: number;
  open: boolean;
  onToggle: () => void;
  /** Puts every item this group shows that is not on the order sheet yet on the sheet. */
  onAddAll: () => void;
  /** Short explanation shown above the rows (used by the "Category unavailable" group). */
  note?: string;
  children: ReactNode;
};

/**
 * A category group: a header, then the rows. The header is a strip with two separate controls (a button cannot sit inside
 * a button): the <h3> whose whole width is the collapse button, and "Add all N" for the items of this group. On a narrow
 * screen "Add all N" wraps under the title. Collapsed rows stay in the page (hidden), so ticks and focus are never lost
 * by collapsing; the header (and "Add all N") stays visible.
 */
export function GroupSection({ groupKey, title, count, onSheetCount, open, onToggle, onAddAll, note, children }: GroupSectionProps) {
  const listId = `group-list-${groupKey}`;
  return (
    <section className="mb-5" data-testid={`group-${groupKey}`}>
      <div className={`flex flex-wrap items-center border border-gray-300 bg-gray-100 ${open ? "rounded-t-xl" : "rounded-xl"}`}>
        <h3 data-testid={`group-heading-${groupKey}`} className="m-0 min-w-0 flex-1 basis-60">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={onToggle}
            className={`flex min-h-13 w-full flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-2 text-left text-[17px] font-bold text-gray-900 hover:bg-gray-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-700 ${open ? "rounded-tl-xl" : "rounded-l-xl"}`}
          >
            <ChevronIcon
              className={`h-5 w-5 text-gray-600 transition-transform motion-reduce:transition-none ${open ? "" : "-rotate-90"}`}
            />
            <span className="min-w-0 break-words">{title}</span>
            <span className="shrink-0 text-[15px] font-medium text-gray-600">
              · {count} {plural(count, "item", "items")}
            </span>
            {onSheetCount > 0 && (
              <span
                data-testid={`group-on-sheet-${groupKey}`}
                className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 text-[13px] leading-5 font-semibold text-blue-800"
              >
                <CheckIcon className="h-3.5 w-3.5" />
                {onSheetCount} on order sheet
              </span>
            )}
          </button>
        </h3>
        <div className="flex shrink-0 items-center pr-3 pb-1.5 pl-4 sm:py-1 sm:pl-0">
          <BulkAddButton scope="group" groupKey={groupKey} title={title} shown={count} pending={count - onSheetCount} onAdd={onAddAll} />
        </div>
      </div>
      <div
        id={listId}
        data-testid={listId}
        hidden={!open}
        className="overflow-hidden rounded-b-xl border border-t-0 border-gray-300 bg-white"
      >
        {note && <p className="border-b border-gray-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">{note}</p>}
        <ul role="list" className="@container">
          {children}
        </ul>
      </div>
    </section>
  );
}

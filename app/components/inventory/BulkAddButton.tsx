"use client";

import { ORDER_SHEET_LIMITS } from "@/lib/order-sheet/types";
import { CheckIcon, PlusIcon, WarnIcon } from "./Icons";
import { ignoreHeldEnter, plural } from "./helpers";

type BulkAddButtonProps = {
  /** "group": the button in a category header. "flat": the one button of the ungrouped list. */
  scope: "group" | "flat";
  /** The group key (category id, "unknown" or "uncategorized"). Used for the test ids of a group button. */
  groupKey?: string;
  /** The group title; named in the button's accessible name. */
  title?: string;
  /** How many items the list (or group) shows right now. */
  shown: number;
  /** How many of those are NOT on the order sheet yet. */
  pending: number;
  /** True when the sheet already holds the most rows it can (ORDER_SHEET_LIMITS.rows): nothing more can be added. */
  sheetFull: boolean;
  onAdd: () => void;
};

const BASE =
  "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700";
const ADD = `${BASE} border-blue-700 bg-white text-blue-800 hover:bg-blue-50`;
const DONE = `${BASE} cursor-default border-transparent bg-transparent text-green-800`;
const FULL = `${BASE} cursor-default border-transparent bg-transparent text-amber-900`;

/**
 * "Add all N": puts every item the list (or the group) shows, and that is not on the order sheet yet, on the sheet. It is
 * always an explicit click; nothing is ever added by itself.
 *
 * It has two other faces, both a status instead of a button:
 *   - When every shown item is on the sheet it reads "All N on the order sheet" with a check mark.
 *   - When some shown items are not on the sheet but the sheet already holds the most rows it can, it reads "Sheet full
 *     (500 items)" with a warning mark. Offering "Add all 100" then would be a lie (it would add nothing) and pressing it would
 *     only produce "Added 0 of 100". (When everything shown IS on the sheet, "All N on the order sheet" wins: it is the more
 *     specific truth, and true even on a full sheet.)
 * All three are ONE element on purpose: a person who pressed the button with the keyboard keeps their place (a button that
 * is swapped for text drops keyboard focus to the page start). A status is aria-disabled and leaves the Tab order
 * (tabIndex -1), so it neither does anything nor traps focus; it can still be read and still holds focus once.
 *
 * A held Enter presses it once (ignoreHeldEnter): when the sheet is nearly full, a second press would only replace the "Added 2 of 5"
 * message (and its Undo) with a notice that nothing could be added.
 *
 * The visible text is short ("Add all 5", flat list: "Add all 27 shown"); the accessible name spells out what it acts on and
 * contains the visible text ("Add all 5 items shown in Antibiotics to the order sheet", "Add all 27 shown to the order sheet"),
 * so a person who speaks the label to a voice control finds it (WCAG 2.5.3). The same holds for both statuses.
 */
export function BulkAddButton({ scope, groupKey, title, shown, pending, sheetFull, onAdd }: BulkAddButtonProps) {
  const group = scope === "group";
  if (pending > 0 && sheetFull) {
    const full = `Sheet full (${ORDER_SHEET_LIMITS.rows} items)`;
    const items = plural(pending, "item", "items");
    return (
      <button
        type="button"
        data-testid={group ? `group-sheet-full-${groupKey}` : "flat-sheet-full"}
        aria-disabled="true"
        tabIndex={-1}
        aria-label={group ? `${full}: ${pending} ${items} shown in ${title} cannot be added` : `${full}: ${pending} ${items} shown cannot be added`}
        className={FULL}
      >
        <WarnIcon className="h-4 w-4" />
        {full}
      </button>
    );
  }
  if (pending > 0) {
    const items = plural(pending, "item", "items");
    return (
      <button
        type="button"
        data-testid={group ? `group-add-all-${groupKey}` : "flat-add-all"}
        aria-label={group ? `Add all ${pending} ${items} shown in ${title} to the order sheet` : `Add all ${pending} shown to the order sheet`}
        onKeyDown={ignoreHeldEnter}
        onClick={onAdd}
        className={ADD}
      >
        <PlusIcon className="h-4 w-4" />
        {group ? `Add all ${pending}` : `Add all ${pending} shown`}
      </button>
    );
  }
  return (
    <button
      type="button"
      data-testid={group ? `group-all-on-sheet-${groupKey}` : "flat-all-on-sheet"}
      aria-disabled="true"
      tabIndex={-1}
      aria-label={group ? `All ${shown} on the order sheet: items shown in ${title}` : `All ${shown} on the order sheet: all items shown`}
      className={DONE}
    >
      <CheckIcon className="h-4 w-4" />
      {`All ${shown} on the order sheet`}
    </button>
  );
}

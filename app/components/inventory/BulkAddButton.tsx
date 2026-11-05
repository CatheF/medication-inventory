"use client";

import { CheckIcon, PlusIcon } from "./Icons";
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
  onAdd: () => void;
};

const BASE =
  "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700";
const ADD = `${BASE} border-blue-700 bg-white text-blue-800 hover:bg-blue-50`;
const DONE = `${BASE} cursor-default border-transparent bg-transparent text-green-800`;

/**
 * "Add all N": puts every item the list (or the group) shows, and that is not on the order sheet yet, on the sheet. It is
 * always an explicit click; nothing is ever added by itself.
 *
 * When every shown item is on the sheet the same button turns into the status "All N on the order sheet" with a check
 * mark. It stays ONE element on purpose: a person who pressed it with the keyboard keeps their place (a button that is
 * swapped for text drops keyboard focus to the page start). The status state is aria-disabled and leaves the Tab order
 * (tabIndex -1), so it neither does anything nor traps focus; it can still be read and still holds focus once.
 *
 * A held Enter presses it once (ignoreHeldEnter): when the sheet is nearly full, a second press would only replace the "Added 2 of 5"
 * message (and its Undo) with "Added 0 of 3".
 *
 * The visible text is short ("Add all 5", flat list: "Add all 27 shown"); the accessible name spells out what it acts on and
 * contains the visible text ("Add all 5 items shown in Antibiotics to the order sheet", "Add all 27 shown to the order sheet"),
 * so a person who speaks the label to a voice control finds it (WCAG 2.5.3).
 */
export function BulkAddButton({ scope, groupKey, title, shown, pending, onAdd }: BulkAddButtonProps) {
  const group = scope === "group";
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

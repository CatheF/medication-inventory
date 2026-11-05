"use client";

import { useId, useState } from "react";
import type { OrderDraft } from "@/lib/order-sheet/draft";
import { ORDER_SHEET_LIMITS } from "@/lib/order-sheet/types";
import { SHEET_DATE_MAX, SHEET_DATE_MIN, formatSheetDate, isSheetDate } from "./format";
import { WarnIcon } from "./icons";
import { CARD, FOCUS, H2, HELP, INPUT, INPUT_INVALID, LABEL } from "./ui";

// "Sheet details": the title, date, who prepared it, notes to the supplier and the two optional columns. Every value
// is part of the saved draft (this browser only). Nothing here is calculated.

type SheetDetailsProps = {
  draft: OrderDraft;
  /** The date that will be printed: the chosen date, or today's date when none was chosen */
  resolvedDate: string;
  today: string;
  update: (fn: (d: OrderDraft) => OrderDraft) => void;
};

export function SheetDetails({ draft, resolvedDate, today, update }: SheetDetailsProps) {
  const titleId = useId();
  const dateId = useId();
  const dateHelpId = useId();
  const dateErrorId = useId();
  const byId = useId();
  const notesId = useId();

  return (
    <section aria-labelledby="details-heading" className={`${CARD} print:hidden`}>
      <h2 id="details-heading" className={H2}>
        Sheet details
      </h2>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <label htmlFor={titleId} className={LABEL}>
            Sheet title
          </label>
          <input
            id={titleId}
            data-testid="sheet-title"
            type="text"
            autoComplete="off"
            maxLength={ORDER_SHEET_LIMITS.title}
            value={draft.title}
            onChange={(event) => {
              const title = event.target.value;
              update((d) => ({ ...d, title }));
            }}
            className={INPUT}
          />
        </div>

        <div>
          <label htmlFor={dateId} className={LABEL}>
            Date
          </label>
          <DateField
            id={dateId}
            helpId={dateHelpId}
            errorId={dateErrorId}
            value={resolvedDate}
            today={today}
            onCommit={(date) => update((d) => ({ ...d, date }))}
          />
          <p id={dateHelpId} className={HELP}>
            Clear the field to use today’s date.
          </p>
        </div>

        <div>
          <label htmlFor={byId} className={LABEL}>
            Prepared by <span className="font-normal text-gray-600">(optional)</span>
          </label>
          <input
            id={byId}
            data-testid="sheet-prepared-by"
            type="text"
            autoComplete="off"
            maxLength={ORDER_SHEET_LIMITS.preparedBy}
            placeholder="Name or initials"
            value={draft.preparedBy}
            onChange={(event) => {
              const preparedBy = event.target.value;
              update((d) => ({ ...d, preparedBy }));
            }}
            className={INPUT}
          />
        </div>

        <div className="sm:col-span-2 lg:col-span-3">
          <label htmlFor={notesId} className={LABEL}>
            Notes to supplier <span className="font-normal text-gray-600">(optional)</span>
          </label>
          <textarea
            id={notesId}
            data-testid="sheet-notes"
            rows={3}
            maxLength={ORDER_SHEET_LIMITS.notes}
            placeholder="e.g. Deliver to the side entrance before 4 pm."
            value={draft.notes}
            onChange={(event) => {
              const notes = event.target.value;
              update((d) => ({ ...d, notes }));
            }}
            className={`${INPUT} block`}
          />
          <p className={HELP}>Printed under the table. Line breaks are kept.</p>
        </div>
      </div>

      <div className="mt-4 space-y-1">
        <CheckOption
          testId="show-on-hand"
          label="Show on-hand column on the printed sheet"
          checked={draft.showOnHand}
          onChange={(showOnHand) => update((d) => ({ ...d, showOnHand }))}
        />
        <CheckOption
          testId="show-barcode"
          label="Show barcode column"
          checked={draft.showBarcode}
          onChange={(showBarcode) => update((d) => ({ ...d, showBarcode }))}
        />
      </div>

      <p className="mt-4 text-sm text-gray-600">
        On-hand stock and order quantity are separate. Order quantity and unit are typed by staff; nothing is calculated.
      </p>
    </section>
  );
}

function CheckOption({
  testId,
  label,
  checked,
  onChange,
}: {
  testId: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg text-base text-gray-900">
      <input
        type="checkbox"
        data-testid={testId}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className={`h-5 w-5 shrink-0 accent-blue-700 ${FOCUS}`}
      />
      {label}
    </label>
  );
}

/**
 * A date box that can be edited by typing. The browser reports an unfinished date as "" while a segment is being
 * edited, so the text is kept locally and only a complete, real date from 2000 to 2099 is saved. Leaving the box
 * empty means "use today's date" (the draft stores no date and the sheet follows the calendar).
 *
 * A date outside that range is almost always a typing mistake (the browser reads a year typed as "26" as year 0026, and
 * a fifth digit as year 20265). It is not saved, so the printed sheet never shows a different date than the one the
 * person meant; once they leave the box, a message says so and names the date the sheet still uses.
 */
function DateField({
  id,
  helpId,
  errorId,
  value,
  today,
  onCommit,
}: {
  id: string;
  helpId: string;
  errorId: string;
  /** The date the sheet uses (the saved date, or today's date) */
  value: string;
  today: string;
  onCommit: (date: string | null) => void;
}) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  // Whether the person has left the box with a date that cannot be used. Not shown while they are still typing:
  // a year is typed digit by digit, and "2", "20", "202" are not usable on the way to "2026".
  const [left, setLeft] = useState(false);
  if (seen !== value) {
    // The saved date changed from outside this box (another tab, or "today" rolled over): show it.
    setSeen(value);
    setText(value);
    setLeft(false);
  }

  const showProblem = left && text !== "" && !isSheetDate(text);

  return (
    <>
      <input
        id={id}
        data-testid="sheet-date"
        type="date"
        min={SHEET_DATE_MIN}
        max={SHEET_DATE_MAX}
        aria-describedby={showProblem ? `${helpId} ${errorId}` : helpId}
        aria-invalid={showProblem ? true : undefined}
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (isSheetDate(next)) {
            setLeft(false);
            onCommit(next);
          }
        }}
        onBlur={() => {
          if (text === "") {
            onCommit(null);
            setText(today);
            setLeft(false);
          } else {
            setLeft(true);
          }
        }}
        className={showProblem ? INPUT_INVALID : INPUT}
      />
      {showProblem ? (
        <p id={errorId} role="alert" data-testid="sheet-date-error" className="mt-1.5 flex items-start gap-1.5 text-sm font-medium text-red-700">
          <WarnIcon className="mt-0.5 h-4 w-4" />
          <span>
            That date is not used: choose a date from 2000 to 2099. The sheet still shows {formatSheetDate(value)}.
          </span>
        </p>
      ) : null}
    </>
  );
}

"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Notice } from "@/app/components/Notice";
import type { BuiltSheet } from "@/lib/order-sheet/types";
import { downloadWorkbook } from "./export-client";
import type { ExportOutcome } from "./export-client";
import { DownloadIcon, PrintIcon, SpinnerIcon } from "./icons";
import { BTN_PRIMARY, BTN_SECONDARY, CARD, H2, HELP, WRAP_ACTIONS } from "./ui";

// The two ways to get the sheet out: the browser's print window (which can also "Save as PDF") and a real .xlsx
// file. Both are disabled, with the reason written next to them, when there is nothing valid to print. Neither
// places an order or changes stock.

type PrintActionsProps = {
  sheet: BuiltSheet;
  /** Changes whenever the draft changes. A plain success message goes away when the sheet is edited afterwards. */
  draftKey: unknown;
  /** Why printing and exporting are unavailable right now, or null when they are available. */
  disabledReason: string | null;
  /** Called when the server reports that some items are gone, so the page can reload its item list. */
  onInventoryChanged: () => void;
};

type StoredResult = {
  outcome: ExportOutcome;
  /** The draft at the moment the answer ARRIVED (not when Download was pressed): see runExport. */
  key: unknown;
  /** The sheet was edited between pressing Download and the answer arriving. */
  changedWhileWaiting: boolean;
};

/**
 * Which result is on screen.
 *  - A failure stays until the person presses Retry or Dismiss, or exports again. It is never removed by editing the
 *    sheet: someone who keeps typing would otherwise lose the message before they could read it.
 *  - A success describes the sheet as it was, so editing the sheet afterwards removes it ...
 *  - ... unless the sheet was already edited while the file was being made. Then the message is a warning (the file is
 *    out of date), and it stays until the person acts on it.
 */
function visibleResult(result: StoredResult | null, draftKey: unknown): StoredResult | null {
  if (result === null) return null;
  if (!result.outcome.ok || result.changedWhileWaiting) return result;
  return result.key === draftKey ? result : null;
}

const UNEXPECTED: ExportOutcome = {
  ok: false,
  message: "The Excel file could not be created. Try again, or use Print / Save as PDF instead.",
  inventoryChanged: false,
};

export function PrintActions({ sheet, draftKey, disabledReason, onInventoryChanged }: PrintActionsProps) {
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<StoredResult | null>(null);
  const exportButton = useRef<HTMLButtonElement>(null);
  const errorNotice = useRef<HTMLDivElement>(null);
  /** The newest draft, readable from the async part of runExport (which closes over the draft of the click). */
  const latestKey = useRef<unknown>(draftKey);
  const reasonId = useId();
  const disabled = disabledReason !== null;

  // A layout effect (not a passive one): it runs inside the commit, so no network answer can arrive in the gap between an
  // edit being rendered and the ref knowing about it.
  useLayoutEffect(() => {
    latestKey.current = draftKey;
  }, [draftKey]);

  const runExport = async () => {
    if (exporting || disabled) return;
    const keyAtClick = draftKey;
    setExporting(true);
    setResult(null);
    let outcome: ExportOutcome;
    try {
      outcome = await downloadWorkbook(sheet);
    } catch {
      outcome = UNEXPECTED;
    }
    // Staff may have kept typing while the file was being made. The answer is still shown: a failure must never be
    // dropped silently, and a success says so when the file does not include their latest edits (see visibleResult).
    const keyNow = latestKey.current;
    // Commit now so focus can be moved to the message (or back to the button) that this render creates.
    flushSync(() => {
      setResult({ outcome, key: keyNow, changedWhileWaiting: keyNow !== keyAtClick });
      setExporting(false);
    });
    // Move focus only when it has nowhere useful to be: on the button, or on nothing (a disabled button loses focus,
    // and so does a Retry button that was removed). If the person is typing in a field, leave them there: the
    // message is a live region, so it is announced without taking their place.
    const active = document.activeElement;
    if (active === null || active === document.body || active === exportButton.current) {
      if (outcome.ok) exportButton.current?.focus();
      else errorNotice.current?.focus();
    }
    if (!outcome.ok && outcome.inventoryChanged) onInventoryChanged();
  };

  const shown = visibleResult(result, draftKey);

  const dismissResult = () => {
    setResult(null);
    // The Dismiss button is about to disappear; keep the keyboard where the person was working.
    exportButton.current?.focus();
  };

  return (
    <section aria-labelledby="actions-heading" className={`${CARD} print:hidden`}>
      <h2 id="actions-heading" tabIndex={-1} className={`${H2} outline-none`}>
        Print or download
      </h2>
      <p className={HELP}>
        “Print / Save as PDF” opens your browser’s print window. To get a PDF file, choose “Save as PDF” as the printer there.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="print-button"
          disabled={disabled}
          aria-describedby={disabled ? reasonId : undefined}
          onClick={() => window.print()}
          className={`${BTN_PRIMARY} w-full sm:w-auto`}
        >
          <PrintIcon className="h-5 w-5" />
          Print / Save as PDF
        </button>
        <button
          ref={exportButton}
          type="button"
          data-testid="export-xlsx"
          disabled={disabled || exporting}
          aria-describedby={disabled ? reasonId : undefined}
          onClick={() => void runExport()}
          className={`${BTN_SECONDARY} w-full sm:w-auto`}
        >
          {exporting ? <SpinnerIcon className="h-5 w-5" /> : <DownloadIcon className="h-5 w-5" />}
          Download Excel (.xlsx)
        </button>
        <p role="status" className="text-sm text-gray-700">
          {exporting ? "Creating the Excel file…" : ""}
        </p>
      </div>

      {disabledReason !== null ? (
        <p id={reasonId} className="mt-3 text-sm font-medium text-gray-800">
          {disabledReason}
        </p>
      ) : null}

      {shown !== null ? (
        <div className="mt-4">
          {shown.outcome.ok ? (
            <Notice tone="success" data-testid="export-success" onDismiss={dismissResult}>
              Downloaded <span className="sheet-mono font-semibold">{shown.outcome.fileName}</span>. If you don’t see it, check
              your browser’s downloads.
              {shown.changedWhileWaiting ? (
                <>
                  {" "}
                  <strong>You changed the sheet while the file was being created, so the file does not include your latest
                  changes.</strong>{" "}
                  Download again to include them.
                </>
              ) : null}
            </Notice>
          ) : (
            <Notice
              ref={errorNotice}
              tone="error"
              title="The Excel file could not be created"
              data-testid="export-error"
              className={WRAP_ACTIONS}
              onRetry={() => void runExport()}
              retryLabel="Retry"
              onDismiss={dismissResult}
            >
              {shown.outcome.message}
              {shown.changedWhileWaiting ? " You changed the sheet while this was running. Retry uses the sheet as it is now." : ""}
            </Notice>
          )}
        </div>
      ) : null}
    </section>
  );
}

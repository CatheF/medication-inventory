import { memo } from "react";
import type { BuiltSheet, PaperSize, SheetRow } from "@/lib/order-sheet/types";
import { INVALID_QTY_PRINT_NOTE, columnWidths, formatSheetDate, planColumns, sheetFooter } from "./format";
import type { ColumnKey } from "./format";

// THE printed sheet. This one component is both the on-screen "paper" preview and what the browser prints:
// everything else on the page is print:hidden, and the print rules in app/globals.css (.print-sheet) switch the
// paper look off (fixed width, padding, shadow) and add the page-break behavior (repeat the header row on every
// page, never split a row, keep the notes row with the last item row so the last page always has an item row). It is
// black on white and uses only borders, never shading or color, so it reads the same on a black-and-white printer.
//
// It shows exactly `sheet.rows`: items that no longer exist are not in it. Quantity and unit are what staff typed
// (empty when left blank: an empty bordered cell to fill in by hand). A missing supplier order number prints as
// an em dash, the same marker the Excel file uses. No visually-hidden text lives in here: it would end up in the
// PDF's text layer.
//
// Print / Save as PDF is disabled while a typed quantity is not a valid number, but Ctrl/Cmd+P still prints the page. Such a
// row has an empty quantity cell (buildSheet blanks it), which would silently drop what staff typed. So, when printing only
// (`print:` classes: hidden on screen, where the builder already explains the problem), the cell shows "?" and a bordered line
// above the table says what the "?" means. Black on white, no color: it reads the same on a black-and-white printer.

const PAPER: Record<PaperSize, string> = {
  // 8.5 x 11 in and 210 x 297 mm at 96 dpi. Printing replaces the fixed width with the real page width.
  letter: "w-[816px] sm:min-h-[1056px]",
  a4: "w-[794px] sm:min-h-[1123px]",
};

const CELL = "border border-black px-[7px] py-[6px] text-left align-top wrap-anywhere";
const HEAD_CELL = "border border-b-2 border-black px-[7px] py-[6px] text-left align-bottom font-bold wrap-anywhere";
const CODE = "sheet-mono text-[9.5pt]";

function SheetCell({ column, row, qtyInvalid }: { column: ColumnKey; row: SheetRow; qtyInvalid: boolean }) {
  switch (column) {
    case "item":
      return <td className={CELL}>{row.name}</td>;
    case "supplier":
      return row.supplierOrderNumber === null ? (
        <td className={`${CELL} text-center`} aria-label="No supplier order number">
          —
        </td>
      ) : (
        <td className={`${CELL} ${CODE}`}>{row.supplierOrderNumber}</td>
      );
    case "qty":
      return (
        <td className={CELL}>
          {row.qty}
          {qtyInvalid ? (
            <span data-testid="print-qty-marker" className="hidden font-bold print:inline">
              ?
            </span>
          ) : null}
        </td>
      );
    case "unit":
      return <td className={CELL}>{row.unit}</td>;
    case "onHand":
      return <td className={CELL}>{`${row.onHand} ${row.stockUnit}`.trim()}</td>;
    case "barcode":
      return <td className={`${CELL} ${CODE}`}>{row.barcode}</td>;
  }
}

type BodyRowProps = {
  row: SheetRow;
  /** What staff typed for the quantity is not a valid number: the row prints a "?" (the cell itself is empty) */
  qtyInvalid: boolean;
  showOnHand: boolean;
  showBarcode: boolean;
};

/**
 * One printed row. Memoized on the row's own values (buildSheet makes new row objects on every edit, so the default
 * comparison would never skip): typing in one row's quantity re-renders only that row, which keeps a long sheet
 * responsive.
 */
const BodyRow = memo(
  function BodyRow({ row, qtyInvalid, showOnHand, showBarcode }: BodyRowProps) {
    const columns = planColumns({ showOnHand, showBarcode });
    return (
      <tr className="h-[8mm]">
        {columns.map((column) => (
          <SheetCell key={column.key} column={column.key} row={row} qtyInvalid={qtyInvalid} />
        ))}
      </tr>
    );
  },
  (a, b) =>
    a.qtyInvalid === b.qtyInvalid &&
    a.showOnHand === b.showOnHand &&
    a.showBarcode === b.showBarcode &&
    a.row.id === b.row.id &&
    a.row.name === b.row.name &&
    a.row.supplierOrderNumber === b.row.supplierOrderNumber &&
    a.row.qty === b.row.qty &&
    a.row.unit === b.row.unit &&
    a.row.onHand === b.row.onHand &&
    a.row.stockUnit === b.row.stockUnit &&
    a.row.barcode === b.row.barcode
);

/**
 * What Ctrl/Cmd+P (the browser's own print command) puts on paper while there is NO sheet to print: the inventory is still
 * loading, or it could not be loaded. The print rules hide everything but the sheet, and the sheet only exists once the
 * inventory has loaded, so without this the paper would come out completely blank, which looks like a printer fault or like
 * an empty order. It says plainly why there is nothing to print and what to do. Hidden on screen (the loading box and the
 * load error already say it there). Black on white, borders only, no color, the same as the sheet.
 */
export function PrintUnavailable({ loadFailed }: { loadFailed: boolean }) {
  return (
    <section
      data-testid="print-unavailable"
      aria-label="Order sheet not printed"
      className="print-unavailable sheet-font hidden border-2 border-black bg-white p-6 text-black print:block"
    >
      <h2 className="mb-3 text-[18pt] leading-tight font-bold">Order sheet not printed</h2>
      <p className="text-[13pt] leading-snug">
        {loadFailed
          ? "The order sheet could not be printed because the inventory could not be loaded. Close the print window, press Retry on the screen (or reload the page), then print again."
          : "The order sheet could not be printed yet because the inventory is still loading. Close the print window, wait for the list to load, then print again."}
      </p>
    </section>
  );
}

export function PrintSheet({ sheet, paper }: { sheet: BuiltSheet; paper: PaperSize }) {
  const { options, rows } = sheet;
  const invalidQty = new Set(sheet.invalidQtyIds);
  const columns = planColumns(options);
  const widths = columnWidths(columns);
  const title = options.title.trim();
  const preparedBy = options.preparedBy.trim();
  const notes = options.notes.trim();
  const dateText = formatSheetDate(options.date);
  const footer = sheetFooter(title, dateText);

  return (
    <article
      data-testid="sheet-preview"
      data-paper={paper}
      aria-label="Order sheet"
      className={`print-sheet sheet-font mx-auto bg-white p-[14mm] text-[10pt] leading-[1.35] text-black shadow-[0_2px_14px_rgba(0,0,0,0.28)] ring-1 ring-black/10 ${PAPER[paper]}`}
    >
      {title !== "" ? <h3 className="mb-2 text-[22pt] leading-[1.15] font-bold wrap-anywhere">{title}</h3> : null}
      <dl className="mb-3.5 flex flex-wrap gap-x-7 gap-y-0.5 text-[10.5pt]">
        <div>
          <dt className="inline font-bold">Date:</dt> <dd className="inline">{dateText}</dd>
        </div>
        {preparedBy !== "" ? (
          <div>
            <dt className="inline font-bold">Prepared by:</dt> <dd className="inline wrap-anywhere">{preparedBy}</dd>
          </div>
        ) : null}
      </dl>

      {invalidQty.size > 0 ? (
        <p
          data-testid="print-invalid-note"
          className="mb-3 hidden break-after-avoid border-2 border-black px-2.5 py-1.5 text-[11pt] leading-snug font-bold print:block"
        >
          {INVALID_QTY_PRINT_NOTE}
        </p>
      ) : null}

      <table className="w-full table-fixed border-collapse text-[10pt]" aria-label="Items to order">
        <colgroup>
          {columns.map((column, index) => (
            <col key={column.key} style={{ width: widths[index] }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={HEAD_CELL}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className={`${CELL} py-7 text-center italic`}>
                No items on this order sheet
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <BodyRow
                key={row.id}
                row={row}
                qtyInvalid={invalidQty.has(row.id)}
                showOnHand={options.showOnHand}
                showBarcode={options.showBarcode}
              />
            ))
          )}
          {notes !== "" ? (
            // "sheet-notes": the print rules keep this row with the item row above it (see app/globals.css), so the notes
            // never end up alone on a last page that has no item rows.
            <tr className="sheet-notes">
              <td colSpan={columns.length} className={`${CELL} border-t-2`}>
                <strong>Notes to supplier:</strong> <span className="whitespace-pre-line">{notes}</span>
              </td>
            </tr>
          ) : null}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={columns.length} className="border-0 pt-[10px] pb-0 text-left text-[9pt] wrap-anywhere">
              {footer}
            </td>
          </tr>
        </tfoot>
      </table>
    </article>
  );
}

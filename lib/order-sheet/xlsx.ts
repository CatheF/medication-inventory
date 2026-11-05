// Writes the order sheet as a real .xlsx file with the `write-excel-file` package (already a dependency).
// Everything happens in this process: no file is sent to a third-party conversion service.
//
// Safety rules enforced here:
//  * EVERY text value is an explicit string cell (`type: String`) with the "@" (Text) number format. Nothing is ever
//    written as a formula, so names like =HYPERLINK(...), +1, -2, @A1 or "\t=1" come out as literal text, and
//    supplier numbers / barcodes keep leading zeros ("0092", "00417-B") instead of becoming numbers or dates.
//  * Only the row number and the order quantity are numeric cells.
//  * Order quantity / order unit (typed by staff) and the on-hand stock (read-only) live in separate columns.
//
// Layout (sheet "Order sheet"):
//   rows 1-3  Title / Date / Prepared by   (row 4 Notes only when notes were typed)
//   blank row
//   header:   No. | Item | Supplier order no. | Order qty | Unit | [On hand] | [Barcode]
//   data rows (header row bold; the rows down to the header are frozen unless they would be taller than
//   MAX_FROZEN_PT, which only happens with long notes)
//
// Printing straight from a spreadsheet app (a supplier may well print the emailed file): the writer's only print option
// is `orientation`, which also forces A4 paper and cannot say "fit to one page wide" or "repeat the header row". So a
// small custom writer "feature" (the library's documented extension point: it transforms the XML parts before they are
// zipped) adds the print setup (see addPrintSetupToSheetXml / addPrintTitlesToWorkbookXml):
//   * fit to ONE page wide, as many pages tall as needed, portrait, paper size left to the printer (Letter or A4),
//   * the header row repeats at the top of every printed page (the Print_Titles defined name),
//   * "number stored as text" warnings are switched off for the sheet (the supplier numbers are text on purpose).
//
// SERVER-ONLY: this module uses write-excel-file/node (node:fs, node:stream). Browser code must never import it;
// the browser asks POST /api/order-sheet/xlsx for the file instead.

import writeExcelFile from "write-excel-file/node";
import type { CellObject, Row, SheetData } from "write-excel-file/node";
import { clampText, normalizeQty, normalizeUnit } from "./build";
import type { BuiltSheet, SheetRow } from "./types";

const SHEET_NAME = "Order sheet";
/** Shown when an item has no supplier order number (the printed sheet uses the same marker). */
const MISSING_SUPPLIER_MARKER = "—";
/** Excel's hard limit for the text in one cell. */
const MAX_CELL_CHARS = 32767;
/**
 * Longest Notes text, in wrapped lines, that the Notes row is made tall enough to show. Excel's hard limit for a row is
 * 409.5 pt, and 25 lines of 11 pt text need 372 pt, so the whole of a 1000-character note (the longest the form
 * accepts) shows without clipping, unless it contains more than 25 separate lines (the text is still all in the cell).
 */
const NOTES_MAX_LINES = 25;
/** Height (pt) of the rows that have no explicit height: the blank separator row and the header row. */
const DEFAULT_ROW_PT = 15;
/**
 * The rows down to the header are frozen only when together they are at most this tall (about 270 px). A taller frozen
 * block would take most of a laptop-sized window and leave almost no room to scroll the data, so with long notes
 * nothing is frozen (the printed pages still repeat the header row).
 */
const MAX_FROZEN_PT = 200;
const MONOSPACE = "Courier New";
const BORDER = { borderStyle: "thin", borderColor: "#808080" } as const;

type CellStyle = Omit<CellObject, "value" | "type" | "format">;

/** Text for a cell: always a string, CR/CRLF unified to LF, within Excel's cell limit. */
function cellText(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return clampText(text.replace(/\r\n?/g, "\n"), MAX_CELL_CHARS);
}

/** An explicit string cell in "Text" format. `""` produces an empty (but styled) cell. */
function textCell(value: unknown, style: CellStyle = {}): CellObject {
  return { value: cellText(value), type: String, format: "@", ...style };
}

function numberCell(value: number, style: CellStyle = {}): CellObject {
  return { value, type: Number, format: "0", ...style };
}

/** A bordered empty cell (the box staff fill in by hand). */
function blankCell(style: CellStyle = {}): CellObject {
  return { value: "", type: String, format: "@", ...style };
}

function supplierText(row: SheetRow): string {
  const code = row.supplierOrderNumber;
  return typeof code === "string" && code.trim() !== "" ? code : MISSING_SUPPLIER_MARKER;
}

/** "12 units": the on-hand number together with the item's own stock unit, as plain text (it is not an order unit). */
function onHandText(row: SheetRow): string {
  const unit = typeof row.stockUnit === "string" ? row.stockUnit.trim() : "";
  const count = Number.isFinite(row.onHand) ? String(row.onHand) : "";
  return unit === "" ? count : `${count} ${unit}`;
}

type ColumnSpec = {
  header: string;
  /** Width in characters */
  width: number;
  headerAlign: "left" | "center";
  cell: (row: SheetRow) => CellObject;
};

const DATA_STYLE: CellStyle = { ...BORDER, alignVertical: "top", wrap: true };
const CODE_STYLE: CellStyle = { ...DATA_STYLE, fontFamily: MONOSPACE, fontSize: 11 };

function columnSpecs(showOnHand: boolean, showBarcode: boolean): ColumnSpec[] {
  const columns: ColumnSpec[] = [
    {
      header: "No.",
      width: 13,
      headerAlign: "center",
      cell: (row) => numberCell(row.n, { ...BORDER, alignVertical: "top", align: "center" }),
    },
    { header: "Item", width: 50, headerAlign: "left", cell: (row) => textCell(row.name, DATA_STYLE) },
    {
      header: "Supplier order no.",
      width: 26,
      headerAlign: "left",
      cell: (row) => textCell(supplierText(row), CODE_STYLE),
    },
    {
      header: "Order qty",
      width: 12,
      headerAlign: "center",
      cell: (row) => {
        // Re-validated here so a hand-built sheet can never put text or NaN into the quantity column.
        const qty = normalizeQty(row.qty);
        return qty.ok && qty.value !== ""
          ? numberCell(Number(qty.value), { ...BORDER, alignVertical: "top", align: "center" })
          : blankCell({ ...BORDER, alignVertical: "top" });
      },
    },
    {
      header: "Unit",
      width: 14,
      headerAlign: "left",
      cell: (row) => textCell(normalizeUnit(row.unit), DATA_STYLE),
    },
  ];
  if (showOnHand) {
    columns.push({ header: "On hand", width: 16, headerAlign: "left", cell: (row) => textCell(onHandText(row), DATA_STYLE) });
  }
  if (showBarcode) {
    columns.push({ header: "Barcode", width: 22, headerAlign: "left", cell: (row) => textCell(row.barcode, CODE_STYLE) });
  }
  return columns;
}

/** Rough row height (points) for wrapped text in a merged cell. Excel does not auto-fit merged cells, so it is set. */
function mergedRowHeight(text: string, widthChars: number, fontSize: number, maxLines: number): number {
  const charsPerLine = Math.max(10, Math.floor(widthChars * (11 / fontSize) * 0.85));
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    lines += Math.max(1, Math.ceil(Array.from(paragraph).length / charsPerLine));
    if (lines >= maxLines) {
      lines = maxLines;
      break;
    }
  }
  return Math.max(15, Math.ceil(lines * fontSize * 1.35));
}

// ── Print setup (XML transforms, applied by a writer feature in buildOrderSheetXlsx) ─────────────────────────────────

/** Spreadsheet column letters: 1 → A, 26 → Z, 27 → AA. */
function columnLetter(index: number): string {
  let letters = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** First child of <worksheet>: "fit the sheet to the page width" is switched on here and configured in pageSetup. */
const FIT_TO_PAGE = '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>';
const PAGE_MARGINS = '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>';
/** One page wide, as many pages tall as needed (fitToHeight 0). No paperSize: Letter or A4 follows the printer. */
const PAGE_SETUP = '<pageSetup orientation="portrait" fitToWidth="1" fitToHeight="0"/>';

export type PrintSetupArea = {
  /** Number of columns in the table (A..) */
  lastColumn: number;
  /** 1-based number of the last row that has content */
  lastRow: number;
};

/**
 * Adds the print setup to the worksheet XML. Pure string work on the writer's known output; every insertion needs its
 * exact anchor and refuses to duplicate an element that is already there, so an unexpected shape leaves the XML
 * untouched (a valid sheet that simply prints less nicely) rather than producing a file Excel would "repair".
 *
 * Child order of <worksheet> follows the file format: sheetPr, (sheetViews, cols, sheetData, mergeCells), then
 * pageMargins, pageSetup, ignoredErrors.
 */
export function addPrintSetupToSheetXml(sheetXml: string, area: PrintSetupArea): string {
  let xml = sheetXml;

  if (!/<sheetPr[\s>/]/.test(xml)) {
    // An opening tag only: a self-closing <worksheet/> has no content to put it in.
    xml = xml.replace(/<worksheet(?:\s[^>]*[^/>])?>/, (open) => open + FIT_TO_PAGE);
  }

  const hasPageElements = /<pageMargins[\s>/]/.test(xml) || /<pageSetup[\s>/]/.test(xml);
  if (!hasPageElements) {
    // The sheet's text cells hold supplier numbers and barcodes such as "0092" on purpose: no green "number stored as text" flags.
    const ignoredErrors = /<ignoredErrors[\s>/]/.test(xml)
      ? ""
      : `<ignoredErrors><ignoredError sqref="A1:${columnLetter(area.lastColumn)}${area.lastRow}" numberStoredAsText="1"/></ignoredErrors>`;
    const block = PAGE_MARGINS + PAGE_SETUP + ignoredErrors;
    const anchor = xml.includes("</mergeCells>") ? "</mergeCells>" : "</sheetData>";
    xml = xml.replace(anchor, (found) => found + block);
  }
  return xml;
}

/**
 * Makes the header row repeat at the top of every printed page: the built-in "Print_Titles" name of sheet 0.
 * Only the writer's empty `<definedNames/>` is replaced; any other shape is left alone.
 * (The replacements here and above are functions, so a `$` in the inserted text is never read as a replacement pattern.)
 */
export function addPrintTitlesToWorkbookXml(workbookXml: string, headerRow: number): string {
  const reference = `'${SHEET_NAME.replace(/'/g, "''")}'!$${headerRow}:$${headerRow}`;
  const definedNames =
    `<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">${escapeXml(reference)}</definedName></definedNames>`;
  return workbookXml.replace("<definedNames/>", () => definedNames);
}

/**
 * Builds the workbook bytes for a BuiltSheet. Rejects only if the underlying writer fails.
 * The caller is responsible for deciding which rows are on the sheet (see buildSheet).
 */
export async function buildOrderSheetXlsx(sheet: BuiltSheet): Promise<Uint8Array<ArrayBuffer>> {
  const { options, rows } = sheet;
  const columns = columnSpecs(options.showOnHand === true, options.showBarcode === true);
  const columnCount = columns.length;
  const valueSpan = columnCount - 1; // the metadata values span every column after the label column
  const valueWidth = columns.slice(1).reduce((sum, column) => sum + column.width, 0);

  const data: SheetData = [];
  /** Height (pt) of every row above the first data row, in order, to decide whether freezing them is sensible. */
  const topRowHeights: number[] = [];

  const addMetaRow = (label: string, value: unknown, opts: { bold?: boolean; fontSize?: number; maxLines: number }): void => {
    const text = cellText(value);
    const fontSize = opts.fontSize ?? 11;
    const height = mergedRowHeight(text, valueWidth, fontSize, opts.maxLines);
    const cells: Row = [
      textCell(label, { fontWeight: "bold", alignVertical: "top" }),
      textCell(text, {
        alignVertical: "top",
        wrap: true,
        columnSpan: valueSpan,
        height,
        ...(opts.bold ? { fontWeight: "bold" as const } : {}),
        ...(opts.fontSize ? { fontSize: opts.fontSize } : {}),
      }),
    ];
    for (let i = 2; i < columnCount; i += 1) cells.push(null); // covered by the merged value cell
    data.push(cells);
    topRowHeights.push(height);
  };

  addMetaRow("Title", options.title, { bold: true, fontSize: 14, maxLines: 3 });
  addMetaRow("Date", options.date, { maxLines: 1 });
  addMetaRow("Prepared by", options.preparedBy, { maxLines: 2 });
  if (cellText(options.notes).trim() !== "") {
    addMetaRow("Notes", options.notes, { maxLines: NOTES_MAX_LINES });
  }
  data.push([]); // blank separator row
  topRowHeights.push(DEFAULT_ROW_PT);

  data.push(
    columns.map((column) =>
      textCell(column.header, {
        ...BORDER,
        fontWeight: "bold",
        backgroundColor: "#E7E6E6",
        align: column.headerAlign,
        alignVertical: "center",
        wrap: true,
      })
    )
  );
  topRowHeights.push(DEFAULT_ROW_PT);
  const headerRowNumber = data.length; // 1-based number of the header row = number of rows to freeze
  const frozenPoints = topRowHeights.reduce((sum, height) => sum + height, 0);

  for (const row of rows) {
    data.push(columns.map((column) => column.cell(row)));
  }
  const lastRow = data.length; // 1-based number of the last row that has content

  const buffer = await writeExcelFile(
    data,
    {
      sheet: SHEET_NAME,
      columns: columns.map((column) => ({ width: column.width })),
      // Freeze down to the header row, unless that block is so tall (long notes) that it would crowd out the data.
      ...(frozenPoints <= MAX_FROZEN_PT ? { stickyRowsCount: headerRowNumber } : {}),
    },
    {
      // An explicit default font keeps bold / plain / monospace cells in one consistent family and size everywhere.
      fontFamily: "Calibri",
      fontSize: 11,
      // The print setup (see the header comment). Custom features run after the writer's own, so by the time this one
      // sees the worksheet it already has its <sheetViews>, and <sheetPr> is put in front of it.
      features: [
        {
          files: {
            transform: {
              "xl/worksheets/sheet{id}.xml": {
                transform: (xml) => addPrintSetupToSheetXml(xml, { lastColumn: columnCount, lastRow }),
              },
              "xl/workbook.xml": {
                transform: (xml) => addPrintTitlesToWorkbookXml(xml, headerRowNumber),
              },
            },
          },
        },
      ],
    }
  ).toBuffer();

  // A plain Uint8Array copy (Buffer is a pooled Uint8Array subclass; callers expect a standalone byte array).
  return new Uint8Array(buffer);
}

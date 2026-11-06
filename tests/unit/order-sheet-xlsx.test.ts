// Inspects the generated workbook with Node built-ins and fflate only (no spreadsheet library, no Python):
// the .xlsx is a zip of XML parts, so every claim below is checked on the real bytes.
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { Medication } from "@/lib/db";
import { buildSheet } from "@/lib/order-sheet/build";
import type { BuiltSheet, SheetOptions, SheetRow, SheetRowInput } from "@/lib/order-sheet/types";
import { addPrintSetupToSheetXml, addPrintTitlesToWorkbookXml, buildOrderSheetXlsx } from "@/lib/order-sheet/xlsx";
import {
  FORMULA_NAMES,
  TRICKY_SUPPLIER_NUMBERS,
  UNUSUAL_NAMES,
  buildManyMedications,
  buildMedications,
} from "@/tests/helpers/fixtures";

// ── minimal xlsx reader ──────────────────────────────────────────────────────────────────────────────────────────

type Cell = { ref: string; type: string | null; style: number | null; raw: string | null };
type Xf = { numFmtId: number | null; fontId: number | null; wrap: boolean };
type Workbook = {
  names: string[];
  xml: Record<string, string>;
  shared: string[];
  cells: Map<string, Cell>;
  rowAttrs: Map<number, Record<string, string>>;
  xfs: Xf[];
  fonts: string[];
  numFmts: Map<number, string>;
  bytes: Uint8Array;
};

function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

function readWorkbook(bytes: Uint8Array): Workbook {
  const files = unzipSync(bytes);
  const xml: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) xml[name] = strFromU8(data);

  const shared: string[] = [];
  for (const m of (xml["xl/sharedStrings.xml"] ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const t = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(m[1]);
    shared.push(unescapeXml(t ? t[1] : ""));
  }

  const sheetXml = xml["xl/worksheets/sheet1.xml"] ?? "";
  const cells = new Map<string, Cell>();
  for (const m of sheetXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const a = attributes(m[1]);
    const value = m[2] !== undefined ? /<v>([\s\S]*?)<\/v>/.exec(m[2]) : null;
    cells.set(a.r, { ref: a.r, type: a.t ?? null, style: a.s !== undefined ? Number(a.s) : null, raw: value ? value[1] : null });
  }
  const rowAttrs = new Map<number, Record<string, string>>();
  for (const m of sheetXml.matchAll(/<row\b([^>]*?)\/?>/g)) {
    const a = attributes(m[1]);
    rowAttrs.set(Number(a.r), a);
  }

  const stylesXml = xml["xl/styles.xml"] ?? "";
  const numFmts = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\b([^>]*)\/>/g)) {
    const a = attributes(m[1]);
    numFmts.set(Number(a.numFmtId), a.formatCode);
  }
  const fontsBlock = /<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(stylesXml)?.[1] ?? "";
  const fonts = [...fontsBlock.matchAll(/<font>([\s\S]*?)<\/font>/g)].map((m) => m[1]);
  const xfBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? "";
  const xfs: Xf[] = [...xfBlock.matchAll(/<xf\b([^>]*)>([\s\S]*?)<\/xf>/g)].map((m) => {
    const a = attributes(m[1]);
    return {
      numFmtId: a.numFmtId !== undefined ? Number(a.numFmtId) : null,
      fontId: a.fontId !== undefined ? Number(a.fontId) : null,
      wrap: /wrapText="1"/.test(m[2]),
    };
  });
  return { names: Object.keys(files), xml, shared, cells, rowAttrs, xfs, fonts, numFmts, bytes };
}

/** What a cell holds: the shared string for t="s", a number for numeric cells, null for an empty cell, undefined if absent. */
function valueAt(wb: Workbook, ref: string): string | number | null | undefined {
  const cell = wb.cells.get(ref);
  if (!cell) return undefined;
  if (cell.raw === null) return null;
  if (cell.type === "s") return wb.shared[Number(cell.raw)];
  return Number(cell.raw);
}

function isTextFormat(wb: Workbook, cell: Cell): boolean {
  const xf = wb.xfs[cell.style ?? 0];
  return xf !== undefined && xf.numFmtId !== null && (xf.numFmtId === 49 || wb.numFmts.get(xf.numFmtId) === "@");
}

function isBold(wb: Workbook, cell: Cell): boolean {
  const xf = wb.xfs[cell.style ?? 0];
  return xf !== undefined && xf.fontId !== null && (wb.fonts[xf.fontId] ?? "").includes("<b/>");
}

function wraps(wb: Workbook, cell: Cell): boolean {
  return wb.xfs[cell.style ?? 0]?.wrap === true;
}

function allXml(wb: Workbook): string[] {
  return Object.entries(wb.xml)
    .filter(([name]) => name.endsWith(".xml") || name.endsWith(".rels"))
    .map(([, text]) => text);
}

const SHEET_PART = "xl/worksheets/sheet1.xml";
const WORKBOOK_PART = "xl/workbook.xml";
/** Excel refuses (or "repairs") a row taller than this many points. */
const EXCEL_MAX_ROW_HEIGHT = 409.5;

/** The order of the child elements of <worksheet> required by the file format (ECMA-376, CT_Worksheet). */
const WORKSHEET_CHILD_ORDER = [
  "sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "sheetCalcPr", "sheetProtection",
  "protectedRanges", "scenarios", "autoFilter", "sortState", "dataConsolidate", "customSheetViews", "mergeCells",
  "phoneticPr", "conditionalFormatting", "dataValidations", "hyperlinks", "printOptions", "pageMargins", "pageSetup",
  "headerFooter", "rowBreaks", "colBreaks", "customProperties", "cellWatches", "ignoredErrors", "smartTags", "drawing",
  "legacyDrawing", "legacyDrawingHF", "drawingHF", "picture", "oleObjects", "controls", "webPublishItems", "tableParts",
  "extLst",
];

/** Names of the direct children of the root element, in document order (a small tag scanner; no XML library needed). */
function rootChildren(xml: string): string[] {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  const names: string[] = [];
  let depth = 0;
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)\b[^>]*?(\/?)>/g)) {
    if (m[1] === "/") {
      depth -= 1;
      continue;
    }
    if (depth === 1) names.push(m[2]);
    if (m[3] !== "/") depth += 1;
  }
  return names;
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────

const OPTIONS: SheetOptions = {
  title: "Supply order",
  date: "2026-11-05",
  preparedBy: "Jane Doe",
  notes: "",
  showOnHand: false,
  showBarcode: false,
};

function med(id: number, overrides: Partial<Medication> = {}): Medication {
  return {
    id,
    name: `Item ${id}`,
    barcode: `0000000${id}`.slice(-10),
    photo_url: null,
    stock: 7,
    threshold: 3,
    vendor_url: null,
    unit: "units",
    notes: null,
    category_id: null,
    supplier_order_number: null,
    is_unnamed: false,
    created_at: "2026-08-11T16:00:00+00:00",
    updated_at: "2026-10-28T16:02:00+00:00",
    ...overrides,
  };
}

function inputs(items: Medication[], make: (m: Medication, i: number) => Partial<SheetRowInput> = () => ({})): SheetRowInput[] {
  return items.map((m, i) => ({ id: m.id, qty: "", unit: "", ...make(m, i) }));
}

async function exportOf(items: Medication[], rows: SheetRowInput[], options: SheetOptions = OPTIONS): Promise<Workbook> {
  const bytes = await buildOrderSheetXlsx(buildSheet(items, rows, options));
  return readWorkbook(bytes);
}

function handBuilt(rows: Partial<SheetRow>[], options: Partial<SheetOptions> = {}): BuiltSheet {
  return {
    options: { ...OPTIONS, ...options },
    rows: rows.map((r, i) => ({
      n: i + 1,
      id: i + 1,
      name: `Row ${i + 1}`,
      nameIsFallback: false,
      supplierOrderNumber: null,
      qty: "",
      unit: "",
      onHand: 0,
      stockUnit: "units",
      barcode: "0",
      ...r,
    })),
    missingIds: [],
    duplicateIds: [],
    invalidQtyIds: [],
  };
}

const DASH = "—";

// ── tests ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("buildOrderSheetXlsx: package", () => {
  it("returns a standalone Uint8Array holding a real zip with the parts a spreadsheet needs", async () => {
    const bytes = await buildOrderSheetXlsx(buildSheet(buildMedications(), inputs(buildMedications().slice(0, 3)), OPTIONS));
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(bytes)).toBe(false);
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe("PK");

    const wb = readWorkbook(bytes);
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
      "xl/styles.xml",
      "xl/sharedStrings.xml",
    ]) {
      expect(wb.names).toContain(part);
    }
    expect(wb.xml["[Content_Types].xml"]).toContain("spreadsheetml.sheet.main+xml");
    expect(wb.names.filter((n) => n.startsWith("xl/worksheets/sheet"))).toEqual(["xl/worksheets/sheet1.xml"]);
    expect(wb.xml["xl/workbook.xml"]).toContain('name="Order sheet"');
  });

  it("is a real workbook, not CSV text: no part is plain delimited text", async () => {
    const wb = await exportOf([med(1)], inputs([med(1)]));
    expect(wb.xml["xl/worksheets/sheet1.xml"].startsWith("<?xml")).toBe(true);
  });
});

describe("buildOrderSheetXlsx: layout", () => {
  it("puts Title / Date / Prepared by in rows 1-3, a blank row, then the header and data", async () => {
    const items = [med(1, { name: "Gauze", supplier_order_number: "00417-B" }), med(2, { name: "Gloves" })];
    const wb = await exportOf(items, inputs(items, (_m, i) => ({ qty: i === 0 ? "12" : "", unit: i === 0 ? "box" : "" })));
    expect(valueAt(wb, "A1")).toBe("Title");
    expect(valueAt(wb, "B1")).toBe("Supply order");
    expect(valueAt(wb, "A2")).toBe("Date");
    expect(valueAt(wb, "B2")).toBe("2026-11-05");
    expect(valueAt(wb, "A3")).toBe("Prepared by");
    expect(valueAt(wb, "B3")).toBe("Jane Doe");
    for (const ref of ["A4", "B4", "C4"]) expect(valueAt(wb, ref) ?? null).toBeNull();
    expect(["A5", "B5", "C5", "D5", "E5"].map((ref) => valueAt(wb, ref))).toEqual(["No.", "Item", "Supplier order no.", "Order qty", "Unit"]);
    expect(valueAt(wb, "F5")).toBeUndefined();
    expect(["A6", "B6", "C6", "D6", "E6"].map((ref) => valueAt(wb, ref))).toEqual([1, "Gauze", "00417-B", 12, "box"]);
    expect(["A7", "B7", "C7", "D7", "E7"].map((ref) => valueAt(wb, ref) ?? null)).toEqual([2, "Gloves", DASH, null, null]);
    expect(wb.cells.has("A8")).toBe(false);
  });

  it("adds a Notes row (row 4) only when notes were typed, which moves the header down by one", async () => {
    const wb = await exportOf([med(1)], inputs([med(1)]), { ...OPTIONS, notes: "Deliver to the loading dock.\nCall first." });
    expect(valueAt(wb, "A4")).toBe("Notes");
    expect(valueAt(wb, "B4")).toBe("Deliver to the loading dock.\nCall first.");
    expect(valueAt(wb, "A6")).toBe("No.");
    expect(valueAt(wb, "A7")).toBe(1);

    const blankNotes = await exportOf([med(1)], inputs([med(1)]), { ...OPTIONS, notes: "   \n " });
    expect(valueAt(blankNotes, "A4") ?? null).toBeNull();
    expect(valueAt(blankNotes, "A5")).toBe("No.");
  });

  it("keeps the Prepared by row (blank) so staff can fill it in", async () => {
    const wb = await exportOf([med(1)], inputs([med(1)]), { ...OPTIONS, preparedBy: "" });
    expect(valueAt(wb, "A3")).toBe("Prepared by");
    expect(valueAt(wb, "B3") ?? null).toBeNull();
    expect(valueAt(wb, "A5")).toBe("No.");
  });

  it("shows the optional On hand and Barcode columns only when asked, in that order", async () => {
    const items = [med(1, { barcode: "0049000028911", stock: 18, unit: "units" })];
    const rows = inputs(items, () => ({ qty: "5", unit: "case" }));
    const base = await exportOf(items, rows);
    expect(valueAt(base, "F5")).toBeUndefined();

    const onHand = await exportOf(items, rows, { ...OPTIONS, showOnHand: true });
    expect(valueAt(onHand, "F5")).toBe("On hand");
    expect(valueAt(onHand, "G5")).toBeUndefined();
    expect(valueAt(onHand, "F6")).toBe("18 units");

    const barcode = await exportOf(items, rows, { ...OPTIONS, showBarcode: true });
    expect(valueAt(barcode, "F5")).toBe("Barcode");
    expect(valueAt(barcode, "F6")).toBe("0049000028911");

    const both = await exportOf(items, rows, { ...OPTIONS, showOnHand: true, showBarcode: true });
    expect([valueAt(both, "F5"), valueAt(both, "G5"), valueAt(both, "F6"), valueAt(both, "G6")]).toEqual([
      "On hand",
      "Barcode",
      "18 units",
      "0049000028911",
    ]);
  });

  it("freezes everything down to the header row", async () => {
    const plain = await exportOf([med(1)], inputs([med(1)]));
    const pane = /<pane\b([^>]*)\/>/.exec(plain.xml["xl/worksheets/sheet1.xml"]);
    expect(pane).not.toBeNull();
    expect(attributes(pane![1])).toMatchObject({ ySplit: "5", topLeftCell: "A6", state: "frozen" });

    const withNotes = await exportOf([med(1)], inputs([med(1)]), { ...OPTIONS, notes: "x" });
    const pane2 = /<pane\b([^>]*)\/>/.exec(withNotes.xml["xl/worksheets/sheet1.xml"]);
    expect(attributes(pane2![1])).toMatchObject({ ySplit: "6", topLeftCell: "A7", state: "frozen" });
  });

  it("sets sensible column widths, with the item column the widest", async () => {
    const wb = await exportOf([med(1)], inputs([med(1)]), { ...OPTIONS, showOnHand: true, showBarcode: true });
    const cols = [...wb.xml["xl/worksheets/sheet1.xml"].matchAll(/<col\b([^>]*)\/>/g)].map((m) => attributes(m[1]));
    expect(cols).toHaveLength(7);
    const widths = cols.map((c) => Number(c.width));
    expect(cols.every((c) => c.customWidth === "1")).toBe(true);
    expect(widths.every((w) => w >= 10 && w <= 60)).toBe(true);
    expect(widths[1]).toBe(Math.max(...widths));
    expect(cols.map((c) => Number(c.min))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("merges each metadata value across the table width so long text can wrap", async () => {
    const wb = await exportOf([med(1)], inputs([med(1)]), { ...OPTIONS, notes: "n" });
    const merges = [...wb.xml["xl/worksheets/sheet1.xml"].matchAll(/<mergeCell ref="([^"]+)"/g)].map((m) => m[1]);
    expect(merges).toEqual(["B1:E1", "B2:E2", "B3:E3", "B4:E4"]);
    const wide = await exportOf([med(1)], inputs([med(1)]), { ...OPTIONS, showOnHand: true, showBarcode: true });
    expect([...wide.xml["xl/worksheets/sheet1.xml"].matchAll(/<mergeCell ref="([^"]+)"/g)].map((m) => m[1])[0]).toBe("B1:G1");
  });

  it("makes the header row bold and the data wrap, with borders", async () => {
    const items = [med(1, { name: "A fairly long name that will need to wrap inside the item column of the sheet" })];
    const wb = await exportOf(items, inputs(items), { ...OPTIONS, showOnHand: true, showBarcode: true });
    for (const ref of ["A5", "B5", "C5", "D5", "E5", "F5", "G5"]) {
      expect(isBold(wb, wb.cells.get(ref)!)).toBe(true);
    }
    for (const ref of ["B6", "C6", "E6", "F6", "G6"]) {
      expect(wraps(wb, wb.cells.get(ref)!)).toBe(true);
    }
    expect(isBold(wb, wb.cells.get("B6")!)).toBe(false);
    expect(wb.xml["xl/styles.xml"]).toContain('<border><left style="thin">');
    // labels in the metadata block are bold, values are not (the title value is)
    expect(isBold(wb, wb.cells.get("A2")!)).toBe(true);
    expect(isBold(wb, wb.cells.get("B2")!)).toBe(false);
    expect(isBold(wb, wb.cells.get("B1")!)).toBe(true);
  });

  it("gives long metadata text an explicit row height (merged cells do not auto-fit), never above Excel's own limit", async () => {
    const long = await exportOf([med(1)], inputs([med(1)]), {
      ...OPTIONS,
      title: "T".repeat(120),
      notes: "word ".repeat(400),
    });
    const titleHeight = Number(long.rowAttrs.get(1)?.ht);
    const notesHeight = Number(long.rowAttrs.get(4)?.ht);
    expect(long.rowAttrs.get(4)?.customHeight).toBe("1");
    expect(titleHeight).toBeGreaterThanOrEqual(19 * 2);
    expect(notesHeight).toBeGreaterThan(30);
    expect(notesHeight).toBeLessThanOrEqual(EXCEL_MAX_ROW_HEIGHT);

    const short = await exportOf([med(1)], inputs([med(1)]), { ...OPTIONS, notes: "Deliver Friday." });
    expect(Number(short.rowAttrs.get(2)?.ht)).toBe(15);
    expect(Number(short.rowAttrs.get(4)?.ht)).toBe(15);
  });
});

// The Notes row grows with the note up to 25 lines (372 pt, under Excel's own 409.5 pt row limit), so a longer note is
// not silently cut off in the sheet.
describe("buildOrderSheetXlsx: the Notes row shows the whole note", () => {
  const EXPECTED_25_LINES_PT = Math.ceil(25 * 11 * 1.35); // 372
  const noteLines = (count: number) => Array.from({ length: count }, (_v, i) => `Line ${i + 1}`).join("\n");
  const prose1000 = "Call the loading dock before delivery and ask for the receiving clerk. ".repeat(20).slice(0, 1000);

  it("is tall enough for 25 separate lines: the documented cap, 372 pt (it was 149 pt, about 10 lines)", async () => {
    const wb = await exportOf([med(1)], inputs([med(1)]), { ...OPTIONS, notes: noteLines(25) });
    expect(Number(wb.rowAttrs.get(4)?.ht)).toBe(EXPECTED_25_LINES_PT);
    expect(wb.rowAttrs.get(4)?.customHeight).toBe("1");
    expect(valueAt(wb, "B4")).toBe(noteLines(25));
  });

  it("grows with the text: 10, 12 and 25 lines each get their own height, not one shared 10-line cap", async () => {
    const heightOf = async (notes: string) => Number((await exportOf([med(1)], inputs([med(1)]), { ...OPTIONS, notes })).rowAttrs.get(4)?.ht);
    expect(await heightOf(noteLines(10))).toBe(Math.ceil(10 * 11 * 1.35)); // 149
    expect(await heightOf(noteLines(12))).toBe(Math.ceil(12 * 11 * 1.35)); // 179: taller than the 10-line row (149 pt)
    expect(await heightOf(noteLines(25))).toBe(EXPECTED_25_LINES_PT);
  });

  it("makes a 1000-character paragraph (the longest the form accepts) tall enough: 12 wrapped lines, 179 pt", async () => {
    const wb = await exportOf([med(1)], inputs([med(1)]), { ...OPTIONS, notes: prose1000 });
    expect(prose1000).toHaveLength(1000);
    expect(Number(wb.rowAttrs.get(4)?.ht)).toBe(Math.ceil(12 * 11 * 1.35));
    expect(valueAt(wb, "B4")).toBe(prose1000);
  });

  it("stops at the cap for more than 25 lines, below Excel's row limit, and still keeps every line in the cell", async () => {
    for (const lineCount of [26, 40, 400]) {
      const note = noteLines(lineCount);
      const wb = await exportOf([med(1)], inputs([med(1)]), { ...OPTIONS, notes: note });
      expect(Number(wb.rowAttrs.get(4)?.ht), `${lineCount} lines`).toBe(EXPECTED_25_LINES_PT);
      expect(Number(wb.rowAttrs.get(4)?.ht)).toBeLessThanOrEqual(EXCEL_MAX_ROW_HEIGHT);
      expect(valueAt(wb, "B4"), `${lineCount} lines`).toBe(note); // the text itself is never cut
    }
  });
});

// A frozen block taller than the window leaves no room to scroll the data, so long notes switch the freeze off.
describe("buildOrderSheetXlsx: freezing the rows above the data", () => {
  const noteLines = (count: number) => Array.from({ length: count }, (_v, i) => `Line ${i + 1}`).join("\n");
  const panes = async (options: Partial<SheetOptions>) =>
    /<pane\b([^>]*)\/>/.exec((await exportOf([med(1)], inputs([med(1)]), { ...OPTIONS, ...options })).xml[SHEET_PART]);

  it("keeps the freeze with no notes, a short note and up to 8 lines of notes (the block stays within 200 pt)", async () => {
    expect(attributes((await panes({}))![1])).toMatchObject({ ySplit: "5", state: "frozen" });
    expect(attributes((await panes({ notes: "Call first." }))![1])).toMatchObject({ ySplit: "6", state: "frozen" });
    expect(attributes((await panes({ notes: noteLines(8) }))![1])).toMatchObject({ ySplit: "6", state: "frozen" });
  });

  it("drops the freeze for notes of 10 or more lines: 228 pt (about 304 px) of frozen rows would crowd out the data", async () => {
    expect(await panes({ notes: noteLines(10) })).toBeNull();
    expect(await panes({ notes: noteLines(25) })).toBeNull();
    expect(await panes({ notes: "word ".repeat(400) })).toBeNull();
  });

  it("still writes the complete table when nothing is frozen, and the header row still prints on every page", async () => {
    const wb = await exportOf([med(1), med(2)], inputs([med(1), med(2)]), { ...OPTIONS, notes: noteLines(25) });
    expect(valueAt(wb, "A6")).toBe("No.");
    expect(valueAt(wb, "A7")).toBe(1);
    expect(valueAt(wb, "A8")).toBe(2);
    expect(wb.xml["xl/workbook.xml"]).toContain("'Order sheet'!$6:$6");
  });
});

// Printing the .xlsx from a spreadsheet app must keep the table one page wide (names, supplier numbers and quantities on
// the same pages) and repeat the header row on every page. The writer library cannot set up printing itself, so a small
// writer "feature" adds it to the XML; these tests pin what ends up in the file.
describe("buildOrderSheetXlsx: printing the file from a spreadsheet app", () => {
  it("fits the table to one page wide, as many pages tall as needed, portrait, with margins", async () => {
    const wb = await exportOf([med(1)], inputs([med(1)]));
    const sheet = wb.xml[SHEET_PART];
    expect(sheet).toMatch(/^<\?xml[^>]*\?><worksheet\b[^>]*><sheetPr><pageSetUpPr fitToPage="1"\/><\/sheetPr>/);
    const setup = /<pageSetup\b([^>]*)\/>/.exec(sheet);
    expect(setup).not.toBeNull();
    expect(attributes(setup![1])).toEqual({ orientation: "portrait", fitToWidth: "1", fitToHeight: "0" });
    const margins = /<pageMargins\b([^>]*)\/>/.exec(sheet);
    expect(attributes(margins![1])).toEqual({ left: "0.5", right: "0.5", top: "0.6", bottom: "0.6", header: "0.3", footer: "0.3" });
  });

  it("does not hard-code a paper size, so Letter or A4 follows the printer (the writer's own default is A4)", async () => {
    for (const options of [OPTIONS, { ...OPTIONS, showOnHand: true, showBarcode: true }, { ...OPTIONS, notes: "x" }]) {
      const wb = await exportOf([med(1)], inputs([med(1)]), options);
      expect(wb.xml[SHEET_PART]).not.toContain("paperSize");
      expect(wb.xml[SHEET_PART].match(/<pageSetup\b/g)).toHaveLength(1);
      expect(wb.xml[SHEET_PART].match(/<pageMargins\b/g)).toHaveLength(1);
    }
  });

  it("repeats the header row at the top of every printed page (Print_Titles of sheet 0)", async () => {
    const plain = await exportOf([med(1)], inputs([med(1)]));
    expect(plain.xml[WORKBOOK_PART]).toContain(
      `<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">'Order sheet'!$5:$5</definedName></definedNames>`
    );
    expect(plain.xml[WORKBOOK_PART]).not.toContain("<definedNames/>");
    expect(valueAt(plain, "A5")).toBe("No."); // the repeated row really is the header row

    // with a Notes row the header is one row lower, and the repeated row follows it
    const withNotes = await exportOf([med(1)], inputs([med(1)]), { ...OPTIONS, notes: "Call first." });
    expect(withNotes.xml[WORKBOOK_PART]).toContain("'Order sheet'!$6:$6</definedName>");
    expect(valueAt(withNotes, "A6")).toBe("No.");

    // the sheet name in the reference matches the sheet's real name
    expect(plain.xml[WORKBOOK_PART]).toContain('name="Order sheet"');
  });

  it("does not repeat the title / date / notes block, only the header row", async () => {
    const wb = await exportOf([med(1)], inputs([med(1)]), { ...OPTIONS, notes: "n" });
    const reference = /<definedName\b[^>]*>([^<]*)<\/definedName>/.exec(wb.xml[WORKBOOK_PART])?.[1];
    expect(reference).toBe("'Order sheet'!$6:$6"); // one row, not $1:$6
  });

  it("switches off 'number stored as text' flags over the whole table (supplier numbers like 0092 are text on purpose)", async () => {
    const two = await exportOf([med(1), med(2)], inputs([med(1), med(2)]));
    expect(two.xml[SHEET_PART]).toContain('<ignoredErrors><ignoredError sqref="A1:E7" numberStoredAsText="1"/></ignoredErrors>');
    const wide = await exportOf([med(1)], inputs([med(1)]), { ...OPTIONS, showOnHand: true, showBarcode: true });
    expect(wide.xml[SHEET_PART]).toContain('sqref="A1:G6"');
    const empty = await buildOrderSheetXlsx(handBuilt([])).then(readWorkbook);
    expect(empty.xml[SHEET_PART]).toContain('sqref="A1:E5"');
  });

  it("keeps the worksheet's child elements in the order the file format requires (Excel 'repairs' a file that breaks it)", async () => {
    const lines25 = Array.from({ length: 25 }, (_v, i) => `Line ${i + 1}`).join("\n");
    for (const options of [OPTIONS, { ...OPTIONS, notes: "x" }, { ...OPTIONS, notes: lines25 }, { ...OPTIONS, showOnHand: true, showBarcode: true }]) {
      const wb = await exportOf([med(1)], inputs([med(1)]), options);
      const children = rootChildren(wb.xml[SHEET_PART]);
      const positions = children.map((name) => WORKSHEET_CHILD_ORDER.indexOf(name));
      expect(positions.every((position) => position >= 0), children.join(",")).toBe(true);
      expect(positions, children.join(",")).toEqual([...positions].sort((a, b) => a - b));
      expect(new Set(children).size, "no element twice").toBe(children.length);
      for (const required of ["sheetPr", "cols", "sheetData", "mergeCells", "pageMargins", "pageSetup", "ignoredErrors"]) {
        expect(children).toContain(required);
      }
    }
  });

  it("still returns a complete, readable package with the print setup in it", async () => {
    const wb = await exportOf(buildMedications(), inputs(buildMedications().slice(0, 5)));
    expect(wb.names[0]).toBe("[Content_Types].xml");
    for (const part of ["_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", SHEET_PART, "xl/styles.xml", "xl/sharedStrings.xml"]) {
      expect(wb.names).toContain(part);
    }
    // XML that was edited must still be well formed: one root element, balanced and closed
    for (const part of [WORKBOOK_PART, SHEET_PART]) {
      const xml = wb.xml[part];
      expect(xml.startsWith("<?xml")).toBe(true);
      expect(rootChildren(xml).length).toBeGreaterThan(0);
      expect(xml.trimEnd().endsWith(part === SHEET_PART ? "</worksheet>" : "</workbook>")).toBe(true);
    }
    expect(valueAt(wb, "B6")).toBe(buildMedications()[0].name);
  });
});

describe("print setup helpers", () => {
  const SHEET =
    '<?xml version="1.0" ?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews><cols><col min="1" max="1" width="13"/></cols><sheetData><row r="1"/></sheetData>' +
    '<mergeCells count="1"><mergeCell ref="B1:E1"/></mergeCells></worksheet>';
  const AREA = { lastColumn: 5, lastRow: 7 };

  it("adds sheetPr first and the page elements after mergeCells", () => {
    const out = addPrintSetupToSheetXml(SHEET, AREA);
    expect(rootChildren(out)).toEqual(["sheetPr", "sheetViews", "cols", "sheetData", "mergeCells", "pageMargins", "pageSetup", "ignoredErrors"]);
    expect(out).toContain('<ignoredError sqref="A1:E7" numberStoredAsText="1"/>');
  });

  it("is idempotent: a second pass changes nothing (no duplicated element)", () => {
    const once = addPrintSetupToSheetXml(SHEET, AREA);
    expect(addPrintSetupToSheetXml(once, AREA)).toBe(once);
  });

  it("puts the page elements after sheetData when the sheet has no merged cells", () => {
    const noMerges = SHEET.replace(/<mergeCells[\s\S]*<\/mergeCells>/, "");
    expect(rootChildren(addPrintSetupToSheetXml(noMerges, AREA))).toEqual([
      "sheetPr", "sheetViews", "cols", "sheetData", "pageMargins", "pageSetup", "ignoredErrors",
    ]);
  });

  it("never duplicates page setup the writer already emitted: it leaves such a sheet's page elements alone", () => {
    const already = SHEET.replace("</worksheet>", '<pageMargins left="1" right="1" top="1" bottom="1" header="0.5" footer="0.5"/></worksheet>');
    const out = addPrintSetupToSheetXml(already, AREA);
    expect(out.match(/<pageMargins\b/g)).toHaveLength(1);
    expect(out).not.toContain("<pageSetup");
    expect(out).not.toContain("<ignoredErrors");
  });

  it("does not add a second sheetPr or ignoredErrors if one is present", () => {
    const withSheetPr = SHEET.replace("<sheetViews>", '<sheetPr><tabColor rgb="FF0000"/></sheetPr><sheetViews>');
    expect(addPrintSetupToSheetXml(withSheetPr, AREA).match(/<sheetPr\b/g)).toHaveLength(1);
    const withIgnored = SHEET.replace("</worksheet>", '<ignoredErrors><ignoredError sqref="A1" evalError="1"/></ignoredErrors></worksheet>');
    expect(addPrintSetupToSheetXml(withIgnored, AREA).match(/<ignoredErrors\b/g)).toHaveLength(1);
  });

  it("leaves unrecognisable XML untouched instead of guessing where to insert", () => {
    for (const odd of ["", "<notxml>", "<worksheet/>", '<worksheet xmlns="x"/>', "plain text"]) {
      expect(addPrintSetupToSheetXml(odd, AREA), odd).toBe(odd);
    }
  });

  it("names columns beyond Z correctly in the ignored-errors range", () => {
    expect(addPrintSetupToSheetXml(SHEET, { lastColumn: 26, lastRow: 3 })).toContain('sqref="A1:Z3"');
    expect(addPrintSetupToSheetXml(SHEET, { lastColumn: 27, lastRow: 3 })).toContain('sqref="A1:AA3"');
    expect(addPrintSetupToSheetXml(SHEET, { lastColumn: 52, lastRow: 3 })).toContain('sqref="A1:AZ3"');
    expect(addPrintSetupToSheetXml(SHEET, { lastColumn: 53, lastRow: 3 })).toContain('sqref="A1:BA3"');
  });

  const WORKBOOK = '<workbook><sheets><sheet r:id="rId1" sheetId="1" name="Order sheet"/></sheets><definedNames/><calcPr/></workbook>';

  it("replaces the empty definedNames element with the Print_Titles name for the given header row, and changes nothing else", () => {
    const out = addPrintTitlesToWorkbookXml(WORKBOOK, 5);
    expect(out).toBe(
      `<workbook><sheets><sheet r:id="rId1" sheetId="1" name="Order sheet"/></sheets>` +
        `<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">'Order sheet'!$5:$5</definedName></definedNames><calcPr/></workbook>`
    );
    expect(addPrintTitlesToWorkbookXml(WORKBOOK, 12)).toContain("'Order sheet'!$12:$12");
  });

  it("leaves a workbook that already defines names (or has no definedNames element) as it is", () => {
    const named = WORKBOOK.replace("<definedNames/>", '<definedNames><definedName name="x">A1</definedName></definedNames>');
    expect(addPrintTitlesToWorkbookXml(named, 5)).toBe(named);
    const none = WORKBOOK.replace("<definedNames/>", "");
    expect(addPrintTitlesToWorkbookXml(none, 5)).toBe(none);
  });
});

describe("buildOrderSheetXlsx: text is text, never a formula", () => {
  it("writes formula-looking names, titles, notes and people as literal string cells", async () => {
    const items = FORMULA_NAMES.map((name, i) => med(100 + i, { name }));
    const wb = await exportOf(items, inputs(items), {
      ...OPTIONS,
      title: FORMULA_NAMES[0],
      preparedBy: FORMULA_NAMES[3],
      notes: FORMULA_NAMES.join("\n"),
    });

    for (const xml of allXml(wb)) {
      expect(xml).not.toMatch(/<f[\s>/]/);
      expect(xml).not.toMatch(/<fv[\s>/]/);
    }
    expect(wb.xml["xl/worksheets/sheet1.xml"]).not.toContain('t="str"');
    expect(wb.xml["xl/worksheets/sheet1.xml"]).not.toContain('t="e"');

    expect(valueAt(wb, "B1")).toBe(FORMULA_NAMES[0]);
    expect(valueAt(wb, "B3")).toBe(FORMULA_NAMES[3]);
    // the notes row exists, so the header is row 6 and the data starts at row 7; a CR in the notes becomes a line break
    expect(valueAt(wb, "A4")).toBe("Notes");
    expect(valueAt(wb, "B4")).toBe(FORMULA_NAMES.join("\n").replace(/\r\n?/g, "\n"));
    // buildSheet trims names, so "\t=1+1" and "\r=1+1" arrive as "=1+1"; the rest are verbatim
    FORMULA_NAMES.forEach((name, i) => {
      const ref = `B${7 + i}`;
      expect(wb.cells.get(ref)?.type).toBe("s");
      expect(isTextFormat(wb, wb.cells.get(ref)!)).toBe(true);
      expect(valueAt(wb, ref)).toBe(name.trim());
    });
  });

  it("does not trust a hand-built sheet either: leading tab / CR / spaces are kept as text, still no formula", async () => {
    const hostile = ["\t=1+1", "\r=1+1", '  =HYPERLINK("http://x")  ', "@A1", "-2+3", "+1", "=1+1\r\n=2+2", "\n=3"];
    const wb = await buildOrderSheetXlsx(
      handBuilt(
        hostile.map((name, i) => ({
          name,
          supplierOrderNumber: i % 2 ? `=${i}` : `+${i}`,
          unit: i % 2 ? "=box" : "",
          barcode: `@${i}`,
          qty: "",
        })),
        { title: "\t=SUM(1,2)", preparedBy: "\r@A1", notes: "-1\n+2\n=3", showOnHand: true, showBarcode: true }
      )
    ).then(readWorkbook);

    for (const xml of allXml(wb)) expect(xml).not.toMatch(/<f[\s>/]/);
    const lf = (s: string) => s.replace(/\r\n?/g, "\n");
    expect(valueAt(wb, "B1")).toBe("\t=SUM(1,2)");
    expect(valueAt(wb, "B3")).toBe("\n@A1");
    // notes are present, so the header is row 6 and the data starts at row 7
    hostile.forEach((name, i) => {
      const row = 7 + i;
      expect(wb.cells.get(`B${row}`)?.type).toBe("s");
      expect(valueAt(wb, `B${row}`)).toBe(lf(name)); // not trimmed, not prefixed, not escaped
      expect(valueAt(wb, `C${row}`)).toBe(i % 2 ? `=${i}` : `+${i}`);
      expect(valueAt(wb, `E${row}`) ?? null).toBe(i % 2 ? "=box" : null);
      expect(valueAt(wb, `G${row}`)).toBe(`@${i}`);
      expect(valueAt(wb, `H${row}`)).toBeUndefined();
    });
    // whitespace at the ends of a shared string is flagged so spreadsheet apps keep it
    expect(wb.xml["xl/sharedStrings.xml"]).toContain('xml:space="preserve"');
  });

  it("gives every text cell an explicit string type and the Text number format; only No. and Order qty are numeric", async () => {
    const items = buildMedications();
    const wb = await exportOf(
      items,
      inputs(items, (_m, i) => ({ qty: i % 2 ? "5" : "", unit: i % 2 ? "box" : "" })),
      { ...OPTIONS, notes: "n", showOnHand: true, showBarcode: true }
    );
    const headerRow = 6;
    for (const cell of wb.cells.values()) {
      if (cell.raw === null) continue;
      const row = Number(cell.ref.replace(/[A-Z]+/, ""));
      const column = cell.ref.replace(/[0-9]+/, "");
      const numericColumn = row > headerRow && (column === "A" || column === "D");
      if (numericColumn) {
        expect(cell.type, cell.ref).toBeNull();
      } else {
        expect(cell.type, cell.ref).toBe("s");
        expect(isTextFormat(wb, cell), cell.ref).toBe(true);
      }
    }
  });
});

describe("buildOrderSheetXlsx: supplier order numbers", () => {
  it("keeps leading zeros, letters, dates, exponents and long digit strings exactly as text", async () => {
    const items = TRICKY_SUPPLIER_NUMBERS.map((code, i) => med(200 + i, { supplier_order_number: code }));
    const wb = await exportOf(items, inputs(items));
    TRICKY_SUPPLIER_NUMBERS.forEach((code, i) => {
      const cell = wb.cells.get(`C${6 + i}`)!;
      expect(cell.type).toBe("s");
      expect(isTextFormat(wb, cell)).toBe(true);
      expect(valueAt(wb, `C${6 + i}`)).toBe(code);
    });
    // the raw package must not hold these as numbers anywhere
    const sheet = wb.xml["xl/worksheets/sheet1.xml"];
    expect(sheet).not.toMatch(/<v>417<\/v>/);
    expect(sheet).not.toMatch(/<v>92<\/v>/);
  });

  it("writes the em-dash marker (same as the printed sheet) for a missing supplier order number", async () => {
    const items = [med(1, { supplier_order_number: null }), med(2, { supplier_order_number: "   " }), med(3, { supplier_order_number: "0092" })];
    const wb = await exportOf(items, inputs(items));
    expect(["C6", "C7", "C8"].map((ref) => valueAt(wb, ref))).toEqual([DASH, DASH, "0092"]);
    expect(wb.cells.get("C6")?.type).toBe("s");
  });

  it("never infers a supplier number from the barcode or the name", async () => {
    const items = [med(1, { barcode: "00417-B", name: "Order no. 00417-B", supplier_order_number: null })];
    const wb = await exportOf(items, inputs(items));
    expect(valueAt(wb, "C6")).toBe(DASH);
  });

  it("keeps barcodes with leading zeros as text too", async () => {
    const items = [med(1, { barcode: "0012345678905" }), med(2, { barcode: "012345" }), med(3, { barcode: "ABC-0042" })];
    const wb = await exportOf(items, inputs(items), { ...OPTIONS, showBarcode: true });
    expect(["F6", "F7", "F8"].map((ref) => valueAt(wb, ref))).toEqual(["0012345678905", "012345", "ABC-0042"]);
    expect(["F6", "F7", "F8"].every((ref) => wb.cells.get(ref)?.type === "s")).toBe(true);
  });
});

describe("buildOrderSheetXlsx: order quantity, unit and on-hand stay separate", () => {
  it("writes the quantity as a number when given and leaves the cell empty otherwise", async () => {
    const items = [med(1), med(2), med(3), med(4)];
    const wb = await exportOf(items, [
      { id: 1, qty: "12", unit: "box" },
      { id: 2, qty: "007", unit: "" },
      { id: 3, qty: "", unit: "case" },
      { id: 4, qty: "abc", unit: "" }, // invalid: buildSheet blanks it, it never reaches the file
    ]);
    expect(["D6", "D7", "D8", "D9"].map((ref) => valueAt(wb, ref) ?? null)).toEqual([12, 7, null, null]);
    expect(wb.cells.get("D6")?.type).toBeNull();
    expect(wb.cells.get("D8")?.raw).toBeNull(); // empty bordered box, no value at all
    expect(["E6", "E7", "E8", "E9"].map((ref) => valueAt(wb, ref) ?? null)).toEqual(["box", null, "case", null]);
  });

  it("never fills in a quantity: a low-stock item with nothing typed has an empty order quantity", async () => {
    const items = [med(1, { stock: 0, threshold: 50 })];
    const wb = await exportOf(items, inputs(items), { ...OPTIONS, showOnHand: true });
    expect(valueAt(wb, "D6") ?? null).toBeNull();
    expect(valueAt(wb, "F6")).toBe("0 units");
  });

  it("shows on-hand as read-only text with the item's own stock unit, apart from the order unit", async () => {
    const items = [med(1, { stock: 18, unit: "boxes" }), med(2, { stock: 3, unit: "" })];
    const wb = await exportOf(items, [{ id: 1, qty: "5", unit: "case" }, { id: 2, qty: "", unit: "" }], { ...OPTIONS, showOnHand: true });
    expect(["D6", "E6", "F6"].map((ref) => valueAt(wb, ref))).toEqual([5, "case", "18 boxes"]);
    expect(valueAt(wb, "F7")).toBe("3");
  });

  it("re-validates a hand-built quantity so text or NaN can never land in the numeric column", async () => {
    const wb = await buildOrderSheetXlsx(
      handBuilt([{ qty: "=1+1" }, { qty: "abc" }, { qty: "1.5" }, { qty: "0" }, { qty: "000012" }, { qty: "999999999" }, { unit: "a\nb\tc" }])
    ).then(readWorkbook);
    expect(["D6", "D7", "D8", "D9", "D10", "D11", "D12"].map((ref) => valueAt(wb, ref) ?? null)).toEqual([null, null, null, null, 12, 999999999, null]);
    expect(valueAt(wb, "E12")).toBe("a b c");
    for (const xml of allXml(wb)) expect(xml).not.toMatch(/<f[\s>/]/);
  });
});

describe("buildOrderSheetXlsx: odd but legitimate text", () => {
  it("round-trips commas, quotes, line breaks, markup, emoji, CJK and Arabic exactly (trimmed like the sheet)", async () => {
    const items = UNUSUAL_NAMES.map((name, i) => med(300 + i, { name, supplier_order_number: i % 2 ? "X-1" : null }));
    const wb = await exportOf(items, inputs(items));
    UNUSUAL_NAMES.forEach((name, i) => {
      expect(valueAt(wb, `B${6 + i}`)).toBe(name.trim());
    });
    // markup is escaped in the XML, never emitted raw
    expect(wb.xml["xl/sharedStrings.xml"]).toContain("&lt;script&gt;");
    expect(wb.xml["xl/sharedStrings.xml"]).not.toContain("<script>");
    // the very long name keeps all 113 characters
    expect(String(valueAt(wb, `B${6 + UNUSUAL_NAMES.length - 1}`))).toHaveLength(113);
  });

  it("keeps the fixtures' long name and barcode-only item readable", async () => {
    const items = buildMedications();
    const wb = await exportOf(items, inputs(items));
    const long = items[24];
    expect(valueAt(wb, "B30")).toBe(long.name);
    expect(String(valueAt(wb, "B30")).length).toBeGreaterThan(100);
    expect(valueAt(wb, "B32")).toBe("Unnamed item (barcode 0049000028911)");
    expect(valueAt(wb, "C30")).toBe(long.supplier_order_number);
  });

  it("removes characters that are not allowed in XML instead of corrupting the file", async () => {
    const bad = String.fromCharCode(1) + "A" + String.fromCharCode(8) + "B" + String.fromCharCode(0x1f) + "C";
    const wb = await buildOrderSheetXlsx(handBuilt([{ name: bad }], { title: bad })).then(readWorkbook);
    for (const text of [wb.xml["xl/sharedStrings.xml"], wb.xml["xl/worksheets/sheet1.xml"]]) {
      expect(text).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
    }
    expect(valueAt(wb, "B6")).toBe("ABC");
    expect(valueAt(wb, "B1")).toBe("ABC");
  });

  it("caps an absurdly long cell at Excel's 32,767-character limit instead of producing a file Excel rejects", async () => {
    const wb = await buildOrderSheetXlsx(handBuilt([{ name: "x".repeat(40000) }])).then(readWorkbook);
    expect(String(valueAt(wb, "B6")).length).toBe(32767);
  });
});

describe("buildOrderSheetXlsx: size and edge cases", () => {
  it("writes a 45-row sheet with every row, in order, numbered 1..45", async () => {
    const items = buildManyMedications(45);
    const wb = await exportOf(items, inputs(items, (_m, i) => ({ qty: i % 3 === 0 ? "" : String((i + 1) * 3), unit: i % 3 === 0 ? "" : "box" })), {
      ...OPTIONS,
      showOnHand: true,
      showBarcode: true,
    });
    for (let i = 0; i < 45; i += 1) {
      const row = 6 + i;
      expect(valueAt(wb, `A${row}`)).toBe(i + 1);
      expect(valueAt(wb, `B${row}`)).toBe(items[i].name);
      expect(valueAt(wb, `C${row}`)).toBe(items[i].supplier_order_number ?? DASH);
      expect(valueAt(wb, `D${row}`) ?? null).toBe(i % 3 === 0 ? null : (i + 1) * 3);
      expect(valueAt(wb, `G${row}`)).toBe(items[i].barcode);
    }
    expect(wb.cells.has("A51")).toBe(false);
    expect(wb.cells.has("A50")).toBe(true);
  });

  it("writes only the rows it is given (the intended rows, nothing more)", async () => {
    const items = buildMedications();
    const chosen = [items[2], items[10], items[25]];
    const wb = await exportOf(items, inputs(chosen));
    const names = [...wb.cells.keys()].filter((ref) => /^B([6-9]|[1-9][0-9]+)$/.test(ref)).map((ref) => valueAt(wb, ref));
    expect(names).toEqual(chosen.map((m) => m.name));
  });

  it("produces just the header when there are no rows", async () => {
    const wb = await buildOrderSheetXlsx(handBuilt([])).then(readWorkbook);
    expect(valueAt(wb, "A5")).toBe("No.");
    expect(wb.cells.has("A6")).toBe(false);
    expect(String.fromCharCode(wb.bytes[0], wb.bytes[1])).toBe("PK");
  });

  it("copes with an empty title and empty options", async () => {
    const wb = await buildOrderSheetXlsx(handBuilt([{}], { title: "", preparedBy: "", notes: "" })).then(readWorkbook);
    expect(valueAt(wb, "A1")).toBe("Title");
    expect(valueAt(wb, "B1") ?? null).toBeNull();
    expect(valueAt(wb, "A5")).toBe("No.");
  });

  it("does not depend on the order of the inventory list: rows follow the sheet's own order", async () => {
    const items = [med(1, { name: "Alpha" }), med(2, { name: "Beta" }), med(3, { name: "Gamma" })];
    const wb = await exportOf([...items].reverse(), [{ id: 2, qty: "", unit: "" }, { id: 3, qty: "", unit: "" }, { id: 1, qty: "", unit: "" }]);
    expect(["B6", "B7", "B8"].map((ref) => valueAt(wb, ref))).toEqual(["Beta", "Gamma", "Alpha"]);
  });

  it("is deterministic apart from the zip timestamps: same input, same sheet content", async () => {
    const items = buildMedications().slice(0, 5);
    const a = await exportOf(items, inputs(items));
    const b = await exportOf(items, inputs(items));
    expect(b.xml["xl/worksheets/sheet1.xml"]).toBe(a.xml["xl/worksheets/sheet1.xml"]);
    expect(b.xml["xl/sharedStrings.xml"]).toBe(a.xml["xl/sharedStrings.xml"]);
    expect(b.xml["xl/styles.xml"]).toBe(a.xml["xl/styles.xml"]);
  });
});

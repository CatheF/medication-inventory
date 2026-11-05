// Requirement-driven tests: the .xlsx file produced by POST /api/order-sheet/xlsx (TASK.md sections 3, 4, 5, 9; SPEC 2.8, 2.10).
//
//   "Do not call a CSV file XLSX"                      -> the bytes are a real zip package that opens as a spreadsheet
//   "Protect against spreadsheet formula injection"    -> no formula element anywhere, hostile text stays literal text
//   "Preserve leading zeros and handle commas, quotes, line breaks, and non-ASCII characters in exports"
//   "The report contains exactly the intended records; missing codes, long names, unusual characters, and multiple pages"
//   "Supplier codes with leading zeros and letters survive save, reload, and export"
//   "If order quantity is entered manually, keep it separate from stock on hand"
//
// The file is read back with tests/helpers/xlsx-reader.ts (independent of the code under test). When python3 + openpyxl
// and xmllint are installed, a second, unrelated reader cross-checks the same file (those tests skip, naming the tool,
// when it is missing).
import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Medication } from "@/lib/db";
import { bodyRecord, ID_SHAPES, itemNamed, snapshotDb } from "../helpers/api-test-kit";
import { installFake, LIVE_AFTER_MIGRATION, type FakeSupabase } from "../helpers/fake-supabase";
import { buildCategories, buildManyMedications, FORMULA_NAMES, TRICKY_SUPPLIER_NUMBERS, UNUSUAL_NAMES } from "../helpers/fixtures";
import { seedStandard } from "../helpers/fixtures-extra";
import { api } from "../helpers/route-client";
import { readXlsx, type XlsxCell, type XlsxSheet, type XlsxTable, type XlsxWorkbook } from "../helpers/xlsx-reader";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

type Row = { id: number; qty?: string; unit?: string };
type Exported = { bytes: Uint8Array; wb: XlsxWorkbook; sheet: XlsxSheet; table: XlsxTable; meta: Record<string, string> };

function sheetBody(rows: readonly Row[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: "Supply order", date: "2026-11-05", preparedBy: "Nurse A", notes: "", showOnHand: false, showBarcode: false, rows, ...overrides };
}

async function exportSheet(body: Record<string, unknown>): Promise<Exported> {
  const res = await api.exportXlsx(body);
  if (res.status !== 200) throw new Error(`export answered ${res.status}: ${await res.text()}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const wb = readXlsx(bytes);
  const sheet = wb.sheet("Order sheet");
  return { bytes, wb, sheet, table: sheet.table(), meta: sheet.meta() };
}

/** Text of a cell in a data row ("" for an empty or missing cell). */
function textOf(cell: XlsxCell | undefined): string {
  return cell?.text ?? "";
}

/** What the sheet should show for an item's name: trimmed, line breaks as LF (the writer normalizes CR and CRLF). */
function shownName(name: string | null, barcode: string): string {
  const trimmed = (name ?? "").trim();
  return trimmed === "" ? `Unnamed item (barcode ${barcode})` : trimmed.replace(/\r\n?/g, "\n");
}

function everyStringCell(sheet: XlsxSheet): XlsxCell[] {
  return sheet.cells.filter((c) => c.type === "shared-string" || c.type === "inline-string");
}

/** Characters XML 1.0 cannot carry (control characters other than tab, line feed and carriage return). */
function illegalXmlCharacters(text: string): string[] {
  const found: string[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd) || code === 0xfffe || code === 0xffff) found.push(`U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  return found;
}

function toolExists(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.error === undefined && result.status === 0;
}

const HAS_XMLLINT = toolExists("xmllint", ["--version"]);
const HAS_OPENPYXL = toolExists("python3", ["-I", "-c", "import openpyxl"]);

describe.each(ID_SHAPES)("the exported workbook on the $label", ({ options, shape }) => {
  let fake: FakeSupabase;
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake(options);
    ({ medications } = seedStandard(fake));
  });

  const idOf = (prefix: string): number => itemNamed(medications, prefix).id;

  describe("it is a real spreadsheet package", () => {
    it("is a zip with the core spreadsheet parts and exactly one sheet named 'Order sheet' (not a renamed CSV)", async () => {
      const { bytes, wb } = await exportSheet(sheetBody([{ id: idOf("Acetaminophen 500 mg") }]));
      expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
      for (const part of ["[Content_Types].xml", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) {
        expect(wb.partNames, `package part ${part}`).toContain(part);
      }
      expect(wb.sheets.map((s) => s.name)).toEqual(["Order sheet"]);
      expect(new TextDecoder().decode(bytes.slice(0, 200))).not.toMatch(/^No\.,/);
    });

    it("contains no formula element or formula result anywhere, even for hostile names, supplier numbers, title, prepared-by and notes", async () => {
      fake.seedMedications(
        FORMULA_NAMES.map((name, i) => ({
          id: 5000 + i,
          barcode: `F-${i}`,
          name,
          supplier_order_number: i % 2 === 0 ? "=1+1" : "+SUM(A1)",
        }))
      );
      const { wb, sheet } = await exportSheet(
        sheetBody(
          FORMULA_NAMES.map((_n, i) => ({ id: 5000 + i, unit: "=cmd|' /C calc'!A0" })),
          { title: '=HYPERLINK("http://example.invalid","Open")', preparedBy: "@SUM(A1:A2)", notes: "-2+3\n+1+1", showBarcode: true, showOnHand: true }
        )
      );
      for (const [name, xml] of Object.entries(wb.parts)) {
        if (name.startsWith("xl/worksheets/") && name.endsWith(".xml")) {
          expect(xml, name).not.toMatch(/<f[\s>/]/);
          expect(xml, name).not.toMatch(/\bt="str"/);
        }
      }
      expect(wb.partNames).not.toContain("xl/calcChain.xml");
      for (const cell of sheet.cells) {
        expect(cell.hasFormula, cell.ref).toBe(false);
        expect(cell.type, cell.ref).not.toBe("formula-string");
      }
    });

    it("keeps every hostile text exactly as typed, as a text cell (a leading = + - @ never turns into a formula)", async () => {
      fake.seedMedications(
        FORMULA_NAMES.map((name, i) => ({ id: 5000 + i, barcode: `F-${i}`, name, supplier_order_number: i % 2 === 0 ? "=1+1" : "-2+3" }))
      );
      const { table, meta } = await exportSheet(
        sheetBody(FORMULA_NAMES.map((_n, i) => ({ id: 5000 + i })), { title: "=HYPERLINK(\"http://example.invalid\",\"x\")", preparedBy: "@me", notes: "+1+1" })
      );
      expect(table.rows).toHaveLength(FORMULA_NAMES.length);
      FORMULA_NAMES.forEach((name, i) => {
        const row = table.rows[i];
        expect(row.Item?.type, name).toBe("shared-string");
        expect(textOf(row.Item)).toBe(shownName(name, `F-${i}`));
        expect(row["Supplier order no."]?.type).toBe("shared-string");
        expect(textOf(row["Supplier order no."])).toBe(i % 2 === 0 ? "=1+1" : "-2+3");
      });
      expect(meta).toMatchObject({ Title: '=HYPERLINK("http://example.invalid","x")', "Prepared by": "@me", Notes: "+1+1" });
    });

    it("never writes characters XML cannot carry (control characters in an item name cannot corrupt the file), and keeps the readable part of the name", async () => {
      fake.seedMedications([{ id: 5100, barcode: "CTL-1", name: "Ctl\u0001char\u001bname\u0008 end", supplier_order_number: "A\u0002B-1" }]);
      const { wb, table } = await exportSheet(sheetBody([{ id: 5100 }]));
      for (const [name, xml] of Object.entries(wb.parts)) {
        if (name.endsWith(".xml") || name.endsWith(".rels")) expect(illegalXmlCharacters(xml), name).toEqual([]);
      }
      expect(textOf(table.rows[0].Item)).toMatch(/^Ctl.*char.*name.* end$/);
    });

    it.skipIf(!HAS_XMLLINT)("is well-formed XML in every part according to xmllint (needs xmllint: skipped when it is not installed)", async () => {
      fake.seedMedications(UNUSUAL_NAMES.map((name, i) => ({ id: 5200 + i, barcode: `U-${i}`, name })));
      const { wb } = await exportSheet(sheetBody(UNUSUAL_NAMES.map((_n, i) => ({ id: 5200 + i })), { showBarcode: true, showOnHand: true, notes: "line 1\nline 2 <&>" }));
      for (const [name, xml] of Object.entries(wb.parts)) {
        if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
        const result = spawnSync("xmllint", ["--noout", "-"], { input: xml, encoding: "utf8" });
        expect(result.status, `${name}: ${result.stderr}`).toBe(0);
      }
    });

    it.skipIf(!HAS_OPENPYXL)("is read by an unrelated spreadsheet library (openpyxl) to the same cells, all text-formatted strings and numbers, no formulas (needs python3 with openpyxl: skipped when it is not installed)", async () => {
      const ids = ["Acetaminophen 500 mg", "Ibuprofen 200 mg", "Aspirin 81 mg", "Thermometer probe covers"].map(idOf);
      const { bytes, sheet } = await exportSheet(
        sheetBody(
          ids.map((id, i) => ({ id, qty: i === 0 ? "12" : "", unit: i === 0 ? "box" : "" })),
          { showBarcode: true, showOnHand: true, notes: "Deliver to the side door" }
        )
      );
      const script = [
        "import sys, io, json, warnings, openpyxl",
        "warnings.simplefilter('ignore')",
        "wb = openpyxl.load_workbook(io.BytesIO(sys.stdin.buffer.read()))",
        "ws = wb['Order sheet']",
        "cells = [[c.coordinate, c.data_type, c.number_format, c.value] for row in ws.iter_rows() for c in row if c.value is not None]",
        "print(json.dumps({'sheets': wb.sheetnames, 'cells': cells, 'titles': ws.print_title_rows, 'orientation': ws.page_setup.orientation, 'fit': bool(ws.sheet_properties.pageSetUpPr and ws.sheet_properties.pageSetUpPr.fitToPage)}))",
      ].join("\n");
      const run = spawnSync("python3", ["-I", "-c", script], { input: Buffer.from(bytes), encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      const parsed: unknown = JSON.parse(run.stdout);
      if (typeof parsed !== "object" || parsed === null) throw new Error("unexpected openpyxl output");
      const result = parsed as { sheets: string[]; cells: Array<[string, string, string, string | number]>; titles: string; orientation: string; fit: boolean };

      expect(result.sheets).toEqual(["Order sheet"]);
      expect(result.orientation).toBe("portrait");
      expect(result.fit).toBe(true);
      expect(result.titles).toBe(`$${sheet.cells.find((c) => c.text === "No.")?.row}:$${sheet.cells.find((c) => c.text === "No.")?.row}`);
      const mine = new Map(sheet.cells.filter((c) => c.text !== null).map((c) => [c.ref, c]));
      expect(result.cells).toHaveLength(mine.size);
      for (const [ref, dataType, format, value] of result.cells) {
        const own = mine.get(ref);
        expect(own, ref).toBeDefined();
        expect(dataType, `${ref} must not be a formula`).not.toBe("f");
        if (own?.type === "number") {
          expect(dataType).toBe("n");
          expect(Number(value)).toBe(Number(own.text));
        } else {
          expect(dataType).toBe("s");
          expect(format).toBe("@");
          expect(value).toBe(own?.text);
        }
      }
    });
  });

  describe("layout", () => {
    it("starts with Title, Date and Prepared by, then a blank row, then the header row and the items", async () => {
      const { sheet, meta, table } = await exportSheet(sheetBody([{ id: idOf("Acetaminophen 500 mg") }], { title: "Winter restock", preparedBy: "Nurse A" }));
      expect(meta).toEqual({ Title: "Winter restock", Date: "2026-11-05", "Prepared by": "Nurse A" });
      expect(sheet.cell("A1")?.text).toBe("Title");
      expect(sheet.cell("A2")?.text).toBe("Date");
      expect(sheet.cell("A3")?.text).toBe("Prepared by");
      expect(table.headerRow).toBe(5); // row 4 is the blank separator
    });

    it("adds a Notes row only when notes were typed, and keeps their line breaks", async () => {
      const without = await exportSheet(sheetBody([{ id: idOf("Acetaminophen 500 mg") }], { notes: "   " }));
      expect(Object.keys(without.meta)).not.toContain("Notes");
      const withNotes = await exportSheet(sheetBody([{ id: idOf("Acetaminophen 500 mg") }], { notes: "Deliver to the side door.\r\nCall first." }));
      expect(withNotes.meta.Notes).toBe("Deliver to the side door.\nCall first.");
      expect(withNotes.table.headerRow).toBe(without.table.headerRow + 1);
    });

    it("shows the date as the text 2026-11-05, never as a spreadsheet date number", async () => {
      const { sheet } = await exportSheet(sheetBody([{ id: idOf("Acetaminophen 500 mg") }]));
      const dateCell = sheet.cell("B2");
      expect(dateCell?.type).toBe("shared-string");
      expect(dateCell?.text).toBe("2026-11-05");
    });

    it("shows the date the sheet was given, not today's date from the server's clock (a date in the future and one in the past)", async () => {
      // Dates are computed so that neither can be "today", whatever day this runs: a fixed fixture date would equal the
      // server's date on exactly one day and hide a route that stamps the file with the clock instead of the request.
      const day = 24 * 60 * 60 * 1000;
      for (const offsetDays of [400, -400]) {
        const requested = new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);
        const { sheet } = await exportSheet(sheetBody([{ id: idOf("Acetaminophen 500 mg") }], { date: requested }));
        expect(sheet.cell("B2")?.text).toBe(requested);
      }
    });

    it.each([
      ["by default (no on-hand, no barcode)", {}, ["No.", "Item", "Supplier order no.", "Order qty", "Unit"]],
      ["with the on-hand column", { showOnHand: true }, ["No.", "Item", "Supplier order no.", "Order qty", "Unit", "On hand"]],
      ["with the barcode column", { showBarcode: true }, ["No.", "Item", "Supplier order no.", "Order qty", "Unit", "Barcode"]],
      ["with both", { showOnHand: true, showBarcode: true }, ["No.", "Item", "Supplier order no.", "Order qty", "Unit", "On hand", "Barcode"]],
    ])("has these columns %s", async (_label, flags, headers) => {
      const { table } = await exportSheet(sheetBody([{ id: idOf("Acetaminophen 500 mg") }], flags));
      expect(table.headers).toEqual(headers);
    });

    it("makes the header row bold and leaves the item rows plain, so the column headings stand out on paper", async () => {
      const { sheet, table } = await exportSheet(sheetBody([{ id: idOf("Acetaminophen 500 mg") }], { showOnHand: true, showBarcode: true }));
      const headings = sheet.cells.filter((cell) => cell.row === table.headerRow && cell.text !== null);
      expect(headings.map((cell) => cell.text)).toEqual(table.headers);
      expect(headings.filter((cell) => !cell.bold).map((cell) => cell.text)).toEqual([]);
      const firstItemRow = sheet.cells.filter((cell) => cell.row === table.headerRow + 1 && cell.text !== null);
      expect(firstItemRow.length).toBeGreaterThan(0);
      expect(firstItemRow.filter((cell) => cell.bold).map((cell) => cell.text)).toEqual([]);
    });

    it("wraps the text of the item rows (a long item name or code stays readable instead of running out of its cell)", async () => {
      const long = medications.find((m) => (m.name ?? "").startsWith("Multi-vitamin with minerals"));
      if (!long) throw new Error("fixture has no long-named item");
      const { table } = await exportSheet(sheetBody([{ id: long.id, qty: "2", unit: "box" }], { showOnHand: true, showBarcode: true }));
      const row = table.rows[0];
      for (const column of ["Item", "Supplier order no.", "Unit", "On hand", "Barcode"]) {
        expect(row[column]?.wrap, `the ${column} cell wraps its text`).toBe(true);
      }
    });

    it("gives the Item column the most room: wide enough for a typical name and wider than every other column", async () => {
      const { sheet, table } = await exportSheet(sheetBody([{ id: idOf("Acetaminophen 500 mg") }], { showOnHand: true, showBarcode: true }));
      const widths = sheet.columnWidths();
      const columnOf = (header: string): number => table.headers.indexOf(header) + 1;
      expect(widths[columnOf("Item")]).toBeGreaterThanOrEqual(30);
      for (const other of table.headers.filter((header) => header !== "Item")) {
        expect(widths[columnOf("Item")], `Item is wider than ${other}`).toBeGreaterThan(widths[columnOf(other)]);
      }
    });

    it("is set up to print one page wide in portrait on the printer's own paper size, with the header row repeating on every page and frozen on screen", async () => {
      const { wb, sheet, table } = await exportSheet(sheetBody(medications.slice(0, 40).map((m) => ({ id: m.id }))));
      expect(sheet.xml).toMatch(/<pageSetUpPr fitToPage="1"\/>/);
      expect(sheet.xml).toMatch(/<pageSetup[^>]*orientation="portrait"/);
      expect(sheet.xml).toMatch(/<pageSetup[^>]*fitToWidth="1"/);
      expect(sheet.xml).toMatch(/<pageSetup[^>]*fitToHeight="0"/);
      expect(sheet.xml).not.toMatch(/<pageSetup[^>]*paperSize=/); // Letter or A4: whatever the printer holds
      expect(wb.parts["xl/workbook.xml"]).toContain(`_xlnm.Print_Titles`);
      expect(wb.parts["xl/workbook.xml"]).toContain(`'Order sheet'!$${table.headerRow}:$${table.headerRow}`);
      const pane = /<pane\b[^>]*>/.exec(sheet.xml)?.[0] ?? "";
      expect(pane).toContain(`ySplit="${table.headerRow}"`); // the rows down to the header stay in view
      expect(pane).toContain('state="frozen"');
    });
  });

  describe("it contains exactly the intended records", () => {
    it("lists the chosen items in the order they were chosen (not database order), numbered 1..n, and nothing else", async () => {
      const chosen = ["Nitrile gloves, L", "Acetaminophen 500 mg", "IV start kit", "Alcohol prep pads"];
      const { table, sheet } = await exportSheet(sheetBody(chosen.map((prefix) => ({ id: idOf(prefix) }))));
      expect(table.rows.map((r) => textOf(r.Item))).toEqual(chosen.map((prefix) => shownName(itemNamed(medications, prefix).name, "")));
      expect(table.rows.map((r) => Number(r["No."]?.text))).toEqual([1, 2, 3, 4]);
      const allText = everyStringCell(sheet).map((c) => c.text);
      for (const other of medications.filter((m) => !chosen.some((p) => m.name?.startsWith(p)))) {
        if (other.name !== null) expect(allText, other.name).not.toContain(other.name);
      }
    });

    it("lists an item that appears twice in the request once, using its first occurrence (no duplicate rows)", async () => {
      const id = idOf("Acetaminophen 500 mg");
      const { table } = await exportSheet(sheetBody([{ id, qty: "5", unit: "box" }, { id: idOf("Ibuprofen 200 mg") }, { id, qty: "99", unit: "case" }]));
      expect(table.rows).toHaveLength(2);
      expect(textOf(table.rows[0]["Order qty"])).toBe("5");
      expect(textOf(table.rows[0].Unit)).toBe("box");
    });

    it("lists all 27 items of the standard inventory when all are chosen, each exactly once", async () => {
      const { table } = await exportSheet(sheetBody(medications.map((m) => ({ id: m.id }))));
      expect(table.rows).toHaveLength(medications.length);
      expect(table.rows.map((r) => textOf(r.Item))).toEqual(medications.map((m) => shownName(m.name, m.barcode)));
    });

    it("exports 45 items (a multi-page sheet) completely and in order", async () => {
      const fresh = installFake(options);
      fresh.seedCategories(buildCategories(shape));
      const bulk = buildManyMedications(45, shape);
      fresh.seedMedications(bulk);
      const { table } = await exportSheet(sheetBody(bulk.map((m) => ({ id: m.id }))));
      expect(table.rows).toHaveLength(45);
      expect(table.rows.map((r) => textOf(r.Item))).toEqual(bulk.map((m) => shownName(m.name, m.barcode)));
      expect(table.rows.map((r) => textOf(r["Supplier order no."]))).toEqual(bulk.map((m) => m.supplier_order_number ?? "—"));
    });

    it("exports the maximum of 500 items completely", async () => {
      const fresh = installFake(options);
      fresh.seedCategories(buildCategories(shape));
      const bulk = buildManyMedications(500, shape);
      fresh.seedMedications(bulk);
      const { table } = await exportSheet(sheetBody(bulk.map((m) => ({ id: m.id }))));
      expect(table.rows).toHaveLength(500);
      expect(table.rows.map((r) => Number(r["No."]?.text))).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
    });

    it("shows an unnamed item under a visible fallback name that includes its barcode, never blank", async () => {
      const unnamed = medications.find((m) => m.name === null);
      if (!unnamed) throw new Error("fixture has no unnamed item");
      const { table } = await exportSheet(sheetBody([{ id: unnamed.id }]));
      expect(textOf(table.rows[0].Item)).toBe(`Unnamed item (barcode ${unnamed.barcode})`);
    });
  });

  describe("supplier order numbers", () => {
    it("shows each item's stored supplier order number exactly, and the marker — for items that have none (never a guess)", async () => {
      const { table } = await exportSheet(sheetBody(medications.map((m) => ({ id: m.id }))));
      table.rows.forEach((row, i) => {
        expect(textOf(row["Supplier order no."]), medications[i].name ?? "unnamed").toBe(medications[i].supplier_order_number ?? "—");
      });
      expect(medications.some((m) => m.supplier_order_number === null)).toBe(true);
      expect(medications.some((m) => m.supplier_order_number?.startsWith("00"))).toBe(true);
    });

    it("keeps leading zeros, letters and punctuation: supplier numbers are text cells formatted as text (00417-B, 0092, AX-1182/4)", async () => {
      const ids = [
        [idOf("Aspirin 81 mg"), "00417-B"],
        [idOf("Diphenhydramine"), "0092"],
        [idOf("Surgical masks"), "AX-1182/4"],
      ] as const;
      for (const [id, code] of ids) expect((await api.updateItem(id, { supplier_order_number: code })).status).toBe(200);
      const { table } = await exportSheet(sheetBody(ids.map(([id]) => ({ id }))));
      expect(table.rows.map((r) => textOf(r["Supplier order no."]))).toEqual(["00417-B", "0092", "AX-1182/4"]);
      for (const row of table.rows) {
        expect(row["Supplier order no."]?.type).toBe("shared-string");
        expect(row["Supplier order no."]?.format).toBe("@");
      }
    });

    it.each(TRICKY_SUPPLIER_NUMBERS.map((code) => [code]))("carries the saved supplier number %j from the save form through the database into the file unchanged", async (code) => {
      const created = await bodyRecord(await api.createItem({ barcode: `EXP-${code.length}-${code.charCodeAt(0)}`, name: "Pipeline item", supplier_order_number: code }));
      const { table } = await exportSheet(sheetBody([{ id: created.id as number }]));
      expect(textOf(table.rows[0]["Supplier order no."])).toBe(code);
      expect(table.rows[0]["Supplier order no."]?.type).toBe("shared-string");
    });

    it("uses the database value, never a value from the request (an edited code appears on the next export)", async () => {
      const id = idOf("Acetaminophen 500 mg");
      expect(textOf((await exportSheet(sheetBody([{ id }]))).table.rows[0]["Supplier order no."])).toBe("00417-B");
      expect((await api.updateItem(id, { supplier_order_number: "NEW-0001" })).status).toBe(200);
      expect(textOf((await exportSheet(sheetBody([{ id }]))).table.rows[0]["Supplier order no."])).toBe("NEW-0001");
      expect((await api.updateItem(id, { supplier_order_number: null })).status).toBe(200);
      expect(textOf((await exportSheet(sheetBody([{ id }]))).table.rows[0]["Supplier order no."])).toBe("—");
    });

    it("ignores a name, supplier number, barcode or stock sent inside a row: the file shows what the database holds, so a stale draft or a hostile client cannot change the sheet", async () => {
      const item = itemNamed(medications, "Acetaminophen 500 mg"); // 00417-B
      const hostileRow = { id: item.id, qty: "2", unit: "box", name: "STALE-NAME", supplier_order_number: "STALE-CODE", barcode: "STALE-BARCODE", stock: 99999, onHand: 99999 };
      const { sheet, table } = await exportSheet({ ...sheetBody([], { showBarcode: true, showOnHand: true }), rows: [hostileRow] });
      const row = table.rows[0];
      expect(textOf(row.Item)).toBe(item.name);
      expect(textOf(row["Supplier order no."])).toBe("00417-B");
      expect(textOf(row.Barcode)).toBe(item.barcode);
      expect(textOf(row["On hand"])).toBe(`${item.stock} units`);
      expect(textOf(row["Order qty"])).toBe("2"); // what staff typed for this sheet is still honoured
      expect(textOf(row.Unit)).toBe("box");
      expect(sheet.cells.map((cell) => cell.text ?? "").join("\n")).not.toMatch(/STALE|99999/);
    });

    it("never infers a code from the barcode or the name: an item without one shows the marker even when its barcode or name looks like a code", async () => {
      fake.seedMedications([{ id: 5300, barcode: "00417-B", name: "AX-1182/4 Syringe" }]);
      const { table } = await exportSheet(sheetBody([{ id: 5300 }]));
      expect(textOf(table.rows[0]["Supplier order no."])).toBe("—");
      expect(textOf(table.rows[0].Item)).toBe("AX-1182/4 Syringe");
    });

    it("keeps a 64-character supplier number whole", async () => {
      const code = "LONG-".padEnd(64, "9");
      const created = await bodyRecord(await api.createItem({ barcode: "LONG-CODE", name: "Long code", supplier_order_number: code }));
      const { table } = await exportSheet(sheetBody([{ id: created.id as number }]));
      expect(textOf(table.rows[0]["Supplier order no."])).toBe(code);
    });
  });

  describe("names, quotes, line breaks and non-ASCII text", () => {
    it.each(UNUSUAL_NAMES.map((name) => [name]))("shows the item name %j as typed (commas, quotes, line breaks, accents, other scripts, emoji, markup)", async (name) => {
      fake.seedMedications([{ id: 5400, barcode: "ODD-1", name }]);
      const { table } = await exportSheet(sheetBody([{ id: 5400 }]));
      expect(textOf(table.rows[0].Item)).toBe(shownName(name, "ODD-1"));
    });

    it("keeps a very long item name (300 characters) whole in the cell", async () => {
      const longName = `Item ${"very long descriptive name, ".repeat(10)}end`.slice(0, 300);
      fake.seedMedications([{ id: 5401, barcode: "LONG-1", name: longName }]);
      const { table } = await exportSheet(sheetBody([{ id: 5401 }]));
      expect(textOf(table.rows[0].Item)).toBe(longName);
    });

    it("keeps the longest name of the live inventory (113 characters) and the multi-vitamin name with its long code whole", async () => {
      const long = itemNamed(medications, "Multi-vitamin with minerals");
      expect(long.name?.length).toBeGreaterThan(100);
      const { table } = await exportSheet(sheetBody([{ id: long.id }]));
      expect(textOf(table.rows[0].Item)).toBe(long.name);
      expect(textOf(table.rows[0]["Supplier order no."])).toBe(long.supplier_order_number);
    });

    it("keeps title, prepared-by and notes text as typed (accents, scripts, emoji, markup)", async () => {
      const { meta } = await exportSheet(
        sheetBody([{ id: idOf("Acetaminophen 500 mg") }], {
          title: "Commande d’hiver 日本 \u{1F48A}",
          preparedBy: "<b>Nurse</b> & Émilie",
          notes: "Line 1\nLine 2 — “quoted”, with commas",
        })
      );
      expect(meta).toMatchObject({
        Title: "Commande d’hiver 日本 \u{1F48A}",
        "Prepared by": "<b>Nurse</b> & Émilie",
        Notes: "Line 1\nLine 2 — “quoted”, with commas",
      });
    });
  });

  describe("quantities and units are typed by staff, never calculated, and never mixed with stock on hand", () => {
    it("writes a typed quantity as a number and the unit as text: 12 box, and '007' becomes 7", async () => {
      const { table } = await exportSheet(
        sheetBody([
          { id: idOf("Acetaminophen 500 mg"), qty: "12", unit: "box" },
          { id: idOf("Ibuprofen 200 mg"), qty: "  007 ", unit: "  case of 24  " },
        ])
      );
      expect(table.rows[0]["Order qty"]?.type).toBe("number");
      expect(table.rows[0]["Order qty"]?.text).toBe("12");
      expect(textOf(table.rows[0].Unit)).toBe("box");
      expect(table.rows[1]["Order qty"]?.type).toBe("number");
      expect(table.rows[1]["Order qty"]?.text).toBe("7");
      expect(textOf(table.rows[1].Unit)).toBe("case of 24");
    });

    it("leaves quantity and unit empty when staff left them blank, even for an out-of-stock or low-stock item (nothing is suggested or computed)", async () => {
      const outOfStock = itemNamed(medications, "Nitrofurantoin"); // stock 0, threshold 10
      const low = itemNamed(medications, "Naproxen 220 mg"); // stock 9, threshold 20
      const { table } = await exportSheet(sheetBody([{ id: outOfStock.id }, { id: low.id, qty: "", unit: "" }]));
      for (const row of table.rows) {
        expect(row["Order qty"]?.type).toBe("empty");
        expect(textOf(row["Order qty"])).toBe("");
        expect(textOf(row.Unit)).toBe("");
      }
    });

    it("keeps the on-hand column separate from the order quantity: stock 9 with an order of 500 cases shows 9 units on hand and 500 case", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const { table } = await exportSheet(sheetBody([{ id: item.id, qty: "500", unit: "case" }], { showOnHand: true }));
      expect(textOf(table.rows[0]["On hand"])).toBe("9 units");
      expect(table.rows[0]["Order qty"]?.text).toBe("500");
      expect(textOf(table.rows[0].Unit)).toBe("case");
    });

    it("shows on-hand stock as text with the item's own unit (0 units for an item that is out of stock), only when asked for", async () => {
      const outOfStock = itemNamed(medications, "Instant cold pack");
      const asked = await exportSheet(sheetBody([{ id: outOfStock.id }], { showOnHand: true }));
      expect(textOf(asked.table.rows[0]["On hand"])).toBe("0 units");
      expect(asked.table.rows[0]["On hand"]?.type).toBe("shared-string");
      const notAsked = await exportSheet(sheetBody([{ id: outOfStock.id }]));
      expect(notAsked.table.headers).not.toContain("On hand");
      expect(everyStringCell(notAsked.sheet).map((c) => c.text)).not.toContain("0 units");
    });

    it("turns line breaks in a typed unit into spaces so a unit stays on one line", async () => {
      const { table } = await exportSheet(sheetBody([{ id: idOf("Acetaminophen 500 mg"), qty: "1", unit: "box\nof\r\n10" }]));
      const unit = textOf(table.rows[0].Unit);
      expect(unit).not.toMatch(/[\r\n]/);
      expect(unit.split(/\s+/)).toEqual(["box", "of", "10"]); // each break became a space (CRLF is two characters, so two spaces)
    });
  });

  describe("barcodes are optional", () => {
    it("leaves barcodes out of the file by default: no Barcode column and none of the barcode values anywhere", async () => {
      const { table, sheet } = await exportSheet(sheetBody(medications.slice(0, 10).map((m) => ({ id: m.id }))));
      expect(table.headers).not.toContain("Barcode");
      const texts = everyStringCell(sheet).map((c) => c.text);
      for (const item of medications.slice(0, 10)) expect(texts).not.toContain(item.barcode);
    });

    it("includes barcodes as text cells when asked, with leading zeros kept", async () => {
      const zeros = medications.filter((m) => m.barcode.startsWith("0")).slice(0, 5);
      expect(zeros.length).toBe(5);
      const { table } = await exportSheet(sheetBody(zeros.map((m) => ({ id: m.id })), { showBarcode: true }));
      table.rows.forEach((row, i) => {
        expect(textOf(row.Barcode)).toBe(zeros[i].barcode);
        expect(row.Barcode?.type).toBe("shared-string");
        expect(row.Barcode?.format).toBe("@");
      });
    });
  });

  describe("it does not change what it reads", () => {
    it("leaves the database identical after building a file that has quantities, units, on-hand and barcode columns", async () => {
      const before = snapshotDb(fake);
      await exportSheet(sheetBody(medications.map((m) => ({ id: m.id, qty: "3", unit: "box" })), { showOnHand: true, showBarcode: true }));
      expect(snapshotDb(fake)).toEqual(before);
      expect(fake.writes()).toEqual([]);
    });
  });
});

describe("the exported workbook before the supplier column exists in the database (deploy-order independence)", () => {
  it("still exports, with the marker — for every supplier order number, and never an error", async () => {
    const fake = installFake({ ...LIVE_AFTER_MIGRATION, hasSupplierColumn: false });
    const { medications } = seedStandard(fake);
    const { table } = await exportSheet(sheetBody(medications.slice(0, 8).map((m) => ({ id: m.id }))));
    expect(table.rows).toHaveLength(8);
    for (const row of table.rows) expect(textOf(row["Supplier order no."])).toBe("—");
    expect(fake.writes()).toEqual([]);
  });
});

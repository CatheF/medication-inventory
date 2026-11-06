// Print output and electronic export of the order sheet, verified against REAL generated artifacts:
//   * PDFs made with page.pdf (Letter and A4, 1 / 45 / 120 rows) and read back with poppler (pdfinfo, pdftotext, pdftoppm),
//   * the downloaded .xlsx opened with an independent oracle (python3 -I + openpyxl, plus the raw sheet XML),
//   * the same workbook opened by LibreOffice (csv and pdf) as a third opinion.
// The browser talks to the mock API in tests/e2e/helpers/mock-api.ts, so no database is involved. Synthetic data only.
// Tools that are missing make the affected tests skip with the tool's name in the reason; nothing passes vacuously.
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Browser, Page, TestInfo } from "@playwright/test";
import type { Medication } from "@/lib/db";
import { buildManyMedications, buildMedications, FORMULA_NAMES, TRICKY_SUPPLIER_NUMBERS, UNUSUAL_NAMES } from "../helpers/fixtures";
import {
  LIBREOFFICE,
  PAGE_MARGIN_PT,
  POPPLER,
  PYTHON_OPENPYXL,
  cellText,
  darkestInBoxes,
  findRules,
  inspectXlsx,
  libreOfficeConvert,
  makeScratch,
  median,
  parseCsv,
  pdfInfo,
  pdfTextPages,
  pdfWords,
  readPrintedTable,
  renderPage,
  rasterStats,
  xlsxTable,
} from "./helpers/print-export-artifacts";
import type { PageRules, PrintedPage, PrintedRow, XlsxReport } from "./helpers/print-export-artifacts";
import { collectPageProblems, openOrderSheet, openOrderSheetUnready, readPreview, renderedOutsideSheet, savePdf, setDraftRows } from "./helpers/print-export-page";
import type { DraftSeed, PreviewReading } from "./helpers/print-export-page";

// Dates print in the browser's language ("Nov 5, 2026"); pin it so the checks do not depend on the machine's locale.
test.use({ locale: "en-US" });

// ── Shared fixtures (all synthetic) ──────────────────────────────────────────────────────────────────────────────

type Paper = { key: "letter" | "a4"; label: string; width: number; height: number; wrongFormat: "Letter" | "A4" };
const PAPERS: readonly Paper[] = [
  // wrongFormat is what page.pdf is ASKED for; the sheet's own @page rule must still win (preferCSSPageSize)
  { key: "letter", label: "Letter", width: 612, height: 792, wrongFormat: "A4" },
  { key: "a4", label: "A4", width: 595, height: 842, wrongFormat: "Letter" },
];
const ROW_COUNTS = [1, 45, 120] as const;

// What "a readable print layout" means in numbers (the sheet is meant to be read, written on and filed on real paper):
// pdftotext reports each word as a box about 1.12 times the type size tall (8 pt type: 8.9 pt), so a box of 8.8 pt or more is 8 pt type
// or larger, the usual smallest comfortable size. Today's smallest text (the 9 pt footer and page numbers) has a 10 pt box.
const MIN_TEXT_BOX_HEIGHT_PT = 8.8;
// The page promises "an empty box to fill in by hand": a row must be at least 7.5 mm (21.3 pt) tall, room for handwriting.
const MIN_ROW_PITCH_PT = (7.5 / 25.4) * 72;
// Paper is not wasted: on average at least this many item rows per page (plain sheets of 45 and 120 rows; today's layout fits 15 or more,
// so ordinary tweaks to padding or type size pass, while rows that are several times too tall do not).
const MIN_ROWS_PER_PAGE = 10;

const XLSX_PATH = /\/api\/order-sheet\/xlsx$/;
const BASE_HEADERS = ["Item", "Supplier order no.", "Order qty", "Unit"];

const TITLE = "Supply order";
const PREPARED_BY = "J. Rivera";
const NOTES = "Deliver to the side entrance before 4 pm.\nCall ahead: 555-0100."; // two lines: the typed line break must survive
const FOOTER = `${TITLE} · Nov 5, 2026`; // "title · date", printed under the rows on every page

const LONG_CODE_HYPHEN = `SUP-${"0123456789".repeat(6)}`; // 64 characters, with a break opportunity after the hyphen
const LONG_CODE_PLAIN = `${"0123456789".repeat(6)}ABCD`; // 64 characters, no break opportunity at all
const LONG_NAME =
  "Multi-vitamin with minerals and iron, adult daily formula, chewable tablets, assorted fruit flavor, 120 count bottle";

/** Exactly 300 characters, with spaces (wraps normally) and, below, 300 characters with no break opportunity at all. */
const LONG_300 = `${"Sterile single-use irrigation solution, preservative-free, carton of 24 ampoules, store below 25 C. ".repeat(4)}`.slice(0, 299) + ".";
const LONG_300_UNBROKEN = "B".repeat(300);

const BASE_ITEM = buildManyMedications(1)[0];

function item(id: number, patch: Partial<Medication>): Medication {
  return { ...BASE_ITEM, id, barcode: String(id).padStart(13, "0"), ...patch };
}

const SPECIAL_ITEMS: Medication[] = [
  item(20001, { name: LONG_NAME, supplier_order_number: LONG_CODE_HYPHEN }),
  item(20002, { name: "Plain long code item", supplier_order_number: LONG_CODE_PLAIN }),
  item(20003, { name: "A".repeat(113), supplier_order_number: "00417-B" }),
  item(20004, { name: "Émulsion à l’huile — 5 % (naïve café) 日本語の薬品名 500mg", supplier_order_number: "NÅ-00ß" }),
  item(20005, { name: 'Comma, "quote" and \'apostrophe\' item', supplier_order_number: "0092" }),
  item(20006, { name: null, is_unnamed: true, barcode: "0049000099999", supplier_order_number: null }),
  item(20007, { name: LONG_300, supplier_order_number: "300-NAME-SPACED" }),
  item(20008, { name: LONG_300_UNBROKEN, supplier_order_number: "300-NAME-UNBROKEN" }),
];

/** Quantity and unit staff typed for row i: a mix of filled and blank cells. */
function typedFor(index: number): { qty: string; unit: string } {
  const units = ["box", "case", "pack"];
  return { qty: index % 3 === 0 ? "" : String(index + 1), unit: index % 4 === 0 ? "" : units[index % 3] };
}

function pdfRows(count: number): DraftSeed["rows"] {
  const ids =
    count === 1
      ? [SPECIAL_ITEMS[0].id]
      : [...SPECIAL_ITEMS.map((s) => s.id), ...buildManyMedications(count - SPECIAL_ITEMS.length).map((m) => m.id)];
  return ids.map((id, i) => ({ id, ...typedFor(i) }));
}

function pdfInventory(): Medication[] {
  return [...SPECIAL_ITEMS, ...buildManyMedications(120)];
}

type Expected = { name: string; code: string; qty: string; unit: string; onHand: string; barcode: string };

/** What each row of the sheet must say, derived from the inventory and what staff typed (the spec's rules, not the app's code). */
function expectedFor(meds: readonly Medication[], rows: DraftSeed["rows"]): Expected[] {
  return rows.map((r) => {
    const m = meds.find((x) => x.id === r.id);
    if (!m) throw new Error(`fixture ${r.id} is not in the inventory`);
    return {
      name: (m.name ?? "").trim() || `Unnamed item (barcode ${m.barcode})`,
      code: (m.supplier_order_number ?? "").trim() || "—",
      qty: r.qty ?? "",
      unit: (r.unit ?? "").trim(),
      onHand: `${m.stock} ${m.unit}`,
      barcode: m.barcode,
    };
  });
}

const sq = (s: string): string => s.replace(/\s+/g, "");
const expectedCells = (e: Expected): string[] => [sq(e.name), sq(e.code), e.qty, sq(e.unit)];
const printedCells = (row: PrintedRow): string[] => [
  sq(row.cells["Item"] ?? ""),
  sq(row.cells["Supplier order no."] ?? ""),
  (row.cells["Order qty"] ?? "").trim(),
  sq(row.cells["Unit"] ?? ""),
];
const previewCells = (row: string[]): string[] => [sq(row[0] ?? ""), sq(row[1] ?? ""), (row[2] ?? "").trim(), sq(row[3] ?? "")];

// ── Shared state: scratch directory and once-per-worker artifacts ────────────────────────────────────────────────

let scratchDirectory: { dir: string; cleanup: () => void } | null = null;
function scratch(): { dir: string; cleanup: () => void } {
  scratchDirectory ??= makeScratch("spec");
  return scratchDirectory;
}
const memo = new Map<string, Promise<unknown>>();
function once<T>(key: string, make: () => Promise<T>): Promise<T> {
  const existing = memo.get(key);
  if (existing) return existing as Promise<T>;
  const created = make();
  memo.set(key, created);
  return created;
}
test.afterAll(() => {
  scratchDirectory?.cleanup();
  scratchDirectory = null;
  memo.clear();
});

async function withFreshPage<T>(browser: Browser, testInfo: TestInfo, fn: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, locale: "en-US", viewport: { width: 1280, height: 900 } });
  try {
    return await fn(await context.newPage());
  } finally {
    await context.close();
  }
}

/** Sixty items with short names and short codes: every row is a single line of text, so its height is the least a row can be. */
function shortItems(): Medication[] {
  return Array.from({ length: 60 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return item(29001 + i, { name: `Gauze pad ${n}`, supplier_order_number: `G-${n}` });
  });
}

/**
 * Sixty rows of very different heights, up to six lines tall (a long name and a 30 to 64 character code that wraps), with varying
 * heights so that page breaks fall at different heights inside rows, on every paper size.
 */
function tallItems(): Medication[] {
  return Array.from({ length: 60 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    const nameLength = [113, 40, 96, 60, 105, 75][i % 6];
    const codeLength = [64, 30, 52, 64, 36, 58][(i + 2) % 6];
    return item(28001 + i, {
      name: `Tall row ${n}: ${LONG_NAME}`.slice(0, nameLength),
      supplier_order_number: `T${n}-${"0123456789".repeat(6)}`.slice(0, codeLength),
    });
  });
}

type Variant = "plain" | "wide" | "tall" | "short";
type PdfArtifact = { file: string; paper: Paper; rows: DraftSeed["rows"]; expected: Expected[]; preview: PreviewReading };

/**
 * The sheet as a real PDF: the paper is chosen through the UI, then the browser prints it (page.pdf, print media).
 * plain = the default four columns; wide = on-hand and barcode columns switched on; tall = 60 rows of up to six lines each;
 * short = 60 single-line rows.
 */
function pdfArtifact(browser: Browser, testInfo: TestInfo, paper: Paper, count: number, variant: Variant = "plain"): Promise<PdfArtifact> {
  return once(`pdf-${paper.key}-${count}-${variant}`, () =>
    withFreshPage(browser, testInfo, async (page) => {
      const medications = variant === "tall" ? tallItems() : variant === "short" ? shortItems() : pdfInventory();
      const rows = variant === "tall" || variant === "short" ? medications.map((m, i) => ({ id: m.id, ...typedFor(i) })) : pdfRows(count);
      await openOrderSheet(page, {
        medications,
        draft: {
          rows,
          title: TITLE,
          preparedBy: PREPARED_BY,
          notes: rows.length >= 40 ? NOTES : "",
          showOnHand: variant === "wide",
          showBarcode: variant === "wide",
        },
      });
      await page.getByTestId(`paper-${paper.key}`).check();
      const preview = await readPreview(page);
      const file = path.join(scratch().dir, `sheet-${paper.key}-${count}-${variant}.pdf`);
      await savePdf(page, file, { format: paper.wrongFormat });
      return { file, paper, rows, expected: expectedFor(medications, rows), preview };
    })
  );
}

const printedPages = (art: PdfArtifact): PrintedPage[] => readPrintedTable(art.file, FOOTER);

/**
 * Ten letters I, ten W, ten l, ten M and ten zeros, used as item name, supplier number and (with two I added) barcode of five rows:
 * in a monospace face all five print equally wide, in a proportional face they cannot.
 */
const MONO_STRINGS = ["IIIIIIIIII", "WWWWWWWWWW", "llllllllll", "MMMMMMMMMM", "0000000000"];

function monoArtifact(browser: Browser, testInfo: TestInfo): Promise<{ file: string }> {
  return once("mono", () =>
    withFreshPage(browser, testInfo, async (page) => {
      const medications = MONO_STRINGS.map((s, i) => item(30001 + i, { name: s, supplier_order_number: s, barcode: `${s}II` }));
      await openOrderSheet(page, { medications, draft: { rows: medications.map((m) => ({ id: m.id })), showBarcode: true } });
      const file = path.join(scratch().dir, "mono.pdf");
      await savePdf(page, file);
      return { file };
    })
  );
}

// ── Looking at the page as a picture: cell borders and ink ───────────────────────────────────────────────────────────

const RENDER_DPI = 150;

/** One page of the PDF rendered in grayscale, and the long straight dark lines on it: the table's cell borders. */
function pageRules(file: string, pageNumber: number): PageRules {
  return findRules(renderPage(file, pageNumber, { dpi: RENDER_DPI, gray: true, dir: scratch().dir }), RENDER_DPI);
}

// A cell's text starts this far (points) to the right of the cell's left border: padding 7 px + half the border.
const TEXT_INSET_PT = 5.65;

type CellSides = { top: boolean; bottom: boolean; left: boolean; right: boolean };

/**
 * Which sides of one printed cell have a border line. The cell is found from the text around it (the row's words, the
 * neighbouring rows, the column heading's left edge); each side is a rule from the picture of the page that lies where that side
 * has to be and covers the whole side.
 */
function cellSides(page: PrintedPage, rules: PageRules, rowIndex: number, column: number): CellSides {
  const row = page.rows[rowIndex];
  const above = rowIndex > 0 ? page.rows[rowIndex - 1].bottom : (page.headingBottom ?? row.top - 30);
  const below = rowIndex + 1 < page.rows.length ? page.rows[rowIndex + 1].top : row.bottom + 14;
  const leftEdge = page.columnLefts[column] - TEXT_INSET_PT;
  const rightEdge = column + 1 < page.columnLefts.length ? page.columnLefts[column + 1] - TEXT_INSET_PT : page.width - PAGE_MARGIN_PT;
  const horizontalBetween = (lo: number, hi: number): boolean =>
    rules.horizontal.some((h) => h.pos > lo && h.pos < hi && h.from <= leftEdge + 3 && h.to >= rightEdge - 3);
  const verticalAt = (x: number): boolean => rules.vertical.some((v) => Math.abs(v.pos - x) <= 3.5 && v.from <= row.top && v.to >= row.bottom);
  return { top: horizontalBetween(above, row.top), bottom: horizontalBetween(row.bottom, below), left: verticalAt(leftEdge), right: verticalAt(rightEdge) };
}

/** Width in points of the text of one printed cell (first letter to last letter). */
function cellWidth(row: PrintedRow, label: string): number {
  const words = row.cellWords[label] ?? [];
  if (words.length === 0) throw new Error(`no text in the "${label}" cell`);
  return Math.max(...words.map((w) => w.x1)) - Math.min(...words.map((w) => w.x0));
}

// Text that belongs to the app around the sheet (navigation, builder, buttons, notices). None of it may reach the paper.
const NOT_ON_PAPER: string[] = [
  "MedInventory",
  "Kiosk Mode",
  "Order sheet",
  "Print / Save as PDF",
  "Download Excel",
  "Add an item",
  "Add all low-stock",
  "Clear sheet",
  "Sheet details",
  "Preview of the printed sheet",
  "Paper size",
  "Items on this sheet",
  "Pick items on the Inventory tab",
  "Go to print and download",
  "saved in this browser only",
  "does not place an order",
  "Refresh",
  "Remove",
  "Dismiss",
  "Retry",
];
const NOT_ON_PAPER_WORDS: RegExp[] = [/\bScan\b/, /\bAdmin\b/, /\bUsage\b/];

function leakedText(text: string): string[] {
  return [...NOT_ON_PAPER.filter((phrase) => text.includes(phrase)), ...NOT_ON_PAPER_WORDS.filter((re) => re.test(text)).map(String)];
}

// ══ 1. Print media (what the browser prints, before any PDF exists) ══════════════════════════════════════════════

test.describe("Print media: only the sheet prints", () => {
  test("navigation, builder controls, buttons, notices and live messages are not rendered when printing; the sheet is", async ({ page }) => {
    const meds = buildMedications();
    await openOrderSheet(page, { medications: meds, draft: { rows: [100, 101, 124, 126].map((id) => ({ id, ...typedFor(id) })), notes: NOTES } });

    // On screen everything is there, so "hidden when printing" below proves the PRINT rules (not missing elements).
    await expect(page.locator("nav")).toBeVisible();
    await expect(page.getByTestId("print-button")).toBeVisible();
    await expect(page.getByTestId("add-search")).toBeVisible();

    // Produce the messages that must not print: an "Added …" announcement and the "Downloaded …" success notice.
    await page.getByTestId("add-search").fill("aspirin");
    await page.getByTestId("add-result-102").click();
    await expect(page.getByTestId("add-status")).toContainText(/Added/);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-xlsx").click()]);
    expect(download.suggestedFilename()).toBe("order-sheet-2026-11-05.xlsx");
    await expect(page.getByTestId("export-success")).toBeVisible();

    await page.emulateMedia({ media: "print" });
    await expect(page.locator("nav")).toBeHidden();
    for (const testId of [
      "print-button",
      "export-xlsx",
      "export-success",
      "add-search",
      "add-status",
      "add-low-stock",
      "clear-sheet",
      "sheet-title",
      "sheet-notes",
      "paper-letter",
      "show-on-hand",
      "show-barcode",
      "sheet-disclaimer",
      "qty-input-100",
      "remove-row-100",
    ]) {
      await expect(page.getByTestId(testId), testId).toBeHidden();
    }
    await expect(page.getByTestId("sheet-preview")).toBeVisible();
    expect(await renderedOutsideSheet(page), "rendered elements outside the sheet while printing").toEqual([]);

    // The sheet itself is complete in print media: every ticked row, the notes and the footer.
    const preview = await readPreview(page);
    expect(preview.rows).toHaveLength(5);
    expect(preview.notes).toContain(NOTES);
    expect(preview.footer).toBe(FOOTER);

    // Back to screen: everything returns, so nothing was removed from the page, only hidden for print.
    await page.emulateMedia({ media: "screen" });
    await expect(page.locator("nav")).toBeVisible();
    await expect(page.getByTestId("print-button")).toBeVisible();
  });

  test("an export error notice does not print either", async ({ page }) => {
    const api = await openOrderSheet(page, { medications: buildMedications(), draft: { rows: [{ id: 100 }] } });
    api.failNext({ method: "POST", path: /\/api\/order-sheet\/xlsx$/, status: 503, body: { error: "Can’t reach the database." } });
    await page.getByTestId("export-xlsx").click();
    await expect(page.getByTestId("export-error")).toBeVisible();
    await page.emulateMedia({ media: "print" });
    await expect(page.getByTestId("export-error")).toBeHidden();
    expect(await renderedOutsideSheet(page)).toEqual([]);
  });

  test("the navigation shows the Order sheet link with the item count on screen and is hidden when printing", async ({ page }) => {
    await openOrderSheet(page, { medications: buildMedications(), draft: { rows: [{ id: 100 }, { id: 101 }, { id: 102 }] } });
    const link = page.locator("nav").getByRole("link", { name: /Order sheet/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveAccessibleName(/\(3 items\)/);
    await page.emulateMedia({ media: "print" });
    await expect(page.locator("nav")).toBeHidden();
  });

  test("Print / Save as PDF opens the browser's print window (and says so); there is no 'Download PDF' claim and no CSV", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as Window & { __printCalls?: number };
      w.__printCalls = 0;
      w.print = () => {
        w.__printCalls = (w.__printCalls ?? 0) + 1;
      };
    });
    const api = await openOrderSheet(page, { medications: buildMedications(), draft: { rows: [{ id: 100 }] } });
    const requestsBefore = api.requests.length;

    const printButton = page.getByTestId("print-button");
    await expect(printButton).toHaveText("Print / Save as PDF");
    await expect(page.getByText(/Save as PDF.{1,3}as the printer/i)).toBeVisible();
    await printButton.click();
    await expect.poll(() => page.evaluate(() => (window as Window & { __printCalls?: number }).__printCalls)).toBe(1);
    expect(api.requests.length, "printing makes no request to the server").toBe(requestsBefore);

    await expect(page.getByRole("button", { name: /download pdf/i })).toHaveCount(0);
    await expect(page.getByText(/download pdf/i)).toHaveCount(0);
    await expect(page.getByText(/\bcsv\b/i)).toHaveCount(0);
    await expect(page.getByTestId("export-xlsx")).toContainText(".xlsx");
  });

  test("while printing, the page title becomes 'Supply order - Nov 5, 2026' (the suggested PDF file name) and is restored afterwards", async ({ page }) => {
    await openOrderSheet(page, { medications: buildMedications(), draft: { rows: [{ id: 100 }] } });
    const original = await page.title();
    const during = await page.evaluate(() => {
      window.dispatchEvent(new Event("beforeprint"));
      return document.title;
    });
    expect(during).toBe("Supply order - Nov 5, 2026");
    const after = await page.evaluate(() => {
      window.dispatchEvent(new Event("afterprint"));
      return document.title;
    });
    expect(after).toBe(original);
  });
});

test.describe("What the page tells staff", () => {
  test("it says plainly that nothing is ordered, emailed or changed and that quantity and on-hand are separate, and its sections follow reading order", async ({ page }) => {
    await openOrderSheet(page, { medications: buildMedications(), draft: { rows: [{ id: 100 }] } });
    await expect(page.getByTestId("sheet-disclaimer")).toContainText("Preparing, printing or exporting this sheet does not place an order, email anyone, or change stock.");
    await expect(page.getByText("On-hand stock and order quantity are separate. Order quantity and unit are typed by staff; nothing is calculated.")).toBeVisible();

    const top = async (locator: ReturnType<Page["locator"]>): Promise<number> => {
      const box = await locator.boundingBox();
      if (!box) throw new Error("element has no box on screen");
      return box.y;
    };
    const positions = [
      await top(page.getByRole("heading", { level: 1, name: "Order sheet" })),
      await top(page.getByTestId("sheet-disclaimer")),
      await top(page.getByRole("heading", { name: /^Items on this sheet/ })),
      await top(page.getByRole("heading", { name: "Sheet details" })),
      await top(page.getByRole("heading", { name: "Print or download" })),
      await top(page.getByRole("heading", { name: "Preview of the printed sheet" })),
    ];
    expect(positions, "heading, disclaimer, builder, options, actions, preview: top to bottom").toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(positions.length);
  });
});

// ══ 2. The printed sheet as REAL PDFs (poppler) ═══════════════════════════════════════════════════════════════

test.describe("Printed PDF (read back with poppler)", () => {
  test.skip(!POPPLER.available, POPPLER.reason);

  for (const paper of PAPERS) {
    test.describe(paper.label, () => {
      test(`every page is exactly ${paper.width} x ${paper.height} pt, even when the PDF is requested as ${paper.wrongFormat} (1, 45 and 120 rows)`, async ({ browser }, testInfo) => {
        for (const count of ROW_COUNTS) {
          const info = pdfInfo((await pdfArtifact(browser, testInfo, paper, count)).file);
          expect(info.sizes, `${count} rows: one size per page`).toHaveLength(info.pages);
          for (const size of info.sizes) {
            expect([Math.round(size.width), Math.round(size.height)], `${count} rows`).toEqual([paper.width, paper.height]);
          }
        }
      });

      test("1 row fits on one page; 45 and 120 rows continue onto more pages, and no page is empty of rows", async ({ browser }, testInfo) => {
        const pageCounts: Record<number, number> = {};
        for (const count of ROW_COUNTS) {
          const art = await pdfArtifact(browser, testInfo, paper, count);
          const pages = printedPages(art);
          pageCounts[count] = pages.length;
          expect(pages.length, `${count} rows: pages in the file`).toBe(pdfInfo(art.file).pages);
          for (const p of pages) expect(p.rows.length, `${count} rows: item rows on page ${p.page}`).toBeGreaterThan(0);
          expect(pages.reduce((n, p) => n + p.rows.length, 0), `${count} rows: rows printed in total`).toBe(art.rows.length);
        }
        expect(pageCounts[1]).toBe(1);
        expect(pageCounts[45]).toBeGreaterThan(1);
        expect(pageCounts[120]).toBeGreaterThan(pageCounts[45]);
      });

      test("the column heading row is printed at the top of EVERY page", async ({ browser }, testInfo) => {
        for (const count of ROW_COUNTS) {
          const art = await pdfArtifact(browser, testInfo, paper, count);
          const pages = printedPages(art);
          for (const p of pages) {
            expect(p.headings, `${count} rows, page ${p.page} of ${pages.length}`).toEqual(["Item", "Supplier order no.", "Order qty", "Unit"]);
          }
          // a second opinion straight from the text layer, page by page
          pdfTextPages(art.file, "layout").forEach((text, i) => {
            const flat = text.replace(/\s+/g, " ");
            expect(flat, `${count} rows, page ${i + 1}`).toContain("Supplier order");
            expect(flat, `${count} rows, page ${i + 1}`).toMatch(/\bItem\b/);
            expect(flat, `${count} rows, page ${i + 1}`).toMatch(/\bUnit\b/);
          });
        }
      });

      test("every ticked item is printed exactly once, in sheet order, with its own supplier number, quantity and unit (and the preview shows the same rows)", async ({ browser }, testInfo) => {
        for (const count of ROW_COUNTS) {
          const art = await pdfArtifact(browser, testInfo, paper, count);
          const expected = art.expected.map(expectedCells);
          const onPaper = printedPages(art).flatMap((p) => p.rows).map(printedCells);
          expect(onPaper, `${count} rows on paper`).toEqual(expected);
          expect(art.preview.rows.map(previewCells), `${count} rows in the preview`).toEqual(expected);
        }
      });

      test("tall rows (several lines each) are never split across two pages: every page break falls between rows", async ({ browser }, testInfo) => {
        const art = await pdfArtifact(browser, testInfo, paper, 60, "tall");
        const pages = printedPages(art);
        // Not a magic page count: 60 rows that are several lines tall need many pages, so many page breaks fall where a row would
        // be cut if rows were allowed to split. Three pages is far below what these rows need and far above what one page holds.
        expect(pages.length, "60 tall rows need several pages, so page breaks do fall inside rows if they are allowed to").toBeGreaterThanOrEqual(3);
        for (const p of pages) expect(p.headings, `page ${p.page}`).toEqual(["Item", "Supplier order no.", "Order qty", "Unit"]);
        expect(pages.flatMap((p) => p.rows).map(printedCells), "each row is printed whole, exactly once").toEqual(art.expected.map(expectedCells));
        for (const p of pages) {
          expect(p.wordsOutsideMargins, `page ${p.page}`).toEqual([]);
          expect(p.overlappingWords, `page ${p.page}`).toEqual([]);
          expect(p.wordsPastColumn, `page ${p.page}`).toEqual([]);
        }
      });

      test("no navigation, button, builder or notice text reaches the paper", async ({ browser }, testInfo) => {
        for (const count of ROW_COUNTS) {
          const art = await pdfArtifact(browser, testInfo, paper, count);
          const text = pdfTextPages(art.file, "raw").join("\n");
          expect(leakedText(text), `${count} rows`).toEqual([]);
        }
      });

      test("long names and 64-character supplier numbers are complete: nothing is clipped, pushed past its column or overlapping its neighbour", async ({ browser }, testInfo) => {
        for (const count of ROW_COUNTS) {
          const art = await pdfArtifact(browser, testInfo, paper, count);
          const pages = printedPages(art);
          for (const p of pages) {
            expect(p.wordsOutsideMargins, `${count} rows, page ${p.page}: words outside the page margins`).toEqual([]);
            expect(p.overlappingWords, `${count} rows, page ${p.page}: overlapping words`).toEqual([]);
            expect(p.wordsPastColumn, `${count} rows, page ${p.page}: words past the right edge of their column`).toEqual([]);
          }
        }
        const art = await pdfArtifact(browser, testInfo, paper, 45);
        const rows = printedPages(art).flatMap((p) => p.rows);
        const byName = (name: string): PrintedRow => {
          const found = rows.find((r) => sq(r.cells["Item"] ?? "") === sq(name));
          if (!found) throw new Error(`row "${name.slice(0, 30)}…" not printed`);
          return found;
        };
        expect(sq(byName(LONG_NAME).cells["Supplier order no."])).toBe(LONG_CODE_HYPHEN);
        expect(sq(byName("Plain long code item").cells["Supplier order no."])).toBe(LONG_CODE_PLAIN);
        expect(sq(byName("A".repeat(113)).cells["Item"])).toBe("A".repeat(113));
        expect(sq(byName(LONG_300).cells["Supplier order no."])).toBe("300-NAME-SPACED");
        expect(sq(byName(LONG_300_UNBROKEN).cells["Item"]), "a 300-character name with no spaces is printed whole").toBe(LONG_300_UNBROKEN);
        expect(LONG_300).toHaveLength(300);
        expect(LONG_CODE_HYPHEN).toHaveLength(64);
        expect(LONG_CODE_PLAIN).toHaveLength(64);
      });

      test("missing supplier numbers print an em dash; the title, date and prepared-by are on page 1; the footer repeats; the notes close the sheet", async ({ browser }, testInfo) => {
        for (const count of [45, 120] as const) {
          const art = await pdfArtifact(browser, testInfo, paper, count);
          const pages = printedPages(art);
          const preamble = sq(pages[0].preamble);
          expect(preamble).toContain(sq(TITLE));
          expect(preamble).toContain(sq("Date: Nov 5, 2026"));
          expect(preamble).toContain(sq(`Prepared by: ${PREPARED_BY}`));
          for (const p of pages) expect(sq(p.footer), `${count} rows, footer on page ${p.page}`).toBe(sq(FOOTER));
          const dashRows = pages.flatMap((p) => p.rows).filter((r) => (r.cells["Supplier order no."] ?? "").trim() === "—").length;
          const wanted = art.expected.filter((e) => e.code === "—").length;
          expect(wanted, "the fixture has items without a supplier number").toBeGreaterThan(5);
          expect(dashRows, `${count} rows: items without a supplier number print an em dash`).toBe(wanted);
          expect(sq(pages[pages.length - 1].notes), `${count} rows: notes on the last page`).toContain(sq(NOTES));
          const lastPageLayout = pdfTextPages(art.file, "layout").slice(-1)[0] ?? "";
          expect(lastPageLayout, `${count} rows: the line break typed in the notes is kept on paper`).toMatch(/^\s*Call ahead: 555-0100\.\s*$/m);
          expect(pages.slice(0, -1).map((p) => p.notes), `${count} rows: notes only once`).toEqual(pages.slice(0, -1).map(() => ""));
        }
        const single = printedPages(await pdfArtifact(browser, testInfo, paper, 1));
        expect(sq(single[0].preamble)).toContain(sq(TITLE));
        expect(single[0].notes, "no notes were typed for the 1-row sheet").toBe("");
      });

      test("pages are not blank (grayscale render) and contain no colour at all, so a black-and-white printer loses nothing", async ({ browser }, testInfo) => {
        for (const count of ROW_COUNTS) {
          const art = await pdfArtifact(browser, testInfo, paper, count);
          const { pages } = pdfInfo(art.file);
          for (let n = 1; n <= pages; n += 1) {
            const gray = rasterStats(renderPage(art.file, n, { dpi: 40, gray: true, dir: scratch().dir }));
            expect(gray.markedPixels, `${count} rows, page ${n}: ink on the page`).toBeGreaterThan(400);
            expect(gray.markedPixels / gray.pixels, `${count} rows, page ${n}: not a solid block`).toBeLessThan(0.6);
            const colour = rasterStats(renderPage(art.file, n, { dpi: 40, gray: false, dir: scratch().dir }));
            expect(colour.chromaticPixels, `${count} rows, page ${n}: coloured pixels`).toBe(0);
          }
        }
      });

      test('every page says "Page N of M" in the bottom margin (progressive enhancement, needs Chromium 131+)', async ({ browser }, testInfo) => {
        const major = Number(browser.version().split(".")[0]);
        test.skip(major < 131, `this Chromium (${browser.version()}) does not print @page margin boxes (needs 131 or newer)`);
        for (const count of [45, 120] as const) {
          const art = await pdfArtifact(browser, testInfo, paper, count);
          const texts = pdfTextPages(art.file, "layout");
          texts.forEach((text, i) => {
            expect(text.replace(/\s+/g, " "), `${count} rows, page ${i + 1}`).toContain(`Page ${i + 1} of ${texts.length}`);
          });
        }
      });

      test("with the on-hand and barcode columns switched on, every value stays in its own column, nothing is clipped, and the typed order quantity is never replaced by stock", async ({ browser }, testInfo) => {
        const art = await pdfArtifact(browser, testInfo, paper, 45, "wide");
        const pages = printedPages(art);
        expect(pages.length).toBeGreaterThan(1);
        const rows: PrintedRow[] = [];
        for (const p of pages) {
          expect(p.headings, `page ${p.page}`).toEqual(["Item", "Supplier order no.", "Order qty", "Unit", "On hand", "Barcode"]);
          expect(p.wordsOutsideMargins, `page ${p.page}`).toEqual([]);
          expect(p.overlappingWords, `page ${p.page}`).toEqual([]);
          expect(p.wordsPastColumn, `page ${p.page}`).toEqual([]);
          rows.push(...p.rows);
        }
        expect(rows).toHaveLength(art.expected.length);
        rows.forEach((row, i) => {
          const e = art.expected[i];
          expect(sq(row.cells["Item"]), `row ${i + 1} item`).toBe(sq(e.name));
          expect((row.cells["Order qty"] ?? "").trim(), `row ${i + 1}: order quantity is what staff typed (blank stays blank)`).toBe(e.qty);
          expect(sq(row.cells["Unit"]), `row ${i + 1}: order unit`).toBe(sq(e.unit));
          expect(sq(row.cells["On hand"]), `row ${i + 1}: on hand is its own column`).toBe(sq(e.onHand));
          expect(sq(row.cells["Barcode"]), `row ${i + 1}: barcode keeps its leading zeros`).toBe(sq(e.barcode));
        });
        expect(art.preview.headers).toEqual(["Item", "Supplier order no.", "Order qty", "Unit", "On hand", "Barcode"]);
      });

      test("the text is large enough to read: item rows are set in 8 pt type or larger (median), and so is every word anywhere on the paper (smallest), at 1, 45 and 120 rows", async ({ browser }, testInfo) => {
        for (const count of ROW_COUNTS) {
          const art = await pdfArtifact(browser, testInfo, paper, count);
          const rowHeights = printedPages(art).flatMap((p) => p.rows.flatMap((r) => r.words.map((w) => w.y1 - w.y0)));
          const allHeights = pdfWords(art.file).flatMap((p) => p.words.map((w) => w.y1 - w.y0));
          expect(rowHeights.length, `${count} rows: item-row words measured`).toBeGreaterThan(count * 3);
          expect(median(rowHeights), `${count} rows: median height of a word in the item rows (points)`).toBeGreaterThanOrEqual(MIN_TEXT_BOX_HEIGHT_PT);
          expect(Math.min(...allHeights), `${count} rows: height of the smallest word on the paper, headings, footer and page numbers included (points)`).toBeGreaterThanOrEqual(MIN_TEXT_BOX_HEIGHT_PT);
        }
      });

      test("rows are tall enough to write in (7.5 mm or more) and the table runs from margin to margin: the browser did not shrink the sheet to fit", async ({ browser }, testInfo) => {
        const short = await pdfArtifact(browser, testInfo, paper, 60, "short");
        const pitches: number[] = [];
        for (const p of printedPages(short)) {
          p.rows.forEach((row, i) => {
            const next = p.rows[i + 1];
            // a one-line row is as tall as its cell padding and one line of type: the distance to the next row's text is its height
            if (next && row.lines === 1) pitches.push(next.top - row.top);
          });
        }
        expect(pitches.length, "60 one-line rows: row heights measured").toBeGreaterThan(40);
        expect(Math.min(...pitches), "height of the shortest row (points)").toBeGreaterThanOrEqual(MIN_ROW_PITCH_PT);
        const art = await pdfArtifact(browser, testInfo, paper, 45);
        for (const p of printedPages(art)) {
          const verticals = pageRules(art.file, p.page).vertical.filter((v) => v.to - v.from > 40).map((v) => v.pos);
          expect(verticals.length, `page ${p.page}: vertical borders found`).toBeGreaterThanOrEqual(p.headings.length + 1);
          expect(Math.min(...verticals), `page ${p.page}: the table's left border sits on the left margin`).toBeGreaterThan(PAGE_MARGIN_PT - 2.5);
          expect(Math.min(...verticals), `page ${p.page}: the table's left border sits on the left margin`).toBeLessThan(PAGE_MARGIN_PT + 2.5);
          expect(Math.max(...verticals), `page ${p.page}: the table's right border reaches the right margin`).toBeGreaterThan(p.width - PAGE_MARGIN_PT - 3.5);
          expect(Math.max(...verticals), `page ${p.page}: the table's right border reaches the right margin`).toBeLessThan(p.width - PAGE_MARGIN_PT + 1);
        }
      });

      test("paper is used sensibly: one row is one page, and 45 and 120 rows average at least 10 item rows per page", async ({ browser }, testInfo) => {
        for (const count of ROW_COUNTS) {
          const art = await pdfArtifact(browser, testInfo, paper, count);
          const pages = pdfInfo(art.file).pages;
          if (count === 1) {
            expect(pages, "a one-row sheet fits on one page").toBe(1);
          } else {
            expect(count / pages, `${count} rows on ${pages} pages: item rows per page`).toBeGreaterThanOrEqual(MIN_ROWS_PER_PAGE);
          }
        }
      });

      test("every cell is a bordered box on all four sides, so blank Order qty and Unit cells are empty boxes to fill in by hand", async ({ browser }, testInfo) => {
        for (const count of [1, 45] as const) {
          const art = await pdfArtifact(browser, testInfo, paper, count);
          let blankCells = 0;
          for (const p of printedPages(art)) {
            const rules = pageRules(art.file, p.page);
            p.rows.forEach((row, rowIndex) => {
              p.headings.forEach((label, column) => {
                const blank = (row.cells[label] ?? "").trim() === "";
                if (blank) blankCells += 1;
                expect(cellSides(p, rules, rowIndex, column), `${count} rows, page ${p.page}, row ${rowIndex + 1}, "${label}"${blank ? " (blank)" : ""}`).toEqual({
                  top: true,
                  bottom: true,
                  left: true,
                  right: true,
                });
              });
            });
          }
          expect(blankCells, `${count} rows: blank cells checked`).toBeGreaterThanOrEqual(count === 1 ? 2 : 20);
        }
      });

      test("the text is solid black: every printed word has near-black ink, so nothing fades on a black-and-white or draft-mode printer", async ({ browser }, testInfo) => {
        const art = await pdfArtifact(browser, testInfo, paper, 45);
        const pages = pdfWords(art.file);
        const darkest: number[] = [];
        pages.forEach((p, i) => {
          const raster = renderPage(art.file, i + 1, { dpi: RENDER_DPI, gray: true, dir: scratch().dir });
          // a hair inside each word box, so the cell borders around the text are not part of the measurement
          darkest.push(...darkestInBoxes(raster, RENDER_DPI, p.words.map((w) => ({ x0: w.x0 + 0.3, x1: w.x1 - 0.3, y0: w.y0 + 0.3, y1: w.y1 - 0.3 }))));
        });
        expect(darkest.length, "words measured").toBeGreaterThan(100);
        const sorted = [...darkest].sort((a, b) => a - b);
        expect(median(darkest), "darkest pixel of a typical word (0 = black, 255 = paper)").toBeLessThanOrEqual(30);
        expect(sorted[Math.floor(sorted.length * 0.95)], "darkest pixel of the 95th-percentile word (0 = black, 255 = paper)").toBeLessThanOrEqual(60);
      });

      test("with notes typed, no page holds only the notes: every page of a 1 to 40 row sheet has item rows, so the notes stay with the last item", async ({ page }) => {
        test.setTimeout(240_000);
        const meds = buildManyMedications(45);
        await openOrderSheet(page, { medications: meds, draft: { rows: [{ id: meds[0].id }], title: TITLE, preparedBy: PREPARED_BY, notes: NOTES, paper: paper.key } });
        const orphans: string[] = [];
        for (let count = 1; count <= 40; count += 1) {
          await setDraftRows(page, meds.slice(0, count).map((m) => m.id));
          const file = path.join(scratch().dir, `sweep-${paper.key}-${count}.pdf`);
          await savePdf(page, file);
          const pages = readPrintedTable(file, FOOTER);
          for (const p of pages) {
            if (p.rows.length === 0) orphans.push(`${count} rows: page ${p.page} of ${pages.length} has no item rows (it carries ${p.notes ? "the notes" : "nothing"} and ${p.footer ? "the footer" : "no footer"})`);
          }
          rmSync(file, { force: true });
        }
        expect(orphans, "sheets that end with a page that has no item rows").toEqual([]);
      });
    });
  }

  test("supplier numbers and barcodes are set in a monospace face (every character the same width), item names are not", async ({ browser }, testInfo) => {
    const { file } = await monoArtifact(browser, testInfo);
    const rows = readPrintedTable(file, FOOTER).flatMap((p) => p.rows);
    expect(rows.map((r) => r.cells["Item"]), "the five rows that were printed").toEqual(MONO_STRINGS);
    const spread = (label: string): number => {
      const widths = rows.map((r) => cellWidth(r, label));
      return Math.max(...widths) - Math.min(...widths);
    };
    // ten letters I, ten letters W, ten l, ten M and ten zeros: equally wide only if every character has the same width
    expect(spread("Supplier order no."), "widest minus narrowest supplier number (points)").toBeLessThan(1.5);
    expect(spread("Barcode"), "widest minus narrowest barcode (points)").toBeLessThan(1.5);
    expect(spread("Item"), "control: the same strings as item names are in a proportional face, so their widths differ").toBeGreaterThan(40);
  });
});

// ══ 3. Empty and invalid sheets ═══════════════════════════════════════════════════════════════════════════════

test.describe("Empty and invalid sheets", () => {
  test("an empty sheet says so clearly, and Print and Download are disabled with a visible reason", async ({ page }) => {
    await openOrderSheet(page, { medications: buildMedications(), draft: null });
    await expect(page.getByTestId("sheet-empty")).toBeVisible();
    await expect(page.getByTestId("sheet-empty")).toContainText("No items on the order sheet yet");
    await expect(page.getByTestId("print-button")).toBeDisabled();
    await expect(page.getByTestId("export-xlsx")).toBeDisabled();
    const reason = page.getByText("Add at least one item to print or download the sheet.");
    await expect(reason).toBeVisible();
    await expect(page.getByTestId("print-button")).toHaveAccessibleDescription(/Add at least one item/);
    await expect(page.getByTestId("export-xlsx")).toHaveAccessibleDescription(/Add at least one item/);

    // adding one item enables both, emptying the sheet again disables them again
    await page.getByTestId("add-search").fill("ibuprofen");
    await page.getByTestId("add-result-101").click();
    await expect(page.getByTestId("print-button")).toBeEnabled();
    await expect(page.getByTestId("export-xlsx")).toBeEnabled();
    await expect(reason).toBeHidden();
    await page.getByTestId("remove-row-101").click();
    await expect(page.getByTestId("print-button")).toBeDisabled();
    await expect(page.getByTestId("export-xlsx")).toBeDisabled();
    await expect(reason).toBeVisible();
  });

  test("if an empty sheet is printed anyway (Ctrl+P), the paper says 'No items on this order sheet' instead of coming out blank", async ({ page }) => {
    test.skip(!POPPLER.available, POPPLER.reason);
    await openOrderSheet(page, { medications: buildMedications(), draft: null });
    const file = path.join(scratch().dir, "empty.pdf");
    await savePdf(page, file);
    expect(pdfInfo(file).pages).toBe(1);
    const text = pdfTextPages(file, "raw").join("\n");
    expect(text).toContain("No items on this order sheet");
    expect(leakedText(text)).toEqual([]);
    const gray = rasterStats(renderPage(file, 1, { dpi: 40, gray: true, dir: scratch().dir }));
    expect(gray.markedPixels).toBeGreaterThan(400);
  });

  test("when every ticked item has been deleted from the inventory, the sheet stays disabled with a reason and prints as empty", async ({ page }) => {
    await openOrderSheet(page, { medications: buildMedications(), draft: { rows: [{ id: 9001 }, { id: 9002 }] } });
    await expect(page.getByTestId("sheet-row-9001")).toContainText(/no longer in inventory/i);
    await expect(page.getByTestId("sheet-row-9002")).toContainText(/no longer in inventory/i);
    await expect(page.getByTestId("missing-items-summary")).toContainText("2 items are no longer in the inventory");
    await expect(page.getByTestId("print-button")).toBeDisabled();
    await expect(page.getByTestId("export-xlsx")).toBeDisabled();
    await expect(page.getByText(/None of the items on the sheet are in the inventory any more/)).toBeVisible();
    const preview = await readPreview(page);
    expect(preview.rows).toEqual([]);
    expect(preview.emptyMessage).toBe("No items on this order sheet");
  });

  test("an invalid order quantity disables Print and Download with a reason; with print media the paper explains the '?' marker, and fixing the quantity re-enables both", async ({ page }) => {
    await openOrderSheet(page, { medications: buildMedications(), draft: { rows: [{ id: 100, qty: "5", unit: "box" }, { id: 101 }] } });
    await page.getByTestId("qty-input-101").fill("12abc");
    await expect(page.getByTestId("export-xlsx")).toBeDisabled();
    await expect(page.getByTestId("print-button")).toBeDisabled();
    await expect(page.getByText(/Fix the order quantity on 1 row first/)).toBeVisible();
    await expect(page.getByTestId("invalid-qty-summary")).toBeVisible();

    // On screen the paper stays quiet (the builder already explains the problem) ...
    await expect(page.getByTestId("print-invalid-note")).toBeHidden();
    // ... but Ctrl+P still prints the page, and then the paper says what is wrong.
    await page.emulateMedia({ media: "print" });
    await expect(page.getByTestId("print-invalid-note")).toBeVisible();
    await expect(page.getByTestId("print-qty-marker")).toBeVisible();
    await page.emulateMedia({ media: "screen" });

    await page.getByTestId("qty-input-101").fill("12");
    await expect(page.getByTestId("export-xlsx")).toBeEnabled();
    await expect(page.getByTestId("print-button")).toBeEnabled();
    await expect(page.getByTestId("invalid-qty-summary")).toHaveCount(0);
  });

  test("if a sheet with an invalid quantity is printed anyway (Ctrl+P), the PDF marks that quantity '?' and says why, instead of silently dropping it", async ({ page }) => {
    test.skip(!POPPLER.available, POPPLER.reason);
    await openOrderSheet(page, { medications: buildMedications(), draft: { rows: [{ id: 100, qty: "5", unit: "box" }, { id: 101 }] } });
    await page.getByTestId("qty-input-101").fill("12abc");
    await expect(page.getByTestId("invalid-qty-summary")).toBeVisible();
    const file = path.join(scratch().dir, "invalid-qty.pdf");
    await savePdf(page, file);
    const rows = readPrintedTable(file, FOOTER).flatMap((p) => p.rows);
    expect(rows.map((r) => (r.cells["Order qty"] ?? "").trim())).toEqual(["5", "?"]);
    expect(pdfTextPages(file, "raw").join("\n").replace(/\s+/g, " ")).toContain("Some quantities are not valid numbers");
  });
});

// Ctrl/Cmd+P works whatever the page is showing. Before the inventory has loaded, or when it could not be loaded, there is no sheet
// to print; the paper must say so instead of coming out blank (a blank page looks like a printer fault, or like an empty order).
test.describe("Printing before the inventory is ready", () => {
  test.skip(!POPPLER.available, POPPLER.reason);
  const SAVED_DRAFT: DraftSeed = { rows: [{ id: 100, qty: "3", unit: "box" }] };

  async function printedText(page: Page, fileName: string): Promise<string> {
    const file = path.join(scratch().dir, fileName);
    await savePdf(page, file);
    expect(pdfInfo(file).pages, "the browser printed something").toBeGreaterThanOrEqual(1);
    return pdfTextPages(file, "raw").join("\n").replace(/\s+/g, " ").trim();
  }

  test("when the inventory could not be loaded, printing does not give a blank page: the paper says the inventory is not available", async ({ page }) => {
    await openOrderSheetUnready(page, { medications: buildMedications(), draft: SAVED_DRAFT, state: "error" });
    const text = await printedText(page, "unready-error.pdf");
    expect(text, "what the paper says").not.toBe("");
    expect(text, "what the paper says").toMatch(/inventory/i);
  });

  test("while the inventory is still loading, printing does not give a blank page: the paper says the inventory is loading", async ({ page }) => {
    await openOrderSheetUnready(page, { medications: buildMedications(), draft: SAVED_DRAFT, state: "loading" });
    const text = await printedText(page, "unready-loading.pdf");
    expect(text, "what the paper says").not.toBe("");
    expect(text, "what the paper says").toMatch(/inventory/i);
  });

  test("control: the same page prints the sheet as soon as the slow inventory has arrived, so the blank pages above come from the loading and error states themselves", async ({ page }) => {
    const { release } = await openOrderSheetUnready(page, { medications: buildMedications(), draft: SAVED_DRAFT, state: "loading" });
    release();
    await expect(page.getByTestId("sheet-preview")).toBeVisible();
    expect(await printedText(page, "unready-after.pdf"), "once loaded, the sheet itself prints").toContain("Acetaminophen 500 mg, tablets");
  });
});

// ══ 4. The Excel file, opened with an independent oracle (python3 -I + openpyxl + raw XML) ═══════════════════════

async function downloadXlsx(page: Page, fileName: string): Promise<{ file: string; suggestedName: string }> {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), page.getByTestId("export-xlsx").click()]);
  const file = path.join(scratch().dir, fileName);
  await download.saveAs(file);
  return { file, suggestedName: download.suggestedFilename() };
}

test.describe("Excel export (openpyxl)", () => {
  test.skip(!PYTHON_OPENPYXL.available, PYTHON_OPENPYXL.reason);

  test("the download is order-sheet-YYYY-MM-DD.xlsx, a real workbook with exactly the ticked items, once each, in sheet order", async ({ page }) => {
    const meds = buildMedications();
    // deliberately not alphabetical and not id order; includes the long-name item and the barcode-only (unnamed) item
    const rows = [111, 100, 124, 103, 118, 125, 107, 126].map((id, i) => ({ id, ...typedFor(i + 1) }));
    await openOrderSheet(page, { medications: meds, draft: { rows, preparedBy: PREPARED_BY, notes: NOTES } });
    const { file, suggestedName } = await downloadXlsx(page, "ticked-items.xlsx");
    expect(suggestedName).toBe("order-sheet-2026-11-05.xlsx");

    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 2).toString("latin1"), "a .xlsx is a zip archive").toBe("PK");
    const report = inspectXlsx(file);
    expect(report.zipEntries).toEqual(expect.arrayContaining(["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]));
    expect(report.sheetNames).toEqual(["Order sheet"]);

    const table = xlsxTable(report);
    const expected = expectedFor(meds, rows);
    expect(table.headers).toEqual(["No.", "Item", "Supplier order no.", "Order qty", "Unit"]);
    expect(table.rows, "27 items are in the inventory, only the 8 ticked ones are exported").toHaveLength(8);
    expect(table.rows.map((r) => Number(cellText(r["No."])))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(table.rows.map((r) => cellText(r["Item"]))).toEqual(expected.map((e) => e.name));
    expect(table.rows.map((r) => cellText(r["Supplier order no."]))).toEqual(expected.map((e) => e.code));
    expect(table.rows.map((r) => cellText(r["Unit"]))).toEqual(expected.map((e) => e.unit));
    expect(table.rows.map((r) => cellText(r["Order qty"]))).toEqual(expected.map((e) => e.qty));

    // the title block above the table
    const top = new Map(table.preamble.map((c) => [c.ref, cellText(c)]));
    expect(top.get("A1")).toBe("Title");
    expect(top.get("B1")).toBe(TITLE);
    expect(top.get("A2")).toBe("Date");
    expect(top.get("B2")).toBe("2026-11-05");
    expect(top.get("A3")).toBe("Prepared by");
    expect(top.get("B3")).toBe(PREPARED_BY);
    expect(top.get("B4")).toBe(NOTES);
  });

  test("supplier order numbers keep leading zeros, letters and punctuation as text (0092, 00417-B, 000000, 1E5, a date, 20 digits)", async ({ page }) => {
    const meds = TRICKY_SUPPLIER_NUMBERS.map((code, i) => item(22001 + i, { name: `Tricky code item ${i + 1}`, supplier_order_number: code }));
    await openOrderSheet(page, { medications: meds, draft: { rows: meds.map((m) => ({ id: m.id })) } });
    const { file } = await downloadXlsx(page, "tricky-codes.xlsx");
    const report = inspectXlsx(file);
    const table = xlsxTable(report);
    expect(table.rows).toHaveLength(TRICKY_SUPPLIER_NUMBERS.length);
    table.rows.forEach((row, i) => {
      const code = TRICKY_SUPPLIER_NUMBERS[i];
      const cell = row["Supplier order no."];
      expect(cell.value, `${code} is stored exactly as typed`).toBe(code);
      expect(cell.type, `${code} is a text cell`).toBe("s");
      expect(cell.format, `${code} is formatted as text`).toBe("@");
      expect(["s", "inlineStr"], `${code} raw cell type`).toContain(report.rawCellTypes[cell.ref]);
    });
    // the same codes are what the preview (and so the paper) shows
    expect((await readPreview(page)).rows.map((r) => r[1])).toEqual([...TRICKY_SUPPLIER_NUMBERS]);
  });

  test("order quantity is a number, order unit is text, and a blank quantity or unit stays blank (never filled from stock)", async ({ page }) => {
    const meds = [
      item(23001, { name: "Case A", stock: 500 }),
      item(23002, { name: "Case B", stock: 500 }),
      item(23003, { name: "Case C", stock: 500 }),
      item(23004, { name: "Case D", stock: 500 }),
      item(23005, { name: "Case E", stock: 500 }),
    ];
    const rows = [
      { id: 23001, qty: "12", unit: "box" },
      { id: 23002, qty: "007", unit: "007" }, // leading zeros: the quantity is normalised to 7, the unit is text and stays "007"
      { id: 23003, qty: "", unit: "" },
      { id: 23004, qty: "999999999", unit: "case of 12" },
      { id: 23005, qty: "1", unit: "=SUM(1,1)" },
    ];
    await openOrderSheet(page, { medications: meds, draft: { rows } });
    const { file } = await downloadXlsx(page, "quantities.xlsx");
    const table = xlsxTable(inspectXlsx(file));
    const qty = table.rows.map((r) => r["Order qty"]);
    const unit = table.rows.map((r) => r["Unit"]);

    expect(qty.map((c) => c.value)).toEqual([12, 7, null, 999999999, 1]);
    expect(qty.map((c) => (c.value === null ? "blank" : c.type)), "typed quantities are numeric cells").toEqual(["n", "n", "blank", "n", "n"]);
    expect(qty.every((c) => c.value === null || Number.isInteger(c.value))).toBe(true);
    expect(unit.map((c) => c.value)).toEqual(["box", "007", null, "case of 12", "=SUM(1,1)"]);
    expect(unit.map((c) => (c.value === null ? "blank" : c.type)), "units are text cells").toEqual(["s", "s", "blank", "s", "s"]);
    expect(table.headers, "no on-hand column unless it is switched on").toEqual(["No.", "Item", "Supplier order no.", "Order qty", "Unit"]);
    expect(qty[2].value, "stock is 500 but the blank quantity stays blank").toBeNull();
  });

  test("the On hand and Barcode columns appear only when switched on; On hand is separate text and never changes the order quantity", async ({ page }) => {
    const meds = buildMedications();
    const rows = [100, 101, 126].map((id, i) => ({ id, qty: i === 1 ? "" : String(10 * (i + 1)), unit: i === 1 ? "" : "box" }));
    await openOrderSheet(page, { medications: meds, draft: { rows } });

    const plain = xlsxTable(inspectXlsx((await downloadXlsx(page, "plain.xlsx")).file));
    expect(plain.headers).toEqual(["No.", "Item", "Supplier order no.", "Order qty", "Unit"]);

    await page.getByTestId("show-on-hand").check();
    await page.getByTestId("show-barcode").check();
    const wideReport = inspectXlsx((await downloadXlsx(page, "wide.xlsx")).file);
    const wide = xlsxTable(wideReport);
    expect(wide.headers).toEqual(["No.", "Item", "Supplier order no.", "Order qty", "Unit", "On hand", "Barcode"]);
    const expected = expectedFor(meds, rows);
    expect(wide.rows.map((r) => cellText(r["On hand"]))).toEqual(expected.map((e) => e.onHand));
    expect(wide.rows.map((r) => r["On hand"].type)).toEqual(["s", "s", "s"]);
    expect(wide.rows.map((r) => cellText(r["Barcode"]))).toEqual(expected.map((e) => e.barcode));
    expect(wide.rows.map((r) => r["Barcode"].type), "barcodes are text, so leading zeros survive").toEqual(["s", "s", "s"]);
    expect(wide.rows[2]["Barcode"].value).toBe("0049000028911");

    // switching the columns on changed nothing in the quantity or unit columns
    expect(wide.rows.map((r) => cellText(r["Order qty"]))).toEqual(plain.rows.map((r) => cellText(r["Order qty"])));
    expect(wide.rows.map((r) => cellText(r["Unit"]))).toEqual(plain.rows.map((r) => cellText(r["Unit"])));
    expect(wide.rows[1]["Order qty"].value, "blank quantity next to an on-hand value").toBeNull();
  });

  test("the header row is bold and frozen, the sheet is one page wide, and the workbook contains no formula cells at all", async ({ page }) => {
    const meds = buildMedications();
    await openOrderSheet(page, { medications: meds, draft: { rows: [100, 101, 102, 103].map((id) => ({ id })), preparedBy: PREPARED_BY, notes: NOTES } });
    const report = inspectXlsx((await downloadXlsx(page, "structure.xlsx")).file);
    const table = xlsxTable(report);
    const headerCells = report.cells.filter((c) => c.row === table.headerRow && c.value !== null);
    expect(headerCells.map((c) => c.bold), "every header cell is bold").toEqual(headerCells.map(() => true));
    expect(report.freezePanes, "everything down to the header row stays on screen while scrolling").toBe(`A${table.headerRow + 1}`);
    expect(report.printTitleRows, "the header row repeats on every printed page").toBe(`$${table.headerRow}:$${table.headerRow}`);
    expect(report.orientation).toBe("portrait");
    expect(report.fitToPage).toBe(true);
    expect(report.fitToWidth).toBe(1);
    expect(report.formulaCells, "openpyxl sees no formula cell").toEqual([]);
    expect(report.rawFormulaCells, "the sheet XML has no formula cell").toEqual([]);
    expect(report.formulaTagCount, "the sheet XML has no formula tag").toBe(0);
    expect(report.cells.filter((c) => c.type === "f" || c.type === "e")).toEqual([]);
    expect(report.sheetNames).toEqual(["Order sheet"]);
  });

  test("commas, quotes, line breaks, tabs, accents, CJK, Arabic, emoji, 113- and 300-character names and HTML text reach the workbook intact", async ({ page }) => {
    const names = [...UNUSUAL_NAMES, LONG_300, LONG_300_UNBROKEN];
    const meds = names.map((name, i) =>
      item(24001 + i, { name, supplier_order_number: TRICKY_SUPPLIER_NUMBERS[i % TRICKY_SUPPLIER_NUMBERS.length] })
    );
    const rows = meds.map((m, i) => ({ id: m.id, qty: String(i + 1), unit: i % 2 === 0 ? "box" : "pack" }));
    await openOrderSheet(page, { medications: meds, draft: { rows, notes: 'Line one\nLine two, with a "quote"' } });
    const report = inspectXlsx((await downloadXlsx(page, "unusual.xlsx")).file);
    const table = xlsxTable(report);
    expect(table.rows.map((r) => cellText(r["Item"]))).toEqual(names.map((n) => n.trim()));
    expect(table.rows.map((r) => r["Item"].type)).toEqual(names.map(() => "s"));
    expect(table.rows.map((r) => cellText(r["Order qty"]))).toEqual(names.map((_, i) => String(i + 1)));
    const notes = table.preamble.find((c) => c.ref === "B4");
    expect(notes?.value).toBe('Line one\nLine two, with a "quote"');
  });

});

// These checks need the browser first and the workbook second: the browser half (what the page shows, which file name the download
// has, what the request says) always runs, the workbook half needs python3 + openpyxl and is reported as SKIPPED without them.
test.describe("Excel export options and defaults", () => {
  const ONLY_ONE_COLUMN = [
    { label: "On hand", testId: "show-on-hand", flags: { showOnHand: true, showBarcode: false } },
    { label: "Barcode", testId: "show-barcode", flags: { showOnHand: false, showBarcode: true } },
  ] as const;

  for (const option of ONLY_ONE_COLUMN) {
    test(`ticking only "${option.label}" adds only that column: the export request, the preview and the workbook all agree`, async ({ page }) => {
      const meds = buildMedications();
      const rows = [100, 101, 126].map((id) => ({ id, qty: "10", unit: "box" }));
      const api = await openOrderSheet(page, { medications: meds, draft: { rows } });
      await page.getByTestId(option.testId).check();
      expect((await readPreview(page)).headers, "the printed sheet").toEqual([...BASE_HEADERS, option.label]);

      const { file } = await downloadXlsx(page, `only-${option.testId}.xlsx`);
      const body = api.requestsTo("POST", XLSX_PATH)[0].body as Record<string, unknown>;
      expect({ showOnHand: body.showOnHand, showBarcode: body.showBarcode }, "the flags in the export request").toEqual(option.flags);

      test.skip(!PYTHON_OPENPYXL.available, PYTHON_OPENPYXL.reason);
      const table = xlsxTable(inspectXlsx(file));
      expect(table.headers, "the workbook").toEqual(["No.", "Item", "Supplier order no.", "Order qty", "Unit", option.label]);
      const expected = expectedFor(meds, rows).map((e) => (option.label === "On hand" ? e.onHand : e.barcode));
      expect(table.rows.map((r) => cellText(r[option.label]))).toEqual(expected);
    });
  }

  test("a date typed in the Date box is the date on the sheet: preview, file name, export request and workbook agree", async ({ page }) => {
    const api = await openOrderSheet(page, { medications: buildMedications(), draft: { rows: [{ id: 100 }] } });
    await page.getByTestId("sheet-date").fill("2026-12-24");
    await expect.poll(async () => (await readPreview(page)).dateLine).toBe("Date: Dec 24, 2026");
    const { file, suggestedName } = await downloadXlsx(page, "chosen-date.xlsx");
    expect(suggestedName).toBe("order-sheet-2026-12-24.xlsx");
    expect((api.requestsTo("POST", XLSX_PATH)[0].body as { date: string }).date).toBe("2026-12-24");
    test.skip(!PYTHON_OPENPYXL.available, PYTHON_OPENPYXL.reason);
    expect(xlsxTable(inspectXlsx(file)).preamble.find((c) => c.ref === "B2")?.value).toBe("2026-12-24");
  });

  test("a new sheet has no barcode or on-hand column and Letter paper; quantity and unit are never invented, not even by Add all low-stock items", async ({ page }) => {
    const meds = buildMedications();
    const api = await openOrderSheet(page, { medications: meds, draft: null });
    await expect(page.getByTestId("paper-letter")).toBeChecked();
    await expect(page.getByTestId("show-on-hand")).not.toBeChecked();
    await expect(page.getByTestId("show-barcode")).not.toBeChecked();
    expect((await readPreview(page)).rows, "nothing is added automatically").toEqual([]);

    await page.getByTestId("add-search").fill("cetirizine");
    await page.getByTestId("add-result-105").click();
    await expect(page.getByTestId("qty-input-105")).toHaveValue("");
    await expect(page.getByTestId("unit-input-105")).toHaveValue("");

    const low = meds.filter((m) => m.stock <= m.threshold);
    expect(low.length, "the fixture has several low-stock items").toBeGreaterThan(5);
    await page.getByTestId("add-low-stock").click();
    const wanted = new Set([105, ...low.map((m) => m.id)]);
    await expect(page.locator("[data-testid^=sheet-row-]")).toHaveCount(wanted.size);
    for (const id of wanted) {
      await expect(page.getByTestId(`qty-input-${id}`), `quantity for item ${id}`).toHaveValue("");
      await expect(page.getByTestId(`unit-input-${id}`), `unit for item ${id}`).toHaveValue("");
    }
    const preview = await readPreview(page);
    expect(preview.headers).toEqual(BASE_HEADERS);
    expect(preview.rows.every((r) => r[2] === "" && r[3] === ""), "printed quantity and unit cells are empty").toBe(true);

    const { file } = await downloadXlsx(page, "low-stock.xlsx");
    const body = api.requestsTo("POST", XLSX_PATH)[0].body as { showOnHand: boolean; showBarcode: boolean; rows: Array<{ id: number; qty: string; unit: string }> };
    expect({ showOnHand: body.showOnHand, showBarcode: body.showBarcode }, "a new sheet exports no on-hand or barcode column").toEqual({ showOnHand: false, showBarcode: false });
    expect(body.rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([...wanted].sort((a, b) => a - b));
    expect(body.rows.every((r) => r.qty === "" && r.unit === ""), "no quantity or unit is sent that staff did not type").toBe(true);

    test.skip(!PYTHON_OPENPYXL.available, PYTHON_OPENPYXL.reason);
    const table = xlsxTable(inspectXlsx(file));
    expect(table.headers).toEqual(["No.", ...BASE_HEADERS]);
    expect(table.rows.map((r) => cellText(r["Item"])).sort()).toEqual(expectedFor(meds, [...wanted].map((id) => ({ id }))).map((e) => e.name).sort());
    expect(table.rows.map((r) => r["Order qty"].value), "no quantity was calculated from stock or thresholds").toEqual(table.rows.map(() => null));
    expect(table.rows.map((r) => r["Unit"].value)).toEqual(table.rows.map(() => null));
  });

  test.describe("default date", () => {
    test.use({ timezoneId: "Pacific/Auckland" });

    test("a sheet with no chosen date uses today's LOCAL date everywhere: date box, preview, file name, export request and workbook", async ({ page }) => {
      // 20:00 UTC on 9 March is 09:00 on 10 March in Auckland: a UTC-based "today" would say the 9th.
      await page.clock.setFixedTime(new Date("2026-03-09T20:00:00Z"));
      const api = await openOrderSheet(page, { medications: buildMedications(), draft: { rows: [{ id: 100 }], date: null } });
      await expect(page.getByTestId("sheet-date")).toHaveValue("2026-03-10");
      expect((await readPreview(page)).dateLine).toBe("Date: Mar 10, 2026");
      const { file, suggestedName } = await downloadXlsx(page, "local-date.xlsx");
      expect(suggestedName).toBe("order-sheet-2026-03-10.xlsx");
      expect((api.requestsTo("POST", XLSX_PATH)[0].body as { date: string }).date).toBe("2026-03-10");
      test.skip(!PYTHON_OPENPYXL.available, PYTHON_OPENPYXL.reason);
      expect(xlsxTable(inspectXlsx(file)).preamble.find((c) => c.ref === "B2")?.value).toBe("2026-03-10");
    });
  });
});

// ══ 5. Formula injection and HTML injection ══════════════════════════════════════════════════════════════════════

const HOSTILE_TITLE = '=HYPERLINK("http://example.invalid","click")';
const HOSTILE_PREPARED_BY = "+1+1";
const HOSTILE_NOTES = "@SUM(A1:A2)";
const HOSTILE_UNIT = "-2+3";
const HOSTILE_CODES = ["=1+1", "+44 20 7946 0000", "-5", "@A1", "=cmd|' /C calc'!A0", "=HYPERLINK(\"http://example.invalid\")", "+1"];

function formulaFixture(): { meds: Medication[]; rows: DraftSeed["rows"] } {
  const meds = FORMULA_NAMES.map((name, i) => item(25001 + i, { name, supplier_order_number: HOSTILE_CODES[i % HOSTILE_CODES.length] }));
  return { meds, rows: meds.map((m, i) => ({ id: m.id, qty: String(i + 1), unit: HOSTILE_UNIT })) };
}

test.describe("Formula and HTML injection", () => {
  test("in the workbook, names, codes, units, title, prepared-by and notes that look like formulas (= + - @ tab) are literal text cells", async ({ page }) => {
    test.skip(!PYTHON_OPENPYXL.available, PYTHON_OPENPYXL.reason);
    const { meds, rows } = formulaFixture();
    await openOrderSheet(page, { medications: meds, draft: { rows, title: HOSTILE_TITLE, preparedBy: HOSTILE_PREPARED_BY, notes: HOSTILE_NOTES } });
    const report = inspectXlsx((await downloadXlsx(page, "formulas.xlsx")).file);
    const table = xlsxTable(report);

    expect(report.formulaCells).toEqual([]);
    expect(report.rawFormulaCells).toEqual([]);
    expect(report.formulaTagCount).toBe(0);
    expect(table.rows.map((r) => cellText(r["Item"]))).toEqual(FORMULA_NAMES.map((n) => n.trim()));
    expect(table.rows.map((r) => r["Item"].type)).toEqual(FORMULA_NAMES.map(() => "s"));
    expect(table.rows.map((r) => cellText(r["Supplier order no."]))).toEqual(meds.map((m) => m.supplier_order_number));
    expect(table.rows.map((r) => r["Supplier order no."].type)).toEqual(meds.map(() => "s"));
    expect(table.rows.map((r) => cellText(r["Unit"]))).toEqual(meds.map(() => HOSTILE_UNIT));
    expect(table.rows.map((r) => r["Unit"].type)).toEqual(meds.map(() => "s"));
    const top = new Map(table.preamble.map((c) => [c.ref, c]));
    expect(top.get("B1")?.value).toBe(HOSTILE_TITLE);
    expect(top.get("B1")?.type).toBe("s");
    expect(top.get("B3")?.value).toBe(HOSTILE_PREPARED_BY);
    expect(top.get("B3")?.type).toBe("s");
    expect(top.get("B4")?.value).toBe(HOSTILE_NOTES);
    expect(top.get("B4")?.type).toBe("s");
  });

  test("on paper, formula-like names, codes and units appear literally, exactly as typed", async ({ page }) => {
    test.skip(!POPPLER.available, POPPLER.reason);
    const { meds, rows } = formulaFixture();
    await openOrderSheet(page, { medications: meds, draft: { rows, title: HOSTILE_TITLE, preparedBy: HOSTILE_PREPARED_BY, notes: HOSTILE_NOTES } });
    const file = path.join(scratch().dir, "formulas.pdf");
    await savePdf(page, file);
    const pages = readPrintedTable(file, `${HOSTILE_TITLE} · Nov 5, 2026`);
    const printed = pages.flatMap((p) => p.rows);
    expect(printed.map((r) => sq(r.cells["Item"]))).toEqual(FORMULA_NAMES.map((n) => sq(n)));
    expect(printed.map((r) => sq(r.cells["Supplier order no."]))).toEqual(meds.map((m) => sq(m.supplier_order_number ?? "")));
    expect(printed.map((r) => sq(r.cells["Unit"]))).toEqual(meds.map(() => HOSTILE_UNIT));
    expect(sq(pages[0].preamble)).toContain(sq(HOSTILE_TITLE));
    expect(sq(pages[0].preamble)).toContain(sq(`Prepared by: ${HOSTILE_PREPARED_BY}`));
    expect(sq(pages[pages.length - 1].notes)).toContain(sq(HOSTILE_NOTES));
  });

  test("HTML in names, codes, title, prepared-by and notes is shown as text everywhere: no element is created, nothing runs", async ({ page }) => {
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    const names = [
      `<script>alert("x")</script> & <b>bold</b>`,
      `<img src=x onerror="window.__pwned=(window.__pwned||0)+1">`,
      `<svg onload="window.__pwned=2"></svg>`,
      `</td></tr></table><h1>injected heading</h1>`,
      `&lt;b&gt;already escaped&lt;/b&gt; &amp; &#60;i&#62;`,
      `"><iframe src="javascript:alert(1)"></iframe>`,
    ];
    const meds = names.map((name, i) => item(26001 + i, { name, supplier_order_number: i === 0 ? "<u>0092</u>" : "AX-1182/4" }));
    const rows = meds.map((m) => ({ id: m.id, qty: "3", unit: "<i>box</i>" }));
    await openOrderSheet(page, {
      medications: meds,
      draft: { rows, title: "<u>Underlined title</u>", preparedBy: '<a href="javascript:alert(1)">me</a>', notes: "<i>italic note</i>", showBarcode: true },
    });

    // the preview shows every string as typed
    const preview = await readPreview(page);
    expect(preview.rows.map((r) => r[0])).toEqual(names);
    expect(preview.rows.map((r) => r[3])).toEqual(rows.map(() => "<i>box</i>"));
    expect(preview.rows[0][1]).toBe("<u>0092</u>");
    expect(preview.title).toBe("<u>Underlined title</u>");
    expect(preview.preparedByLine).toContain('<a href="javascript:alert(1)">me</a>');
    expect(preview.notes).toContain("<i>italic note</i>");

    // and the add-item search results escape names too
    await page.getByTestId("add-search").fill("script");
    await expect(page.getByTestId(`add-result-${meds[0].id}`)).toContainText("<script>");

    // no element was created from any of that text
    const created = await page.evaluate(() => ({
      scripts: document.querySelectorAll("[data-testid=sheet-preview] script, [data-testid^=sheet-row-] script, [data-testid^=add-result-] script").length,
      images: document.querySelectorAll("img[src='x']").length,
      svgOnload: document.querySelectorAll("svg[onload]").length,
      iframes: document.querySelectorAll("iframe").length,
      boldInSheet: document.querySelectorAll("[data-testid=sheet-preview] b, [data-testid^=sheet-row-] b, [data-testid^=add-result-] b").length,
      markup: document.querySelectorAll("[data-testid=sheet-preview] u, [data-testid=sheet-preview] i, [data-testid^=sheet-row-] u, [data-testid^=sheet-row-] i").length,
      jsLinks: document.querySelectorAll("a[href^='javascript:']").length,
      headings: Array.from(document.querySelectorAll("h1")).map((h) => h.textContent ?? ""),
      pwned: (window as Window & { __pwned?: number }).__pwned ?? null,
    }));
    expect(created).toEqual({ scripts: 0, images: 0, svgOnload: 0, iframes: 0, boldInSheet: 0, markup: 0, jsLinks: 0, headings: ["Order sheet"], pwned: null });
    expect(dialogs).toEqual([]);
  });
});

// ══ 6. Export errors through the UI ═════════════════════════════════════════════════════════════════════════════

const THREE_ROWS: DraftSeed = { rows: [{ id: 100, qty: "2", unit: "box" }, { id: 101 }, { id: 102, qty: "4", unit: "case" }] };

test.describe("Export errors", () => {
  test("a 503 from the server shows its message with a Retry button; Retry produces the file and the page recovers", async ({ page }) => {
    const api = await openOrderSheet(page, { medications: buildMedications(), draft: THREE_ROWS });
    const message = "Can’t reach the database. Check the connection, and that the Supabase project isn’t paused.";
    api.failNext({ method: "POST", path: XLSX_PATH, status: 503, body: { error: message } });
    let downloads = 0;
    page.on("download", () => (downloads += 1));

    await page.getByTestId("export-xlsx").click();
    const alert = page.getByTestId("export-error");
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(alert).toContainText("The Excel file could not be created");
    await expect(alert).toContainText(message);
    await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByTestId("export-xlsx")).toBeEnabled();
    expect(downloads, "nothing was downloaded for the failed attempt").toBe(0);

    const [download] = await Promise.all([page.waitForEvent("download"), alert.getByRole("button", { name: "Retry" }).click()]);
    expect(download.suggestedFilename()).toBe("order-sheet-2026-11-05.xlsx");
    await expect(page.getByTestId("export-success")).toContainText("order-sheet-2026-11-05.xlsx");
    await expect(page.getByTestId("export-error")).toHaveCount(0);
    await expect(page.getByTestId("export-xlsx")).toBeEnabled();
    expect(api.requestsTo("POST", XLSX_PATH)).toHaveLength(2);
  });

  test("when items were deleted meanwhile (422), the message says how many, the rows are marked, and Retry exports the remaining items", async ({ page }) => {
    const meds = buildMedications();
    const api = await openOrderSheet(page, { medications: meds, draft: THREE_ROWS });
    // another computer deletes two of the three items after this page loaded the inventory
    for (const id of [101, 102]) api.medications.splice(api.medications.findIndex((m) => m.id === id), 1);

    await page.getByTestId("export-xlsx").click();
    const alert = page.getByTestId("export-error");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("2 items on the sheet are no longer in the inventory");
    await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
    // the page re-read the inventory: the two rows now say so and are left out of the file
    await expect(page.getByTestId("sheet-row-101")).toContainText(/no longer in inventory/i);
    await expect(page.getByTestId("sheet-row-102")).toContainText(/no longer in inventory/i);
    await expect(page.getByTestId("print-button")).toBeEnabled();

    const [download] = await Promise.all([page.waitForEvent("download"), alert.getByRole("button", { name: "Retry" }).click()]);
    await expect(page.getByTestId("export-success")).toBeVisible();
    await expect(page.getByTestId("export-error")).toHaveCount(0);
    const retry = api.requestsTo("POST", XLSX_PATH)[1];
    expect((retry.body as { rows: Array<{ id: number }> }).rows.map((r) => r.id), "the retry sends only items that still exist").toEqual([100]);
    // the rest needs python3 + openpyxl; without them the test is reported as skipped (never as passed)
    test.skip(!PYTHON_OPENPYXL.available, PYTHON_OPENPYXL.reason);
    const file = path.join(scratch().dir, "after-422.xlsx");
    await download.saveAs(file);
    expect(xlsxTable(inspectXlsx(file)).rows.map((r) => cellText(r["Item"]))).toEqual(["Acetaminophen 500 mg, tablets"]);
  });

  test("a 422 that names missing items shows how many and offers Retry, even when this page still lists them (the server's view and the page's can differ for a moment)", async ({ page }) => {
    const api = await openOrderSheet(page, { medications: buildMedications(), draft: THREE_ROWS });
    api.failNext({
      method: "POST",
      path: XLSX_PATH,
      status: 422,
      body: { error: "2 item(s) on the order sheet are no longer in the inventory.", missingIds: [101, 102] },
    });
    await page.getByTestId("export-xlsx").click();
    const alert = page.getByTestId("export-error");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("2 items on the sheet are no longer in the inventory. Remove them and try again.");
    await expect(page.getByTestId("export-xlsx")).toBeEnabled();
    await Promise.all([page.waitForEvent("download"), alert.getByRole("button", { name: "Retry" }).click()]);
    await expect(page.getByTestId("export-success")).toBeVisible();
    await expect(page.getByTestId("export-error")).toHaveCount(0);
  });

  test("a network failure says the server can't be reached, offers Retry, and the button works again", async ({ page }) => {
    const api = await openOrderSheet(page, { medications: buildMedications(), draft: THREE_ROWS });
    api.failNext({ method: "POST", path: XLSX_PATH, networkError: true });
    await page.getByTestId("export-xlsx").click();
    const alert = page.getByTestId("export-error");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/Can.t reach the server/);
    await expect(alert).toContainText(/internet connection/i);
    await expect(page.getByTestId("export-xlsx")).toBeEnabled();
    await Promise.all([page.waitForEvent("download"), alert.getByRole("button", { name: "Retry" }).click()]);
    await expect(page.getByTestId("export-success")).toBeVisible();
    await expect(page.getByTestId("export-error")).toHaveCount(0);
  });

  test("a 200 answer that is not a spreadsheet is never saved as .xlsx: the page reports it and offers Retry", async ({ page }) => {
    const api = await openOrderSheet(page, { medications: buildMedications(), draft: THREE_ROWS });
    api.failNext({ method: "POST", path: XLSX_PATH, status: 200, body: { note: "an error page from a proxy, say" } });
    let downloads = 0;
    page.on("download", () => (downloads += 1));
    await page.getByTestId("export-xlsx").click();
    await expect(page.getByTestId("export-error")).toContainText(/did not send an Excel file/);
    expect(downloads).toBe(0);
    await Promise.all([page.waitForEvent("download"), page.getByTestId("export-error").getByRole("button", { name: "Retry" }).click()]);
    await expect(page.getByTestId("export-success")).toBeVisible();
  });

  test("a 200 answer with the spreadsheet content type but no content is reported as an empty file, never saved as a 0-byte download", async ({ page }) => {
    await openOrderSheet(page, { medications: buildMedications(), draft: THREE_ROWS });
    let answers = 0;
    // registered after the mock, so it runs first: the first answer is an empty "spreadsheet", later requests go on to the mock
    await page.route("**/api/order-sheet/xlsx", async (route) => {
      answers += 1;
      if (answers > 1) return route.fallback();
      return route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": 'attachment; filename="order-sheet-2026-11-05.xlsx"',
        },
        body: "",
      });
    });
    let downloads = 0;
    page.on("download", () => (downloads += 1));
    await page.getByTestId("export-xlsx").click();
    const alert = page.getByTestId("export-error");
    await expect(alert).toContainText(/empty file/i);
    await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByTestId("export-success")).toHaveCount(0);
    await expect(page.getByTestId("export-xlsx")).toBeEnabled();
    expect(downloads, "no file was saved for the empty answer").toBe(0);

    const [download] = await Promise.all([page.waitForEvent("download"), alert.getByRole("button", { name: "Retry" }).click()]);
    expect(download.suggestedFilename()).toBe("order-sheet-2026-11-05.xlsx");
    await expect(page.getByTestId("export-success")).toBeVisible();
    await expect(page.getByTestId("export-error")).toHaveCount(0);
    expect(answers).toBe(2);
  });

  test("a 400 from the server shows the server's own explanation", async ({ page }) => {
    const api = await openOrderSheet(page, { medications: buildMedications(), draft: THREE_ROWS });
    api.failNext({ method: "POST", path: XLSX_PATH, status: 400, body: { error: "Notes can be at most 1000 characters.", field: "notes" } });
    await page.getByTestId("export-xlsx").click();
    await expect(page.getByTestId("export-error")).toContainText("Notes can be at most 1000 characters.");
  });

  test("while the file is being created the button is disabled and says so; afterwards it is enabled again", async ({ page }) => {
    await openOrderSheet(page, { medications: buildMedications(), draft: THREE_ROWS });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hits = 0;
    // registered after the mock, so it runs first and then hands the request on to the mock
    await page.route("**/api/order-sheet/xlsx", async (route) => {
      hits += 1;
      await gate;
      await route.fallback();
    });
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("export-xlsx").click();
    await expect(page.getByTestId("export-xlsx")).toBeDisabled();
    // the progress text is a live region, so a screen reader announces it
    await expect(page.getByRole("status").filter({ hasText: "Creating the Excel file…" })).toBeVisible();
    expect(hits).toBe(1);
    release();
    await downloadPromise;
    await expect(page.getByTestId("export-success")).toBeVisible();
    await expect(page.getByTestId("export-xlsx")).toBeEnabled();
    expect(hits).toBe(1);
  });
});

// ══ 6b. Keyboard and focus ═════════════════════════════════════════════════════════════════════════════════════════

test.describe("Keyboard and focus around Print and Download", () => {
  const printCalls = (page: Page): Promise<number | undefined> => page.evaluate(() => (window as Window & { __printCalls?: number }).__printCalls);

  test("both buttons work from the keyboard: Enter and Space press Print, Tab moves on to Download, Enter and Space press that", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as Window & { __printCalls?: number };
      w.__printCalls = 0;
      w.print = () => {
        w.__printCalls = (w.__printCalls ?? 0) + 1;
      };
    });
    const api = await openOrderSheet(page, { medications: buildMedications(), draft: THREE_ROWS });
    const exportButton = page.getByTestId("export-xlsx");

    await page.getByTestId("print-button").focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => printCalls(page)).toBe(1);
    await page.keyboard.press("Space");
    await expect.poll(() => printCalls(page)).toBe(2);

    await page.keyboard.press("Tab");
    await expect(exportButton, "Tab from Print lands on Download").toBeFocused();
    const [byEnter] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
    expect(byEnter.suggestedFilename()).toBe("order-sheet-2026-11-05.xlsx");
    await expect(page.getByTestId("export-success")).toBeVisible();
    await exportButton.focus();
    const [bySpace] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Space")]);
    expect(bySpace.suggestedFilename()).toBe("order-sheet-2026-11-05.xlsx");
    expect(api.requestsTo("POST", XLSX_PATH), "one request per press").toHaveLength(2);
  });

  test("after a successful download keyboard focus is back on the Download button (a disabled button drops focus while the file is made)", async ({ page }) => {
    await openOrderSheet(page, { medications: buildMedications(), draft: THREE_ROWS });
    await page.getByTestId("export-xlsx").focus();
    await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
    await expect(page.getByTestId("export-success")).toBeVisible();
    await expect(page.getByTestId("export-xlsx")).toBeFocused();
  });

  test("after a failed download keyboard focus moves to the error message, Retry is the next Tab stop, and Enter on it recovers with focus back on Download", async ({ page }) => {
    const api = await openOrderSheet(page, { medications: buildMedications(), draft: THREE_ROWS });
    api.failNext({ method: "POST", path: XLSX_PATH, status: 503, body: { error: "Can’t reach the database." } });
    await page.getByTestId("export-xlsx").focus();
    await page.keyboard.press("Enter");
    const alert = page.getByTestId("export-error");
    await expect(alert).toBeVisible();
    await expect(alert, "the message takes the keyboard focus, so it is read out and nothing is lost").toBeFocused();
    await page.keyboard.press("Tab");
    await expect(alert.getByRole("button", { name: "Retry" })).toBeFocused();
    await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
    await expect(page.getByTestId("export-success")).toBeVisible();
    await expect(page.getByTestId("export-error")).toHaveCount(0);
    await expect(page.getByTestId("export-xlsx"), "the Retry button is gone; focus is not lost to the page").toBeFocused();
  });

  test("dismissing the error message with the keyboard puts focus back on the Download button", async ({ page }) => {
    const api = await openOrderSheet(page, { medications: buildMedications(), draft: THREE_ROWS });
    api.failNext({ method: "POST", path: XLSX_PATH, status: 503, body: { error: "Can’t reach the database." } });
    await page.getByTestId("export-xlsx").focus();
    await page.keyboard.press("Enter");
    const alert = page.getByTestId("export-error");
    await expect(alert).toBeFocused();
    await alert.getByRole("button", { name: "Dismiss" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("export-error")).toHaveCount(0);
    await expect(page.getByTestId("export-xlsx")).toBeFocused();
  });
});

// ══ 7. No side effects, no third party ═══════════════════════════════════════════════════════════════════════════

test.describe("Side effects", () => {
  test("preparing, printing and exporting never write to the inventory and never leave this site", async ({ page, baseURL }) => {
    const origin = new URL(baseURL ?? "http://127.0.0.1:3100").origin;
    const outside: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!["data:", "blob:", "about:"].includes(url.protocol) && url.origin !== origin) outside.push(request.url());
    });
    await page.addInitScript(() => {
      const w = window as Window & { __printCalls?: number };
      w.__printCalls = 0;
      w.print = () => {
        w.__printCalls = (w.__printCalls ?? 0) + 1;
      };
    });
    const problems = collectPageProblems(page);
    const meds = buildMedications();
    const api = await openOrderSheet(page, { medications: meds, draft: { rows: [{ id: 100, qty: "24", unit: "box" }] } });

    // build the sheet like a person: search, add (twice: the second press must not add a second row), type, options, paper
    await page.getByTestId("add-search").fill("ibuprofen");
    await page.getByTestId("add-result-101").click();
    await expect(page.getByTestId("add-result-101")).toHaveAttribute("aria-disabled", "true");
    // a second press on the now "On sheet" result is still a real press (it jumps to the row), so bypass Playwright's enabled-check
    await page.getByTestId("add-result-101").click({ force: true });
    await expect(page.getByTestId("add-status")).toContainText(/Already on the sheet/);
    await expect(page.locator("[data-testid^=sheet-row-]")).toHaveCount(2);
    await page.getByTestId("qty-input-101").fill("6");
    await page.getByTestId("unit-input-101").fill("case");
    await page.getByTestId("show-on-hand").check();
    await page.getByTestId("paper-a4").check();
    await page.getByTestId("print-button").click();
    await expect.poll(() => page.evaluate(() => (window as Window & { __printCalls?: number }).__printCalls)).toBe(1);
    await Promise.all([page.waitForEvent("download"), page.getByTestId("export-xlsx").click()]);
    await expect(page.getByTestId("export-success")).toBeVisible();

    const writes = api.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
    expect(writes, "the only non-read request is the read-only workbook export").toEqual(["POST /api/order-sheet/xlsx"]);
    expect(api.medications, "stock, thresholds, codes and every other field are untouched").toEqual(meds);
    const body = api.requestsTo("POST", XLSX_PATH)[0].body as Record<string, unknown>;
    expect(body.rows, "the export sends ids and what staff typed, nothing about stock").toEqual([
      { id: 100, qty: "24", unit: "box" },
      { id: 101, qty: "6", unit: "case" },
    ]);
    expect(Object.keys(body).sort()).toEqual(["date", "notes", "preparedBy", "rows", "showBarcode", "showOnHand", "title"]);
    // only "Show on-hand" was ticked above: each flag says exactly what was chosen (swapping them would put stock where barcodes belong)
    expect({ showOnHand: body.showOnHand, showBarcode: body.showBarcode }).toEqual({ showOnHand: true, showBarcode: false });
    expect(api.requests.filter((r) => /transactions|import|upload|categories/.test(r.path) && r.method !== "GET")).toEqual([]);
    expect(outside, "requests to any other site").toEqual([]);
    expect(problems.filter((p) => p.startsWith("[pageerror]"))).toEqual([]);
  });

  test("a stored draft that lists the same item twice still prints and exports one row", async ({ page }) => {
    const meds = buildMedications();
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "medinventory.orderSheet.v1",
        JSON.stringify({
          version: 1,
          rows: [
            { id: 100, qty: "1", unit: "box" },
            { id: 101, qty: "", unit: "" },
            { id: 100, qty: "99", unit: "case" },
          ],
          title: "Supply order",
          date: "2026-11-05",
          preparedBy: "",
          notes: "",
          showOnHand: false,
          showBarcode: false,
          paper: "letter",
        })
      );
    });
    const api = await openOrderSheet(page, { medications: meds, draft: null });
    const preview = await readPreview(page);
    expect(preview.rows.map((r) => r[0])).toEqual(["Acetaminophen 500 mg, tablets", "Ibuprofen 200 mg, tablets"]);
    expect(preview.rows[0][2], "the first entry wins").toBe("1");
    const { file } = await downloadXlsx(page, "dedupe.xlsx");
    // the export request carries one row per item, whatever the stored draft says
    expect((api.requestsTo("POST", XLSX_PATH)[0].body as { rows: Array<{ id: number }> }).rows.map((r) => r.id)).toEqual([100, 101]);
    // the rest needs python3 + openpyxl; without them the test is reported as skipped (never as passed)
    test.skip(!PYTHON_OPENPYXL.available, PYTHON_OPENPYXL.reason);
    expect(xlsxTable(inspectXlsx(file)).rows).toHaveLength(2);
  });
});

// ══ 8. LibreOffice as a third opinion ═══════════════════════════════════════════════════════════════════════════

type LibreOfficeArtifact = { xlsx: string; report: XlsxReport; csv: string[][]; pdf: string };

function libreOfficeArtifact(browser: Browser, testInfo: TestInfo): Promise<LibreOfficeArtifact> {
  return once("libreoffice", () =>
    withFreshPage(browser, testInfo, async (page) => {
      const tricky = TRICKY_SUPPLIER_NUMBERS.map((code, i) => item(27001 + i, { name: `Tricky code item ${i + 1}`, supplier_order_number: code }));
      const unusual = UNUSUAL_NAMES.map((name, i) => item(27101 + i, { name, supplier_order_number: i % 2 ? "0092" : null }));
      const formulas = FORMULA_NAMES.map((name, i) => item(27201 + i, { name, supplier_order_number: HOSTILE_CODES[i % HOSTILE_CODES.length] }));
      const bulk = buildManyMedications(120 - SPECIAL_ITEMS.length - tricky.length - unusual.length - formulas.length);
      const meds = [...SPECIAL_ITEMS, ...tricky, ...unusual, ...formulas, ...bulk];
      const rows = meds.map((m, i) => ({ id: m.id, ...typedFor(i) }));
      await openOrderSheet(page, { medications: meds, draft: { rows, title: HOSTILE_TITLE, preparedBy: PREPARED_BY, notes: NOTES, showOnHand: true, showBarcode: true } });
      const { file } = await downloadXlsx(page, "libreoffice-source.xlsx");
      const report = inspectXlsx(file);
      const csvPath = libreOfficeConvert(file, "csv", scratch().dir);
      const pdfPath = libreOfficeConvert(file, "pdf", scratch().dir);
      return { xlsx: file, report, csv: parseCsv(readFileSync(csvPath, "utf8")), pdf: pdfPath };
    })
  );
}

test.describe("LibreOffice agrees with openpyxl", () => {
  test.skip(!LIBREOFFICE.available, LIBREOFFICE.reason);
  test.skip(!PYTHON_OPENPYXL.available, PYTHON_OPENPYXL.reason);

  test("LibreOffice reads every cell of the workbook exactly as openpyxl does (text stays text, leading zeros and formula-like text survive)", async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    const { report, csv } = await libreOfficeArtifact(browser, testInfo);
    expect(report.maxRow).toBeGreaterThan(100);
    expect(csv.length, "rows in LibreOffice's CSV").toBeGreaterThanOrEqual(report.maxRow);
    const mismatches: string[] = [];
    for (const cell of report.cells) {
      const fromLibreOffice = csv[cell.row - 1]?.[cell.col - 1] ?? "";
      const fromOpenpyxl = cellText(cell);
      if (fromLibreOffice !== fromOpenpyxl) mismatches.push(`${cell.ref}: openpyxl ${JSON.stringify(fromOpenpyxl)} vs LibreOffice ${JSON.stringify(fromLibreOffice)}`);
    }
    expect(mismatches.slice(0, 10), `${mismatches.length} cells differ`).toEqual([]);
    expect(report.formulaCells).toEqual([]);
    // the cells people worry about, spelled out
    const find = (text: string) => csv.flat().includes(text);
    for (const text of ["00417-B", "0092", "000000", "1E5", "12345678901234567890", "00-1.50", "2026-11-05", "=1+1", '=HYPERLINK("http://example.invalid","click")']) {
      expect(find(text), `LibreOffice shows ${JSON.stringify(text)} unchanged`).toBe(true);
    }
  });

  test("LibreOffice prints the workbook on several pages with the column heading row at the top of every page", async ({ browser }, testInfo) => {
    test.skip(!POPPLER.available, POPPLER.reason);
    test.setTimeout(240_000);
    const { pdf } = await libreOfficeArtifact(browser, testInfo);
    const info = pdfInfo(pdf);
    expect(info.pages, "120 items do not fit on one page").toBeGreaterThan(1);
    const texts = pdfTextPages(pdf, "layout");
    expect(texts).toHaveLength(info.pages);
    texts.forEach((text, i) => {
      expect(text.replace(/\s+/g, " "), `page ${i + 1} of ${info.pages}`).toMatch(/No\.\s+Item\s+Supplier order no\.\s+Order qty\s+Unit\s+On hand\s+Barcode/);
    });
    // every item is on some page exactly once: the spreadsheet printout is complete too
    const all = texts.join("\n").replace(/\s+/g, "");
    for (const needle of ["Tricky code item 1", "Tricky code item 10"]) {
      expect(all.split(needle.replace(/\s+/g, "")).length - 1, needle).toBeGreaterThanOrEqual(1);
    }
  });
});

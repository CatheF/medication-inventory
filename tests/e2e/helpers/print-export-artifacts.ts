// Helpers for tests/e2e/print-and-export.spec.ts that look at REAL generated artifacts with tools that are independent
// of the application: poppler (pdfinfo / pdftotext / pdftoppm) for PDFs, python3 + openpyxl (plus the raw XML) for the
// .xlsx workbook and LibreOffice (soffice --headless) for a third opinion. Nothing here imports application code.
//
// Every tool is probed once; a spec skips (with the tool's name in the reason) instead of passing vacuously when one
// is missing. Synthetic data only.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HELPERS_DIR = typeof __dirname === "string" ? __dirname : path.resolve(process.cwd(), "tests/e2e/helpers");
const INSPECT_SCRIPT = path.join(HELPERS_DIR, "print-export-inspect-xlsx.py");

// ── Tool availability ────────────────────────────────────────────────────────────────────────────────────────────

export type Tool = { available: boolean; reason: string };

function runs(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

function probeTool(reasonWhenMissing: string, checks: Array<[string, string[]]>): Tool {
  const ok = checks.every(([command, args]) => runs(command, args));
  return { available: ok, reason: ok ? "" : reasonWhenMissing };
}

export const POPPLER: Tool = probeTool("poppler-utils (pdfinfo, pdftotext, pdftoppm) is not installed or not on PATH", [
  ["pdfinfo", ["-v"]],
  ["pdftotext", ["-v"]],
  ["pdftoppm", ["-v"]],
]);

export const PYTHON_OPENPYXL: Tool = probeTool("python3 with the openpyxl module is not installed or not on PATH", [
  ["python3", ["-I", "-c", "import openpyxl"]],
]);

export const LIBREOFFICE: Tool = probeTool("LibreOffice (soffice) is not installed or not on PATH", [["soffice", ["--version"]]]);

function run(command: string, args: string[], timeoutMs = 120_000): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
}

// ── Scratch space ────────────────────────────────────────────────────────────────────────────────────────────────

/** A private temp directory for generated files. Set KEEP_PRINT_EXPORT_ARTIFACTS=1 to keep the files for inspection. */
export function makeScratch(label: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), `print-export-${label}-`));
  return {
    dir,
    cleanup: () => {
      if (process.env.KEEP_PRINT_EXPORT_ARTIFACTS) return;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ── PDF (poppler) ────────────────────────────────────────────────────────────────────────────────────────────────

export type PdfInfo = { pages: number; sizes: Array<{ width: number; height: number }> };

/** Page count and the size (in points) of EVERY page. */
export function pdfInfo(file: string): PdfInfo {
  const head = run("pdfinfo", [file]);
  const pages = Number(/^Pages:\s+(\d+)/m.exec(head)?.[1] ?? Number.NaN);
  if (!Number.isFinite(pages) || pages < 1) throw new Error(`pdfinfo reported no pages for ${file}:\n${head}`);
  const detail = run("pdfinfo", ["-f", "1", "-l", String(pages), file]);
  const sizes = [...detail.matchAll(/^Page\s+\d+ size:\s+([\d.]+) x ([\d.]+) pts/gm)].map((m) => ({ width: Number(m[1]), height: Number(m[2]) }));
  return { pages, sizes };
}

/** The text of each page (pdftotext), one string per page. "layout" keeps columns apart; "raw" keeps content order. */
export function pdfTextPages(file: string, mode: "layout" | "raw"): string[] {
  const out = run("pdftotext", [mode === "layout" ? "-layout" : "-raw", file, "-"]);
  const parts = out.split("\f");
  parts.pop(); // pdftotext ends every page, including the last, with a form feed
  return parts;
}

export type PdfWord = { text: string; x0: number; y0: number; x1: number; y1: number };
export type PdfPageWords = { width: number; height: number; words: PdfWord[] };

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Every word with its bounding box in points (pdftotext -bbox), page by page. */
export function pdfWords(file: string): PdfPageWords[] {
  const html = run("pdftotext", ["-bbox", file, "-"]);
  const pages: PdfPageWords[] = [];
  let current: PdfPageWords | null = null;
  for (const line of html.split("\n")) {
    const pageMatch = /<page width="([\d.]+)" height="([\d.]+)">/.exec(line);
    if (pageMatch) {
      current = { width: Number(pageMatch[1]), height: Number(pageMatch[2]), words: [] };
      pages.push(current);
      continue;
    }
    const wordMatch = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*)<\/word>/.exec(line);
    if (wordMatch && current) {
      current.words.push({
        x0: Number(wordMatch[1]),
        y0: Number(wordMatch[2]),
        x1: Number(wordMatch[3]),
        y1: Number(wordMatch[4]),
        text: decodeEntities(wordMatch[5]),
      });
    }
  }
  return pages;
}

/** 14 mm, the page margin the order sheet asks for with @page { margin: 14mm }, in points. */
export const PAGE_MARGIN_PT = (14 / 25.4) * 72;

export type PrintedRow = { cells: Record<string, string> };
export type PrintedPage = {
  page: number;
  width: number;
  height: number;
  /** text above the column headings (title, date, prepared by); only page 1 has any */
  preamble: string;
  /** the column headings found on this page, in order; empty when the page has no heading row */
  headings: string[];
  rows: PrintedRow[];
  /** the sheet footer line(s) printed under the rows ("title · date") */
  footer: string;
  /** "Notes to supplier: ..." when this page carries the notes row */
  notes: string;
  /** every word that is not inside the page margins (x/y outside the printable area) */
  wordsOutsideMargins: PdfWord[];
  /** pairs of words whose boxes overlap each other: text that spilled into a neighbour */
  overlappingWords: Array<[PdfWord, PdfWord]>;
  /** words (in the item rows) that extend past the right edge of their own column */
  wordsPastColumn: PdfWord[];
};

const HEADING_LABELS: Array<{ label: string; first: string }> = [
  { label: "Item", first: "Item" },
  { label: "Supplier order no.", first: "Supplier" },
  { label: "Order qty", first: "Order" },
  { label: "Unit", first: "Unit" },
  { label: "On hand", first: "On" },
  { label: "Barcode", first: "Barcode" },
];

function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

function joinCell(words: PdfWord[]): string {
  return [...words].sort((a, b) => (Math.abs(a.y0 - b.y0) > 3 ? a.y0 - b.y0 : a.x0 - b.x0)).map((w) => w.text).join(" ");
}

/**
 * Reads the printed item table back out of a PDF from the word boxes (pdftotext -bbox): which words sit in which column
 * of which row, whatever the paper size or number of columns. Rows are found by the vertical gaps between lines, columns
 * by the left edge of each column heading. `footerText` is the exact footer line the sheet prints under the rows.
 */
export function readPrintedTable(file: string, footerText: string): PrintedPage[] {
  const pages = pdfWords(file);
  const squashedFooter = squash(footerText);
  return pages.map((p, index): PrintedPage => {
    const marginOk = (w: PdfWord) => w.x0 >= PAGE_MARGIN_PT - 1 && w.x1 <= p.width - PAGE_MARGIN_PT + 1 && w.y0 >= PAGE_MARGIN_PT - 1 && w.y1 <= p.height - PAGE_MARGIN_PT + 1;
    // The "Page N of M" margin box lives in the bottom margin; it is neither a row nor a spill.
    const inBottomMargin = (w: PdfWord) => w.y0 >= p.height - PAGE_MARGIN_PT + 1;
    const content = p.words.filter((w) => !inBottomMargin(w));
    const wordsOutsideMargins = content.filter((w) => !marginOk(w));

    const overlappingWords: Array<[PdfWord, PdfWord]> = [];
    const byY = [...content].sort((a, b) => a.y0 - b.y0);
    for (let i = 0; i < byY.length; i += 1) {
      for (let j = i + 1; j < byY.length && byY[j].y0 < byY[i].y1; j += 1) {
        const a = byY[i];
        const b = byY[j];
        const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (overlapX > 0.8 && overlapY > 2) overlappingWords.push([a, b]);
      }
    }

    // clusters of words: a new cluster starts when the next word starts clearly below everything so far in the cluster
    const clusters: PdfWord[][] = [];
    let bottom = -Infinity;
    for (const word of byY) {
      if (clusters.length === 0 || word.y0 - bottom > 7) {
        clusters.push([word]);
        bottom = word.y1;
      } else {
        clusters[clusters.length - 1].push(word);
        bottom = Math.max(bottom, word.y1);
      }
    }

    const headingIndex = clusters.findIndex((c) => c.some((w) => w.text === "Supplier") && c.some((w) => w.text === "Unit"));
    const preamble = headingIndex > 0 ? clusters.slice(0, headingIndex).map((c) => joinCell(c)).join("\n") : headingIndex === -1 ? clusters.map((c) => joinCell(c)).join("\n") : "";

    let headings: string[] = [];
    const lefts: Array<{ label: string; left: number }> = [];
    if (headingIndex >= 0) {
      const header = clusters[headingIndex];
      for (const { label, first } of HEADING_LABELS) {
        const candidates = header.filter((w) => w.text === first);
        if (candidates.length === 0) continue;
        const word = label === "Order qty" ? candidates.sort((a, b) => b.x0 - a.x0)[0] : candidates.sort((a, b) => a.x0 - b.x0)[0];
        lefts.push({ label, left: word.x0 });
      }
      lefts.sort((a, b) => a.left - b.left);
      headings = lefts.map((l) => l.label);
    }

    const columnOf = (w: PdfWord): number => {
      let found = 0;
      for (let i = 0; i < lefts.length; i += 1) if (lefts[i].left <= w.x0 + 2) found = i;
      return found;
    };

    const rows: PrintedRow[] = [];
    const wordsPastColumn: PdfWord[] = [];
    let footer = "";
    let notes = "";
    if (headingIndex >= 0) {
      for (const cluster of clusters.slice(headingIndex + 1)) {
        const text = joinCell(cluster);
        if (squash(text).startsWith("Notestosupplier:")) {
          notes = text;
          continue;
        }
        if (squash(text) === squashedFooter) {
          footer = text;
          continue;
        }
        const cells: Record<string, string> = {};
        const perColumn: PdfWord[][] = lefts.map(() => []);
        for (const w of cluster) perColumn[columnOf(w)].push(w);
        lefts.forEach((l, i) => {
          cells[l.label] = joinCell(perColumn[i]);
          const limit = i + 1 < lefts.length ? lefts[i + 1].left - 1 : p.width - PAGE_MARGIN_PT + 1;
          for (const w of perColumn[i]) if (w.x1 > limit) wordsPastColumn.push(w);
        });
        rows.push({ cells });
      }
    }
    return { page: index + 1, width: p.width, height: p.height, preamble, headings, rows, footer, notes, wordsOutsideMargins, overlappingWords, wordsPastColumn };
  });
}

export type Raster = { width: number; height: number; channels: 1 | 3; data: Buffer };

function parsePnm(buffer: Buffer): Raster {
  let pos = 0;
  const token = (): string => {
    for (;;) {
      while (pos < buffer.length && /\s/.test(String.fromCharCode(buffer[pos]))) pos += 1;
      if (buffer[pos] === 0x23) {
        while (pos < buffer.length && buffer[pos] !== 0x0a) pos += 1; // comment line
        continue;
      }
      break;
    }
    const start = pos;
    while (pos < buffer.length && !/\s/.test(String.fromCharCode(buffer[pos]))) pos += 1;
    return buffer.toString("latin1", start, pos);
  };
  const magic = token();
  const width = Number(token());
  const height = Number(token());
  const maxValue = Number(token());
  pos += 1; // exactly one whitespace byte separates the header from the pixel data
  if ((magic !== "P5" && magic !== "P6") || maxValue !== 255) throw new Error(`Unexpected image format ${magic} (max ${maxValue})`);
  const channels = magic === "P5" ? 1 : 3;
  const data = buffer.subarray(pos, pos + width * height * channels);
  if (data.length !== width * height * channels) throw new Error("Truncated image data from pdftoppm");
  return { width, height, channels, data };
}

/** One page rasterised by pdftoppm (grayscale PGM or colour PPM). */
export function renderPage(file: string, pageNumber: number, options: { dpi: number; gray: boolean; dir: string }): Raster {
  const prefix = path.join(options.dir, `page-${pageNumber}-${options.gray ? "gray" : "color"}-${options.dpi}`);
  run("pdftoppm", ["-r", String(options.dpi), "-f", String(pageNumber), "-l", String(pageNumber), "-singlefile", ...(options.gray ? ["-gray"] : []), file, prefix]);
  return parsePnm(readFileSync(prefix + (options.gray ? ".pgm" : ".ppm")));
}

export type RasterStats = {
  pixels: number;
  /** pixels that are not (nearly) white: ink, borders, anti-aliased edges */
  markedPixels: number;
  /** pixels whose red, green and blue differ by more than the tolerance: colour that a black-and-white printer would turn into gray */
  chromaticPixels: number;
};

export function rasterStats(raster: Raster, chromaTolerance = 10): RasterStats {
  const { width, height, channels, data } = raster;
  let marked = 0;
  let chromatic = 0;
  for (let i = 0; i < width * height; i += 1) {
    if (channels === 1) {
      if (data[i] < 230) marked += 1;
    } else {
      const r = data[i * 3];
      const g = data[i * 3 + 1];
      const b = data[i * 3 + 2];
      if (0.299 * r + 0.587 * g + 0.114 * b < 230) marked += 1;
      if (Math.max(r, g, b) - Math.min(r, g, b) > chromaTolerance) chromatic += 1;
    }
  }
  return { pixels: width * height, markedPixels: marked, chromaticPixels: chromatic };
}

// ── XLSX (python3 + openpyxl + raw XML) ──────────────────────────────────────────────────────────────────────────

export type XlsxCell = {
  ref: string;
  row: number;
  col: number;
  value: string | number | boolean | null | { __repr__: string; __iso__: string | null };
  /** openpyxl data_type: n numeric, s string, f formula, b boolean, d date, e error */
  type: string;
  format: string;
  bold: boolean;
  wrap: boolean;
};

export type XlsxReport = {
  zipEntries: string[];
  sheetXmlCount: number;
  rawFormulaCells: string[];
  rawCellTypes: Record<string, string | null>;
  formulaTagCount: number;
  sheetNames: string[];
  freezePanes: string | null;
  maxRow: number;
  maxCol: number;
  printTitleRows: string | null;
  orientation: string | null;
  fitToWidth: number | null;
  fitToHeight: number | null;
  fitToPage: boolean;
  columnWidths: Record<string, number | null>;
  cells: XlsxCell[];
  formulaCells: string[];
};

export function inspectXlsx(file: string): XlsxReport {
  return JSON.parse(run("python3", ["-I", INSPECT_SCRIPT, file])) as XlsxReport;
}

export function cellAt(report: XlsxReport, ref: string): XlsxCell {
  const found = report.cells.find((c) => c.ref === ref);
  if (!found) throw new Error(`No cell ${ref} in the workbook (size ${report.maxRow} x ${report.maxCol})`);
  return found;
}

/** The text of a cell as a person sees it in the file (numbers become their decimal text, blank becomes ""). */
export function cellText(cell: XlsxCell): string {
  if (cell.value === null) return "";
  if (typeof cell.value === "object") return cell.value.__iso__ ?? cell.value.__repr__;
  return String(cell.value);
}

export type XlsxTable = {
  headerRow: number;
  headers: string[];
  rows: Array<Record<string, XlsxCell>>;
  /** the cells above the header: title, date, prepared by, notes */
  preamble: XlsxCell[];
};

/** Splits the workbook into the preamble (rows above the header) and the item table (header row = "No." | "Item" | ...). */
export function xlsxTable(report: XlsxReport): XlsxTable {
  const headerCell = report.cells.find((c) => c.col === 1 && c.value === "No.");
  if (!headerCell) throw new Error('No header row found: no cell in column A says "No."');
  const headerRow = headerCell.row;
  const headerCells = report.cells.filter((c) => c.row === headerRow && c.value !== null);
  const headers = headerCells.map((c) => cellText(c));
  const rows: Array<Record<string, XlsxCell>> = [];
  for (let r = headerRow + 1; r <= report.maxRow; r += 1) {
    const entry: Record<string, XlsxCell> = {};
    for (const header of headerCells) {
      entry[cellText(header)] = cellAt(report, `${columnLetter(header.col)}${r}`);
    }
    rows.push(entry);
  }
  return { headerRow, headers, rows, preamble: report.cells.filter((c) => c.row < headerRow && c.value !== null) };
}

function columnLetter(col: number): string {
  let n = col;
  let letters = "";
  while (n > 0) {
    const rest = (n - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

// ── LibreOffice ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Converts a workbook with a headless LibreOffice. Uses a private profile directory so it never clashes with another
 * soffice process on the machine. Returns the path of the converted file.
 */
export function libreOfficeConvert(input: string, format: "csv" | "pdf", outDir: string): string {
  const profile = mkdtempSync(path.join(tmpdir(), "print-export-lo-profile-"));
  try {
    const filter = format === "csv" ? "csv:Text - txt - csv (StarCalc):44,34,76,1" : "pdf";
    run(
      "soffice",
      [`-env:UserInstallation=file://${profile}`, "--headless", "--norestore", "--nolockcheck", "--nodefault", "--convert-to", filter, "--outdir", outDir, input],
      240_000
    );
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  return path.join(outDir, `${path.basename(input, path.extname(input))}.${format}`);
}

/** RFC 4180 CSV: quoted fields, doubled quotes, line breaks inside quotes, CRLF or LF row ends. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < source.length) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
    } else if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && source[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

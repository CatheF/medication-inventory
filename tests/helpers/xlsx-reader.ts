// A small reader for the .xlsx files the order-sheet export produces. Test support only (synthetic data, no network).
//
// It unzips the package with `fflate` (already a dev dependency) and reads just enough of the SpreadsheetML parts to
// answer the questions the export tests ask: which sheets exist, what text/number is in a cell, is the cell a string or
// a formula, which number format does it carry ("@" = text, so "0092" stays "0092" when a person edits the cell), and how
// it is dressed for paper (bold font, wrapped text, column widths).
//
// It is deliberately independent of the code under test (nothing is imported from lib/ or app/). Its reading of a real
// export is cross-checked against openpyxl (tests/api/order-sheet-export-file.test.ts does that on every run when
// python3 + openpyxl are installed).
import { strFromU8, unzipSync } from "fflate";

export type XlsxCellType =
  | "shared-string" // t="s": text held in xl/sharedStrings.xml
  | "inline-string" // t="inlineStr": text held in the cell itself
  | "formula-string" // t="str": the cached text RESULT of a formula
  | "number" // no t attribute, or t="n"
  | "boolean"
  | "error"
  | "empty"; // a styled cell with no value

export type XlsxCell = {
  /** A1-style reference, e.g. "C7" */
  ref: string;
  /** 1-based row number */
  row: number;
  /** 1-based column number (A = 1) */
  column: number;
  type: XlsxCellType;
  /** Text of a string cell, the stored number text of a numeric cell, null when the cell is empty */
  text: string | null;
  /** True when the cell XML carries an <f> (formula) element */
  hasFormula: boolean;
  /** Number format code of the cell's style: "@" is text, "General" is the default */
  format: string;
  /** True when the cell's font is bold */
  bold: boolean;
  /** True when the cell's text wraps inside the cell instead of running out of it */
  wrap: boolean;
};

export type XlsxTable = {
  /** 1-based row number of the header row (the row whose first cell reads "No.") */
  headerRow: number;
  headers: string[];
  /** One entry per data row below the header, keyed by header text */
  rows: Array<Record<string, XlsxCell | undefined>>;
};

export type XlsxSheet = {
  name: string;
  /** The raw worksheet XML */
  xml: string;
  cells: XlsxCell[];
  cell(ref: string): XlsxCell | undefined;
  /** Column width in characters by 1-based column number, from the <cols> element (a column without an entry is absent) */
  columnWidths(): Record<number, number>;
  /** "Title" -> "Supply order", ... : the label/value pairs above the table (column A label, column B value) */
  meta(): Record<string, string>;
  table(): XlsxTable;
};

export type XlsxWorkbook = {
  /** Every file in the package, decoded as UTF-8 text (binary parts are decoded too; only XML parts matter here) */
  parts: Record<string, string>;
  /** Names of all files in the package */
  partNames: string[];
  sheets: XlsxSheet[];
  sheet(name: string): XlsxSheet;
};

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g;

function decodeXml(text: string): string {
  return text.replace(ENTITY_RE, (_whole, body: string) => {
    switch (body) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code = body.startsWith("#x") ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return String.fromCodePoint(code);
      }
    }
  });
}

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes);
  return match ? decodeXml(match[1]) : null;
}

/** "C7" -> { column: 3, row: 7 } */
function splitRef(ref: string): { column: number; row: number } {
  const match = /^([A-Z]+)([0-9]+)$/.exec(ref);
  if (!match) throw new Error(`xlsx-reader: unexpected cell reference "${ref}"`);
  let column = 0;
  for (const letter of match[1]) column = column * 26 + (letter.charCodeAt(0) - 64);
  return { column, row: Number(match[2]) };
}

/** All text of one <si> / <is> element: every <t> run, concatenated (rich-text runs included). */
function textOfStringItem(xml: string): string {
  let out = "";
  const runs = /<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let match: RegExpExecArray | null;
  while ((match = runs.exec(xml)) !== null) out += decodeXml(match[1] ?? "");
  return out;
}

function readSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const items: string[] = [];
  const re = /<si(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/si>)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) items.push(textOfStringItem(match[1] ?? ""));
  return items;
}

/** Number format code for each cellXfs entry (index = the cell's `s` attribute). */
function readFormats(stylesXml: string | undefined): string[] {
  if (!stylesXml) return [];
  const builtIn: Record<string, string> = { "0": "General", "1": "0", "2": "0.00", "49": "@" };
  const custom: Record<string, string> = {};
  const numFmt = /<numFmt\s[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = numFmt.exec(stylesXml)) !== null) {
    const id = attribute(match[0], "numFmtId");
    const code = attribute(match[0], "formatCode");
    if (id !== null && code !== null) custom[id] = code;
  }
  const cellXfsBlock = /<cellXfs[\s\S]*?<\/cellXfs>/.exec(stylesXml)?.[0] ?? "";
  const formats: string[] = [];
  const xf = /<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g;
  while ((match = xf.exec(cellXfsBlock)) !== null) {
    const id = attribute(match[1], "numFmtId") ?? "0";
    formats.push(custom[id] ?? builtIn[id] ?? `numFmt#${id}`);
  }
  return formats;
}

type StyleFlags = { bold: boolean; wrap: boolean };

/** Bold and wrap flags for each cellXfs entry (index = the cell's `s` attribute). */
function readStyleFlags(stylesXml: string | undefined): StyleFlags[] {
  if (!stylesXml) return [];
  const fontsBlock = /<fonts[\s\S]*?<\/fonts>/.exec(stylesXml)?.[0] ?? "";
  const bold: boolean[] = [];
  const font = /<font\b[^>]*?(?:\/>|>([\s\S]*?)<\/font>)/g;
  let match: RegExpExecArray | null;
  while ((match = font.exec(fontsBlock)) !== null) {
    const inner = match[1] ?? "";
    bold.push(/<b\s*\/>|<b>|<b\s+val="(?:1|true)"\s*\/>/.test(inner));
  }
  const cellXfsBlock = /<cellXfs[\s\S]*?<\/cellXfs>/.exec(stylesXml)?.[0] ?? "";
  const flags: StyleFlags[] = [];
  const xf = /<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g;
  while ((match = xf.exec(cellXfsBlock)) !== null) {
    const fontId = Number(attribute(match[1], "fontId") ?? "0");
    const wrapAttribute = /<alignment\b[^>]*\swrapText="([^"]*)"/.exec(match[2] ?? "")?.[1];
    flags.push({ bold: bold[fontId] ?? false, wrap: wrapAttribute === "1" || wrapAttribute === "true" });
  }
  return flags;
}

function readColumnWidths(sheetXml: string): Record<number, number> {
  const widths: Record<number, number> = {};
  const colsBlock = /<cols>[\s\S]*?<\/cols>/.exec(sheetXml)?.[0] ?? "";
  const col = /<col\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = col.exec(colsBlock)) !== null) {
    const min = Number(attribute(match[1], "min"));
    const max = Number(attribute(match[1], "max"));
    const width = Number(attribute(match[1], "width"));
    if (!Number.isInteger(min) || !Number.isInteger(max) || !Number.isFinite(width)) continue;
    for (let column = min; column <= max; column += 1) widths[column] = width;
  }
  return widths;
}

function readCells(sheetXml: string, shared: string[], formats: string[], styleFlags: StyleFlags[]): XlsxCell[] {
  const cells: XlsxCell[] = [];
  // `<c ...>` but never `<col ...>` / `<cols>`: the attribute list must start with whitespace or the tag must end at once.
  const re = /<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sheetXml)) !== null) {
    const attributes = match[1] ?? "";
    const inner = match[2] ?? "";
    const ref = attribute(attributes, "r");
    if (ref === null) continue;
    const { column, row } = splitRef(ref);
    const t = attribute(attributes, "t");
    const s = attribute(attributes, "s");
    const format = s === null ? "General" : (formats[Number(s)] ?? "General");
    const flags = s === null ? undefined : styleFlags[Number(s)];
    const hasFormula = /<f[\s>/]/.test(inner);
    const rawValue = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1];

    let type: XlsxCellType;
    let text: string | null;
    if (t === "s") {
      type = "shared-string";
      const index = rawValue === undefined ? NaN : Number(rawValue);
      text = Number.isInteger(index) ? (shared[index] ?? null) : null;
    } else if (t === "inlineStr") {
      type = "inline-string";
      text = textOfStringItem(/<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? "");
    } else if (t === "str") {
      type = "formula-string";
      text = rawValue === undefined ? null : decodeXml(rawValue);
    } else if (t === "b") {
      type = "boolean";
      text = rawValue ?? null;
    } else if (t === "e") {
      type = "error";
      text = rawValue === undefined ? null : decodeXml(rawValue);
    } else if (rawValue === undefined) {
      type = "empty";
      text = null;
    } else {
      type = "number";
      text = decodeXml(rawValue);
    }
    cells.push({ ref, row, column, type, text, hasFormula, format, bold: flags?.bold ?? false, wrap: flags?.wrap ?? false });
  }
  return cells;
}

function makeSheet(name: string, xml: string, shared: string[], formats: string[], styleFlags: StyleFlags[]): XlsxSheet {
  const cells = readCells(xml, shared, formats, styleFlags);
  const byRef = new Map(cells.map((c) => [c.ref, c]));
  const textAt = (ref: string): string => byRef.get(ref)?.text ?? "";

  const headerRowNumber = (): number => {
    const header = cells.find((c) => c.column === 1 && c.text === "No.");
    if (!header) throw new Error('xlsx-reader: no header row found (a cell in column A reading "No.")');
    return header.row;
  };

  return {
    name,
    xml,
    cells,
    cell: (ref) => byRef.get(ref),
    columnWidths: () => readColumnWidths(xml),
    meta() {
      const last = headerRowNumber();
      const out: Record<string, string> = {};
      for (const c of cells) {
        if (c.column === 1 && c.row < last && c.text !== null && c.text !== "") out[c.text] = textAt(`B${c.row}`);
      }
      return out;
    },
    table() {
      const headerRow = headerRowNumber();
      const headerCells = cells.filter((c) => c.row === headerRow && c.text !== null).sort((a, b) => a.column - b.column);
      const headers = headerCells.map((c) => c.text ?? "");
      const rowNumbers = Array.from(new Set(cells.filter((c) => c.row > headerRow).map((c) => c.row))).sort((a, b) => a - b);
      const rows = rowNumbers.map((rowNumber) => {
        const record: Record<string, XlsxCell | undefined> = {};
        for (const h of headerCells) record[h.text ?? ""] = byRef.get(`${columnLetters(h.column)}${rowNumber}`);
        return record;
      });
      return { headerRow, headers, rows };
    },
  };
}

function columnLetters(column: number): string {
  let letters = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

/** Unzips and reads an .xlsx. Throws (with a readable message) when the bytes are not a zip package or lack the core parts. */
export function readXlsx(bytes: Uint8Array): XlsxWorkbook {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    throw new Error(`xlsx-reader: not a zip package (${error instanceof Error ? error.message : "unknown error"})`);
  }
  const parts: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) parts[name] = strFromU8(data);

  const workbookXml = parts["xl/workbook.xml"];
  if (workbookXml === undefined) throw new Error("xlsx-reader: xl/workbook.xml is missing (not a spreadsheet package)");
  const relsXml = parts["xl/_rels/workbook.xml.rels"] ?? "";
  const shared = readSharedStrings(parts["xl/sharedStrings.xml"]);
  const formats = readFormats(parts["xl/styles.xml"]);
  const styleFlags = readStyleFlags(parts["xl/styles.xml"]);

  const sheets: XlsxSheet[] = [];
  const sheetTag = /<sheet\s[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = sheetTag.exec(workbookXml)) !== null) {
    const name = attribute(match[0], "name");
    const rid = attribute(match[0], "r:id");
    if (name === null || rid === null) continue;
    const relationship = new RegExp(`<Relationship\\s[^>]*Id="${rid}"[^>]*>`).exec(relsXml)?.[0] ?? "";
    const target = attribute(relationship, "Target");
    if (target === null) throw new Error(`xlsx-reader: no relationship target for sheet "${name}"`);
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    const xml = parts[path];
    if (xml === undefined) throw new Error(`xlsx-reader: worksheet part ${path} is missing`);
    sheets.push(makeSheet(name, xml, shared, formats, styleFlags));
  }

  return {
    parts,
    partNames: Object.keys(parts),
    sheets,
    sheet(name) {
      const found = sheets.find((s) => s.name === name);
      if (!found) throw new Error(`xlsx-reader: no sheet named "${name}" (found: ${sheets.map((s) => s.name).join(", ")})`);
      return found;
    },
  };
}

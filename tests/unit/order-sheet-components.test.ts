// Markup-level tests of the two Order sheet components this round changed, rendered on the server (no browser needed):
//  * PrintSheet: the print-only "?" marker and warning line for an invalid quantity (Ctrl/Cmd+P ignores the disabled
//    Print button, so the paper copy must never silently lose what staff typed). Real printing is covered by the
//    Playwright spec (page.pdf + pdftotext); here the classes that make it print-only are pinned down.
//  * SheetRows: a row whose item was deleted says which item it was ("<name> - no longer in inventory").
// and the structure of what the Undo / limit / Enter changes added (UndoLine, LimitNote, the quantity and unit boxes, AddItems, SheetDetails).
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Medication } from "@/lib/db";
import { AddItems } from "@/app/order-sheet/AddItems";
import { LimitNote, atLimit } from "@/app/order-sheet/LimitNote";
import { PrintSheet } from "@/app/order-sheet/PrintSheet";
import { SheetDetails } from "@/app/order-sheet/SheetDetails";
import { SheetRows } from "@/app/order-sheet/SheetRows";
import { UndoLine } from "@/app/order-sheet/UndoLine";
import { INVALID_QTY_PRINT_NOTE } from "@/app/order-sheet/format";
import { buildSheet } from "@/lib/order-sheet/build";
import { DEFAULT_DRAFT } from "@/lib/order-sheet/draft";
import type { BuiltSheet, SheetOptions, SheetRow, SheetRowInput } from "@/lib/order-sheet/types";
import { buildMedications } from "@/tests/helpers/fixtures";

const OPTIONS: SheetOptions = { title: "Supply order", date: "2026-11-05", preparedBy: "", notes: "", showOnHand: false, showBarcode: false };
const items: Medication[] = buildMedications();
const [acet, ibu, aspirin] = items;

function printMarkup(sheet: BuiltSheet): string {
  return renderToStaticMarkup(createElement(PrintSheet, { sheet, paper: "letter" }));
}

/** The attribute `class` of the first element whose opening tag carries `data-testid="<id>"`. */
function classOf(html: string, testId: string): string {
  const tag = new RegExp(`<[a-z0-9]+[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";
  return /class="([^"]*)"/.exec(tag)?.[1] ?? "";
}

function count(html: string, text: string): number {
  return html.split(text).length - 1;
}

/** The text a person reads: tags removed first, then entities decoded (so escaped markup comes back as the text it is). */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("PrintSheet: print-only marker for an invalid quantity", () => {
  const input = (id: number, qty: string): SheetRowInput => ({ id, qty, unit: "box" });

  it("a sheet with only valid (or blank) quantities has no marker and no warning line at all", () => {
    const html = printMarkup(buildSheet(items, [input(acet.id, "12"), input(ibu.id, ""), input(aspirin.id, "007")], OPTIONS));
    expect(html).not.toContain("print-invalid-note");
    expect(html).not.toContain("print-qty-marker");
    expect(html).not.toContain(INVALID_QTY_PRINT_NOTE);
    expect(textOf(html)).not.toContain("?");
    expect(html).toContain(">12<"); // a valid quantity prints as typed (leading zeros stripped: 007 -> 7)
    expect(html).toContain(">7<");
  });

  it("an invalid quantity prints '?' in its own quantity cell, and only there", () => {
    const sheet = buildSheet(items, [input(acet.id, "12"), input(ibu.id, "1.5"), input(aspirin.id, "4")], OPTIONS);
    expect(sheet.invalidQtyIds).toEqual([ibu.id]);
    const html = printMarkup(sheet);
    expect(count(html, "print-qty-marker")).toBe(1);
    const rows = html.split("<tr").slice(1);
    const ibuRow = rows.find((row) => row.includes(ibu.name ?? "")) ?? "";
    expect(ibuRow).toContain("print-qty-marker");
    expect(rows.filter((row) => row.includes("print-qty-marker"))).toHaveLength(1);
    // the typed "1.5" is not printed as if it were a quantity; the cell is empty apart from the marker
    expect(ibuRow).not.toContain("1.5");
    expect(ibuRow).toMatch(/<td[^>]*><span[^>]*data-testid="print-qty-marker"[^>]*>\?<\/span><\/td>/);
  });

  it("the marker and the warning line are hidden on screen and shown only when printing (print: variants), black on white", () => {
    const html = printMarkup(buildSheet(items, [input(ibu.id, "abc")], OPTIONS));
    const marker = classOf(html, "print-qty-marker").split(/\s+/);
    expect(marker).toContain("hidden");
    expect(marker).toContain("print:inline");
    const note = classOf(html, "print-invalid-note").split(/\s+/);
    expect(note).toContain("hidden");
    expect(note).toContain("print:block");
    expect(note).toContain("border-black");
    expect(note).toContain("font-bold");
    // never rely on color or shading: no text/background/border color utilities other than black
    for (const cls of [...marker, ...note]) {
      expect(cls, cls).not.toMatch(/^(print:)?(text|bg)-(red|amber|yellow|orange|gray|blue|green)/);
      expect(cls, cls).not.toMatch(/^border-(red|amber|yellow|orange|gray|blue|green)/);
    }
  });

  it("says what the '?' means, once, in the exact words, above the table and inside the printed sheet", () => {
    const html = printMarkup(buildSheet(items, [input(ibu.id, "1.5"), input(aspirin.id, "x")], OPTIONS));
    expect(INVALID_QTY_PRINT_NOTE).toBe("Some quantities are not valid numbers (marked ?). Fix them before using this sheet.");
    expect(count(html, INVALID_QTY_PRINT_NOTE)).toBe(1); // one line however many rows are marked
    expect(count(html, "print-qty-marker")).toBe(2);
    const at = html.indexOf(INVALID_QTY_PRINT_NOTE);
    expect(at).toBeGreaterThan(html.indexOf('class="print-sheet'));
    expect(at).toBeLessThan(html.indexOf("<table"));
    expect(at).toBeGreaterThan(html.indexOf("<dl")); // after the date line, before the table
  });

  it("a missing item is not on the sheet, so its typed quantity neither marks a row nor adds the warning", () => {
    const sheet = buildSheet(items, [input(999999, "abc"), input(acet.id, "5")], OPTIONS);
    expect(sheet.missingIds).toEqual([999999]);
    const html = printMarkup(sheet);
    expect(html).not.toContain("print-invalid-note");
    expect(html).not.toContain("print-qty-marker");
  });

  it("works with the on-hand and barcode columns on, and for an empty sheet", () => {
    const full = printMarkup(buildSheet(items, [input(ibu.id, "1.5")], { ...OPTIONS, showOnHand: true, showBarcode: true }));
    expect(count(full, "print-qty-marker")).toBe(1);
    expect(full).toContain("On hand");
    expect(full).toContain("Barcode");
    const empty = printMarkup(buildSheet(items, [], OPTIONS));
    expect(empty).not.toContain("print-invalid-note");
    expect(empty).toContain("No items on this order sheet");
  });

  it("the marker follows the row when only the quantity changes (BodyRow's memo comparison includes it)", () => {
    // Two renders of the same row, first invalid and then valid: the second must not show a marker.
    const invalid = printMarkup(buildSheet(items, [input(ibu.id, "1.5")], OPTIONS));
    const valid = printMarkup(buildSheet(items, [input(ibu.id, "15")], OPTIONS));
    expect(invalid).toContain("print-qty-marker");
    expect(valid).not.toContain("print-qty-marker");
    expect(valid).toContain(">15<");
  });
});

describe("SheetRows: a row whose item is no longer in the inventory", () => {
  function rowsMarkup(rows: SheetRowInput[], details: Map<number, SheetRow> = new Map()): string {
    return renderToStaticMarkup(
      createElement(SheetRows, {
        rows,
        details,
        showBarcode: false,
        flashId: null,
        listRef: createRef<HTMLUListElement>(),
        onQty: vi.fn(),
        onUnit: vi.fn(),
        onRemove: vi.fn(),
      })
    );
  }

  it("with a remembered name it reads '<name> - no longer in inventory.' and still has Remove", () => {
    const html = rowsMarkup([{ id: 105, qty: "", unit: "", name: "Cetirizine 10 mg, tablets" }]);
    const text = textOf(html);
    expect(text).toContain("Cetirizine 10 mg, tablets - no longer in inventory.");
    expect(text).toContain("It is not in the preview, the print-out or the Excel file.");
    expect(text).not.toContain("Item no.");
    expect(html).toContain('data-testid="sheet-row-105"');
    expect(html).toContain('data-testid="remove-row-105"');
    expect(html).toContain('aria-label="Remove Cetirizine 10 mg, tablets from the order sheet"');
  });

  it("without a remembered name it falls back to the old wording with the item number", () => {
    for (const name of [undefined, "", "   ", "\t\n"]) {
      const html = rowsMarkup([{ id: 105, qty: "", unit: "", name }]);
      const text = textOf(html);
      expect(text, JSON.stringify(name)).toContain("No longer in inventory. Item no. 105 is not in the preview, the print-out or the Excel file.");
      expect(text).not.toContain(" - no longer in inventory");
      expect(html).toContain('aria-label="Remove missing item 105 from the order sheet"');
    }
  });

  it("a hostile remembered name is plain text: escaped, never markup", () => {
    const names = ['<img src=x onerror="window.__pwned=1">', '"><script>window.__pwned=2</script>', "<b>bold</b> & <i>x</i>", "=HYPERLINK(\"http://example.invalid\",\"click\")"];
    for (const name of names) {
      const html = rowsMarkup([{ id: 7, qty: "", unit: "", name }]);
      expect(html, name).not.toContain("<img");
      expect(html, name).not.toContain("<script");
      expect(html, name).not.toContain("<b>bold");
      expect(html).not.toContain("<i>x");
      expect(textOf(html), name).toContain(`${name} - no longer in inventory.`);
    }
  });

  it("a very long name keeps wrapping (wrap-anywhere) instead of widening the page, and the warning icon does not shrink", () => {
    const html = rowsMarkup([{ id: 7, qty: "", unit: "", name: "L".repeat(120) }]);
    expect(html).toMatch(/class="[^"]*font-semibold[^"]*wrap-anywhere[^"]*"[^>]*>L{120} - no longer in inventory\./);
    expect(html).toContain("shrink-0");
  });

  it("an item that IS in the inventory shows the inventory's current name, not a stale remembered one", () => {
    const sheet = buildSheet(items, [{ id: acet.id, qty: "3", unit: "box", name: "STALE NAME" }], OPTIONS);
    const details = new Map(sheet.rows.map((row) => [row.id, row] as const));
    const html = rowsMarkup([{ id: acet.id, qty: "3", unit: "box", name: "STALE NAME" }], details);
    expect(textOf(html)).not.toContain("STALE NAME");
    expect(html).toContain(acet.name ?? "NO NAME");
    expect(html).not.toContain("no longer in inventory");
  });

  it("lists present and missing rows in the draft's order", () => {
    const sheet = buildSheet(items, [{ id: acet.id, qty: "", unit: "" }, { id: ibu.id, qty: "", unit: "" }], OPTIONS);
    const details = new Map(sheet.rows.map((row) => [row.id, row] as const));
    const html = rowsMarkup(
      [
        { id: acet.id, qty: "", unit: "" },
        { id: 105000, qty: "", unit: "", name: "Gone item" },
        { id: ibu.id, qty: "", unit: "" },
      ],
      details
    );
    const order = [...html.matchAll(/data-testid="sheet-row-(\d+)"/g)].map((m) => Number(m[1]));
    expect(order).toEqual([acet.id, 105000, ibu.id]);
  });
});

describe("UndoLine: the message under 'Add all low-stock items', with Undo and Dismiss", () => {
  function lineMarkup(props: Partial<{ text: string; canUndo: boolean; canDismiss: boolean }> = {}): string {
    return renderToStaticMarkup(
      createElement(UndoLine, {
        text: "Added 3 low-stock items. Order quantities are left empty.",
        tick: 1,
        canUndo: true,
        canDismiss: true,
        rootRef: createRef<HTMLDivElement>(),
        onUndo: vi.fn(),
        onDismiss: vi.fn(),
        ...props,
      })
    );
  }

  it("the sentence is a polite live region of its own; Undo and Dismiss are outside of it, so only the sentence is read out", () => {
    const html = lineMarkup();
    const regionEnd = html.indexOf("</p>") + "</p>".length;
    const region = html.slice(0, regionEnd);
    const after = html.slice(regionEnd);
    expect(region).toContain('role="status"');
    expect(region).toContain('aria-live="polite"');
    expect(region).toContain('aria-atomic="true"');
    expect(region).toContain('data-testid="low-stock-status"');
    expect(textOf(region)).toBe("Added 3 low-stock items. Order quantities are left empty.");
    expect(region).not.toMatch(/Undo|Dismiss/);
    expect(after).toMatch(/<button[^>]*data-testid="bulk-undo"[^>]*>Undo<\/button>/);
    expect(after).toMatch(/<button[^>]*data-testid="bulk-dismiss"[^>]*>Dismiss<\/button>/);
    expect(after.indexOf("bulk-undo")).toBeLessThan(after.indexOf("bulk-dismiss")); // Undo first: it is the one Tab reaches first
  });

  it("with no message only the empty, visually hidden live region is drawn (no buttons), so the first message is announced when it appears", () => {
    const html = lineMarkup({ text: "", canUndo: false, canDismiss: false });
    expect(html).toContain('role="status"');
    expect(html).toContain("sr-only");
    expect(html).not.toContain("<button");
    expect(textOf(html)).toBe("");
  });

  it("offers only what applies: Dismiss alone once Undo is used, and nothing at all next to an explanation", () => {
    const used = lineMarkup({ text: "Undid adding 3 items.", canUndo: false, canDismiss: true });
    expect(used).not.toContain("bulk-undo");
    expect(used).toContain("bulk-dismiss");
    const explanation = lineMarkup({ text: "All 3 low-stock items are already on the sheet. Nothing was added.", canUndo: false, canDismiss: false });
    expect(explanation).not.toContain("<button");
    expect(textOf(explanation)).toBe("All 3 low-stock items are already on the sheet. Nothing was added.");
  });
});

describe("LimitNote: a box that cuts text off says so", () => {
  const note = (value: string, limit: number): string => renderToStaticMarkup(createElement(LimitNote, { id: "n", testId: "t", value, limit }));

  it("is in the page but empty (no text, no styling) while there is room", () => {
    expect(note("a".repeat(39), 40)).toBe('<p id="n" data-testid="t" role="status"></p>');
  });

  it("names the limit, with thousands separators, once the box is full", () => {
    expect(textOf(note("a".repeat(40), 40))).toBe("Limit: 40 characters. Anything more is cut off.");
    expect(textOf(note("a".repeat(1000), 1000))).toBe("Limit: 1,000 characters. Anything more is cut off.");
  });

  it("counts like maxLength does (UTF-16 units), so the note appears exactly when the browser stops accepting characters", () => {
    expect(atLimit("a".repeat(40), 40)).toBe(true);
    expect(atLimit("a".repeat(39), 40)).toBe(false);
    expect(atLimit("\u{1F600}".repeat(20), 40)).toBe(true); // a character outside the basic plane is two units: 20 of them fill a 40-unit box
  });
});

describe("SheetRows: the quantity box keeps what was typed, the unit box says when it is full", () => {
  const sheet = buildSheet(items, [{ id: acet.id, qty: "", unit: "" }], OPTIONS);
  const details = new Map(sheet.rows.map((row) => [row.id, row] as const));

  function rowMarkup(qty: string, unit: string): string {
    return renderToStaticMarkup(
      createElement(SheetRows, {
        rows: [{ id: acet.id, qty, unit }],
        details,
        showBarcode: false,
        flashId: null,
        listRef: createRef<HTMLUListElement>(),
        onQty: vi.fn(),
        onUnit: vi.fn(),
        onRemove: vi.fn(),
      })
    );
  }
  const tag = (html: string, testId: string): string => new RegExp(`<input[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";

  it("the quantity box has no maxLength (a pasted 12-digit number is kept) and the row says it is too large, naming the limit", () => {
    const html = rowMarkup("999999999999", "");
    const qty = tag(html, `qty-input-${acet.id}`);
    expect(qty).not.toMatch(/maxlength/i);
    expect(qty).toContain('value="999999999999"');
    expect(qty).toContain('aria-invalid="true"');
    expect(textOf(html)).toContain("Too large. Enter 999,999,999 or less.");
  });

  it("the unit box keeps its limit of 40 and explains it only once it is reached", () => {
    const room = rowMarkup("", "box");
    expect(tag(room, `unit-input-${acet.id}`)).toContain('maxLength="40"');
    expect(room).toContain(`<p id="unit-limit-note-${acet.id}" data-testid="unit-limit-${acet.id}" role="status"></p>`);
    expect(tag(room, `unit-input-${acet.id}`)).not.toContain("aria-describedby");

    const full = rowMarkup("", "u".repeat(40));
    expect(tag(full, `unit-input-${acet.id}`)).toContain(`aria-describedby="unit-limit-note-${acet.id}"`);
    expect(textOf(full)).toContain("Limit: 40 characters. Anything more is cut off.");
  });
});

describe("AddItems and SheetDetails: wording", () => {
  const addItems = (): string =>
    renderToStaticMarkup(
      createElement(AddItems, {
        items,
        categories: { status: "loading" },
        isOnSheet: () => false,
        onAdd: vi.fn(),
        status: { text: "", tick: 0 },
        searchRef: createRef<HTMLInputElement>(),
      })
    );
  const details = (draft = DEFAULT_DRAFT): string =>
    renderToStaticMarkup(createElement(SheetDetails, { draft, resolvedDate: "2026-11-05", today: "2026-11-05", update: vi.fn() }));

  it("the search box calls it a 'supplier order no.' like every label, and its help text says that Enter adds a single match", () => {
    const html = addItems();
    expect(html).toContain('placeholder="Name, barcode or supplier order no."');
    const text = textOf(html);
    expect(text).toContain("When only one item matches (for example after scanning its barcode), press Enter to add it.");
    expect(text).toContain("An item that is already on the sheet is marked and is never added twice.");
    expect(html).toMatch(/<input[^>]*data-testid="add-search"[^>]*aria-describedby="[^"]+"/);
  });

  it("the two column switches say that they change the Excel file too, and keep their test ids", () => {
    const html = details();
    expect(textOf(html)).toContain("Show on-hand column (printed sheet and Excel file)");
    expect(textOf(html)).toContain("Show barcode column (printed sheet and Excel file)");
    expect(textOf(html)).not.toContain("Show on-hand column on the printed sheet");
    expect(html).toMatch(/<input[^>]*data-testid="show-on-hand"/);
    expect(html).toMatch(/<input[^>]*data-testid="show-barcode"/);
  });

  it("title, prepared-by and notes keep their limits and each explains it when full (and only then)", () => {
    const quiet = details();
    for (const id of ["sheet-title-limit", "sheet-prepared-by-limit", "sheet-notes-limit"]) {
      expect(quiet, id).toMatch(new RegExp(`<p id="[^"]+" data-testid="${id}" role="status"></p>`));
    }
    const full = details({ ...DEFAULT_DRAFT, title: "t".repeat(120), preparedBy: "p".repeat(80), notes: "n".repeat(1000) });
    const text = textOf(full);
    expect(text).toContain("Limit: 120 characters.");
    expect(text).toContain("Limit: 80 characters.");
    expect(text).toContain("Limit: 1,000 characters.");
    expect(full).toMatch(/<input[^>]*data-testid="sheet-title"[^>]*maxLength="120"/);
    expect(full).toMatch(/<textarea[^>]*data-testid="sheet-notes"[^>]*maxLength="1000"/);
  });
});

// Markup-level tests of the two Order sheet components this round changed, rendered on the server (no browser needed):
//  * PrintSheet: the print-only "?" marker and warning line for an invalid quantity (Ctrl/Cmd+P ignores the disabled
//    Print button, so the paper copy must never silently lose what staff typed). Real printing is covered by the
//    Playwright spec (page.pdf + pdftotext); here the classes that make it print-only are pinned down.
//  * SheetRows: a row whose item was deleted says which item it was ("<name> - no longer in inventory").
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Medication } from "@/lib/db";
import { PrintSheet } from "@/app/order-sheet/PrintSheet";
import { SheetRows } from "@/app/order-sheet/SheetRows";
import { INVALID_QTY_PRINT_NOTE } from "@/app/order-sheet/format";
import { buildSheet } from "@/lib/order-sheet/build";
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

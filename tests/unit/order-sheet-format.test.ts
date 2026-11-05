// Pure wording / date / column helpers of the Order sheet page (app/order-sheet/format.ts).
import { describe, expect, it } from "vitest";
import {
  INVALID_QTY_PRINT_NOTE,
  LOAD_ERROR_REASSURANCE,
  LOAD_ERROR_TITLE,
  SHEET_DATE_MAX,
  SHEET_DATE_MIN,
  categoryLabel,
  columnWidths,
  displayName,
  formatSheetDate,
  isSheetDate,
  pageStyleText,
  planColumns,
  pluralize,
  printDocumentTitle,
  qtyProblem,
  sheetFooter,
} from "@/app/order-sheet/format";
import type { CategoryList } from "@/app/order-sheet/format";
import { isValidISODate } from "@/lib/order-sheet/draft";
import { buildCategories, categoryId } from "@/tests/helpers/fixtures";

describe("the words the page shares with the other screens", () => {
  it("load failure: the shared title and reassurance, exactly", () => {
    expect(LOAD_ERROR_TITLE).toBe("Couldn’t load the inventory");
    expect(LOAD_ERROR_REASSURANCE).toBe("This does not mean the inventory is empty.");
  });

  it("the line printed above the table when a quantity is not a valid number", () => {
    expect(INVALID_QTY_PRINT_NOTE).toBe("Some quantities are not valid numbers (marked ?). Fix them before using this sheet.");
  });
});

describe("dates: only 2000-2099, the same rule as the draft and the export route", () => {
  it("the date box range is the first and last day of the accepted years", () => {
    expect(SHEET_DATE_MIN).toBe("2000-01-01");
    expect(SHEET_DATE_MAX).toBe("2099-12-31");
    expect(isSheetDate(SHEET_DATE_MIN)).toBe(true);
    expect(isSheetDate(SHEET_DATE_MAX)).toBe(true);
  });

  it.each(["2026-11-05", "2000-02-29", "2096-02-29", "2099-12-31"])("accepts %s", (date) => {
    expect(isSheetDate(date)).toBe(true);
  });

  it.each(["0026-11-05", "1999-12-31", "2100-01-01", "9999-12-31", "20265-11-05", "2026-02-30", "2026-13-01", "2026-1-5", "", "2026-11-05T10:00"])("rejects %j", (date) => {
    expect(isSheetDate(date)).toBe(false);
  });

  it("never disagrees with isValidISODate (the rule the draft and the export route use)", () => {
    const samples: string[] = [];
    for (const year of ["0001", "0026", "1999", "2000", "2026", "2099", "2100", "9999"]) {
      for (const monthDay of ["01-01", "02-29", "02-30", "06-31", "12-31", "13-01", "00-10"]) samples.push(`${year}-${monthDay}`);
    }
    for (const sample of samples) expect(isSheetDate(sample), sample).toBe(isValidISODate(sample));
  });

  it("formatSheetDate shows a real date in the browser's language and leaves anything else as it is", () => {
    const expected = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(Date.UTC(2026, 10, 5));
    expect(formatSheetDate("2026-11-05")).toBe(expected);
    expect(formatSheetDate("2026-11-05")).toContain("2026");
    expect(formatSheetDate("not a date")).toBe("not a date");
    expect(formatSheetDate("2026-1-5")).toBe("2026-1-5");
    // a year before 1000 (only possible with a wrong computer clock) is shown exactly as stored, never as another year
    expect(formatSheetDate("0026-11-05")).toBe("0026-11-05");
  });

  it("the footer and the suggested file name use the title and the date", () => {
    const dateText = formatSheetDate("2026-11-05");
    expect(sheetFooter("  Winter order ", dateText)).toBe(`Winter order · ${dateText}`);
    expect(sheetFooter("", dateText)).toBe(dateText);
    expect(printDocumentTitle({ title: "Winter order", date: "2026-11-05" })).toBe(`Winter order - ${dateText}`);
    expect(printDocumentTitle({ title: "   ", date: "2026-11-05" })).toBe(`Order sheet - ${dateText}`);
  });
});

describe("order quantity wording", () => {
  it("nothing to say for a valid or blank quantity", () => {
    for (const typed of ["", "  ", "1", "12", "007", " 5 ", "999999999"]) expect(qtyProblem(typed), JSON.stringify(typed)).toBeNull();
  });

  it("says why a quantity is not valid, without changing it", () => {
    expect(qtyProblem("1.5")).toBe("Digits only, for example 12.");
    expect(qtyProblem("abc")).toBe("Digits only, for example 12.");
    expect(qtyProblem("-3")).toBe("Digits only, for example 12.");
    expect(qtyProblem("1000000000")).toBe("Digits only, for example 12.");
    expect(qtyProblem("0")).toBe("Enter 1 or more, or leave blank.");
    expect(qtyProblem("000")).toBe("Enter 1 or more, or leave blank.");
  });
});

describe("names, plurals and categories", () => {
  it("pluralize", () => {
    expect(pluralize(1, "item", "items")).toBe("item");
    expect(pluralize(0, "item", "items")).toBe("items");
    expect(pluralize(2, "item", "items")).toBe("items");
  });

  it("displayName: the trimmed name, or the barcode fallback for an unnamed item (the same rule as buildSheet)", () => {
    expect(displayName({ name: "  Ibuprofen 200 mg  ", barcode: "123" })).toBe("Ibuprofen 200 mg");
    expect(displayName({ name: null, barcode: "0049000028911" })).toBe("Unnamed item (barcode 0049000028911)");
    expect(displayName({ name: "   ", barcode: "X-1" })).toBe("Unnamed item (barcode X-1)");
  });

  it.each(["uuid", "bigint"] as const)("categoryLabel with %s ids: never calls an unresolved category 'Uncategorized'", (shape) => {
    const categories = buildCategories(shape);
    const ready: CategoryList = { status: "ready", categories };
    expect(categoryLabel({ category_id: null }, ready)).toBe("Uncategorized");
    expect(categoryLabel({ category_id: categoryId(2, shape) }, ready)).toBe("Antibiotics");
    expect(categoryLabel({ category_id: shape === "uuid" ? "00000000-0000-4000-8000-00000000dead" : "9999" }, ready)).toBe("Category unavailable");
    expect(categoryLabel({ category_id: categoryId(2, shape) }, { status: "loading" })).toBeNull(); // say nothing while loading
    expect(categoryLabel({ category_id: categoryId(2, shape) }, { status: "error" })).toBe("Category unavailable");
    expect(categoryLabel({ category_id: null }, { status: "error" })).toBe("Uncategorized");
  });
});

describe("printed columns and page setup", () => {
  it("Item, Supplier order no., Order qty and Unit always; On hand and Barcode only when switched on", () => {
    expect(planColumns({ showOnHand: false, showBarcode: false }).map((c) => c.label)).toEqual(["Item", "Supplier order no.", "Order qty", "Unit"]);
    expect(planColumns({ showOnHand: true, showBarcode: false }).map((c) => c.label)).toEqual(["Item", "Supplier order no.", "Order qty", "Unit", "On hand"]);
    expect(planColumns({ showOnHand: false, showBarcode: true }).map((c) => c.label)).toEqual(["Item", "Supplier order no.", "Order qty", "Unit", "Barcode"]);
    expect(planColumns({ showOnHand: true, showBarcode: true }).map((c) => c.key)).toEqual(["item", "supplier", "qty", "unit", "onHand", "barcode"]);
  });

  it("column widths are percentages that add up to 100", () => {
    for (const options of [
      { showOnHand: false, showBarcode: false },
      { showOnHand: true, showBarcode: true },
    ]) {
      const widths = columnWidths(planColumns(options));
      expect(widths.every((w) => /^\d+(\.\d+)?%$/.test(w))).toBe(true);
      const total = widths.reduce((sum, w) => sum + parseFloat(w), 0);
      expect(total).toBeGreaterThan(99.9);
      expect(total).toBeLessThan(100.1);
    }
  });

  it("the @page rule matches the chosen paper", () => {
    expect(pageStyleText("letter")).toContain("size: letter portrait");
    expect(pageStyleText("a4")).toContain("size: A4 portrait");
    expect(pageStyleText("letter")).toContain("margin: 14mm");
    expect(pageStyleText("a4")).toContain('counter(page) " of " counter(pages)');
  });
});

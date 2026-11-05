import { describe, expect, it } from "vitest";
import type { Medication } from "@/lib/db";
import { buildSheet, clampText, exceedsLength, normalizeQty, normalizeUnit } from "@/lib/order-sheet/build";
import type { SheetOptions, SheetRowInput } from "@/lib/order-sheet/types";
import {
  FORMULA_NAMES,
  TRICKY_SUPPLIER_NUMBERS,
  UNUSUAL_NAMES,
  buildManyMedications,
  buildMedications,
} from "@/tests/helpers/fixtures";

const OPTIONS: SheetOptions = {
  title: "Supply order",
  date: "2026-11-05",
  preparedBy: "Jane Doe",
  notes: "",
  showOnHand: false,
  showBarcode: false,
};

function row(id: number, qty = "", unit = ""): SheetRowInput {
  return { id, qty, unit };
}

function med(overrides: Partial<Medication> & { id: number }): Medication {
  return {
    name: "Test item",
    barcode: "0012345678905",
    photo_url: null,
    stock: 10,
    threshold: 5,
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

/** Deep-freezes a value so any accidental mutation throws (the test files run as strict ES modules). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

describe("normalizeQty", () => {
  it.each([
    ["", ""],
    ["   ", ""],
    ["\t\n ", ""],
    ["1", "1"],
    ["12", "12"],
    [" 12 ", "12"],
    ["007", "7"],
    ["0000000012", "12"], // leading zeros stripped first, so the 10 typed characters are still only "12"
    ["999999999", "999999999"],
    ["000000001", "1"],
  ])("accepts %j as %j", (input, expected) => {
    expect(normalizeQty(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    "0",
    "000",
    "1000000000", // 10 digits: above the maximum
    "9007199254740993", // beyond Number's safe range: must be rejected by length, not rounded
    "99999999999999999999999",
    "1.5",
    "1,000",
    "1 000",
    "12 3",
    "-3",
    "+5",
    "12a",
    "abc",
    "1e3",
    "0x10",
    ".5",
    "5.",
    "=1+1",
    "NaN",
    "Infinity",
    String.fromCharCode(0xff11, 0xff12), // full-width digits
    String.fromCharCode(0x0663), // Arabic-indic digit
    String.fromCharCode(0),
  ])("rejects %j with a reason", (input) => {
    const result = normalizeQty(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/whole number/i);
  });

  it("never returns a value with a leading zero or non-digit", () => {
    for (const input of ["1", "01", "00012", " 7 ", "123456789", "000000123"]) {
      const result = normalizeQty(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toMatch(/^[1-9][0-9]{0,8}$/);
    }
  });

  it("rejects a non-string at runtime instead of coercing it", () => {
    expect(normalizeQty(12 as unknown as string).ok).toBe(false);
    expect(normalizeQty(null as unknown as string).ok).toBe(false);
    expect(normalizeQty(undefined as unknown as string).ok).toBe(false);
  });

  it("handles a giant digit string without hanging or coercing", () => {
    expect(normalizeQty("9".repeat(100000)).ok).toBe(false);
    expect(normalizeQty("0".repeat(100000)).ok).toBe(false);
  });
});

describe("normalizeUnit", () => {
  it("trims the ends and keeps everything else, including repeated inner spaces", () => {
    expect(normalizeUnit("  box ")).toBe("box");
    expect(normalizeUnit("  cardboard   box ")).toBe("cardboard   box");
    expect(normalizeUnit("case of 12")).toBe("case of 12");
    expect(normalizeUnit("")).toBe("");
    expect(normalizeUnit("   ")).toBe("");
  });

  it("replaces control characters and line breaks with a space (and collapses nothing else)", () => {
    expect(normalizeUnit("a\nb")).toBe("a b");
    expect(normalizeUnit("a\r\nb")).toBe("a  b");
    expect(normalizeUnit("a\tb")).toBe("a b");
    expect(normalizeUnit("a" + String.fromCharCode(0) + "b")).toBe("a b");
    expect(normalizeUnit("a" + String.fromCharCode(0x7f) + "b")).toBe("a b");
    expect(normalizeUnit("a" + String.fromCharCode(0x85) + "b")).toBe("a b");
    expect(normalizeUnit("a" + String.fromCharCode(0x2028) + "b")).toBe("a b");
    expect(normalizeUnit("a" + String.fromCharCode(0x2029) + "b")).toBe("a b");
    expect(normalizeUnit(String.fromCharCode(0) + "box")).toBe("box");
    expect(normalizeUnit("box\n")).toBe("box");
  });

  it("truncates to 40 characters without splitting a surrogate pair", () => {
    expect(normalizeUnit("x".repeat(60))).toBe("x".repeat(40));
    expect(normalizeUnit("x".repeat(40))).toBe("x".repeat(40));
    const emoji = String.fromCodePoint(0x1f48a);
    const result = normalizeUnit("a".repeat(39) + emoji + emoji);
    expect(Array.from(result)).toHaveLength(40);
    expect(result.endsWith(emoji)).toBe(true);
    expect(result.isWellFormed()).toBe(true);
  });

  it("does not leave a trailing space after truncating", () => {
    expect(normalizeUnit("a".repeat(39) + " b")).toBe("a".repeat(39));
  });

  it("is idempotent and never converts or interprets the text", () => {
    for (const input of ["box", " 12 ", "=SUM(1,2)", "a\nb", "x".repeat(80), "case/12"]) {
      expect(normalizeUnit(normalizeUnit(input))).toBe(normalizeUnit(input));
    }
    expect(normalizeUnit("=SUM(1,2)")).toBe("=SUM(1,2)");
  });

  it("returns an empty string for a non-string", () => {
    expect(normalizeUnit(5 as unknown as string)).toBe("");
    expect(normalizeUnit(undefined as unknown as string)).toBe("");
  });
});

describe("clampText / exceedsLength", () => {
  it("counts code points, not UTF-16 units", () => {
    const emoji = String.fromCodePoint(0x1f48a);
    expect(clampText(emoji.repeat(5), 3)).toBe(emoji.repeat(3));
    expect(exceedsLength(emoji.repeat(5), 5)).toBe(false);
    expect(exceedsLength(emoji.repeat(6), 5)).toBe(true);
    expect(clampText("abc", 10)).toBe("abc");
    expect(clampText("abcdef", 3)).toBe("abc");
    expect(exceedsLength("", 0)).toBe(false);
    expect(exceedsLength("a", 0)).toBe(true);
  });

  it("is cheap for a very long string", () => {
    expect(clampText("z".repeat(5_000_000), 10)).toBe("z".repeat(10));
  });
});

describe("buildSheet", () => {
  const items = buildMedications();
  const byId = new Map(items.map((m) => [m.id, m]));
  const [first, second, third] = items;

  it("keeps the input order and numbers the emitted rows 1..n", () => {
    const sheet = buildSheet(items, [row(third.id), row(first.id), row(second.id)], OPTIONS);
    expect(sheet.rows.map((r) => r.id)).toEqual([third.id, first.id, second.id]);
    expect(sheet.rows.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(sheet.missingIds).toEqual([]);
    expect(sheet.duplicateIds).toEqual([]);
    expect(sheet.invalidQtyIds).toEqual([]);
  });

  it("joins by id and copies the right fields from the inventory", () => {
    const sheet = buildSheet(items, [row(first.id, "5", "box")], OPTIONS);
    expect(sheet.rows).toEqual([
      {
        n: 1,
        id: first.id,
        name: first.name,
        nameIsFallback: false,
        supplierOrderNumber: first.supplier_order_number,
        qty: "5",
        unit: "box",
        onHand: first.stock,
        stockUnit: first.unit,
        barcode: first.barcode,
      },
    ]);
  });

  it("de-duplicates by id: first wins, later ones are reported (once) and never emitted", () => {
    const sheet = buildSheet(items, [row(first.id, "2", "box"), row(second.id), row(first.id, "99", "case"), row(first.id)], OPTIONS);
    expect(sheet.rows.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(sheet.rows[0]).toMatchObject({ qty: "2", unit: "box" });
    expect(sheet.duplicateIds).toEqual([first.id]);
    expect(sheet.rows.map((r) => r.n)).toEqual([1, 2]);
  });

  it("reports ids that are not in the inventory and does not emit them; n counts emitted rows only", () => {
    const sheet = buildSheet(items, [row(first.id), row(999999), row(second.id), row(888888)], OPTIONS);
    expect(sheet.missingIds).toEqual([999999, 888888]);
    expect(sheet.rows.map((r) => [r.n, r.id])).toEqual([
      [1, first.id],
      [2, second.id],
    ]);
  });

  it("returns an empty sheet for no inputs, and only missing ids for an empty inventory", () => {
    expect(buildSheet(items, [], OPTIONS)).toEqual({ options: OPTIONS, rows: [], missingIds: [], duplicateIds: [], invalidQtyIds: [] });
    const none = buildSheet([], [row(1), row(2)], OPTIONS);
    expect(none.rows).toEqual([]);
    expect(none.missingIds).toEqual([1, 2]);
  });

  it("normalizes a valid typed quantity, keeps blank as blank and flags invalid ones", () => {
    const sheet = buildSheet(
      items,
      [row(100, "007"), row(101, ""), row(102, "  "), row(103, "1.5"), row(104, "abc"), row(105, "0"), row(106, "12")],
      OPTIONS
    );
    expect(sheet.rows.map((r) => r.qty)).toEqual(["7", "", "", "", "", "", "12"]);
    expect(sheet.invalidQtyIds).toEqual([103, 104, 105]);
  });

  it("does not flag the quantity of a row that is not emitted", () => {
    const sheet = buildSheet(items, [row(999999, "abc")], OPTIONS);
    expect(sheet.invalidQtyIds).toEqual([]);
    expect(sheet.missingIds).toEqual([999999]);
  });

  it("gives unnamed items a visible fallback name and marks it", () => {
    const unnamed = items.find((m) => m.name === null);
    expect(unnamed).toBeDefined();
    const sheet = buildSheet(items, [row(unnamed!.id), row(first.id)], OPTIONS);
    expect(sheet.rows[0].name).toBe(`Unnamed item (barcode ${unnamed!.barcode})`);
    expect(sheet.rows[0].nameIsFallback).toBe(true);
    expect(sheet.rows[1].nameIsFallback).toBe(false);

    const blank = buildSheet([med({ id: 7, name: "  \t " })], [row(7)], OPTIONS);
    expect(blank.rows[0]).toMatchObject({ name: "Unnamed item (barcode 0012345678905)", nameIsFallback: true });
  });

  it("trims names but otherwise keeps them verbatim (no escaping or prefixing at this layer)", () => {
    const odd = [...FORMULA_NAMES, ...UNUSUAL_NAMES].map((name, i) => med({ id: 1000 + i, name }));
    const sheet = buildSheet(odd, odd.map((m) => row(m.id)), OPTIONS);
    sheet.rows.forEach((r, i) => {
      expect(r.name).toBe([...FORMULA_NAMES, ...UNUSUAL_NAMES][i].trim());
      expect(r.nameIsFallback).toBe(false);
    });
  });

  it("takes the supplier order number from the item only: trimmed, never inferred", () => {
    const withCode = med({ id: 1, supplier_order_number: "  00417-B " });
    const noCode = med({ id: 2, supplier_order_number: null, barcode: "0000000417", name: "Order no. 00417-B?" });
    const blankCode = med({ id: 3, supplier_order_number: "   " });
    const sheet = buildSheet([withCode, noCode, blankCode], [row(1), row(2), row(3)], OPTIONS);
    expect(sheet.rows.map((r) => r.supplierOrderNumber)).toEqual(["00417-B", null, null]);
  });

  it("keeps leading zeros, letters and punctuation in supplier order numbers", () => {
    const tricky = TRICKY_SUPPLIER_NUMBERS.map((code, i) => med({ id: 2000 + i, supplier_order_number: code }));
    const sheet = buildSheet(tricky, tricky.map((m) => row(m.id)), OPTIONS);
    expect(sheet.rows.map((r) => r.supplierOrderNumber)).toEqual([...TRICKY_SUPPLIER_NUMBERS]);
  });

  it("treats a pre-migration row (no supplier column at all) as 'not set'", () => {
    const legacy = med({ id: 5 });
    delete (legacy as Partial<Medication>).supplier_order_number;
    const sheet = buildSheet([legacy], [row(5)], OPTIONS);
    expect(sheet.rows[0].supplierOrderNumber).toBeNull();
  });

  it("keeps on-hand stock completely separate from the typed quantity and unit", () => {
    const boxes = med({ id: 9, stock: 18, unit: "boxes" });
    const sheet = buildSheet([boxes], [row(9, "5", "case")], OPTIONS);
    expect(sheet.rows[0]).toMatchObject({ onHand: 18, stockUnit: "boxes", qty: "5", unit: "case" });
    // Nothing is derived: a blank order quantity stays blank even though stock is below threshold.
    const low = med({ id: 10, stock: 1, threshold: 50 });
    expect(buildSheet([low], [row(10)], OPTIONS).rows[0]).toMatchObject({ qty: "", unit: "", onHand: 1 });
  });

  it("guards a non-finite stock value", () => {
    const broken = med({ id: 11, stock: Number.NaN });
    expect(buildSheet([broken], [row(11)], OPTIONS).rows[0].onHand).toBe(0);
  });

  it("copies the options and never mutates its inputs", () => {
    const frozenItems = deepFreeze(items.map((m) => ({ ...m })));
    const frozenInputs = deepFreeze([row(100, "3", "box"), row(100, "9"), row(999999)]);
    const frozenOptions = deepFreeze({ ...OPTIONS });
    const sheet = buildSheet(frozenItems, frozenInputs, frozenOptions);
    expect(sheet.options).toEqual(OPTIONS);
    expect(sheet.options).not.toBe(frozenOptions);
    expect(sheet.rows).toHaveLength(1);
  });

  it("uses the first inventory record when the inventory list repeats an id", () => {
    const a = med({ id: 1, name: "First copy" });
    const b = med({ id: 1, name: "Second copy" });
    expect(buildSheet([a, b], [row(1)], OPTIONS).rows[0].name).toBe("First copy");
  });

  it("ignores the draft's remembered name: the sheet always carries the inventory's current name", () => {
    const stale = [{ id: first.id, qty: "2", unit: "box", name: "OLD NAME (the item was renamed since)" }];
    const sheet = buildSheet(items, stale, OPTIONS);
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0].name).toBe(first.name);
    expect(sheet.rows[0].nameIsFallback).toBe(false);
    expect(JSON.stringify(sheet)).not.toContain("OLD NAME");
    // the same sheet is built with or without remembered names
    const plain = buildSheet(items, [row(first.id, "2", "box")], OPTIONS);
    expect(sheet).toEqual(plain);
  });

  it("an unnamed item keeps its barcode fallback whatever name the draft remembered", () => {
    const unnamed = items.find((m) => m.name === null)!;
    const sheet = buildSheet(items, [{ id: unnamed.id, qty: "", unit: "", name: "Some earlier name" }], OPTIONS);
    expect(sheet.rows[0].name).toBe(`Unnamed item (barcode ${unnamed.barcode})`);
    expect(sheet.rows[0].nameIsFallback).toBe(true);
  });

  it("a row whose item is gone is reported by id only: its remembered name is not echoed into the sheet or the lists", () => {
    const inputs = [
      { id: first.id, qty: "1", unit: "", name: "Kept row" },
      { id: 999999, qty: "abc", unit: "", name: "Deleted item <b>x</b>" },
    ];
    const sheet = buildSheet(items, inputs, OPTIONS);
    expect(sheet.missingIds).toEqual([999999]);
    expect(sheet.invalidQtyIds).toEqual([]); // a missing row is not checked, as before
    expect(sheet.rows.map((r) => r.id)).toEqual([first.id]);
    expect(JSON.stringify(sheet)).not.toContain("Deleted item");
    expect(JSON.stringify(sheet)).not.toContain("Kept row");
  });

  it("hostile remembered names never reach the built sheet (names are display text for the builder page only)", () => {
    const names = ['<img src=x onerror="alert(1)">', "=HYPERLINK(\"http://example.invalid\",\"click\")", "+1+1", "@SUM(A1:A2)", "__proto__"];
    const inputs = names.map((name, i) => ({ id: items[i].id, qty: "", unit: "", name }));
    const sheet = buildSheet(items, inputs, OPTIONS);
    expect(sheet.rows.map((r) => r.name)).toEqual(items.slice(0, names.length).map((m) => (m.name ?? "").trim()));
    for (const name of names) expect(JSON.stringify(sheet)).not.toContain(name.slice(0, 12));
    // and the typed inputs are not changed by building a sheet from them
    expect(inputs.map((i) => i.name)).toEqual(names);
  });

  it("accepts draft rows (with an optional name) as input without changing them", () => {
    const frozen = deepFreeze([{ id: first.id, qty: "7", unit: "pack", name: "Remembered" }, { id: second.id, qty: "", unit: "" }]);
    const sheet = buildSheet(items, frozen, OPTIONS);
    expect(sheet.rows.map((r) => [r.id, r.qty, r.unit])).toEqual([[first.id, "7", "pack"], [second.id, "", ""]]);
    expect(frozen[0].name).toBe("Remembered");
  });

  it("builds a 45-row sheet with contiguous numbering (multi-page case)", () => {
    const many = buildManyMedications(45);
    const sheet = buildSheet(many, many.map((m) => row(m.id)), OPTIONS);
    expect(sheet.rows).toHaveLength(45);
    expect(sheet.rows.map((r) => r.n)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
    expect(new Set(sheet.rows.map((r) => r.id)).size).toBe(45);
  });

  it("exposes exactly the intended rows for the fixtures (nothing extra, nothing silently dropped)", () => {
    const wanted = [items[0].id, items[5].id, items[24].id, items[26].id];
    const sheet = buildSheet(items, wanted.map((id) => row(id)), OPTIONS);
    expect(sheet.rows.map((r) => r.id)).toEqual(wanted);
    expect(sheet.rows.every((r) => byId.get(r.id) !== undefined)).toBe(true);
    // Long-name and missing-code items are included unchanged.
    expect(sheet.rows[2].name.length).toBeGreaterThan(100);
    expect(sheet.rows[3].nameIsFallback).toBe(true);
  });
});

// Table-driven tests of lib/admin-form.ts, the pure logic behind the Admin item form: what is sent when an item is saved
// (only what the person changed), how the server's answer is checked, the limits on the text fields, and the category
// choices. Synthetic data only (tests/helpers/fixtures.ts).
//
// The rule these tests pin down: "Editing another field does not clear the category or overwrite unrelated item data".
// A field the person did not change is never sent, and that includes the category.
import { describe, expect, it } from "vitest";
import type { Category, Medication } from "@/lib/db";
import {
  CATEGORY_NAME_MAX_LENGTH,
  EMPTY_FORM,
  FORM_KEYS,
  NEW_CATEGORY_VALUE,
  UNCATEGORIZED_LABEL,
  UNIT_MAX_LENGTH,
  buildPayload,
  categoryLabel,
  categoryName,
  categoryNameProblem,
  countOf,
  describedBy,
  displayName,
  filterToValue,
  findNotStored,
  firstProblemField,
  formCategoryOptions,
  formFromMedication,
  formProblems,
  isEmptyPayload,
  isFormKey,
  isRecord,
  listFilterOptions,
  mergeCategories,
  notesOrNull,
  planSupplier,
  rebaseForm,
  stockStatus,
  supplierOf,
  toCategory,
  toMedication,
  trimmedOrNull,
  unitOrDefault,
  valueToFilter,
  type FormState,
  type SavePayload,
} from "@/lib/admin-form";
import { UNKNOWN_CATEGORY_FILTER, UNKNOWN_CATEGORY_ID, type CategoryCounts } from "@/lib/inventory-view";
import {
  SUPPLIER_ORDER_NUMBER_INVISIBLE_REASON,
  SUPPLIER_ORDER_NUMBER_MAX_LENGTH,
  parseSupplierOrderNumber,
} from "@/lib/supplier-order-number";
import { CATEGORY_NAMES, buildCategories, buildMedications, categoryId, fakeUuid, type IdShape } from "../helpers/fixtures";

const SHAPES: readonly IdShape[] = ["uuid", "bigint"];

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

/** An item with every optional field filled in, so a field that is wrongly sent or wrongly dropped shows. */
function item(shape: IdShape = "uuid", overrides: Partial<Medication> = {}): Medication {
  const base = buildMedications({ shape }).find((m) => m.name?.startsWith("Ibuprofen"));
  if (!base) throw new Error("the fixtures have no Ibuprofen");
  return {
    ...base,
    notes: "Keep in the blue cabinet",
    vendor_url: "https://supplier.example/ibuprofen",
    unit: "bottles",
    photo_url: "https://photos.example.invalid/ibuprofen.png",
    ...overrides,
  };
}

function unnamedItem(shape: IdShape = "uuid"): Medication {
  const base = buildMedications({ shape }).find((m) => m.is_unnamed);
  if (!base) throw new Error("the fixtures have no unnamed item");
  return base;
}

/** What the form holds after the person typed `edits` into the form that was opened on `loaded` (or into a new form). */
function formOf(loaded: Medication | null, edits: Partial<FormState> = {}): FormState {
  return { ...(loaded === null ? EMPTY_FORM : formFromMedication(loaded)), ...edits };
}

/** The body the page would send for those edits. */
function payloadOf(loaded: Medication | null, edits: Partial<FormState> = {}): SavePayload {
  const form = formOf(loaded, edits);
  return buildPayload(form, planSupplier(form, loaded), loaded);
}

const category = (index: number, shape: IdShape = "uuid"): string => categoryId(index, shape);

// ── formFromMedication ──────────────────────────────────────────────────────────────────────────

describe("formFromMedication", () => {
  it("shows every field of the item as the text a person would type, and keeps the category id exactly", () => {
    const med = item("uuid");
    expect(formFromMedication(med)).toEqual({
      name: "Ibuprofen 200 mg, tablets",
      barcode: med.barcode,
      supplier_order_number: "0092",
      photo_url: "https://photos.example.invalid/ibuprofen.png",
      stock: "18",
      threshold: "40",
      unit: "bottles",
      vendor_url: "https://supplier.example/ibuprofen",
      notes: "Keep in the blue cabinet",
      category_id: category(0),
    });
  });

  it("turns missing optional values into empty text, never into the word null, and an uncategorized item stays null", () => {
    const form = formFromMedication(unnamedItem());
    expect(form).toMatchObject({ name: "", supplier_order_number: "", vendor_url: "", notes: "", photo_url: null, category_id: null, stock: "0" });
    expect(Object.values(form).filter((v) => typeof v === "string").join("|")).not.toMatch(/null|undefined|NaN/);
  });

  it("starts a new item on the documented defaults: unit units, no category, empty numbers", () => {
    expect(EMPTY_FORM).toMatchObject({ unit: "units", category_id: null, stock: "", threshold: "", supplier_order_number: "", photo_url: null });
  });
});

// ── buildPayload: editing ───────────────────────────────────────────────────────────────────────

describe("buildPayload: an unedited form sends nothing", () => {
  // Every seeded item that has a name, in both id shapes: legacy rows without a category, long names, quotes and commas, codes
  // with leading zeros, items without a supplier number. Opening an item and saving it untouched changes nothing, so nothing is sent.
  for (const shape of SHAPES) {
    const named = buildMedications({ shape }).filter((m) => !m.is_unnamed);
    it(`${named.length} seeded items (${shape} ids): the payload is empty`, () => {
      for (const med of named) {
        expect(payloadOf(med), `item ${med.id} ${med.name}`).toEqual({});
      }
    });
  }

  it("an item whose optional fields are all filled in sends nothing either", () => {
    expect(payloadOf(item())).toEqual({});
  });

  it("an item that has no category, no supplier number and a blank unit sends nothing", () => {
    expect(payloadOf(item("uuid", { category_id: null, supplier_order_number: null, unit: "", notes: null, vendor_url: null, photo_url: null }))).toEqual({});
  });
});

type SingleEdit = { title: string; edits: Partial<FormState>; expected: SavePayload };

const SINGLE_EDITS: readonly SingleEdit[] = [
  { title: "name", edits: { name: "Ibuprofen 400 mg" }, expected: { name: "Ibuprofen 400 mg" } },
  { title: "name, cleared", edits: { name: "" }, expected: { name: "" } },
  { title: "barcode", edits: { barcode: "0044556677" }, expected: { barcode: "0044556677" } },
  { title: "photo", edits: { photo_url: "https://photos.example.invalid/new.png" }, expected: { photo_url: "https://photos.example.invalid/new.png" } },
  { title: "photo, removed", edits: { photo_url: null }, expected: { photo_url: null } },
  { title: "unit", edits: { unit: "boxes" }, expected: { unit: "boxes" } },
  { title: "unit, cleared (the server turns a blank unit into units)", edits: { unit: "" }, expected: { unit: "" } },
  { title: "stock", edits: { stock: "77" }, expected: { stock: 77 } },
  { title: "stock, to zero", edits: { stock: "0" }, expected: { stock: 0 } },
  { title: "stock, cleared (blank means 0)", edits: { stock: "" }, expected: { stock: 0 } },
  { title: "threshold", edits: { threshold: "45" }, expected: { threshold: 45 } },
  { title: "vendor URL", edits: { vendor_url: "https://supplier.example/typed" }, expected: { vendor_url: "https://supplier.example/typed" } },
  { title: "vendor URL, cleared", edits: { vendor_url: "" }, expected: { vendor_url: null } },
  { title: "notes", edits: { notes: "Typed note" }, expected: { notes: "Typed note" } },
  { title: "notes, cleared", edits: { notes: "" }, expected: { notes: null } },
  { title: "notes, a trailing space (notes keep their own spacing)", edits: { notes: "Keep in the blue cabinet " }, expected: { notes: "Keep in the blue cabinet " } },
  { title: "supplier order number", edits: { supplier_order_number: "00417-B" }, expected: { supplier_order_number: "00417-B" } },
  { title: "supplier order number, with spaces around it (the server trims, the page sends it trimmed)", edits: { supplier_order_number: "  AX-1182/4 " }, expected: { supplier_order_number: "AX-1182/4" } },
  { title: "supplier order number, cleared", edits: { supplier_order_number: "" }, expected: { supplier_order_number: null } },
  { title: "supplier order number, blanks only (the same as cleared)", edits: { supplier_order_number: "   " }, expected: { supplier_order_number: null } },
];

describe("buildPayload: editing sends only the field that was edited", () => {
  it.each(SINGLE_EDITS)("editing only the $title sends exactly that", ({ edits, expected }) => {
    expect(payloadOf(item(), edits)).toEqual(expected);
  });

  it("two fields edited send those two and nothing else", () => {
    expect(payloadOf(item(), { notes: "Typed note", stock: "5" })).toEqual({ notes: "Typed note", stock: 5 });
  });

  it("a code with leading zeros stays text: 0092 is sent as the string 0092, never as the number 92", () => {
    const sent = payloadOf(item("uuid", { supplier_order_number: null }), { supplier_order_number: "0092" });
    expect(sent).toEqual({ supplier_order_number: "0092" });
    expect(typeof sent.supplier_order_number).toBe("string");
  });
});

// A value that normalizes to what the item already holds is "unchanged": nothing is sent for it.
const UNCHANGED_AFTER_NORMALIZING: ReadonlyArray<{ title: string; edits: Partial<FormState> }> = [
  { title: "the name with spaces around it", edits: { name: "  Ibuprofen 200 mg, tablets  " } },
  { title: "the barcode with spaces around it", edits: { barcode: ` ${item().barcode} ` } },
  { title: "the unit with spaces around it", edits: { unit: " bottles " } },
  { title: "the vendor URL with spaces around it", edits: { vendor_url: " https://supplier.example/ibuprofen " } },
  { title: "the photo address with spaces around it", edits: { photo_url: " https://photos.example.invalid/ibuprofen.png " } },
  { title: "the stock typed with leading zeros", edits: { stock: "018" } },
  { title: "the threshold typed with leading zeros", edits: { threshold: "0040" } },
  { title: "the supplier order number with spaces around it", edits: { supplier_order_number: " 0092 " } },
];

describe("buildPayload: values that read the same are not changes", () => {
  it.each(UNCHANGED_AFTER_NORMALIZING)("$title sends nothing", ({ edits }) => {
    expect(payloadOf(item(), edits)).toEqual({});
  });

  it("a blank unit equals a stored unit of 'units' (the server's default)", () => {
    expect(payloadOf(item("uuid", { unit: "units" }), { unit: "" })).toEqual({});
    expect(payloadOf(item("uuid", { unit: "units" }), { unit: "   " })).toEqual({});
  });

  it("a stored value that is only blanks counts as none: typing nothing is not a change", () => {
    expect(payloadOf(item("uuid", { notes: "   ", vendor_url: "  ", photo_url: " " }), { notes: "", vendor_url: "", photo_url: null })).toEqual({});
  });
});

// ── buildPayload: the category ──────────────────────────────────────────────────────────────────

describe.each(SHAPES)("buildPayload: the category (%s ids)", (shape) => {
  it("an unchanged category is not sent, so a category set elsewhere in the meantime is not put back", () => {
    // The form was opened on Pain & Fever; the person edits only the notes. The database may hold another category by now.
    const sent = payloadOf(item(shape), { notes: "Checked on the shelf" });
    expect(sent).toEqual({ notes: "Checked on the shelf" });
    expect("category_id" in sent).toBe(false);
  });

  it("a changed category is sent as the id text, and only the category", () => {
    const sent = payloadOf(item(shape), { category_id: category(2, shape) });
    expect(sent).toEqual({ category_id: category(2, shape) });
    expect(typeof sent.category_id).toBe("string");
  });

  it("choosing Uncategorized sends an explicit null: that is how a category is cleared", () => {
    const sent = payloadOf(item(shape), { category_id: null });
    expect(sent).toEqual({ category_id: null });
    expect("category_id" in sent).toBe(true);
  });

  it("an item without a category that is given one sends it", () => {
    expect(payloadOf(item(shape, { category_id: null }), { category_id: category(3, shape) })).toEqual({ category_id: category(3, shape) });
  });

  it("an item without a category that stays without one sends no category", () => {
    expect(payloadOf(item(shape, { category_id: null }), { notes: "x" })).toEqual({ notes: "x" });
  });

  it("an item whose category is not in the list keeps it: untouched, nothing is sent; replaced, the new one is sent", () => {
    const orphan = fakeUuid(9999);
    const stranded = item(shape, { category_id: shape === "uuid" ? orphan : "9999" });
    expect(payloadOf(stranded, { notes: "x" })).toEqual({ notes: "x" });
    expect(payloadOf(stranded, { category_id: category(1, shape) })).toEqual({ category_id: category(1, shape) });
    expect(payloadOf(stranded, { category_id: null })).toEqual({ category_id: null });
  });

  it("switching to another category and back before saving sends nothing: the form holds what the item holds", () => {
    expect(payloadOf(item(shape), { category_id: category(0, shape) })).toEqual({});
  });
});

describe("buildPayload: the category id is compared as an id, not as text", () => {
  it("a uuid in capitals is the same category as the stored lowercase uuid", () => {
    const med = item("uuid");
    expect(med.category_id).toBe(category(0));
    expect(payloadOf(med, { category_id: category(0).toUpperCase() })).toEqual({});
  });

  it("two different ids are different categories, whatever their length", () => {
    expect(payloadOf(item("bigint"), { category_id: "11" })).toEqual({ category_id: "11" }); // not "1"
    expect(payloadOf(item("bigint"), { category_id: "1" })).toEqual({});
  });
});

// ── buildPayload: creating ──────────────────────────────────────────────────────────────────────

describe("buildPayload: creating an item sends every field", () => {
  const NEW_FIELDS = ["name", "barcode", "photo_url", "unit", "stock", "threshold", "vendor_url", "notes", "category_id"];

  it("sends all nine fields with their defaults, an explicit null category, and no supplier key when none was typed", () => {
    const sent = payloadOf(null, { barcode: "0099001122" });
    expect(sent).toEqual({
      name: "",
      barcode: "0099001122",
      photo_url: null,
      unit: "units",
      stock: 0,
      threshold: 0,
      vendor_url: null,
      notes: null,
      category_id: null,
    });
    expect(Object.keys(sent).sort()).toEqual([...NEW_FIELDS].sort());
    expect("supplier_order_number" in sent).toBe(false); // a database that has not been migrated yet still takes the item
  });

  it("sends what was typed: the category id, the supplier order number exactly, and the numbers as numbers", () => {
    const sent = payloadOf(null, {
      name: "Test syrup, 100 mL",
      barcode: "0099001122",
      supplier_order_number: " 00417-B ",
      category_id: category(2),
      unit: "bottles",
      stock: "7",
      threshold: "3",
      vendor_url: "https://supplier.example/syrup",
      notes: "Shake well before use",
    });
    expect(sent).toEqual({
      name: "Test syrup, 100 mL",
      barcode: "0099001122",
      photo_url: null,
      unit: "bottles",
      stock: 7,
      threshold: 3,
      vendor_url: "https://supplier.example/syrup",
      notes: "Shake well before use",
      category_id: category(2),
      supplier_order_number: "00417-B",
    });
  });

  it("every key it sends is a key of the form, so the API's field names can be matched to a form field", () => {
    for (const key of Object.keys(payloadOf(null, { barcode: "1", supplier_order_number: "x" }))) expect(isFormKey(key), key).toBe(true);
  });
});

// ── buildPayload: an unnamed item ───────────────────────────────────────────────────────────────

describe("buildPayload: an unnamed item (created by a scan) can be completed", () => {
  // The server clears the "needs review" flag on every successful save, so saving is how an item is reviewed. A save with an
  // empty body is refused ("Nothing to update"), so a form with no other change sends the one field that cannot change anything:
  // the name as it is. For a scan-created item that is null, and the server stores null where null already is.
  it("with nothing else changed, sends only the empty name", () => {
    expect(payloadOf(unnamedItem())).toEqual({ name: null });
  });

  it("a name that is only blanks is still the empty name", () => {
    expect(payloadOf(unnamedItem(), { name: "   " })).toEqual({ name: null });
  });

  it("with a name typed, sends the name", () => {
    expect(payloadOf(unnamedItem(), { name: "Ondansetron 4 mg, ODT" })).toEqual({ name: "Ondansetron 4 mg, ODT" });
  });

  it("with only a category chosen, sends only the category: the save is not empty, so no name is added", () => {
    expect(payloadOf(unnamedItem(), { category_id: category(2) })).toEqual({ category_id: category(2) });
  });

  it("with only a supplier order number typed, sends only that", () => {
    expect(payloadOf(unnamedItem(), { supplier_order_number: "0092" })).toEqual({ supplier_order_number: "0092" });
  });

  it("an item that is not flagged as unnamed and has nothing changed sends nothing (the caller says 'No changes to save.')", () => {
    expect(isEmptyPayload(payloadOf(item()))).toBe(true);
  });

  it("an item that carries the flag but already has a name keeps that name as the field that is sent", () => {
    expect(payloadOf(item("uuid", { is_unnamed: true }))).toEqual({ name: "Ibuprofen 200 mg, tablets" });
  });
});

describe("isEmptyPayload", () => {
  it.each([
    ["no key", {}, true],
    ["a key whose value is null (a clear is a change)", { category_id: null }, false],
    ["a key whose value is zero", { stock: 0 }, false],
    ["a key whose value is an empty string", { notes: "" }, false],
  ] as const)("%s", (_title, payload, empty) => {
    expect(isEmptyPayload(payload)).toBe(empty);
  });
});

// ── planSupplier ────────────────────────────────────────────────────────────────────────────────

describe("planSupplier: what happens to the supplier order number on save", () => {
  const withSupplier = (value: string | null): Medication => item("uuid", { supplier_order_number: value });

  const CASES: ReadonlyArray<{ title: string; typed: string; loaded: Medication | null; expected: { send: boolean; value: string | null } }> = [
    { title: "create, nothing typed: not sent (keeps creating possible before the migration)", typed: "", loaded: null, expected: { send: false, value: null } },
    { title: "create, blanks only: not sent", typed: "   ", loaded: null, expected: { send: false, value: null } },
    { title: "create, a code with leading zeros", typed: "0092", loaded: null, expected: { send: true, value: "0092" } },
    { title: "create, letters and punctuation", typed: "00417-B", loaded: null, expected: { send: true, value: "00417-B" } },
    { title: "create, surrounding spaces are not part of the code", typed: "  AX-1182/4  ", loaded: null, expected: { send: true, value: "AX-1182/4" } },
    { title: "create, inner spaces and case are kept", typed: "Ab  12c", loaded: null, expected: { send: true, value: "Ab  12c" } },
    { title: "edit, unchanged: not sent", typed: "0092", loaded: withSupplier("0092"), expected: { send: false, value: "0092" } },
    { title: "edit, unchanged apart from surrounding spaces: not sent", typed: " 0092 ", loaded: withSupplier("0092"), expected: { send: false, value: "0092" } },
    { title: "edit, changed", typed: "0093", loaded: withSupplier("0092"), expected: { send: true, value: "0093" } },
    { title: "edit, changed only in letter case: that is a change", typed: "ab-1", loaded: withSupplier("AB-1"), expected: { send: true, value: "ab-1" } },
    { title: "edit, leading zeros dropped: that is a change", typed: "92", loaded: withSupplier("0092"), expected: { send: true, value: "92" } },
    { title: "edit, cleared: sent as null", typed: "", loaded: withSupplier("0092"), expected: { send: true, value: null } },
    { title: "edit, blanks only: sent as null", typed: "  ", loaded: withSupplier("0092"), expected: { send: true, value: null } },
    { title: "edit, none before and none now: not sent", typed: "", loaded: withSupplier(null), expected: { send: false, value: null } },
    { title: "edit, none before and a code now", typed: "00417-B", loaded: withSupplier(null), expected: { send: true, value: "00417-B" } },
    { title: "edit, a code made of digits only is still text", typed: "000000", loaded: withSupplier(null), expected: { send: true, value: "000000" } },
    { title: "edit, looks like a formula: kept as typed, it is text", typed: "=1+1", loaded: withSupplier(null), expected: { send: true, value: "=1+1" } },
    { title: "edit, looks like a number in scientific notation", typed: "1E5", loaded: withSupplier(null), expected: { send: true, value: "1E5" } },
    { title: "edit, an invisible character inside is not removed (the server refuses it and says so)", typed: "AB​12", loaded: withSupplier(null), expected: { send: true, value: "AB​12" } },
    { title: "edit, exactly 64 characters", typed: "A".repeat(64), loaded: withSupplier(null), expected: { send: true, value: "A".repeat(64) } },
    { title: "edit, 65 characters are still planned as typed: they are never cut to 64", typed: "A".repeat(65), loaded: withSupplier(null), expected: { send: true, value: "A".repeat(65) } },
  ];

  it.each(CASES)("$title", ({ typed, loaded, expected }) => {
    const form = formOf(loaded, { supplier_order_number: typed });
    expect(planSupplier(form, loaded)).toEqual(expected);
  });

  it("the plan and the payload agree: the payload carries the supplier key exactly when the plan says send", () => {
    for (const { typed, loaded } of CASES) {
      const form = formOf(loaded, { supplier_order_number: typed, barcode: loaded === null ? "0099" : formOf(loaded).barcode });
      const plan = planSupplier(form, loaded);
      const payload = buildPayload(form, plan, loaded);
      expect("supplier_order_number" in payload, typed).toBe(plan.send);
      if (plan.send) expect(payload.supplier_order_number).toBe(plan.value);
    }
  });
});

// ── Limits on the text fields (nothing is cut short silently) ─────────────────────────────────────

describe("formProblems: text that is too long is reported, never cut", () => {
  const withUnit = (unit: string): Medication => item("uuid", { unit });

  it("the limits are the ones the server enforces: 64 for the supplier order number, 60 for a category name, 40 for the unit", () => {
    expect(SUPPLIER_ORDER_NUMBER_MAX_LENGTH).toBe(64);
    expect(CATEGORY_NAME_MAX_LENGTH).toBe(60);
    expect(UNIT_MAX_LENGTH).toBe(40);
  });

  it("the supplier message is the server's own wording, so the two can never say different things", () => {
    const server = parseSupplierOrderNumber("x".repeat(SUPPLIER_ORDER_NUMBER_MAX_LENGTH + 1));
    expect(server.ok).toBe(false);
    const problems = formProblems(formOf(item(), { supplier_order_number: "x".repeat(65) }), item());
    expect(problems.supplier_order_number?.message).toBe(server.ok ? "" : server.reason);
    expect(problems.supplier_order_number).toMatchObject({ length: 65, max: 64 });
  });

  const SUPPLIER_LENGTHS: ReadonlyArray<{ title: string; text: string; tooLong: boolean }> = [
    { title: "1 character", text: "A", tooLong: false },
    { title: "exactly 64 characters", text: "A".repeat(64), tooLong: false },
    { title: "64 characters inside spaces", text: ` ${"A".repeat(64)} `, tooLong: false },
    { title: "65 characters", text: "A".repeat(65), tooLong: true },
    { title: "70 characters", text: "0123456789".repeat(7), tooLong: true },
    { title: "64 emoji (128 UTF-16 units, 64 characters to a person and to the server)", text: "💊".repeat(64), tooLong: false },
    { title: "65 emoji", text: "💊".repeat(65), tooLong: true },
    { title: "64 letters with accents written as base letter plus accent", text: "é".repeat(64), tooLong: false },
  ];

  it.each(SUPPLIER_LENGTHS)("a supplier order number of $title: too long = $tooLong (edit)", ({ text, tooLong }) => {
    const problems = formProblems(formOf(item(), { supplier_order_number: text }), item());
    expect(problems.supplier_order_number !== undefined).toBe(tooLong);
  });

  it.each(SUPPLIER_LENGTHS)("a supplier order number of $title: too long = $tooLong (create)", ({ text, tooLong }) => {
    const problems = formProblems(formOf(null, { supplier_order_number: text }), null);
    expect(problems.supplier_order_number !== undefined).toBe(tooLong);
  });

  it("agrees with the server on every one of those lengths", () => {
    for (const { text, tooLong } of SUPPLIER_LENGTHS) {
      expect(parseSupplierOrderNumber(text).ok, JSON.stringify(text)).toBe(!tooLong);
    }
  });

  it("an over-long supplier order number that is not being changed is not a problem: only what is sent is checked", () => {
    const legacy = item("uuid", { supplier_order_number: "L".repeat(70) });
    expect(formProblems(formOf(legacy), legacy)).toEqual({});
    expect(formProblems(formOf(legacy, { supplier_order_number: `  ${"L".repeat(70)}  ` }), legacy)).toEqual({}); // same text, spaces only
    expect(formProblems(formOf(legacy, { supplier_order_number: "L".repeat(71) }), legacy).supplier_order_number).toBeDefined(); // longer: it is a change
  });

  it("an invisible character is not a length problem: the server refuses it and the page explains it after the save", () => {
    expect(formProblems(formOf(item(), { supplier_order_number: "AB​12" }), item())).toEqual({});
  });

  it("an over-long code that also holds an invisible character is left to the server, which names the invisible character first", () => {
    // The shared parser checks invisible characters before length. The page must not show a length message the server would not
    // give for the same text: it stays quiet, and the save is answered with the invisible-character message and its hint.
    const text = `${"A".repeat(70)}​`;
    const server = parseSupplierOrderNumber(text);
    expect(server).toEqual({ ok: false, reason: SUPPLIER_ORDER_NUMBER_INVISIBLE_REASON });
    expect(formProblems(formOf(item(), { supplier_order_number: text }), item())).toEqual({});
  });

  const UNIT_LENGTHS: ReadonlyArray<{ title: string; text: string; tooLong: boolean }> = [
    { title: "empty (the server turns it into units)", text: "", tooLong: false },
    { title: "exactly 40 characters", text: "u".repeat(40), tooLong: false },
    { title: "40 characters inside spaces", text: ` ${"u".repeat(40)} `, tooLong: false },
    { title: "41 characters", text: "u".repeat(41), tooLong: true },
    { title: "40 emoji", text: "💊".repeat(40), tooLong: false },
    { title: "41 emoji", text: "💊".repeat(41), tooLong: true },
  ];

  it.each(UNIT_LENGTHS)("a unit of $title: too long = $tooLong (edit)", ({ text, tooLong }) => {
    const problems = formProblems(formOf(withUnit("bottles"), { unit: text }), withUnit("bottles"));
    expect(problems.unit !== undefined).toBe(tooLong);
    if (tooLong) {
      expect(problems.unit?.message).toBe("Unit is too long (maximum 40 characters).");
      expect(problems.unit?.max).toBe(40);
    }
  });

  it.each(UNIT_LENGTHS)("a unit of $title: too long = $tooLong (create)", ({ text, tooLong }) => {
    expect(formProblems(formOf(null, { unit: text }), null).unit !== undefined).toBe(tooLong);
  });

  it("a stored unit that is longer than 40 characters is not a problem while it is not being changed", () => {
    const legacy = withUnit("W".repeat(45));
    expect(formProblems(formOf(legacy), legacy)).toEqual({});
    expect(formProblems(formOf(legacy, { unit: "W".repeat(46) }), legacy).unit).toBeDefined();
    expect(formProblems(formOf(legacy, { unit: "boxes" }), legacy)).toEqual({}); // shortened: fine
  });

  it("a form with no problems reports none, and the first problem is the one higher up the form", () => {
    expect(formProblems(formOf(item(), { notes: "x" }), item())).toEqual({});
    expect(firstProblemField({})).toBeNull();
    const both = formProblems(formOf(item(), { supplier_order_number: "x".repeat(65), unit: "u".repeat(41) }), item());
    expect(Object.keys(both).sort()).toEqual(["supplier_order_number", "unit"]);
    expect(firstProblemField(both)).toBe("supplier_order_number");
    expect(firstProblemField({ unit: both.unit })).toBe("unit");
  });
});

describe("categoryNameProblem", () => {
  const CASES: ReadonlyArray<{ title: string; name: string; tooLong: boolean }> = [
    { title: "empty", name: "", tooLong: false },
    { title: "a short name", name: "Vaccines", tooLong: false },
    { title: "exactly 60 characters", name: "C".repeat(60), tooLong: false },
    { title: "60 characters inside spaces", name: `  ${"C".repeat(60)}  `, tooLong: false },
    { title: "61 characters", name: "C".repeat(61), tooLong: true },
    { title: "60 emoji", name: "💊".repeat(60), tooLong: false },
    { title: "61 emoji", name: "💊".repeat(61), tooLong: true },
  ];

  it.each(CASES)("a name of $title: too long = $tooLong", ({ name, tooLong }) => {
    const problem = categoryNameProblem(name);
    expect(problem !== null).toBe(tooLong);
    if (problem) {
      expect(problem.message).toBe("Category name is too long (maximum 60 characters).");
      expect(problem).toMatchObject({ max: 60, length: [...name.trim()].length });
    }
  });
});

// ── rebaseForm: the server's row becomes the baseline ───────────────────────────────────────────

describe("rebaseForm: when the server's row becomes the new baseline, the fields the person did not touch follow it", () => {
  // The form was opened on `opened`. Meanwhile another person changed the stock, the category and the notes. The person then
  // typed a supplier order number and pressed Save, and the server answered with its current row, `saved`.
  const opened = item("uuid");
  const saved = item("uuid", { stock: 7, category_id: category(2), notes: "Moved to the top shelf" });
  const typed = formOf(opened, { supplier_order_number: "NEW-0042" });

  it("untouched fields take the saved row's values and the typed one stays", () => {
    expect(rebaseForm(typed, opened, saved)).toEqual({ ...formFromMedication(saved), supplier_order_number: "NEW-0042" });
  });

  it("so a second save carries only what the person typed", () => {
    const rebased = rebaseForm(typed, opened, saved);
    expect(buildPayload(rebased, planSupplier(rebased, saved), saved)).toEqual({ supplier_order_number: "NEW-0042" });
  });

  it("control: without the rebase, the second save would put back the stale stock, notes and category", () => {
    expect(buildPayload(typed, planSupplier(typed, saved), saved)).toEqual({
      supplier_order_number: "NEW-0042",
      stock: 18,
      notes: "Keep in the blue cabinet",
      category_id: category(0),
    });
  });

  it("a field typed back to the value it was opened with counts as untouched", () => {
    const retyped = formOf(opened, { stock: "18", supplier_order_number: "NEW-0042" });
    expect(rebaseForm(retyped, opened, saved).stock).toBe("7");
  });

  it("a field the person changed keeps their text, whatever the saved row holds", () => {
    const edited = formOf(opened, { stock: "50", notes: "Typed note", category_id: category(4) });
    expect(rebaseForm(edited, opened, saved)).toMatchObject({ stock: "50", notes: "Typed note", category_id: category(4) });
  });

  it("a new item (nothing was loaded): fields still at their starting values follow the saved row, typed ones stay", () => {
    const savedNew = item("uuid", { id: 777, name: "Test syrup", barcode: "0099", stock: 0, threshold: 0, unit: "units", category_id: null, supplier_order_number: null, notes: null, vendor_url: null, photo_url: null });
    const typedNew = formOf(null, { name: "Test syrup", barcode: "0099", category_id: category(1) });
    expect(rebaseForm(typedNew, null, savedNew)).toEqual({
      name: "Test syrup",
      barcode: "0099",
      supplier_order_number: "",
      photo_url: null,
      stock: "0",
      threshold: "0",
      unit: "units",
      vendor_url: "",
      notes: "",
      category_id: category(1),
    });
  });

  it("changes nothing when the saved row is the row the form was opened on", () => {
    const edited = formOf(opened, { notes: "Typed note" });
    expect(rebaseForm(edited, opened, opened)).toEqual(edited);
  });

  it("is idempotent: rebasing onto the same saved row twice gives the same form", () => {
    const once = rebaseForm(typed, opened, saved);
    expect(rebaseForm(once, saved, saved)).toEqual(once);
  });
});

// ── findNotStored: the read-after-write check ───────────────────────────────────────────────────

describe("findNotStored: only what was sent can be missing", () => {
  const saved = (overrides: Partial<Medication> = {}): Medication => item("uuid", overrides);

  it("nothing is missing when the saved row carries what was sent", () => {
    expect(findNotStored(saved({ category_id: category(2), supplier_order_number: "NEW-1" }), { category_id: category(2), supplier_order_number: "NEW-1" })).toEqual([]);
  });

  it("a category that was sent and did not come back is named", () => {
    expect(findNotStored(saved({ category_id: category(0) }), { category_id: category(2) })).toEqual(["category"]);
  });

  it("a cleared category that did not come back cleared is named", () => {
    expect(findNotStored(saved({ category_id: category(0) }), { category_id: null })).toEqual(["category"]);
    expect(findNotStored(saved({ category_id: null }), { category_id: null })).toEqual([]);
  });

  it("a supplier order number that was sent and did not come back is named, a cleared one too", () => {
    expect(findNotStored(saved({ supplier_order_number: "0092" }), { supplier_order_number: "NEW-1" })).toEqual(["supplier order number"]);
    expect(findNotStored(saved({ supplier_order_number: "0092" }), { supplier_order_number: null })).toEqual(["supplier order number"]);
    expect(findNotStored(saved({ supplier_order_number: null }), { supplier_order_number: null })).toEqual([]);
  });

  it("both are named together, category first", () => {
    expect(findNotStored(saved({ category_id: category(0), supplier_order_number: "0092" }), { category_id: category(2), supplier_order_number: "NEW-1" })).toEqual([
      "category",
      "supplier order number",
    ]);
  });

  it("a category that was NOT sent is not checked: whatever the row holds is what another person left there", () => {
    expect(findNotStored(saved({ category_id: category(2) }), { notes: "Checked on the shelf" })).toEqual([]);
    expect(findNotStored(saved({ category_id: null }), { notes: "Checked on the shelf" })).toEqual([]);
  });

  it("a supplier order number that was NOT sent is not checked", () => {
    expect(findNotStored(saved({ supplier_order_number: "ZZ-7" }), { notes: "Checked on the shelf" })).toEqual([]);
  });

  it("ids are compared as ids: a bigint id that came back as a number-like string, or a uuid in capitals, is the same", () => {
    expect(findNotStored(saved({ category_id: "3" }), { category_id: "3" })).toEqual([]);
    expect(findNotStored(saved({ category_id: category(2).toUpperCase() }), { category_id: category(2) })).toEqual([]);
  });
});

// ── Small text helpers ──────────────────────────────────────────────────────────────────────────

describe("trimmedOrNull / notesOrNull / unitOrDefault / countOf", () => {
  it.each([
    ["text", "  Aspirin  ", "Aspirin"],
    ["blank", "   ", null],
    ["empty", "", null],
    ["null", null, null],
    ["undefined", undefined, null],
  ] as const)("trimmedOrNull: %s", (_title, input, expected) => {
    expect(trimmedOrNull(input)).toBe(expected);
  });

  it.each([
    ["text keeps its own spacing", "  line one\nline two  ", "  line one\nline two  "],
    ["blank is none", " \n\t ", null],
    ["empty is none", "", null],
    ["null is none", null, null],
  ] as const)("notesOrNull: %s", (_title, input, expected) => {
    expect(notesOrNull(input)).toBe(expected);
  });

  it.each([
    ["boxes", "boxes"],
    ["  boxes  ", "boxes"],
    ["", "units"],
    ["   ", "units"],
  ] as const)("unitOrDefault(%j) = %j", (input, expected) => {
    expect(unitOrDefault(input)).toBe(expected);
  });

  it.each([
    ["", 0],
    ["0", 0],
    ["7", 7],
    ["007", 7],
    ["2147483647", 2147483647],
  ] as const)("countOf(%j) = %j", (input, expected) => {
    expect(countOf(input)).toBe(expected);
  });
});

describe("displayName / supplierOf / stockStatus (what a list row shows)", () => {
  it.each([
    ["a name", "  Aspirin 81 mg  ", "Aspirin 81 mg"],
    ["a blank name", "   ", null],
    ["no name", null, null],
  ] as const)("displayName: %s", (_title, name, expected) => {
    expect(displayName({ name })).toBe(expected);
  });

  it.each([
    ["a code keeps its leading zeros", " 0092 ", "0092"],
    ["a blank code is not set", "  ", null],
    ["no code is not set", null, null],
  ] as const)("supplierOf: %s", (_title, supplier_order_number, expected) => {
    expect(supplierOf({ supplier_order_number })).toBe(expected);
  });

  it.each([
    ["no stock is Out, even when the threshold is 0", { stock: 0, threshold: 0 }, "out"],
    ["no stock is Out", { stock: 0, threshold: 10 }, "out"],
    ["at the threshold is Low", { stock: 10, threshold: 10 }, "low"],
    ["below the threshold is Low", { stock: 3, threshold: 10 }, "low"],
    ["above the threshold is OK", { stock: 11, threshold: 10 }, "ok"],
  ] as const)("stockStatus: %s", (_title, levels, expected) => {
    expect(stockStatus(levels)).toBe(expected);
  });
});

describe("isFormKey, FORM_KEYS, isRecord", () => {
  it("recognizes exactly the form's keys", () => {
    for (const key of FORM_KEYS) expect(isFormKey(key)).toBe(true);
    for (const other of ["id", "is_unnamed", "created_at", "", "constructor", "toString", "Name"]) expect(isFormKey(other), other).toBe(false);
  });

  it("every key of an empty form is a form key", () => {
    expect(Object.keys(EMPTY_FORM).sort()).toEqual([...FORM_KEYS].sort());
  });

  it.each([
    [{}, true],
    [{ a: 1 }, true],
    [[], false],
    [null, false],
    [undefined, false],
    ["text", false],
    [3, false],
  ] as const)("isRecord(%j) = %j", (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});

describe("toMedication / toCategory read what the server sends", () => {
  it("reads a row, turning a numeric category id into text and a missing supplier column into null", () => {
    const row = { id: 7, name: "X", barcode: "0012", stock: 3, threshold: 2, unit: "units", category_id: 4, is_unnamed: false };
    expect(toMedication(row)).toMatchObject({ id: 7, barcode: "0012", category_id: "4", supplier_order_number: null });
  });

  it.each([
    ["not an object", "oops"],
    ["an array", [{ id: 1 }]],
    ["null", null],
    ["no id", { name: "X", barcode: "1" }],
    ["id 0", { id: 0, barcode: "1" }],
    ["a negative id", { id: -3, barcode: "1" }],
    ["a text id", { id: "abc", barcode: "1" }],
  ])("toMedication refuses %s", (_title, body) => {
    expect(toMedication(body)).toBeNull();
  });

  it("reads a category and refuses one without an id or a name", () => {
    expect(toCategory({ id: fakeUuid(1), name: "Vaccines", created_at: null })).toEqual({ id: fakeUuid(1), name: "Vaccines", created_at: null });
    expect(toCategory({ id: 5, name: "Dental" })).toMatchObject({ id: "5", name: "Dental" });
    for (const body of [null, "x", [], { name: "No id" }, { id: 3, name: "   " }, { id: 3 }, { id: "", name: "x" }]) {
      expect(toCategory(body), JSON.stringify(body)).toBeNull();
    }
  });
});

// ── Category choices ────────────────────────────────────────────────────────────────────────────

describe.each(SHAPES)("category choices (%s ids)", (shape) => {
  const categories = buildCategories(shape);

  it("formCategoryOptions: Uncategorized first, then every category by name, then the create command last", () => {
    const options = formCategoryOptions(categories, null, false);
    expect(options[0]).toEqual({ value: "", label: UNCATEGORIZED_LABEL });
    expect(options.at(-1)).toEqual({ value: NEW_CATEGORY_VALUE, label: "+ Create new category…", kind: "action" });
    expect(options.slice(1, -1)).toEqual(categories.map((c) => ({ value: c.id, label: c.name })));
    expect(options.map((o) => o.value)).toHaveLength(categories.length + 2);
  });

  it("formCategoryOptions: a current category that is not in the list is offered second, labelled honestly", () => {
    const missing = shape === "uuid" ? fakeUuid(404) : "404";
    expect(formCategoryOptions(categories, missing, false)[1]).toEqual({ value: missing, label: "Current category (name unavailable)" });
    expect(formCategoryOptions([], missing, true)[1]).toEqual({ value: missing, label: "Current category (loading…)" });
    expect(formCategoryOptions([], null, false).map((o) => o.label)).toEqual([UNCATEGORIZED_LABEL, "+ Create new category…"]);
  });

  it("formCategoryOptions: a category with a blank name is offered as Unnamed category, never as an empty row", () => {
    const blank: Category = { id: category(7, shape), name: "   ", created_at: null };
    expect(formCategoryOptions([blank], null, false)[1].label).toBe("Unnamed category");
    expect(categoryName(blank)).toBe("Unnamed category");
    expect(categoryName(categories[0])).toBe(CATEGORY_NAMES[0]);
  });

  it("no option value is ever a number, NaN or the word null: ids stay opaque text", () => {
    for (const option of formCategoryOptions(categories, null, false)) {
      expect(typeof option.value).toBe("string");
      expect(option.value).not.toMatch(/NaN|null|undefined/);
    }
  });

  it("listFilterOptions: every category with its count, Uncategorized, and Category unavailable only when asked", () => {
    const counts: CategoryCounts = {
      all: 27,
      uncategorized: 3,
      unknown: 2,
      byId: Object.fromEntries(categories.map((c, i) => [c.id, i + 1])),
    };
    const without = listFilterOptions(categories, counts, false);
    expect(without[0]).toEqual({ value: "all", label: "All categories (27)" });
    expect(without.slice(1, -1).map((o) => o.label)).toEqual(categories.map((c, i) => `${c.name} (${i + 1})`));
    expect(without.at(-1)).toEqual({ value: "uncategorized", label: "Uncategorized (3)" });
    const withUnknown = listFilterOptions(categories, counts, true);
    expect(withUnknown.at(-1)).toEqual({ value: UNKNOWN_CATEGORY_ID, label: "Category unavailable (2)" });
    expect(withUnknown).toHaveLength(without.length + 1);
  });

  it("listFilterOptions: a category with no entry in the counts reads (0)", () => {
    const counts: CategoryCounts = { all: 0, uncategorized: 0, unknown: 0, byId: {} };
    expect(listFilterOptions(categories, counts, false)[1].label).toBe(`${categories[0].name} (0)`);
  });

  it("categoryLabel: a category by name, none as Uncategorized, an id that is not in the list as Category unavailable", () => {
    expect(categoryLabel(categories[2].id, categories)).toEqual({ kind: "category", title: "Antibiotics" });
    expect(categoryLabel(null, categories)).toEqual({ kind: "uncategorized", title: "Uncategorized" });
    expect(categoryLabel("  ", categories)).toEqual({ kind: "uncategorized", title: "Uncategorized" });
    expect(categoryLabel(shape === "uuid" ? fakeUuid(404) : "404", categories)).toEqual({ kind: "unknown", title: "Category unavailable" });
    expect(categoryLabel(categories[0].id, [{ ...categories[0], name: " " }])).toEqual({ kind: "category", title: "Unnamed category" });
  });

  it("mergeCategories: drops repeats and ids that are empty, and sorts the way the Inventory tab does", () => {
    const created: Category = { id: category(9, shape), name: "Dental", created_at: null };
    const repeat: Category = { ...categories[1] };
    const merged = mergeCategories([...categories].reverse(), [created, repeat, { id: "", name: "No id", created_at: null }]);
    expect(merged.map((c) => c.name)).toEqual(["Allergy & Cold", "Antibiotics", "Dental", "First Aid", "IV & Fluids", "Pain & Fever", "PPE & Gloves"]);
    expect(merged).toHaveLength(categories.length + 1);
  });

  it("mergeCategories: names that read alike keep a stable order by id", () => {
    const a: Category = { id: category(1, shape), name: "Same", created_at: null };
    const b: Category = { id: category(2, shape), name: "same", created_at: null };
    expect(mergeCategories([b, a], []).map((c) => c.id)).toEqual(mergeCategories([a, b], []).map((c) => c.id));
  });

  it("a category in both lists is the same category even when one id is in capitals", () => {
    if (shape !== "uuid") return;
    const upper: Category = { ...categories[0], id: categories[0].id.toUpperCase() };
    expect(mergeCategories(categories, [upper])).toHaveLength(categories.length);
  });
});

describe("filterToValue / valueToFilter", () => {
  it.each([
    [{ kind: "all" } as const, "all"],
    [{ kind: "uncategorized" } as const, "uncategorized"],
    [{ kind: "category", id: "abc" } as const, "abc"],
    [UNKNOWN_CATEGORY_FILTER, UNKNOWN_CATEGORY_ID],
  ])("%j <-> %s", (filter, value) => {
    expect(filterToValue(filter)).toBe(value);
    expect(valueToFilter(value)).toEqual(filter);
  });

  it("a uuid and a digit string come back as a category filter with that exact id", () => {
    for (const id of [fakeUuid(3), "17"]) expect(valueToFilter(id)).toEqual({ kind: "category", id });
  });
});

describe("describedBy", () => {
  it.each([
    [[], undefined],
    [[false, null, undefined, ""], undefined],
    [["a"], "a"],
    [["a", false, "b", null, "c"], "a b c"],
  ] as const)("%j -> %j", (ids, expected) => {
    expect(describedBy(...ids)).toBe(expected);
  });
});

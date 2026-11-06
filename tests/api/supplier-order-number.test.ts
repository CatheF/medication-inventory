// Requirement-driven tests: the supplier ordering number.
//
//   "Store it as text so leading zeros, letters, and punctuation survive."
//   "Keep it separate from item name and barcode."
//   "Preserve existing items without a code; display missing information honestly."
//   "Do not infer supplier codes from barcodes or external catalogs, or automatically strip codes from existing item names."
//   Deploy-order independence: the app must work both BEFORE and AFTER the migration that adds the column.
//
// Both id shapes are exercised. The database is the fake in tests/helpers/fake-supabase.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Medication } from "@/lib/db";
import {
  bodyList,
  bodyRecord,
  errorTextOf,
  ID_SHAPES,
  itemNamed,
  omitKeys,
  snapshotDb,
  storedMedication,
} from "../helpers/api-test-kit";
import { installFake, LIVE_AFTER_MIGRATION, LIVE_BEFORE_MIGRATION, type FakeSupabase } from "../helpers/fake-supabase";
import { seedStandard } from "../helpers/fixtures-extra";
import { api } from "../helpers/route-client";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

/** Typical supplier codes plus the values spreadsheets and number parsers love to mangle. */
const ROUND_TRIP_CODES: readonly string[] = [
  "00417-B", // leading zeros + letter + dash
  "0092", // digits only, leading zeros
  "AX-1182/4", // letters, dash, slash
  "000000", // only zeros
  "1E5", // looks like scientific notation
  "12345678901234567890", // more digits than a double can hold
  "00-1.50", // looks like a price
  "2026-11-05", // looks like a date
  "=1+1", // looks like a formula
  "NÅ-00ß", // non-ASCII letters
  "日本語-001", // Japanese
  "\u{1F48A}-01", // emoji
  "ABC 123 / x", // internal spaces are part of the code
  "a".repeat(64), // exactly the maximum length
];

const FORBIDDEN_CHARACTERS: ReadonlyArray<readonly [string, string]> = [
  ["a line feed", "AX\n1182"],
  ["a tab", "AX\t1182"],
  ["a CRLF line break", "AX\r\n1182"],
  ["a NUL character", "AX\u00001182"],
  ["a DEL character", "AX\u007f1182"],
  ["a C1 control character (NEL)", "AX\u00851182"],
  ["a Unicode line separator", "AX 1182"],
  ["a Unicode paragraph separator", "AX 1182"],
  ["a zero-width space (invisible)", "AX​1182"],
  ["a left-to-right mark (invisible)", "AX‎1182"],
  ["a right-to-left override (changes how the code reads)", "AX‮1182"],
  ["a byte order mark", "AX﻿1182"],
  ["a soft hyphen (invisible)", "AX­1182"],
  ["a trailing NUL (not whitespace, so it can't be trimmed away)", "AX1182\u0000"],
];

const NOT_TEXT: ReadonlyArray<readonly [string, unknown]> = [
  ["the number 417", 417],
  ["the number 92 (what 0092 becomes when a client parses it)", 92],
  ["zero", 0],
  ["a decimal number", 4.17],
  ["true", true],
  ["false", false],
  ["an array", ["00417-B"]],
  ["an empty array", []],
  ["an object", { value: "00417-B" }],
];

async function reload(id: number, barcode: string): Promise<{ list: unknown; byId: unknown; byBarcode: unknown }> {
  const listed = (await bodyList(await api.listItems())).find((m) => m.id === id);
  const byId = await bodyRecord(await api.getItem(id));
  const byBarcode = await bodyRecord(await api.lookup(barcode));
  return { list: listed?.supplier_order_number, byId: byId.supplier_order_number, byBarcode: byBarcode.supplier_order_number };
}

describe.each(ID_SHAPES)("supplier order number on the $label", ({ options }) => {
  let fake: FakeSupabase;
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake(options);
    ({ medications } = seedStandard(fake));
  });

  describe("round trip: save, reload, and the stored text", () => {
    it.each(ROUND_TRIP_CODES)("keeps %j exactly when an item is created: response, list, item, barcode lookup and stored text", async (code) => {
      const barcode = `RT-${code.length}-${code.charCodeAt(0)}`;
      const res = await api.createItem({ barcode, name: "Round trip item", supplier_order_number: code });
      expect(res.status).toBe(201);
      const created = await bodyRecord(res);
      expect(created.supplier_order_number).toBe(code);

      expect(await reload(created.id as number, barcode)).toEqual({ list: code, byId: code, byBarcode: code });
      const stored = storedMedication(fake, created.id as number);
      expect(stored.supplier_order_number).toBe(code); // still TEXT in the database: "0092" is not 92
      expect(typeof stored.supplier_order_number).toBe("string");
    });

    it.each(ROUND_TRIP_CODES)("keeps %j exactly when an existing item is edited", async (code) => {
      const item = itemNamed(medications, "Aspirin 81 mg"); // seeded without a supplier number
      expect(item.supplier_order_number).toBeNull();
      const res = await api.updateItem(item.id, { supplier_order_number: code });
      expect(res.status).toBe(200);
      expect((await bodyRecord(res)).supplier_order_number).toBe(code);
      expect(await reload(item.id, item.barcode)).toEqual({ list: code, byId: code, byBarcode: code });
      expect(storedMedication(fake, item.id).supplier_order_number).toBe(code);
    });

    it.each(ROUND_TRIP_CODES)(
      "keeps %j exactly when the Admin form saves it together with a changed name and the category_id the form always sends, and changes nothing else",
      async (code) => {
        const item = itemNamed(medications, "Aspirin 81 mg"); // seeded without a supplier number
        const before = await bodyRecord(await api.getItem(item.id));
        const sent = { name: "Aspirin 81 mg, chewable (renamed)", category_id: item.category_id, supplier_order_number: code };
        const res = await api.updateItem(item.id, sent);
        expect(res.status).toBe(200);
        expect((await bodyRecord(res)).supplier_order_number).toBe(code);
        expect(await reload(item.id, item.barcode)).toEqual({ list: code, byId: code, byBarcode: code });
        expect(storedMedication(fake, item.id).supplier_order_number).toBe(code);
        const after = await bodyRecord(await api.getItem(item.id));
        expect(after).toMatchObject({ name: sent.name, category_id: item.category_id });
        const moved = ["updated_at", "is_unnamed", "name", "supplier_order_number"];
        expect(omitKeys(after, ...moved)).toEqual(omitKeys(before, ...moved));
      }
    );

    it("keeps the three codes the owner named (00417-B, 0092, AX-1182/4) side by side on three different items", async () => {
      const a = itemNamed(medications, "Aspirin 81 mg");
      const b = itemNamed(medications, "Diphenhydramine");
      const c = itemNamed(medications, "Surgical masks");
      expect((await api.updateItem(a.id, { supplier_order_number: "00417-B" })).status).toBe(200);
      expect((await api.updateItem(b.id, { supplier_order_number: "0092" })).status).toBe(200);
      expect((await api.updateItem(c.id, { supplier_order_number: "AX-1182/4" })).status).toBe(200);
      const listed = await bodyList(await api.listItems());
      const byId = new Map(listed.map((m) => [m.id, m.supplier_order_number]));
      expect(byId.get(a.id)).toBe("00417-B");
      expect(byId.get(b.id)).toBe("0092");
      expect(byId.get(c.id)).toBe("AX-1182/4");
    });

    it("accepts 64 characters counted as characters (64 emoji are 128 UTF-16 units) and rejects the 65th", async () => {
      const ok = await api.createItem({ barcode: "LEN-1", name: "x", supplier_order_number: "\u{1F48A}".repeat(64) });
      expect(ok.status).toBe(201);
      const tooLong = await api.createItem({ barcode: "LEN-2", name: "x", supplier_order_number: "a".repeat(65) });
      expect(tooLong.status).toBe(400);
      const body = await bodyRecord(tooLong);
      expect(body.field).toBe("supplier_order_number");
      expect(errorTextOf(body)).toMatch(/64/);
    });

    it("trims whitespace at the two ends only: inner spaces, case and leading zeros stay exactly as typed", async () => {
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["  00417-B  ", "00417-B"],
        ["\t00417-B\n", "00417-B"],
        ["AX 1182 / 4", "AX 1182 / 4"],
        ["  AX  1182  ", "AX  1182"],
        ["  ab-Cd-0099", "ab-Cd-0099"],
      ];
      for (const [typed, saved] of cases) {
        const res = await api.createItem({ barcode: `TRIM-${typed.length}-${saved.length}`, name: "x", supplier_order_number: typed });
        expect(res.status).toBe(201);
        expect((await bodyRecord(res)).supplier_order_number).toBe(saved);
      }
    });

    it("counts the 64-character limit after trimming (64 characters plus padding is accepted)", async () => {
      const res = await api.createItem({ barcode: "PAD-1", name: "x", supplier_order_number: `  ${"b".repeat(64)}  ` });
      expect(res.status).toBe(201);
      expect((await bodyRecord(res)).supplier_order_number).toBe("b".repeat(64));
    });
  });

  describe("null, blank and omitted", () => {
    it("clears the supplier number when null is sent, and every reload shows it as null", async () => {
      const item = itemNamed(medications, "Acetaminophen 500 mg"); // seeded with 00417-B
      expect(item.supplier_order_number).toBe("00417-B");
      const res = await api.updateItem(item.id, { supplier_order_number: null });
      expect(res.status).toBe(200);
      expect((await bodyRecord(res)).supplier_order_number).toBeNull();
      expect(await reload(item.id, item.barcode)).toEqual({ list: null, byId: null, byBarcode: null });
      expect(storedMedication(fake, item.id).supplier_order_number).toBeNull();
    });

    it("clears the code when the Admin form saves it as null together with a changed name and the category_id, and keeps everything else", async () => {
      const item = itemNamed(medications, "Acetaminophen 500 mg"); // seeded with 00417-B and a category
      const before = await bodyRecord(await api.getItem(item.id));
      const sent = { name: "Acetaminophen 500 mg, tablets (renamed)", category_id: item.category_id, supplier_order_number: null };
      const res = await api.updateItem(item.id, sent);
      expect(res.status).toBe(200);
      expect(await reload(item.id, item.barcode)).toEqual({ list: null, byId: null, byBarcode: null });
      expect(storedMedication(fake, item.id).supplier_order_number).toBeNull();
      const after = await bodyRecord(await api.getItem(item.id));
      const moved = ["updated_at", "is_unnamed", "name", "supplier_order_number"];
      expect(after).toMatchObject({ name: sent.name, category_id: item.category_id });
      expect(omitKeys(after, ...moved)).toEqual(omitKeys(before, ...moved));
    });

    it.each([
      ["an empty string", ""],
      ["spaces", "   "],
      ["tabs and line breaks", " \t\n "],
    ])("clears the supplier number when the field is %s (a blank box means 'not set'), stored as null not as an empty string", async (_label, blank) => {
      const item = itemNamed(medications, "Acetaminophen 500 mg");
      const res = await api.updateItem(item.id, { supplier_order_number: blank });
      expect(res.status).toBe(200);
      expect((await bodyRecord(res)).supplier_order_number).toBeNull();
      expect(storedMedication(fake, item.id).supplier_order_number).toBeNull();
    });

    it.each([
      ["stock", { stock: 3 }],
      ["name", { name: "Acetaminophen 500 mg, tablets (renamed)" }],
      ["barcode", { barcode: "0000555000999" }],
      ["category", { category_id: null }],
      ["notes", { notes: "note" }],
    ])("leaves the supplier number untouched when only %s is edited (omitted means unchanged)", async (_label, patch) => {
      const item = itemNamed(medications, "Acetaminophen 500 mg");
      expect((await api.updateItem(item.id, patch)).status).toBe(200);
      expect((await bodyRecord(await api.getItem(item.id))).supplier_order_number).toBe("00417-B");
      expect(storedMedication(fake, item.id).supplier_order_number).toBe("00417-B");
    });

    it("does not send the supplier column to the database when the edit does not mention it, nor when a new item has none", async () => {
      const item = itemNamed(medications, "Acetaminophen 500 mg");
      fake.clearCalls();
      expect((await api.updateItem(item.id, { stock: 4 })).status).toBe(200);
      expect((await api.createItem({ barcode: "NOSUP-1", name: "No supplier number" })).status).toBe(201);
      for (const write of fake.writes()) {
        expect(JSON.stringify(write.payload)).not.toContain("supplier_order_number");
      }
    });

    it("creates an item with no supplier number as null (not an empty string, not missing)", async () => {
      const res = await api.createItem({ barcode: "NOSUP-2", name: "No supplier number" });
      expect(res.status).toBe(201);
      const created = await bodyRecord(res);
      expect(created).toHaveProperty("supplier_order_number", null);
      expect(storedMedication(fake, created.id as number).supplier_order_number).toBeNull();
    });

    it.each([
      ["null", null],
      ["an empty string", ""],
      ["spaces", "   "],
    ])("creates an item normally when the supplier number is %s", async (_label, value) => {
      const res = await api.createItem({ barcode: "NOSUP-3", name: "Blank supplier", supplier_order_number: value });
      expect(res.status).toBe(201);
      expect((await bodyRecord(res)).supplier_order_number).toBeNull();
    });

    it("shows items that never had a code honestly: null in the list, by id and by barcode (never an empty string or a made-up value)", async () => {
      const item = itemNamed(medications, "Alcohol prep pads");
      expect(item.supplier_order_number).toBeNull();
      expect(await reload(item.id, item.barcode)).toEqual({ list: null, byId: null, byBarcode: null });
    });
  });

  describe("rejecting values that would not read the same on screen and on paper", () => {
    it.each(FORBIDDEN_CHARACTERS)("rejects a supplier number containing %s: 400, the field name, a message, and nothing stored", async (_label, value) => {
      const before = snapshotDb(fake);
      const res = await api.createItem({ barcode: "BAD-1", name: "x", supplier_order_number: value });
      expect(res.status).toBe(400);
      const body = await bodyRecord(res);
      expect(body.field).toBe("supplier_order_number");
      expect(errorTextOf(body)).toMatch(/line breaks|control|invisible/i);
      expect(snapshotDb(fake)).toEqual(before);
    });

    it.each(FORBIDDEN_CHARACTERS)("rejects an edit that sets a supplier number containing %s and keeps the existing code", async (_label, value) => {
      const item = itemNamed(medications, "Acetaminophen 500 mg");
      const before = snapshotDb(fake);
      const res = await api.updateItem(item.id, { stock: 77, supplier_order_number: value });
      expect(res.status).toBe(400);
      expect((await bodyRecord(res)).field).toBe("supplier_order_number");
      expect(snapshotDb(fake)).toEqual(before);
    });

    it.each(NOT_TEXT)("rejects %s as a supplier number (JSON numbers have already lost their leading zeros): 400 'must be text'", async (_label, value) => {
      const before = snapshotDb(fake);
      const created = await api.createItem({ barcode: "NUM-1", name: "x", supplier_order_number: value });
      expect(created.status).toBe(400);
      const body = await bodyRecord(created);
      expect(body.field).toBe("supplier_order_number");
      expect(errorTextOf(body)).toMatch(/text/i);

      const item = itemNamed(medications, "Acetaminophen 500 mg");
      const edited = await api.updateItem(item.id, { supplier_order_number: value });
      expect(edited.status).toBe(400);
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("rejects a 65-character supplier number on edit and keeps the existing code", async () => {
      const item = itemNamed(medications, "Acetaminophen 500 mg");
      const before = snapshotDb(fake);
      const res = await api.updateItem(item.id, { supplier_order_number: "z".repeat(65) });
      expect(res.status).toBe(400);
      expect(errorTextOf(await res.json())).toMatch(/too long/i);
      expect(snapshotDb(fake)).toEqual(before);
    });
  });

  describe("kept separate from the barcode and the item name; never inferred", () => {
    it("never derives a supplier number from the barcode: a new item with a code-like barcode has no supplier number", async () => {
      const res = await api.createItem({ barcode: "00417-B", name: "Barcode looks like a supplier code" });
      expect(res.status).toBe(201);
      const created = await bodyRecord(res);
      expect(created.barcode).toBe("00417-B");
      expect(created.supplier_order_number).toBeNull();
    });

    it("stores the same text in both fields independently: changing the barcode later leaves the supplier number alone, and the other way round", async () => {
      const created = await bodyRecord(await api.createItem({ barcode: "SAME-111", name: "Twin values", supplier_order_number: "SAME-111" }));
      const id = created.id as number;
      expect((await api.updateItem(id, { barcode: "SAME-222" })).status).toBe(200);
      let row = await bodyRecord(await api.getItem(id));
      expect(row).toMatchObject({ barcode: "SAME-222", supplier_order_number: "SAME-111" });
      expect((await api.updateItem(id, { supplier_order_number: "SUP-333" })).status).toBe(200);
      row = await bodyRecord(await api.getItem(id));
      expect(row).toMatchObject({ barcode: "SAME-222", supplier_order_number: "SUP-333" });
    });

    it("does not copy a supplier number into the barcode or the name when it is saved or cleared", async () => {
      const item = itemNamed(medications, "Aspirin 81 mg");
      const before = await bodyRecord(await api.getItem(item.id));
      expect((await api.updateItem(item.id, { supplier_order_number: "ZZ-9" })).status).toBe(200);
      expect((await api.updateItem(item.id, { supplier_order_number: null })).status).toBe(200);
      const after = await bodyRecord(await api.getItem(item.id));
      expect(omitKeys(after, "updated_at")).toEqual(omitKeys(before, "updated_at"));
    });

    it("never strips a code out of an item name: a name that contains the supplier code keeps it when the code is set, changed and cleared", async () => {
      const created = await bodyRecord(await api.createItem({ barcode: "NAME-1", name: "GLV-M Nitrile gloves, M (00417-B)" }));
      const id = created.id as number;
      for (const code of ["GLV-M", "00417-B", null]) {
        expect((await api.updateItem(id, { supplier_order_number: code })).status).toBe(200);
        expect((await bodyRecord(await api.getItem(id))).name).toBe("GLV-M Nitrile gloves, M (00417-B)");
      }
    });

    it("leaves legacy item names untouched when the list is read (codes embedded in names are not extracted or removed)", async () => {
      fake.seedMedications([{ id: 900, barcode: "LEGACY-1", name: "AX-1182/4 Syringe 3 mL", stock: 5 }]);
      const listed = await bodyList(await api.listItems());
      const legacy = listed.find((m) => m.id === 900);
      expect(legacy).toMatchObject({ name: "AX-1182/4 Syringe 3 mL", supplier_order_number: null });
    });
  });
});

describe.each(ID_SHAPES)("deploy-order independence: the database does NOT have the supplier column yet ($label)", ({ options }) => {
  // The app may be deployed before the migration is applied: it must keep listing and saving items, and say clearly
  // what is missing when somebody tries to store a supplier number.
  let fake: FakeSupabase;
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake({ ...options, hasSupplierColumn: false });
    ({ medications } = seedStandard(fake));
  });

  it("lists every item, each with supplier_order_number null (not undefined, not an error)", async () => {
    const res = await api.listItems();
    expect(res.status).toBe(200);
    const listed = await bodyList(res);
    expect(listed).toHaveLength(medications.length);
    for (const item of listed) expect(item).toHaveProperty("supplier_order_number", null);
  });

  it("opens an item by id and by barcode with supplier_order_number null", async () => {
    const item = itemNamed(medications, "Acetaminophen 500 mg");
    for (const res of [await api.getItem(item.id), await api.lookup(item.barcode)]) {
      expect(res.status).toBe(200);
      expect(await bodyRecord(res)).toHaveProperty("supplier_order_number", null);
    }
  });

  it("never names the supplier column in a select list, which a database without the column would reject", async () => {
    const item = itemNamed(medications, "Acetaminophen 500 mg");
    await api.listItems();
    await api.getItem(item.id);
    await api.lookup(item.barcode);
    await api.updateItem(item.id, { stock: 9 });
    await api.createItem({ barcode: "SEL-1", name: "x" });
    const reads = fake.calls.filter((c) => c.table === "medications");
    expect(reads.length).toBeGreaterThanOrEqual(5);
    for (const call of reads) expect(call.select === null || call.select === "*").toBe(true);
  });

  it("saves an edit that does not involve a supplier number (200) and the edit is stored", async () => {
    const item = itemNamed(medications, "Acetaminophen 500 mg");
    const res = await api.updateItem(item.id, { stock: 33, name: "Edited before the migration" });
    expect(res.status).toBe(200);
    expect(storedMedication(fake, item.id)).toMatchObject({ stock: 33, name: "Edited before the migration" });
  });

  it("creates an item that has no supplier number (201), including when the supplier field was left blank", async () => {
    for (const [index, supplier] of [undefined, null, "", "   "].entries()) {
      const res = await api.createItem({ barcode: `PRE-${index}`, name: "Created before the migration", supplier_order_number: supplier });
      expect(res.status).toBe(201);
      expect(await bodyRecord(res)).toHaveProperty("supplier_order_number", null);
    }
    expect(fake.dump("medications")).toHaveLength(medications.length + 4);
  });

  it("assigns categories before the migration too (the category fix does not depend on the supplier column)", async () => {
    const category = fake.dump("categories")[0];
    const item = itemNamed(medications, "Thermometer probe covers");
    const res = await api.updateItem(item.id, { category_id: String(category.id) });
    expect(res.status).toBe(200);
    expect((await bodyRecord(res)).category_id).toBe(String(category.id));
  });

  it("answers an edit that sets a supplier number with 409 and the migration message, and stores none of that edit", async () => {
    const item = itemNamed(medications, "Acetaminophen 500 mg");
    const before = snapshotDb(fake);
    const res = await api.updateItem(item.id, { stock: 77, supplier_order_number: "00417-B" });
    expect(res.status).toBe(409);
    const body = await bodyRecord(res);
    expect(body.field).toBe("supplier_order_number");
    // Plain words for staff. "Nothing was changed on this item" is true: the database refuses the whole update, so the stock
    // that was sent with the supplier number is not saved either (the snapshot check below proves it).
    expect(errorTextOf(body)).toBe(
      "Supplier order numbers cannot be saved yet. This needs a one-time database update by whoever looks after this app. Nothing was changed on this item."
    );
    expect(errorTextOf(body)).not.toMatch(/supplier_order_number|migration|column/i);
    expect(String(body.technical)).toMatch(/supplier_order_number column/);
    expect(String(body.technical)).toContain("supabase/migrations/");
    expect(snapshotDb(fake)).toEqual(before);
  });

  it("answers a create that sets a supplier number with 409 and the migration message, and creates nothing", async () => {
    const before = snapshotDb(fake);
    const res = await api.createItem({ barcode: "PRE-SUP", name: "x", supplier_order_number: "00417-B" });
    expect(res.status).toBe(409);
    const body = await bodyRecord(res);
    expect(body.field).toBe("supplier_order_number");
    expect(errorTextOf(body)).toBe(
      "Supplier order numbers cannot be saved yet. This needs a one-time database update by whoever looks after this app. The item was not created."
    );
    expect(String(body.technical)).toContain("supabase/migrations/");
    expect(res.ok).toBe(false);
    expect(snapshotDb(fake)).toEqual(before);
  });

  it("answers 409 (not 500, not 200) however the missing-column error is worded by the database (PGRST204 or 42703)", async () => {
    const item = itemNamed(medications, "Acetaminophen 500 mg");
    fake.failNext(
      { code: "42703", message: 'column "supplier_order_number" of relation "medications" does not exist' },
      { table: "medications", op: "update" }
    );
    const viaPostgres = await api.updateItem(item.id, { supplier_order_number: "A1" });
    expect(viaPostgres.status).toBe(409);
    fake.failNext(
      { code: "PGRST204", message: "Could not find the 'supplier_order_number' column of 'medications' in the schema cache" },
      { table: "medications", op: "insert" }
    );
    const viaPostgrest = await api.createItem({ barcode: "PRE-X", name: "x", supplier_order_number: "A1" });
    expect(viaPostgrest.status).toBe(409);
  });
});

describe("the live database before the migration (uuid ids, categories hidden by row-level security, no supplier column)", () => {
  let fake: FakeSupabase;
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake(LIVE_BEFORE_MIGRATION);
    ({ medications } = seedStandard(fake));
  });

  it("keeps the whole inventory usable exactly as deployed today: list, open, edit and create all succeed", async () => {
    expect((await bodyList(await api.listItems())).length).toBe(medications.length);
    const item = itemNamed(medications, "Acetaminophen 500 mg");
    expect((await api.getItem(item.id)).status).toBe(200);
    expect((await api.updateItem(item.id, { stock: 1 })).status).toBe(200);
    expect((await api.createItem({ barcode: "LIVE-1", name: "New item" })).status).toBe(201);
  });
});

describe("after the migration (supplier column present)", () => {
  it("accepts the same requests, so deploying before or after the migration needs no code change", async () => {
    const fake = installFake(LIVE_AFTER_MIGRATION);
    const { medications } = seedStandard(fake);
    const item = itemNamed(medications, "Aspirin 81 mg");
    expect((await api.updateItem(item.id, { supplier_order_number: "00417-B" })).status).toBe(200);
    expect((await api.createItem({ barcode: "POST-1", name: "x", supplier_order_number: "0092" })).status).toBe(201);
    expect((await bodyRecord(await api.getItem(item.id))).supplier_order_number).toBe("00417-B");
  });
});

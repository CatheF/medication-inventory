// Requirement-driven tests: assigning a category to an item and reading it back.
//
//   "A category selected when creating an item remains selected after saving, refreshing, and reopening it."
//   "A category changed during editing persists in the same way."
//   "Editing another field does not clear the category or overwrite unrelated item data."
//   "Failed saves show a useful error and do not appear successful."
//   "Existing items without categories remain accessible."
//
// Each group runs against BOTH id shapes (uuid = live database, bigint = supabase/schema.sql). "Reload" here means a
// completely separate GET after the write: list, item by id, and barcode lookup (the three ways the app reads an item).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Category, Medication } from "@/lib/db";
import {
  absentCategoryId,
  asRecord,
  bodyList,
  bodyRecord,
  errorTextOf,
  foreignShapeCategoryId,
  ID_SHAPES,
  itemNamed,
  omitKeys,
  snapshotDb,
  storedMedication,
} from "../helpers/api-test-kit";
import { installFake, LIVE_AFTER_MIGRATION, REPO_SCHEMA_SHAPE, type FakeSupabase } from "../helpers/fake-supabase";
import { seedStandard } from "../helpers/fixtures-extra";
import { api } from "../helpers/route-client";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

/** What every way of reading an item says its category is. */
async function categoryAfterReload(item: Medication): Promise<{ list: unknown; byId: unknown; byBarcode: unknown }> {
  const listed = (await bodyList(await api.listItems())).find((m) => m.id === item.id);
  const byId = await bodyRecord(await api.getItem(item.id));
  const byBarcode = await bodyRecord(await api.lookup(item.barcode));
  return { list: listed?.category_id, byId: byId.category_id, byBarcode: byBarcode.category_id };
}

describe.each(ID_SHAPES)("assigning a category when an item is CREATED, on the $label", ({ options }) => {
  let fake: FakeSupabase;
  let categories: Category[];
  beforeEach(() => {
    fake = installFake(options);
    ({ categories } = seedStandard(fake));
  });

  it("keeps the selected category after saving, refreshing and reopening: create response, list, item and barcode lookup all show it", async () => {
    const antibiotics = categories[2];
    const res = await api.createItem({ barcode: "9990001", name: "Doxycycline 100 mg, capsules", stock: 20, threshold: 8, category_id: antibiotics.id });
    expect(res.status).toBe(201);
    const created = await bodyRecord(res);
    expect(created.category_id).toBe(antibiotics.id);

    const reloaded = await categoryAfterReload({ id: created.id as number, barcode: "9990001" } as Medication);
    expect(reloaded).toEqual({ list: antibiotics.id, byId: antibiotics.id, byBarcode: antibiotics.id });
    expect(String(storedMedication(fake, created.id as number).category_id)).toBe(antibiotics.id);
  });

  // The Admin page's create form sends EVERY field at once. A defect that only shows when category, supplier number and the
  // other fields travel together (one of them dropped or reset to a default) is invisible to tests that set one at a time.
  const FULL_NEW_ITEM = {
    name: "Fully populated new item",
    barcode: "0000888000111",
    photo_url: "https://example.invalid/new-photo.png",
    unit: "boxes",
    stock: 41,
    threshold: 17,
    vendor_url: "https://example.invalid/new-vendor",
    notes: "Keep cool.\nSecond line.",
    supplier_order_number: "00-NEW/7",
  } as const;

  it.each([
    ["with a category", (categories: readonly Category[]) => categories[4].id],
    ["with no category (Uncategorized)", () => null],
  ])("keeps EVERY field of a new item that has all of them filled in %s: the create answer, the list, the item, the barcode lookup and the stored row all agree", async (_label, pickCategory) => {
    const sent = { ...FULL_NEW_ITEM, category_id: pickCategory(categories) };
    const res = await api.createItem(sent);
    expect(res.status).toBe(201);
    const created = await bodyRecord(res);
    const listed = (await bodyList(await api.listItems())).find((m) => m.id === created.id);
    expect(listed, "the new item is in the list").toBeDefined();
    const views = [created, await bodyRecord(await api.getItem(created.id as number)), await bodyRecord(await api.lookup(sent.barcode)), listed];
    for (const view of views) expect(view).toMatchObject({ ...sent, is_unnamed: false });
    const stored = storedMedication(fake, created.id as number);
    expect(stored).toMatchObject({ ...FULL_NEW_ITEM, is_unnamed: false });
    expect(stored.category_id === null ? null : String(stored.category_id)).toBe(sent.category_id);
  });

  it("keeps a category that was created a moment earlier through the category API (the admin page's inline 'new category' flow)", async () => {
    const newCategory = await bodyRecord(await api.createCategory("Splints & Braces"));
    expect(typeof newCategory.id).toBe("string");

    const res = await api.createItem({ barcode: "9990002", name: "Wrist splint", category_id: newCategory.id });
    expect(res.status).toBe(201);
    const created = await bodyRecord(res);
    expect(created.category_id).toBe(newCategory.id);
    expect((await categoryAfterReload({ id: created.id as number, barcode: "9990002" } as Medication)).byId).toBe(newCategory.id);
  });

  it("stores an item created without a category as uncategorized (null) and shows it in the uncategorized view", async () => {
    const res = await api.createItem({ barcode: "9990003", name: "Untagged item" });
    expect(res.status).toBe(201);
    const created = await bodyRecord(res);
    expect(created.category_id).toBeNull();
    const none = await bodyList(await api.listItems("?category=none"));
    expect(none.some((m) => m.id === created.id)).toBe(true);
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["blank spaces", "   "],
  ])("treats %s as 'no category' when creating", async (_label, value) => {
    const res = await api.createItem({ barcode: "9990004", name: "No category chosen", category_id: value });
    expect(res.status).toBe(201);
    expect((await bodyRecord(res)).category_id).toBeNull();
  });

  it("puts a new categorized item in its category's view and not in the uncategorized view", async () => {
    const firstAid = categories[3];
    const created = await bodyRecord(await api.createItem({ barcode: "9990005", name: "Triangular bandage", category_id: firstAid.id }));
    const inCategory = await bodyList(await api.listItems(`?category=${firstAid.id}`));
    const inNone = await bodyList(await api.listItems("?category=none"));
    expect(inCategory.some((m) => m.id === created.id)).toBe(true);
    expect(inNone.some((m) => m.id === created.id)).toBe(false);
  });

  it.each([
    ["the text NaN", "NaN"],
    ["the text undefined", "undefined"],
    ["the text null", "null"],
    ["zero", 0],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["a word", "antibiotics"],
    ["scientific notation", "1e3"],
    ["a hex number", "0x1f"],
    ["a boolean", true],
    ["an object", { id: 1 }],
    ["an array", [1]],
  ])("rejects %s as a category id with 400, naming the field, and creates no item", async (_label, value) => {
    const before = snapshotDb(fake);
    const res = await api.createItem({ barcode: "9990006", name: "Should not be saved", category_id: value });
    expect(res.status).toBe(400);
    const body = await bodyRecord(res);
    expect(body.field).toBe("category_id");
    expect(errorTextOf(body)).toMatch(/category/i);
    expect(snapshotDb(fake)).toEqual(before);
  });

  it("rejects a category that does not exist (deleted or from another database) with a clear message, and creates no item", async () => {
    const before = snapshotDb(fake);
    const res = await api.createItem({ barcode: "9990007", name: "Orphan", category_id: absentCategoryId(options.categoryIdType ?? "uuid") });
    expect(res.status).toBe(400);
    const body = await bodyRecord(res);
    expect(errorTextOf(body)).toMatch(/category no longer exists/i);
    expect(body.field).toBe("category_id");
    expect(snapshotDb(fake)).toEqual(before);
  });

  it("rejects an id written in the other database's shape with a clear 400 and creates no item (never a 500, never a silent null)", async () => {
    const before = snapshotDb(fake);
    const res = await api.createItem({ barcode: "9990008", name: "Wrong shape", category_id: foreignShapeCategoryId(options.categoryIdType ?? "uuid") });
    expect(res.status).toBe(400);
    expect(errorTextOf(await res.json())).not.toBe("");
    expect(snapshotDb(fake)).toEqual(before);
  });
});

describe.each(ID_SHAPES)("changing an item's category when it is EDITED, on the $label", ({ options }) => {
  let fake: FakeSupabase;
  let categories: Category[];
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake(options);
    ({ categories, medications } = seedStandard(fake));
  });

  it("assigns a category to an uncategorized (legacy) item and keeps it after a reload", async () => {
    const legacy = itemNamed(medications, "Thermometer probe covers");
    expect(legacy.category_id).toBeNull();
    const target = categories[3];

    const res = await api.updateItem(legacy.id, { category_id: target.id });
    expect(res.status).toBe(200);
    expect((await bodyRecord(res)).category_id).toBe(target.id);
    expect(await categoryAfterReload(legacy)).toEqual({ list: target.id, byId: target.id, byBarcode: target.id });
    expect(String(storedMedication(fake, legacy.id).category_id)).toBe(target.id);
  });

  it("moves an item from one category to another: the new category's view has it and the old one no longer does", async () => {
    const item = itemNamed(medications, "Ibuprofen 200 mg");
    const from = categories[0];
    const to = categories[2];
    expect(item.category_id).toBe(from.id);

    expect((await api.updateItem(item.id, { category_id: to.id })).status).toBe(200);

    const inNew = await bodyList(await api.listItems(`?category=${to.id}`));
    const inOld = await bodyList(await api.listItems(`?category=${from.id}`));
    expect(inNew.some((m) => m.id === item.id)).toBe(true);
    expect(inOld.some((m) => m.id === item.id)).toBe(false);
    expect((await categoryAfterReload(item)).byId).toBe(to.id);
  });

  it("clears the category only when null is sent explicitly, and the item then appears as uncategorized", async () => {
    const item = itemNamed(medications, "Cetirizine");
    expect(item.category_id).not.toBeNull();

    const res = await api.updateItem(item.id, { category_id: null });
    expect(res.status).toBe(200);
    expect((await bodyRecord(res)).category_id).toBeNull();
    expect(await categoryAfterReload(item)).toEqual({ list: null, byId: null, byBarcode: null });
    const none = await bodyList(await api.listItems("?category=none"));
    expect(none.some((m) => m.id === item.id)).toBe(true);
  });

  it("clears the category when the form's 'Uncategorized' option sends an empty string", async () => {
    const item = itemNamed(medications, "Cetirizine");
    const res = await api.updateItem(item.id, { category_id: "" });
    expect(res.status).toBe(200);
    expect((await bodyRecord(res)).category_id).toBeNull();
  });

  it("keeps the category when an edit re-sends it unchanged along with other fields (what the admin form does)", async () => {
    const item = itemNamed(medications, "Loratadine");
    const res = await api.updateItem(item.id, { name: "Loratadine 10 mg, tablets (renamed)", stock: 30, category_id: item.category_id });
    expect(res.status).toBe(200);
    const saved = await bodyRecord(res);
    expect(saved.category_id).toBe(item.category_id);
    expect(saved.name).toBe("Loratadine 10 mg, tablets (renamed)");
  });

  const FIELD_EDITS: ReadonlyArray<readonly [string, unknown]> = [
    ["name", "Renamed medication"],
    ["barcode", "0000777000111"],
    ["photo_url", "https://example.invalid/photo.png"],
    ["stock", 7],
    ["threshold", 3],
    ["vendor_url", "https://example.invalid/vendor"],
    ["unit", "boxes"],
    ["notes", "Keep refrigerated. Second line."],
    ["supplier_order_number", "ZZ-0042"],
  ];

  it.each(FIELD_EDITS)("keeps the category and every other field when only %s is edited (partial update)", async (field, value) => {
    const item = itemNamed(medications, "Acetaminophen 500 mg");
    expect(item.category_id).not.toBeNull();
    const before = await bodyRecord(await api.getItem(item.id));

    const res = await api.updateItem(item.id, { [field]: value });
    expect(res.status).toBe(200);
    const saved = await bodyRecord(res);
    expect(saved.category_id).toBe(item.category_id);

    const after = await bodyRecord(await api.getItem(item.id));
    expect(omitKeys(after, "updated_at")).toEqual({ ...omitKeys(before, "updated_at"), [field]: value });
    expect(String(storedMedication(fake, item.id).category_id)).toBe(item.category_id);
  });

  it.each(FIELD_EDITS)(
    "keeps the category and every other field of an item with EVERY optional field filled in when only %s is edited",
    async (field, value) => {
      // The standard fixtures leave photo, vendor, notes (and sometimes the supplier number) empty, where a PUT that
      // "resets" them to null would go unnoticed. This item has a non-empty, non-default value in every column.
      fake.seedMedications([
        {
          id: 700,
          barcode: "FULL-0001",
          name: "Fully populated item",
          photo_url: "https://example.invalid/original-photo.png",
          stock: 33,
          threshold: 12,
          vendor_url: "https://example.invalid/original-vendor",
          unit: "pallets",
          notes: "Original notes.",
          category_id: categories[1].id,
          supplier_order_number: "ORIG-0001",
        },
      ]);
      const before = await bodyRecord(await api.getItem(700));
      for (const key of ["name", "photo_url", "vendor_url", "notes", "category_id", "supplier_order_number"]) expect(before[key]).not.toBeNull();

      const res = await api.updateItem(700, { [field]: value });
      expect(res.status).toBe(200);
      expect((await bodyRecord(res)).category_id).toBe(categories[1].id);
      const after = await bodyRecord(await api.getItem(700));
      expect(omitKeys(after, "updated_at")).toEqual({ ...omitKeys(before, "updated_at"), [field]: value });
    }
  );

  it("does not send category_id (or any other field the form did not change) to the database in a partial update", async () => {
    const item = itemNamed(medications, "Acetaminophen 500 mg");
    fake.clearCalls();
    expect((await api.updateItem(item.id, { stock: 11 })).status).toBe(200);
    const updates = fake.writes().filter((c) => c.op === "update");
    expect(updates).toHaveLength(1);
    const payload = asRecord(updates[0].payload, "update payload");
    expect(Object.keys(payload).sort()).toEqual(["is_unnamed", "stock"]);
  });

  it("keeps the category when the edit sends every other editable field but omits category_id", async () => {
    const item = itemNamed(medications, "Naproxen 220 mg");
    const res = await api.updateItem(item.id, {
      name: "Naproxen 220 mg, tablets",
      barcode: item.barcode,
      photo_url: null,
      stock: 12,
      threshold: 25,
      vendor_url: null,
      unit: "units",
      notes: "edited",
      supplier_order_number: item.supplier_order_number,
    });
    expect(res.status).toBe(200);
    expect((await bodyRecord(res)).category_id).toBe(item.category_id);
    expect(String(storedMedication(fake, item.id).category_id)).toBe(item.category_id);
  });

  it("documents the wire format of the original defect: NaN serializes to null, and an explicit null clears the category", async () => {
    // A page that sends Number("<uuid>") sends NaN; JSON.stringify turns NaN into null, so the PUT carries an explicit
    // null and the category is wiped while the page still says "saved". The server cannot tell NaN from an intended
    // null, so the only defence is a client that sends the id string (covered by the admin page tests).
    const item = itemNamed(medications, "Cetirizine");
    const res = await api.updateItem(item.id, { category_id: Number.NaN });
    expect(res.status).toBe(200);
    expect((await bodyRecord(res)).category_id).toBeNull();
  });
});

// ── What the Admin page REALLY sends ──────────────────────────────────────────────────────────────────────────────────────
// When staff press Save on an existing item, app/admin/page.tsx (buildPayload) sends ONLY the fields that changed, plus
// category_id on EVERY save (an id string, or null for "Uncategorized"), plus supplier_order_number when that changed. So
// the realistic way to lose a category is not "the category travels alone" (covered above) but "the category,
// or another field, is dropped or reset when it travels TOGETHER with other fields". Each case below is read back three
// ways (the PUT answer, a fresh read of the item, the stored row) and checks that every field that was NOT sent is exactly
// what it was before the save.
type FormSave = readonly [label: string, body: (category: string | null) => Record<string, unknown>];
const FORM_SAVES: readonly FormSave[] = [
  ["name", (c) => ({ name: "Renamed item", category_id: c })],
  ["barcode", (c) => ({ barcode: "0000777000222", category_id: c })],
  ["photo", (c) => ({ photo_url: "https://example.invalid/new-photo.png", category_id: c })],
  ["unit", (c) => ({ unit: "boxes", category_id: c })],
  ["stock", (c) => ({ stock: 55, category_id: c })],
  ["threshold", (c) => ({ threshold: 3, category_id: c })],
  ["vendor link", (c) => ({ vendor_url: "https://example.invalid/new-vendor", category_id: c })],
  ["notes", (c) => ({ notes: "edited notes\nsecond line", category_id: c })],
  ["supplier order number", (c) => ({ category_id: c, supplier_order_number: "0099-Z" })],
  ["name, stock and supplier order number", (c) => ({ name: "Renamed item", stock: 55, category_id: c, supplier_order_number: "0099-Z" })],
  [
    "every editable field at once",
    (c) => ({
      name: "Renamed item",
      barcode: "0000777000333",
      photo_url: "https://example.invalid/new-photo.png",
      unit: "boxes",
      stock: 55,
      threshold: 3,
      vendor_url: "https://example.invalid/new-vendor",
      notes: "edited notes",
      category_id: c,
      supplier_order_number: "0099-Z",
    }),
  ],
];

/** The ids of the items the list shows for a category view such as "?category=none". */
async function idsInView(query: string): Promise<number[]> {
  return (await bodyList(await api.listItems(query))).map((m) => m.id as number);
}

/** `view` shows every value that was sent, and every field that was NOT sent exactly as it was before the save. */
function expectSavedAsSent(view: Record<string, unknown>, before: Record<string, unknown>, sent: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(sent)) expect(view[key], `sent ${key}`).toEqual(value);
  expect(view.is_unnamed).toBe(false); // every successful edit counts as the review (documented contract)
  const moved = ["updated_at", "is_unnamed", ...Object.keys(sent)];
  expect(omitKeys(view, ...moved)).toEqual(omitKeys(before, ...moved));
}

describe.each(ID_SHAPES)("saving an existing item the way the Admin page does (changed fields + category_id), on the $label", ({ options }) => {
  let fake: FakeSupabase;
  let categories: Category[];
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake(options);
    ({ categories, medications } = seedStandard(fake));
    // An item with a non-empty, non-default value in EVERY column, so a field that is reset to null or to a default shows.
    fake.seedMedications([
      {
        id: 700,
        barcode: "FULL-0001",
        name: "Fully populated item",
        photo_url: "https://example.invalid/original-photo.png",
        stock: 33,
        threshold: 12,
        vendor_url: "https://example.invalid/original-vendor",
        unit: "pallets",
        notes: "Original notes.",
        category_id: categories[1].id,
        supplier_order_number: "ORIG-0001",
      },
    ]);
  });

  type SavedItem = readonly [label: string, pick: () => Pick<Medication, "id">];
  const CATEGORIZED_ITEMS: readonly SavedItem[] = [
    ["a standard categorized item", () => itemNamed(medications, "Acetaminophen 500 mg")],
    ["a categorized item with every optional field filled in", () => ({ id: 700 })],
  ];
  const ALL_ITEMS: readonly SavedItem[] = [...CATEGORIZED_ITEMS, ["a legacy item that has no category yet", () => itemNamed(medications, "Thermometer probe covers")]];

  describe.each(ALL_ITEMS)("on %s", (_itemLabel, pick) => {
    it.each(FORM_SAVES)("a CHANGED category saved together with a changed %s is stored, returned and read back by list, id and barcode; nothing else moves", async (_label, makeBody) => {
      const item = pick();
      const target = categories[3].id;
      const before = await bodyRecord(await api.getItem(item.id));
      expect(before.category_id).not.toBe(target);
      const sent = makeBody(target);

      const res = await api.updateItem(item.id, sent);
      expect(res.status).toBe(200);
      const saved = await bodyRecord(res);
      const reread = await bodyRecord(await api.getItem(item.id));
      for (const view of [saved, reread]) {
        expect(view.category_id).toBe(target);
        expectSavedAsSent(view, before, sent);
      }
      expect(String(storedMedication(fake, item.id).category_id)).toBe(target);

      // the other two ways the app reads an item agree, and the item sits in the group staff expect
      const byBarcode = await bodyRecord(await api.lookup(String(reread.barcode)));
      expect(byBarcode.id).toBe(item.id);
      expect(byBarcode.category_id).toBe(target);
      expect(await idsInView(`?category=${target}`)).toContain(item.id);
      expect(await idsInView("?category=none")).not.toContain(item.id);
      if (before.category_id !== null) expect(await idsInView(`?category=${String(before.category_id)}`)).not.toContain(item.id);
    });

    it.each(FORM_SAVES)("an UNCHANGED category re-sent with a changed %s keeps the category and changes only what was sent", async (_label, makeBody) => {
      const item = pick();
      const before = await bodyRecord(await api.getItem(item.id));
      const sent = makeBody(before.category_id as string | null); // what the form sends when the select was not touched

      const res = await api.updateItem(item.id, sent);
      expect(res.status).toBe(200);
      const saved = await bodyRecord(res);
      const reread = await bodyRecord(await api.getItem(item.id));
      for (const view of [saved, reread]) {
        expect(view.category_id).toBe(before.category_id);
        expectSavedAsSent(view, before, sent);
      }
      const stored = storedMedication(fake, item.id).category_id;
      expect(stored === null ? null : String(stored)).toBe(before.category_id);
    });
  });

  describe.each(CATEGORIZED_ITEMS)("on %s", (_itemLabel, pick) => {
    it.each(FORM_SAVES)("CLEARING the category (Uncategorized) together with a changed %s clears it, files the item under Uncategorized and changes nothing else", async (_label, makeBody) => {
      const item = pick();
      const before = await bodyRecord(await api.getItem(item.id));
      expect(before.category_id).not.toBeNull();
      const sent = makeBody(null);

      const res = await api.updateItem(item.id, sent);
      expect(res.status).toBe(200);
      const saved = await bodyRecord(res);
      const reread = await bodyRecord(await api.getItem(item.id));
      for (const view of [saved, reread]) {
        expect(view.category_id).toBeNull();
        expectSavedAsSent(view, before, sent);
      }
      expect(storedMedication(fake, item.id).category_id).toBeNull();

      const byBarcode = await bodyRecord(await api.lookup(String(reread.barcode)));
      expect(byBarcode.id).toBe(item.id);
      expect(byBarcode.category_id).toBeNull();
      expect(await idsInView("?category=none")).toContain(item.id);
      expect(await idsInView(`?category=${String(before.category_id)}`)).not.toContain(item.id);
    });
  });

  it("moves an item to another category and changes its supplier order number in ONE save, and both are there on the next read", async () => {
    const item = itemNamed(medications, "Ibuprofen 200 mg"); // category 0, supplier "0092"
    const res = await api.updateItem(item.id, { category_id: categories[2].id, supplier_order_number: "IBU-0200" });
    expect(res.status).toBe(200);
    const reread = await bodyRecord(await api.getItem(item.id));
    expect(reread).toMatchObject({ category_id: categories[2].id, supplier_order_number: "IBU-0200" });
    expect(storedMedication(fake, item.id)).toMatchObject({ supplier_order_number: "IBU-0200" });
  });

  it("clears the category and the supplier order number in ONE save (both set to null), and both are gone on the next read", async () => {
    const item = itemNamed(medications, "Ibuprofen 200 mg");
    const res = await api.updateItem(item.id, { category_id: null, supplier_order_number: null });
    expect(res.status).toBe(200);
    expect(await bodyRecord(await api.getItem(item.id))).toMatchObject({ category_id: null, supplier_order_number: null });
  });

  it("answers with exactly what the database now holds: the PUT response and a fresh read are the same row (the page's read-after-write check depends on it)", async () => {
    const item = itemNamed(medications, "Acetaminophen 500 mg");
    const res = await api.updateItem(item.id, { name: "Renamed item", stock: 55, category_id: categories[3].id, supplier_order_number: "0099-Z" });
    expect(res.status).toBe(200);
    expect(await bodyRecord(res)).toEqual(await bodyRecord(await api.getItem(item.id)));
  });
});

describe.each(ID_SHAPES)("failed category saves, on the $label", ({ options }) => {
  let fake: FakeSupabase;
  let categories: Category[];
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake(options);
    ({ categories, medications } = seedStandard(fake));
  });

  it.each([
    ["the text NaN", "NaN"],
    ["the text undefined", "undefined"],
    ["the text null", "null"],
    ["zero", 0],
    ["a negative number", -5],
    ["a fraction", 2.5],
    ["a word", "antibiotics"],
    ["scientific notation", "1e3"],
    ["a boolean", false],
    ["an object", {}],
    ["an array", []],
  ])("rejects %s as a category id with 400 and leaves the item, including its current category, untouched", async (_label, value) => {
    const item = itemNamed(medications, "Azithromycin");
    const before = snapshotDb(fake);
    const res = await api.updateItem(item.id, { stock: 99, category_id: value });
    expect(res.status).toBe(400);
    expect(res.ok).toBe(false);
    const body = await bodyRecord(res);
    expect(body.field).toBe("category_id");
    expect(errorTextOf(body)).toMatch(/category/i);
    expect(body).not.toHaveProperty("stock");
    expect(snapshotDb(fake)).toEqual(before);
    expect(fake.writes()).toEqual([]);
  });

  it("rejects a category that no longer exists with 'That category no longer exists' and changes nothing (not even the other fields in the same save)", async () => {
    const item = itemNamed(medications, "Azithromycin");
    const before = snapshotDb(fake);
    const res = await api.updateItem(item.id, { stock: 99, category_id: absentCategoryId(options.categoryIdType ?? "uuid") });
    expect(res.status).toBe(400);
    const body = await bodyRecord(res);
    expect(errorTextOf(body)).toBe("That category no longer exists, so nothing was saved. Reload the page and choose another category.");
    expect(body.field).toBe("category_id");
    expect(snapshotDb(fake)).toEqual(before);
  });

  it("rejects an id of the other database shape with a clear 400 and keeps the item's category", async () => {
    const item = itemNamed(medications, "Azithromycin");
    const before = snapshotDb(fake);
    const res = await api.updateItem(item.id, { category_id: foreignShapeCategoryId(options.categoryIdType ?? "uuid") });
    expect(res.status).toBe(400);
    expect(errorTextOf(await res.json())).not.toBe("");
    expect(snapshotDb(fake)).toEqual(before);
    expect((await bodyRecord(await api.getItem(item.id))).category_id).toBe(item.category_id);
  });

  it("answers 503 with a connection message when the database is unreachable, and the item keeps its category", async () => {
    const item = itemNamed(medications, "Azithromycin");
    const before = snapshotDb(fake);
    fake.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "medications", op: "update" });
    const res = await api.updateItem(item.id, { category_id: categories[0].id });
    expect(res.status).toBe(503);
    expect(res.ok).toBe(false);
    expect(errorTextOf(await res.json())).toMatch(/can.t reach the database/i);
    expect(snapshotDb(fake)).toEqual(before);
  });

  it("answers 404 and not 200 when the item was deleted before the category was saved", async () => {
    const res = await api.updateItem(987654, { category_id: categories[0].id });
    expect(res.status).toBe(404);
    expect(errorTextOf(await res.json())).toMatch(/not found/i);
  });

  it("does not look successful when the database silently refuses the update (policy removed): 404, item unchanged", async () => {
    const item = itemNamed(medications, "Azithromycin");
    fake.setRls("medications", { select: true, insert: true, update: false, delete: true });
    const before = snapshotDb(fake);
    const res = await api.updateItem(item.id, { category_id: categories[0].id });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(snapshotDb(fake)).toEqual(before);
  });

  it("answers a failed create of an item with a category with an error and stores neither the item nor a new category", async () => {
    const before = snapshotDb(fake);
    fake.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "medications", op: "insert" });
    const res = await api.createItem({ barcode: "9990010", name: "Never saved", category_id: categories[1].id });
    expect(res.status).toBe(503);
    expect(res.ok).toBe(false);
    expect(snapshotDb(fake)).toEqual(before);
  });
});

describe.each(ID_SHAPES)("legacy and uncategorized items, on the $label", ({ options }) => {
  let fake: FakeSupabase;
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake(options);
    ({ medications } = seedStandard(fake));
  });

  const uncategorized = (): Medication[] => medications.filter((m) => m.category_id === null);

  it("still lists every item, categorized or not, in one complete list", async () => {
    const listed = await bodyList(await api.listItems());
    expect(listed).toHaveLength(medications.length);
    expect(new Set(listed.map((m) => m.id))).toEqual(new Set(medications.map((m) => m.id)));
    expect(listed.filter((m) => m.category_id === null)).toHaveLength(uncategorized().length);
    expect(uncategorized().length).toBeGreaterThanOrEqual(3);
  });

  it("lists exactly the uncategorized items in the uncategorized view, including the barcode-only unnamed one", async () => {
    const none = await bodyList(await api.listItems("?category=none"));
    expect(new Set(none.map((m) => m.id))).toEqual(new Set(uncategorized().map((m) => m.id)));
    expect(none.some((m) => m.name === null)).toBe(true);
  });

  it("opens an uncategorized item by id and by barcode, with category_id null (not missing, not 'undefined')", async () => {
    const legacy = itemNamed(medications, "Thermometer probe covers");
    for (const res of [await api.getItem(legacy.id), await api.lookup(legacy.barcode)]) {
      expect(res.status).toBe(200);
      const body = await bodyRecord(res);
      expect(body.category_id).toBeNull();
      expect(body.name).toBe("Thermometer probe covers");
    }
  });

  it("lets staff edit an uncategorized item (stock) without inventing a category for it", async () => {
    const legacy = itemNamed(medications, "Thermometer probe covers");
    const res = await api.updateItem(legacy.id, { stock: 55 });
    expect(res.status).toBe(200);
    const saved = await bodyRecord(res);
    expect(saved.stock).toBe(55);
    expect(saved.category_id).toBeNull();
    expect(storedMedication(fake, legacy.id).category_id).toBeNull();
  });

  it("lets staff name the barcode-only item and keeps it uncategorized (and marks it reviewed)", async () => {
    const unnamed = medications.find((m) => m.name === null);
    if (!unnamed) throw new Error("fixture has no unnamed item");
    expect(unnamed.is_unnamed).toBe(true);
    const res = await api.updateItem(unnamed.id, { name: "Digital thermometer" });
    expect(res.status).toBe(200);
    const saved = await bodyRecord(res);
    expect(saved).toMatchObject({ name: "Digital thermometer", category_id: null, is_unnamed: false });
  });

  it("keeps an uncategorized item's other data intact when it is categorized later", async () => {
    const legacy = itemNamed(medications, "Multi-vitamin with minerals");
    const before = await bodyRecord(await api.getItem(legacy.id));
    const catList = await bodyList(await api.listItems());
    const someCategory = catList.find((m) => m.category_id !== null)?.category_id;
    expect(typeof someCategory).toBe("string");
    expect((await api.updateItem(legacy.id, { category_id: someCategory })).status).toBe(200);
    const after = await bodyRecord(await api.getItem(legacy.id));
    expect(omitKeys(after, "updated_at", "category_id")).toEqual(omitKeys(before, "updated_at", "category_id"));
    expect(after.category_id).toBe(someCategory);
  });

  it("still lists and opens items whose category the database hides from the app (no policy on categories): the category id is kept, nothing is dropped", async () => {
    fake.setRls("categories", false); // the live defect: row-level security on, no policy
    const listed = await bodyList(await api.listItems());
    expect(listed).toHaveLength(medications.length);
    const categorized = medications.filter((m) => m.category_id !== null);
    for (const item of categorized) {
      expect(listed.find((m) => m.id === item.id)?.category_id).toBe(item.category_id);
    }
    const one = categorized[0];
    expect((await bodyRecord(await api.getItem(one.id))).category_id).toBe(one.category_id);
  });
});

describe("id forms specific to the live database (uuid)", () => {
  let fake: FakeSupabase;
  let categories: Category[];
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake(LIVE_AFTER_MIGRATION);
    ({ categories, medications } = seedStandard(fake));
  });

  it("accepts an upper-case UUID from a client and stores and returns it in canonical lower case", async () => {
    const item = itemNamed(medications, "Thermometer probe covers");
    const res = await api.updateItem(item.id, { category_id: categories[4].id.toUpperCase() });
    expect(res.status).toBe(200);
    expect((await bodyRecord(res)).category_id).toBe(categories[4].id);
    expect(storedMedication(fake, item.id).category_id).toBe(categories[4].id);
  });

  it("rejects a bare number as a category id with 400 (a uuid column can't hold it) and keeps the item's category", async () => {
    const item = itemNamed(medications, "Azithromycin");
    const before = snapshotDb(fake);
    const res = await api.updateItem(item.id, { category_id: 3 });
    expect(res.status).toBe(400);
    expect(snapshotDb(fake)).toEqual(before);
  });

  it("keeps working for ids whose first characters look like a number (ids are never parsed as numbers)", async () => {
    // Number("12345678-...") would be NaN; parseInt would silently keep "12345678". Neither may happen.
    const odd = "12345678-0000-4000-8000-000000000042";
    fake.seedCategories([{ id: odd, name: "Looks numeric" }]);
    const item = itemNamed(medications, "Thermometer probe covers");
    const res = await api.updateItem(item.id, { category_id: odd });
    expect(res.status).toBe(200);
    expect((await bodyRecord(res)).category_id).toBe(odd);
    expect(storedMedication(fake, item.id).category_id).toBe(odd);
  });
});

describe("id forms specific to supabase/schema.sql (bigint)", () => {
  let fake: FakeSupabase;
  let categories: Category[];
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake(REPO_SCHEMA_SHAPE);
    ({ categories, medications } = seedStandard(fake));
  });

  it("still accepts a category id sent as a JSON number (older clients sent numbers) and returns it as a string", async () => {
    const item = itemNamed(medications, "Thermometer probe covers");
    const res = await api.updateItem(item.id, { category_id: Number(categories[2].id) });
    expect(res.status).toBe(200);
    expect((await bodyRecord(res)).category_id).toBe(categories[2].id);
    expect(storedMedication(fake, item.id).category_id).toBe(Number(categories[2].id));
  });

  it("ignores leading zeros in a digit-string id (\"0003\" is category 3)", async () => {
    const item = itemNamed(medications, "Thermometer probe covers");
    const res = await api.updateItem(item.id, { category_id: "0003" });
    expect(res.status).toBe(200);
    expect((await bodyRecord(res)).category_id).toBe("3");
  });

  it("keeps ids above 2^31 working: a bigint id is never squeezed through a 32-bit integer", async () => {
    fake.seedCategories([{ id: "3000000000", name: "Big id" }]);
    const item = itemNamed(medications, "Thermometer probe covers");
    const res = await api.updateItem(item.id, { category_id: "3000000000" });
    expect(res.status).toBe(200);
    expect((await bodyRecord(res)).category_id).toBe("3000000000");
  });
});

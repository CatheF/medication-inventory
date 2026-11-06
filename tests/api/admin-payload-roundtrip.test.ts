// The whole trace without a browser: what the Admin form holds -> the body the page builds from it
// (buildPayload) -> the REAL POST/PUT /api/medications handlers -> the database (tests/helpers/fake-supabase.ts) -> what is read
// back, the way the page reads it (toMedication, which runs normalizeMedication) and checks it (findNotStored).
//
//   "A category selected when creating an item remains selected after saving, refreshing, and reopening it."
//   "A category changed during editing persists in the same way."
//   "Editing another field does not clear the category or overwrite unrelated item data."
//
// Every group runs on BOTH id shapes (uuid = the live database, bigint = supabase/schema.sql). Synthetic data only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_FORM,
  buildPayload,
  findNotStored,
  formFromMedication,
  formProblems,
  isEmptyPayload,
  planSupplier,
  toMedication,
  type FormState,
  type SavePayload,
} from "@/lib/admin-form";
import type { Category, Medication } from "@/lib/db";
import { normalizeMedication } from "@/lib/normalize";
import { SUPPLIER_ORDER_NUMBER_INVISIBLE_REASON, SUPPLIER_ORDER_NUMBER_MAX_LENGTH } from "@/lib/supplier-order-number";
import {
  asRecord,
  bodyList,
  bodyRecord,
  errorTextOf,
  ID_SHAPES,
  itemNamed,
  omitKeys,
  snapshotDb,
  storedMedication,
} from "../helpers/api-test-kit";
import { installFake, LIVE_AFTER_MIGRATION, type FakeSupabase } from "../helpers/fake-supabase";
import { buildCategories, buildMedications } from "../helpers/fixtures";
import { seedStandard } from "../helpers/fixtures-extra";
import { api } from "../helpers/route-client";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

// ── What the page does, minus the browser ───────────────────────────────────────────────────────

/** The item as the page holds it when it opens the form: read through the real GET route, read the way the page reads an answer. */
async function openItem(id: number): Promise<Medication> {
  const med = toMedication((await (await api.getItem(id)).json()) as unknown);
  if (med === null) throw new Error(`GET /api/medications/${id} did not answer with an item`);
  return med;
}

type PageSave = {
  /** What the page built from the form. */
  payload: SavePayload;
  /** False when the payload was empty: the page then makes no request at all and says "No changes to save." */
  requested: boolean;
  status: number | null;
  body: unknown;
  /** The answer read as an item (only for a 2xx answer). */
  saved: Medication | null;
};

/** Pressing Save: build the body from the form, send it to the real route unless it is empty, read the answer. */
async function saveLikeThePage(loaded: Medication | null, form: FormState): Promise<PageSave> {
  const payload = buildPayload(form, planSupplier(form, loaded), loaded);
  if (isEmptyPayload(payload)) return { payload, requested: false, status: null, body: null, saved: null };
  const res = loaded === null ? await api.createItem(payload) : await api.updateItem(loaded.id, payload);
  const body = (await res.json()) as unknown;
  return { payload, requested: true, status: res.status, body, saved: res.ok ? toMedication(body) : null };
}

/** The category (and supplier number) every way of reading an item reports: the list, the item itself and the barcode lookup. */
async function readBack(item: { id: number; barcode: string }): Promise<Array<Record<string, unknown>>> {
  const listed = (await bodyList(await api.listItems())).find((m) => m.id === item.id);
  return [asRecord(listed, "the item in the list"), await bodyRecord(await api.getItem(item.id)), await bodyRecord(await api.lookup(item.barcode))];
}

/** What the form holds: a new form is EMPTY_FORM, an edit form holds the item; `edits` is what the person typed on top. */
function form(loaded: Medication | null, edits: Partial<FormState> = {}): FormState {
  return { ...(loaded === null ? EMPTY_FORM : formFromMedication(loaded)), ...edits };
}

describe.each(ID_SHAPES)("form -> payload -> route -> database -> read-back, on the $label", ({ options, shape }) => {
  let fake: FakeSupabase;
  let categories: Category[];
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake(options);
    ({ categories, medications } = seedStandard(fake));
  });

  const painAndFever = (): Category => categories[0];
  const antibiotics = (): Category => categories[2];

  // ── Creating ───────────────────────────────────────────────────────────────────────────────────

  describe("creating an item", () => {
    const TYPED: Partial<FormState> = {
      name: "Test syrup, 100 mL",
      barcode: "0099001122",
      supplier_order_number: "0092",
      unit: "bottles",
      stock: "7",
      threshold: "3",
      vendor_url: "https://supplier.example/syrup",
      notes: "Shake well before use",
    };

    it("keeps every field of a new item, with its category, from the form to the stored row and back through all three reads", async () => {
      const typed = form(null, { ...TYPED, category_id: antibiotics().id });
      const result = await saveLikeThePage(null, typed);

      expect(result.status).toBe(201);
      expect(result.saved).not.toBeNull();
      const saved = result.saved as Medication;
      expect(saved).toMatchObject({
        name: "Test syrup, 100 mL",
        barcode: "0099001122",
        supplier_order_number: "0092", // the leading zeros are still there
        unit: "bottles",
        stock: 7,
        threshold: 3,
        category_id: antibiotics().id,
      });
      expect(findNotStored(saved, result.payload)).toEqual([]);
      const row = storedMedication(fake, saved.id);
      expect(row).toMatchObject({ supplier_order_number: "0092", is_unnamed: false });
      expect(normalizeMedication(row).category_id).toBe(antibiotics().id); // a raw bigint (number) or uuid reads as the id the form held
      for (const view of await readBack(saved)) {
        expect(view).toMatchObject({ category_id: antibiotics().id, supplier_order_number: "0092" });
      }
    });

    it("an item created without a category is stored as uncategorized and reads back that way (an explicit null, not a guess)", async () => {
      const result = await saveLikeThePage(null, form(null, TYPED));
      expect(result.payload).toHaveProperty("category_id", null);
      expect(result.status).toBe(201);
      const saved = result.saved as Medication;
      expect(saved.category_id).toBeNull();
      expect(findNotStored(saved, result.payload)).toEqual([]);
      expect(storedMedication(fake, saved.id).category_id).toBeNull();
    });

    // What the server stores after its own trimming and defaults must read back to the form as "nothing changed": a difference
    // would be a phantom change the next time the item is opened and saved.
    const AWKWARD: ReadonlyArray<{ title: string; edits: Partial<FormState> }> = [
      { title: "everything typed with spaces around it", edits: { ...TYPED, name: "  Test syrup, 100 mL  ", barcode: "  0099001122  ", supplier_order_number: "  00417-B  ", unit: "  bottles  ", vendor_url: "  https://supplier.example/syrup  " } },
      { title: "notes with a trailing space and a line break (notes keep their own spacing)", edits: { ...TYPED, notes: "Shake well\nbefore use \n" } },
      { title: "numbers typed with leading zeros", edits: { ...TYPED, stock: "007", threshold: "0003" } },
      { title: "a blank unit (the server stores units)", edits: { ...TYPED, unit: "   " } },
      { title: "no name at all", edits: { ...TYPED, name: "" } },
      { title: "only the barcode", edits: { barcode: "0099001133" } },
      { title: "a supplier order number that looks like a number, a formula, a date", edits: { ...TYPED, supplier_order_number: "000000" } },
      { title: "a supplier order number in scientific notation", edits: { ...TYPED, supplier_order_number: "1E5" } },
      { title: "a supplier order number that is a formula", edits: { ...TYPED, supplier_order_number: "=1+1" } },
      { title: "a supplier order number of exactly 64 characters", edits: { ...TYPED, supplier_order_number: `X-${"7".repeat(SUPPLIER_ORDER_NUMBER_MAX_LENGTH - 2)}` } },
    ];

    it.each(AWKWARD)("reopening what was created and saving it untouched changes nothing: $title", async ({ edits }) => {
      const result = await saveLikeThePage(null, form(null, { ...edits, category_id: painAndFever().id }));
      expect(result.status).toBe(201);
      const saved = result.saved as Medication;
      expect(findNotStored(saved, result.payload)).toEqual([]);

      const reopened = await openItem(saved.id);
      const again = await saveLikeThePage(reopened, formFromMedication(reopened));
      expect(again.payload).toEqual({});
      expect(again.requested).toBe(false);
    });
  });

  // ── Editing ────────────────────────────────────────────────────────────────────────────────────

  describe("editing an item", () => {
    /** An item with every optional field filled in, made through the real route the way the form would. */
    async function populatedItem(): Promise<Medication> {
      const target = itemNamed(medications, "Ibuprofen");
      const res = await api.updateItem(target.id, {
        notes: "Keep in the blue cabinet",
        vendor_url: "https://supplier.example/ibuprofen",
        unit: "bottles",
        photo_url: "https://photos.example.invalid/ibuprofen.png",
      });
      expect(res.status).toBe(200);
      return openItem(target.id);
    }

    it("editing only the notes sends only the notes and leaves every other column of the row as it was", async () => {
      const loaded = await populatedItem();
      expect(loaded).toMatchObject({ category_id: painAndFever().id, supplier_order_number: "0092", stock: 18, unit: "bottles" });
      const before = { ...storedMedication(fake, loaded.id) };

      const result = await saveLikeThePage(loaded, form(loaded, { notes: "Checked on the shelf" }));

      expect(result.payload).toEqual({ notes: "Checked on the shelf" });
      expect(result.status).toBe(200);
      const after = storedMedication(fake, loaded.id);
      expect(omitKeys(after, "notes", "updated_at")).toEqual(omitKeys(before, "notes", "updated_at"));
      expect(after.notes).toBe("Checked on the shelf");
      expect(findNotStored(result.saved as Medication, result.payload)).toEqual([]);
    });

    it("a category another person set while the form was open is NOT put back by saving a note (the page used to send it with every save)", async () => {
      // The form is opened on Pain & Fever, stock 18.
      const loaded = await openItem(itemNamed(medications, "Ibuprofen").id);
      const opened = formFromMedication(loaded);
      expect(opened.category_id).toBe(painAndFever().id);

      // Meanwhile another person files the item under Antibiotics, and a dispense takes the stock down to 7.
      expect((await api.updateItem(loaded.id, { category_id: antibiotics().id, stock: 7 })).status).toBe(200);

      // This person edits only the notes and presses Save.
      const result = await saveLikeThePage(loaded, { ...opened, notes: "Checked on the shelf" });

      const after = storedMedication(fake, loaded.id);
      expect(String(after.category_id), "the category stays the one set in the meantime").toBe(antibiotics().id);
      expect(after.stock, "the stock set in the meantime stays").toBe(7);
      expect(after.notes).toBe("Checked on the shelf");
      expect(result.payload).toEqual({ notes: "Checked on the shelf" });
      // The page reports the item as it is stored now, not the category the form was opened with, and nothing is "not stored".
      const saved = result.saved as Medication;
      expect(saved.category_id).toBe(antibiotics().id);
      expect(findNotStored(saved, result.payload)).toEqual([]);
      for (const view of await readBack(loaded)) expect(view.category_id).toBe(antibiotics().id);
    });

    it("control: a body that DID carry the category the form was opened with puts it back (this is what the page used to send)", async () => {
      const loaded = await openItem(itemNamed(medications, "Ibuprofen").id);
      expect((await api.updateItem(loaded.id, { category_id: antibiotics().id })).status).toBe(200);

      await api.updateItem(loaded.id, { notes: "Checked on the shelf", category_id: loaded.category_id });

      expect(String(storedMedication(fake, loaded.id).category_id)).toBe(painAndFever().id);
    });

    it("a changed category is sent alone and persists: stored, read back three ways, and nothing else of the row changes", async () => {
      const loaded = await openItem(itemNamed(medications, "Acetaminophen 500").id);
      const before = { ...storedMedication(fake, loaded.id) };

      const result = await saveLikeThePage(loaded, form(loaded, { category_id: antibiotics().id }));

      expect(result.payload).toEqual({ category_id: antibiotics().id });
      expect(result.status).toBe(200);
      expect(findNotStored(result.saved as Medication, result.payload)).toEqual([]);
      expect(omitKeys(storedMedication(fake, loaded.id), "category_id", "updated_at")).toEqual(omitKeys(before, "category_id", "updated_at"));
      for (const view of await readBack(loaded)) expect(view.category_id).toBe(antibiotics().id);
    });

    it("choosing Uncategorized sends an explicit null: the category is cleared, and the saved row says so", async () => {
      const loaded = await openItem(itemNamed(medications, "Acetaminophen 500").id);

      const result = await saveLikeThePage(loaded, form(loaded, { category_id: null }));

      expect(result.payload).toEqual({ category_id: null });
      expect(result.status).toBe(200);
      expect((result.saved as Medication).category_id).toBeNull();
      expect(findNotStored(result.saved as Medication, result.payload)).toEqual([]);
      expect(storedMedication(fake, loaded.id).category_id).toBeNull();
      for (const view of await readBack(loaded)) expect(view.category_id).toBeNull();
    });

    it("an item without a category that is given one keeps it after a reload; one that stays without a category is not touched", async () => {
      const loaded = await openItem(itemNamed(medications, "Thermometer probe covers").id);
      expect(loaded.category_id).toBeNull();

      const note = await saveLikeThePage(loaded, form(loaded, { notes: "Fits the standard probe." }));
      expect(note.payload).toEqual({ notes: "Fits the standard probe." });
      expect(storedMedication(fake, loaded.id).category_id).toBeNull();

      const reopened = await openItem(loaded.id); // the form is opened again, on the item as it is stored now
      const assigned = await saveLikeThePage(reopened, form(reopened, { category_id: categories[3].id }));
      expect(assigned.payload).toEqual({ category_id: categories[3].id });
      for (const view of await readBack(loaded)) expect(view.category_id).toBe(categories[3].id);
    });

    it("a form that was opened and saved with nothing changed makes no request: the route would refuse an empty body", async () => {
      const loaded = await openItem(itemNamed(medications, "Ibuprofen").id);
      const before = snapshotDb(fake);

      const result = await saveLikeThePage(loaded, formFromMedication(loaded));

      expect(result.payload).toEqual({});
      expect(result.requested).toBe(false);
      expect(snapshotDb(fake)).toEqual(before); // not even updated_at moved

      // Why the page must not send {}: the route refuses it, so the person would see an error for pressing Save.
      const refused = await api.updateItem(loaded.id, {});
      expect(refused.status).toBe(400);
      expect(errorTextOf(await refused.json())).toBe("Nothing to update");
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("every item the list returns, opened and saved untouched, makes no request (the server's values read as unchanged)", async () => {
      const listed = await bodyList(await api.listItems());
      expect(listed.length).toBeGreaterThan(20);
      for (const row of listed) {
        const loaded = toMedication(row);
        if (loaded === null || loaded.is_unnamed) continue;
        expect(buildPayload(formFromMedication(loaded), planSupplier(formFromMedication(loaded), loaded), loaded), `item ${loaded.id}`).toEqual({});
      }
    });
  });

  // ── An unnamed item (created by a scan) ────────────────────────────────────────────────────────

  describe("an unnamed item", () => {
    it("can be completed with nothing else changed: the body is not empty, the route marks it reviewed and changes nothing else", async () => {
      const unnamed = medications.find((m) => m.is_unnamed);
      expect(unnamed).toBeDefined();
      const loaded = await openItem((unnamed as Medication).id);
      expect(loaded).toMatchObject({ name: null, is_unnamed: true });
      const before = { ...storedMedication(fake, loaded.id) };

      const result = await saveLikeThePage(loaded, formFromMedication(loaded));

      expect(result.payload).toEqual({ name: null });
      expect(result.requested).toBe(true);
      expect(result.status).toBe(200);
      const after = storedMedication(fake, loaded.id);
      expect(after.is_unnamed).toBe(false); // the save is the review
      expect(omitKeys(after, "is_unnamed", "updated_at")).toEqual(omitKeys(before, "is_unnamed", "updated_at"));
      expect((result.saved as Medication).is_unnamed).toBe(false);
      expect(findNotStored(result.saved as Medication, result.payload)).toEqual([]);
    });

    it("given only a category, sends only the category and still marks the item reviewed", async () => {
      const unnamed = medications.find((m) => m.is_unnamed);
      const loaded = await openItem((unnamed as Medication).id);

      const result = await saveLikeThePage(loaded, form(loaded, { category_id: antibiotics().id }));

      expect(result.payload).toEqual({ category_id: antibiotics().id });
      expect(storedMedication(fake, loaded.id)).toMatchObject({ is_unnamed: false, name: null });
      expect(String(storedMedication(fake, loaded.id).category_id)).toBe(antibiotics().id);
    });
  });

  // ── The supplier order number ──────────────────────────────────────────────────────────────────

  describe("the supplier order number", () => {
    const CODES: ReadonlyArray<{ title: string; typed: string; stored: string }> = [
      { title: "leading zeros", typed: "0092", stored: "0092" },
      { title: "letters and a dash", typed: "00417-B", stored: "00417-B" },
      { title: "surrounding spaces are not part of the code", typed: "  AX-1182/4  ", stored: "AX-1182/4" },
      { title: "digits only, all zeros", typed: "000000", stored: "000000" },
      { title: "scientific-notation lookalike", typed: "1E5", stored: "1E5" },
      { title: "a formula is only text", typed: "=1+1", stored: "=1+1" },
      { title: "a date lookalike", typed: "2026-11-05", stored: "2026-11-05" },
      { title: "inner spaces and case", typed: "Ab  12c", stored: "Ab  12c" },
      { title: "exactly 64 characters", typed: "Z".repeat(SUPPLIER_ORDER_NUMBER_MAX_LENGTH), stored: "Z".repeat(SUPPLIER_ORDER_NUMBER_MAX_LENGTH) },
    ];

    it.each(CODES)("a code with $title survives: payload, route, stored row and every read agree", async ({ typed, stored }) => {
      const loaded = await openItem(itemNamed(medications, "Aspirin 81").id);
      expect(loaded.supplier_order_number).toBeNull();

      const result = await saveLikeThePage(loaded, form(loaded, { supplier_order_number: typed }));

      expect(result.payload).toEqual({ supplier_order_number: stored });
      expect(typeof result.payload.supplier_order_number).toBe("string");
      expect(result.status).toBe(200);
      expect(storedMedication(fake, loaded.id).supplier_order_number).toBe(stored);
      expect(findNotStored(result.saved as Medication, result.payload)).toEqual([]);
      for (const view of await readBack(loaded)) expect(view.supplier_order_number).toBe(stored);
    });

    it("clearing the supplier order number sends an explicit null and the row ends up without one", async () => {
      const loaded = await openItem(itemNamed(medications, "Ibuprofen").id);

      const result = await saveLikeThePage(loaded, form(loaded, { supplier_order_number: "   " }));

      expect(result.payload).toEqual({ supplier_order_number: null });
      expect((result.saved as Medication).supplier_order_number).toBeNull();
      expect(findNotStored(result.saved as Medication, result.payload)).toEqual([]);
      expect(storedMedication(fake, loaded.id).supplier_order_number).toBeNull();
    });

    it("a code one character over the limit: the page's own check and the route agree, and nothing is stored", async () => {
      const loaded = await openItem(itemNamed(medications, "Aspirin 81").id);
      const tooLong = "Z".repeat(SUPPLIER_ORDER_NUMBER_MAX_LENGTH + 1);
      const typed = form(loaded, { supplier_order_number: tooLong });
      const before = snapshotDb(fake);

      // The page stops here, next to the field, and sends nothing ...
      const problem = formProblems(typed, loaded).supplier_order_number;
      expect(problem).toMatchObject({ length: 65, max: 64 });

      // ... and the route, asked anyway, refuses with the same words and stores nothing: they cannot disagree.
      const result = await saveLikeThePage(loaded, typed);
      expect(result.status).toBe(400);
      expect(errorTextOf(result.body)).toBe(problem?.message);
      expect(asRecord(result.body)).toMatchObject({ field: "supplier_order_number" });
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("an invisible character is not a length problem for the page: it is sent as typed and the route refuses it in plain words", async () => {
      const loaded = await openItem(itemNamed(medications, "Aspirin 81").id);
      const typed = form(loaded, { supplier_order_number: "AB​12" }); // a zero-width space inside
      expect(formProblems(typed, loaded)).toEqual({});
      const before = snapshotDb(fake);

      const result = await saveLikeThePage(loaded, typed);

      expect(result.payload).toEqual({ supplier_order_number: "AB​12" }); // not cleaned up behind the person's back
      expect(result.status).toBe(400);
      expect(errorTextOf(result.body)).toBe(SUPPLIER_ORDER_NUMBER_INVISIBLE_REASON);
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("an over-long code that is already stored does not get in the way of editing another field", async () => {
      // Legacy data written before any limit (an import, a hand edit in the database): seeded straight into a fresh database.
      const long = "L".repeat(70);
      const legacyFake = installFake(options);
      legacyFake.seedCategories(buildCategories(shape));
      legacyFake.seedMedications(buildMedications({ shape }).map((m) => (m.name?.startsWith("Ibuprofen") ? { ...m, supplier_order_number: long } : m)));
      const target = buildMedications({ shape }).find((m) => m.name?.startsWith("Ibuprofen"));
      const legacy = await openItem((target as Medication).id);
      expect(legacy.supplier_order_number).toBe(long);

      const typed = form(legacy, { notes: "Edited next to a long code" });
      expect(formProblems(typed, legacy)).toEqual({});
      const result = await saveLikeThePage(legacy, typed);

      expect(result.payload).toEqual({ notes: "Edited next to a long code" });
      expect(result.status).toBe(200);
      expect(storedMedication(legacyFake, legacy.id).supplier_order_number).toBe(long);
    });
  });
});

// ── A database that has not been migrated yet ─────────────────────────────────────────────────────

describe("a database without the supplier_order_number column (the migration has not been applied)", () => {
  let fake: FakeSupabase;
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake({ ...LIVE_AFTER_MIGRATION, hasSupplierColumn: false });
    ({ medications } = seedStandard(fake));
  });

  it("an edit that leaves the supplier order number alone still saves: the body does not mention the column", async () => {
    const loaded = await openItem(itemNamed(medications, "Ibuprofen").id);

    const result = await saveLikeThePage(loaded, form(loaded, { notes: "Saved before the migration" }));

    expect(result.payload).toEqual({ notes: "Saved before the migration" });
    expect(result.status).toBe(200);
    expect(storedMedication(fake, loaded.id).notes).toBe("Saved before the migration");
  });

  it("a new item without a supplier order number is created: the body does not mention the column", async () => {
    const result = await saveLikeThePage(null, form(null, { name: "Created before the migration", barcode: "0099001144" }));

    expect(result.payload).not.toHaveProperty("supplier_order_number");
    expect(result.status).toBe(201);
  });

  it("typing a supplier order number is refused in plain words and nothing is stored", async () => {
    const loaded = await openItem(itemNamed(medications, "Ibuprofen").id);
    const before = snapshotDb(fake);

    const result = await saveLikeThePage(loaded, form(loaded, { supplier_order_number: "0092" }));

    expect(result.payload).toEqual({ supplier_order_number: "0092" });
    expect(result.status).toBe(409);
    expect(errorTextOf(result.body)).toMatch(/supplier order number/i);
    expect(snapshotDb(fake)).toEqual(before);
  });
});

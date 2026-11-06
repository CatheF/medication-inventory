import { describe, expect, it } from "vitest";
import { normalizeCategory, normalizeMedication } from "@/lib/normalize";
import { buildCategories, buildMedications, FORMULA_NAMES, UNUSUAL_NAMES, fakeUuid } from "../helpers/fixtures";

const UUID = fakeUuid(3);

/** A row exactly as PostgREST returns it from the live (UUID, pre-migration) database: no supplier_order_number column. */
function liveRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 101,
    name: "Ibuprofen 200 mg, tablets",
    barcode: "0012345600007",
    photo_url: null,
    stock: 18,
    threshold: 40,
    vendor_url: null,
    unit: "units",
    notes: null,
    category_id: UUID,
    is_unnamed: false,
    created_at: "2026-08-11T16:00:00+00:00",
    updated_at: "2026-10-28T16:02:00+00:00",
    ...overrides,
  };
}

const MEDICATION_KEYS = [
  "barcode",
  "category_id",
  "created_at",
  "id",
  "is_unnamed",
  "name",
  "notes",
  "photo_url",
  "stock",
  "supplier_order_number",
  "threshold",
  "unit",
  "updated_at",
  "vendor_url",
];

describe("normalizeMedication", () => {
  it("normalizes a pre-migration UUID row (no supplier column)", () => {
    const m = normalizeMedication(liveRow());
    expect(m).toEqual({
      id: 101,
      name: "Ibuprofen 200 mg, tablets",
      barcode: "0012345600007",
      photo_url: null,
      stock: 18,
      threshold: 40,
      vendor_url: null,
      unit: "units",
      notes: null,
      category_id: UUID,
      supplier_order_number: null,
      is_unnamed: false,
      created_at: "2026-08-11T16:00:00+00:00",
      updated_at: "2026-10-28T16:02:00+00:00",
    });
  });

  it("always returns exactly the Medication keys, with supplier_order_number as null when the column is absent", () => {
    const m = normalizeMedication(liveRow());
    expect(Object.keys(m).sort()).toEqual(MEDICATION_KEYS);
    expect("supplier_order_number" in liveRow()).toBe(false);
    expect(m.supplier_order_number).toBeNull();
  });

  describe("category_id", () => {
    it("keeps a UUID string as is", () => {
      expect(normalizeMedication(liveRow({ category_id: UUID })).category_id).toBe(UUID);
    });

    it("turns a bigint category id (a JSON number) into a string", () => {
      const m = normalizeMedication(liveRow({ category_id: 7 }));
      expect(m.category_id).toBe("7");
      expect(typeof m.category_id).toBe("string");
    });

    it.each([
      ["null", null],
      ["undefined", undefined],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["an object", {}],
      ["true", true],
    ])("%s -> null (never the text 'NaN' / 'undefined')", (_label, value) => {
      expect(normalizeMedication(liveRow({ category_id: value })).category_id).toBeNull();
    });

    it("treats a row with no category_id key at all as uncategorized", () => {
      const row = liveRow();
      delete row.category_id;
      expect(normalizeMedication(row).category_id).toBeNull();
    });
  });

  describe("supplier_order_number", () => {
    it.each(["0092", "00417-B", "000000", "1E5", "12345678901234567890", "=1+1", "NX-220/100"])("keeps %j exactly", (value) => {
      expect(normalizeMedication(liveRow({ supplier_order_number: value })).supplier_order_number).toBe(value);
    });

    it.each([
      ["null", null],
      ["undefined", undefined],
      ["a number (leading zeros would already be lost)", 92],
      ["a boolean", true],
      ["an object", { value: "0092" }],
      ["an array", ["0092"]],
    ])("%s -> null, never coerced to text", (_label, value) => {
      expect(normalizeMedication(liveRow({ supplier_order_number: value })).supplier_order_number).toBeNull();
    });
  });

  describe("ids and numbers", () => {
    it("keeps a numeric id", () => {
      expect(normalizeMedication(liveRow({ id: 101 })).id).toBe(101);
    });

    it("converts a numeric string id to a number", () => {
      expect(normalizeMedication(liveRow({ id: "101" })).id).toBe(101);
    });

    it("converts numeric strings for stock and threshold", () => {
      const m = normalizeMedication(liveRow({ stock: "12", threshold: "5" }));
      expect(m.stock).toBe(12);
      expect(m.threshold).toBe(5);
    });

    it("treats null stock and threshold as 0 rather than NaN", () => {
      const m = normalizeMedication(liveRow({ stock: null, threshold: null }));
      expect(m.stock).toBe(0);
      expect(m.threshold).toBe(0);
    });

    it("keeps zero stock (does not treat it as missing)", () => {
      expect(normalizeMedication(liveRow({ stock: 0 })).stock).toBe(0);
    });
  });

  describe("text columns", () => {
    it("never turns a barcode with leading zeros into a number", () => {
      expect(normalizeMedication(liveRow({ barcode: "0049000028911" })).barcode).toBe("0049000028911");
    });

    it("stringifies a non-string barcode and uses '' for a missing one", () => {
      expect(normalizeMedication(liveRow({ barcode: 12345 })).barcode).toBe("12345");
      expect(normalizeMedication(liveRow({ barcode: null })).barcode).toBe("");
      expect(normalizeMedication(liveRow({ barcode: undefined })).barcode).toBe("");
    });

    it("keeps a null name null (an unnamed item) and an empty-looking name as typed", () => {
      expect(normalizeMedication(liveRow({ name: null })).name).toBeNull();
      expect(normalizeMedication(liveRow({ name: "" })).name).toBe("");
    });

    it("defaults unit to 'units' only when it is not text", () => {
      expect(normalizeMedication(liveRow({ unit: undefined })).unit).toBe("units");
      expect(normalizeMedication(liveRow({ unit: null })).unit).toBe("units");
      expect(normalizeMedication(liveRow({ unit: 5 })).unit).toBe("units");
      expect(normalizeMedication(liveRow({ unit: "box" })).unit).toBe("box");
    });

    it.each(["photo_url", "vendor_url", "notes"])("%s: text is kept, anything else becomes null", (key) => {
      expect(normalizeMedication(liveRow({ [key]: "https://example.invalid/x" }))[key as "photo_url"]).toBe("https://example.invalid/x");
      expect(normalizeMedication(liveRow({ [key]: 5 }))[key as "photo_url"]).toBeNull();
      expect(normalizeMedication(liveRow({ [key]: null }))[key as "photo_url"]).toBeNull();
    });

    it("does not alter hostile or unusual text (sanitizing belongs to the output layer)", () => {
      for (const name of [...FORMULA_NAMES, ...UNUSUAL_NAMES]) {
        expect(normalizeMedication(liveRow({ name })).name).toBe(name);
      }
    });
  });

  describe("flags and timestamps", () => {
    it.each([
      [true, true],
      [false, false],
      ["true", false],
      [1, false],
      [null, false],
      [undefined, false],
    ])("is_unnamed %j -> %j (strictly boolean true only)", (value, expected) => {
      expect(normalizeMedication(liveRow({ is_unnamed: value })).is_unnamed).toBe(expected);
    });

    it("uses '' for missing or non-text timestamps", () => {
      const m = normalizeMedication(liveRow({ created_at: null, updated_at: 12345 }));
      expect(m.created_at).toBe("");
      expect(m.updated_at).toBe("");
    });
  });

  describe("purity", () => {
    it("does not mutate its input", () => {
      const row = Object.freeze(liveRow({ category_id: 7 })) as Record<string, unknown>;
      expect(() => normalizeMedication(row)).not.toThrow();
      expect(row.category_id).toBe(7);
    });

    it("drops unknown columns instead of leaking them to the client", () => {
      const m = normalizeMedication(liveRow({ internal_note: "secret" }));
      expect(Object.keys(m).sort()).toEqual(MEDICATION_KEYS);
      expect("internal_note" in m).toBe(false);
    });

    it("is idempotent for already-normalized fixtures of both id shapes", () => {
      for (const shape of ["uuid", "bigint"] as const) {
        for (const med of buildMedications({ shape })) {
          expect(normalizeMedication(med as unknown as Record<string, unknown>)).toEqual(med);
        }
      }
    });

    it("produces JSON without NaN-induced nulls for realistic rows", () => {
      const m = normalizeMedication(liveRow({ stock: "12", category_id: 3 }));
      const roundTripped = JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
      expect(roundTripped.stock).toBe(12);
      expect(roundTripped.id).toBe(101);
      expect(roundTripped.category_id).toBe("3");
    });
  });
});

describe("normalizeCategory", () => {
  it("keeps a UUID id and the name", () => {
    expect(normalizeCategory({ id: UUID, name: "Antibiotics", created_at: "2026-11-01T12:00:00+00:00" })).toEqual({
      id: UUID,
      name: "Antibiotics",
      created_at: "2026-11-01T12:00:00+00:00",
    });
  });

  it("turns a bigint id (a JSON number) into a string", () => {
    const c = normalizeCategory({ id: 5, name: "First Aid", created_at: null });
    expect(c.id).toBe("5");
    expect(typeof c.id).toBe("string");
  });

  it("uses null for a missing or non-text created_at", () => {
    expect(normalizeCategory({ id: 1, name: "A" }).created_at).toBeNull();
    expect(normalizeCategory({ id: 1, name: "A", created_at: 5 }).created_at).toBeNull();
  });

  it("never returns a non-string id or name, even for garbage rows", () => {
    for (const row of [{}, { id: NaN, name: 5 }, { id: true, name: null }, { id: {}, name: [] }, { id: undefined }]) {
      const c = normalizeCategory(row);
      expect(typeof c.id).toBe("string");
      expect(typeof c.name).toBe("string");
      expect(c.id).not.toMatch(/NaN|undefined|null/);
    }
  });

  it("does not trim or otherwise alter the stored name", () => {
    expect(normalizeCategory({ id: 1, name: "  Pain & Fever  " }).name).toBe("  Pain & Fever  ");
    expect(normalizeCategory({ id: 1, name: "Émulsion — 5 %" }).name).toBe("Émulsion — 5 %");
  });

  it("drops unknown columns and does not mutate its input", () => {
    const row = Object.freeze({ id: 2, name: "X", created_at: null, owner: "someone" }) as Record<string, unknown>;
    const c = normalizeCategory(row);
    expect(Object.keys(c).sort()).toEqual(["created_at", "id", "name"]);
  });

  it("is idempotent for already-normalized fixtures of both id shapes", () => {
    for (const shape of ["uuid", "bigint"] as const) {
      for (const cat of buildCategories(shape)) {
        expect(normalizeCategory(cat as unknown as Record<string, unknown>)).toEqual(cat);
      }
    }
  });
});

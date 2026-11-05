// Requirement-driven tests: GET /api/medications (TASK.md sections 2/8/9 as far as the API is involved; SPEC 1, 2.6).
//
//   "Ensure search, filtering, sorting, and pagination work together without hiding items or implying that a partial
//    page is the complete category."
//   "Existing items without categories remain accessible."   "errors shown as empty lists" (section 7)
//
// The listing must be COMPLETE even when the database answers at most N rows per request (PostgREST max-rows, commonly
// 1000), and a failure must be a failure, never a 200 with an empty or partial list. Both id shapes are exercised.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Medication } from "@/lib/db";
import { bodyList, bodyRecord, errorTextOf, ID_SHAPES, isRecord } from "../helpers/api-test-kit";
import { installFake, type FakeSupabase, type FakeSupabaseOptions } from "../helpers/fake-supabase";
import { buildCategories, buildManyMedications, type IdShape } from "../helpers/fixtures";
import { seedStandard } from "../helpers/fixtures-extra";
import { api } from "../helpers/route-client";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

import * as listRoute from "@/app/api/medications/route";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

/** Installs a fake holding `count` bulk items (ids 10001..) and the categories they point at. */
function bulkFake(options: FakeSupabaseOptions, shape: IdShape, count: number): { fake: FakeSupabase; seeded: Medication[] } {
  const fake = installFake(options);
  fake.seedCategories(buildCategories(shape));
  const seeded = buildManyMedications(count, shape);
  fake.seedMedications(seeded);
  return { fake, seeded };
}

function idsOf(items: Record<string, unknown>[]): number[] {
  return items.map((m) => m.id as number);
}

describe.each(ID_SHAPES)("GET /api/medications is complete and honest on the $label", ({ options, shape }) => {
  describe("completeness when the database caps every read", () => {
    it("returns all 2,500 items when the database answers at most 1,000 rows per request, in name order, each once", async () => {
      const { fake, seeded } = bulkFake({ ...options, maxRows: 1000 }, shape, 2500);
      const res = await api.listItems();
      expect(res.status).toBe(200);
      const items = await bodyList(res);
      expect(items).toHaveLength(2500);
      const ids = idsOf(items);
      expect(new Set(ids).size).toBe(2500);
      expect(ids).toEqual(seeded.map((m) => m.id)); // bulk names ascend with their ids
      expect(fake.callsFor("medications").filter((c) => c.op === "select").length).toBeGreaterThanOrEqual(3);
    });

    it.each([0, 1, 999, 1000, 1001, 1999, 2000, 2001])(
      "is complete for exactly %i items when the database caps reads at 1,000 (page boundaries lose nothing)",
      async (count) => {
        const { seeded } = bulkFake({ ...options, maxRows: 1000 }, shape, count);
        const items = await bodyList(await api.listItems());
        expect(idsOf(items)).toEqual(seeded.map((m) => m.id));
      }
    );

    it("is complete when the database cap (100) is far below the page size the app asks for", async () => {
      const { seeded } = bulkFake({ ...options, maxRows: 100 }, shape, 350);
      const items = await bodyList(await api.listItems());
      expect(idsOf(items)).toEqual(seeded.map((m) => m.id));
    });

    it("is complete when the database does not report a total (count header stripped by a proxy)", async () => {
      const { seeded } = bulkFake({ ...options, maxRows: 1000, countSupported: false }, shape, 2500);
      const items = await bodyList(await api.listItems());
      expect(idsOf(items)).toEqual(seeded.map((m) => m.id));
    });

    it("is complete when the total is an exact multiple of the cap and no total is reported", async () => {
      const { seeded } = bulkFake({ ...options, maxRows: 1000, countSupported: false }, shape, 2000);
      const items = await bodyList(await api.listItems());
      expect(idsOf(items)).toEqual(seeded.map((m) => m.id));
    });

    it("loses none of the original items when a new item that sorts first arrives between two pages (offsets shift by one)", async () => {
      const { fake, seeded } = bulkFake({ ...options, maxRows: 1000 }, shape, 2500);
      let reads = 0;
      fake.onCall((call) => {
        if (call.op === "select" && call.table === "medications" && ++reads === 2) {
          fake.seedMedications([{ id: 20000, barcode: "000000000000", name: "A newcomer that sorts first", stock: 1, threshold: 1 }]);
        }
      });
      const ids = idsOf(await bodyList(await api.listItems()));
      expect(new Set(ids).size).toBe(ids.length); // never listed twice
      for (const original of seeded) expect(ids).toContain(original.id); // never lost
    });

    it("fails with an error instead of returning a partial list when a later page cannot be read", async () => {
      const { fake } = bulkFake({ ...options, maxRows: 1000 }, shape, 2500);
      let reads = 0;
      fake.onCall((call) => {
        if (call.op === "select" && call.table === "medications" && ++reads === 2) {
          fake.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "medications", op: "select" });
        }
      });
      const res = await api.listItems();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(false);
      expect(errorTextOf(body)).toMatch(/can.t reach the database/i);
    });

    it("fails with a 500 'too large' error instead of a silently truncated list when the safety limit of 50 pages is reached", async () => {
      const { fake } = bulkFake({ ...options, maxRows: 10 }, shape, 600);
      const res = await api.listItems();
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(false);
      expect(errorTextOf(body)).toMatch(/too large/i);
      expect(fake.callsFor("medications").filter((c) => c.op === "select").length).toBeLessThanOrEqual(50);
    });

    it("allows exactly 50 pages (500 items at 10 rows per page) and refuses 501 with an error instead of a silently short list", async () => {
      const allowed = bulkFake({ ...options, maxRows: 10 }, shape, 500);
      const ok = await api.listItems();
      expect(ok.status).toBe(200);
      expect(idsOf(await bodyList(ok))).toEqual(allowed.seeded.map((m) => m.id));

      bulkFake({ ...options, maxRows: 10 }, shape, 501);
      const tooMany = await api.listItems();
      expect(tooMany.status).toBe(500);
      expect(errorTextOf(await tooMany.json())).toMatch(/too large/i);
    });

    it("lists two different items that share a name even when one ends a page and the other starts the next (de-duplication is by id, never by name)", async () => {
      const { seeded } = bulkFake({ ...options, maxRows: 1000 }, shape, 1001);
      // Renamed to sort last, the final two items are the 1000th row (end of page 1) and the 1001st (start of page 2).
      const [a, b] = [seeded[999], seeded[1000]];
      const twinName = "Zzz twin item, 10 mg";
      expect((await api.updateItem(a.id, { name: twinName })).status).toBe(200);
      expect((await api.updateItem(b.id, { name: twinName })).status).toBe(200);
      const items = await bodyList(await api.listItems());
      expect(items).toHaveLength(1001);
      expect(items.filter((m) => m.name === twinName).map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    });

    it("answers an empty inventory with an empty list and HTTP 200 (an empty database is not an error)", async () => {
      installFake(options);
      const res = await api.listItems();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });
  });

  describe("filters (each one still complete across pages)", () => {
    it("returns only low-stock items for lowStock=true, including items exactly at their threshold and zero-stock zero-threshold items", async () => {
      const fake = installFake(options);
      seedStandard(fake);
      fake.seedMedications([
        { id: 500, barcode: "EQ-1", name: "At threshold", stock: 10, threshold: 10 },
        { id: 501, barcode: "ZERO-1", name: "Zero and zero", stock: 0, threshold: 0 },
        { id: 502, barcode: "OK-1", name: "Just above", stock: 11, threshold: 10 },
      ]);
      const low = await bodyList(await api.listItems("?lowStock=true"));
      expect(low.length).toBeGreaterThan(5);
      for (const item of low) expect(item.stock as number).toBeLessThanOrEqual(item.threshold as number);
      const ids = idsOf(low);
      expect(ids).toContain(500);
      expect(ids).toContain(501);
      expect(ids).not.toContain(502);
      const all = await bodyList(await api.listItems());
      const expected = all.filter((m) => (m.stock as number) <= (m.threshold as number));
      expect(ids).toEqual(idsOf(expected));
    });

    it("finds low-stock items that sit beyond the first page of a large inventory", async () => {
      const { seeded } = bulkFake({ ...options, maxRows: 1000 }, shape, 2500);
      const low = await bodyList(await api.listItems("?lowStock=true"));
      const expected = seeded.filter((m) => m.stock <= m.threshold);
      expect(idsOf(low)).toEqual(expected.map((m) => m.id));
      expect(expected.some((m) => m.id > 11000)).toBe(true); // the fixture really has low-stock rows past page one
    });

    it("switches a filter on only for the exact word true: lowStock=false, unnamed=false and lowStock=1 list everything", async () => {
      const fake = installFake(options);
      const { medications } = seedStandard(fake);
      for (const query of ["?lowStock=false", "?unnamed=false", "?lowStock=1", "?lowStock=&unnamed="]) {
        expect(await bodyList(await api.listItems(query)), query).toHaveLength(medications.length);
      }
    });

    it("returns only items still waiting for a name for unnamed=true", async () => {
      const fake = installFake(options);
      const { medications } = seedStandard(fake);
      const unnamed = await bodyList(await api.listItems("?unnamed=true"));
      expect(idsOf(unnamed)).toEqual(medications.filter((m) => m.is_unnamed).map((m) => m.id));
      expect(unnamed.length).toBeGreaterThanOrEqual(1);
    });

    it("returns exactly one category's items for category=<id>, for every category", async () => {
      const fake = installFake(options);
      const { categories, medications } = seedStandard(fake);
      for (const category of categories) {
        const items = await bodyList(await api.listItems(`?category=${category.id}`));
        const expected = medications.filter((m) => m.category_id === category.id);
        expect(expected.length).toBeGreaterThan(0);
        expect(new Set(idsOf(items))).toEqual(new Set(expected.map((m) => m.id)));
        for (const item of items) expect(item.category_id).toBe(category.id);
      }
    });

    it("returns exactly the uncategorized items for category=none (case and spaces don't matter)", async () => {
      const fake = installFake(options);
      const { medications } = seedStandard(fake);
      const expected = new Set(medications.filter((m) => m.category_id === null).map((m) => m.id));
      for (const spelling of ["none", "NONE", " None "]) {
        const items = await bodyList(await api.listItems(`?category=${encodeURIComponent(spelling)}`));
        expect(new Set(idsOf(items))).toEqual(expected);
      }
    });

    it("treats an empty category parameter as 'no category filter' (everything)", async () => {
      const fake = installFake(options);
      const { medications } = seedStandard(fake);
      expect(await bodyList(await api.listItems("?category="))).toHaveLength(medications.length);
    });

    it("answers 200 with an empty list for a well-formed category id that has no items (a legitimate empty category)", async () => {
      const fake = installFake(options);
      seedStandard(fake);
      const absent = shape === "uuid" ? "deadbeef-0000-4000-8000-00000000ffff" : "987654";
      const res = await api.listItems(`?category=${absent}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it("combines filters: a category together with lowStock, and uncategorized together with unnamed", async () => {
      const fake = installFake(options);
      const { categories, medications } = seedStandard(fake);
      const lowInFirstAid = await bodyList(await api.listItems(`?category=${categories[3].id}&lowStock=true`));
      expect(new Set(idsOf(lowInFirstAid))).toEqual(
        new Set(medications.filter((m) => m.category_id === categories[3].id && m.stock <= m.threshold).map((m) => m.id))
      );
      const unnamedUncategorized = await bodyList(await api.listItems("?category=none&unnamed=true"));
      expect(new Set(idsOf(unnamedUncategorized))).toEqual(
        new Set(medications.filter((m) => m.category_id === null && m.is_unnamed).map((m) => m.id))
      );
    });

    it("keeps a category view complete across pages (2,500 items, cap 1,000)", async () => {
      const { seeded } = bulkFake({ ...options, maxRows: 1000 }, shape, 2500);
      const target = seeded.find((m) => m.category_id !== null)?.category_id;
      if (!target) throw new Error("fixture has no categorized item");
      const items = await bodyList(await api.listItems(`?category=${target}`));
      expect(idsOf(items)).toEqual(seeded.filter((m) => m.category_id === target).map((m) => m.id));
    });

    it.each([
      ["the text NaN", "NaN"],
      ["the text undefined", "undefined"],
      ["the text null", "null"],
      ["zero", "0"],
      ["a negative number", "-3"],
      ["a fraction", "1.5"],
      ["a word", "antibiotics"],
      ["SQL-looking text", "1;drop table medications"],
      ["two numbers separated by a space", "1 2"],
    ])("rejects %s as a category filter with 400 and reads nothing from the database", async (_label, value) => {
      const fake = installFake(options);
      seedStandard(fake);
      fake.clearCalls();
      const res = await api.listItems(`?category=${encodeURIComponent(value)}`);
      expect(res.status).toBe(400);
      const body = await bodyRecord(res);
      expect(body.field).toBe("category");
      expect(errorTextOf(body)).toMatch(/category/i);
      expect(fake.calls).toEqual([]);
    });

    it("rejects an id in the other database's shape with a clear 400 (never an empty 200 list that looks like an empty category)", async () => {
      const fake = installFake(options);
      seedStandard(fake);
      const foreign = shape === "uuid" ? "7" : "deadbeef-0000-4000-8000-000000000001";
      const res = await api.listItems(`?category=${foreign}`);
      expect(res.status).toBe(400);
      expect(Array.isArray(await res.json())).toBe(false);
    });

    it("accepts an upper-case UUID or a zero-padded number as the category filter and finds the same items", async () => {
      const fake = installFake(options);
      const { categories, medications } = seedStandard(fake);
      const raw = shape === "uuid" ? categories[0].id.toUpperCase() : `00${categories[0].id}`;
      const items = await bodyList(await api.listItems(`?category=${raw}`));
      expect(new Set(idsOf(items))).toEqual(new Set(medications.filter((m) => m.category_id === categories[0].id).map((m) => m.id)));
    });
  });

  describe("order and shape of the list", () => {
    it("orders by name, puts unnamed items last, and breaks ties by barcode", async () => {
      const fake = installFake(options);
      fake.seedMedications([
        { id: 1, barcode: "Z9", name: "Apple" },
        { id: 2, barcode: "B2", name: "Banana" },
        { id: 3, barcode: "B1", name: "Banana" },
        { id: 4, barcode: "N2", name: null, is_unnamed: true },
        { id: 5, barcode: "N1", name: null, is_unnamed: true },
      ]);
      const items = await bodyList(await api.listItems());
      expect(items.map((m) => `${String(m.name)}/${String(m.barcode)}`)).toEqual([
        "Apple/Z9",
        "Banana/B1",
        "Banana/B2",
        "null/N1",
        "null/N2",
      ]);
    });

    it("returns every field of the item contract with normalized types: numeric ids, string category ids, text supplier numbers", async () => {
      const fake = installFake(options);
      const { medications } = seedStandard(fake);
      const items = await bodyList(await api.listItems());
      const sample = items.find((m) => m.supplier_order_number === "00417-B");
      if (!sample) throw new Error("expected the seeded item with supplier number 00417-B");
      expect(Object.keys(sample).sort()).toEqual(
        [
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
        ].sort()
      );
      expect(typeof sample.id).toBe("number");
      expect(typeof sample.category_id).toBe("string");
      expect(typeof sample.stock).toBe("number");
      for (const item of items) {
        expect(item.category_id === null || typeof item.category_id === "string").toBe(true);
        expect(item.supplier_order_number === null || typeof item.supplier_order_number === "string").toBe(true);
      }
      expect(items).toHaveLength(medications.length);
    });

    it("keeps barcodes with leading zeros as text, so 0049000028911 and 49000028911 stay two different items", async () => {
      const fake = installFake(options);
      fake.seedMedications([
        { id: 1, barcode: "0049000028911", name: "Leading zeros" },
        { id: 2, barcode: "49000028911", name: "No leading zeros" },
      ]);
      const items = await bodyList(await api.listItems());
      expect(items.map((m) => m.barcode).sort()).toEqual(["0049000028911", "49000028911"]);
    });
  });

  describe("failures are failures, never an empty list", () => {
    it("answers 503 with a connection message (not 200 []) when the database can't be reached", async () => {
      installFake(options).failNext({ code: "", message: "TypeError: fetch failed" }, { table: "medications" });
      const res = await api.listItems();
      expect(res.status).toBe(503);
      expect(Array.isArray(await res.json())).toBe(false);
    });

    it("answers 500 with the API-key message when the database rejects the app's key", async () => {
      installFake(options).failNext({ code: "PGRST301", message: "JWT expired" }, { table: "medications" });
      const res = await api.listItems();
      expect(res.status).toBe(500);
      expect(errorTextOf(await res.json())).toMatch(/API key/i);
    });

    it("answers 403 with a plain permission message when the database user lacks the privilege to read", async () => {
      installFake(options).failNext({ code: "42501", message: "permission denied for table medications" }, { table: "medications" });
      const res = await api.listItems();
      expect(res.status).toBe(403);
      expect(errorTextOf(await res.json())).toMatch(/permission denied/i);
    });

    it("answers 500 with the error code for an unexpected database error", async () => {
      installFake(options).failNext({ code: "XX000", message: "internal error" }, { table: "medications" });
      const res = await api.listItems();
      expect(res.status).toBe(500);
      const body = await bodyRecord(res);
      expect(body.error).toBe("Unexpected database error.");
      expect(body.code).toBe("XX000");
    });

    it("keeps error bodies to a message, a code, a short detail and a field: no stack trace, and the database's own text is cut to 300 characters", async () => {
      installFake(options).failNext({ code: "XX000", message: `boom ${"x".repeat(2000)}`, details: "Key (barcode)=(0049000028911) already exists." }, { table: "medications" });
      const res = await api.listItems();
      expect(res.status).toBe(500);
      const body = await bodyRecord(res);
      for (const key of Object.keys(body)) expect(["error", "code", "detail", "field"]).toContain(key);
      expect(typeof body.detail).toBe("string");
      expect((body.detail as string).length).toBeLessThanOrEqual(300);
      expect(JSON.stringify(body)).not.toMatch(/\bat\s+\S+\s+\(.*:\d+:\d+\)/); // no "at fn (file:line:col)" stack lines
    });

    it("answers 500 instead of an empty list when the database client throws", async () => {
      installFake(options).onCall(() => {
        throw new Error("socket hang up");
      });
      const res = await api.listItems();
      expect(res.status).toBe(500);
      expect(isRecord(await res.json())).toBe(true);
    });

    it("answers a failed filtered read with an error as well (not an empty category)", async () => {
      const fake = installFake(options);
      const { categories } = seedStandard(fake);
      fake.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "medications" });
      const res = await api.listItems(`?category=${categories[0].id}`);
      expect(res.status).toBe(503);
      expect(Array.isArray(await res.json())).toBe(false);
    });
  });

  describe("reading never changes anything and is never cached", () => {
    it("issues no write of any kind while listing, with or without filters", async () => {
      const fake = installFake(options);
      const { categories } = seedStandard(fake);
      const before = { m: fake.dump("medications"), c: fake.dump("categories") };
      await api.listItems();
      await api.listItems("?lowStock=true");
      await api.listItems(`?category=${categories[0].id}`);
      await api.listItems("?category=none&unnamed=true");
      expect(fake.writes()).toEqual([]);
      expect(fake.dump("medications")).toEqual(before.m);
      expect(fake.dump("categories")).toEqual(before.c);
    });

    it("opts out of static caching and marks every answer no-store, so a saved edit can't look lost behind a stale copy", async () => {
      installFake(options);
      expect(listRoute.dynamic).toBe("force-dynamic");
      expect((await api.listItems()).headers.get("cache-control")).toBe("no-store");
      expect((await api.listItems("?category=nope")).headers.get("cache-control")).toBe("no-store");
    });
  });
});

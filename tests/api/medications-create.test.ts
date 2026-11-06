// Requirement-driven tests: POST /api/medications.
//
// Item creation must keep working for every existing caller (the Scan tab and /kiosk create an unnamed item for an
// unknown barcode; the Admin form creates complete items), must refuse bad input with a message naming the field, and
// must never report success for a row that was not stored. Both id shapes are exercised.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Category } from "@/lib/db";
import {
  absentCategoryId,
  asRecord,
  bodyList,
  bodyRecord,
  errorTextOf,
  ID_SHAPES,
  snapshotDb,
  storedMedication,
} from "../helpers/api-test-kit";
import { installFake, type FakeSupabase } from "../helpers/fake-supabase";
import { UNUSUAL_NAMES } from "../helpers/fixtures";
import { jsonRequest, seedStandard } from "../helpers/fixtures-extra";
import { api } from "../helpers/route-client";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

import { POST as postRaw } from "@/app/api/medications/route";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe.each(ID_SHAPES)("POST /api/medications on the $label", ({ options }) => {
  let fake: FakeSupabase;
  let categories: Category[];
  beforeEach(() => {
    fake = installFake(options);
    ({ categories } = seedStandard(fake));
  });

  describe("existing callers keep working", () => {
    it("creates the unnamed item the Scan tab and the kiosk ask for when a barcode is unknown (name null, stock 0, threshold 10, is_unnamed true)", async () => {
      const res = await api.createItem({ name: null, barcode: "0049000099991", stock: 0, threshold: 10, unit: "units", is_unnamed: true });
      expect(res.status).toBe(201);
      expect(await bodyRecord(res)).toMatchObject({
        name: null,
        barcode: "0049000099991",
        stock: 0,
        threshold: 10,
        unit: "units",
        is_unnamed: true,
        category_id: null,
        supplier_order_number: null,
      });
      // ... and the scanner's very next step, looking the barcode up again, finds it.
      const found = await api.lookup("0049000099991");
      expect(found.status).toBe(200);
      expect((await bodyRecord(found)).is_unnamed).toBe(true);
    });

    it("answers 409 'Barcode already exists' for a barcode that exists, which is how the scanner learns another device just created it", async () => {
      await api.createItem({ barcode: "RACE-1", name: null, is_unnamed: true });
      const again = await api.createItem({ barcode: "RACE-1", name: null, is_unnamed: true });
      expect(again.status).toBe(409);
      expect(errorTextOf(await again.json())).toMatch(/barcode already exists/i);
      expect(fake.dump("medications").filter((m) => m.barcode === "RACE-1")).toHaveLength(1);
    });

    it("saves the Admin form's create payload (every field, blanks sent as null or empty) exactly as typed", async () => {
      const payload = {
        name: "Doxycycline 100 mg, capsules",
        barcode: "0049000077001",
        photo_url: null,
        unit: "units",
        stock: 20,
        threshold: 8,
        vendor_url: null,
        notes: null,
        category_id: categories[2].id,
        supplier_order_number: "00417-B",
      };
      const res = await api.createItem(payload);
      expect(res.status).toBe(201);
      const created = await bodyRecord(res);
      expect(created).toMatchObject({ ...payload, is_unnamed: false });
      expect(String(storedMedication(fake, created.id as number).category_id)).toBe(categories[2].id);
    });

    it("saves an Admin form payload whose optional boxes were left empty (empty strings) without storing empty strings", async () => {
      const res = await api.createItem({
        name: "",
        barcode: "ADMIN-EMPTY-1",
        photo_url: null,
        unit: "",
        stock: 0,
        threshold: 10,
        vendor_url: "",
        notes: "",
        category_id: "",
      });
      expect(res.status).toBe(201);
      expect(await bodyRecord(res)).toMatchObject({ name: null, unit: "units", vendor_url: null, notes: null, category_id: null });
    });

    it("makes the created item visible at once to a fresh list and a barcode lookup (a reload shows it)", async () => {
      const created = await bodyRecord(await api.createItem({ barcode: "VIS-1", name: "Visible straight away" }));
      expect((await bodyList(await api.listItems())).some((m) => m.id === created.id)).toBe(true);
      expect((await bodyRecord(await api.lookup("VIS-1"))).id).toBe(created.id);
    });
  });

  describe("defaults and normalization", () => {
    it("applies the documented defaults when only a barcode is given", async () => {
      const res = await api.createItem({ barcode: "DEF-1" });
      expect(res.status).toBe(201);
      expect(await bodyRecord(res)).toMatchObject({
        barcode: "DEF-1",
        name: null,
        photo_url: null,
        stock: 0,
        threshold: 10,
        vendor_url: null,
        unit: "units",
        notes: null,
        category_id: null,
        supplier_order_number: null,
        is_unnamed: false,
      });
    });

    it.each([
      ["name", "  Padded name  ", "Padded name"],
      ["name", "   ", null],
      ["unit", "  boxes  ", "boxes"],
      ["unit", "   ", "units"],
      ["unit", null, "units"],
      ["vendor_url", "  https://example.invalid/v  ", "https://example.invalid/v"],
      ["vendor_url", "  ", null],
      ["photo_url", "  https://example.invalid/p.png  ", "https://example.invalid/p.png"],
      ["photo_url", "", null],
      ["notes", "  first line\n\n  second line  ", "  first line\n\n  second line  "],
      ["notes", " \n\t ", null],
    ])("normalizes %s %j to %j", async (field, input, expected) => {
      const res = await api.createItem({ barcode: "NORM-1", [field]: input });
      expect(res.status).toBe(201);
      expect((await bodyRecord(res))[field]).toBe(expected);
    });

    it.each(UNUSUAL_NAMES.map((name) => [name]))("stores the name %j as typed (commas, quotes, line breaks, accents, scripts and emoji survive a reload)", async (name) => {
      const res = await api.createItem({ barcode: `NAME-${name.length}-${name.codePointAt(0)}`, name });
      expect(res.status).toBe(201);
      const created = await bodyRecord(res);
      expect(created.name).toBe(name.trim());
      expect((await bodyRecord(await api.getItem(created.id as number))).name).toBe(name.trim());
    });

    it("keeps leading zeros and letters in the barcode (it is text, never a number) and trims only its ends", async () => {
      const res = await api.createItem({ barcode: "  0049000077002  ", name: "Leading zeros" });
      expect(res.status).toBe(201);
      expect((await bodyRecord(res)).barcode).toBe("0049000077002");
      const alnum = await api.createItem({ barcode: "MED-0007/B", name: "Letters" });
      expect((await bodyRecord(alnum)).barcode).toBe("MED-0007/B");
    });

    it("treats zero as a real value: a threshold of 0 and a stock of 0 are stored, not replaced by the default threshold of 10", async () => {
      const res = await api.createItem({ barcode: "ZERO-1", name: "Zero values", stock: 0, threshold: 0 });
      expect(res.status).toBe(201);
      expect(await bodyRecord(res)).toMatchObject({ stock: 0, threshold: 0 });
    });

    it("treats real __proto__ and constructor keys in the body as ordinary, ignored keys", async () => {
      const raw = '{"barcode":"PROTO-1","__proto__":{"evil":1},"constructor":{"x":1},"toString":"nope","hasOwnProperty":1}';
      const res = await postRaw(
        new Request("http://localhost/api/medications", { method: "POST", headers: { "content-type": "application/json" }, body: raw }) as unknown as Parameters<typeof postRaw>[0]
      );
      expect(res.status).toBe(201);
      expect(({} as Record<string, unknown>).evil).toBeUndefined();
      const insert = fake.writes().find((c) => c.op === "insert" && c.table === "medications");
      expect(Object.keys(asRecord(insert?.payload, "insert payload"))).not.toContain("__proto__");
      expect(Object.keys(asRecord(insert?.payload, "insert payload"))).not.toContain("constructor");
    });

    it("ignores keys a client may not set (id, created_at, updated_at, unknown names): the database assigns them", async () => {
      const res = await api.createItem({ barcode: "EXTRA-1", id: 424242, created_at: "2001-01-01T00:00:00Z", updated_at: "2001-01-01T00:00:00Z", color: "red" });
      expect(res.status).toBe(201);
      const created = await bodyRecord(res);
      expect(created.id).not.toBe(424242);
      expect(String(created.created_at)).not.toMatch(/^2001/);
      expect(created).not.toHaveProperty("color");
    });
  });

  describe("rejecting bad input: 400, the field name, a readable message, nothing stored", () => {
    it.each([
      ["missing", undefined],
      ["null", null],
      ["empty", ""],
      ["only spaces", "   "],
    ])("rejects a %s barcode", async (_label, barcode) => {
      const before = snapshotDb(fake);
      const res = await api.createItem({ name: "No barcode", barcode });
      expect(res.status).toBe(400);
      const body = await bodyRecord(res);
      expect(body.field).toBe("barcode");
      expect(errorTextOf(body)).toBe("Barcode is required");
      expect(snapshotDb(fake)).toEqual(before);
    });

    it.each([
      ["a number", 4900002891],
      ["a boolean", true],
      ["an object", { code: "1" }],
    ])("rejects %s as a barcode (a number has already lost its leading zeros)", async (_label, barcode) => {
      const before = snapshotDb(fake);
      const res = await api.createItem({ barcode });
      expect(res.status).toBe(400);
      expect((await bodyRecord(res)).field).toBe("barcode");
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("accepts a 1024-character barcode (the original stored any length) and rejects 1025 characters", async () => {
      expect((await api.createItem({ barcode: "9".repeat(1024) })).status).toBe(201);
      const res = await api.createItem({ barcode: "9".repeat(1025) });
      expect(res.status).toBe(400);
      expect(errorTextOf(await res.json())).toMatch(/1024/);
    });

    it("rejects a barcode containing a NUL character (the database cannot store it)", async () => {
      const res = await api.createItem({ barcode: "AB\u0000CD" });
      expect(res.status).toBe(400);
      expect((await bodyRecord(res)).field).toBe("barcode");
    });

    it.each([
      ["stock", -1],
      ["stock", 1.5],
      ["stock", "5"],
      ["stock", null],
      ["stock", Number.NaN],
      ["stock", 2147483648],
      ["stock", true],
      ["threshold", -1],
      ["threshold", 0.1],
      ["threshold", "10"],
      ["threshold", null],
      ["threshold", 2147483648],
    ])("rejects %s = %j as not a whole number from 0 to 2,147,483,647, and stores nothing", async (field, value) => {
      const before = snapshotDb(fake);
      const res = await api.createItem({ barcode: "CNT-1", [field]: value });
      expect(res.status).toBe(400);
      const body = await bodyRecord(res);
      expect(body.field).toBe(field);
      expect(errorTextOf(body)).toMatch(/whole number/i);
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("accepts zero and the largest whole number the database column holds for stock and threshold", async () => {
      const res = await api.createItem({ barcode: "CNT-2", stock: 0, threshold: 2147483647 });
      expect(res.status).toBe(201);
      expect(await bodyRecord(res)).toMatchObject({ stock: 0, threshold: 2147483647 });
    });

    it.each([
      ["name", 5],
      ["name", { first: "x" }],
      ["unit", 5],
      ["notes", 5],
      ["vendor_url", 5],
      ["photo_url", ["x"]],
      ["name", "Bad\u0000name"],
      ["notes", "Bad\u0000notes"],
    ])("rejects %s = %j (text expected, no NUL) and stores nothing", async (field, value) => {
      const before = snapshotDb(fake);
      const res = await api.createItem({ barcode: "TXT-1", [field]: value });
      expect(res.status).toBe(400);
      expect((await bodyRecord(res)).field).toBe(field);
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("rejects an is_unnamed that is not true or false", async () => {
      const res = await api.createItem({ barcode: "UN-1", is_unnamed: "yes" });
      expect(res.status).toBe(400);
      expect((await bodyRecord(res)).field).toBe("is_unnamed");
    });

    it("treats a null is_unnamed as the default (false)", async () => {
      const res = await api.createItem({ barcode: "UN-2", is_unnamed: null });
      expect(res.status).toBe(201);
      expect((await bodyRecord(res)).is_unnamed).toBe(false);
    });

    it.each([
      ["text that is not JSON", "not json"],
      ["an empty body", ""],
      ["a JSON array", "[]"],
      ["JSON null", "null"],
      ["a bare number", "42"],
    ])("rejects %s with 400 and writes nothing", async (_label, raw) => {
      const res = await postRaw(
        new Request("http://localhost/api/medications", { method: "POST", headers: { "content-type": "application/json" }, body: raw }) as unknown as Parameters<typeof postRaw>[0]
      );
      expect(res.status).toBe(400);
      expect(errorTextOf(await res.json())).toMatch(/JSON/);
      expect(fake.writes()).toEqual([]);
    });

    it("rejects a category that does not exist and does not create the item", async () => {
      const before = snapshotDb(fake);
      const res = await api.createItem({ barcode: "CAT-X", category_id: absentCategoryId(options.categoryIdType ?? "uuid") });
      expect(res.status).toBe(400);
      expect(errorTextOf(await res.json())).toMatch(/category no longer exists/i);
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("does not partially create anything when validation fails after other fields were fine", async () => {
      const before = snapshotDb(fake);
      const res = await api.createItem({ barcode: "PART-1", name: "Looks fine", stock: 10, threshold: -4, category_id: categories[0].id });
      expect(res.status).toBe(400);
      expect(snapshotDb(fake)).toEqual(before);
      expect(fake.writes()).toEqual([]);
    });
  });

  describe("database failures are failures", () => {
    it("answers 403 with a plain message (technical cause in its own field), and stores nothing, when the database refuses the insert", async () => {
      fake.setRls("medications", { select: true, insert: false, update: true, delete: true });
      const before = snapshotDb(fake);
      const res = await api.createItem({ barcode: "RLS-1", name: "Blocked" });
      expect(res.status).toBe(403);
      const body = await bodyRecord(res);
      expect(errorTextOf(body)).toMatch(/^The database did not allow this change, so nothing was saved\./);
      expect(errorTextOf(body)).not.toMatch(/row-level/i);
      expect(String(body.technical)).toMatch(/row-level security/i);
      expect(body).not.toHaveProperty("id");
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("answers 503 with a connection message when the database can't be reached, and stores nothing", async () => {
      const before = snapshotDb(fake);
      fake.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "medications", op: "insert" });
      const res = await api.createItem({ barcode: "NET-1", name: "Never saved" });
      expect(res.status).toBe(503);
      expect(errorTextOf(await res.json())).toMatch(/can.t reach the database/i);
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("logs a failed create without the item's name, notes, barcode or supplier number (no inventory text in server logs)", async () => {
      const logged = vi.spyOn(console, "error");
      fake.failNext({ code: "XX000", message: "internal error" }, { table: "medications", op: "insert" });
      const res = await api.createItem({ name: "SECRET-NAME-4417", notes: "SECRET-NOTE-4417", barcode: "SECRET-BARCODE-4417", supplier_order_number: "SECRET-CODE-4417" });
      expect(res.status).toBe(500);
      expect(logged).toHaveBeenCalled();
      expect(JSON.stringify(logged.mock.calls)).not.toMatch(/SECRET-(NAME|NOTE|BARCODE|CODE)-4417/);
      expect(JSON.stringify(await res.json())).not.toMatch(/SECRET-(NAME|NOTE|BARCODE|CODE)-4417/);
    });

    it("answers 500 with the database error code for an unexpected failure", async () => {
      fake.failNext({ code: "XX000", message: "internal error" }, { table: "medications", op: "insert" });
      const res = await api.createItem({ barcode: "ERR-1" });
      expect(res.status).toBe(500);
      expect(await bodyRecord(res)).toMatchObject({ error: expect.stringMatching(/^Something went wrong in the database\./) as unknown, code: "XX000" });
    });

    it("answers 400 (not 500) when a not-null column would be violated", async () => {
      fake.failNext({ code: "23502", message: 'null value in column "unit" violates not-null constraint' }, { table: "medications", op: "insert" });
      const res = await api.createItem({ barcode: "NN-1" });
      expect(res.status).toBe(400);
      expect(errorTextOf(await res.json())).toMatch(/required field/i);
    });

    it("answers 409 when another device creates the same barcode between the check and the insert", async () => {
      fake.onCall((call) => {
        if (call.op === "insert" && call.table === "medications") fake.seedMedications([{ id: 7001, barcode: "RACE-2", name: "Winner" }]);
      });
      const res = await api.createItem({ barcode: "RACE-2", name: "Loser" });
      expect(res.status).toBe(409);
      expect(fake.dump("medications").filter((m) => m.barcode === "RACE-2")).toHaveLength(1);
    });
  });

  describe("responses are never cached", () => {
    it("marks created and rejected responses no-store", async () => {
      expect((await api.createItem({ barcode: "CACHE-1" })).headers.get("cache-control")).toBe("no-store");
      expect((await api.createItem({})).headers.get("cache-control")).toBe("no-store");
      const raw = await postRaw(jsonRequest("POST", "/api/medications", { barcode: "CACHE-2" }));
      expect(asRecord(await raw.json())).toHaveProperty("id");
    });
  });
});

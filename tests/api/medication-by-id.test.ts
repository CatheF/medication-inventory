// Requirement-driven tests: GET / PUT / DELETE /api/medications/[id].
//
//   "Editing another field does not clear the category or overwrite unrelated item data."
//   "Failed saves show a useful error and do not appear successful."
//   Never report success for a change that did not happen (a DELETE of a row that is not there is not a success).
//
// Both id shapes are exercised (the categories attached to the items differ between them).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Category, Medication } from "@/lib/db";
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
import { installFake, type FakeSupabase } from "../helpers/fake-supabase";
import { jsonRequest, routeParams, seedStandard } from "../helpers/fixtures-extra";
import { api } from "../helpers/route-client";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

import * as itemRoute from "@/app/api/medications/[id]/route";
import { POST as postTransaction } from "@/app/api/transactions/route";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const BAD_IDS: ReadonlyArray<readonly [string, string]> = [
  ["letters", "abc"],
  ["zero", "0"],
  ["a negative number", "-5"],
  ["a fraction", "1.5"],
  ["scientific notation", "1e3"],
  ["a hex number", "0x10"],
  ["a zero-padded number", "007"],
  ["more digits than a safe integer", "9007199254740993"],
  ["spaces only", "   "],
  ["a uuid", "a0000000-0000-4000-8000-000000000001"],
  ["the text NaN", "NaN"],
  ["the text undefined", "undefined"],
];

describe.each(ID_SHAPES)("GET, PUT and DELETE /api/medications/[id] on the $label", ({ options }) => {
  let fake: FakeSupabase;
  let categories: Category[];
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake(options);
    ({ categories, medications } = seedStandard(fake, { withTransactions: true }));
  });

  describe("GET", () => {
    it("returns the item with normalized types", async () => {
      const item = itemNamed(medications, "Acetaminophen 500 mg");
      const res = await api.getItem(item.id);
      expect(res.status).toBe(200);
      expect(await bodyRecord(res)).toMatchObject({ id: item.id, name: item.name, barcode: item.barcode, stock: item.stock, category_id: item.category_id });
    });

    it("answers 404 'Medication not found' for an id that does not exist", async () => {
      const res = await api.getItem(987654);
      expect(res.status).toBe(404);
      expect(errorTextOf(await res.json())).toBe("Medication not found");
    });

    it.each(BAD_IDS)("answers 400 for an id that is %s, without touching the database", async (_label, id) => {
      fake.clearCalls();
      const res = await api.getItem(id);
      expect(res.status).toBe(400);
      expect((await bodyRecord(res)).field).toBe("id");
      expect(fake.calls).toEqual([]);
    });

    it("answers a database failure with an error that is not 'not found' (an outage must not look like a deleted item)", async () => {
      fake.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "medications" });
      const res = await api.getItem(medications[0].id);
      expect(res.status).toBe(503);
      expect(errorTextOf(await res.json())).not.toMatch(/not found/i);
    });
  });

  describe("PUT: partial update", () => {
    it("rejects an empty body with 400 'Nothing to update' and writes nothing", async () => {
      const res = await api.updateItem(medications[0].id, {});
      expect(res.status).toBe(400);
      expect(errorTextOf(await res.json())).toBe("Nothing to update");
      expect(fake.writes()).toEqual([]);
    });

    it("rejects a body that only names keys a client may not set (id, created_at, updated_at, is_unnamed, unknown) with 400 and writes nothing", async () => {
      const res = await api.updateItem(medications[0].id, { id: 5, created_at: "2001-01-01", updated_at: "2001-01-01", is_unnamed: true, color: "red" });
      expect(res.status).toBe(400);
      expect(errorTextOf(await res.json())).toBe("Nothing to update");
      expect(fake.writes()).toEqual([]);
    });

    it("writes only the keys that were sent: nothing else about the item changes", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const before = await bodyRecord(await api.getItem(item.id));
      const res = await api.updateItem(item.id, { notes: "Check expiry monthly" });
      expect(res.status).toBe(200);
      const after = await bodyRecord(await api.getItem(item.id));
      expect(omitKeys(after, "updated_at")).toEqual({ ...omitKeys(before, "updated_at"), notes: "Check expiry monthly" });
    });

    it("changes nothing but the sent field on an item that has every optional field filled in (no field is reset to null or to a default)", async () => {
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
          category_id: categories[2].id,
          supplier_order_number: "ORIG-0001",
        },
      ]);
      const before = await bodyRecord(await api.getItem(700));
      for (const patch of [{ stock: 1 }, { name: "Renamed" }, { notes: "New notes" }, { threshold: 99 }, { unit: "cases" }]) {
        const res = await api.updateItem(700, patch);
        expect(res.status).toBe(200);
        const after = await bodyRecord(await api.getItem(700));
        const key = Object.keys(patch)[0];
        expect(omitKeys(after, "updated_at", key)).toEqual(omitKeys(before, "updated_at", key));
        Object.assign(before, patch);
      }
    });

    it("does not overwrite a stock change made after the form was opened when only the name is saved (a scan or another editor changed stock meanwhile)", async () => {
      const item = itemNamed(medications, "Acetaminophen 500 mg"); // stock 120
      const opened = await bodyRecord(await api.getItem(item.id));
      expect(opened.stock).toBe(120);

      const dispensed = await postTransaction(jsonRequest("POST", "/api/transactions", { medication_id: item.id, type: "dispense", quantity: 20 }));
      expect(dispensed.status).toBe(201);

      const saved = await api.updateItem(item.id, { name: "Acetaminophen 500 mg, tablets (renamed)" }); // the form only sends what changed
      expect(saved.status).toBe(200);
      expect(await bodyRecord(saved)).toMatchObject({ name: "Acetaminophen 500 mg, tablets (renamed)", stock: 100 });
      expect(storedMedication(fake, item.id).stock).toBe(100);
    });

    it("keeps two successive edits of different fields (neither overwrites the other)", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      expect((await api.updateItem(item.id, { stock: 5 })).status).toBe(200);
      expect((await api.updateItem(item.id, { notes: "second edit" })).status).toBe(200);
      expect(await bodyRecord(await api.getItem(item.id))).toMatchObject({ stock: 5, notes: "second edit", category_id: item.category_id });
    });

    it("does not touch any other item", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const before = fake.dump("medications");
      expect((await api.updateItem(item.id, { stock: 1 })).status).toBe(200);
      const after = fake.dump("medications");
      const others = (rows: Record<string, unknown>[]) => rows.filter((r) => r.id !== item.id);
      expect(others(after)).toEqual(others(before));
    });

    it("clears the 'needs a name' flag on any successful edit, even one that does not touch the name (documented contract of the original route)", async () => {
      const unnamed = medications.find((m) => m.is_unnamed);
      if (!unnamed) throw new Error("fixture has no unnamed item");
      const res = await api.updateItem(unnamed.id, { stock: 4 });
      expect(res.status).toBe(200);
      expect(await bodyRecord(res)).toMatchObject({ is_unnamed: false, name: null, stock: 4 });
    });

    it("returns the saved row (200) with the new values, normalized like every other read", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const res = await api.updateItem(item.id, { name: "  Naproxen renamed  ", unit: "  boxes ", threshold: 21 });
      expect(res.status).toBe(200);
      const saved = await bodyRecord(res);
      expect(saved).toMatchObject({ id: item.id, name: "Naproxen renamed", unit: "boxes", threshold: 21, category_id: item.category_id });
      expect(typeof saved.updated_at).toBe("string");
    });

    it("lets staff clear optional text fields with null or blank without touching the rest", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      expect((await api.updateItem(item.id, { notes: "x", vendor_url: "https://example.invalid/v", photo_url: "https://example.invalid/p" })).status).toBe(200);
      const cleared = await api.updateItem(item.id, { notes: null, vendor_url: "  ", photo_url: "" });
      expect(cleared.status).toBe(200);
      expect(await bodyRecord(cleared)).toMatchObject({ notes: null, vendor_url: null, photo_url: null, name: item.name, category_id: item.category_id });
    });

    it("keeps leading zeros in an edited barcode", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const res = await api.updateItem(item.id, { barcode: "0000123400" });
      expect(res.status).toBe(200);
      expect((await bodyRecord(res)).barcode).toBe("0000123400");
      expect((await bodyRecord(await api.lookup("0000123400"))).id).toBe(item.id);
    });

    it("treats zero as a real value: stock 0 and threshold 0 are saved, not ignored or replaced by a default", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg"); // stock 9, threshold 20
      const res = await api.updateItem(item.id, { stock: 0, threshold: 0 });
      expect(res.status).toBe(200);
      expect(await bodyRecord(res)).toMatchObject({ stock: 0, threshold: 0, category_id: item.category_id });
      expect(storedMedication(fake, item.id)).toMatchObject({ stock: 0, threshold: 0 });
    });

    it("does not report a barcode conflict when an item is saved with its own, unchanged barcode", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const res = await api.updateItem(item.id, { barcode: item.barcode, stock: 3 });
      expect(res.status).toBe(200);
      expect((await bodyRecord(res)).barcode).toBe(item.barcode);
    });

    it("treats real __proto__ and constructor keys in the body as ordinary, ignored keys (nothing is polluted, nothing is stored)", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const raw = '{"stock":4,"__proto__":{"evil":1},"constructor":{"x":1},"toString":"nope","hasOwnProperty":1}';
      const res = await itemRoute.PUT(
        new Request(`http://localhost/api/medications/${item.id}`, { method: "PUT", body: raw }) as unknown as Parameters<typeof itemRoute.PUT>[0],
        routeParams({ id: String(item.id) })
      );
      expect(res.status).toBe(200);
      expect((await bodyRecord(res)).stock).toBe(4);
      expect(({} as Record<string, unknown>).evil).toBeUndefined();
      const update = fake.writes().find((c) => c.op === "update");
      expect(Object.keys(asRecord(update?.payload, "update payload")).sort()).toEqual(["is_unnamed", "stock"]);

      const only = await itemRoute.PUT(
        new Request(`http://localhost/api/medications/${item.id}`, { method: "PUT", body: '{"__proto__":{"stock":1},"constructor":1}' }) as unknown as Parameters<typeof itemRoute.PUT>[0],
        routeParams({ id: String(item.id) })
      );
      expect(only.status).toBe(400);
      expect(errorTextOf(await only.json())).toBe("Nothing to update");
    });

    it("moves the barcode lookup with an edited barcode: the old barcode no longer finds the item", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const oldBarcode = item.barcode;
      expect((await api.updateItem(item.id, { barcode: "NEW-CODE-1" })).status).toBe(200);
      expect((await api.lookup("NEW-CODE-1")).status).toBe(200);
      expect((await api.lookup(oldBarcode)).status).toBe(404);
    });
  });

  describe("PUT: failures are failures", () => {
    it.each(BAD_IDS)("answers 400 for an id that is %s and writes nothing", async (_label, id) => {
      const res = await api.updateItem(id, { stock: 1 });
      expect(res.status).toBe(400);
      expect((await bodyRecord(res)).field).toBe("id");
      expect(fake.writes()).toEqual([]);
    });

    it.each([
      ["text that is not JSON", "not json"],
      ["a JSON array", "[1]"],
      ["JSON null", "null"],
    ])("answers 400 for %s and writes nothing", async (_label, raw) => {
      const res = await itemRoute.PUT(
        new Request("http://localhost/api/medications/100", { method: "PUT", body: raw }) as unknown as Parameters<typeof itemRoute.PUT>[0],
        routeParams({ id: "100" })
      );
      expect(res.status).toBe(400);
      expect(errorTextOf(await res.json())).toMatch(/JSON/);
      expect(fake.writes()).toEqual([]);
    });

    it.each([
      ["a blank barcode", { barcode: "" }, "barcode"],
      ["a null barcode", { barcode: null }, "barcode"],
      ["a numeric barcode", { barcode: 123 }, "barcode"],
      ["a negative stock", { stock: -1 }, "stock"],
      ["a fractional stock", { stock: 2.5 }, "stock"],
      ["a text stock", { stock: "12" }, "stock"],
      ["a null stock", { stock: null }, "stock"],
      ["NaN stock (arrives as null)", { stock: Number.NaN }, "stock"],
      ["a negative threshold", { threshold: -3 }, "threshold"],
      ["a numeric name", { name: 5 }, "name"],
      ["a numeric unit", { unit: 5 }, "unit"],
      ["a NUL character in notes", { notes: "a\u0000b" }, "notes"],
    ])("rejects %s with 400 naming the field and leaves the whole item untouched", async (_label, patch, field) => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const before = snapshotDb(fake);
      const res = await api.updateItem(item.id, { name: "Would be renamed", ...patch });
      expect(res.status).toBe(400);
      const body = await bodyRecord(res);
      expect(body.field).toBe(field);
      expect(errorTextOf(body)).not.toBe("");
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("answers 409 'Barcode already exists' when the new barcode belongs to another item, and changes nothing", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const other = itemNamed(medications, "Aspirin 81 mg");
      const before = snapshotDb(fake);
      const res = await api.updateItem(item.id, { barcode: other.barcode, stock: 1 });
      expect(res.status).toBe(409);
      expect(errorTextOf(await res.json())).toMatch(/barcode already exists/i);
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("answers 404 for an item that does not exist", async () => {
      const res = await api.updateItem(987654, { stock: 1 });
      expect(res.status).toBe(404);
      expect(errorTextOf(await res.json())).toMatch(/not found/i);
    });

    it("answers 403 with a plain message (technical cause in its own field) when the database refuses the update with an error", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const before = snapshotDb(fake);
      fake.failNext({ code: "42501", message: 'new row violates row-level security policy for table "medications"' }, { table: "medications", op: "update" });
      const res = await api.updateItem(item.id, { stock: 1 });
      expect(res.status).toBe(403);
      const body = await bodyRecord(res);
      expect(errorTextOf(body)).toMatch(/^The database did not allow this change, so nothing was saved\./);
      expect(errorTextOf(body)).not.toMatch(/row-level/i);
      expect(String(body.technical)).toMatch(/row-level security/i);
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("answers 404 (not success) when the database silently updates nothing because the update policy is gone", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      fake.setRls("medications", { select: true, insert: true, update: false, delete: true });
      const before = snapshotDb(fake);
      const res = await api.updateItem(item.id, { stock: 1 });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(404);
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("answers 503 with a connection message when the database can't be reached", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const before = snapshotDb(fake);
      fake.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "medications", op: "update" });
      const res = await api.updateItem(item.id, { stock: 1 });
      expect(res.status).toBe(503);
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("logs a failed save without the item's name, notes, barcode or supplier number (no inventory text in server logs)", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const logged = vi.spyOn(console, "error");
      fake.failNext({ code: "XX000", message: "internal error" }, { table: "medications", op: "update" });
      const res = await api.updateItem(item.id, { name: "SECRET-NAME-9137", notes: "SECRET-NOTE-9137", barcode: "SECRET-BARCODE-9137", supplier_order_number: "SECRET-CODE-9137" });
      expect(res.status).toBe(500);
      expect(logged).toHaveBeenCalled();
      expect(JSON.stringify(logged.mock.calls)).not.toMatch(/SECRET-(NAME|NOTE|BARCODE|CODE)-9137/);
      expect(JSON.stringify(await res.json())).not.toMatch(/SECRET-(NAME|NOTE|BARCODE|CODE)-9137/);
    });

    it("answers 500 with the error code for an unexpected database error, and the item is unchanged", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const before = snapshotDb(fake);
      fake.failNext({ code: "XX000", message: "internal error" }, { table: "medications", op: "update" });
      const res = await api.updateItem(item.id, { stock: 1 });
      expect(res.status).toBe(500);
      expect(await bodyRecord(res)).toMatchObject({ error: expect.stringMatching(/^Something went wrong in the database\./) as unknown, code: "XX000" });
      expect(snapshotDb(fake)).toEqual(before);
    });
  });

  describe("DELETE", () => {
    it("deletes the item (200 {success: true}); it is gone from the list, by id and by barcode", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const res = await api.deleteItem(item.id);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect((await bodyList(await api.listItems())).some((m) => m.id === item.id)).toBe(false);
      expect((await api.getItem(item.id)).status).toBe(404);
      expect((await api.lookup(item.barcode)).status).toBe(404);
    });

    it("removes the item's usage history with it and nothing else (unchanged ON DELETE CASCADE behavior)", async () => {
      const item = medications[0]; // seedStandard(withTransactions) gives the first six items two transactions each
      expect(fake.dump("transactions").filter((t) => t.medication_id === item.id)).toHaveLength(2);
      const transactionsBefore = fake.dump("transactions").length;
      expect((await api.deleteItem(item.id)).status).toBe(200);
      expect(fake.dump("transactions").filter((t) => t.medication_id === item.id)).toHaveLength(0);
      expect(fake.dump("transactions")).toHaveLength(transactionsBefore - 2);
    });

    it("never deletes or changes a category, or any other item, when an item is deleted", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const before = snapshotDb(fake);
      expect((await api.deleteItem(item.id)).status).toBe(200);
      const after = snapshotDb(fake);
      expect(after.categories).toEqual(before.categories);
      expect(after.categories).toHaveLength(categories.length);
      expect(after.medications).toEqual(before.medications.filter((m) => m.id !== item.id));
    });

    it("answers 404 (not success) for an item that does not exist", async () => {
      const res = await api.deleteItem(987654);
      expect(res.status).toBe(404);
      expect(errorTextOf(await res.json())).toMatch(/not found/i);
    });

    it.each(BAD_IDS)("answers 400 for an id that is %s and deletes nothing", async (_label, id) => {
      const res = await api.deleteItem(id);
      expect(res.status).toBe(400);
      expect(fake.writes()).toEqual([]);
    });

    it("answers 404 (not success) and keeps the item when the database silently deletes nothing because the delete policy is gone", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      fake.setRls("medications", { select: true, insert: true, update: true, delete: false });
      const res = await api.deleteItem(item.id);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(404);
      expect(fake.dump("medications").some((m) => m.id === item.id)).toBe(true);
    });

    it.each([
      { label: "the database can't be reached", error: { code: "", message: "TypeError: fetch failed" }, status: 503 },
      { label: "the database refuses the delete with an error", error: { code: "42501", message: 'new row violates row-level security policy for table "medications"' }, status: 403 },
      { label: "an unexpected database error happens", error: { code: "XX000", message: "internal error" }, status: 500 },
    ])("answers with $status and keeps the item when $label", async ({ error, status }) => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      fake.failNext(error, { table: "medications", op: "delete" });
      const res = await api.deleteItem(item.id);
      expect(res.status).toBe(status);
      expect(errorTextOf(await res.json())).not.toBe("");
      expect(fake.dump("medications").some((m) => m.id === item.id)).toBe(true);
    });
  });

  describe("never cached", () => {
    it("opts out of static caching and marks GET, PUT and DELETE answers no-store", async () => {
      expect(itemRoute.dynamic).toBe("force-dynamic");
      const item = itemNamed(medications, "Naproxen 220 mg");
      expect((await api.getItem(item.id)).headers.get("cache-control")).toBe("no-store");
      expect((await api.updateItem(item.id, { stock: 2 })).headers.get("cache-control")).toBe("no-store");
      expect((await api.getItem(987654)).headers.get("cache-control")).toBe("no-store");
      expect((await api.deleteItem(item.id)).headers.get("cache-control")).toBe("no-store");
    });
  });
});

// Requirement-driven tests: size limits on what the API accepts (item text fields, request bodies, the category list).
//
// Why they exist: without limits, one request could store megabytes of text in an item's name, notes, vendor link, photo
// address or unit. Every item is returned to every browser by GET /api/medications, so one such field would slow down every
// screen for everybody. The limits are in lib/limits.ts; the boundary of every one is tested here (the largest value that
// is accepted, and one more that is refused).
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asRecord, bodyList, bodyRecord, errorTextOf, ID_SHAPES, itemNamed, snapshotDb, storedMedication } from "../helpers/api-test-kit";
import { installFake, type FakeSupabase } from "../helpers/fake-supabase";
import { jsonRequest, routeParams, seedStandard } from "../helpers/fixtures-extra";
import { api } from "../helpers/route-client";
import { BARCODE_MAX_LENGTH, MAX_JSON_BODY_BYTES } from "@/lib/limits";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

import { GET as categoriesGet, POST as categoriesPost } from "@/app/api/categories/route";
import { PUT as medicationPut } from "@/app/api/medications/[id]/route";
import { POST as medicationsPost } from "@/app/api/medications/route";
import { POST as exportPost } from "@/app/api/order-sheet/xlsx/route";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

/** A JSON request whose body and (optionally) declared Content-Length are chosen by the test. */
function sized(url: string, method: string, body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json", ...headers }, body });
}

/** A URL of exactly `length` characters. */
function urlOfLength(length: number): string {
  const prefix = "https://shop.example/";
  return prefix + "p".repeat(length - prefix.length);
}

const EMOJI = "\u{1F48A}"; // two UTF-16 units, one character

type FieldCase = {
  field: "name" | "notes" | "vendor_url" | "photo_url" | "unit" | "barcode";
  limit: number;
  /** Builds a value of exactly this many characters. */
  make: (length: number) => string;
  /** What the refusal must say about the field. */
  label: RegExp;
};

const FIELD_CASES: FieldCase[] = [
  { field: "name", limit: 300, make: (n) => "n".repeat(n), label: /name/i },
  { field: "notes", limit: 5000, make: (n) => "t".repeat(n), label: /notes/i },
  { field: "vendor_url", limit: 2048, make: urlOfLength, label: /vendor url/i },
  { field: "photo_url", limit: 2048, make: urlOfLength, label: /photo url/i },
  { field: "unit", limit: 40, make: (n) => "u".repeat(n), label: /unit/i },
  { field: "barcode", limit: 1024, make: (n) => "9".repeat(n), label: /barcode/i },
];

describe.each(ID_SHAPES)("limits on item fields on the $label", ({ options }) => {
  let fake: FakeSupabase;
  beforeEach(() => {
    fake = installFake(options);
    seedStandard(fake);
  });

  it("states the limits the owner asked for, in one place (lib/limits.ts)", async () => {
    const limits = await import("@/lib/limits");
    expect({
      barcode: limits.BARCODE_MAX_LENGTH,
      name: limits.NAME_MAX_LENGTH,
      notes: limits.NOTES_MAX_LENGTH,
      vendorUrl: limits.VENDOR_URL_MAX_LENGTH,
      photoUrl: limits.PHOTO_URL_MAX_LENGTH,
      unit: limits.UNIT_MAX_LENGTH,
      categoryName: limits.CATEGORY_NAME_MAX_LENGTH,
      supplierOrderNumber: limits.SUPPLIER_ORDER_NUMBER_MAX_LENGTH,
      body: limits.MAX_JSON_BODY_BYTES,
    }).toEqual({ barcode: 1024, name: 300, notes: 5000, vendorUrl: 2048, photoUrl: 2048, unit: 40, categoryName: 60, supplierOrderNumber: 64, body: 1_000_000 });
  });

  describe("creating an item (POST /api/medications)", () => {
    it.each(FIELD_CASES)("accepts a $field of exactly $limit characters and refuses one character more, naming the field and the limit", async ({ field, limit, make, label }) => {
      const base = { barcode: "LIM-BASE", name: "Limit probe" };
      const ok = await api.createItem({ ...base, [field]: make(limit) });
      expect(ok.status, `${field} at the limit`).toBe(201);
      expect(asRecord(await ok.json())[field]).toBe(make(limit));

      const before = snapshotDb(fake);
      const tooLong = await api.createItem({ ...base, barcode: "LIM-OVER", [field]: make(limit + 1) });
      expect(tooLong.status, `${field} one over the limit`).toBe(400);
      const body = await bodyRecord(tooLong);
      expect(body.field).toBe(field);
      expect(errorTextOf(body)).toMatch(label);
      expect(errorTextOf(body)).toContain(String(limit));
      expect(snapshotDb(fake)).toEqual(before);
    });

    it.each([
      ["name", "name", 300],
      ["notes", "notes", 5000],
      ["unit", "unit", 40],
    ] as const)("counts the %s in characters, not UTF-16 units: %i emoji are accepted and one more is refused", async (_label, field, limit) => {
      const ok = await api.createItem({ barcode: "EMOJI-OK", [field]: EMOJI.repeat(limit) });
      expect(ok.status).toBe(201);
      const over = await api.createItem({ barcode: "EMOJI-OVER", [field]: EMOJI.repeat(limit + 1) });
      expect(over.status).toBe(400);
      expect((await bodyRecord(over)).field).toBe(field);
    });

    it("does not count the spaces around a name, a unit or a link (they are trimmed before they are stored)", async () => {
      const res = await api.createItem({
        barcode: "PAD-1",
        name: `   ${"n".repeat(300)}   `,
        unit: `  ${"u".repeat(40)}  `,
        vendor_url: `  ${urlOfLength(2048)}  `,
        photo_url: `  ${urlOfLength(2048)}  `,
      });
      expect(res.status).toBe(201);
      expect(await bodyRecord(res)).toMatchObject({ name: "n".repeat(300), unit: "u".repeat(40), vendor_url: urlOfLength(2048), photo_url: urlOfLength(2048) });
    });

    it("counts notes exactly as they will be stored: their own line breaks and spaces count", async () => {
      expect((await api.createItem({ barcode: "NOTES-OK", notes: `${"t".repeat(4999)}\n` })).status).toBe(201);
      expect((await api.createItem({ barcode: "NOTES-OVER", notes: `${"t".repeat(5000)}\n` })).status).toBe(400);
    });

    it("keeps accepting a barcode of 1024 characters (it used to stop at 128) and refuses 1025, so scanning a long code is never refused", async () => {
      expect(BARCODE_MAX_LENGTH).toBe(1024);
      expect((await api.createItem({ barcode: "9".repeat(1024) })).status).toBe(201);
      expect((await api.lookup("9".repeat(1024))).status).toBe(200);
      const over = await api.createItem({ barcode: "9".repeat(1025) });
      expect(over.status).toBe(400);
      expect((await bodyRecord(over)).field).toBe("barcode");
    });

    it("the reported case: 2,000,000 characters in the name is refused with 413 and nothing is stored (it used to answer 201)", async () => {
      const before = snapshotDb(fake);
      const res = await api.createItem({ barcode: "HUGE-1", name: "x".repeat(2_000_000) });
      expect(res.status).toBe(413);
      expect(errorTextOf(await res.json())).toMatch(/too large/i);
      expect(snapshotDb(fake)).toEqual(before);
    });
  });
});

describe.each(ID_SHAPES)("limits on item edits on the $label", ({ options }) => {
  let fake: FakeSupabase;
  let itemId: number;
  beforeEach(() => {
    fake = installFake(options);
    const { medications } = seedStandard(fake);
    itemId = itemNamed(medications, "Naproxen 220 mg").id;
  });

  it.each(FIELD_CASES)("PUT accepts a $field of exactly $limit characters and refuses one character more, naming the field and the limit", async ({ field, limit, make, label }) => {
    const ok = await api.updateItem(itemId, { [field]: make(limit) });
    expect(ok.status, `${field} at the limit`).toBe(200);
    expect(asRecord(await ok.json())[field]).toBe(make(limit));

    const before = snapshotDb(fake);
    const tooLong = await api.updateItem(itemId, { [field]: make(limit + 1) });
    expect(tooLong.status, `${field} one over the limit`).toBe(400);
    const body = await bodyRecord(tooLong);
    expect(body.field).toBe(field);
    expect(errorTextOf(body)).toMatch(label);
    expect(errorTextOf(body)).toContain(String(limit));
    expect(snapshotDb(fake)).toEqual(before);
  });

  it("a PUT that does not send a field never validates it: values that are already too long elsewhere never block an unrelated edit", async () => {
    // Stored directly, the way data written before the limits existed (or by a CSV import) sits in the database.
    const long = {
      name: "N".repeat(400),
      notes: "T".repeat(6000),
      vendor_url: urlOfLength(3000),
      photo_url: urlOfLength(3000),
      unit: "U".repeat(80),
    };
    fake.seedMedications([{ id: 7001, barcode: "LEGACY-LONG", ...long }]);

    const res = await api.updateItem(7001, { stock: 7 });
    expect(res.status).toBe(200);
    expect(await bodyRecord(res)).toMatchObject({ ...long, stock: 7 });
    expect(storedMedication(fake, 7001)).toMatchObject({ ...long, stock: 7 });

    // Sending one field validates that field only.
    const both = await api.updateItem(7001, { threshold: 3, notes: "short now" });
    expect(both.status).toBe(200);
    expect(storedMedication(fake, 7001)).toMatchObject({ ...long, notes: "short now", threshold: 3 });

    const refused = await api.updateItem(7001, { name: "N".repeat(301) });
    expect(refused.status).toBe(400);
    expect(storedMedication(fake, 7001).name).toBe(long.name);
  });

  it("reading items back never shortens a value that is already stored", async () => {
    fake.seedMedications([{ id: 7002, barcode: "LEGACY-LONG-2", notes: "T".repeat(6000) }]);
    const listed = await bodyList(await api.listItems());
    expect(String(listed.find((item) => item.id === 7002)?.notes).length).toBe(6000);
  });
});

describe.each(ID_SHAPES)("request body size on the $label", ({ options }) => {
  let fake: FakeSupabase;
  let itemId: number;
  beforeEach(() => {
    fake = installFake(options);
    const { medications } = seedStandard(fake);
    itemId = itemNamed(medications, "Naproxen 220 mg").id;
  });

  /** Valid JSON of exactly `bytes` bytes (ASCII): {"notes":"xxxx"} */
  function bodyOfBytes(bytes: number): string {
    const frame = '{"notes":""}'.length;
    return `{"notes":"${"x".repeat(bytes - frame)}"}`;
  }

  it("refuses a declared Content-Length above 1,000,000 bytes with 413 BEFORE reading the body (POST item)", async () => {
    const request = sized("/api/medications", "POST", '{"barcode":"SIZE-1"}', { "content-length": String(MAX_JSON_BODY_BYTES + 1) });
    const res = await medicationsPost(request);
    expect(res.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
    expect(fake.writes()).toEqual([]);
  });

  it("refuses a declared Content-Length above 1,000,000 bytes with 413 BEFORE reading the body (PUT item)", async () => {
    const request = sized(`/api/medications/${itemId}`, "PUT", '{"stock":1}', { "content-length": String(MAX_JSON_BODY_BYTES + 1) });
    const res = await medicationPut(request, routeParams({ id: String(itemId) }));
    expect(res.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
    expect(fake.writes()).toEqual([]);
  });

  it("refuses a declared Content-Length above 1,000,000 bytes with 413 BEFORE reading the body (POST category)", async () => {
    const request = sized("/api/categories", "POST", '{"name":"Splints"}', { "content-length": String(MAX_JSON_BODY_BYTES + 1) });
    const res = await categoriesPost(request);
    expect(res.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it("lets a declared Content-Length of exactly 1,000,000 bytes through to the normal validation", async () => {
    const request = sized("/api/medications", "POST", '{"barcode":"SIZE-2"}', { "content-length": String(MAX_JSON_BODY_BYTES) });
    const res = await medicationsPost(request);
    expect(res.status).toBe(201);
  });

  it("measures a body that has no Content-Length once it is read: exactly 1,000,000 bytes pass the size check, one more is 413", async () => {
    const exact = await medicationsPost(sized("/api/medications", "POST", bodyOfBytes(MAX_JSON_BODY_BYTES)));
    expect(exact.status).toBe(400); // past the size check: it is the notes limit that refuses it
    expect((await bodyRecord(exact)).field).toBe("notes");

    const over = await medicationsPost(sized("/api/medications", "POST", bodyOfBytes(MAX_JSON_BODY_BYTES + 1)));
    expect(over.status).toBe(413);
    expect(fake.writes()).toEqual([]);
  });

  it("measures the same way for PUT item and POST category", async () => {
    const putExact = await medicationPut(sized(`/api/medications/${itemId}`, "PUT", bodyOfBytes(MAX_JSON_BODY_BYTES)), routeParams({ id: String(itemId) }));
    expect(putExact.status).toBe(400);
    const putOver = await medicationPut(sized(`/api/medications/${itemId}`, "PUT", bodyOfBytes(MAX_JSON_BODY_BYTES + 1)), routeParams({ id: String(itemId) }));
    expect(putOver.status).toBe(413);

    const catExact = await categoriesPost(sized("/api/categories", "POST", bodyOfBytes(MAX_JSON_BODY_BYTES)));
    expect(catExact.status).toBe(400);
    const catOver = await categoriesPost(sized("/api/categories", "POST", bodyOfBytes(MAX_JSON_BODY_BYTES + 1)));
    expect(catOver.status).toBe(413);
    expect(fake.writes()).toEqual([]);
  });

  it("counts bytes, not characters: a body of 600,000 two-byte characters is over the limit", async () => {
    const body = JSON.stringify({ notes: "é".repeat(600_000) }); // 1,200,000+ bytes, only 600,000 characters
    expect(body.length).toBeLessThan(MAX_JSON_BODY_BYTES);
    const res = await medicationsPost(sized("/api/medications", "POST", body));
    expect(res.status).toBe(413);
  });

  it("answers an oversized request with a plain message, as JSON, and never as a server error", async () => {
    const res = await medicationsPost(sized("/api/medications", "POST", bodyOfBytes(MAX_JSON_BODY_BYTES + 1)));
    expect(res.headers.get("content-type")).toMatch(/json/);
    expect(errorTextOf(await res.json())).toMatch(/too large/i);
  });
});

describe.each(ID_SHAPES)("request body size of the order sheet export on the $label", ({ options }) => {
  const EXPORT_LIMIT = 262_144;
  let fake: FakeSupabase;
  beforeEach(() => {
    fake = installFake(options);
    seedStandard(fake);
  });

  it("refuses a declared Content-Length above the existing limit with 413 before reading the body or the database", async () => {
    const request = sized("/api/order-sheet/xlsx", "POST", "{}", { "content-length": String(EXPORT_LIMIT + 1) });
    const res = await exportPost(request);
    expect(res.status).toBe(413);
    expect(errorTextOf(await res.json())).toMatch(/too large to export/i);
    expect(request.bodyUsed).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it("lets a declared Content-Length of exactly the limit through to the normal validation", async () => {
    const request = sized("/api/order-sheet/xlsx", "POST", '{"date":"2026-11-05","rows":[]}', { "content-length": String(EXPORT_LIMIT) });
    const res = await exportPost(request);
    expect(res.status).toBe(400);
    expect((await bodyRecord(res)).field).toBe("rows");
  });

  it("still measures a body without a Content-Length once it is read (exactly the limit passes, one more is 413)", async () => {
    const frame = '{"notes":""}'.length;
    const exact = await exportPost(sized("/api/order-sheet/xlsx", "POST", `{"notes":"${"x".repeat(EXPORT_LIMIT - frame)}"}`));
    expect(exact.status).toBe(400); // notes over its own limit: past the size check
    expect((await bodyRecord(exact)).field).not.toBeUndefined();
    const over = await exportPost(sized("/api/order-sheet/xlsx", "POST", `{"notes":"${"x".repeat(EXPORT_LIMIT - frame + 1)}"}`));
    expect(over.status).toBe(413);
    expect(fake.calls).toEqual([]);
  });
});

describe.each(ID_SHAPES)("the category list is read page by page on the $label", ({ options }) => {
  const names = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `Category ${String(i + 1).padStart(5, "0")}` }));

  it("returns every category when the database answers at most 1000 rows per request (it used to stop at 1000, silently)", async () => {
    const fake = installFake({ ...options, maxRows: 1000 });
    fake.seedCategories(names(2500));
    const res = await categoriesGet();
    expect(res.status).toBe(200);
    const listed = await bodyList(res);
    expect(listed).toHaveLength(2500);
    expect(new Set(listed.map((c) => c.id)).size).toBe(2500);
    expect(listed[0].name).toBe("Category 00001");
    expect(listed[2499].name).toBe("Category 02500");
  });

  it("returns every category when the database cap is 100 and no total is available", async () => {
    const fake = installFake({ ...options, maxRows: 100, countSupported: false });
    fake.seedCategories(names(350));
    expect(await bodyList(await categoriesGet())).toHaveLength(350);
  });

  it("allows exactly 50 pages and refuses one more with an error, never a silently partial list", async () => {
    const allowed = installFake({ ...options, maxRows: 10 });
    allowed.seedCategories(names(500));
    const ok = await categoriesGet();
    expect(ok.status).toBe(200);
    expect(await bodyList(ok)).toHaveLength(500);

    const tooMany = installFake({ ...options, maxRows: 10 });
    tooMany.seedCategories(names(501));
    const res = await categoriesGet();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(false);
    expect(errorTextOf(body)).toMatch(/too large/i);
  });

  it("answers with the database's error, not with the pages read so far, when a later page fails", async () => {
    const fake = installFake({ ...options, maxRows: 100 });
    fake.seedCategories(names(350));
    let reads = 0;
    fake.onCall((call) => {
      if (call.op === "select" && call.table === "categories" && ++reads === 2) {
        fake.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "categories" });
      }
    });
    const res = await categoriesGet();
    expect(res.status).toBe(503);
    expect(Array.isArray(await res.json())).toBe(false);
  });

  it("orders pages by id so that no row is skipped or repeated between pages, and still sorts the answer by name", async () => {
    const fake = installFake({ ...options, maxRows: 100 });
    fake.seedCategories([{ name: "zebra" }, ...names(250), { name: "Apple" }]);
    const listed = await bodyList(await categoriesGet());
    expect(listed).toHaveLength(252);
    expect(listed[0].name).toBe("Apple");
    expect(listed[251].name).toBe("zebra");
    const reads = fake.callsFor("categories").filter((call) => call.op === "select");
    expect(reads.every((call) => call.order.some((o) => o.column === "id"))).toBe(true);
  });

  it("the duplicate check of POST /api/categories sees every category too: a name that exists beyond the first page is not created again", async () => {
    const fake = installFake({ ...options, maxRows: 1000 });
    fake.seedCategories([...names(1500), { name: "Vaccines" }]);
    const res = await categoriesPost(jsonRequest("POST", "/api/categories", { name: "vaccines" }));
    expect(res.status).toBe(200);
    expect(fake.writes()).toEqual([]);
    expect(fake.dump("categories")).toHaveLength(1501);
  });
});

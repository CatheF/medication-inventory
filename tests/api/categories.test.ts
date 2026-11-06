// Requirement-driven tests for /api/categories (TASK.md section 1 "Repair categories", sections 8 and 9; SPEC 2.6).
//
// Every group runs against BOTH database shapes: the live Health Center database (uuid ids) and supabase/schema.sql
// (bigint ids). The category API must behave the same for both and must always hand the browser string ids.
//
// Synthetic data only; the database is tests/helpers/fake-supabase.ts, never a real Supabase project.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asRecord, bodyList, bodyRecord, errorTextOf, ID_SHAPES, looksLikeUuid } from "../helpers/api-test-kit";
import { installFake, LIVE_BEFORE_MIGRATION, type FakeSupabase } from "../helpers/fake-supabase";
import { jsonRequest } from "../helpers/fixtures-extra";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

import * as categoriesRoute from "@/app/api/categories/route";

const { GET, POST } = categoriesRoute;

function create(name: unknown): Promise<Response> {
  return POST(jsonRequest("POST", "/api/categories", { name }));
}

function rawPost(body: string): Promise<Response> {
  // The body is the test's own (not necessarily JSON), but the request is declared as JSON like every call from the app.
  return POST(new NextRequest("http://localhost/api/categories", { method: "POST", headers: { "content-type": "application/json" }, body }));
}

beforeEach(() => {
  // The routes log 403/5xx failures with console.error; keep the test output readable.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe.each(ID_SHAPES)("GET and POST /api/categories on the $label", ({ options, shape }) => {
  let fake: FakeSupabase;
  beforeEach(() => {
    fake = installFake(options);
  });

  describe("creating and reloading", () => {
    it("lists a database without categories as an empty list with HTTP 200 (an empty list is not an error)", async () => {
      const res = await GET();
      expect(res.status).toBe(200);
      expect(await bodyList(res)).toEqual([]);
    });

    it("creates a category: 201, a string id, the trimmed name, and one stored row", async () => {
      const res = await create("  Antibiotics  ");
      expect(res.status).toBe(201);
      const body = await bodyRecord(res);
      expect(body.name).toBe("Antibiotics");
      expect(typeof body.id).toBe("string");
      if (shape === "uuid") expect(looksLikeUuid(body.id)).toBe(true);
      else expect(body.id).toMatch(/^[0-9]+$/);

      const stored = fake.dump("categories");
      expect(stored).toHaveLength(1);
      expect(stored[0].name).toBe("Antibiotics");
      expect(String(stored[0].id)).toBe(body.id);
    });

    it("keeps a created category after a reload: the list contains it with the same id and name", async () => {
      const created = await bodyRecord(await create("Antibiotics"));
      const reloaded = await bodyList(await GET());
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0]).toMatchObject({ id: created.id, name: "Antibiotics" });
    });

    it("gives the browser string ids for every category, whatever type the database column has", async () => {
      fake.seedCategories([{ name: "One" }, { name: "Two" }, { name: "Three" }]);
      const listed = await bodyList(await GET());
      expect(listed).toHaveLength(3);
      for (const category of listed) expect(typeof category.id).toBe("string");
      expect(listed.map((c) => c.id).sort()).toEqual(fake.dump("categories").map((r) => String(r.id)).sort());
    });

    it("answers with the existing category (200) when the same name is created again, and stores no second row", async () => {
      const first = await bodyRecord(await create("Antibiotics"));
      const again = await create("Antibiotics");
      expect(again.status).toBe(200);
      expect((await bodyRecord(again)).id).toBe(first.id);
      expect(fake.dump("categories")).toHaveLength(1);
    });

    it("treats a name that differs only by letter case as the same category (no near-duplicates)", async () => {
      const first = await bodyRecord(await create("Antibiotics"));
      for (const variant of ["antibiotics", "ANTIBIOTICS", "  aNtIbIoTiCs "]) {
        const res = await create(variant);
        expect(res.status).toBe(200);
        expect((await bodyRecord(res)).id).toBe(first.id);
      }
      expect(fake.dump("categories")).toHaveLength(1);
    });

    it("treats composed and decomposed accents as the same category name", async () => {
      const first = await bodyRecord(await create("Crème"));
      const decomposed = await create("Crème");
      expect(decomposed.status).toBe(200);
      expect((await bodyRecord(decomposed)).id).toBe(first.id);
      expect(fake.dump("categories")).toHaveLength(1);
    });

    it("accepts a 60-character name, counting characters rather than UTF-16 units (60 emoji are fine)", async () => {
      expect((await create("x".repeat(60))).status).toBe(201);
      expect((await create("\u{1F48A}".repeat(60))).status).toBe(201);
      expect(fake.dump("categories")).toHaveLength(2);
    });
  });

  describe("rejecting bad input with a useful message and without writing anything", () => {
    it.each([
      ["a missing name", {}],
      ["an empty name", { name: "" }],
      ["a whitespace-only name", { name: "   " }],
      ["a null name", { name: null }],
      ["a numeric name", { name: 123 }],
      ["a boolean name", { name: true }],
      ["an array name", { name: ["Antibiotics"] }],
      ["an object name", { name: { text: "Antibiotics" } }],
    ])("rejects %s with 400, the field name and a message", async (_label, payload) => {
      const res = await POST(jsonRequest("POST", "/api/categories", payload));
      expect(res.status).toBe(400);
      const body = await bodyRecord(res);
      expect(body.field).toBe("name");
      expect(errorTextOf(body).length).toBeGreaterThan(5);
      expect(fake.writes()).toEqual([]);
      expect(fake.dump("categories")).toEqual([]);
    });

    it("rejects a 61-character name and says what the maximum is", async () => {
      const res = await create("x".repeat(61));
      expect(res.status).toBe(400);
      expect(errorTextOf(await bodyRecord(res))).toMatch(/60/);
      expect(fake.writes()).toEqual([]);
    });

    it.each([
      ["a line break", "Anti\nbiotics"],
      ["a tab", "Anti\tbiotics"],
      ["a carriage return", "Anti\rbiotics"],
      ["a NUL character", "Anti\u0000biotics"],
      ["an escape character", "Anti\u001bbiotics"],
      ["a zero-width space (invisible, would make look-alike duplicates)", "Anti​biotics"],
      ["a right-to-left override", "Anti‮biotics"],
    ])("rejects a name containing %s", async (_label, name) => {
      const res = await create(name);
      expect(res.status).toBe(400);
      const body = await bodyRecord(res);
      expect(body.field).toBe("name");
      expect(errorTextOf(body)).toMatch(/control|invisible|line breaks/i);
      expect(fake.writes()).toEqual([]);
    });

    it.each([
      ["text that is not JSON", "this is not json"],
      ["an empty body", ""],
      ["a JSON array", '["Antibiotics"]'],
      ["JSON null", "null"],
      ["a bare JSON string", '"Antibiotics"'],
    ])("rejects %s with 400 and writes nothing", async (_label, body) => {
      const res = await rawPost(body);
      expect(res.status).toBe(400);
      expect(errorTextOf(await bodyRecord(res))).toMatch(/JSON/);
      expect(fake.writes()).toEqual([]);
    });
  });

  describe("listing", () => {
    it("lists categories in natural, case-insensitive name order (Category 2 before Category 10)", async () => {
      fake.seedCategories([
        { name: "banana" },
        { name: "Apple" },
        { name: "Category 10" },
        { name: "Category 2" },
        { name: "cherry" },
      ]);
      const names = (await bodyList(await GET())).map((c) => c.name);
      expect(names).toEqual(["Apple", "banana", "Category 2", "Category 10", "cherry"]);
    });

    it("lists names that differ only by case in the same order whatever order they were created in", async () => {
      fake.seedCategories([{ name: "apple" }, { name: "Apple" }]);
      const first = (await bodyList(await GET())).map((c) => c.name);

      const other = installFake(options);
      other.seedCategories([{ name: "Apple" }, { name: "apple" }]);
      const second = (await bodyList(await GET())).map((c) => c.name);

      expect(first).toEqual(second);
      expect([...first].sort()).toEqual(["Apple", "apple"]);
    });

    it("lists legacy categories exactly as stored: it does not rename, trim, merge or delete them, and writes nothing", async () => {
      fake.seedCategories([{ name: "Antibiotics" }, { name: "antibiotics" }, { name: "  Odd spacing  " }]);
      const before = fake.dump("categories");
      const listed = await bodyList(await GET());
      expect(listed.map((c) => c.name).sort()).toEqual(["  Odd spacing  ", "Antibiotics", "antibiotics"].sort());
      expect(fake.dump("categories")).toEqual(before);
      expect(fake.writes()).toEqual([]);
    });

    it("does not merge two existing categories whose names differ only by case when a third spelling is created", async () => {
      fake.seedCategories([{ name: "Antibiotics" }, { name: "antibiotics" }]);
      const res = await create("ANTIBIOTICS");
      expect(res.status).toBe(200); // answered with one of the existing ones
      expect(fake.dump("categories")).toHaveLength(2); // nothing created, nothing merged or deleted
      expect(fake.writes()).toEqual([]);
    });
  });

  describe("never a stale or cached answer", () => {
    it("marks list and create responses no-store and opts out of static caching, so a saved category can't look lost", async () => {
      expect(categoriesRoute.dynamic).toBe("force-dynamic");
      expect((await GET()).headers.get("cache-control")).toBe("no-store");
      expect((await create("Antibiotics")).headers.get("cache-control")).toBe("no-store");
      expect((await rawPost("nope")).headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("database failures are reported as failures", () => {
    it("answers a list request with 503 and a connection message when the database can't be reached (never an empty 200 list)", async () => {
      fake.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "categories" });
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(false);
      expect(errorTextOf(body)).toMatch(/can.t reach the database/i);
    });

    it("answers a list request with 500 and an API-key message when the database rejects the key", async () => {
      fake.failNext({ code: "PGRST301", message: "JWT expired" }, { table: "categories" });
      const res = await GET();
      expect(res.status).toBe(500);
      const body = await bodyRecord(res);
      expect(errorTextOf(body)).toMatch(/connection to the database was refused/i);
      expect(errorTextOf(body)).not.toMatch(/API key|JWT/i); // plain words for staff
      expect(body.technical).toMatch(/API key/); // the cause, for whoever looks after the app
    });

    it("answers a list request with 500 and the database error code for an unexpected error", async () => {
      fake.failNext({ code: "XX000", message: "internal error" }, { table: "categories" });
      const res = await GET();
      expect(res.status).toBe(500);
      const body = await bodyRecord(res);
      expect(body.error).toMatch(/^Something went wrong while reading from the database\./);
      expect(body.code).toBe("XX000");
    });

    it("answers with a 500 error instead of an empty list when the database client throws", async () => {
      fake.onCall(() => {
        throw new Error("socket hang up");
      });
      const res = await GET();
      expect(res.status).toBe(500);
      expect(Array.isArray(await res.json())).toBe(false);
    });

    it("fails a create request with 503 when the database can't be reached, and stores nothing", async () => {
      fake.failAll({ code: "", message: "TypeError: fetch failed" }, { table: "categories" });
      const res = await create("Antibiotics");
      expect(res.status).toBe(503);
      expect(errorTextOf(await res.json())).toMatch(/can.t reach the database/i);
      fake.clearFailures();
      expect(fake.dump("categories")).toEqual([]);
    });

    it("fails a create request with 503 when the database is unreachable at the insert step, and stores nothing", async () => {
      fake.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "categories", op: "insert" });
      const res = await create("Antibiotics");
      expect(res.status).toBe(503);
      expect(fake.dump("categories")).toEqual([]);
    });

    it("returns the winner (200) when another request creates the same name between the duplicate check and the insert", async () => {
      fake.onCall((call) => {
        if (call.op === "insert" && call.table === "categories") fake.seedCategories([{ name: "Splints" }]);
      });
      const res = await create("Splints");
      expect(res.status).toBe(200);
      const body = await bodyRecord(res);
      expect(body.name).toBe("Splints");
      expect(fake.dump("categories")).toHaveLength(1);
      expect(body.id).toBe(String(fake.dump("categories")[0].id));
    });

    it("answers 409 'already exists' (not a success, not a 500) when the race is lost and the winner can't be read back", async () => {
      fake.onCall((call) => {
        if (call.op === "insert" && call.table === "categories") {
          fake.seedCategories([{ name: "Splints" }]);
          fake.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "categories", op: "select" });
        }
      });
      const res = await create("Splints");
      expect(res.status).toBe(409);
      expect(errorTextOf(await res.json())).toMatch(/already exists/i);
      expect(fake.dump("categories")).toHaveLength(1);
    });
  });

  describe("only ever adds categories", () => {
    it("issues nothing but inserts into the categories table, however many creates happen (no rename, merge or delete)", async () => {
      await create("Antibiotics");
      await create("antibiotics");
      await create("First Aid");
      await create("Pain & Fever");
      const writes = fake.writes();
      expect(writes.length).toBe(3);
      for (const write of writes) {
        expect(write.op).toBe("insert");
        expect(write.table).toBe("categories");
      }
    });

    it("never touches medications or transactions while creating categories", async () => {
      fake.seedCategories([{ name: "Existing" }]);
      fake.seedMedications([{ id: 1, barcode: "B1", name: "Item", category_id: fake.dump("categories")[0].id as string | number }]);
      const before = fake.dump("medications");
      await create("New one");
      expect(fake.dump("medications")).toEqual(before);
      expect(fake.callsFor("medications")).toEqual([]);
      expect(fake.callsFor("transactions")).toEqual([]);
    });
  });
});

describe.each(ID_SHAPES)("the live categories defect (RLS on, no policy) with $label", ({ shape }) => {
  // supabase/schema.sql + the live inspection: `categories` has row-level security enabled and no policy for anon.
  // Reads come back EMPTY with no error; inserts fail with SQLSTATE 42501.
  let fake: FakeSupabase;
  beforeEach(() => {
    fake = installFake({ ...LIVE_BEFORE_MIGRATION, categoryIdType: shape });
  });

  it("refuses to create a category with 403 and a plain message, keeping the technical cause in a separate field, and stores nothing", async () => {
    const res = await create("Antibiotics");
    expect(res.status).toBe(403);
    const body = await bodyRecord(res);
    // What staff read: plain words, who to ask, and that the item can still be saved.
    expect(errorTextOf(body)).toBe(
      "Categories cannot be saved yet. This needs a one-time database update by whoever looks after this app. You can still save the item without a category."
    );
    expect(errorTextOf(body)).not.toMatch(/row-level|migration|42501|supabase/i);
    // What the person who looks after the app needs: the code, and the cause in database terms.
    expect(body.code).toBe("42501");
    expect(String(body.technical)).toMatch(/row-level security/i);
    expect(String(body.technical)).toContain("supabase/migrations/");
    expect(body).not.toHaveProperty("id");
    expect(fake.dump("categories")).toEqual([]);
  });

  it("logs the technical cause for whoever looks after the app, next to the code", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await create("Antibiotics");
    const line = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(line).toMatch(/403 42501/);
    expect(line).toMatch(/row-level security/i);
    expect(line).toContain("supabase/migrations/");
  });

  it("never reports success for the refused create: not 200, not 201, and no category appears in a later list", async () => {
    const res = await create("Antibiotics");
    expect(res.ok).toBe(false);
    expect(await bodyList(await GET())).toEqual([]);
  });

  it("documents the limitation that hidden categories are indistinguishable from none: the list is an empty 200", async () => {
    // Postgres answers a SELECT blocked by row-level security with zero rows and NO error, so this layer cannot tell
    // "no categories" from "categories I may not read". The Inventory tab therefore shows items whose category it
    // cannot name under "Category unavailable" instead of trusting an empty list. If this test starts failing, the
    // API gained a way to detect the situation: update the UI notes and the handoff report deliberately.
    fake.seedCategories([{ name: "Created by an administrator" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await bodyList(res)).toEqual([]);
    expect(fake.dump("categories")).toHaveLength(1);
  });

  it("refuses with 403 (and stores nothing) when only the INSERT policy exists, because the new row is read back and needs SELECT too", async () => {
    fake.setRls("categories", { select: false, insert: true, update: false, delete: false });
    const res = await create("Antibiotics");
    expect(res.status).toBe(403);
    expect(errorTextOf(await res.json())).toMatch(/^Categories cannot be saved yet\./);
    expect(fake.dump("categories")).toEqual([]);
  });

  it("creates categories normally once the migration's SELECT and INSERT policies exist", async () => {
    fake.setRls("categories", { select: true, insert: true, update: false, delete: false });
    const res = await create("Antibiotics");
    expect(res.status).toBe(201);
    expect(await bodyList(await GET())).toHaveLength(1);
  });

  it("explains a missing table privilege differently from a missing policy (applying the migration would not fix it)", async () => {
    fake.failNext({ code: "42501", message: 'permission denied for table categories' }, { table: "categories", op: "insert" });
    fake.setRls("categories", true);
    const res = await create("Antibiotics");
    expect(res.status).toBe(403);
    const body = asRecord(await res.json());
    const text = errorTextOf(body);
    expect(text).toMatch(/does not have permission to add to the category list/i);
    expect(text).not.toMatch(/one-time database update/i); // a one-time update would not help here
    expect(String(body.technical)).toMatch(/will not fix/i);
    expect(String(body.technical)).toMatch(/permission denied/i);
  });
});

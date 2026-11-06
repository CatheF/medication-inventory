// Self-tests for tests/helpers/fake-supabase.ts. Everything here is synthetic.
//
// Sections 15 and 16 prove the two vi.mock patterns documented in the helper's header by running REAL route
// handlers (transactions, analytics, import, upload) against the fake.
// Section 15b uses throwaway inline copies of plain categories handlers (the preFix functions) to show the live symptoms.
//
// Three tests in section 15 DO import the category and item routes (POST/GET /api/medications, POST /api/categories). They
// are the ones that prove the fake can reproduce what the route-level suites need: a NUL character reaching the
// route's own guard, and the two timing scenarios (a 23505 race and rows shifting between pages) that would otherwise
// need a hand-rolled stand-in. They only assert the routes' contract (status codes, field names, "every row exactly
// once"), never message wording, so a rewording of those routes cannot break them.
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeSupabase,
  getFake,
  installFake,
  LIVE_AFTER_MIGRATION,
  LIVE_BEFORE_MIGRATION,
  REPO_SCHEMA_SHAPE,
  supabaseProxy,
  uninstallFake,
  type FakeResponse,
  type FakeSupabase,
  type FakeSupabaseOptions,
  type Row,
} from "../helpers/fake-supabase";
import { buildTransactionSeeds, jsonRequest, readJson, routeParams, seedStandard, standardFake } from "../helpers/fixtures-extra";
import { buildCategories, buildMedications, SEED_ITEMS } from "../helpers/fixtures";

// Pattern A (documented in the helper header): dynamic import inside the hoisted factory.
vi.mock("@/lib/db", async () => {
  const { supabaseProxy: proxy } = await import("../helpers/fake-supabase");
  return { supabase: proxy };
});

// Pattern B support: a holder created by vi.hoisted (runs before any import).
const holder = vi.hoisted(() => ({ fake: null as FakeSupabase | null }));

import { supabase } from "@/lib/db"; // through the mock this is supabaseProxy
import { GET as analyticsGET } from "@/app/api/analytics/route";
import { POST as categoriesPOST } from "@/app/api/categories/route";
import { POST as importPOST } from "@/app/api/import/route";
import { GET as medicationsGET, POST as medicationsPOST } from "@/app/api/medications/route";
import { GET as transactionsGET, POST as transactionsPOST } from "@/app/api/transactions/route";
import { POST as uploadPOST } from "@/app/api/upload/route";

// ───────────────────────────────────────── helpers ─────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00:00$/;
const FETCH_FAILED = { code: "", message: "TypeError: fetch failed" } as const;

function rowsOf(r: FakeResponse): Row[] {
  if (r.error) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  if (!Array.isArray(r.data)) throw new Error(`expected an array, got ${JSON.stringify(r.data)}`);
  return r.data as Row[];
}
function rowOf(r: FakeResponse): Row {
  if (r.error) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.data as Row;
}
const names = (rows: Row[]): unknown[] => rows.map((r) => r.name);

/** bigint-shaped fake with 2 categories and 4 items: ids 1..4, one unnamed, one uncategorized. */
function simpleFake(options: FakeSupabaseOptions = {}): FakeSupabase {
  const fake = createFakeSupabase({ categoryIdType: "bigint", ...options });
  fake.seedCategories([
    { id: 1, name: "Antibiotics" },
    { id: 2, name: "First Aid" },
  ]);
  const supplier = options.hasSupplierColumn === false ? {} : { supplier_order_number: "00417-B" };
  fake.seedMedications([
    { id: 1, barcode: "0100", name: "Amoxicillin", stock: 5, threshold: 10, category_id: 1, ...supplier },
    { id: 2, barcode: "0200", name: "ibuprofen", stock: 50, threshold: 10, category_id: 1 },
    { id: 3, barcode: "300", name: "Zinc", stock: 7, threshold: 10, category_id: null },
    { id: 4, barcode: "400", name: null, stock: 0, threshold: 10, category_id: 2, is_unnamed: true },
  ]);
  return fake;
}

// ═══════════════════════════════════ 1. response shape & basics ═══════════════════════════════════

describe("basics", () => {
  it("resolves to { data, error, count, status, statusText, success } like postgrest-js", async () => {
    const fake = createFakeSupabase();
    const res = await fake.from("categories").select("*");
    expect(res).toEqual({ success: true, error: null, data: [], count: null, status: 200, statusText: "OK" });
  });

  it("insert without .select() returns no body (return=minimal); with .select() returns the stored row", async () => {
    const fake = createFakeSupabase();
    const minimal = await fake.from("medications").insert({ barcode: "0012" });
    expect(minimal).toMatchObject({ data: null, error: null, status: 201, statusText: "Created" });

    const full = await fake.from("medications").insert({ barcode: "0013" }).select();
    expect(full.status).toBe(201);
    const [row] = rowsOf(full);
    expect(row).toEqual({
      id: 2,
      name: null,
      barcode: "0013",
      photo_url: null,
      stock: 0,
      threshold: 10,
      vendor_url: null,
      unit: "units",
      notes: null,
      category_id: null,
      is_unnamed: false,
      created_at: expect.stringMatching(TS_RE),
      updated_at: expect.stringMatching(TS_RE),
      supplier_order_number: null,
    });
    expect(row.created_at).toBe(row.updated_at);
  });

  it("returns columns in table order with the supplier column appended last, and omits it when not migrated", async () => {
    const withCol = createFakeSupabase({ hasSupplierColumn: true });
    const without = createFakeSupabase({ hasSupplierColumn: false });
    const a = rowOf(await withCol.from("medications").insert({ barcode: "1" }).select().single());
    const b = rowOf(await without.from("medications").insert({ barcode: "1" }).select().single());
    expect(Object.keys(a).at(-1)).toBe("supplier_order_number");
    expect(Object.keys(a).slice(0, 3)).toEqual(["id", "name", "barcode"]);
    expect("supplier_order_number" in b).toBe(false);
  });

  it("supports column lists and aliases in select()", async () => {
    const fake = simpleFake();
    const res = await fake.from("medications").select("n:name, barcode").eq("id", 1);
    expect(rowsOf(res)).toEqual([{ n: "Amoxicillin", barcode: "0100" }]);
  });

  it("from() returns a builder that is not itself awaitable; nothing is sent until a chain is awaited", async () => {
    const fake = createFakeSupabase();
    const qb = fake.from("medications");
    expect(Object.prototype.hasOwnProperty.call(qb, "then")).toBe(false);
    fake.from("medications").select("*"); // built but never awaited
    fake.from("medications").insert({ barcode: "x" }); // same
    expect(fake.calls).toHaveLength(0);
    expect(fake.dump("medications")).toHaveLength(0);
  });

  it("hands out copies: mutating a result never changes the stored rows", async () => {
    const fake = simpleFake();
    const res = await fake.from("medications").select("*").eq("id", 1);
    rowsOf(res)[0].name = "TAMPERED";
    expect(fake.dump("medications")[0].name).toBe("Amoxicillin");
    fake.dump("medications")[0].name = "TAMPERED";
    expect(fake.dump("medications")[0].name).toBe("Amoxicillin");
  });

  it("unknown tables, columns and unsupported builder methods fail loudly", async () => {
    const fake = createFakeSupabase();
    const table = await fake.from("nope").select("*");
    expect(table.error).toMatchObject({ code: "PGRST205", message: "Could not find the table 'public.nope' in the schema cache" });
    expect(table.status).toBe(404);

    const column = await fake.from("medications").select("*").eq("bogus", 1);
    expect(column.error).toMatchObject({ code: "42703", message: "column medications.bogus does not exist" });

    const builder = fake.from("medications").select("*") as unknown as Record<string, () => unknown>;
    expect(() => builder.or()).toThrow(/not implemented/);
    expect(() => builder.csv()).toThrow(/not implemented/);
    expect(() => fake.from("")).toThrow(/Invalid relation name/);
  });

  it("error objects are plain objects (as in supabase-js), not Error instances", async () => {
    const fake = createFakeSupabase();
    await fake.from("medications").insert({ barcode: "1" });
    const dup = await fake.from("medications").insert({ barcode: "1" });
    expect(dup.error).not.toBeInstanceOf(Error);
    expect(Object.keys(dup.error ?? {}).sort()).toEqual(["code", "details", "hint", "message"]);
    expect(dup.success).toBe(false);
  });

  it(".throwOnError() rejects with a PostgrestError instead of resolving the error", async () => {
    const fake = createFakeSupabase();
    await fake.from("medications").insert({ barcode: "1" });
    await expect(fake.from("medications").insert({ barcode: "1" }).throwOnError()).rejects.toMatchObject({
      name: "PostgrestError",
      code: "23505",
    });
  });

  it("type-only builder methods are accepted and harmless; unsupported syntax in on_conflict is loud", async () => {
    const fake = simpleFake();
    const res = await fake.from("medications").select("*").abortSignal(new AbortController().signal).returns().overrideTypes().retry(false);
    expect(res.error).toBeNull();
    expect(rowsOf(res)).toHaveLength(4);
    await expect(Promise.resolve(fake.from("medications").upsert({ barcode: "x" }, { onConflict: "barcode,name" }))).rejects.toThrow(/not implemented/);
  });

  it("rejects typos in options instead of silently keeping the permissive defaults", () => {
    expect(() => createFakeSupabase({ rls: { categorys: false } as never })).toThrow(/unknown table "categorys"/);
    expect(() => createFakeSupabase({ rls: { categories: { selekt: false } as never } })).toThrow(/unknown operation "selekt"/);
    expect(() => createFakeSupabase({ maxRows: 0 })).toThrow(/maxRows/);
    expect(() => createFakeSupabase({ maxRows: 1000, rls: { categories: { select: false } } })).not.toThrow();
  });

  it("presets describe the live and repo database shapes, including the RLS of every table", async () => {
    expect(createFakeSupabase(LIVE_BEFORE_MIGRATION).options).toMatchObject({
      categoryIdType: "uuid",
      hasSupplierColumn: false,
      categoryFkOnDelete: "restrict",
    });
    expect(createFakeSupabase(LIVE_AFTER_MIGRATION).options).toMatchObject({ hasSupplierColumn: true, categoryIdType: "uuid", categoryFkOnDelete: "restrict" });
    expect(createFakeSupabase(REPO_SCHEMA_SHAPE).options).toMatchObject({ categoryIdType: "bigint", categoryFkOnDelete: "set-null" });
    expect(() => createFakeSupabase({ categoryIdType: "int" as unknown as "uuid" })).toThrow(/unknown categoryIdType/);

    const ALL = { select: true, insert: true, update: true, delete: true };
    const NONE = { select: false, insert: false, update: false, delete: false };
    const SELECT_ONLY = { select: true, insert: false, update: false, delete: false };
    // supabase/rls.sql + the live inspection: RLS on categories with no policy at all
    expect(createFakeSupabase(LIVE_BEFORE_MIGRATION).options.rls).toEqual({ categories: NONE, medications: ALL, transactions: SELECT_ONLY });
    // supabase/migrations/20261105000000_*.sql adds exactly two policies on categories: SELECT and INSERT
    expect(createFakeSupabase(LIVE_AFTER_MIGRATION).options.rls).toEqual({
      categories: { select: true, insert: true, update: false, delete: false },
      medications: ALL,
      transactions: SELECT_ONLY,
    });
    // a fresh install from schema.sql + rls.sql never enables RLS on categories, so anon keeps full table access
    expect(createFakeSupabase(REPO_SCHEMA_SHAPE).options.rls).toEqual({ categories: ALL, medications: ALL, transactions: SELECT_ONLY });
  });
});

// ═══════════════════════════════════ 2. filters ═══════════════════════════════════

describe("filters", () => {
  let fake: FakeSupabase;
  beforeEach(() => {
    fake = simpleFake();
  });

  it("eq / neq / gt / gte / lt / lte on numbers", async () => {
    const q = (op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte") => fake.from("medications").select("id").order("id")[op]("stock", 7);
    expect((rowsOf(await q("eq")) as Row[]).map((r) => r.id)).toEqual([3]);
    expect(rowsOf(await q("neq")).map((r) => r.id)).toEqual([1, 2, 4]);
    expect(rowsOf(await q("gt")).map((r) => r.id)).toEqual([2]);
    expect(rowsOf(await q("gte")).map((r) => r.id)).toEqual([2, 3]);
    expect(rowsOf(await q("lt")).map((r) => r.id)).toEqual([1, 4]);
    expect(rowsOf(await q("lte")).map((r) => r.id)).toEqual([1, 3, 4]);
  });

  it("text equality is exact and case-sensitive; a leading zero is significant", async () => {
    expect(rowsOf(await fake.from("medications").select("id").eq("barcode", "0100"))).toHaveLength(1);
    expect(rowsOf(await fake.from("medications").select("id").eq("barcode", "100"))).toHaveLength(0);
    expect(rowsOf(await fake.from("medications").select("id").eq("name", "amoxicillin"))).toHaveLength(0);
  });

  it("bigint columns accept numbers and numeric strings in filters", async () => {
    expect(rowsOf(await fake.from("medications").select("id").eq("id", 2))).toHaveLength(1);
    expect(rowsOf(await fake.from("medications").select("id").eq("id", "2"))).toHaveLength(1);
    const bad = await fake.from("medications").select("id").eq("id", Number("abc"));
    expect(bad.error).toMatchObject({ code: "22P02", message: 'invalid input syntax for type bigint: "NaN"' });
  });

  it("in(): lists, quoting of values with commas, de-duplication, empty list matches nothing", async () => {
    expect(rowsOf(await fake.from("medications").select("id").in("id", [1, 3, 3, 99])).map((r) => r.id)).toEqual([1, 3]);
    await fake.from("medications").insert({ barcode: "a,b" });
    await fake.from("medications").insert({ barcode: 'say "hi"' });
    expect(rowsOf(await fake.from("medications").select("barcode").in("barcode", ["a,b", "0100"]))).toHaveLength(2);
    expect(fake.calls.at(-1)?.filters[0].expr).toBe('in.("a,b",0100)');
    expect(rowsOf(await fake.from("medications").select("id").in("id", []))).toEqual([]);
    expect(fake.calls.at(-1)?.filters[0].expr).toBe("in.()");
  });

  it("in(): finds values with an embedded double quote, a comma, parentheses or a backslash (postgrest-js quotes only , ( ) and the server reads the rest literally)", async () => {
    const f = createFakeSupabase();
    const stored = ['say "hi"', "a,b", "x\\y", "(paren)", "0042", "plain"];
    f.seedMedications(stored.map((barcode) => ({ barcode })));
    const found = async (...values: string[]): Promise<string[]> =>
      rowsOf(await f.from("medications").select("barcode").in("barcode", values)).map((r) => r.barcode as string).sort();
    const sent = (): string => f.calls.at(-1)?.filters[0].expr ?? "";

    expect(await found('say "hi"')).toEqual(['say "hi"']);
    expect(sent()).toBe('in.(say "hi")'); // not wrapped: the quotes are part of the value
    expect(await found("a,b")).toEqual(["a,b"]);
    expect(sent()).toBe('in.("a,b")');
    expect(await found("x\\y")).toEqual(["x\\y"]);
    expect(sent()).toBe("in.(x\\y)"); // a backslash outside quotes is not an escape
    expect(await found("(paren)")).toEqual(["(paren)"]);
    expect(sent()).toBe('in.("(paren)")');
    // all of them in one list, the way /api/import sends its barcodes
    expect(await found(...stored)).toEqual([...stored].sort());
    expect(await found('say "hi"', "0042", "nope")).toEqual(['say "hi"', "0042"].sort());
    // and .eq() agrees with .in() for every one of them
    for (const value of stored) {
      expect(rowsOf(await f.from("medications").select("barcode").eq("barcode", value)).map((r) => r.barcode)).toEqual([value]);
    }
  });

  it("in(): the raw list grammar - an element is quoted only when it starts with a quote and the closing quote is followed by , or ); backslash escapes work inside quotes only; anything else is PGRST100", async () => {
    const f = createFakeSupabase();
    const stored = ["a,b", "plain", 'a"b', "x\\y", 'say "hi"', '"a"b', '"a', "quoted", '"quoted"'];
    f.seedMedications(stored.map((barcode) => ({ barcode })));
    const where = async (list: string): Promise<string[]> =>
      rowsOf(await f.from("medications").select("barcode").filter("barcode", "in", list)).map((r) => r.barcode as string).sort();

    expect(await where('("a,b",plain)')).toEqual(["a,b", "plain"]);
    expect(await where('("a\\"b")')).toEqual(['a"b']); // \" inside quotes is a literal quote
    expect(await where('("x\\\\y")')).toEqual(["x\\y"]); // \\ inside quotes is a literal backslash
    expect(await where("(x\\y)")).toEqual(["x\\y"]); // ...but not outside quotes
    expect(await where('(say "hi")')).toEqual(['say "hi"']); // quote in the middle of an element: literal
    expect(await where('("a"b)')).toEqual(['"a"b']); // closing quote followed by another character: not a quoted element
    expect(await where('("a)')).toEqual(['"a']); // never closed: literal
    expect(await where('("quoted")')).toEqual(["quoted"]); // a quoted element loses its quotes ...
    // ... so a value that itself starts and ends with a quote cannot be looked up with postgrest-js .in(): it is sent
    // unwrapped (no , ( or ) in it), read back as a quoted element, and finds the OTHER row. Use .eq() for such values.
    const viaIn = rowsOf(await f.from("medications").select("barcode").in("barcode", ['"quoted"']));
    expect(viaIn.map((r) => r.barcode)).toEqual(["quoted"]);
    expect(f.calls.at(-1)?.filters[0].expr).toBe('in.("quoted")');
    expect(rowsOf(await f.from("medications").select("barcode").eq("barcode", '"quoted"')).map((r) => r.barcode)).toEqual(['"quoted"']);
    // malformed lists are a parse error, like PostgREST
    for (const bad of ["a,b", "(a,b", "a,b)", "(a)b)", '("a")b)']) {
      const res = await f.from("medications").select("barcode").filter("barcode", "in", bad);
      expect(res.error, bad).toMatchObject({ code: "PGRST100" });
      expect(res.status).toBe(400);
    }
  });

  it("is(): null and booleans; a bad value is a PostgREST parse error (PGRST100)", async () => {
    expect(rowsOf(await fake.from("medications").select("id").is("category_id", null)).map((r) => r.id)).toEqual([3]);
    expect(rowsOf(await fake.from("medications").select("id").is("is_unnamed", true)).map((r) => r.id)).toEqual([4]);
    expect(rowsOf(await fake.from("medications").select("id").not("category_id", "is", null)).map((r) => r.id)).toEqual([1, 2, 4]);
    const bad = await fake.from("medications").select("id").is("category_id", Number.NaN);
    expect(bad.error).toMatchObject({ code: "PGRST100" });
    expect(bad.status).toBe(400);
  });

  it("follows SQL NULL logic: neq / not.eq never match rows whose column is NULL", async () => {
    const neq = rowsOf(await fake.from("medications").select("id").neq("category_id", 1));
    expect(neq.map((r) => r.id)).toEqual([4]); // id 3 (category NULL) is NOT returned
    const notEq = rowsOf(await fake.from("medications").select("id").not("category_id", "eq", 1));
    expect(notEq.map((r) => r.id)).toEqual([4]);
    expect(rowsOf(await fake.from("medications").select("id").eq("name", null as unknown as string))).toEqual([]);
  });

  it("like / ilike translate % _ and PostgREST's *", async () => {
    expect(names(rowsOf(await fake.from("medications").select("name").ilike("name", "%IBU%")))).toEqual(["ibuprofen"]);
    expect(names(rowsOf(await fake.from("medications").select("name").ilike("name", "*ibu*")))).toEqual(["ibuprofen"]);
    expect(names(rowsOf(await fake.from("medications").select("name").like("name", "%IBU%")))).toEqual([]);
    expect(names(rowsOf(await fake.from("medications").select("name").like("name", "Zin_")))).toEqual(["Zinc"]);
    expect(names(rowsOf(await fake.from("medications").select("name").like("name", "Zin\\_")))).toEqual([]);
    const bad = await fake.from("medications").select("id").ilike("stock", "5");
    expect(bad.error).toMatchObject({ code: "42883" });
  });

  it("match() and filter() build the same expressions as postgrest-js", async () => {
    expect(rowsOf(await fake.from("medications").select("id").match({ category_id: 1, stock: 50, ignored: undefined })).map((r) => r.id)).toEqual([2]);
    expect(rowsOf(await fake.from("medications").select("id").filter("stock", "lte", 5)).map((r) => r.id)).toEqual([1, 4]);
  });

  it("compares timestamps by instant, not by text (Z vs +00:00, fractional seconds)", async () => {
    const f = createFakeSupabase();
    f.seedMedications([
      { id: 1, barcode: "a", created_at: "2026-11-05T12:00:00.500+00:00" },
      { id: 2, barcode: "b", created_at: "2026-11-05T12:00:01+00:00" },
      { id: 3, barcode: "c", created_at: "2026-11-05T11:00:00-02:00" }, // 13:00Z
    ]);
    const ids = async (op: "gte" | "lte", value: string) =>
      rowsOf(await f.from("medications").select("id").order("id")[op]("created_at", value)).map((r) => r.id);
    expect(await ids("gte", "2026-11-05T12:00:01.000Z")).toEqual([2, 3]);
    expect(await ids("lte", "2026-11-05T12:00:00.500Z")).toEqual([1]);
    expect(await ids("gte", "2026-11-05T13:00:00Z")).toEqual([3]);
    expect(await f.from("medications").select("id").gte("created_at", "yesterday-ish")).toMatchObject({
      error: { code: "22007", message: 'invalid input syntax for type timestamp with time zone: "yesterday-ish"' },
    });
  });

  it("less common operators: is.false / is.unknown, gt/lt on text and uuid, raw filter() expressions", async () => {
    expect(rowsOf(await fake.from("medications").select("id").is("is_unnamed", false).order("id")).map((r) => r.id)).toEqual([1, 2, 3]);
    expect(rowsOf(await fake.from("medications").select("id").filter("is_unnamed", "is", "unknown"))).toEqual([]);
    expect((await fake.from("medications").select("id").is("stock", true)).error).toMatchObject({ code: "42804" });
    expect(names(rowsOf(await fake.from("medications").select("name").gt("name", "Amoxicillin").order("name")))).toEqual(["ibuprofen", "Zinc"]);
    expect(rowsOf(await fake.from("medications").select("id").filter("id", "in", "(1,4)").order("id")).map((r) => r.id)).toEqual([1, 4]);
    expect((await fake.from("medications").select("id").filter("id", "in", "1,4")).error).toMatchObject({ code: "PGRST100" });
    expect((await fake.from("medications").select("id").filter("id", "approx", "1")).error).toMatchObject({ code: "PGRST100" });
    expect((await fake.from("medications").select("id").filter("id", "gt", "")).error).toMatchObject({ code: "22P02" });

    const uuid = createFakeSupabase({ categoryIdType: "uuid" });
    uuid.seedCategories(buildCategories("uuid"));
    const ids = buildCategories("uuid").map((c) => c.id).sort();
    expect(rowsOf(await uuid.from("categories").select("id").lt("id", ids[2])).map((r) => r.id).sort()).toEqual(ids.slice(0, 2));
  });

  it("order() / limit() / range() on a referenced table are refused loudly", () => {
    const builder = fake.from("transactions").select("*, medications(name)");
    expect(() => builder.order("name", { referencedTable: "medications" })).toThrow(/not implemented/);
    expect(() => builder.limit(1, { foreignTable: "medications" })).toThrow(/not implemented/);
    expect(() => builder.range(0, 1, { referencedTable: "medications" })).toThrow(/not implemented/);
  });

  it("records filters exactly as the client would put them in the URL, keeping the original argument", async () => {
    await fake.from("medications").select("id").eq("category_id", Number.NaN).limit(1);
    const call = fake.calls[0];
    expect(call.filters).toHaveLength(1);
    expect(call.filters[0].expr).toBe("eq.NaN");
    expect(Number.isNaN(call.filters[0].value)).toBe(true);
  });
});

// ═══════════════════════════════════ 3. ordering, windows, counts, max rows ═══════════════════════════════════

describe("order / limit / range / count / head", () => {
  it("orders ascending with NULLS LAST and descending with NULLS FIRST (Postgres defaults)", async () => {
    const fake = simpleFake();
    expect(names(rowsOf(await fake.from("medications").select("name").order("name")))).toEqual(["Amoxicillin", "ibuprofen", "Zinc", null]);
    expect(names(rowsOf(await fake.from("medications").select("name").order("name", { ascending: false })))).toEqual([null, "Zinc", "ibuprofen", "Amoxicillin"]);
    expect(names(rowsOf(await fake.from("medications").select("name").order("name", { nullsFirst: true })))).toEqual([null, "Amoxicillin", "ibuprofen", "Zinc"]);
    expect(names(rowsOf(await fake.from("medications").select("name").order("name", { ascending: false, nullsFirst: false })))).toEqual(["Zinc", "ibuprofen", "Amoxicillin", null]);
  });

  it("supports several order() calls (tie-breakers) and is stable", async () => {
    const fake = simpleFake();
    const res = await fake.from("medications").select("id").order("category_id", { nullsFirst: false }).order("id", { ascending: false });
    expect(rowsOf(res).map((r) => r.id)).toEqual([2, 1, 4, 3]);
  });

  it("collation option: en-US ignores case at the first level, C sorts uppercase first", async () => {
    const en = simpleFake({ collation: "en-US" });
    const c = simpleFake({ collation: "C" });
    expect(names(rowsOf(await en.from("medications").select("name").order("name")))).toEqual(["Amoxicillin", "ibuprofen", "Zinc", null]);
    expect(names(rowsOf(await c.from("medications").select("name").order("name")))).toEqual(["Amoxicillin", "Zinc", "ibuprofen", null]);
  });

  it("limit() and range() window the ordered result; range beyond the end is an empty array", async () => {
    const fake = simpleFake();
    const ids = async (from: number, to: number) => rowsOf(await fake.from("medications").select("id").order("id").range(from, to)).map((r) => r.id);
    expect(await ids(0, 1)).toEqual([1, 2]);
    expect(await ids(2, 10)).toEqual([3, 4]);
    expect(await ids(10, 19)).toEqual([]);
    expect(rowsOf(await fake.from("medications").select("id").order("id").limit(3)).map((r) => r.id)).toEqual([1, 2, 3]);
    expect(rowsOf(await fake.from("medications").select("id").limit(0))).toEqual([]);
    expect(await fake.from("medications").select("id").range(0, Number.NaN)).toMatchObject({ error: { code: "PGRST100" } });
  });

  it("a page that starts beyond the table is 416 PGRST103 when a count was requested, an empty array otherwise", async () => {
    const fake = simpleFake();
    const withCount = await fake.from("medications").select("*", { count: "exact" }).range(4, 7);
    expect(withCount).toMatchObject({
      data: null,
      status: 416,
      error: { code: "PGRST103", message: "Requested range not satisfiable", details: "An offset of 4 was requested, but there are only 4 rows." },
    });
    expect(rowsOf(await fake.from("medications").select("*").range(4, 7))).toEqual([]);
    expect(rowsOf(await fake.from("medications").select("*", { count: "exact" }).range(3, 7))).toHaveLength(1); // last row: fine
    const empty = createFakeSupabase();
    expect(await empty.from("medications").select("*", { count: "exact" }).range(0, 9)).toMatchObject({ data: [], count: 0, error: null });
  });

  it("countSupported:false answers count requests with count: null (and then there is no 416 either)", async () => {
    const fake = simpleFake({ countSupported: false });
    const res = await fake.from("medications").select("*", { count: "exact" }).range(0, 1);
    expect(res.count).toBeNull();
    expect(rowsOf(res)).toHaveLength(2);
    expect(res.status).toBe(200);
    expect(rowsOf(await fake.from("medications").select("*", { count: "exact" }).range(10, 12))).toEqual([]);
    const del = await fake.from("medications").delete({ count: "exact" }).eq("id", 3);
    expect(del.count).toBeNull();
  });

  it("count: 'exact' reports the full match count (before limit); head:true returns only the count", async () => {
    const fake = simpleFake();
    const page = await fake.from("medications").select("id", { count: "exact" }).order("id").range(0, 1);
    expect(rowsOf(page)).toHaveLength(2);
    expect(page.count).toBe(4);
    expect(page.status).toBe(206); // partial content, as PostgREST answers when the page is smaller than the total

    const head = await fake.from("medications").select("*", { count: "exact", head: true }).eq("category_id", 1);
    expect(head).toMatchObject({ data: null, error: null, count: 2, status: 200 });

    const none = await fake.from("medications").select("id");
    expect(none.count).toBeNull();
  });

  it("maxRows silently truncates reads; count still reports the true total", async () => {
    const fake = createFakeSupabase({ maxRows: 1000 });
    fake.seedMedications(Array.from({ length: 2500 }, (_, i) => ({ barcode: `B${String(i + 1).padStart(5, "0")}`, name: `Item ${i + 1}` })));

    const naive = await fake.from("medications").select("*", { count: "exact" });
    expect(rowsOf(naive)).toHaveLength(1000); // no error, no warning: the server just stops
    expect(naive.count).toBe(2500);

    expect(rowsOf(await fake.from("medications").select("id").range(0, 1999))).toHaveLength(1000); // range is capped too
    expect(rowsOf(await fake.from("medications").select("id").limit(5000))).toHaveLength(1000);
    expect(rowsOf(await fake.from("medications").select("id").limit(10))).toHaveLength(10);
  });

  it("a range() loop that stops on a short page retrieves every row exactly once (and survives an exact multiple)", async () => {
    for (const total of [2500, 2000]) {
      const fake = createFakeSupabase({ maxRows: 1000 });
      fake.seedMedications(Array.from({ length: total }, (_, i) => ({ barcode: `B${i + 1}` })));
      const all: Row[] = [];
      for (let from = 0, pages = 0; ; from += 1000, pages++) {
        expect(pages).toBeLessThan(10);
        const page = rowsOf(await fake.from("medications").select("*").order("id").range(from, from + 999));
        all.push(...page);
        if (page.length < 1000) break;
      }
      expect(all).toHaveLength(total);
      expect(new Set(all.map((r) => r.id)).size).toBe(total);
      expect(fake.calls).toHaveLength(Math.floor(total / 1000) + 1); // 3 requests for 2500, 3 for 2000 (last one empty)
    }
  });

  it("without maxRows everything is returned", async () => {
    const fake = createFakeSupabase();
    fake.seedMedications(Array.from({ length: 1500 }, (_, i) => ({ barcode: `B${i + 1}` })));
    expect(rowsOf(await fake.from("medications").select("id"))).toHaveLength(1500);
  });
});

// ═══════════════════════════════════ 4. single / maybeSingle ═══════════════════════════════════

describe("single() and maybeSingle()", () => {
  it("single(): exactly one row -> object; zero or many -> PGRST116 (406)", async () => {
    const fake = simpleFake();
    expect(rowOf(await fake.from("medications").select("*").eq("id", 1).single()).name).toBe("Amoxicillin");

    const none = await fake.from("medications").select("*").eq("id", 99).single();
    expect(none).toMatchObject({
      data: null,
      status: 406,
      error: {
        code: "PGRST116",
        message: "JSON object requested, multiple (or no) rows returned",
        details: "The result contains 0 rows",
        hint: null,
      },
    });
    const many = await fake.from("medications").select("*").single();
    expect(many.error).toMatchObject({ code: "PGRST116", details: "The result contains 4 rows" });
  });

  it("maybeSingle(): zero rows -> null without an error; many rows -> PGRST116", async () => {
    const fake = simpleFake();
    expect(await fake.from("medications").select("*").eq("id", 99).maybeSingle()).toMatchObject({ data: null, error: null });
    expect(rowOf(await fake.from("medications").select("*").eq("id", 2).maybeSingle()).name).toBe("ibuprofen");
    const many = await fake.from("medications").select("*").maybeSingle();
    expect(many.error).toMatchObject({
      code: "PGRST116",
      details: "Results contain 4 rows, application/vnd.pgrst.object+json requires 1 row",
    });
    expect(many.data).toBeNull();
  });

  it("update().select().single() that would touch 0 or 2 rows fails with PGRST116 and changes nothing (rollback)", async () => {
    const fake = simpleFake();
    const before = fake.dump("medications");

    const zero = await fake.from("medications").update({ name: "X" }).eq("id", 99).select().single();
    expect(zero.error).toMatchObject({ code: "PGRST116" });

    const two = await fake.from("medications").update({ name: "X" }).eq("category_id", 1).select().single();
    expect(two.error).toMatchObject({ code: "PGRST116", details: "The result contains 2 rows" });
    expect(fake.dump("medications")).toEqual(before);
  });

  it("insert of two rows + .single() is rolled back; delete().select().single() likewise", async () => {
    const fake = simpleFake();
    const res = await fake.from("medications").insert([{ barcode: "n1" }, { barcode: "n2" }]).select().single();
    expect(res.error).toMatchObject({ code: "PGRST116" });
    expect(fake.dump("medications")).toHaveLength(4);
    const del = await fake.from("medications").delete().in("id", [1, 3]).select().single();
    expect(del.error).toMatchObject({ code: "PGRST116" });
    expect(fake.dump("medications")).toHaveLength(4);
  });

  it("maybeSingle() is client side: a mutation that touched 2 rows is NOT rolled back (documented postgrest-js behaviour)", async () => {
    const fake = simpleFake();
    const res = await fake.from("medications").update({ notes: "n" }).eq("category_id", 1).select().maybeSingle();
    expect(res.error).toMatchObject({ code: "PGRST116" });
    expect(fake.dump("medications").filter((r) => r.notes === "n")).toHaveLength(2);
  });
});

// ═══════════════════════════════════ 5. typed category ids ═══════════════════════════════════

describe("category ids: uuid (live database)", () => {
  let fake: FakeSupabase;
  let catId: string;
  beforeEach(async () => {
    fake = createFakeSupabase({ categoryIdType: "uuid" });
    catId = rowOf(await fake.from("categories").insert({ name: "Antibiotics" }).select().single()).id as string;
  });

  it("generates uuid strings for categories and returns category_id as a string", async () => {
    expect(catId).toMatch(UUID_RE);
    expect(catId).toBe("a0000000-0000-4000-8000-000000000001"); // deterministic, so tests can rely on it
    const med = rowOf(await fake.from("medications").insert({ barcode: "1", category_id: catId }).select().single());
    expect(med.category_id).toBe(catId);
    expect(typeof med.category_id).toBe("string");
  });

  it.each([
    ["NaN", 'invalid input syntax for type uuid: "NaN"'],
    ["undefined", 'invalid input syntax for type uuid: "undefined"'],
    ["", 'invalid input syntax for type uuid: ""'],
    ["null", 'invalid input syntax for type uuid: "null"'],
    ["12", 'invalid input syntax for type uuid: "12"'],
    [" a0000000-0000-4000-8000-000000000001", 'invalid input syntax for type uuid: " a0000000-0000-4000-8000-000000000001"'],
    ["a0000000-0000-4000-8000-00000000000g", 'invalid input syntax for type uuid: "a0000000-0000-4000-8000-00000000000g"'],
  ])("writing %j to a uuid column -> 22P02 %s", async (bad, message) => {
    const insert = await fake.from("medications").insert({ barcode: "bad", category_id: bad });
    expect(insert.error).toMatchObject({ code: "22P02", message });
    expect(insert.status).toBe(400);
    const med = rowOf(await fake.from("medications").insert({ barcode: "ok" }).select().single());
    const update = await fake.from("medications").update({ category_id: bad }).eq("id", med.id as number);
    expect(update.error).toMatchObject({ code: "22P02", message });
    expect(fake.dump("medications").map((r) => r.barcode)).toEqual(["ok"]); // nothing from the failed insert
  });

  it("a JSON number is not a uuid either (5 -> 22P02)", async () => {
    const res = await fake.from("medications").insert({ barcode: "n", category_id: 5 });
    expect(res.error).toMatchObject({ code: "22P02", message: 'invalid input syntax for type uuid: "5"' });
  });

  it("null is allowed; uppercase, braced and hyphen-less spellings are accepted and stored canonically", async () => {
    expect(rowOf(await fake.from("medications").insert({ barcode: "a", category_id: null }).select().single()).category_id).toBeNull();
    const compact = catId.replace(/-/g, "");
    for (const [i, spelling] of [catId.toUpperCase(), `{${catId}}`, compact, `${compact.slice(0, 4)}-${compact.slice(4)}`].entries()) {
      const med = rowOf(await fake.from("medications").insert({ barcode: `v${i}`, category_id: spelling }).select().single());
      expect(med.category_id).toBe(catId);
    }
  });

  it("filters are typed too: eq('category_id', 'NaN' | NaN) fails with 22P02 even on an empty table", async () => {
    const empty = createFakeSupabase({ categoryIdType: "uuid" });
    const msg = 'invalid input syntax for type uuid: "NaN"';
    expect(await empty.from("medications").select("*").eq("category_id", "NaN")).toMatchObject({ error: { code: "22P02", message: msg } });
    expect(await empty.from("medications").select("*").eq("category_id", Number.NaN)).toMatchObject({ error: { code: "22P02", message: msg } });
    expect(await empty.from("medications").select("*").in("category_id", [catId, "x"])).toMatchObject({
      error: { code: "22P02", message: 'invalid input syntax for type uuid: "x"' },
    });
    expect(rowsOf(await fake.from("medications").select("*").eq("category_id", catId.toUpperCase()))).toEqual([]);
  });

  it("ROOT CAUSE REPRODUCED: Number(uuid) is NaN, JSON turns NaN into null, the update 'succeeds' and clears the category", async () => {
    const med = rowOf(await fake.from("medications").insert({ barcode: "m", category_id: catId }).select().single());
    expect(Number(catId)).toBeNaN();

    const res = await fake.from("medications").update({ category_id: Number(catId) }).eq("id", med.id as number).select().single();
    expect(res.error).toBeNull(); // no error: this is why the page still said "Medication updated."
    expect(rowOf(res).category_id).toBeNull();
    expect(fake.dump("medications")[0].category_id).toBeNull();
    expect(fake.calls.at(-1)?.payload).toEqual({ category_id: null }); // what actually went over the wire
  });
});

describe("category ids: bigint (supabase/schema.sql)", () => {
  let fake: FakeSupabase;
  beforeEach(async () => {
    fake = createFakeSupabase({ categoryIdType: "bigint" });
    await fake.from("categories").insert([{ name: "Antibiotics" }, { name: "First Aid" }]);
  });

  it("categories get sequential numeric ids; reads return numbers", async () => {
    const cats = rowsOf(await fake.from("categories").select("*").order("id"));
    expect(cats.map((c) => c.id)).toEqual([1, 2]);
    const med = rowOf(await fake.from("medications").insert({ barcode: "1", category_id: 2 }).select().single());
    expect(med.category_id).toBe(2);
    expect(typeof med.category_id).toBe("number");
  });

  it("PostgREST accepts numeric strings for bigint (and Postgres tolerates padding and leading zeros)", async () => {
    for (const [i, input] of ["2", "002", " 2 ", "+2", 2].entries()) {
      const med = rowOf(await fake.from("medications").insert({ barcode: `n${i}`, category_id: input }).select().single());
      expect(med.category_id).toBe(2);
    }
  });

  it.each([
    ["NaN", 'invalid input syntax for type bigint: "NaN"'],
    ["undefined", 'invalid input syntax for type bigint: "undefined"'],
    ["", 'invalid input syntax for type bigint: ""'],
    ["1.5", 'invalid input syntax for type bigint: "1.5"'],
    [1.5, 'invalid input syntax for type bigint: "1.5"'],
    ["1e3", 'invalid input syntax for type bigint: "1e3"'],
    ["a1", 'invalid input syntax for type bigint: "a1"'],
    ["a0000000-0000-4000-8000-000000000001", 'invalid input syntax for type bigint: "a0000000-0000-4000-8000-000000000001"'],
  ])("writing %j to a bigint column -> 22P02", async (bad, message) => {
    const res = await fake.from("medications").insert({ barcode: "bad", category_id: bad });
    expect(res.error).toMatchObject({ code: "22P02", message });
  });

  it("out-of-range digits are 22003; null is allowed", async () => {
    const big = await fake.from("medications").insert({ barcode: "big", category_id: "99999999999999999999" });
    expect(big.error).toMatchObject({ code: "22003", message: 'value "99999999999999999999" is out of range for type bigint' });
    expect((await fake.from("medications").insert({ barcode: "nul", category_id: null })).error).toBeNull();
  });

  it("Number(id) works for bigint, which is why the NaN bug only shows up on the uuid database", async () => {
    expect(Number("2")).toBe(2);
    const med = rowOf(await fake.from("medications").insert({ barcode: "m", category_id: 1 }).select().single());
    const res = await fake.from("medications").update({ category_id: Number("2") }).eq("id", med.id as number).select().single();
    expect(rowOf(res).category_id).toBe(2);
  });
});

// ═══════════════════════════════════ 6. row-level security ═══════════════════════════════════

describe("row-level security", () => {
  it("SELECT denied: silent empty result (HTTP 200), count 0, single -> PGRST116, maybeSingle -> null", async () => {
    const fake = createFakeSupabase({ rls: { categories: { select: false, insert: false } } });
    fake.seedCategories([{ id: "a0000000-0000-4000-8000-0000000000aa", name: "Hidden" }]);
    const res = await fake.from("categories").select("*").order("name");
    expect(res).toMatchObject({ data: [], error: null, status: 200 });
    expect((await fake.from("categories").select("*", { count: "exact" })).count).toBe(0);
    expect((await fake.from("categories").select("*").eq("name", "Hidden").single()).error).toMatchObject({ code: "PGRST116" });
    expect(await fake.from("categories").select("*").eq("name", "Hidden").maybeSingle()).toMatchObject({ data: null, error: null });
    expect(fake.dump("categories")).toHaveLength(1); // the row exists; it is only invisible
  });

  it("INSERT denied: 42501 with the Postgres message and nothing stored", async () => {
    const fake = createFakeSupabase({ rls: { categories: { select: false, insert: false } } });
    const res = await fake.from("categories").insert({ name: "Nope" }).select().single();
    expect(res).toMatchObject({
      data: null,
      status: 403,
      error: { code: "42501", message: 'new row violates row-level security policy for table "categories"' },
    });
    expect(fake.dump("categories")).toEqual([]);
  });

  it("rls: { categories: false } = RLS enabled with no policy at all (the live table today)", async () => {
    const fake = createFakeSupabase(LIVE_BEFORE_MIGRATION);
    fake.seedCategories([{ id: "a0000000-0000-4000-8000-0000000000aa", name: "Hidden" }]);
    expect(rowsOf(await fake.from("categories").select("*"))).toEqual([]);
    expect((await fake.from("categories").insert({ name: "x" })).error?.code).toBe("42501");
    const upd = await fake.from("categories").update({ name: "y" }).eq("name", "Hidden").select();
    expect(upd).toMatchObject({ data: [], error: null });
    const del = await fake.from("categories").delete().eq("name", "Hidden").select();
    expect(del).toMatchObject({ data: [], error: null });
    expect(fake.dump("categories").map((c) => c.name)).toEqual(["Hidden"]);
  });

  it("LIVE_AFTER_MIGRATION keeps the migration's least-privilege boundary: categories can be read and created, but a rename or delete silently touches 0 rows", async () => {
    const fake = createFakeSupabase(LIVE_AFTER_MIGRATION);
    const created = rowOf(await fake.from("categories").insert({ name: "A" }).select().single()); // INSERT .. RETURNING needs both policies
    const id = created.id as string;
    expect(rowsOf(await fake.from("categories").select("*")).map((c) => c.name)).toEqual(["A"]);

    const rename = await fake.from("categories").update({ name: "B" }).eq("id", id).select();
    expect(rename).toMatchObject({ data: [], error: null, status: 200 }); // no error: the row is just not updatable
    expect((await fake.from("categories").update({ name: "B" }).eq("id", id).select().single()).error).toMatchObject({ code: "PGRST116" });
    const removal = await fake.from("categories").delete().eq("id", id).select();
    expect(removal).toMatchObject({ data: [], error: null, status: 200 });
    expect(fake.dump("categories").map((c) => c.name)).toEqual(["A"]); // neither happened

    // the same two statements DO work where RLS is off on categories (a fresh install: REPO_SCHEMA_SHAPE)
    const repo = createFakeSupabase(REPO_SCHEMA_SHAPE);
    await repo.from("categories").insert({ name: "A" });
    expect(rowsOf(await repo.from("categories").update({ name: "B" }).eq("name", "A").select()).map((c) => c.name)).toEqual(["B"]);
    expect(rowsOf(await repo.from("categories").delete().eq("name", "B").select())).toHaveLength(1);
  });

  it("UPDATE / DELETE denied silently affect 0 rows (no error), so .single() reports PGRST116", async () => {
    const fake = simpleFake({ rls: { medications: { update: false, delete: false } } });
    const before = fake.dump("medications");
    expect(await fake.from("medications").update({ name: "X" }).eq("id", 1)).toMatchObject({ data: null, error: null });
    expect(await fake.from("medications").update({ name: "X" }).eq("id", 1).select()).toMatchObject({ data: [], error: null });
    expect((await fake.from("medications").update({ name: "X" }).eq("id", 1).select().single()).error?.code).toBe("PGRST116");
    expect(await fake.from("medications").delete().eq("id", 1).select()).toMatchObject({ data: [], error: null });
    expect(fake.dump("medications")).toEqual(before);
  });

  it("with SELECT denied, UPDATE/DELETE with a WHERE clause also match nothing (Postgres needs SELECT to evaluate the WHERE)", async () => {
    const fake = simpleFake({ rls: { medications: { select: false } } });
    const before = fake.dump("medications");
    expect(await fake.from("medications").update({ name: "X" }).eq("id", 1).select()).toMatchObject({ data: [], error: null });
    expect(await fake.from("medications").delete().eq("id", 1).select()).toMatchObject({ data: [], error: null });
    expect(fake.dump("medications")).toEqual(before);
  });

  it("INSERT .. RETURNING needs SELECT as well: insert allowed + select denied -> 42501 only when .select() is chained", async () => {
    const fake = createFakeSupabase({ rls: { categories: { select: false } } });
    const returning = await fake.from("categories").insert({ name: "A" }).select().single();
    expect(returning.error).toMatchObject({ code: "42501", message: 'new row violates row-level security policy for table "categories"' });
    expect(fake.dump("categories")).toEqual([]);
    const minimal = await fake.from("categories").insert({ name: "B" });
    expect(minimal.error).toBeNull();
    expect(fake.dump("categories").map((c) => c.name)).toEqual(["B"]);
  });

  it("upsert needs INSERT even for rows that conflict; its update part needs SELECT + UPDATE (error, not silent)", async () => {
    const noInsert = simpleFake({ rls: { medications: { insert: false } } });
    expect((await noInsert.from("medications").upsert({ barcode: "0100", stock: 1 }, { onConflict: "barcode" })).error?.code).toBe("42501");

    const noUpdate = simpleFake({ rls: { medications: { update: false } } });
    const res = await noUpdate.from("medications").upsert({ barcode: "0100", stock: 1 }, { onConflict: "barcode" });
    expect(res.error).toMatchObject({
      code: "42501",
      message: 'new row violates row-level security policy (USING expression) for table "medications"',
    });
    expect(noUpdate.dump("medications")[0].stock).toBe(5);
  });

  it("transactions default to SELECT-only (supabase/rls.sql); the rpc and the ON DELETE CASCADE bypass RLS", async () => {
    const fake = simpleFake();
    expect(fake.options.rls.transactions).toEqual({ select: true, insert: false, update: false, delete: false });
    const direct = await fake.from("transactions").insert({ medication_id: 1, type: "receive", quantity: 1 });
    expect(direct.error).toMatchObject({ code: "42501", message: 'new row violates row-level security policy for table "transactions"' });

    const viaRpc = await fake.rpc("record_transaction", { p_medication_id: 1, p_type: "receive", p_quantity: 4 });
    expect(viaRpc.error).toBeNull();
    expect(rowsOf(await fake.from("transactions").select("*"))).toHaveLength(1);

    expect((await fake.from("medications").delete().eq("id", 1).select()).error).toBeNull();
    expect(fake.dump("transactions")).toEqual([]); // cascaded although transactions has no DELETE policy
  });

  it("FK checks bypass RLS: a hidden category can still be referenced", async () => {
    const fake = createFakeSupabase({ categoryIdType: "uuid", rls: { categories: false } });
    fake.seedCategories([{ id: "a0000000-0000-4000-8000-0000000000aa", name: "Hidden" }]);
    const res = await fake.from("medications").insert({ barcode: "m", category_id: "a0000000-0000-4000-8000-0000000000aa" }).select().single();
    expect(res.error).toBeNull();
    expect(rowOf(res).category_id).toBe("a0000000-0000-4000-8000-0000000000aa");
    expect(rowsOf(await fake.from("categories").select("*"))).toEqual([]);
  });

  it("the rpc is SECURITY DEFINER: it works even when medications and transactions are fully locked down", async () => {
    const fake = simpleFake({ rls: { medications: false, transactions: false } });
    const res = await fake.rpc("record_transaction", { p_medication_id: 1, p_type: "dispense", p_quantity: 2 });
    expect(res.error).toBeNull();
    expect(fake.dump("medications")[0].stock).toBe(3);
  });

  it("embedded rows obey the embedded table's SELECT policy (null when hidden)", async () => {
    const fake = simpleFake({ rls: { medications: { select: false } } });
    fake.seedTransactions([{ medication_id: 1, type: "receive", quantity: 2 }]);
    const res = await fake.from("transactions").select("*, medications(name, unit)");
    expect(rowsOf(res)[0].medications).toBeNull();
  });

  it("setRls() changes policies mid-test; booleans and partial objects resolve against the table defaults", async () => {
    const fake = simpleFake();
    expect((await fake.from("categories").insert({ name: "New" })).error).toBeNull();
    fake.setRls("categories", { insert: false });
    expect(fake.options.rls.categories).toEqual({ select: true, insert: false, update: true, delete: true });
    expect((await fake.from("categories").insert({ name: "Newer" })).error?.code).toBe("42501");
    fake.setRls("categories", false);
    expect(rowsOf(await fake.from("categories").select("*"))).toEqual([]);
    fake.setRls("transactions", { insert: true });
    expect(fake.options.rls.transactions).toEqual({ select: true, insert: true, update: false, delete: false });
  });
});

// ═══════════════════════════════════ 7. constraints, defaults, triggers ═══════════════════════════════════

describe("constraints", () => {
  it("unique(barcode): 23505 with Postgres wording; state unchanged; also on UPDATE", async () => {
    const fake = createFakeSupabase();
    await fake.from("medications").insert({ barcode: "0012" });
    const dup = await fake.from("medications").insert({ barcode: "0012", name: "Other" });
    expect(dup).toMatchObject({
      status: 409,
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "medications_barcode_key"',
        details: "Key (barcode)=(0012) already exists.",
      },
    });
    const second = rowOf(await fake.from("medications").insert({ barcode: "0013" }).select().single());
    const clash = await fake.from("medications").update({ barcode: "0012" }).eq("id", second.id as number);
    expect(clash.error).toMatchObject({ code: "23505" });
    expect(fake.dump("medications").map((r) => r.barcode)).toEqual(["0012", "0013"]);
    // "0012" and "12" are different text values
    expect((await fake.from("medications").insert({ barcode: "12" })).error).toBeNull();
  });

  it("unique(categories.name) is case-SENSITIVE like Postgres, so the app must do its own case-insensitive check", async () => {
    const fake = createFakeSupabase();
    expect((await fake.from("categories").insert({ name: "Antibiotics" })).error).toBeNull();
    expect((await fake.from("categories").insert({ name: "antibiotics" })).error).toBeNull();
    const dup = await fake.from("categories").insert({ name: "Antibiotics" });
    expect(dup.error).toMatchObject({ code: "23505", message: 'duplicate key value violates unique constraint "categories_name_key"' });
  });

  it("a duplicate inside one multi-row insert fails the whole statement", async () => {
    const fake = createFakeSupabase();
    const res = await fake.from("medications").insert([{ barcode: "a" }, { barcode: "b" }, { barcode: "a" }]);
    expect(res.error?.code).toBe("23505");
    expect(fake.dump("medications")).toEqual([]);
  });

  it("FK medications.category_id -> categories.id: nonexistent category is 23503 on insert and update", async () => {
    const fake = createFakeSupabase({ categoryIdType: "uuid" });
    const ghost = "a0000000-0000-4000-8000-0000000000ff";
    const ins = await fake.from("medications").insert({ barcode: "m", category_id: ghost });
    expect(ins).toMatchObject({
      status: 409,
      error: {
        code: "23503",
        message: 'insert or update on table "medications" violates foreign key constraint "medications_category_id_fkey"',
        details: `Key (category_id)=(${ghost}) is not present in table "categories".`,
      },
    });
    const med = rowOf(await fake.from("medications").insert({ barcode: "m" }).select().single());
    const upd = await fake.from("medications").update({ category_id: ghost }).eq("id", med.id as number);
    expect(upd.error?.code).toBe("23503");
    expect(fake.dump("medications")[0].category_id).toBeNull();
  });

  it("deleting an in-use category is 23503 (no ON DELETE SET NULL on the live DB); fine once unused", async () => {
    const fake = simpleFake();
    const blocked = await fake.from("categories").delete().eq("id", 1);
    expect(blocked.error).toMatchObject({
      code: "23503",
      message: 'update or delete on table "categories" violates foreign key constraint "medications_category_id_fkey" on table "medications"',
      details: 'Key (id)=(1) is still referenced from table "medications".',
    });
    expect(fake.dump("categories")).toHaveLength(2);
    await fake.from("medications").update({ category_id: null }).in("id", [1, 2]);
    expect((await fake.from("categories").delete().eq("id", 1).select().single()).error).toBeNull();
    expect(fake.dump("categories")).toHaveLength(1);
  });

  it("categoryFkOnDelete: 'set-null' (supabase/schema.sql) nulls the references and bumps updated_at", async () => {
    const fake = simpleFake({ categoryFkOnDelete: "set-null" });
    const before = fake.dump("medications");
    expect((await fake.from("categories").delete().eq("id", 1)).error).toBeNull();
    const after = fake.dump("medications");
    expect(after.map((m) => m.category_id)).toEqual([null, null, null, 2]);
    expect(String(after[0].updated_at) > String(before[0].updated_at)).toBe(true);
    expect(after[3].updated_at).toBe(before[3].updated_at); // untouched row
  });

  it("transactions.medication_id: nonexistent medication is 23503; deleting a medication cascades", async () => {
    const fake = simpleFake({ rls: { transactions: true } });
    const ghost = await fake.from("transactions").insert({ medication_id: 999, type: "receive", quantity: 1 });
    expect(ghost.error).toMatchObject({ code: "23503" });
    fake.seedTransactions([
      { medication_id: 1, type: "receive", quantity: 1 },
      { medication_id: 2, type: "receive", quantity: 2 },
    ]);
    expect((await fake.from("medications").delete().eq("id", 1)).error).toBeNull();
    expect(fake.dump("transactions").map((t) => t.medication_id)).toEqual([2]);
  });

  it("NOT NULL: barcode is required; explicit null / NaN breaks a NOT NULL column but an omitted key uses the default", async () => {
    const fake = createFakeSupabase();
    expect((await fake.from("medications").insert({ name: "x" })).error).toMatchObject({
      code: "23502",
      message: 'null value in column "barcode" of relation "medications" violates not-null constraint',
    });
    expect((await fake.from("medications").insert({ barcode: "1", stock: null })).error?.code).toBe("23502");
    expect((await fake.from("medications").insert({ barcode: "1", stock: Number.NaN })).error?.code).toBe("23502"); // NaN -> null on the wire
    expect((await fake.from("medications").insert({ barcode: "1", unit: null })).error?.code).toBe("23502");
    expect((await fake.from("categories").insert({ name: null })).error?.code).toBe("23502");
    const ok = rowOf(await fake.from("medications").insert({ barcode: "1", stock: undefined, threshold: undefined }).select().single());
    expect(ok).toMatchObject({ stock: 0, threshold: 10, unit: "units", is_unnamed: false });
  });

  it("CHECK constraints on transactions (type, quantity > 0) are 23514 with Postgres' default constraint names", async () => {
    const fake = simpleFake({ rls: { transactions: true } });
    const type = await fake.from("transactions").insert({ medication_id: 1, type: "adjust", quantity: 1 });
    expect(type.error).toMatchObject({
      code: "23514",
      message: 'new row for relation "transactions" violates check constraint "transactions_type_check"',
    });
    const qty = await fake.from("transactions").insert({ medication_id: 1, type: "receive", quantity: 0 });
    expect(qty.error).toMatchObject({ code: "23514", message: expect.stringContaining('"transactions_quantity_check"') });
    expect((await fake.from("transactions").insert({ medication_id: 1, type: "receive", quantity: 1 })).error).toBeNull();
  });

  it("scalar column types: integer, boolean and timestamp input rules", async () => {
    const fake = createFakeSupabase();
    const ins = (extra: Row) => fake.from("medications").insert({ barcode: `b${fake.calls.length}`, ...extra });
    expect((await ins({ stock: "abc" })).error).toMatchObject({ code: "22P02", message: 'invalid input syntax for type integer: "abc"' });
    expect((await ins({ stock: 1.5 })).error).toMatchObject({ code: "22P02", message: 'invalid input syntax for type integer: "1.5"' });
    expect((await ins({ stock: 3000000000 })).error).toMatchObject({ code: "22003", message: 'value "3000000000" is out of range for type integer' });
    expect((await ins({ is_unnamed: "maybe" })).error).toMatchObject({ code: "22P02", message: 'invalid input syntax for type boolean: "maybe"' });
    expect((await ins({ created_at: "not a date" })).error).toMatchObject({ code: "22007" });
    expect((await ins({ created_at: "2026-02-30" })).error).toMatchObject({ code: "22007" });

    const ok = rowOf(await fake.from("medications").insert({ barcode: "ok", stock: "7", is_unnamed: "yes", created_at: "2026-11-05 10:30:00+02" }).select().single());
    expect(ok).toMatchObject({ stock: 7, is_unnamed: true, created_at: "2026-11-05T08:30:00+00:00" });
  });

  it("text columns store what they are given: numbers become text (no zero padding is invented, none is lost later)", async () => {
    const fake = createFakeSupabase();
    const row = rowOf(await fake.from("medications").insert({ barcode: 12345, name: true, notes: { a: 1 }, supplier_order_number: 92 }).select().single());
    expect(row).toMatchObject({ barcode: "12345", name: "true", notes: '{"a":1}', supplier_order_number: "92" });
    const kept = rowOf(await fake.from("medications").insert({ barcode: "x", supplier_order_number: "0092" }).select().single());
    expect(kept.supplier_order_number).toBe("0092");
  });

  it("text containing U+0000 is refused with 22P05 like Postgres/PostgREST on insert, update, upsert and rpc text arguments; seeding it is a setup error", async () => {
    const NUL = String.fromCharCode(0);
    const fake = simpleFake();
    const before = fake.dump("medications");
    const refused = {
      status: 400,
      error: { code: "22P05", message: "unsupported Unicode escape sequence", details: "\\u0000 cannot be converted to text." },
    };

    expect(await fake.from("medications").insert({ barcode: `a${NUL}b` })).toMatchObject(refused);
    expect(await fake.from("medications").insert({ barcode: "fine", notes: `x${NUL}` }).select()).toMatchObject(refused);
    expect(await fake.from("medications").update({ name: `Zinc${NUL}` }).eq("id", 3).select()).toMatchObject(refused);
    expect(await fake.from("medications").upsert({ barcode: "0100", name: `n${NUL}` }, { onConflict: "barcode" })).toMatchObject(refused);
    expect(await fake.from("categories").insert({ name: `${NUL}` })).toMatchObject(refused);
    const viaRpc = await fake.rpc("record_transaction", { p_medication_id: 1, p_type: "receive", p_quantity: 1, p_note: `n${NUL}` });
    expect(viaRpc).toMatchObject(refused);
    expect(fake.dump("transactions")).toEqual([]); // the rpc rolled back as a whole
    expect(fake.dump("medications")).toEqual(before);
    expect(fake.dump("categories")).toHaveLength(2);

    // seeding is strict about it too, with a readable message
    expect(() => fake.seedMedications([{ barcode: `s${NUL}` }])).toThrow(/22P05/);
    // a NUL inside a nested JSON value is only the six characters backslash-u-0-0-0-0 in its JSON text: storable
    const nested = rowOf(await fake.from("medications").insert({ barcode: "nested", notes: { a: `x${NUL}` } }).select().single());
    expect(nested.notes).toBe('{"a":"x\\u0000"}');
  });

  it("a lone UTF-16 surrogate is refused (22P02, invalid json) while a valid pair - an emoji - is stored as is", async () => {
    const fake = createFakeSupabase();
    for (const bad of ["\ud83d", "\ude00", "a\ud83db", "\ude00\ud83d"]) {
      const res = await fake.from("medications").insert({ barcode: bad });
      expect(res, JSON.stringify(bad)).toMatchObject({ status: 400, error: { code: "22P02", message: "invalid input syntax for type json" } });
    }
    expect(fake.dump("medications")).toEqual([]);
    const ok = rowOf(await fake.from("medications").insert({ barcode: "pill 💊 é" }).select().single());
    expect(ok.barcode).toBe("pill 💊 é");
  });

  it("payload keys that are not columns are PGRST204; an empty/invalid body is PGRST102", async () => {
    const fake = createFakeSupabase();
    expect(await fake.from("medications").insert({ barcode: "1", bogus: 1 })).toMatchObject({
      status: 400,
      error: { code: "PGRST204", message: "Could not find the 'bogus' column of 'medications' in the schema cache" },
    });
    expect((await fake.from("medications").insert(null)).error?.code).toBe("PGRST102");
    expect((await fake.from("medications").update([{ name: "x" }]).eq("id", 1)).error?.code).toBe("PGRST102");
    expect(await fake.from("medications").insert([])).toMatchObject({ error: null });
  });

  it("pg_safeupdate: UPDATE or DELETE without any filter is refused (21000) and nothing changes", async () => {
    const fake = simpleFake();
    const before = fake.dump("medications");
    expect((await fake.from("medications").update({ stock: 0 })).error).toMatchObject({ code: "21000", message: "UPDATE requires a WHERE clause" });
    expect((await fake.from("medications").delete()).error).toMatchObject({ code: "21000", message: "DELETE requires a WHERE clause" });
    expect(fake.dump("medications")).toEqual(before);
  });

  it("bulk insert with different keys: missing columns become NULL (NOT NULL ones fail) unless defaultToNull is false", async () => {
    const fake = createFakeSupabase();
    const res = await fake.from("medications").insert([{ barcode: "h1", stock: 5 }, { barcode: "h2" }]);
    expect(res.error).toMatchObject({ code: "23502", message: expect.stringContaining('"stock"') });
    expect(fake.dump("medications")).toEqual([]);
    const ok = await fake.from("medications").insert([{ barcode: "h1", stock: 5 }, { barcode: "h2" }], { defaultToNull: false }).select();
    expect(rowsOf(ok).map((r) => r.stock)).toEqual([5, 0]);
    // a single object never sees this: omitted keys always take the column default
    expect(rowOf(await fake.from("medications").insert({ barcode: "h3" }).select().single()).stock).toBe(0);
  });

  it("count on mutations is the number of affected rows; update/delete without .select() answer 204", async () => {
    const fake = simpleFake();
    const upd = await fake.from("medications").update({ notes: "x" }, { count: "exact" }).eq("category_id", 1);
    expect(upd).toMatchObject({ data: null, error: null, count: 2, status: 204 });
    const del = await fake.from("medications").delete({ count: "exact" }).in("id", [1, 3]);
    expect(del).toMatchObject({ data: null, error: null, count: 2, status: 204 });
    const ins = await fake.from("medications").insert([{ barcode: "c1" }, { barcode: "c2" }], { count: "exact" });
    expect(ins).toMatchObject({ data: null, error: null, count: 2, status: 201 });
  });

  it("an update with no columns ({} or only undefined values, which JSON drops) matches no rows, like PostgREST's SELECT .. WHERE false (assumed)", async () => {
    const fake = simpleFake();
    const before = fake.dump("medications");

    expect(await fake.from("medications").update({}).eq("id", 1).select()).toMatchObject({ data: [], error: null, status: 200 });
    expect(await fake.from("medications").update({ name: undefined, stock: undefined }).eq("id", 1).select()).toMatchObject({ data: [], error: null });
    expect(await fake.from("medications").update({}).eq("id", 1)).toMatchObject({ data: null, error: null, status: 204 });
    // so the app's update().eq().select().single() sees "no row" (PGRST116 -> its 404), exactly as it would in production
    expect((await fake.from("medications").update({}).eq("id", 1).select().single()).error).toMatchObject({
      code: "PGRST116",
      details: "The result contains 0 rows",
    });
    expect(await fake.from("medications").update({}, { count: "exact" }).eq("id", 1)).toMatchObject({ count: 0 });
    expect(fake.dump("medications")).toEqual(before); // nothing changed, not even updated_at

    // everything around it is unchanged: a bad payload is still refused, a real patch still updates
    expect((await fake.from("medications").update({ bogus: 1 }).eq("id", 1)).error).toMatchObject({ code: "PGRST204" });
    expect((await fake.from("medications").update([]).eq("id", 1)).error).toMatchObject({ code: "PGRST102" });
    expect(rowsOf(await fake.from("medications").update({ name: "Renamed" }).eq("id", 1).select()).map((r) => r.name)).toEqual(["Renamed"]);
  });

  it("limit()/range() on a mutation is refused loudly instead of being ignored", async () => {
    const fake = simpleFake();
    await expect(Promise.resolve(fake.from("medications").update({ stock: 0 }).eq("id", 1).limit(1))).rejects.toThrow(/not implemented/);
  });
});

describe("updated_at trigger, timestamps and sequences", () => {
  it("every UPDATE bumps updated_at (even a no-op), never created_at, and the trigger overrides a supplied value", async () => {
    const fake = createFakeSupabase({ now: () => new Date("2026-11-05T12:00:00.000Z") }); // frozen clock
    const created = rowOf(await fake.from("medications").insert({ barcode: "m", name: "A" }).select().single());
    expect(created.created_at).toBe("2026-11-05T12:00:00+00:00");

    const same = rowOf(await fake.from("medications").update({ name: "A" }).eq("id", 1).select().single());
    expect(same.created_at).toBe(created.created_at);
    expect(same.updated_at).not.toBe(created.updated_at);
    expect(String(same.updated_at) > String(created.updated_at)).toBe(true);

    const forced = rowOf(await fake.from("medications").update({ updated_at: "2001-01-01T00:00:00Z" }).eq("id", 1).select().single());
    expect(String(forced.updated_at) > String(same.updated_at)).toBe(true);
  });

  it("categories have no updated_at trigger; upsert's update path bumps medications.updated_at", async () => {
    const fake = simpleFake();
    const before = fake.dump("medications")[0];
    await fake.from("medications").upsert({ barcode: "0100", stock: 6 }, { onConflict: "barcode" });
    expect(String(fake.dump("medications")[0].updated_at) > String(before.updated_at)).toBe(true);
  });

  it("ids come from a sequence: a failed insert burns a value (gap), explicit ids do not advance it, seeding does", async () => {
    const fake = createFakeSupabase();
    const id = async (barcode: string) => rowOf(await fake.from("medications").insert({ barcode }).select().single()).id;
    expect(await id("a")).toBe(1);
    expect(await id("b")).toBe(2);
    expect((await fake.from("medications").insert({ barcode: "a" })).error?.code).toBe("23505"); // consumes 3
    expect(await id("c")).toBe(4);

    const seeded = createFakeSupabase();
    seeded.seedMedications([{ id: 100, barcode: "s" }]);
    expect(rowOf(await seeded.from("medications").insert({ barcode: "t" }).select().single()).id).toBe(101);

    const explicit = createFakeSupabase();
    await explicit.from("medications").insert({ id: 2, barcode: "e1" });
    await explicit.from("medications").insert({ barcode: "e2" }); // takes 1
    expect((await explicit.from("medications").insert({ barcode: "e3" })).error?.code).toBe("23505"); // wants 2: collides
  });

  it("timestamps use PostgREST's format and are strictly increasing between statements", async () => {
    const fake = createFakeSupabase();
    const a = rowOf(await fake.from("medications").insert({ barcode: "a" }).select().single());
    const b = rowOf(await fake.from("medications").insert({ barcode: "b" }).select().single());
    expect(a.created_at).toMatch(TS_RE);
    expect(Date.parse(String(b.created_at))).toBeGreaterThan(Date.parse(String(a.created_at)));
  });
});

// ═══════════════════════════════════ 8. supplier_order_number column ═══════════════════════════════════

describe("supplier_order_number (hasSupplierColumn)", () => {
  it("false (pre-migration): any write that mentions the column is PGRST204, nothing is stored", async () => {
    const fake = simpleFake({ hasSupplierColumn: false });
    const msg = "Could not find the 'supplier_order_number' column of 'medications' in the schema cache";
    expect(await fake.from("medications").insert({ barcode: "n", supplier_order_number: "00417-B" })).toMatchObject({ status: 400, error: { code: "PGRST204", message: msg } });
    expect((await fake.from("medications").insert({ barcode: "n", supplier_order_number: null })).error).toMatchObject({ code: "PGRST204", message: msg });
    expect((await fake.from("medications").update({ supplier_order_number: "x" }).eq("id", 1)).error).toMatchObject({ code: "PGRST204", message: msg });
    expect((await fake.from("medications").upsert({ barcode: "0100", supplier_order_number: "x" }, { onConflict: "barcode" })).error).toMatchObject({ code: "PGRST204" });
    expect(fake.dump("medications")).toHaveLength(4);
  });

  it("false: `undefined` is dropped by JSON, so a payload that merely carries the key as undefined still works", async () => {
    const fake = simpleFake({ hasSupplierColumn: false });
    const res = await fake.from("medications").insert({ barcode: "n", name: "ok", supplier_order_number: undefined }).select().single();
    expect(res.error).toBeNull();
    expect("supplier_order_number" in rowOf(res)).toBe(false);
  });

  it("false: naming the column in a select list, filter or order is 42703; select('*') silently omits it", async () => {
    const fake = simpleFake({ hasSupplierColumn: false });
    const msg = "column medications.supplier_order_number does not exist";
    expect(await fake.from("medications").select("id, supplier_order_number")).toMatchObject({ status: 400, error: { code: "42703", message: msg } });
    expect((await fake.from("medications").select("*").eq("supplier_order_number", "x")).error).toMatchObject({ code: "42703", message: msg });
    expect((await fake.from("medications").select("*").order("supplier_order_number")).error).toMatchObject({ code: "42703", message: msg });
    expect((await fake.from("transactions").select("*, medications(name, supplier_order_number)")).error).toMatchObject({ code: "42703" });
    const star = rowsOf(await fake.from("medications").select("*"));
    expect(star).toHaveLength(4);
    expect("supplier_order_number" in star[0]).toBe(false);
  });

  it("false: seeding a supplier code is a test-setup error, and the rpc result has no such key", async () => {
    const fake = createFakeSupabase({ hasSupplierColumn: false });
    expect(() => fake.seedMedications([{ barcode: "x", supplier_order_number: "A1" }])).toThrow(/PGRST204/);
    fake.seedMedications([{ id: 1, barcode: "x", stock: 3, supplier_order_number: null }]);
    const rpc = await fake.rpc("record_transaction", { p_medication_id: 1, p_type: "receive", p_quantity: 1 });
    expect("supplier_order_number" in rowsOf(rpc)[0]).toBe(false);
  });

  it("true: nullable text that keeps leading zeros, letters and punctuation exactly; selectable by name", async () => {
    const fake = createFakeSupabase({ hasSupplierColumn: true });
    for (const code of ["00417-B", "0092", "AX-1182/4", "1E5", "12345678901234567890", "2026-11-05", "=1+1", "NÅ-00ß"]) {
      const row = rowOf(await fake.from("medications").insert({ barcode: `bc-${code}`, supplier_order_number: code }).select("id, supplier_order_number").single());
      expect(row.supplier_order_number).toBe(code);
    }
    const unset = rowOf(await fake.from("medications").insert({ barcode: "unset" }).select().single());
    expect(unset.supplier_order_number).toBeNull();
    const found = rowsOf(await fake.from("medications").select("barcode").eq("supplier_order_number", "0092"));
    expect(found).toEqual([{ barcode: "bc-0092" }]);
    expect(rowsOf(await fake.from("medications").select("barcode").eq("supplier_order_number", "92"))).toEqual([]);
  });
});

// ═══════════════════════════════════ 9. rpc record_transaction ═══════════════════════════════════

describe("rpc('record_transaction')", () => {
  let fake: FakeSupabase;
  beforeEach(() => {
    fake = createFakeSupabase({ categoryIdType: "bigint" });
    fake.seedMedications([{ id: 1, barcode: "m1", name: "Item", stock: 10, threshold: 4 }]);
  });
  const call = (args: Record<string, unknown>) => fake.rpc("record_transaction", args);

  it("receive and dispense: returns the medications row as an ARRAY, writes the transaction, bumps updated_at", async () => {
    const before = fake.dump("medications")[0];
    const res = await call({ p_medication_id: 1, p_type: "dispense", p_quantity: 4, p_note: "front desk" });
    expect(res.error).toBeNull();
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    expect(rowsOf(res)).toHaveLength(1);
    expect(rowsOf(res)[0]).toMatchObject({ id: 1, stock: 6, barcode: "m1" });
    expect(fake.dump("transactions")).toEqual([
      { id: 1, medication_id: 1, type: "dispense", quantity: 4, note: "front desk", created_at: expect.stringMatching(TS_RE) },
    ]);
    expect(String(fake.dump("medications")[0].updated_at) > String(before.updated_at)).toBe(true);

    const recv = await call({ p_medication_id: 1, p_type: "receive", p_quantity: 5 });
    expect(rowsOf(recv)[0].stock).toBe(11);
    expect(fake.dump("transactions")[1].note).toBeNull(); // p_note defaults to NULL
  });

  it("dispensing exactly the stock is allowed; one more is 'Insufficient stock. Current stock: N' (P0001) and writes nothing", async () => {
    const fail = await call({ p_medication_id: 1, p_type: "dispense", p_quantity: 11 });
    expect(fail).toMatchObject({ data: null, status: 400, error: { code: "P0001", message: "Insufficient stock. Current stock: 10" } });
    expect(fake.dump("transactions")).toEqual([]);
    expect(fake.dump("medications")[0].stock).toBe(10);
    expect(rowsOf(await call({ p_medication_id: 1, p_type: "dispense", p_quantity: 10 }))[0].stock).toBe(0);
  });

  it("unknown id, NaN id (-> JSON null) -> 'Medication not found'; a non-numeric string is 22P02", async () => {
    expect((await call({ p_medication_id: 99, p_type: "receive", p_quantity: 1 })).error).toMatchObject({ code: "P0001", message: "Medication not found" });
    expect((await call({ p_medication_id: Number("abc"), p_type: "receive", p_quantity: 1 })).error?.message).toBe("Medication not found");
    expect((await call({ p_medication_id: "abc", p_type: "receive", p_quantity: 1 })).error).toMatchObject({
      code: "22P02",
      message: 'invalid input syntax for type bigint: "abc"',
    });
    expect(rowsOf(await call({ p_medication_id: "1", p_type: "receive", p_quantity: "2" }))[0].stock).toBe(12); // numeric strings are fine
  });

  it("any type other than receive/dispense fails the CHECK and the WHOLE function rolls back", async () => {
    const res = await call({ p_medication_id: 1, p_type: "adjust", p_quantity: 3 });
    expect(res.error).toMatchObject({
      code: "23514",
      message: 'new row for relation "transactions" violates check constraint "transactions_type_check"',
    });
    expect(fake.dump("medications")[0].stock).toBe(10);
    expect(fake.dump("transactions")).toEqual([]);
  });

  it("quantity must be a positive integer: 0 / negative -> CHECK 23514, 1.5 -> 22P02, NaN/null -> NOT NULL 23502", async () => {
    expect((await call({ p_medication_id: 1, p_type: "receive", p_quantity: 0 })).error).toMatchObject({ code: "23514" });
    expect((await call({ p_medication_id: 1, p_type: "receive", p_quantity: -2 })).error).toMatchObject({ code: "23514" });
    expect((await call({ p_medication_id: 1, p_type: "dispense", p_quantity: -2 })).error).toMatchObject({ code: "23514" });
    expect((await call({ p_medication_id: 1, p_type: "receive", p_quantity: 1.5 })).error).toMatchObject({ code: "22P02" });
    expect((await call({ p_medication_id: 1, p_type: "receive", p_quantity: Number.NaN })).error).toMatchObject({ code: "23502" });
    expect(fake.dump("transactions")).toEqual([]);
    expect(fake.dump("medications")[0].stock).toBe(10);
  });

  it("the integer column cannot overflow: 22003 'integer out of range'", async () => {
    fake.seedMedications([{ id: 2, barcode: "m2", stock: 2147483647 }]);
    expect((await call({ p_medication_id: 2, p_type: "receive", p_quantity: 1 })).error).toMatchObject({ code: "22003", message: "integer out of range" });
  });

  it("argument names are matched like PostgREST: missing / extra / unknown function -> PGRST202 (404)", async () => {
    const missing = await call({ p_medication_id: 1, p_quantity: 1 });
    expect(missing).toMatchObject({
      status: 404,
      error: { code: "PGRST202", message: "Could not find the function public.record_transaction(p_medication_id, p_quantity) in the schema cache" },
    });
    expect((await call({ p_medication_id: 1, p_type: "receive", p_quantity: 1, p_extra: 1 })).error?.code).toBe("PGRST202");
    expect((await fake.rpc("nope", {})).error).toMatchObject({ code: "PGRST202", message: "Could not find the function public.nope() in the schema cache" });
  });

  it("result chaining works like any builder: .single() gives the object", async () => {
    const res = await call({ p_medication_id: 1, p_type: "receive", p_quantity: 1 }).single();
    expect(Array.isArray(res.data)).toBe(false);
    expect(rowOf(res).stock).toBe(11);
  });

  it("is recorded as a write with the JSON wire args", async () => {
    await call({ p_medication_id: Number.NaN, p_type: "receive", p_quantity: 1, p_note: undefined });
    expect(fake.writes()).toHaveLength(1);
    expect(fake.writes()[0]).toMatchObject({ op: "rpc", fn: "record_transaction", table: null, payload: { p_medication_id: null, p_type: "receive", p_quantity: 1 } });
    expect(fake.callsFor("record_transaction")).toHaveLength(1);
  });
});

// ═══════════════════════════════════ 10. embedded select ═══════════════════════════════════

describe("embedded resources", () => {
  let fake: FakeSupabase;
  beforeEach(() => {
    fake = simpleFake();
    fake.seedTransactions([
      { medication_id: 1, type: "receive", quantity: 3, created_at: "2026-11-01T10:00:00+00:00" },
      { medication_id: 1, type: "dispense", quantity: 1, created_at: "2026-11-02T10:00:00+00:00" },
      { medication_id: 2, type: "receive", quantity: 9, created_at: "2026-11-03T10:00:00+00:00" },
    ]);
  });

  it("'*, medications(name, unit)' on transactions (the shape /api/transactions uses)", async () => {
    const res = await fake.from("transactions").select("*, medications(name, unit)").eq("medication_id", 1).order("created_at", { ascending: false }).limit(100);
    const rows = rowsOf(res);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: 2,
      medication_id: 1,
      type: "dispense",
      quantity: 1,
      note: null,
      created_at: "2026-11-02T10:00:00+00:00",
      medications: { name: "Amoxicillin", unit: "units" },
    });
  });

  it("to-many, to-one, nested stars, aliases and !inner", async () => {
    const meds = rowsOf(await fake.from("medications").select("name, transactions(quantity), categories(name)").order("id"));
    expect(meds[0]).toEqual({ name: "Amoxicillin", transactions: [{ quantity: 3 }, { quantity: 1 }], categories: { name: "Antibiotics" } });
    expect(meds[2]).toEqual({ name: "Zinc", transactions: [], categories: null });

    const inner = rowsOf(await fake.from("medications").select("name, categories!inner(name)").order("id"));
    expect(inner.map((r) => r.name)).toEqual(["Amoxicillin", "ibuprofen", null]);

    const aliased = rowsOf(await fake.from("transactions").select("qty:quantity, med:medications(*)").eq("id", 3));
    expect(aliased[0].qty).toBe(9);
    expect(aliased[0].med).toMatchObject({ id: 2, barcode: "0200" });
  });

  it("unknown relation -> PGRST200; select casts are not supported (loud error instead of silent misbehaviour)", async () => {
    const res = await fake.from("transactions").select("*, foo(name)");
    expect(res).toMatchObject({ status: 400, error: { code: "PGRST200", message: "Could not find a relationship between 'transactions' and 'foo' in the schema cache" } });
    await expect(Promise.resolve(fake.from("transactions").select("id::text"))).rejects.toThrow(/not implemented/);
  });
});

// ═══════════════════════════════════ 11. upsert ═══════════════════════════════════

describe("upsert", () => {
  it("merge-duplicates updates only the columns in the payload (category and supplier survive) and inserts the rest", async () => {
    const fake = simpleFake();
    const before = fake.dump("medications")[0];
    const res = await fake
      .from("medications")
      .upsert(
        [
          { name: "Amoxicillin 500", barcode: "0100", stock: 9, threshold: 3, unit: "box", vendor_url: null, notes: null },
          { name: "Brand new", barcode: "0999", stock: 1, threshold: 2, unit: "units", vendor_url: null, notes: null },
        ],
        { onConflict: "barcode", count: "exact" }
      )
      .select();
    expect(res.status).toBe(201);
    expect(res.count).toBe(2);
    const after = fake.dump("medications");
    expect(after).toHaveLength(5);
    expect(after[0]).toMatchObject({ id: 1, name: "Amoxicillin 500", stock: 9, unit: "box", category_id: 1, supplier_order_number: "00417-B" });
    expect(after[0].created_at).toBe(before.created_at);
    expect(String(after[0].updated_at) > String(before.updated_at)).toBe(true);
    // id 6, not 5: like Postgres, ON CONFLICT evaluates the nextval() default for the proposed row of the conflicting
    // barcode before it detects the conflict, so that sequence value is burnt.
    expect(after[4]).toMatchObject({ id: 6, barcode: "0999", category_id: null, is_unnamed: false });
  });

  it("two proposed rows with the same conflict key -> 21000 'cannot affect row a second time' (a CSV with duplicate barcodes)", async () => {
    const fake = simpleFake();
    const res = await fake.from("medications").upsert([{ barcode: "0100", stock: 1 }, { barcode: "0100", stock: 2 }], { onConflict: "barcode" });
    expect(res.error).toMatchObject({ code: "21000", message: "ON CONFLICT DO UPDATE command cannot affect row a second time" });
    expect(fake.dump("medications")[0].stock).toBe(5);
    const fresh = await fake.from("medications").upsert([{ barcode: "zz", stock: 1 }, { barcode: "zz", stock: 2 }], { onConflict: "barcode" });
    expect(fresh.error?.code).toBe("21000");
    expect(fake.dump("medications")).toHaveLength(4);
  });

  it("ignoreDuplicates leaves existing rows alone and inserts new ones", async () => {
    const fake = simpleFake();
    const res = await fake.from("medications").upsert([{ barcode: "0100", stock: 99 }, { barcode: "new1", stock: 1 }], { onConflict: "barcode", ignoreDuplicates: true }).select();
    expect(rowsOf(res).map((r) => r.barcode)).toEqual(["new1"]);
    expect(fake.dump("medications")[0].stock).toBe(5);
  });

  it("ignoreDuplicates also tolerates a repeated key inside the payload (first one wins, no error)", async () => {
    const fake = simpleFake();
    const res = await fake.from("medications").upsert([{ barcode: "r1", stock: 1 }, { barcode: "r1", stock: 2 }], { onConflict: "barcode", ignoreDuplicates: true }).select();
    expect(res.error).toBeNull();
    expect(rowsOf(res).map((r) => r.stock)).toEqual([1]);
  });

  it("conflict target must be a unique column (42P10); the default target is the primary key", async () => {
    const fake = simpleFake();
    expect((await fake.from("medications").upsert({ barcode: "x", name: "n" }, { onConflict: "name" })).error?.code).toBe("42P10");
    await fake.from("medications").upsert({ id: 2, barcode: "0200", stock: 1 });
    expect(fake.dump("medications")[1].stock).toBe(1);
  });

  it("rows with different keys: the missing columns are filled with NULL (and overwrite) unless defaultToNull is false", async () => {
    const fake = simpleFake();
    await fake.from("medications").upsert([{ barcode: "0100", notes: "n1" }, { barcode: "new", name: "N" }], { onConflict: "barcode" });
    // 'name' is in the column union, so row 1's missing name is written as NULL (PostgREST behaviour)
    expect(fake.dump("medications")[0]).toMatchObject({ name: null, notes: "n1" });

    const keep = simpleFake();
    await keep.from("medications").upsert([{ barcode: "0100", notes: "n1" }, { barcode: "new", name: "N" }], { onConflict: "barcode", defaultToNull: false });
    // missing -> column DEFAULT (NULL for name): still null; for stock the default 0 would apply on insert paths
    expect(keep.dump("medications")[4]).toMatchObject({ stock: 0, threshold: 10 });
  });
});

// ═══════════════════════════════════ 12. failure injection & call log ═══════════════════════════════════

describe("failure injection", () => {
  it("failNext: the next call resolves { data: null, error }, state is untouched, and later calls succeed", async () => {
    const fake = simpleFake();
    fake.failNext(FETCH_FAILED);
    const res = await fake.from("medications").update({ name: "X" }).eq("id", 1).select();
    expect(res).toMatchObject({
      success: false,
      data: null,
      count: null,
      status: 0,
      error: { code: "", message: "TypeError: fetch failed", details: null, hint: null },
    });
    expect(fake.dump("medications")[0].name).toBe("Amoxicillin");
    expect(rowsOf(await fake.from("medications").select("id"))).toHaveLength(4);
    expect(fake.calls[0].injected).toBe(true);
    expect(fake.calls[0].result?.error?.message).toBe("TypeError: fetch failed");
    expect(fake.calls[1].injected).toBe(false);
  });

  it("failNext queues (FIFO); a matcher only consumes a matching call (table / op / fn / bucket)", async () => {
    const fake = simpleFake();
    fake.failNext({ code: "XX001", message: "first" }, { table: "medications", op: "update" });
    fake.failNext({ code: "XX002", message: "second" }, { fn: "record_transaction" });
    expect(rowsOf(await fake.from("medications").select("id"))).toHaveLength(4); // not matched
    expect((await fake.from("categories").update({ name: "z" }).eq("id", 1)).error).toBeNull(); // wrong table
    expect((await fake.from("medications").update({ name: "z" }).eq("id", 1)).error?.message).toBe("first");
    expect((await fake.from("medications").update({ name: "z" }).eq("id", 1)).error).toBeNull(); // consumed
    expect((await fake.rpc("record_transaction", { p_medication_id: 1, p_type: "receive", p_quantity: 1 })).error?.message).toBe("second");
    fake.failNext(FETCH_FAILED, { op: ["insert", "upsert"] });
    expect((await fake.from("medications").insert({ barcode: "q" })).error?.message).toBe("TypeError: fetch failed");
    fake.failNext({ message: "storage down" }, { bucket: "medication-photos" });
    expect((await fake.storage.from("medication-photos").upload("a.png", new Uint8Array([1]))).error?.message).toBe("storage down");
  });

  it("failAll keeps failing until clearFailures(); queued failNext entries win first", async () => {
    const fake = simpleFake();
    fake.failAll({ code: "57014", message: "canceling statement due to statement timeout" });
    fake.failNext({ code: "XX000", message: "once" });
    expect((await fake.from("medications").select("*")).error?.message).toBe("once");
    expect((await fake.from("medications").select("*")).error?.code).toBe("57014");
    expect((await fake.from("categories").select("*")).error?.code).toBe("57014");
    fake.clearFailures();
    expect((await fake.from("medications").select("*")).error).toBeNull();
  });

  it("failAll with a matcher fails only matching calls", async () => {
    const fake = simpleFake();
    fake.failAll(FETCH_FAILED, { table: "transactions" });
    expect((await fake.from("transactions").select("*")).error?.message).toBe("TypeError: fetch failed");
    expect((await fake.from("medications").select("*")).error).toBeNull();
  });
});

describe("call log", () => {
  it("records table, op, filters, wire payload, select list, order, window, single and count for every awaited call", async () => {
    const fake = simpleFake();
    await fake.from("medications").update({ category_id: Number.NaN, name: undefined, stock: 3 }).eq("id", 1).select("id, stock").single();
    await fake.from("medications").select("*", { count: "exact" }).eq("category_id", 1).order("name", { nullsFirst: false }).range(5, 9);
    const [upd, sel] = fake.calls;
    expect(upd).toMatchObject({
      seq: 1,
      op: "update",
      table: "medications",
      payload: { category_id: null, stock: 3 }, // NaN -> null, undefined dropped
      select: "id,stock",
      returning: true,
      single: "single",
      fn: null,
      bucket: null,
      injected: false,
      result: { status: 200, error: null, rows: 1 },
    });
    expect("name" in (upd.payload as Row)).toBe(false);
    expect(upd.filters).toEqual([{ column: "id", expr: "eq.1", operator: "eq", value: 1 }]);
    expect(sel).toMatchObject({
      seq: 2,
      op: "select",
      select: "*",
      count: "exact",
      offset: 5,
      limit: 5,
      order: [{ column: "name", ascending: true, nullsFirst: false }],
      payload: undefined,
    });
  });

  it("callsFor() filters by table, rpc name or bucket; writes() lists attempted mutations only", async () => {
    const fake = simpleFake();
    await fake.from("medications").select("*");
    await fake.from("categories").select("*");
    await fake.from("medications").insert({ barcode: "dup-check" });
    await fake.from("medications").insert({ barcode: "dup-check" }); // fails but is still an attempted write
    await fake.from("medications").update({ stock: 1 }).eq("id", 1);
    await fake.from("medications").upsert({ barcode: "u" }, { onConflict: "barcode" });
    await fake.from("medications").delete().eq("id", 3);
    await fake.rpc("record_transaction", { p_medication_id: 1, p_type: "receive", p_quantity: 1 });
    await fake.storage.from("medication-photos").upload("p.png", new Uint8Array([1, 2]), { contentType: "image/png" });
    expect(fake.callsFor("medications")).toHaveLength(6);
    expect(fake.callsFor("categories")).toHaveLength(1);
    expect(fake.callsFor("record_transaction")).toHaveLength(1);
    expect(fake.callsFor("medication-photos")).toHaveLength(1);
    expect(fake.writes().map((c) => c.op)).toEqual(["insert", "insert", "update", "upsert", "delete", "rpc", "storage.upload"]);
  });

  it("a read-only flow leaves writes() empty; clearCalls() empties the SAME array in place", async () => {
    const fake = simpleFake();
    const live = fake.calls;
    await fake.from("medications").select("*");
    await fake.from("medications").select("*").in("id", [1, 2]);
    expect(fake.writes()).toHaveLength(0);
    expect(live).toHaveLength(2);
    fake.clearCalls();
    expect(live).toHaveLength(0);
    expect(fake.calls).toBe(live);
  });
});

describe("onCall hooks (run code at the Nth call)", () => {
  it("runs once per awaited call, after it is logged and before it executes, with the recorded call and its index in fake.calls", async () => {
    const fake = simpleFake();
    const seen: Array<{ op: string; index: number; isLogged: boolean; resultSoFar: unknown; medicationRows: number }> = [];
    fake.onCall((call, index) => {
      seen.push({
        op: call.op,
        index,
        isLogged: fake.calls[index] === call,
        resultSoFar: call.result, // not executed yet
        medicationRows: fake.dump("medications").length,
      });
    });

    fake.from("medications").select("id"); // built, never awaited: sends nothing, so no hook
    await fake.from("medications").select("id");
    await fake.from("medications").insert({ barcode: "h1" }); // the hook sees the table BEFORE this insert
    await fake.rpc("record_transaction", { p_medication_id: 1, p_type: "receive", p_quantity: 1 });
    await fake.storage.from("medication-photos").upload("p.png", new Uint8Array([1]));

    expect(seen).toEqual([
      { op: "select", index: 0, isLogged: true, resultSoFar: null, medicationRows: 4 },
      { op: "insert", index: 1, isLogged: true, resultSoFar: null, medicationRows: 4 },
      { op: "rpc", index: 2, isLogged: true, resultSoFar: null, medicationRows: 5 },
      { op: "storage.upload", index: 3, isLogged: true, resultSoFar: null, medicationRows: 5 },
    ]);
    expect(fake.calls[1].result).toMatchObject({ status: 201, error: null }); // and it did run afterwards
  });

  it("the index is the position in fake.calls, so it starts again after clearCalls(); hooks run in registration order", async () => {
    const fake = simpleFake();
    const order: string[] = [];
    fake.onCall((_call, index) => order.push(`first:${index}`));
    fake.onCall((_call, index) => order.push(`second:${index}`));
    await fake.from("medications").select("id");
    await fake.from("medications").select("id");
    fake.clearCalls();
    await fake.from("medications").select("id");
    expect(order).toEqual(["first:0", "second:0", "first:1", "second:1", "first:0", "second:0"]);
  });

  it("the function onCall returns removes that hook; clearHooks() removes all of them", async () => {
    const fake = simpleFake();
    const a: number[] = [];
    const b: number[] = [];
    const removeA = fake.onCall((_c, i) => a.push(i));
    fake.onCall((_c, i) => b.push(i));
    await fake.from("medications").select("id");
    removeA();
    removeA(); // idempotent
    await fake.from("medications").select("id");
    fake.clearHooks();
    await fake.from("medications").select("id");
    expect({ a, b }).toEqual({ a: [0], b: [0, 1] });
  });

  it("a hook can remove itself (or add another) while hooks are running without skipping anyone", async () => {
    const fake = simpleFake();
    const log: string[] = [];
    const removeOnce = fake.onCall(() => {
      log.push("once");
      removeOnce();
    });
    fake.onCall(() => log.push("always"));
    await fake.from("medications").select("id");
    await fake.from("medications").select("id");
    expect(log).toEqual(["once", "always", "always"]);
  });

  it("an error thrown by a hook rejects the awaited call, the call is not executed, and later calls are fine", async () => {
    const fake = simpleFake();
    const remove = fake.onCall((call) => {
      if (call.op === "insert") throw new Error("hook says no");
    });
    await expect(Promise.resolve(fake.from("medications").insert({ barcode: "h2" }))).rejects.toThrow("hook says no");
    expect(fake.dump("medications")).toHaveLength(4);
    expect(fake.calls).toHaveLength(1); // logged, but never answered
    expect(fake.calls[0].result).toBeNull();
    remove();
    expect((await fake.from("medications").insert({ barcode: "h2" })).error).toBeNull();
  });

  it("a hook runs before failure injection, so it may queue failNext() for the very call it is looking at", async () => {
    const fake = simpleFake();
    fake.onCall((call) => {
      if (call.op === "update") fake.failNext({ code: "57014", message: "canceling statement due to statement timeout" });
    });
    const res = await fake.from("medications").update({ name: "X" }).eq("id", 1).select();
    expect(res.error).toMatchObject({ code: "57014" });
    expect(fake.calls[0].injected).toBe(true);
    expect(fake.dump("medications")[0].name).toBe("Amoxicillin");
    expect((await fake.from("medications").select("id")).error).toBeNull(); // the queued failure was consumed
  });

  it("scenario - the check-then-insert race: a competing row is seeded just before the insert runs, so the fake's own unique constraint answers 23505", async () => {
    const fake = createFakeSupabase();
    fake.onCall((call) => {
      if (call.op === "insert" && call.table === "categories") fake.seedCategories([{ name: "Splints" }]);
    });
    expect(rowsOf(await fake.from("categories").select("id").ilike("name", "splints"))).toEqual([]); // the pre-check finds nothing
    const res = await fake.from("categories").insert({ name: "Splints" }).select().single();
    expect(res.error).toMatchObject({ code: "23505", message: 'duplicate key value violates unique constraint "categories_name_key"' });
    expect(fake.calls.at(-1)?.injected).toBe(false); // a real constraint violation, not a canned error
    expect(fake.dump("categories")).toHaveLength(1);
    expect(rowOf(await fake.from("categories").select("*").eq("name", "Splints").single()).name).toBe("Splints"); // the winner is readable
  });

  it("scenario - rows shifting between pages: an offset page repeats the last row of the previous page when a row sorting first arrives in between", async () => {
    const fake = createFakeSupabase({ maxRows: 1000 });
    fake.seedMedications(Array.from({ length: 1500 }, (_, i) => ({ id: i + 1, barcode: `B${i + 1}`, name: `Item ${String(i + 1).padStart(4, "0")}` })));
    const page = async (from: number): Promise<Row[]> =>
      rowsOf(await fake.from("medications").select("id, name").order("name").range(from, from + 999));
    let selects = 0;
    fake.onCall((call) => {
      if (call.op === "select" && ++selects === 2) fake.seedMedications([{ id: 9001, barcode: "AAA", name: "AAA arrived between pages" }]);
    });
    const first = await page(0);
    const second = await page(1000); // the hook ran just before this one
    expect(first).toHaveLength(1000);
    expect(second).toHaveLength(501); // 1501 rows now
    expect(second[0]).toEqual(first[999]); // the same row twice
    expect(first.some((r) => r.id === 9001)).toBe(false); // and the newcomer was on neither page
    expect(second.some((r) => r.id === 9001)).toBe(false);
  });
});

// ═══════════════════════════════════ 13. seeding & dump ═══════════════════════════════════

describe("seeding and dump", () => {
  it("seeds the standard fixtures in both id shapes; dump() shows what the database holds (uuid strings vs bigint numbers)", () => {
    const uuid = standardFake({ categoryIdType: "uuid" });
    expect(uuid.fake.dump("categories")).toHaveLength(6);
    expect(uuid.fake.dump("medications")).toHaveLength(SEED_ITEMS.length);
    expect(uuid.fake.dump("categories")[0].id).toBe(buildCategories("uuid")[0].id);
    expect(uuid.fake.dump("medications")[0]).toMatchObject({ id: 100, category_id: buildMedications({ shape: "uuid" })[0].category_id });
    expect(uuid.fake.dump("medications").filter((m) => m.category_id === null)).toHaveLength(3);

    const big = standardFake({ categoryIdType: "bigint" });
    expect(big.fake.dump("categories").map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(big.fake.dump("medications")[0].category_id).toBe(1); // "1" in the fixtures, a number in the database
    expect(typeof big.fake.dump("medications")[0].category_id).toBe("number");
  });

  it("seedStandard adapts to the options: no supplier column -> no supplier numbers; optional transactions", () => {
    const fake = createFakeSupabase(LIVE_BEFORE_MIGRATION);
    const { medications } = seedStandard(fake, { withTransactions: true });
    expect(medications.every((m) => m.supplier_order_number === null)).toBe(true);
    expect("supplier_order_number" in fake.dump("medications")[0]).toBe(false);
    expect(fake.dump("transactions")).toHaveLength(12);
    expect(buildTransactionSeeds(medications)).toHaveLength(12);
  });

  it("seeding is strict: FK order, duplicates, and types are enforced with a readable error", () => {
    const fake = createFakeSupabase({ categoryIdType: "uuid" });
    expect(() => fake.seedMedications(buildMedications({ shape: "uuid" }))).toThrow(/23503/); // categories first!
    fake.seedCategories(buildCategories("uuid"));
    expect(() => fake.seedCategories(buildCategories("uuid"))).toThrow(/23505/);
    expect(() => fake.seedMedications([{ barcode: "x", category_id: "7" }])).toThrow(/22P02/); // bigint-style id in a uuid DB
    expect(() => fake.seedTransactions([{ medication_id: 1, type: "receive", quantity: 1 }])).toThrow(/23503/);
  });

  it("seeding bypasses RLS and records no calls; created_at null on a Category means 'use the default'", async () => {
    const fake = createFakeSupabase(LIVE_BEFORE_MIGRATION);
    fake.seedCategories([{ id: "a0000000-0000-4000-8000-0000000000aa", name: "Hidden", created_at: null }]);
    expect(fake.calls).toHaveLength(0);
    expect(fake.dump("categories")[0].created_at).toMatch(TS_RE);
    expect(rowsOf(await fake.from("categories").select("*"))).toEqual([]);
  });

  it("seeded rows keep their supplied timestamps (no trigger) and later inserts continue the sequence", async () => {
    const { fake, medications } = standardFake({ categoryIdType: "bigint" });
    expect(fake.dump("medications")[0].updated_at).toBe(medications[0].updated_at);
    const next = rowOf(await fake.from("medications").insert({ barcode: "zzz" }).select().single());
    expect(next.id).toBe(100 + SEED_ITEMS.length); // max seeded id (126) + 1
  });
});

// ═══════════════════════════════════ 14. storage ═══════════════════════════════════

describe("storage", () => {
  it("upload / getPublicUrl behave like the upload route expects; duplicates need upsert:true; uploads are recorded as writes", async () => {
    const fake = createFakeSupabase();
    const bucket = fake.storage.from("medication-photos");
    const first = await bucket.upload("a.png", new Uint8Array([1, 2, 3]), { contentType: "image/png", upsert: false });
    expect(first).toMatchObject({ error: null, data: { path: "a.png", fullPath: "medication-photos/a.png" } });
    const dup = await bucket.upload("a.png", new Uint8Array([1]), { upsert: false });
    expect(dup.data).toBeNull();
    expect(dup.error).toMatchObject({ message: "The resource already exists", status: 409, statusCode: "409" });
    expect((await bucket.upload("a.png", new Uint8Array([1]), { upsert: true })).error).toBeNull();
    expect(bucket.getPublicUrl("a.png").data.publicUrl).toBe("https://fake-supabase.invalid/storage/v1/object/public/medication-photos/a.png");
    expect(fake.uploads()).toEqual([{ bucket: "medication-photos", path: "a.png", contentType: "image/png", size: 3 }]);
    expect(fake.writes().map((c) => c.op)).toEqual(["storage.upload", "storage.upload", "storage.upload"]);
  });
});

// ═══════════════════════════════════ 15. vi.mock pattern A with REAL routes ═══════════════════════════════════

describe("pattern A: vi.mock('@/lib/db') + installFake() with the real, unchanged routes", () => {
  let fake: FakeSupabase;
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fake = installFake({ categoryIdType: "uuid", hasSupplierColumn: true });
    seedStandard(fake, { withTransactions: true });
  });

  it("the module mock delegates to whichever fake is currently installed", async () => {
    expect(supabaseProxy.from).toBeTypeOf("function");
    const other = installFake({ categoryIdType: "bigint" });
    expect(rowsOf(await supabaseProxy.from("medications").select("id"))).toEqual([]);
    expect(other.calls).toHaveLength(1);
    expect(fake.calls).toHaveLength(0);
  });

  it("POST /api/transactions: dispense and receive go through the rpc, return the updated row, change stock", async () => {
    const res = await transactionsPOST(jsonRequest("POST", "/api/transactions", { medication_id: 100, type: "dispense", quantity: 20, note: "ward 3" }));
    expect(res.status).toBe(201);
    expect(await readJson(res)).toMatchObject({ id: 100, stock: 100 });
    const recv = await transactionsPOST(jsonRequest("POST", "/api/transactions", { medication_id: "100", type: "receive", quantity: 5 }));
    expect(await readJson(recv)).toMatchObject({ id: 100, stock: 105 });
    expect(fake.dump("medications").find((m) => m.id === 100)?.stock).toBe(105);
    expect(fake.writes().map((c) => c.op)).toEqual(["rpc", "rpc"]);
    expect(fake.writes()[0].payload).toEqual({ p_medication_id: 100, p_type: "dispense", p_quantity: 20, p_note: "ward 3" });
  });

  it("POST /api/transactions: insufficient stock and unknown item come back as the route's 400s; DB outage is a 500", async () => {
    const insufficient = await transactionsPOST(jsonRequest("POST", "/api/transactions", { medication_id: 112, type: "dispense", quantity: 5 }));
    expect(insufficient.status).toBe(400);
    expect(await readJson(insufficient)).toEqual({ error: "Insufficient stock. Current stock: 0" });

    const missing = await transactionsPOST(jsonRequest("POST", "/api/transactions", { medication_id: 99999, type: "receive", quantity: 1 }));
    expect(missing.status).toBe(400);
    expect(await readJson(missing)).toEqual({ error: "Medication not found" });

    fake.failNext(FETCH_FAILED);
    const outage = await transactionsPOST(jsonRequest("POST", "/api/transactions", { medication_id: 100, type: "receive", quantity: 1 }));
    expect(outage.status).toBe(500);
    expect(fake.dump("medications").find((m) => m.id === 100)?.stock).toBe(120);
  });

  it("GET /api/transactions: embedded medication fields are flattened, newest first", async () => {
    const res = await transactionsGET(jsonRequest("GET", "/api/transactions?medicationId=100"));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as Row[];
    expect(body.map((t) => t.type)).toEqual(["dispense", "receive"]); // dispense is newer (1 day ago vs 5)
    expect(body[0]).toMatchObject({ medication_id: 100, medication_name: "Acetaminophen 500 mg, tablets", unit: "units" });
    expect("medications" in body[0]).toBe(false);

    const recent = (await readJson(await transactionsGET(jsonRequest("GET", "/api/transactions?days=30")))) as Row[];
    expect(recent).toHaveLength(12);
    const none = (await readJson(await transactionsGET(jsonRequest("GET", "/api/transactions?days=3")))) as Row[];
    expect(none).toHaveLength(6); // only the six dispenses from yesterday
  });

  it("GET /api/analytics: aggregates the seeded transactions per item", async () => {
    const res = await analyticsGET(jsonRequest("GET", "/api/analytics?days=30"));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { medications: Row[]; days: number };
    expect(body.days).toBe(30);
    expect(body.medications).toHaveLength(SEED_ITEMS.length);
    const first = body.medications.find((m) => m.id === 100);
    expect(first).toMatchObject({ total_dispensed: 2, total_received: 10, current_stock: 120 });
    expect(fake.writes()).toHaveLength(0); // analytics is read-only
  });

  it("POST /api/import: new rows are inserted, existing rows updated; category and supplier code are NOT touched", async () => {
    const meds = buildMedications({ shape: "uuid" });
    const existing = meds[0];
    const csv = ["name,barcode,stock,threshold,unit", `Renamed item,${existing.barcode},7,3,box`, "Brand new item,0099,5,2,units"].join("\n");
    const res = await importPOST(new NextRequest("http://localhost/api/import", { method: "POST", body: csv }));
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ inserted: 1, updated: 1, skipped: 0 });
    const stored = fake.dump("medications");
    expect(stored.find((m) => m.id === 100)).toMatchObject({
      name: "Renamed item",
      stock: 7,
      unit: "box",
      category_id: existing.category_id, // preserved: not in the import payload
      supplier_order_number: existing.supplier_order_number,
    });
    expect(stored.find((m) => m.barcode === "0099")).toMatchObject({ category_id: null, is_unnamed: false, stock: 5 });
    expect(fake.callsFor("medications").map((c) => c.op)).toEqual(["select", "upsert"]);
  });

  it("POST /api/import: existing barcodes with a double quote, a comma or a backslash are counted as UPDATED, not inserted (its .in() lookup must find them)", async () => {
    const tricky = ['say "hi"', "a,b", "x\\y", "0042"];
    fake.seedMedications(tricky.map((barcode, i) => ({ barcode, name: `Existing ${i}`, stock: 1 })));
    const cell = (s: string): string => `"${s.replace(/"/g, '""')}"`; // RFC 4180 quoting
    const csv = [
      "name,barcode,stock,threshold",
      ...tricky.map((barcode, i) => `${cell(`Renamed ${i}`)},${cell(barcode)},9,3`),
      `${cell("Brand new")},${cell("NEW-1")},5,2`,
    ].join("\n");
    const res = await importPOST(new NextRequest("http://localhost/api/import", { method: "POST", body: csv }));
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ inserted: 1, updated: 4, skipped: 0 });
    const stored = fake.dump("medications");
    for (const [i, barcode] of tricky.entries()) {
      const matches = stored.filter((m) => m.barcode === barcode);
      expect(matches, barcode).toHaveLength(1); // updated in place, no duplicate row
      expect(matches[0]).toMatchObject({ name: `Renamed ${i}`, stock: 9 });
    }
    expect(stored.filter((m) => m.barcode === "NEW-1")).toHaveLength(1);
  });

  it("POST /api/import: a CSV that repeats a barcode makes the upsert fail (21000) and nothing is imported", async () => {
    const csv = ["name,barcode,stock,threshold", "A,0098,1,1", "B,0098,2,2"].join("\n");
    const res = await importPOST(new NextRequest("http://localhost/api/import", { method: "POST", body: csv }));
    expect(res.status).toBe(500);
    expect(await readJson(res)).toEqual({ error: "Import failed" });
    expect(fake.dump("medications").some((m) => m.barcode === "0098")).toBe(false);
  });

  it("POST /api/upload: stores the file through the storage fake and returns its public URL; storage errors surface", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "Pill.PNG", { type: "image/png" }));
    const res = await uploadPOST(new NextRequest("http://localhost/api/upload", { method: "POST", body: form }));
    expect(res.status).toBe(200);
    const { url } = (await readJson(res)) as { url: string };
    expect(url).toMatch(/^https:\/\/fake-supabase\.invalid\/storage\/v1\/object\/public\/medication-photos\/\d+-[a-z0-9]+\.png$/);
    expect(fake.uploads()).toHaveLength(1);
    expect(fake.uploads()[0]).toMatchObject({ bucket: "medication-photos", contentType: "image/png", size: 4 });

    fake.failNext({ message: "Bucket not found" }, { bucket: "medication-photos" });
    const form2 = new FormData();
    form2.set("file", new File([new Uint8Array([1])], "x.png", { type: "image/png" }));
    const failed = await uploadPOST(new NextRequest("http://localhost/api/upload", { method: "POST", body: form2 }));
    expect(failed.status).toBe(500);
    expect(await readJson(failed)).toEqual({ error: "Storage error: Bucket not found" });
  });

  it("POST /api/medications refuses U+0000 with its own 400 (and the field) before anything reaches the database", async () => {
    const NUL = String.fromCharCode(0);
    for (const field of ["barcode", "name", "notes", "unit", "vendor_url"]) {
      const res = await medicationsPOST(jsonRequest("POST", "/api/medications", { barcode: "NUL-1", [field]: `a${NUL}b` }));
      expect(res.status, field).toBe(400);
      expect(await readJson(res)).toMatchObject({ field });
    }
    expect(fake.writes()).toHaveLength(0); // the guard answered; no insert was even attempted
    expect(fake.dump("medications").some((m) => m.barcode === "NUL-1")).toBe(false);

    // were the guard ever removed, the fake itself now refuses the value instead of storing it (see the 22P05 test)
    const direct = await fake.from("medications").insert({ barcode: `NUL-2${NUL}` });
    expect(direct.error?.code).toBe("22P05");
  });

  it("POST /api/categories: a competing request that creates the same name between the route's check and its insert is resolved to the winner (200) - reproduced with onCall, no injected error", async () => {
    const f = installFake(LIVE_AFTER_MIGRATION);
    f.onCall((call) => {
      // runs just before the route's insert executes, i.e. after its duplicate check found nothing
      if (call.op === "insert" && call.table === "categories") f.seedCategories([{ name: "Splints" }]);
    });
    const res = await categoriesPOST(jsonRequest("POST", "/api/categories", { name: "Splints" }));
    expect(res.status).toBe(200);
    const winner = f.dump("categories");
    expect(winner).toHaveLength(1); // the route did not create a second one
    expect(await readJson(res)).toMatchObject({ id: winner[0].id, name: "Splints" });
    // the database itself raised the 23505: nothing was injected
    const inserts = f.callsFor("categories").filter((c) => c.op === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ injected: false, result: { error: { code: "23505" } } });
  });

  it("GET /api/medications: a row that arrives between two pages shifts the offsets, yet every original row comes back exactly once", async () => {
    const total = 2100;
    const f = installFake({ categoryIdType: "uuid", maxRows: 1000 });
    f.seedMedications(
      Array.from({ length: total }, (_, i) => ({
        id: i + 1,
        barcode: `B${String(i + 1).padStart(5, "0")}`,
        name: `Item ${String(i + 1).padStart(5, "0")}`,
      }))
    );
    let pages = 0;
    f.onCall((call) => {
      if (call.op === "select" && call.table === "medications" && ++pages === 2) {
        // sorts before everything: the second page now starts one row earlier than the first page ended
        f.seedMedications([{ id: 9001, barcode: "AAA-new", name: "AAA arrived between pages" }]);
      }
    });
    const res = await medicationsGET(jsonRequest("GET", "/api/medications"));
    expect(res.status).toBe(200);
    const ids = ((await readJson(res)) as Array<{ id: number }>).map((m) => m.id);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    const returned = new Set(ids);
    const missing = Array.from({ length: total }, (_, i) => i + 1).filter((id) => !returned.has(id));
    expect(missing).toEqual([]); // none of the original rows lost
  });
});

// ═══════════════════════════════════ 15b. the live category failures, reproduced through the fake ═══════════════════════════════════

// Throwaway inline copies of plain categories handlers that read and write the table directly and hide the database's
// error behind a generic message (hence the preFix names). They exist to show that the fake reproduces the production
// symptoms; they are deliberately not the real routes, so this demonstration cannot change when those routes do.
async function preFixCategoriesGET(): Promise<Response> {
  try {
    const { data, error } = await supabase.from("categories").select("*").order("name");
    if (error) throw error;
    return NextResponse.json(data ?? []);
  } catch {
    return NextResponse.json({ error: "Failed to fetch categories" }, { status: 500 });
  }
}
async function preFixCategoriesPOST(name: string): Promise<Response> {
  try {
    const { data, error } = await supabase.from("categories").insert({ name: name.trim() }).select().single();
    if (error) throw error;
    return NextResponse.json(data, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to create category" }, { status: 500 });
  }
}

describe("the live category failures, reproduced (pre-fix handlers against LIVE_BEFORE_MIGRATION)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("before the migration: the list is silently EMPTY with HTTP 200 and creating a category fails (42501)", async () => {
    const fake = installFake(LIVE_BEFORE_MIGRATION);
    fake.seedCategories([{ id: "a0000000-0000-4000-8000-0000000000aa", name: "Exists but invisible" }]);

    const list = await preFixCategoriesGET();
    expect(list.status).toBe(200);
    expect(await readJson(list)).toEqual([]); // "No categories" although one is stored: looks exactly like data loss

    const created = await preFixCategoriesPOST("Antibiotics");
    expect(created.status).toBe(500);
    expect(await readJson(created)).toEqual({ error: "Failed to create category" });
    expect(fake.callsFor("categories").at(-1)?.result?.error).toMatchObject({ code: "42501" });
    expect(fake.dump("categories")).toHaveLength(1);
  });

  it("after the migration (policy present): the same handlers create and list categories", async () => {
    const fake = installFake(LIVE_AFTER_MIGRATION);
    const created = await preFixCategoriesPOST("Antibiotics");
    expect(created.status).toBe(201);
    expect(((await readJson(created)) as Row).id).toMatch(UUID_RE);
    const list = (await readJson(await preFixCategoriesGET())) as Row[];
    expect(list.map((c) => c.name)).toEqual(["Antibiotics"]);
    expect(fake.writes()).toHaveLength(1);
  });
});

// ═══════════════════════════════════ 16. vi.mock pattern B (vi.hoisted holder) ═══════════════════════════════════

describe("pattern B: vi.hoisted holder + lazy getter", () => {
  it("a route imported AFTER vi.doMock reads the holder's fake at call time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.doMock("@/lib/db", () => ({
      get supabase() {
        return holder.fake;
      },
    }));
    vi.resetModules();
    const { POST } = await import("@/app/api/transactions/route");

    holder.fake = createFakeSupabase({ categoryIdType: "bigint" });
    holder.fake.seedMedications([{ id: 7, barcode: "b7", stock: 3 }]);
    const res = await POST(jsonRequest("POST", "/api/transactions", { medication_id: 7, type: "receive", quantity: 2 }));
    expect(res.status).toBe(201);
    expect(await readJson(res)).toMatchObject({ id: 7, stock: 5 });
    expect(holder.fake.dump("medications")[0].stock).toBe(5);

    holder.fake = createFakeSupabase(); // swapping the holder's fake between tests works without re-importing
    const missing = await POST(jsonRequest("POST", "/api/transactions", { medication_id: 7, type: "receive", quantity: 2 }));
    expect(missing.status).toBe(400);
    holder.fake = null;
    vi.doUnmock("@/lib/db");
  });
});

// ═══════════════════════════════════ 17. helpers that need a pristine module ═══════════════════════════════════

describe("pattern A survives vi.resetModules()", () => {
  // The installed fake lives on globalThis, not in a module variable. vi.resetModules() makes the next import of the
  // helper a SECOND COPY of the module, and the mock factory (which imports the helper) is what hands that copy to the
  // route. A module-level variable would be null in the copy, and the route would answer 500 "no fake installed".
  it("every copy of the helper module sees the fake that was installed through any other copy", async () => {
    const fake = installFake({ categoryIdType: "bigint" });
    vi.resetModules();
    const copy = await import("../helpers/fake-supabase");
    expect(copy.installFake).not.toBe(installFake); // really a second copy of the module
    expect(copy.getFake()).toBe(fake);
    expect(rowsOf(await copy.supabaseProxy.from("medications").select("id"))).toEqual([]);
    expect(fake.calls).toHaveLength(1); // the call through the copy's proxy landed in the original fake

    const replacement = copy.installFake(); // installing through either copy replaces the one shared slot
    expect(getFake()).toBe(replacement);
    uninstallFake(); // ...and so does uninstalling
    expect(() => copy.getFake()).toThrow(/installFake/);
  });

  it("a route imported after vi.resetModules() still talks to the fake installed before it (the mock factory first runs after the reset)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.resetModules();
    // Pattern A's factory, registered after the reset. (The file-level vi.mock above would not do here: vitest keeps the
    // result of a factory that already ran, and this file has imported routes statically. A test file without a static
    // route import hits exactly this situation with plain vi.mock.)
    vi.doMock("@/lib/db", async () => {
      const { supabaseProxy: proxy } = await import("../helpers/fake-supabase");
      return { supabase: proxy };
    });
    try {
      const fake = installFake({ categoryIdType: "bigint" });
      fake.seedMedications([{ id: 7, barcode: "b7", stock: 3 }]);
      const { POST } = await import("@/app/api/transactions/route");
      const res = await POST(jsonRequest("POST", "/api/transactions", { medication_id: 7, type: "receive", quantity: 2 }));
      expect(await readJson(res)).toMatchObject({ id: 7, stock: 5 });
      expect(res.status).toBe(201);
      expect(fake.writes()).toHaveLength(1);
      expect(fake.dump("medications")[0].stock).toBe(5);
    } finally {
      vi.doUnmock("@/lib/db");
    }
  });
});

describe("accessor and request helpers", () => {
  it("getFake() / supabaseProxy explain what to do when no fake has been installed", () => {
    uninstallFake();
    expect(() => getFake()).toThrow(/installFake/);
    expect(() => supabaseProxy.from("medications")).toThrow(/installFake/);
    const fake = installFake();
    expect(getFake()).toBe(fake);
    expect(getFake().dump("medications")).toEqual([]);
    uninstallFake();
    expect(() => getFake()).toThrow(/installFake/);
  });

  it("routeParams() wraps params in a Promise (Next 16 dynamic route context); jsonRequest() builds a NextRequest", async () => {
    await expect(routeParams({ id: "5" }).params).resolves.toEqual({ id: "5" });
    const req = jsonRequest("PUT", "/api/medications/5", { barcode: "x" });
    expect(req.method).toBe("PUT");
    expect(req.nextUrl.pathname).toBe("/api/medications/5");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(await req.json()).toEqual({ barcode: "x" });
    expect(jsonRequest("GET", "http://example.invalid/api/x?y=1").nextUrl.search).toBe("?y=1");
  });
});

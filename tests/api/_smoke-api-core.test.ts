// Smoke tests for the api-core routes (categories + medications). They call the real route handlers with a small,
// stateful stand-in for the Supabase client. Comprehensive independent route tests with a full fake come later;
// this file proves the contract in SPEC 2.6 end to end for the behaviours that caused the reported problems.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Category, Medication } from "@/lib/db";
import { buildCategories, buildManyMedications, buildMedications, fakeUuid, type IdShape } from "../helpers/fixtures";

// ── Minimal chainable stand-in for the Supabase client ───────────────────────────────────────────────────────
// Implements just the builder methods the routes use, with the PostgREST behaviours the routes rely on: a response
// row cap (db-max-rows), exact counts, 416 for an out-of-range offset when a count was requested, PGRST116 for
// single()/maybeSingle(), unique / foreign-key / not-null / invalid-format / missing-column errors, and
// "return=representation" after insert/update/delete. Equality filters are EXACT like Postgres text equality (a
// barcode looked up in the wrong case finds nothing); only uuid columns compare case-insensitively.

type Row = Record<string, unknown>;
type PgError = { code: string; message: string; details: string | null; hint: string | null };
type Result = { data: Row[] | Row | null; error: PgError | null; count: number | null; status: number };
type Op = "select" | "insert" | "update" | "delete";
type Order = { column: string; ascending: boolean; nullsFirst: boolean | undefined };
type Call = {
  table: string;
  op: Op;
  columns: string;
  payload: Row | null;
  eq: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
  order: Order[];
  range: [number, number] | null;
  count: boolean;
  shape: "list" | "single" | "maybeSingle";
  returning: boolean;
};
type Failure = { table: string; op: Op; error: PgError; times: number; skip: number; sideEffect?: () => void };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function pg(code: string, message: string, details: string | null = null): PgError {
  return { code, message, details, hint: null };
}

const NETWORK_ERROR: PgError = { code: "", message: "TypeError: fetch failed", details: "Caused by: Error: getaddrinfo ENOTFOUND x.supabase.co", hint: "" };
const RLS_ERROR = pg("42501", 'new row violates row-level security policy for table "medications"');

function sortRows(rows: Row[], order: Order[]): Row[] {
  if (order.length === 0) return rows.slice();
  return rows.slice().sort((a, b) => {
    for (const o of order) {
      const x = (a[o.column] ?? null) as string | number | null;
      const y = (b[o.column] ?? null) as string | number | null;
      if (x === y) continue;
      const nullsFirst = o.nullsFirst ?? !o.ascending; // PostgreSQL: NULLS LAST for ASC, NULLS FIRST for DESC
      if (x === null) return nullsFirst ? -1 : 1;
      if (y === null) return nullsFirst ? 1 : -1;
      const cmp = x < y ? -1 : x > y ? 1 : 0;
      if (cmp !== 0) return o.ascending ? cmp : -cmp;
    }
    return 0;
  });
}

function project(row: Row, columns: string): Row {
  if (columns.trim() === "*") return { ...row };
  const out: Row = {};
  for (const c of columns.split(",").map((s) => s.trim())) out[c] = row[c];
  return out;
}

class FakeDb {
  tables: { categories: Row[]; medications: Row[] } = { categories: [], medications: [] };
  readonly calls: Call[] = [];
  /** PostgREST db-max-rows: no response ever holds more rows than this. */
  maxRows = 1000;
  /** false = the server ignores `Prefer: count=exact` (the routes must still page correctly). */
  countSupported = true;
  /**
   * Runs at the start of every select (0-based index), BEFORE the rows for that request are chosen, so a change made
   * here is visible to that very request: use index 1 to change the data between page 1 and page 2 of a list.
   */
  onSelect: ((index: number, db: FakeDb) => void) | null = null;
  private failures: Failure[] = [];
  private selects = 0;
  private nextMedicationId = 1_000_000;
  private nextCategory = 5_000;

  constructor(
    readonly shape: IdShape,
    readonly supplierColumn: boolean
  ) {}

  from(table: string): Query {
    return new Query(this, table);
  }

  /** Make the next `times` matching calls fail (after letting `skip` matching calls through). */
  failOn(table: "categories" | "medications", op: Op, error: PgError, opts: { times?: number; skip?: number; sideEffect?: () => void } = {}) {
    this.failures.push({ table, op, error, times: opts.times ?? 1, skip: opts.skip ?? 0, sideEffect: opts.sideEffect });
  }

  callsTo(table: string, op?: Op): Call[] {
    return this.calls.filter((c) => c.table === table && (op === undefined || c.op === op));
  }

  get mutations(): Call[] {
    return this.calls.filter((c) => c.op !== "select");
  }

  private rowsOf(table: string): Row[] {
    return table === "categories" ? this.tables.categories : this.tables.medications;
  }

  /** Postgres equality: exact for text, numbers and booleans; a uuid is parsed to a value, so its case does not matter. */
  private sameColumnValue(table: string, column: string, stored: unknown, wanted: unknown): boolean {
    const a = String(stored);
    const b = String(wanted);
    const isUuidColumn = column === "category_id" || (table === "categories" && column === "id");
    return isUuidColumn ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  private categoryExists(id: unknown): boolean {
    return this.tables.categories.some((c) => String(c.id).toLowerCase() === String(id).toLowerCase());
  }

  private allowedColumns(table: string): string[] {
    if (table === "categories") return ["id", "name", "created_at"];
    const base = ["id", "name", "barcode", "photo_url", "stock", "threshold", "vendor_url", "unit", "notes", "category_id", "is_unnamed", "created_at", "updated_at"];
    return this.supplierColumn ? [...base, "supplier_order_number"] : base;
  }

  /** Database-side validation shared by insert and update. */
  private check(table: string, payload: Row, self: Row | null): PgError | null {
    for (const key of Object.keys(payload)) {
      if (!this.allowedColumns(table).includes(key)) {
        return pg("PGRST204", `Could not find the '${key}' column of '${table}' in the schema cache`);
      }
    }
    if (table === "categories") {
      if (payload.name === undefined || payload.name === null) return pg("23502", 'null value in column "name" of relation "categories" violates not-null constraint');
      if (this.tables.categories.some((c) => c !== self && c.name === payload.name)) {
        return pg("23505", 'duplicate key value violates unique constraint "categories_name_key"', `Key (name)=(${String(payload.name)}) already exists.`);
      }
      return null;
    }
    // NOT NULL columns of the real schema (an explicit null is NOT replaced by the column default)
    for (const column of ["unit", "stock", "threshold", "is_unnamed"]) {
      if (column in payload && payload[column] === null) {
        return pg("23502", `null value in column "${column}" of relation "medications" violates not-null constraint`);
      }
    }
    if ("barcode" in payload || self === null) {
      if (payload.barcode === undefined || payload.barcode === null) return pg("23502", 'null value in column "barcode" of relation "medications" violates not-null constraint');
      if (this.tables.medications.some((m) => m !== self && m.barcode === payload.barcode)) {
        return pg("23505", 'duplicate key value violates unique constraint "medications_barcode_key"', `Key (barcode)=(${String(payload.barcode)}) already exists.`);
      }
    }
    const cat = payload.category_id;
    if (cat !== undefined && cat !== null) {
      if (this.shape === "uuid" && !(typeof cat === "string" && UUID_RE.test(cat))) {
        return pg("22P02", `invalid input syntax for type uuid: "${String(cat)}"`);
      }
      if (this.shape === "bigint" && !/^[0-9]+$/.test(String(cat))) {
        return pg("22P02", `invalid input syntax for type bigint: "${String(cat)}"`);
      }
      if (!this.categoryExists(cat)) {
        return pg("23503", 'insert or update on table "medications" violates foreign key constraint "medications_category_id_fkey"');
      }
    }
    return null;
  }

  private castPayload(payload: Row): Row {
    const out: Row = { ...payload };
    if (out.category_id !== undefined && out.category_id !== null && this.shape === "bigint") out.category_id = Number(out.category_id);
    return out;
  }

  private done(rows: Row[], spec: Call, count: number | null): Result {
    const projected = rows.map((r) => project(r, spec.columns));
    if (spec.shape === "list") return { data: projected, error: null, count, status: 200 };
    if (projected.length === 1) return { data: projected[0], error: null, count, status: 200 };
    if (projected.length === 0 && spec.shape === "maybeSingle") return { data: null, error: null, count, status: 200 };
    return {
      data: null,
      error: pg("PGRST116", "JSON object requested, multiple (or no) rows returned", `The result contains ${projected.length} rows`),
      count: null,
      status: 406,
    };
  }

  execute(spec: Call): Result {
    this.calls.push(spec);
    const failure = this.failures.find((f) => f.table === spec.table && f.op === spec.op && f.times > 0);
    if (failure) {
      if (failure.skip > 0) {
        failure.skip -= 1;
      } else {
        failure.times -= 1;
        failure.sideEffect?.();
        return { data: null, error: failure.error, count: null, status: 500 };
      }
    }

    if (spec.op === "select") {
      this.onSelect?.(this.selects, this); // before the rows are chosen, so the change shows up in THIS request
      this.selects += 1;
    }

    const rows = this.rowsOf(spec.table); // read after the hook: it may replace the table's array
    const matching = rows.filter(
      (r) => spec.eq.every(([c, v]) => this.sameColumnValue(spec.table, c, r[c], v)) && spec.is.every(([c, v]) => (r[c] ?? null) === v)
    );

    if (spec.op === "select") {
      const total = matching.length;
      const wantCount = spec.count && this.countSupported;
      let page = sortRows(matching, spec.order);
      if (spec.range) {
        const [from, to] = spec.range;
        if (wantCount && from > 0 && from >= total) {
          return { data: null, error: pg("PGRST103", "Requested range not satisfiable"), count: null, status: 416 };
        }
        page = page.slice(from, from + Math.min(to - from + 1, this.maxRows));
      } else {
        page = page.slice(0, this.maxRows);
      }
      return this.done(page, spec, wantCount ? total : null);
    }

    if (spec.op === "insert") {
      const payload = spec.payload ?? {};
      const error = this.check(spec.table, payload, null);
      if (error) return { data: null, error, count: null, status: 400 };
      const now = new Date().toISOString();
      let row: Row;
      if (spec.table === "categories") {
        this.nextCategory += 1;
        row = { id: this.shape === "uuid" ? fakeUuid(this.nextCategory) : this.nextCategory, name: payload.name, created_at: now };
      } else {
        this.nextMedicationId += 1;
        row = {
          id: this.nextMedicationId,
          name: null,
          photo_url: null,
          stock: 0,
          threshold: 10,
          vendor_url: null,
          unit: "units",
          notes: null,
          category_id: null,
          is_unnamed: false,
          ...(this.supplierColumn ? { supplier_order_number: null } : {}),
          created_at: now,
          updated_at: now,
          ...this.castPayload(payload),
        };
      }
      rows.push(row);
      return spec.returning ? this.done([row], spec, null) : { data: null, error: null, count: null, status: 201 };
    }

    if (spec.op === "update") {
      const payload = spec.payload ?? {};
      for (const row of matching) {
        const error = this.check(spec.table, payload, row);
        if (error) return { data: null, error, count: null, status: 400 };
      }
      for (const row of matching) Object.assign(row, this.castPayload(payload), { updated_at: new Date().toISOString() });
      return spec.returning ? this.done(matching, spec, null) : { data: null, error: null, count: null, status: 204 };
    }

    // delete
    const removed = matching.slice();
    const kept = rows.filter((r) => !removed.includes(r));
    if (spec.table === "categories") this.tables.categories = kept;
    else this.tables.medications = kept;
    return spec.returning ? this.done(removed, spec, null) : { data: null, error: null, count: null, status: 204 };
  }
}

class Query implements PromiseLike<Result> {
  private readonly spec: Call;

  constructor(
    private readonly db: FakeDb,
    table: string
  ) {
    this.spec = { table, op: "select", columns: "*", payload: null, eq: [], is: [], order: [], range: null, count: false, shape: "list", returning: false };
  }

  select(columns = "*", options?: { count?: string }): this {
    if (this.spec.op === "select") this.spec.count = options?.count === "exact";
    else this.spec.returning = true;
    this.spec.columns = columns;
    return this;
  }
  insert(payload: Row): this {
    this.spec.op = "insert";
    this.spec.payload = payload;
    return this;
  }
  update(payload: Row): this {
    this.spec.op = "update";
    this.spec.payload = payload;
    return this;
  }
  delete(): this {
    this.spec.op = "delete";
    return this;
  }
  eq(column: string, value: unknown): this {
    this.spec.eq.push([column, value]);
    return this;
  }
  is(column: string, value: unknown): this {
    this.spec.is.push([column, value]);
    return this;
  }
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.spec.order.push({ column, ascending: options?.ascending ?? true, nullsFirst: options?.nullsFirst });
    return this;
  }
  range(from: number, to: number): this {
    this.spec.range = [from, to];
    return this;
  }
  single(): this {
    this.spec.shape = "single";
    return this;
  }
  maybeSingle(): this {
    this.spec.shape = "maybeSingle";
    return this;
  }
  then<R1 = Result, R2 = never>(
    onfulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve()
      .then(() => this.db.execute(this.spec))
      .then(onfulfilled, onrejected);
  }
}

// ── Wire the stand-in in place of @/lib/db ───────────────────────────────────────────────────────────────────

const holder = vi.hoisted(() => ({ client: null as { from(table: string): unknown } | null }));

vi.mock("@/lib/db", () => ({
  supabase: {
    from: (table: string) => {
      if (!holder.client) throw new Error("test database not installed");
      return holder.client.from(table);
    },
  },
}));

import * as categoriesRoute from "@/app/api/categories/route";
import * as medicationsRoute from "@/app/api/medications/route";
import * as medicationRoute from "@/app/api/medications/[id]/route";
import * as barcodeRoute from "@/app/api/medications/barcode/[code]/route";

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────

type InstallOptions = {
  shape?: IdShape;
  /** false = the database has not had the supplier_order_number migration applied */
  supplierColumn?: boolean;
  medications?: Medication[];
  categories?: Category[];
  maxRows?: number;
};

function install(options: InstallOptions = {}): FakeDb {
  const shape = options.shape ?? "uuid";
  const supplierColumn = options.supplierColumn ?? true;
  const db = new FakeDb(shape, supplierColumn);
  db.maxRows = options.maxRows ?? 1000;
  db.tables.categories = (options.categories ?? buildCategories(shape)).map((c) => ({ ...c, id: shape === "bigint" ? Number(c.id) : c.id }));
  db.tables.medications = (options.medications ?? buildMedications({ shape })).map((m) => {
    const row: Row = { ...m, category_id: m.category_id === null ? null : shape === "bigint" ? Number(m.category_id) : m.category_id };
    if (!supplierColumn) delete row.supplier_order_number;
    return row;
  });
  holder.client = db;
  return db;
}

function req(method: string, path: string, body?: unknown): NextRequest {
  const init: { method: string; body?: string; headers?: Record<string, string> } = { method };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return new NextRequest(`http://localhost${path}`, init);
}

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const codeParams = (code: string) => ({ params: Promise.resolve({ code }) });

async function readJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const dbRow = (db: FakeDb, id: number): Row => {
  const row = db.tables.medications.find((m) => m.id === id);
  if (!row) throw new Error(`no row ${id}`);
  return row;
};

const cp = (n: number): string => String.fromCodePoint(n);

// Facts about the seed fixtures that expectations compare against. Derived, so changing the seed data cannot leave
// a hard-coded number behind that silently stops meaning what it says.
/** The route asks for this many rows per request (app/api/medications/route.ts). */
const PAGE_SIZE = 1000;

const SEED = buildMedications();
const SEED_COUNT = SEED.length;
const SEED_UNNAMED_COUNT = SEED.filter((m) => m.is_unnamed).length;
const SEED_UNCATEGORIZED_COUNT = SEED.filter((m) => m.category_id === null).length;
const inSeedCategory = (id: string, shape: IdShape = "uuid"): number => buildMedications({ shape }).filter((m) => m.category_id === id).length;

// Messages pinned by SPEC 2.5 (the UI and the E2E mock replicate them).
const RLS_CREATE_CATEGORY =
  "Couldn’t create the category: the database refused the change (row-level security). " +
  "The categories access migration hasn’t been applied yet — see supabase/migrations/.";
const SUPPLIER_COLUMN_MISSING =
  "Supplier order numbers aren’t available yet: the database is missing the supplier_order_number column. Apply the latest migration.";
const UNREACHABLE = "Can’t reach the database. Check the connection, and that the Supabase project isn’t paused.";
const NOT_FOUND = "Item not found. It may have been deleted.";
const NO_SUCH_CATEGORY = "That category no longer exists. Reload and choose another.";

beforeEach(() => {
  holder.client = null;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("route configuration", () => {
  it.each([
    ["categories", categoriesRoute.dynamic],
    ["medications", medicationsRoute.dynamic],
    ["medications/[id]", medicationRoute.dynamic],
    ["medications/barcode/[code]", barcodeRoute.dynamic],
  ])("%s is never statically cached", (_name, dynamic) => {
    expect(dynamic).toBe("force-dynamic");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("GET /api/categories", () => {
  it("returns every category sorted naturally by name, ids as strings", async () => {
    const db = install({
      categories: [
        ...buildCategories("uuid"),
        { id: fakeUuid(7), name: "Shelf 10", created_at: null },
        { id: fakeUuid(8), name: "Shelf 2", created_at: null },
        { id: fakeUuid(9), name: "antibiotics (old)", created_at: null },
      ],
    });
    const res = await categoriesRoute.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const list = await readJson<Category[]>(res);
    const names = list.map((c) => c.name);
    expect(names.indexOf("Shelf 2")).toBeLessThan(names.indexOf("Shelf 10"));
    const expected = [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    expect(names).toEqual(expected);
    expect(list).toHaveLength(buildCategories("uuid").length + 3); // the seed categories plus the three added above
    expect(db.mutations).toHaveLength(0);
  });

  it("normalizes bigint ids (JSON numbers from the database) to strings", async () => {
    install({ shape: "bigint" });
    const list = await readJson<Category[]>(await categoriesRoute.GET());
    expect(list.map((c) => c.id).sort()).toEqual(buildCategories("bigint").map((c) => c.id).sort());
    expect(list.every((c) => typeof c.id === "string")).toBe(true);
  });

  it("returns 200 [] only when there really are no categories", async () => {
    install({ categories: [] });
    const res = await categoriesRoute.GET();
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual([]);
  });

  it("does not turn a database error into an empty list", async () => {
    const db = install();
    db.failOn("categories", "select", NETWORK_ERROR);
    const res = await categoriesRoute.GET();
    expect(res.status).toBe(503);
    const body = await readJson(res);
    expect(Array.isArray(body)).toBe(false);
    expect(body.error).toBe(UNREACHABLE);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("maps an unexpected database error to 500 with its code", async () => {
    const db = install();
    db.failOn("categories", "select", pg("XX000", "boom"));
    const res = await categoriesRoute.GET();
    expect(res.status).toBe(500);
    expect(await readJson(res)).toMatchObject({ error: "Unexpected database error.", code: "XX000" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("POST /api/categories", () => {
  it("creates a trimmed category and returns 201 with the normalized row", async () => {
    const db = install();
    const res = await categoriesRoute.POST(req("POST", "/api/categories", { name: "  Wound care  " }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const created = await readJson<Category>(res);
    expect(created.name).toBe("Wound care");
    expect(typeof created.id).toBe("string");
    expect(db.callsTo("categories", "insert")[0].payload).toEqual({ name: "Wound care" });
    // ...and it is visible on the next read
    const list = await readJson<Category[]>(await categoriesRoute.GET());
    expect(list.find((c) => c.id === created.id)?.name).toBe("Wound care");
  });

  it("returns a string id for the bigint schema shape too", async () => {
    install({ shape: "bigint" });
    const created = await readJson<Category>(await categoriesRoute.POST(req("POST", "/api/categories", { name: "Splints" })));
    expect(created.id).toMatch(/^[0-9]+$/);
  });

  it("returns the existing category (200) for the same name in another case, without inserting", async () => {
    const db = install();
    const existing = db.tables.categories.find((c) => c.name === "Antibiotics")!;
    const res = await categoriesRoute.POST(req("POST", "/api/categories", { name: "  aNTIbiotics " }));
    expect(res.status).toBe(200);
    const body = await readJson<Category>(res);
    expect(body.id).toBe(existing.id);
    expect(body.name).toBe("Antibiotics");
    expect(db.callsTo("categories", "insert")).toHaveLength(0);
  });

  it("treats a composed and a decomposed accent as the same category", async () => {
    const db = install({ categories: [{ id: fakeUuid(1), name: "Café supplies", created_at: null }] });
    const res = await categoriesRoute.POST(req("POST", "/api/categories", { name: `Cafe${cp(0x301)} supplies` }));
    expect(res.status).toBe(200);
    expect(db.callsTo("categories", "insert")).toHaveLength(0);
  });

  it("returns the winner (200) when another request creates the same name first (23505 race)", async () => {
    const db = install({ categories: [] });
    db.failOn("categories", "insert", pg("23505", "duplicate key value violates unique constraint"), {
      sideEffect: () => db.tables.categories.push({ id: fakeUuid(42), name: "Splints", created_at: null }),
    });
    const res = await categoriesRoute.POST(req("POST", "/api/categories", { name: "Splints" }));
    expect(res.status).toBe(200);
    expect(await readJson<Category>(res)).toMatchObject({ id: fakeUuid(42), name: "Splints" });
  });

  it("reports a conflict when the 23505 winner cannot be read back", async () => {
    const db = install({ categories: [] });
    db.failOn("categories", "insert", pg("23505", "duplicate key value violates unique constraint"));
    const res = await categoriesRoute.POST(req("POST", "/api/categories", { name: "Splints" }));
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toMatch(/already exists/i);
  });

  it("explains the missing categories migration on a row-level-security refusal (the live defect)", async () => {
    const db = install();
    db.failOn("categories", "insert", pg("42501", 'new row violates row-level security policy for table "categories"'));
    const res = await categoriesRoute.POST(req("POST", "/api/categories", { name: "Splints" }));
    expect(res.status).toBe(403);
    expect(await readJson(res)).toMatchObject({ error: RLS_CREATE_CATEGORY, code: "42501" });
  });

  it("maps an unreachable database to 503 and does not try to insert", async () => {
    const db = install();
    db.failOn("categories", "select", NETWORK_ERROR);
    const res = await categoriesRoute.POST(req("POST", "/api/categories", { name: "Splints" }));
    expect(res.status).toBe(503);
    expect(db.callsTo("categories", "insert")).toHaveLength(0);
  });

  it("maps an unexpected insert failure to 500", async () => {
    const db = install();
    db.failOn("categories", "insert", pg("XX000", "boom"));
    const res = await categoriesRoute.POST(req("POST", "/api/categories", { name: "Splints" }));
    expect(res.status).toBe(500);
  });

  it("accepts a 60 character name and 60 emoji, rejects 61 of either", async () => {
    install();
    const ok60 = await categoriesRoute.POST(req("POST", "/api/categories", { name: "A".repeat(60) }));
    expect(ok60.status).toBe(201);
    const emoji60 = await categoriesRoute.POST(req("POST", "/api/categories", { name: "💊".repeat(60) }));
    expect(emoji60.status).toBe(201);
    for (const name of ["B".repeat(61), "💊".repeat(61)]) {
      const res = await categoriesRoute.POST(req("POST", "/api/categories", { name }));
      expect(res.status).toBe(400);
      expect(await readJson(res)).toMatchObject({ field: "name" });
    }
  });

  it("accepts visible names in other scripts, with accents and with an emoji drawn with its presentation selector", async () => {
    install();
    for (const name of ["Réfrigérés", "日本語", "الأدوية", `Heat packs ☎${cp(0xfe0f)}`, "Pain & Fever (adults)"]) {
      const res = await categoriesRoute.POST(req("POST", "/api/categories", { name }));
      expect(res.status, name).toBe(201);
      expect((await readJson<Category>(res)).name).toBe(name);
    }
  });

  it.each<[string, unknown]>([
    ["missing name", {}],
    ["null name", { name: null }],
    ["empty name", { name: "" }],
    ["blank name", { name: "   " }],
    ["numeric name", { name: 5 }],
    ["object name", { name: { a: 1 } }],
    ["line break", { name: "Pain\nFever" }],
    ["tab", { name: "Pain\tFever" }],
    ["NUL", { name: `Pain${cp(0)}Fever` }],
    ["DEL", { name: `Pain${cp(0x7f)}Fever` }],
    ["zero-width space", { name: `Pain${cp(0x200b)}Fever` }],
    ["right-to-left override", { name: `Pain${cp(0x202e)}Fever` }],
    ["bidi isolate", { name: `Pain${cp(0x2066)}Fever` }],
    ["line separator", { name: `Pain${cp(0x2028)}Fever` }],
    // The route used to keep its own list of ranges that stopped at U+2069; these slipped through it.
    ["inhibit symmetric swapping (U+206A)", { name: `Pain${cp(0x206a)}Fever` }],
    ["nominal digit shapes (U+206F)", { name: `Pain${cp(0x206f)}Fever` }],
    ["soft hyphen", { name: `Anti${cp(0x00ad)}biotics` }],
    ["Arabic letter mark", { name: `Pain${cp(0x061c)}Fever` }],
    ["unassigned format code point (U+2065)", { name: `Pain${cp(0x2065)}Fever` }],
    ["Hangul filler", { name: `Pain${cp(0x3164)}Fever` }],
    ["language tag", { name: `Pain${cp(0xe0001)}Fever` }],
    ["only a zero-width space", { name: cp(0x200b) }],
    ["array body", []],
    ["null body", null],
    ["string body", '"Splints"'],
    ["invalid JSON", "{not json"],
    ["empty body", ""],
  ])("rejects %s with 400 and never touches the database", async (_label, body) => {
    const db = install();
    const res = await categoriesRoute.POST(req("POST", "/api/categories", body === "" ? "" : body === null ? "null" : body));
    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(typeof json.error).toBe("string");
    expect(db.calls).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("GET /api/medications", () => {
  it("returns normalized rows ordered by name (unnamed last), complete, with no-store", async () => {
    const db = install();
    const res = await medicationsRoute.GET(req("GET", "/api/medications"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const list = await readJson<Medication[]>(res);
    expect(list).toHaveLength(SEED_COUNT);
    expect(list[list.length - 1].name).toBeNull(); // the barcode-only item sorts last
    expect(new Set(list.map((m) => m.id)).size).toBe(SEED_COUNT);
    expect(list.every((m) => "supplier_order_number" in m && typeof m.category_id !== "number")).toBe(true);
    const named = list.slice(0, -1).map((m) => m.name as string);
    expect(named).toEqual([...named].sort());

    const [call] = db.callsTo("medications", "select");
    expect(call.order).toEqual([
      { column: "name", ascending: true, nullsFirst: false },
      { column: "barcode", ascending: true, nullsFirst: undefined },
      { column: "id", ascending: true, nullsFirst: undefined },
    ]);
    expect(call.range).toEqual([0, 999]);
    expect(db.mutations).toHaveLength(0);
  });

  it("never names supplier_order_number in a select list (works before and after the migration)", async () => {
    const db = install();
    await medicationsRoute.GET(req("GET", "/api/medications"));
    await medicationRoute.GET(req("GET", "/api/medications/101"), idParams("101"));
    await barcodeRoute.GET(req("GET", "/api/medications/barcode/x"), codeParams("0049000028911"));
    const selects = db.callsTo("medications", "select");
    expect(selects.length).toBe(3);
    expect(selects.every((c) => c.columns === "*")).toBe(true);
  });

  it("before the migration: no supplier column in the rows -> supplier_order_number is null, nothing breaks", async () => {
    install({ supplierColumn: false });
    const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications")));
    expect(list).toHaveLength(SEED_COUNT);
    expect(list.every((m) => m.supplier_order_number === null)).toBe(true);
  });

  it("after the migration: supplier numbers come back exactly as stored (leading zeros, letters, punctuation)", async () => {
    install();
    const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications")));
    const supplier = new Set(list.map((m) => m.supplier_order_number));
    for (const code of ["00417-B", "0092", "0007", "000250", "NX-220/100", "00-1.50"]) expect(supplier.has(code)).toBe(true);
  });

  describe("paging (the server caps a response at db-max-rows)", () => {
    it("returns ALL rows across more than 1000 (2,345), each once, in order", async () => {
      const db = install({ medications: buildManyMedications(2345) });
      const res = await medicationsRoute.GET(req("GET", "/api/medications"));
      expect(res.status).toBe(200);
      const list = await readJson<Medication[]>(res);
      expect(list).toHaveLength(2345);
      expect(new Set(list.map((m) => m.id)).size).toBe(2345);
      const names = list.map((m) => m.name as string);
      expect(names).toEqual([...names].sort());
      expect(db.callsTo("medications", "select").map((c) => c.range)).toEqual([
        [0, 999],
        [1000, 1999],
        [2000, 2999],
      ]);
      // only the first page asks for the exact total
      expect(db.callsTo("medications", "select").map((c) => c.count)).toEqual([true, false, false]);
    });

    it("exactly 1000 rows: one request, nothing lost", async () => {
      const db = install({ medications: buildManyMedications(1000) });
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications")));
      expect(list).toHaveLength(1000);
      expect(db.callsTo("medications", "select")).toHaveLength(1);
    });

    it("1001 rows: the last row is not dropped", async () => {
      const db = install({ medications: buildManyMedications(1001) });
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications")));
      expect(list).toHaveLength(1001);
      expect(db.callsTo("medications", "select")).toHaveLength(2);
    });

    it("no rows at all: 200 [] after a single request", async () => {
      const db = install({ medications: [] });
      const res = await medicationsRoute.GET(req("GET", "/api/medications"));
      expect(res.status).toBe(200);
      expect(await readJson(res)).toEqual([]);
      expect(db.callsTo("medications", "select")).toHaveLength(1);
    });

    it("still returns everything when the server ignores the count preference (an EMPTY page ends the list)", async () => {
      const db = install({ medications: buildManyMedications(2345) });
      db.countSupported = false;
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications")));
      expect(list).toHaveLength(2345);
      expect(db.callsTo("medications", "select").map((c) => c.range)).toEqual([
        [0, 999],
        [1000, 1999],
        [2000, 2999], // 345 rows: a short page, but without a total it cannot be told apart from a server cap
        [2345, 3344], // empty: nothing more
      ]);
    });

    it("exactly 1000 rows without a count: confirms the end with an empty page instead of stopping early", async () => {
      const db = install({ medications: buildManyMedications(1000) });
      db.countSupported = false;
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications")));
      expect(list).toHaveLength(1000);
      expect(db.callsTo("medications", "select")).toHaveLength(2);
    });

    it("a server cap BELOW the page size (500) cannot be mistaken for the last page", async () => {
      const db = install({ medications: buildManyMedications(1200), maxRows: 500 });
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications")));
      expect(list).toHaveLength(1200);
      expect(new Set(list.map((m) => m.id)).size).toBe(1200);
      expect(db.callsTo("medications", "select").map((c) => c.range)).toEqual([
        [0, 999],
        [500, 1499],
        [1000, 1999],
      ]);
    });

    // Regression (review finding): with a server cap below the page size AND no total, the loop used to treat the
    // first short page as the last one and answered 200 with only the first `cap` rows ("inventory disappeared").
    it.each<[number, number]>([
      [100, 1500],
      [500, 1200],
      [999, 2500],
      [1, 7],
      [1000, 2345],
    ])("server cap %i, %i rows, NO count: every row comes back once (a short page is not the end)", async (cap, rows) => {
      const db = install({ medications: buildManyMedications(rows), maxRows: cap });
      db.countSupported = false;
      const res = await medicationsRoute.GET(req("GET", "/api/medications"));
      expect(res.status).toBe(200);
      const list = await readJson<Medication[]>(res);
      expect(list).toHaveLength(rows);
      expect(new Set(list.map((m) => m.id)).size).toBe(rows);
      const names = list.map((m) => m.name as string);
      expect(names).toEqual([...names].sort());
      // full pages of min(cap, 1000) rows, then ONE empty page that proves the end
      expect(db.callsTo("medications", "select")).toHaveLength(Math.ceil(rows / Math.min(cap, PAGE_SIZE)) + 1);
    });

    it.each<[number, number]>([
      [100, 1500],
      [500, 1200],
      [999, 2500],
    ])("server cap %i, %i rows, count available: every row once and no extra request", async (cap, rows) => {
      const db = install({ medications: buildManyMedications(rows), maxRows: cap });
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications")));
      expect(list).toHaveLength(rows);
      expect(new Set(list.map((m) => m.id)).size).toBe(rows);
      expect(db.callsTo("medications", "select")).toHaveLength(Math.ceil(rows / Math.min(cap, PAGE_SIZE)));
    });

    it("a server cap below the page size with NO count never ends early when a filter is active either", async () => {
      const rows = buildManyMedications(1500);
      const db = install({ medications: rows, maxRows: 100 });
      db.countSupported = false;
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications?category=none")));
      expect(list).toHaveLength(rows.filter((m) => m.category_id === null).length);
    });

    // Regression (review finding): without the empty-page check a count that overstates what is left (rows deleted
    // while the list is being read) made the loop re-ask for the same offset until it hit 50 pages and answered 500.
    it.each<[string, number, number]>([
      ["every row after the first page is deleted", 1000, 2],
      ["half of what the second page would have held is deleted", 1500, 3],
    ])("rows deleted between pages, so the first count overstates what is left: %s", async (_label, keep, expectedRequests) => {
      const db = install({ medications: buildManyMedications(2100) });
      db.onSelect = (index, d) => {
        if (index === 1) d.tables.medications = d.tables.medications.filter((m) => (m.id as number) <= 10_000 + keep);
      };
      const res = await medicationsRoute.GET(req("GET", "/api/medications"));
      expect(res.status).toBe(200);
      const list = await readJson<Medication[]>(res);
      expect(list).toHaveLength(keep);
      expect(new Set(list.map((m) => m.id)).size).toBe(keep);
      expect(db.callsTo("medications", "select")).toHaveLength(expectedRequests);
    });

    // The de-duplication is by row id. Two DIFFERENT items can share a name (85 of the 128 live names contain commas
    // or quotes, so look-alikes are plausible); dropping one of them would make an item vanish from the list.
    it("two different items with the same name are both listed (de-duplication is by id, not by name)", async () => {
      const rows = buildMedications();
      rows[1].name = rows[0].name;
      install({ medications: rows });
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications")));
      expect(list).toHaveLength(SEED_COUNT);
      expect(list.filter((m) => m.name === rows[0].name).map((m) => m.id).sort()).toEqual([rows[0].id, rows[1].id].sort());
    });

    it("two different items with the same name on either side of a page boundary are both listed", async () => {
      const rows = buildManyMedications(1001);
      const [a, b] = [rows[999], rows[1000]];
      a.name = b.name = "Twin item, 10 mg"; // sorts after the 999 other rows: one twin ends page 1, the other starts page 2
      const db = install({ medications: rows });
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications")));
      expect(list).toHaveLength(1001);
      expect(list.filter((m) => m.name === "Twin item, 10 mg").map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
      expect(db.callsTo("medications", "select")).toHaveLength(2);
    });

    it("(test double) a change made by the onSelect hook is visible to the very request that triggered it", async () => {
      const db = install();
      db.onSelect = (index, d) => {
        if (index === 0) d.tables.medications = d.tables.medications.slice(1); // replaces the array, like the deletion tests do
      };
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications")));
      expect(list).toHaveLength(SEED_COUNT - 1);
    });

    it("drops a duplicate when rows shift between pages (offset paging) and loses none of the original rows", async () => {
      const original = buildManyMedications(2100);
      const db = install({ medications: original });
      db.onSelect = (index, d) => {
        if (index === 1) {
          // a new row sorting first arrives between page 1 and page 2: everything shifts down by one
          d.tables.medications.push({ ...original[0], id: 999_999, name: "AAA arrived between pages", barcode: "000000000000-new" });
        }
      };
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications")));
      const ids = list.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length); // no duplicates
      for (const m of original) expect(ids).toContain(m.id); // none of the original rows missing
    });

    it("exactly 50 pages (50,000 rows) is allowed", async () => {
      const rows = Array.from({ length: 50_000 }, (_, i) => ({ id: i + 1, name: `Item ${String(i).padStart(6, "0")}`, barcode: String(i).padStart(12, "0") }));
      const db = install({ medications: rows as unknown as Medication[] });
      const res = await medicationsRoute.GET(req("GET", "/api/medications"));
      expect(res.status).toBe(200);
      expect((await readJson<Medication[]>(res)).length).toBe(50_000);
      expect(db.callsTo("medications", "select")).toHaveLength(50);
    }, 60_000);

    it("more than 50 pages: 500 'Inventory is too large…' and never a 51st request", async () => {
      const rows = Array.from({ length: 50_001 }, (_, i) => ({ id: i + 1, name: `Item ${String(i).padStart(6, "0")}`, barcode: String(i).padStart(12, "0") }));
      const db = install({ medications: rows as unknown as Medication[] });
      const res = await medicationsRoute.GET(req("GET", "/api/medications"));
      expect(res.status).toBe(500);
      expect(await readJson(res)).toEqual({ error: "Inventory is too large to load in one request" });
      expect(db.callsTo("medications", "select")).toHaveLength(50);
    }, 60_000);
  });

  describe("errors are never turned into an empty list", () => {
    it("unreachable database -> 503", async () => {
      const db = install();
      db.failOn("medications", "select", NETWORK_ERROR);
      const res = await medicationsRoute.GET(req("GET", "/api/medications"));
      expect(res.status).toBe(503);
      const body = await readJson(res);
      expect(Array.isArray(body)).toBe(false);
      expect(body.error).toBe(UNREACHABLE);
    });

    it("unexpected error -> 500 with the code", async () => {
      const db = install();
      db.failOn("medications", "select", pg("XX000", "boom"));
      const res = await medicationsRoute.GET(req("GET", "/api/medications"));
      expect(res.status).toBe(500);
      expect(await readJson(res)).toMatchObject({ error: "Unexpected database error.", code: "XX000" });
    });

    it("a failure on the SECOND page returns the error, not the first page as if it were everything", async () => {
      const db = install({ medications: buildManyMedications(2345) });
      db.failOn("medications", "select", NETWORK_ERROR, { skip: 1 });
      const res = await medicationsRoute.GET(req("GET", "/api/medications"));
      expect(res.status).toBe(503);
      expect(Array.isArray(await readJson(res))).toBe(false);
    });

    it("an expired/invalid API key -> 500 with a clear message", async () => {
      const db = install();
      db.failOn("medications", "select", pg("PGRST301", "JWSError JWSInvalidSignature"));
      const res = await medicationsRoute.GET(req("GET", "/api/medications"));
      expect(res.status).toBe(500);
      expect((await readJson(res)).error).toBe("The database rejected the app’s API key.");
    });
  });

  describe("query parameters", () => {
    it("lowStock=true keeps only stock <= threshold (after reading every page)", async () => {
      const meds = buildMedications();
      install({ medications: meds });
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications?lowStock=true")));
      const expected = meds.filter((m) => m.stock <= m.threshold).map((m) => m.id).sort();
      expect(list.map((m) => m.id).sort()).toEqual(expected);
      expect(list.every((m) => m.stock <= m.threshold)).toBe(true);
    });

    it("lowStock sees low-stock items beyond the first 1000 rows", async () => {
      const rows = buildManyMedications(2345);
      install({ medications: rows });
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications?lowStock=true")));
      expect(list.length).toBe(rows.filter((m) => m.stock <= m.threshold).length);
    });

    it("unnamed=true filters on is_unnamed", async () => {
      const db = install();
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications?unnamed=true")));
      expect(list).toHaveLength(SEED_UNNAMED_COUNT);
      expect(list.every((m) => m.is_unnamed)).toBe(true);
      expect(db.callsTo("medications", "select")[0].eq).toEqual([["is_unnamed", true]]);
    });

    it("category=<uuid> filters by that category (uppercase is accepted)", async () => {
      const db = install();
      const id = fakeUuid(3); // Antibiotics
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", `/api/medications?category=${id.toUpperCase()}`)));
      expect(list.length).toBe(inSeedCategory(id));
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((m) => m.category_id === id)).toBe(true);
      expect(db.callsTo("medications", "select")[0].eq).toEqual([["category_id", id]]);
    });

    it("category=<digits> filters by a bigint category and answers with string ids", async () => {
      const db = install({ shape: "bigint" });
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications?category=3")));
      expect(list.length).toBe(inSeedCategory("3", "bigint"));
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((m) => m.category_id === "3")).toBe(true);
      expect(db.callsTo("medications", "select")[0].eq).toEqual([["category_id", "3"]]); // sent as a string, never Number()
    });

    it("category=none returns only uncategorized items using IS NULL", async () => {
      const db = install();
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications?category=none")));
      expect(list).toHaveLength(SEED_UNCATEGORIZED_COUNT);
      expect(list.every((m) => m.category_id === null)).toBe(true);
      const [call] = db.callsTo("medications", "select");
      expect(call.is).toEqual([["category_id", null]]);
      expect(call.eq).toEqual([]);
    });

    it.each(["None", "NONE", " none ", "\tNoNe\n"])("category=%j (any case, padded) also means 'uncategorized'", async (value) => {
      const db = install();
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", `/api/medications?category=${encodeURIComponent(value)}`)));
      expect(list).toHaveLength(SEED_UNCATEGORIZED_COUNT);
      expect(list.every((m) => m.category_id === null)).toBe(true);
      const [call] = db.callsTo("medications", "select");
      expect(call.is).toEqual([["category_id", null]]);
      expect(call.eq).toEqual([]);
    });

    it("category=none can be combined with other filters", async () => {
      install();
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications?category=none&lowStock=true")));
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((m) => m.category_id === null && m.stock <= m.threshold)).toBe(true);
    });

    it("an empty category parameter means no filter", async () => {
      const db = install();
      const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications?category=")));
      expect(list).toHaveLength(SEED_COUNT);
      expect(db.callsTo("medications", "select")[0].eq).toEqual([]);
    });

    it.each(["NaN", "undefined", "null", "0", "-1", "1.5", "abc", "1;drop", "1 2"])("rejects category=%s with 400 before reading", async (value) => {
      const db = install();
      const res = await medicationsRoute.GET(req("GET", `/api/medications?category=${encodeURIComponent(value)}`));
      expect(res.status).toBe(400);
      expect(await readJson(res)).toMatchObject({ field: "category" });
      expect(db.calls).toHaveLength(0);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("POST /api/medications", () => {
  it("creates an unnamed item from a barcode scan (the existing scan body) with the documented defaults", async () => {
    const db = install();
    const res = await medicationsRoute.POST(
      req("POST", "/api/medications", { name: null, barcode: "0049000099999", stock: 0, threshold: 10, unit: "units", is_unnamed: true })
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const created = await readJson<Medication>(res);
    expect(created).toMatchObject({
      name: null,
      barcode: "0049000099999",
      stock: 0,
      threshold: 10,
      unit: "units",
      notes: null,
      photo_url: null,
      vendor_url: null,
      category_id: null,
      supplier_order_number: null,
      is_unnamed: true,
    });
    expect(typeof created.id).toBe("number");
    const [insert] = db.callsTo("medications", "insert");
    expect(insert.columns).toBe("*");
    // no supplier column in the payload unless the client supplied one
    expect("supplier_order_number" in (insert.payload ?? {})).toBe(false);
  });

  it("applies the defaults when only a barcode is sent", async () => {
    install();
    const created = await readJson<Medication>(await medicationsRoute.POST(req("POST", "/api/medications", { barcode: "ABC-1" })));
    expect(created).toMatchObject({ name: null, stock: 0, threshold: 10, unit: "units", is_unnamed: false, category_id: null });
  });

  it("saves every field, trimming text and keeping the category and supplier number exactly", async () => {
    const db = install();
    const categoryId = fakeUuid(3);
    const res = await medicationsRoute.POST(
      req("POST", "/api/medications", {
        name: '  Gauze pads 4"x4", sterile ',
        barcode: " 0001234 ",
        stock: 5,
        threshold: 2,
        unit: " box ",
        notes: "Top shelf\nsecond line",
        vendor_url: "https://example.invalid/gauze",
        photo_url: "",
        category_id: categoryId.toUpperCase(),
        supplier_order_number: " 00417-B ",
      })
    );
    expect(res.status).toBe(201);
    const created = await readJson<Medication>(res);
    expect(created).toMatchObject({
      name: 'Gauze pads 4"x4", sterile',
      barcode: "0001234",
      stock: 5,
      threshold: 2,
      unit: "box",
      notes: "Top shelf\nsecond line",
      vendor_url: "https://example.invalid/gauze",
      photo_url: null,
      category_id: categoryId,
      supplier_order_number: "00417-B",
    });
    expect(dbRow(db, created.id).category_id).toBe(categoryId);
  });

  it("an item created with a category and supplier number is still there, unchanged, on the next list", async () => {
    install();
    const categoryId = fakeUuid(2);
    const created = await readJson<Medication>(
      await medicationsRoute.POST(req("POST", "/api/medications", { barcode: "NEW-1", name: "New thing", category_id: categoryId, supplier_order_number: "0092" }))
    );
    const list = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications")));
    const found = list.find((m) => m.id === created.id);
    expect(found).toMatchObject({ category_id: categoryId, supplier_order_number: "0092" });
    const filtered = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", `/api/medications?category=${categoryId}`)));
    expect(filtered.some((m) => m.id === created.id)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["a numeric-string id", "2"],
    ["a number id", 2],
  ])("accepts %s for a bigint category and returns it as a string", async (_label, categoryId) => {
    const db = install({ shape: "bigint" });
    const res = await medicationsRoute.POST(req("POST", "/api/medications", { barcode: "B-1", category_id: categoryId }));
    expect(res.status).toBe(201);
    const created = await readJson<Medication>(res);
    expect(created.category_id).toBe("2");
    expect(db.callsTo("medications", "insert")[0].payload?.category_id).toBe("2"); // sent as a string
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["empty", ""],
    ["blank", "   "],
  ])("a %s unit is stored as 'units': the column is NOT NULL, so the database must never receive null", async (_label, unit) => {
    const db = install();
    const res = await medicationsRoute.POST(req("POST", "/api/medications", { barcode: "UNIT-1", unit }));
    expect(res.status).toBe(201);
    expect(db.callsTo("medications", "insert")[0].payload?.unit).toBe("units");
    expect(dbRow(db, (await readJson<Medication>(res)).id).unit).toBe("units");
  });

  it("keeps the notes exactly as typed (spaces and line breaks are not trimmed); all-blank notes mean no notes", async () => {
    const db = install();
    const kept = await readJson<Medication>(
      await medicationsRoute.POST(req("POST", "/api/medications", { barcode: "NOTES-1", notes: "  a \n b  " }))
    );
    expect(kept.notes).toBe("  a \n b  ");
    expect(dbRow(db, kept.id).notes).toBe("  a \n b  ");
    const blank = await readJson<Medication>(await medicationsRoute.POST(req("POST", "/api/medications", { barcode: "NOTES-2", notes: "  \n " })));
    expect(blank.notes).toBeNull();
  });

  it("keeps a supplier number's leading zeros and punctuation", async () => {
    install();
    for (const code of ["0092", "000000", "00-1.50", "AX-1182/4", "1E5", "12345678901234567890"]) {
      const created = await readJson<Medication>(
        await medicationsRoute.POST(req("POST", "/api/medications", { barcode: `S-${code}`, supplier_order_number: code }))
      );
      expect(created.supplier_order_number).toBe(code);
    }
  });

  it.each<[string, unknown]>([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["blank", "   "],
  ])("does not send the supplier column when it is %s (creating items works before the migration)", async (_label, value) => {
    const db = install({ supplierColumn: false });
    const body: Record<string, unknown> = { barcode: "PRE-1", name: "Pre-migration item" };
    if (value !== undefined) body.supplier_order_number = value;
    const res = await medicationsRoute.POST(req("POST", "/api/medications", body));
    expect(res.status).toBe(201);
    expect((await readJson<Medication>(res)).supplier_order_number).toBeNull();
    expect("supplier_order_number" in (db.callsTo("medications", "insert")[0].payload ?? {})).toBe(false);
  });

  it("before the migration, a supplier number is refused with the clear 409 message", async () => {
    const db = install({ supplierColumn: false });
    const res = await medicationsRoute.POST(req("POST", "/api/medications", { barcode: "PRE-2", supplier_order_number: "0092" }));
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ error: SUPPLIER_COLUMN_MISSING, field: "supplier_order_number" });
    expect(db.tables.medications.some((m) => m.barcode === "PRE-2")).toBe(false);
  });

  it("ignores keys that are not writable (id, timestamps, unknown)", async () => {
    const db = install();
    const res = await medicationsRoute.POST(
      req("POST", "/api/medications", { barcode: "X-1", id: 7, created_at: "2000-01-01", updated_at: "2000-01-01", role: "admin", __proto__: { evil: 1 } })
    );
    expect(res.status).toBe(201);
    expect(Object.keys(db.callsTo("medications", "insert")[0].payload ?? {}).sort()).toEqual(
      ["barcode", "category_id", "is_unnamed", "name", "notes", "photo_url", "stock", "threshold", "unit", "vendor_url"]
    );
    expect((await readJson<Medication>(res)).id).not.toBe(7);
  });

  it("treats real '__proto__' / 'constructor' JSON keys as ordinary ignored keys", async () => {
    const db = install();
    const raw = '{"barcode":"P-1","__proto__":{"evil":1},"constructor":{"x":1},"toString":"nope","hasOwnProperty":1}';
    const res = await medicationsRoute.POST(req("POST", "/api/medications", raw));
    expect(res.status).toBe(201);
    const payload = db.callsTo("medications", "insert")[0].payload ?? {};
    expect(Object.keys(payload)).not.toContain("__proto__");
    expect(Object.keys(payload)).not.toContain("constructor");
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });

  it("accepts a 128 character barcode", async () => {
    install();
    const res = await medicationsRoute.POST(req("POST", "/api/medications", { barcode: "9".repeat(128) }));
    expect(res.status).toBe(201);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["missing barcode", {}, "barcode"],
    ["null barcode", { barcode: null }, "barcode"],
    ["blank barcode", { barcode: "   " }, "barcode"],
    ["numeric barcode (leading zeros would be lost)", { barcode: 12345 }, "barcode"],
    ["129 character barcode", { barcode: "9".repeat(129) }, "barcode"],
    ["NUL in barcode", { barcode: `12${cp(0)}34` }, "barcode"],
    ["negative stock", { barcode: "1", stock: -1 }, "stock"],
    ["fractional stock", { barcode: "1", stock: 1.5 }, "stock"],
    ["string stock", { barcode: "1", stock: "5" }, "stock"],
    ["null stock", { barcode: "1", stock: null }, "stock"],
    ["NaN stock (serialized as null)", { barcode: "1", stock: NaN }, "stock"],
    ["stock above the INTEGER column", { barcode: "1", stock: 2_147_483_648 }, "stock"],
    ["negative threshold", { barcode: "1", threshold: -5 }, "threshold"],
    ["fractional threshold", { barcode: "1", threshold: 0.5 }, "threshold"],
    ["null threshold", { barcode: "1", threshold: null }, "threshold"],
    ["category 'NaN'", { barcode: "1", category_id: "NaN" }, "category_id"],
    ["category 'undefined'", { barcode: "1", category_id: "undefined" }, "category_id"],
    ["category 0", { barcode: "1", category_id: 0 }, "category_id"],
    ["category '0'", { barcode: "1", category_id: "0" }, "category_id"],
    ["category -1", { barcode: "1", category_id: -1 }, "category_id"],
    ["category object", { barcode: "1", category_id: {} }, "category_id"],
    ["category array", { barcode: "1", category_id: [fakeUuid(1)] }, "category_id"],
    ["category true", { barcode: "1", category_id: true }, "category_id"],
    ["category text", { barcode: "1", category_id: "antibiotics" }, "category_id"],
    ["numeric supplier number", { barcode: "1", supplier_order_number: 92 }, "supplier_order_number"],
    ["object supplier number", { barcode: "1", supplier_order_number: { v: "1" } }, "supplier_order_number"],
    ["supplier number with a line break", { barcode: "1", supplier_order_number: "A\nB" }, "supplier_order_number"],
    ["supplier number with a zero-width space", { barcode: "1", supplier_order_number: `A${cp(0x200b)}B` }, "supplier_order_number"],
    ["65 character supplier number", { barcode: "1", supplier_order_number: "A".repeat(65) }, "supplier_order_number"],
    ["numeric name", { barcode: "1", name: 5 }, "name"],
    ["object name", { barcode: "1", name: {} }, "name"],
    ["NUL in name", { barcode: "1", name: `a${cp(0)}b` }, "name"],
    ["numeric unit", { barcode: "1", unit: 5 }, "unit"],
    ["numeric notes", { barcode: "1", notes: 5 }, "notes"],
    ["numeric vendor_url", { barcode: "1", vendor_url: 5 }, "vendor_url"],
    ["numeric photo_url", { barcode: "1", photo_url: 5 }, "photo_url"],
    ["is_unnamed as text", { barcode: "1", is_unnamed: "yes" }, "is_unnamed"],
    ["is_unnamed as number", { barcode: "1", is_unnamed: 1 }, "is_unnamed"],
  ])("rejects %s with 400 and a field, without touching the database", async (_label, body, field) => {
    const db = install();
    const res = await medicationsRoute.POST(req("POST", "/api/medications", body));
    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.field).toBe(field);
    expect(typeof json.error).toBe("string");
    expect(String(json.error).length).toBeGreaterThan(5);
    expect(db.calls).toHaveLength(0);
  });

  it.each<[string, unknown]>([
    ["invalid JSON", "{not json"],
    ["an array", "[]"],
    ["a string", '"abc"'],
    ["null", "null"],
    ["a number", "42"],
  ])("rejects a body that is %s with 400", async (_label, body) => {
    const db = install();
    const res = await medicationsRoute.POST(req("POST", "/api/medications", body));
    expect(res.status).toBe(400);
    expect(db.calls).toHaveLength(0);
  });

  it("duplicate barcode -> 409 'Barcode already exists' (the scanner's race path depends on this status)", async () => {
    const db = install();
    const existing = db.tables.medications[0].barcode as string;
    const res = await medicationsRoute.POST(req("POST", "/api/medications", { barcode: existing, is_unnamed: true }));
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toBe("Barcode already exists");
  });

  it("a category that no longer exists -> 400 with a message staff can act on", async () => {
    install();
    const res = await medicationsRoute.POST(req("POST", "/api/medications", { barcode: "FK-1", category_id: fakeUuid(999) }));
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({ error: NO_SUCH_CATEGORY, field: "category_id" });
  });

  it("row-level security refusal -> 403", async () => {
    const db = install();
    db.failOn("medications", "insert", RLS_ERROR);
    const res = await medicationsRoute.POST(req("POST", "/api/medications", { barcode: "RLS-1" }));
    expect(res.status).toBe(403);
    expect(await readJson(res)).toMatchObject({ error: "The database refused this change (row-level security).", code: "42501" });
  });

  it("unreachable database -> 503; unexpected error -> 500", async () => {
    const db = install();
    db.failOn("medications", "insert", NETWORK_ERROR);
    expect((await medicationsRoute.POST(req("POST", "/api/medications", { barcode: "NET-1" }))).status).toBe(503);
    db.failOn("medications", "insert", pg("XX000", "boom"));
    expect((await medicationsRoute.POST(req("POST", "/api/medications", { barcode: "NET-2" }))).status).toBe(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("PUT /api/medications/[id] (partial update)", () => {
  const ID = 101; // "Ibuprofen 200 mg, tablets": category #1 (Pain & Fever), supplier "0092", stock 18/40

  it("updates every field and returns the saved row, normalized", async () => {
    const db = install();
    const newCategory = fakeUuid(2);
    const response = await medicationRoute.PUT(
      req("PUT", `/api/medications/${ID}`, {
        name: "  Ibuprofen 400 mg, tablets ",
        barcode: dbRow(db, ID).barcode,
        stock: 30,
        threshold: 12,
        unit: "tablets",
        notes: "moved",
        vendor_url: "https://example.invalid/ibu",
        photo_url: "https://example.invalid/ibu.jpg",
        category_id: newCategory,
        supplier_order_number: "0093-X",
      }),
      idParams(String(ID))
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const saved = await readJson<Medication>(response);
    expect(saved).toMatchObject({
      id: ID,
      name: "Ibuprofen 400 mg, tablets",
      stock: 30,
      threshold: 12,
      unit: "tablets",
      notes: "moved",
      vendor_url: "https://example.invalid/ibu",
      photo_url: "https://example.invalid/ibu.jpg",
      category_id: newCategory,
      supplier_order_number: "0093-X",
      is_unnamed: false,
    });
    expect(dbRow(db, ID).category_id).toBe(newCategory);
    expect(db.callsTo("medications", "update")[0].eq).toEqual([["id", ID]]);
  });

  describe("an unrelated edit never clears the category (the reported bug)", () => {
    it.each<IdShape>(["uuid", "bigint"])("%s ids: editing only the name keeps category, supplier number and stock", async (shape) => {
      const db = install({ shape });
      const before = { ...dbRow(db, ID) };
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { name: "Renamed only" }), idParams(String(ID)));
      expect(res.status).toBe(200);
      const saved = await readJson<Medication>(res);
      expect(saved.name).toBe("Renamed only");
      expect(saved.category_id).toBe(String(before.category_id));
      expect(saved.supplier_order_number).toBe("0092");
      expect(saved.stock).toBe(18);
      expect(saved.threshold).toBe(40);
      // only the sent key (plus the unnamed flag) reached the database
      expect(Object.keys(db.callsTo("medications", "update")[0].payload ?? {}).sort()).toEqual(["is_unnamed", "name"]);
      // and a reload shows the same thing
      const reloaded = await readJson<Medication>(await medicationRoute.GET(req("GET", `/api/medications/${ID}`), idParams(String(ID))));
      expect(reloaded.category_id).toBe(String(before.category_id));
      expect(reloaded.name).toBe("Renamed only");
    });

    it("a body that omits category_id (as the old admin form effectively did) leaves it untouched", async () => {
      const db = install();
      const categoryBefore = dbRow(db, ID).category_id;
      await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { stock: 99, threshold: 5, unit: "units" }), idParams(String(ID)));
      expect(dbRow(db, ID).category_id).toBe(categoryBefore);
      expect("category_id" in (db.callsTo("medications", "update")[0].payload ?? {})).toBe(false);
    });

    it("editing every non-category field in one request still leaves the category alone", async () => {
      const db = install();
      const categoryBefore = dbRow(db, ID).category_id;
      await medicationRoute.PUT(
        req("PUT", `/api/medications/${ID}`, { name: "N", barcode: "0012345600007", photo_url: null, stock: 1, threshold: 1, vendor_url: null, unit: "box", notes: null }),
        idParams(String(ID))
      );
      expect(dbRow(db, ID).category_id).toBe(categoryBefore);
    });
  });

  describe("category changes", () => {
    it("an explicit null clears the category", async () => {
      const db = install();
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { category_id: null }), idParams(String(ID)));
      expect(res.status).toBe(200);
      const saved = await readJson<Medication>(res);
      expect(saved.category_id).toBeNull();
      expect(dbRow(db, ID).category_id).toBeNull();
      expect(saved.name).toBe("Ibuprofen 200 mg, tablets"); // nothing else changed
      expect(saved.supplier_order_number).toBe("0092");
    });

    it("an empty string also clears it (the select's 'Uncategorized' option)", async () => {
      const db = install();
      await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { category_id: "" }), idParams(String(ID)));
      expect(dbRow(db, ID).category_id).toBeNull();
    });

    it("moving an item to another category shows up in that category's list", async () => {
      install();
      const target = fakeUuid(6);
      await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { category_id: target }), idParams(String(ID)));
      const inTarget = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", `/api/medications?category=${target}`)));
      expect(inTarget.some((m) => m.id === ID)).toBe(true);
      const inOld = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", `/api/medications?category=${fakeUuid(1)}`)));
      expect(inOld.some((m) => m.id === ID)).toBe(false);
    });

    it("assigning a category to a previously uncategorized (legacy) item works", async () => {
      const db = install();
      const legacy = db.tables.medications.find((m) => m.category_id === null && m.name !== null)!;
      const target = fakeUuid(4);
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${legacy.id}`, { category_id: target }), idParams(String(legacy.id)));
      expect(res.status).toBe(200);
      expect((await readJson<Medication>(res)).category_id).toBe(target);
    });

    it.each<[string, unknown]>([
      ["a numeric string", "3"],
      ["a number", 3],
    ])("bigint ids: %s is accepted and answered as a string", async (_label, categoryId) => {
      const db = install({ shape: "bigint" });
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { category_id: categoryId }), idParams(String(ID)));
      expect(res.status).toBe(200);
      expect((await readJson<Medication>(res)).category_id).toBe("3");
      expect(db.callsTo("medications", "update")[0].payload?.category_id).toBe("3");
    });

    it("an uppercase UUID is stored lowercase", async () => {
      const db = install();
      const target = fakeUuid(5);
      await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { category_id: target.toUpperCase() }), idParams(String(ID)));
      expect(dbRow(db, ID).category_id).toBe(target);
    });

    it.each<[string, unknown]>([
      ["'NaN'", "NaN"],
      ["'undefined'", "undefined"],
      ["0", 0],
      ["an object", {}],
      ["free text", "antibiotics"],
    ])("rejects category_id %s with 400 and leaves the stored category alone", async (_label, bad) => {
      const db = install();
      const before = dbRow(db, ID).category_id;
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { category_id: bad }), idParams(String(ID)));
      expect(res.status).toBe(400);
      expect((await readJson(res)).field).toBe("category_id");
      expect(db.calls).toHaveLength(0);
      expect(dbRow(db, ID).category_id).toBe(before);
    });

    it("a category that does not exist -> 400 and the stored category is unchanged", async () => {
      const db = install();
      const before = dbRow(db, ID).category_id;
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { category_id: fakeUuid(999) }), idParams(String(ID)));
      expect(res.status).toBe(400);
      expect(await readJson(res)).toMatchObject({ error: NO_SUCH_CATEGORY, field: "category_id" });
      expect(dbRow(db, ID).category_id).toBe(before);
    });
  });

  describe("supplier order number", () => {
    it("is stored exactly as typed (leading zeros, letters, punctuation) and returned", async () => {
      const db = install();
      for (const code of ["000417-B", "0092", "AX-1182/4", "1E5", "00-1.50"]) {
        const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { supplier_order_number: ` ${code} ` }), idParams(String(ID)));
        expect(res.status).toBe(200);
        expect((await readJson<Medication>(res)).supplier_order_number).toBe(code);
        expect(dbRow(db, ID).supplier_order_number).toBe(code);
      }
    });

    it("an explicit null (or blank) clears it; omitting it never does", async () => {
      const db = install();
      await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { name: "Only the name" }), idParams(String(ID)));
      expect(dbRow(db, ID).supplier_order_number).toBe("0092");
      expect(Object.keys(db.callsTo("medications", "update")[0].payload ?? {})).not.toContain("supplier_order_number");
      await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { supplier_order_number: null }), idParams(String(ID)));
      expect(dbRow(db, ID).supplier_order_number).toBeNull();
      await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { supplier_order_number: "0092" }), idParams(String(ID)));
      await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { supplier_order_number: "   " }), idParams(String(ID)));
      expect(dbRow(db, ID).supplier_order_number).toBeNull();
    });

    it("is independent of the barcode and the name", async () => {
      const db = install();
      const barcode = dbRow(db, ID).barcode;
      await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { supplier_order_number: "SUP-1" }), idParams(String(ID)));
      expect(dbRow(db, ID).barcode).toBe(barcode);
      expect(dbRow(db, ID).name).toBe("Ibuprofen 200 mg, tablets");
    });

    it.each<[string, unknown]>([
      ["a number", 92],
      ["a line break", "A\nB"],
      ["65 characters", "A".repeat(65)],
      ["an object", {}],
    ])("rejects %s with 400", async (_label, value) => {
      const db = install();
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { supplier_order_number: value }), idParams(String(ID)));
      expect(res.status).toBe(400);
      expect((await readJson(res)).field).toBe("supplier_order_number");
      expect(dbRow(db, ID).supplier_order_number).toBe("0092");
    });

    it("before the migration: edits that do not mention it still work", async () => {
      const db = install({ supplierColumn: false });
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { name: "Edited before migration", stock: 7 }), idParams(String(ID)));
      expect(res.status).toBe(200);
      expect((await readJson<Medication>(res)).supplier_order_number).toBeNull();
      expect("supplier_order_number" in (db.callsTo("medications", "update")[0].payload ?? {})).toBe(false);
    });

    it.each<[string, unknown]>([
      ["a value", "A-1"],
      ["null", null],
    ])("before the migration: sending %s -> 409 with the migration message and nothing else saved", async (_label, value) => {
      const db = install({ supplierColumn: false });
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { name: "Should not save", supplier_order_number: value }), idParams(String(ID)));
      expect(res.status).toBe(409);
      expect(await readJson(res)).toMatchObject({ error: SUPPLIER_COLUMN_MISSING, field: "supplier_order_number" });
      expect(dbRow(db, ID).name).toBe("Ibuprofen 200 mg, tablets");
    });
  });

  describe("other fields", () => {
    it("every successful edit clears the 'unnamed' review flag", async () => {
      const db = install();
      const unnamed = db.tables.medications.find((m) => m.is_unnamed === true)!;
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${unnamed.id}`, { name: "Now named" }), idParams(String(unnamed.id)));
      expect(res.status).toBe(200);
      expect((await readJson<Medication>(res)).is_unnamed).toBe(false);
      expect(unnamed.is_unnamed).toBe(false);
    });

    // CONTRACT, not an accident (SPEC 2.6, and the original route: "any admin edit clears the unnamed flag"): the flag
    // means "created by a scan, nobody has looked at it yet", so ANY successful edit counts as the review, including
    // one that never touches the name. The admin form is the only caller and always sends the whole form. Open
    // product decision (see the handoff): narrowing this to "only when a name is supplied" would keep an item in the
    // review queue after an unrelated edit, but staff could then never dismiss an item they choose not to name.
    it("an edit that does not touch the name also takes an unnamed item out of the review queue (documented contract)", async () => {
      const db = install();
      const unnamed = db.tables.medications.find((m) => m.is_unnamed === true)!;
      const queueBefore = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications?unnamed=true")));
      expect(queueBefore.map((m) => m.id)).toContain(unnamed.id);
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${unnamed.id}`, { stock: 5 }), idParams(String(unnamed.id)));
      expect(res.status).toBe(200);
      expect(await readJson<Medication>(res)).toMatchObject({ stock: 5, name: null, is_unnamed: false });
      const queueAfter = await readJson<Medication[]>(await medicationsRoute.GET(req("GET", "/api/medications?unnamed=true")));
      expect(queueAfter.map((m) => m.id)).not.toContain(unnamed.id);
    });

    it("a client cannot set is_unnamed, id or timestamps through PUT", async () => {
      const db = install();
      const before = { ...dbRow(db, ID) };
      const res = await medicationRoute.PUT(
        req("PUT", `/api/medications/${ID}`, { name: "N", id: 999999, is_unnamed: true, created_at: "2000-01-01T00:00:00Z", updated_at: "2000-01-01T00:00:00Z", extra: 1 }),
        idParams(String(ID))
      );
      expect(res.status).toBe(200);
      const saved = await readJson<Medication>(res);
      expect(saved.id).toBe(ID);
      expect(saved.is_unnamed).toBe(false);
      expect(dbRow(db, ID).created_at).toBe(before.created_at);
      expect(Object.keys(db.callsTo("medications", "update")[0].payload ?? {}).sort()).toEqual(["is_unnamed", "name"]);
    });

    it("treats real '__proto__' / 'constructor' JSON keys as ordinary ignored keys", async () => {
      const db = install();
      const raw = '{"name":"Safe","__proto__":{"category_id":null},"constructor":{"x":1}}';
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, raw), idParams(String(ID)));
      expect(res.status).toBe(200);
      expect(Object.keys(db.callsTo("medications", "update")[0].payload ?? {}).sort()).toEqual(["is_unnamed", "name"]);
      expect((await readJson<Medication>(res)).category_id).toBe(fakeUuid(1)); // untouched
    });

    it.each<[string, unknown]>([
      ["null", null],
      ["empty", ""],
      ["blank", "   "],
    ])("a %s unit becomes 'units' in the database (never null: the column is NOT NULL)", async (_label, unit) => {
      const db = install();
      dbRow(db, ID).unit = "box";
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { unit }), idParams(String(ID)));
      expect(res.status).toBe(200);
      expect(db.callsTo("medications", "update")[0].payload?.unit).toBe("units");
      expect(dbRow(db, ID).unit).toBe("units");
    });

    it("notes are stored exactly as typed (no trimming); all-blank notes clear them", async () => {
      const db = install();
      await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { notes: "  a \n b  " }), idParams(String(ID)));
      expect(dbRow(db, ID).notes).toBe("  a \n b  ");
      await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { notes: " \n " }), idParams(String(ID)));
      expect(dbRow(db, ID).notes).toBeNull();
    });

    it("explicit nulls clear nullable text columns; blank unit falls back to 'units'", async () => {
      const db = install();
      dbRow(db, ID).notes = "old";
      dbRow(db, ID).vendor_url = "https://example.invalid";
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { notes: null, vendor_url: "", photo_url: null, name: null, unit: "  " }), idParams(String(ID)));
      expect(res.status).toBe(200);
      expect(await readJson<Medication>(res)).toMatchObject({ notes: null, vendor_url: null, photo_url: null, name: null, unit: "units" });
    });

    it.each<[string, Record<string, unknown>, string]>([
      ["null stock (would otherwise reset it to 0)", { stock: null }, "stock"],
      ["string stock", { stock: "5" }, "stock"],
      ["negative stock", { stock: -1 }, "stock"],
      ["fractional threshold", { threshold: 1.5 }, "threshold"],
      ["null barcode", { barcode: null }, "barcode"],
      ["blank barcode", { barcode: "  " }, "barcode"],
      ["numeric barcode", { barcode: 123 }, "barcode"],
      ["129 character barcode", { barcode: "9".repeat(129) }, "barcode"],
      ["numeric name", { name: 5 }, "name"],
    ])("rejects %s with 400 and leaves the row untouched", async (_label, body, field) => {
      const db = install();
      const before = { ...dbRow(db, ID) };
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, body), idParams(String(ID)));
      expect(res.status).toBe(400);
      expect((await readJson(res)).field).toBe(field);
      expect(dbRow(db, ID)).toEqual(before);
      expect(db.calls).toHaveLength(0);
    });

    it("changing the barcode to another item's barcode -> 409", async () => {
      const db = install();
      const other = db.tables.medications[5].barcode as string;
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { barcode: other }), idParams(String(ID)));
      expect(res.status).toBe(409);
      expect((await readJson(res)).error).toBe("Barcode already exists");
    });

    it("re-saving an item with its own barcode is not a conflict", async () => {
      const db = install();
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { barcode: dbRow(db, ID).barcode }), idParams(String(ID)));
      expect(res.status).toBe(200);
    });
  });

  describe("request problems", () => {
    it.each<[string, unknown]>([
      ["an empty object", {}],
      ["only unknown keys", { id: 5, foo: 1, is_unnamed: true }],
      ["only undefined values (dropped by JSON)", { category_id: undefined }],
    ])("%s -> 400 'Nothing to update' and no database call", async (_label, body) => {
      const db = install();
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, body), idParams(String(ID)));
      expect(res.status).toBe(400);
      expect(await readJson(res)).toMatchObject({ error: "Nothing to update" });
      expect(db.calls).toHaveLength(0);
    });

    it.each(["abc", "0", "-1", "1.5", "007", "", " ", "1e3", "NaN", "undefined", "1/2", "12345678901234567890"])(
      "invalid id %j -> 400 and no database call",
      async (id) => {
        const db = install();
        const res = await medicationRoute.PUT(req("PUT", "/api/medications/x", { name: "N" }), idParams(id));
        expect(res.status).toBe(400);
        expect(await readJson(res)).toMatchObject({ field: "id" });
        expect(db.calls).toHaveLength(0);
      }
    );

    it.each(["{not json", "[]", "null", '"text"', "42"])("body %j -> 400", async (body) => {
      const db = install();
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, body), idParams(String(ID)));
      expect(res.status).toBe(400);
      expect(db.calls).toHaveLength(0);
    });

    it("an id that does not exist -> 404 (not a fake success)", async () => {
      install();
      const res = await medicationRoute.PUT(req("PUT", "/api/medications/999999", { name: "Ghost" }), idParams("999999"));
      expect(res.status).toBe(404);
      expect((await readJson(res)).error).toBe(NOT_FOUND);
    });
  });

  describe("database errors are mapped, never reported as success", () => {
    it("row-level security -> 403", async () => {
      const db = install();
      db.failOn("medications", "update", RLS_ERROR);
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { name: "N" }), idParams(String(ID)));
      expect(res.status).toBe(403);
    });

    it("unreachable database -> 503", async () => {
      const db = install();
      db.failOn("medications", "update", NETWORK_ERROR);
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { name: "N" }), idParams(String(ID)));
      expect(res.status).toBe(503);
      expect((await readJson(res)).error).toBe(UNREACHABLE);
    });

    it("unexpected error -> 500 with the code", async () => {
      const db = install();
      db.failOn("medications", "update", pg("XX000", "boom"));
      const res = await medicationRoute.PUT(req("PUT", `/api/medications/${ID}`, { name: "N" }), idParams(String(ID)));
      expect(res.status).toBe(500);
      expect(await readJson(res)).toMatchObject({ code: "XX000" });
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("GET and DELETE /api/medications/[id]", () => {
  it("GET returns the normalized row", async () => {
    install({ shape: "bigint" });
    const res = await medicationRoute.GET(req("GET", "/api/medications/101"), idParams("101"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await readJson<Medication>(res)).toMatchObject({ id: 101, category_id: "1", supplier_order_number: "0092" });
  });

  it("GET of a missing id is 404; a malformed id is 400", async () => {
    install();
    expect((await medicationRoute.GET(req("GET", "/api/medications/5"), idParams("5"))).status).toBe(404);
    expect((await medicationRoute.GET(req("GET", "/api/medications/abc"), idParams("abc"))).status).toBe(400);
  });

  it("GET with an unreachable database is 503, not 404", async () => {
    const db = install();
    db.failOn("medications", "select", NETWORK_ERROR);
    const res = await medicationRoute.GET(req("GET", "/api/medications/101"), idParams("101"));
    expect(res.status).toBe(503);
  });

  it("DELETE removes the row and reports success", async () => {
    const db = install();
    const res = await medicationRoute.DELETE(req("DELETE", "/api/medications/101"), idParams("101"));
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ success: true });
    expect(db.tables.medications.some((m) => m.id === 101)).toBe(false);
    expect(db.tables.medications).toHaveLength(SEED_COUNT - 1);
  });

  it("DELETE only deletes the targeted row", async () => {
    const db = install();
    const call = await medicationRoute.DELETE(req("DELETE", "/api/medications/102"), idParams("102"));
    expect(call.status).toBe(200);
    expect(db.callsTo("medications", "delete")[0].eq).toEqual([["id", 102]]);
    expect(db.tables.medications.some((m) => m.id === 101)).toBe(true);
  });

  it("DELETE of a row that is not there is 404, not a false success", async () => {
    install();
    const res = await medicationRoute.DELETE(req("DELETE", "/api/medications/999999"), idParams("999999"));
    expect(res.status).toBe(404);
    expect((await readJson(res)).error).toBe(NOT_FOUND);
  });

  it("DELETE with a bad id is 400 and deletes nothing", async () => {
    const db = install();
    for (const id of ["abc", "0", "-1", "1.5", "007"]) {
      expect((await medicationRoute.DELETE(req("DELETE", "/api/medications/x"), idParams(id))).status).toBe(400);
    }
    expect(db.mutations).toHaveLength(0);
  });

  it("DELETE errors are mapped (503 / 403 / 500)", async () => {
    const db = install();
    db.failOn("medications", "delete", NETWORK_ERROR);
    expect((await medicationRoute.DELETE(req("DELETE", "/api/medications/101"), idParams("101"))).status).toBe(503);
    db.failOn("medications", "delete", RLS_ERROR);
    expect((await medicationRoute.DELETE(req("DELETE", "/api/medications/101"), idParams("101"))).status).toBe(403);
    db.failOn("medications", "delete", pg("XX000", "boom"));
    expect((await medicationRoute.DELETE(req("DELETE", "/api/medications/101"), idParams("101"))).status).toBe(500);
    expect(db.tables.medications).toHaveLength(SEED_COUNT);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("GET /api/medications/barcode/[code]", () => {
  it("finds an item by barcode and keeps leading zeros", async () => {
    const db = install();
    const res = await barcodeRoute.GET(req("GET", "/api/medications/barcode/x"), codeParams("0049000028911"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const found = await readJson<Medication>(res);
    expect(found.barcode).toBe("0049000028911");
    expect(found.is_unnamed).toBe(true);
    expect(db.mutations).toHaveLength(0);
  });

  it("matches the barcode exactly, like the database: 'med-case-1' does not find 'MED-Case-1'", async () => {
    const db = install();
    db.tables.medications.push({ ...dbRow(db, 101), id: 5100, barcode: "MED-Case-1" });
    const exact = await barcodeRoute.GET(req("GET", "/api/medications/barcode/x"), codeParams("MED-Case-1"));
    expect(exact.status).toBe(200);
    expect((await readJson<Medication>(exact)).id).toBe(5100);
    for (const wrongCase of ["med-case-1", "MED-CASE-1", "Med-Case-1"]) {
      const res = await barcodeRoute.GET(req("GET", "/api/medications/barcode/x"), codeParams(wrongCase));
      expect(res.status, wrongCase).toBe(404);
    }
  });

  it("returns the normalized row (string category id, supplier number)", async () => {
    install({ shape: "bigint" });
    const found = await readJson<Medication>(await barcodeRoute.GET(req("GET", "/api/medications/barcode/x"), codeParams("MED-1003")));
    expect(typeof found.category_id === "string" || found.category_id === null).toBe(true);
    expect("supplier_order_number" in found).toBe(true);
  });

  it("an unknown barcode is 404 'Medication not found' (this is what makes the scanner create a new item)", async () => {
    install();
    const res = await barcodeRoute.GET(req("GET", "/api/medications/barcode/x"), codeParams("9999999999999"));
    expect(res.status).toBe(404);
    expect(await readJson(res)).toEqual({ error: "Medication not found" });
  });

  it("PGRST116 ('no rows') is also a 404", async () => {
    const db = install();
    db.failOn("medications", "select", pg("PGRST116", "JSON object requested, multiple (or no) rows returned", "The result contains 0 rows"));
    const res = await barcodeRoute.GET(req("GET", "/api/medications/barcode/x"), codeParams("whatever"));
    expect(res.status).toBe(404);
  });

  describe("any other failure is NOT a 404 (otherwise the scanner would create a duplicate unnamed item)", () => {
    it("unreachable database -> 503", async () => {
      const db = install();
      db.failOn("medications", "select", NETWORK_ERROR);
      const res = await barcodeRoute.GET(req("GET", "/api/medications/barcode/x"), codeParams("0049000028911"));
      expect(res.status).toBe(503);
      expect((await readJson(res)).error).toBe(UNREACHABLE);
    });

    it("unexpected error -> 500", async () => {
      const db = install();
      db.failOn("medications", "select", pg("XX000", "boom"));
      const res = await barcodeRoute.GET(req("GET", "/api/medications/barcode/x"), codeParams("0049000028911"));
      expect(res.status).toBe(500);
    });

    it("row-level security -> 403", async () => {
      const db = install();
      db.failOn("medications", "select", pg("42501", "permission denied for table medications"));
      const res = await barcodeRoute.GET(req("GET", "/api/medications/barcode/x"), codeParams("0049000028911"));
      expect(res.status).toBe(403);
    });

    it("API key problem -> 500", async () => {
      const db = install();
      db.failOn("medications", "select", pg("PGRST301", "JWT expired"));
      const res = await barcodeRoute.GET(req("GET", "/api/medications/barcode/x"), codeParams("0049000028911"));
      expect(res.status).toBe(500);
    });
  });

  describe("safe decoding of the route parameter", () => {
    it("looks up a barcode containing a stray '%' exactly as received (no URIError, no 500)", async () => {
      const db = install();
      db.tables.medications.push({ ...dbRow(db, 101), id: 5001, barcode: "50%OFF" });
      const res = await barcodeRoute.GET(req("GET", "/api/medications/barcode/x"), codeParams("50%OFF"));
      expect(res.status).toBe(200);
      expect((await readJson<Medication>(res)).id).toBe(5001);
    });

    it("a barcode that literally contains a percent escape ('100%25') is found as stored, not corrupted by a second decode", async () => {
      const db = install();
      db.tables.medications.push({ ...dbRow(db, 101), id: 5002, barcode: "100%25" });
      db.tables.medications.push({ ...dbRow(db, 101), id: 5003, barcode: "100%" });
      const res = await barcodeRoute.GET(req("GET", "/api/medications/barcode/x"), codeParams("100%25"));
      expect((await readJson<Medication>(res)).id).toBe(5002);
      expect(db.callsTo("medications", "select")).toHaveLength(1);
    });

    it("falls back to one extra decode for a caller that encoded twice", async () => {
      const db = install();
      db.tables.medications.push({ ...dbRow(db, 101), id: 5004, barcode: "AB 12" });
      const res = await barcodeRoute.GET(req("GET", "/api/medications/barcode/x"), codeParams("AB%2012"));
      expect(res.status).toBe(200);
      expect((await readJson<Medication>(res)).id).toBe(5004);
    });

    it.each(["%", "%E0%A4%A", "%zz", "a%", "%%%%", "A".repeat(20_000)])("never throws for %j (404 for an unknown code)", async (code) => {
      install();
      const res = await barcodeRoute.GET(req("GET", "/api/medications/barcode/x"), codeParams(code));
      expect(res.status).toBe(404);
    });
  });
});

/**
 * fake-supabase — a faithful in-memory stand-in for the slice of supabase-js / PostgREST / Postgres that this
 * app's API routes use. Synthetic data only; no network; no real Supabase project is ever touched.
 *
 * WHY IT IS "FAITHFUL" (the things that matter for this app's bugs)
 *   * Request bodies are JSON round-tripped exactly like the real client does (`NaN` -> `null`, `undefined` keys
 *     dropped). That is how `Number("<uuid>")` silently turned `category_id` into `null`.
 *   * Filters are serialized to the same PostgREST text the client builds (`eq.NaN`, `in.(1,2)`, `is.null`) and are
 *     parsed/typed against the column, so `.eq("category_id", NaN)` on a uuid column is a 22P02 like in production.
 *   * Columns are typed. `categoryIdType: "uuid"` (live DB) vs `"bigint"` (supabase/schema.sql): invalid text ->
 *     22P02, numeric strings are accepted for bigint, reads return strings (uuid) or numbers (bigint).
 *   * Row-level security per table and operation (see "RLS" below), including the Postgres rules that INSERT ..
 *     RETURNING and UPDATE/DELETE with a WHERE clause also need SELECT access.
 *   * Constraints: unique(barcode), unique(categories.name) (case-SENSITIVE like Postgres), FK
 *     medications.category_id -> categories.id (restrict by default = the live DB), transactions.medication_id ->
 *     medications.id ON DELETE CASCADE, NOT NULL, defaults, CHECKs, `updated_at` trigger, sequence gaps.
 *   * `.single()` -> PGRST116 and rolls a mutation back; `.maybeSingle()` is client side (no rollback).
 *   * `hasSupplierColumn: false` reproduces the pre-migration database (PGRST204 on write, 42703 on named select).
 *   * `maxRows` silently truncates reads (PostgREST `db-max-rows`).
 *   * rpc("record_transaction") mirrors supabase/schema.sql line by line, atomically.
 *   * Error objects are plain objects `{ code, message, details, hint }` (NOT Error instances), as in supabase-js.
 *
 * USAGE IN A ROUTE TEST
 *
 *   `vi.mock` is hoisted ABOVE the imports, so its factory must not touch imported bindings or top-level
 *   variables directly. Two patterns are verified in tests/unit/fake-supabase.test.ts:
 *
 *   A) Accessor + proxy (recommended; order-independent, nothing to hoist):
 *
 *        import { NextRequest } from "next/server";
 *        import { beforeEach, describe, expect, it, vi } from "vitest";
 *        import { installFake, LIVE_AFTER_MIGRATION, type FakeSupabase } from "../helpers/fake-supabase";
 *
 *        vi.mock("@/lib/db", async () => {
 *          const { supabaseProxy } = await import("../helpers/fake-supabase"); // dynamic import = no TDZ problem
 *          return { supabase: supabaseProxy };
 *        });
 *        import { POST } from "@/app/api/categories/route";   // order does not matter, the mock is hoisted
 *
 *        let fake: FakeSupabase;
 *        beforeEach(() => { fake = installFake(LIVE_AFTER_MIGRATION); });     // fresh empty database per test
 *
 *        it("creates a category", async () => {
 *          // The routes that parse a JSON body refuse any other Content-Type (415), so a request carries the header.
 *          const res = await POST(new NextRequest("http://localhost/api/categories", {
 *            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Antibiotics" }) }));
 *          expect(res.status).toBe(201);
 *          expect(fake.dump("categories")).toHaveLength(1);
 *          expect(fake.writes()).toHaveLength(1);
 *        });
 *
 *   B) `vi.hoisted` holder (the same idea, spelled out):
 *
 *        const holder = vi.hoisted(() => ({ fake: null as FakeSupabase | null }));   // runs before the imports
 *        vi.mock("@/lib/db", () => ({ get supabase() { return holder.fake; } }));    // getter: read lazily per use
 *        beforeEach(() => { holder.fake = createFakeSupabase({ categoryIdType: "bigint" }); });
 *
 *   The installed fake lives on globalThis (a Symbol.for slot), so it survives `vi.resetModules()`: a route imported after
 *   the reset, whose mock factory re-imports this file as a SECOND COPY, still talks to the fake you installed. (This
 *   matters most in a test file with no static route import: vitest then runs the factory for the first time after the
 *   reset.) `uninstallFake()` empties the slot; use it in `afterEach` if a forgotten `installFake()` should fail loudly.
 *
 *   Seed with `fake.seedCategories(...)` BEFORE `fake.seedMedications(...)` (foreign key). tests/helpers/
 *   fixtures-extra.ts has `seedStandard(fake)` (the standard synthetic fixtures for the right id shape),
 *   `standardFake(options)`, `jsonRequest(method, url, body)`, `routeParams({ id })` (Next 16 dynamic-route context)
 *   and `readJson(res)`.
 *
 * OPTIONS (all optional)
 *   categoryIdType      "uuid" (default, live DB) | "bigint" (supabase/schema.sql)
 *   hasSupplierColumn   default true. false = migration not applied yet.
 *   rls                 per table: true | false | { select, insert, update, delete }.
 *                       false = RLS enabled with NO policy (the live `categories` table today).
 *                       Defaults (what a preset does not override): medications all true; categories all true (RLS off,
 *                       a fresh schema.sql install); transactions select only (rls.sql).
 *   maxRows             default Infinity. 1000 emulates the common Supabase API cap.
 *   categoryFkOnDelete  "restrict" (default, live DB: no ON DELETE SET NULL) | "set-null" (schema.sql)
 *   collation           "en-US" (default) | "C"   — how ORDER BY compares text (the real collation is unverified)
 *   countSupported      default true. false = `count` requests come back as `count: null`
 *   now                 clock; timestamps are forced strictly increasing so `updated_at` visibly bumps
 *   Presets:
 *     LIVE_BEFORE_MIGRATION  uuid ids, no supplier column, RLS ON for categories with NO policy (select/insert denied)
 *     LIVE_AFTER_MIGRATION   uuid ids, supplier column, categories: the migration's two policies = SELECT + INSERT only,
 *                            so a rename or delete of a category silently touches 0 rows (least privilege, as live)
 *     REPO_SCHEMA_SHAPE      bigint ids, supplier column, ON DELETE SET NULL, RLS off on categories (full access)
 *
 * RLS
 *   SELECT denied            -> { data: [], error: null } (silent, HTTP 200 in real life); count 0
 *   INSERT denied            -> { code: "42501", message: 'new row violates row-level security policy for table "x"' }
 *   INSERT .. RETURNING      -> needs SELECT too, else the same 42501 (Postgres checks the new row against SELECT)
 *   UPDATE / DELETE denied   -> silently affect 0 rows (they also need SELECT because of the WHERE clause)
 *   ON CONFLICT DO UPDATE    -> needs INSERT; the update part needs SELECT+UPDATE else 42501 "(USING expression)"
 *   rpc record_transaction   -> SECURITY DEFINER: bypasses RLS. FK checks and ON DELETE actions bypass RLS too.
 *
 * FAILURE INJECTION / INSPECTION
 *   fake.failNext({ code: "", message: "TypeError: fetch failed" })           next call resolves { data:null, error }
 *   fake.failNext(err, { table: "medications", op: "update" })                 only the matching call
 *   fake.failAll(err, matcher?) ... fake.clearFailures()                       persistent
 *   fake.onCall((call, index) => { ... })                                      run code at the Nth call (below)
 *   fake.calls / fake.callsFor("medications") / fake.writes() / fake.clearCalls()
 *   A call is recorded when the builder is AWAITED (a builder that is never awaited sends nothing, like the real
 *   client). `payload` is the JSON wire body. `writes()` = insert/update/upsert/delete/rpc (+ storage uploads),
 *   attempted or not: `call.result.error === null` tells the successful ones apart.
 *   fake.dump("medications") returns the stored rows (no RLS) — use it to assert what really persisted.
 *
 *   fake.onCall(hook) runs `hook(call, index)` for every awaited call, after it is logged and before it executes (and
 *   before failNext/failAll are applied, so a hook may queue a failure for the very call it looks at). It returns a
 *   function that removes the hook; `fake.clearHooks()` removes all. Use it for things that must happen BETWEEN two
 *   calls of the code under test, e.g. a competing request winning a check-then-insert race, or a row arriving between
 *   page 1 and page 2 of a paged read. Change data inside a hook with the seed* methods only (synchronous, bypass RLS,
 *   not logged); if a hook throws, the awaited call rejects with that error and is not executed.
 *
 *     // the 23505 race: seed the winner just before the insert runs; the fake's own unique constraint answers 23505
 *     fake.onCall((call) => { if (call.op === "insert" && call.table === "categories") fake.seedCategories([{ name: "Splints" }]); });
 *     // a row sorting first arrives before the 2nd read of medications, shifting every offset by one
 *     let reads = 0;
 *     fake.onCall((c) => { if (c.op === "select" && c.table === "medications" && ++reads === 2) fake.seedMedications([...]); });
 *
 * KNOWN LIMITS (explicit, not guesses): `.or()`, full-text, range/array operators, `.csv()`, `.explain()` etc. throw
 * "not implemented"; select casts (`col::text`) and JSON paths throw; embedded-table filters/order/limit are not
 * supported; a unique/PK change on a referenced key is not FK-checked; request-URL length limits (a huge `.in()` list)
 * are not modelled, so assert chunk sizes through `fake.calls`; `count: "planned" | "estimated"` behave like "exact".
 * Modelled on purpose: the Postgres `pg_safeupdate` rule (UPDATE/DELETE need a WHERE) and the PGRST103 / 416 answer for
 * a page that starts beyond the table when a count was requested; text the database cannot store (U+0000, a lone
 * surrogate) is refused in write bodies and rpc arguments. NOT modelled: the same characters in a FILTER value (the
 * fake just matches nothing, real PostgREST/Postgres would most likely answer with an error) or in a JSON object key.
 *
 * ASSUMPTIONS NOT VERIFIED AGAINST A REAL PROJECT (they come from the PostgREST/Postgres docs and memory; nothing
 * here may touch Supabase). If one proves wrong, fix it here once and every route test benefits:
 *   1. `.single()` on a mutation rolls the statement back when it matched != 1 row (PostgREST "singular" rule).
 *   2. `pg_safeupdate` is active on the target project, so UPDATE/DELETE without a filter fail with 21000.
 *   3. Wording of: PGRST116 `details`, PGRST100 / PGRST102 / PGRST200 / PGRST202 / PGRST205 messages, and the HTTP
 *      status numbers. The `code` values are the stable part; assert on codes where you can.
 *   4. ORDER BY on text uses ICU "en-US" (collation: "C" is available). The real database collation is unknown.
 *   5. `maxRows` caps reads only (select and rpc); RETURNING of a mutation is not capped. A page that starts at or
 *      beyond the end of the table is 416 PGRST103 only when a count was requested and offset > 0 (real PostgREST may
 *      answer an empty 200 when offset == total; without a count an empty array is returned).
 *   6. An update whose payload has no columns (`{}`, or only undefined values, which JSON drops) matches NO rows: PostgREST
 *      compiles it to `SELECT .. WHERE false` because an UPDATE needs a column to SET (PostgREST source, as remembered).
 *      So `.update({}).eq().select()` is `[]` (204 without .select()) and `.single()` is PGRST116 - the app's
 *      "Item not found" 404 - never the matched row.
 *   7. Rows keep insertion order when no ORDER BY is given (Postgres may reorder after UPDATEs): always sort in tests.
 *   8. `in.(...)` lists follow PostgREST's pListElement (see parseInList): an element is quoted only when it starts with a
 *      quote and the closing quote is followed by `,` or `)`; otherwise it is literal up to the next `,` or `)`. Taken
 *      from the PostgREST source as remembered; the postgrest-js side (what is sent) is verified against its dist code.
 *   9. U+0000 in a JSON string value is 22P05 "unsupported Unicode escape sequence" (HTTP 400; documented Postgres
 *      behaviour for json -> text). A lone UTF-16 surrogate is 22P02 "invalid input syntax for type json": the code is
 *      from the Postgres source as remembered, and the `details` wording of both is not verified.
 */

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Public types
// ═════════════════════════════════════════════════════════════════════════════════════════════

export type CategoryIdType = "uuid" | "bigint";
export type TableName = "categories" | "medications" | "transactions";
export type Row = Record<string, unknown>;
export type RlsOperation = "select" | "insert" | "update" | "delete";
export type RlsPolicy = boolean | Partial<Record<RlsOperation, boolean>>;
export type CountMode = "exact" | "planned" | "estimated";
export type CallOp = "select" | "insert" | "update" | "upsert" | "delete" | "rpc" | "storage.upload";
export type Collation = "C" | "en-US";

export interface FakeSupabaseOptions {
  categoryIdType?: CategoryIdType;
  hasSupplierColumn?: boolean;
  rls?: Partial<Record<TableName, RlsPolicy>>;
  maxRows?: number;
  categoryFkOnDelete?: "restrict" | "set-null";
  collation?: Collation;
  /** default true. false = `count` requests are answered with `count: null` (e.g. a proxy strips the Prefer header). */
  countSupported?: boolean;
  now?: () => Date;
}

export interface ResolvedFakeOptions {
  readonly categoryIdType: CategoryIdType;
  readonly hasSupplierColumn: boolean;
  readonly rls: Record<TableName, Record<RlsOperation, boolean>>;
  readonly maxRows: number;
  readonly categoryFkOnDelete: "restrict" | "set-null";
  readonly collation: Collation;
  readonly countSupported: boolean;
}

/** What the live Health Center database looked like when it was inspected (read-only), before our migration. */
export const LIVE_BEFORE_MIGRATION: Readonly<FakeSupabaseOptions> = Object.freeze({
  categoryIdType: "uuid",
  hasSupplierColumn: false,
  rls: Object.freeze({ categories: false }),
  categoryFkOnDelete: "restrict",
} as const);

/**
 * The live database after the planned additive migration (policies on categories + supplier_order_number column).
 * RLS stays ENABLED on categories and the migration adds exactly two policies for anon, SELECT and INSERT. UPDATE and
 * DELETE are deliberately NOT granted (supabase/migrations/20261105000000_*.sql, supabase/rls.sql section 4,
 * supabase/tests/sql/33-access-boundaries.sql), so a rename or delete of a category silently touches 0 rows. The
 * default policy for categories (all four operations, i.e. RLS off, a fresh install) would be wrong here.
 */
export const LIVE_AFTER_MIGRATION: Readonly<FakeSupabaseOptions> = Object.freeze({
  categoryIdType: "uuid",
  hasSupplierColumn: true,
  rls: Object.freeze({ categories: Object.freeze({ select: true, insert: true, update: false, delete: false }) }),
  categoryFkOnDelete: "restrict",
} as const);

/** supabase/schema.sql as written (bigint ids, ON DELETE SET NULL) plus the supplier column. */
export const REPO_SCHEMA_SHAPE: Readonly<FakeSupabaseOptions> = Object.freeze({
  categoryIdType: "bigint",
  hasSupplierColumn: true,
  categoryFkOnDelete: "set-null",
} as const);

export type FakeError = { code: string; message: string; details: string | null; hint: string | null };
/** Shape accepted by failNext / failAll. `status` defaults from the code (0 for client-side failures). */
export type ErrorLike = { code?: string; message: string; details?: string | null; hint?: string | null; status?: number };

export interface FakeResponse {
  data: unknown;
  error: FakeError | null;
  count: number | null;
  status: number;
  statusText: string;
  success: boolean;
}

export interface FailureMatcher {
  table?: string;
  fn?: string;
  bucket?: string;
  op?: CallOp | CallOp[];
}

export interface RecordedFilter {
  column: string;
  /** operator expression exactly as the client library puts it in the URL, e.g. "eq.5", "in.(1,2)", "is.null" */
  expr: string;
  operator: string;
  /** the original JavaScript argument (NaN stays NaN here, but `expr` shows what was sent) */
  value: unknown;
}

export interface RecordedCall {
  seq: number;
  op: CallOp;
  /** relation name for table calls, otherwise null */
  table: string | null;
  /** rpc function name, otherwise null */
  fn: string | null;
  /** storage bucket, otherwise null */
  bucket: string | null;
  filters: RecordedFilter[];
  /** JSON wire body (after JSON.stringify/parse: NaN -> null, undefined keys dropped). undefined when there is none. */
  payload: unknown;
  select: string | null;
  returning: boolean;
  order: { column: string; ascending: boolean; nullsFirst: boolean | null }[];
  limit: number | null;
  offset: number | null;
  single: "single" | "maybeSingle" | null;
  count: CountMode | null;
  onConflict: string | null;
  /** true when the response came from failNext/failAll instead of the database */
  injected: boolean;
  result: { status: number; error: FakeError | null; rows: number | null } | null;
}

/**
 * Called for every awaited call, synchronously, after the call is logged and before failure injection and the database
 * see it. `index` is the call's position in `fake.calls` (it starts again after `clearCalls()`).
 */
export type CallHook = (call: RecordedCall, index: number) => void;

export interface SeedCategory {
  id?: string | number;
  name: string;
  created_at?: string | null;
}
export interface SeedMedication {
  id?: number;
  barcode: string;
  name?: string | null;
  photo_url?: string | null;
  stock?: number;
  threshold?: number;
  vendor_url?: string | null;
  unit?: string;
  notes?: string | null;
  category_id?: string | number | null;
  supplier_order_number?: string | null;
  is_unnamed?: boolean;
  created_at?: string;
  updated_at?: string;
}
export interface SeedTransaction {
  id?: number;
  medication_id: number;
  type: string;
  quantity: number;
  note?: string | null;
  created_at?: string;
}

export interface UploadRecord {
  bucket: string;
  path: string;
  contentType: string | null;
  size: number;
}

export interface FakeFilterBuilder extends PromiseLike<FakeResponse> {
  select(columns?: string): FakeFilterBuilder;
  eq(column: string, value: unknown): FakeFilterBuilder;
  neq(column: string, value: unknown): FakeFilterBuilder;
  gt(column: string, value: unknown): FakeFilterBuilder;
  gte(column: string, value: unknown): FakeFilterBuilder;
  lt(column: string, value: unknown): FakeFilterBuilder;
  lte(column: string, value: unknown): FakeFilterBuilder;
  like(column: string, pattern: string): FakeFilterBuilder;
  ilike(column: string, pattern: string): FakeFilterBuilder;
  is(column: string, value: unknown): FakeFilterBuilder;
  in(column: string, values: readonly unknown[]): FakeFilterBuilder;
  not(column: string, operator: string, value: unknown): FakeFilterBuilder;
  match(query: Record<string, unknown>): FakeFilterBuilder;
  filter(column: string, operator: string, value: unknown): FakeFilterBuilder;
  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string; foreignTable?: string }
  ): FakeFilterBuilder;
  limit(count: number, options?: { referencedTable?: string; foreignTable?: string }): FakeFilterBuilder;
  range(from: number, to: number, options?: { referencedTable?: string; foreignTable?: string }): FakeFilterBuilder;
  single(): FakeFilterBuilder;
  maybeSingle(): FakeFilterBuilder;
  throwOnError(): FakeFilterBuilder;
  returns(): FakeFilterBuilder;
  overrideTypes(): FakeFilterBuilder;
  abortSignal(signal: AbortSignal): FakeFilterBuilder;
  retry(enabled: boolean): FakeFilterBuilder;
}

export interface FakeQueryBuilder {
  select(columns?: string, options?: { head?: boolean; count?: CountMode }): FakeFilterBuilder;
  insert(values: unknown, options?: { count?: CountMode; defaultToNull?: boolean }): FakeFilterBuilder;
  upsert(
    values: unknown,
    options?: { onConflict?: string; ignoreDuplicates?: boolean; count?: CountMode; defaultToNull?: boolean }
  ): FakeFilterBuilder;
  update(values: unknown, options?: { count?: CountMode }): FakeFilterBuilder;
  delete(options?: { count?: CountMode }): FakeFilterBuilder;
}

export interface FakeStorageError {
  name: string;
  message: string;
  status: number;
  statusCode: string;
}

export interface FakeStorageBucket {
  upload(
    path: string,
    body: unknown,
    options?: { contentType?: string; upsert?: boolean; cacheControl?: string }
  ): Promise<{ data: { id: string; path: string; fullPath: string } | null; error: FakeStorageError | null }>;
  getPublicUrl(path: string): { data: { publicUrl: string } };
}

export interface FakeClient {
  from(table: string): FakeQueryBuilder;
  rpc(fn: string, args?: Record<string, unknown>, options?: { count?: CountMode }): FakeFilterBuilder;
  storage: { from(bucket: string): FakeStorageBucket };
}

export interface FakeSupabase extends FakeClient {
  readonly options: ResolvedFakeOptions;
  /** live, append-only log of awaited calls (cleared in place by clearCalls) */
  readonly calls: RecordedCall[];
  /** calls whose table, rpc function name or storage bucket equals `name` */
  callsFor(name: string): RecordedCall[];
  /** insert / update / upsert / delete / rpc / storage upload calls (attempted, whether or not they succeeded) */
  writes(): RecordedCall[];
  clearCalls(): void;
  failNext(error: ErrorLike, matcher?: FailureMatcher): void;
  failAll(error: ErrorLike, matcher?: FailureMatcher): void;
  clearFailures(): void;
  /**
   * Registers `hook`; returns a function that removes it again. Use it to make something happen between two calls of the
   * code under test: seed a competing row just before its insert runs (the fake's own unique constraint then raises
   * 23505), or add a row that sorts first between page 1 and page 2 of a paged read. Inside a hook, change the data with
   * `seedCategories` / `seedMedications` / `seedTransactions` (they bypass RLS, enforce every constraint and are not
   * logged). A hook may also queue `failNext()`: it runs before failure injection, so that failure hits the very call
   * the hook is looking at. If a hook throws, the awaited call rejects with that error and is NOT executed (it stays in
   * `calls` with `result: null`). Hooks run in registration order; one that removes itself or another hook while hooks
   * are running is safe; one added while hooks are running first runs on the next call.
   */
  onCall(hook: CallHook): () => void;
  clearHooks(): void;
  seedCategories(rows: readonly SeedCategory[]): void;
  seedMedications(rows: readonly SeedMedication[]): void;
  seedTransactions(rows: readonly SeedTransaction[]): void;
  /** stored rows as the database holds them (ids: uuid strings or bigint numbers), no RLS, deep copy */
  dump(table: TableName): Row[];
  setRls(table: TableName, policy: RlsPolicy): void;
  uploads(): UploadRecord[];
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Internal: errors
// ═════════════════════════════════════════════════════════════════════════════════════════════

function statusForCode(code: string): number {
  if (code === "") return 0;
  if (code === "42501") return 403;
  if (code === "23505" || code === "23503") return 409;
  if (code === "PGRST116") return 406;
  if (code === "PGRST202" || code === "PGRST205" || code === "42P01") return 404;
  if (code === "PGRST103") return 416;
  return 400; // PostgREST maps most remaining Postgres errors (22xxx, 23502, 23514, 42703, P0001, 21000...) to 400
}

const STATUS_TEXT: Record<number, string> = {
  0: "",
  200: "OK",
  201: "Created",
  204: "No Content",
  206: "Partial Content",
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  406: "Not Acceptable",
  409: "Conflict",
  416: "Range Not Satisfiable",
};

class PgError extends Error {
  readonly code: string;
  readonly details: string | null;
  readonly hint: string | null;
  readonly status: number;
  constructor(code: string, message: string, extra: { details?: string | null; hint?: string | null; status?: number } = {}) {
    super(message);
    this.code = code;
    this.details = extra.details ?? null;
    this.hint = extra.hint ?? null;
    this.status = extra.status ?? statusForCode(code);
  }
  toFake(): FakeError {
    return { code: this.code, message: this.message, details: this.details, hint: this.hint };
  }
}

/** Thrown for things the fake deliberately does not implement (surfaces as a rejected promise, never a fake DB error). */
function notImplemented(what: string): Error {
  return new Error(`fake-supabase: ${what} is not implemented by the fake. Extend tests/helpers/fake-supabase.ts or avoid it in the route.`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Internal: schema
// ═════════════════════════════════════════════════════════════════════════════════════════════

type ColType = "int8" | "int4" | "text" | "bool" | "uuid" | "timestamptz";

type ColDefault =
  | { kind: "value"; value: string | number | boolean }
  | { kind: "now" }
  | { kind: "sequence" }
  | { kind: "uuid" };

interface ColumnDef {
  name: string;
  type: ColType;
  notNull: boolean;
  default?: ColDefault;
}
interface UniqueDef {
  name: string;
  column: string;
}
interface CheckDef {
  name: string;
  /** true / false / null (unknown). Postgres only rejects a row when the check is FALSE. */
  holds: (row: Row) => boolean | null;
}
interface FkDef {
  name: string;
  column: string;
  refTable: TableName;
  refColumn: string;
  onDelete: "restrict" | "cascade" | "set-null";
}
interface RelationDef {
  name: string;
  kind: "one" | "many";
  target: TableName;
  localColumn: string;
  targetColumn: string;
}
interface TableDef {
  name: TableName;
  columns: ColumnDef[];
  uniques: UniqueDef[];
  checks: CheckDef[];
  fks: FkDef[];
  relations: RelationDef[];
  /** column the `set_updated_at` trigger maintains (medications only) */
  updatedAtColumn: string | null;
}

const TABLE_NAMES: readonly TableName[] = ["categories", "medications", "transactions"];

function buildSchema(o: ResolvedFakeOptions): Record<TableName, TableDef> {
  const catIdType: ColType = o.categoryIdType === "uuid" ? "uuid" : "int8";
  const createdAt = (): ColumnDef => ({ name: "created_at", type: "timestamptz", notNull: true, default: { kind: "now" } });

  const medicationColumns: ColumnDef[] = [
    { name: "id", type: "int8", notNull: true, default: { kind: "sequence" } },
    { name: "name", type: "text", notNull: false },
    { name: "barcode", type: "text", notNull: true },
    { name: "photo_url", type: "text", notNull: false },
    { name: "stock", type: "int4", notNull: true, default: { kind: "value", value: 0 } },
    { name: "threshold", type: "int4", notNull: true, default: { kind: "value", value: 10 } },
    { name: "vendor_url", type: "text", notNull: false },
    { name: "unit", type: "text", notNull: true, default: { kind: "value", value: "units" } },
    { name: "notes", type: "text", notNull: false },
    { name: "category_id", type: catIdType, notNull: false },
    { name: "is_unnamed", type: "bool", notNull: true, default: { kind: "value", value: false } },
    createdAt(),
    { name: "updated_at", type: "timestamptz", notNull: true, default: { kind: "now" } },
  ];
  // ALTER TABLE .. ADD COLUMN appends, so the supplier column comes last when it exists.
  if (o.hasSupplierColumn) medicationColumns.push({ name: "supplier_order_number", type: "text", notNull: false });

  return {
    categories: {
      name: "categories",
      columns: [
        {
          name: "id",
          type: catIdType,
          notNull: true,
          default: catIdType === "uuid" ? { kind: "uuid" } : { kind: "sequence" },
        },
        { name: "name", type: "text", notNull: true },
        createdAt(),
      ],
      uniques: [
        { name: "categories_pkey", column: "id" },
        { name: "categories_name_key", column: "name" },
      ],
      checks: [],
      fks: [],
      relations: [{ name: "medications", kind: "many", target: "medications", localColumn: "id", targetColumn: "category_id" }],
      updatedAtColumn: null,
    },
    medications: {
      name: "medications",
      columns: medicationColumns,
      uniques: [
        { name: "medications_pkey", column: "id" },
        { name: "medications_barcode_key", column: "barcode" },
      ],
      checks: [],
      fks: [
        {
          name: "medications_category_id_fkey",
          column: "category_id",
          refTable: "categories",
          refColumn: "id",
          onDelete: o.categoryFkOnDelete,
        },
      ],
      relations: [
        { name: "categories", kind: "one", target: "categories", localColumn: "category_id", targetColumn: "id" },
        { name: "transactions", kind: "many", target: "transactions", localColumn: "id", targetColumn: "medication_id" },
      ],
      updatedAtColumn: "updated_at",
    },
    transactions: {
      name: "transactions",
      columns: [
        { name: "id", type: "int8", notNull: true, default: { kind: "sequence" } },
        { name: "medication_id", type: "int8", notNull: true },
        { name: "type", type: "text", notNull: true },
        { name: "quantity", type: "int4", notNull: true },
        { name: "note", type: "text", notNull: false },
        createdAt(),
      ],
      uniques: [{ name: "transactions_pkey", column: "id" }],
      checks: [
        {
          name: "transactions_type_check",
          holds: (r) => (r.type === null ? null : r.type === "receive" || r.type === "dispense"),
        },
        {
          name: "transactions_quantity_check",
          holds: (r) => (r.quantity === null ? null : (r.quantity as number) > 0),
        },
      ],
      fks: [
        {
          name: "transactions_medication_id_fkey",
          column: "medication_id",
          refTable: "medications",
          refColumn: "id",
          onDelete: "cascade",
        },
      ],
      relations: [{ name: "medications", kind: "one", target: "medications", localColumn: "medication_id", targetColumn: "id" }],
      updatedAtColumn: null,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Internal: value parsing / formatting (Postgres input rules)
// ═════════════════════════════════════════════════════════════════════════════════════════════

const TYPE_LABEL: Record<ColType, string> = {
  int8: "bigint",
  int4: "integer",
  text: "text",
  bool: "boolean",
  uuid: "uuid",
  timestamptz: "timestamp with time zone",
};

function invalidSyntax(type: ColType, text: string): PgError {
  return new PgError(type === "timestamptz" ? "22007" : "22P02", `invalid input syntax for type ${TYPE_LABEL[type]}: "${text}"`);
}

const INT_BOUNDS: Record<"int4" | "int8", readonly [bigint, bigint]> = {
  int4: [BigInt("-2147483648"), BigInt("2147483647")],
  int8: [BigInt("-9223372036854775808"), BigInt("9223372036854775807")],
};

function parseInteger(text: string, type: "int4" | "int8"): number {
  const m = /^\s*([+-]?)(\d+)\s*$/.exec(text);
  if (!m) throw invalidSyntax(type, text);
  const magnitude = BigInt(m[2]);
  const value = m[1] === "-" ? -magnitude : magnitude;
  const [lo, hi] = INT_BOUNDS[type];
  if (value < lo || value > hi) throw new PgError("22003", `value "${text}" is out of range for type ${TYPE_LABEL[type]}`);
  return Number(value);
}

const TRUE_WORDS = new Set(["true", "t", "yes", "y", "on", "1"]);
const FALSE_WORDS = new Set(["false", "f", "no", "n", "off", "0"]);

function parseBoolean(text: string): boolean {
  const s = text.trim().toLowerCase();
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  throw invalidSyntax("bool", text);
}

/** Postgres uuid input: optional braces, hyphens allowed after any group of four hex digits; output lowercase 8-4-4-4-12. */
function canonicalUuid(text: string): string | null {
  let s = text;
  if (s.startsWith("{") && s.endsWith("}")) s = s.slice(1, -1);
  if (!/^(?:[0-9a-fA-F]{4}-?){7}[0-9a-fA-F]{4}$/.test(s)) return null;
  const h = s.replace(/-/g, "").toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Milliseconds since the epoch, or null when Postgres would reject the text. No zone = UTC (Supabase session zone). */
function parseTimestamp(text: string): number | null {
  const m = TIMESTAMP_RE.exec(text.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4] ?? "0");
  const minute = Number(m[5] ?? "0");
  const second = Number(m[6] ?? "0");
  const millis = Math.floor(Number(`0.${m[7] ?? "0"}`) * 1000);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const base = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  if (new Date(base).getUTCDate() !== day) return null; // e.g. Feb 30
  let offsetMinutes = 0;
  const zone = m[8];
  if (zone && zone.toUpperCase() !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    offsetMinutes = (zone[0] === "-" ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || "0"));
  }
  return base - offsetMinutes * 60_000;
}

/** PostgREST renders timestamptz as ISO 8601 with a +00:00 offset and no trailing fractional zeros. */
function formatTimestamp(ms: number): string {
  const [datePart, fraction = ""] = new Date(ms).toISOString().slice(0, -1).split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return `${datePart}${trimmed ? `.${trimmed}` : ""}+00:00`;
}

function fromText(text: string, type: ColType): string | number | boolean {
  switch (type) {
    case "text":
      return text;
    case "int4":
    case "int8":
      return parseInteger(text, type);
    case "bool":
      return parseBoolean(text);
    case "uuid": {
      const u = canonicalUuid(text);
      if (u === null) throw invalidSyntax("uuid", text);
      return u;
    }
    case "timestamptz": {
      const ms = parseTimestamp(text);
      if (ms === null) throw invalidSyntax("timestamptz", text);
      return formatTimestamp(ms);
    }
  }
}

const NUL = String.fromCharCode(0);

/** True when `s` holds a UTF-16 surrogate that is not half of a valid pair (what a `.slice()` through an emoji leaves). */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = s.charCodeAt(i + 1); // NaN past the end: comparisons are false, so a trailing high surrogate is lone
      if (following >= 0xdc00 && following <= 0xdfff) i += 1;
      else return true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Postgres text cannot hold U+0000, and PostgREST hands the request body to json_populate_recordset, which decodes the
 * JSON string escapes: `\u0000` fails with SQLSTATE 22P05 "unsupported Unicode escape sequence" (HTTP 400), and a
 * lone surrogate with 22P02 "invalid input syntax for type json". The body is decoded before any column is converted,
 * so this applies to every string value whatever the column type. A NUL inside a NESTED object/array is only the six
 * characters backslash-u-0000 in the value's JSON text, which text can store (see coerceWire).
 */
function assertDecodableJsonString(value: string): void {
  if (value.includes(NUL)) {
    throw new PgError("22P05", "unsupported Unicode escape sequence", { details: "\\u0000 cannot be converted to text.", status: 400 });
  }
  if (hasLoneSurrogate(value)) {
    throw new PgError("22P02", "invalid input syntax for type json", {
      details: "Unicode low surrogate must follow a high surrogate.",
      status: 400,
    });
  }
}

/** JSON body value -> column value, the way json_populate_recordset converts (everything goes through text). */
function coerceWire(value: unknown, col: Pick<ColumnDef, "type">): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") assertDecodableJsonString(value);
  if (col.type === "text") {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value);
  }
  if (col.type === "bool" && typeof value === "boolean") return value;
  const text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  return fromText(text, col.type);
}

function equalValues(type: ColType, a: unknown, b: unknown): boolean {
  if (type === "timestamptz") return parseTimestamp(String(a)) === parseTimestamp(String(b));
  return a === b;
}

function keyOf(v: unknown): string {
  return String(v);
}

function toWire(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

function isPlainObject(v: unknown): v is Row {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Internal: query plan, select-list parser, filters, ordering
// ═════════════════════════════════════════════════════════════════════════════════════════════

interface PlanFilter {
  column: string;
  expr: string;
  operator: string;
  value: unknown;
}
interface PlanOrder {
  column: string;
  ascending: boolean;
  nullsFirst: boolean | null;
}
interface Plan {
  op: Exclude<CallOp, "storage.upload">;
  table: string | null;
  fn: string | null;
  body: unknown;
  selectCols: string | null;
  returning: boolean;
  head: boolean;
  count: CountMode | null;
  filters: PlanFilter[];
  orders: PlanOrder[];
  limit: number | null;
  offset: number | null;
  single: "single" | "maybeSingle" | null;
  onConflict: string | null;
  ignoreDuplicates: boolean;
  defaultToNull: boolean;
  throwOnError: boolean;
}

type SelectItem =
  | { kind: "star" }
  | { kind: "column"; name: string; alias: string }
  | { kind: "embed"; relation: string; alias: string; inner: boolean; items: SelectItem[] };

/** Same whitespace clean-up postgrest-js applies to the select list. */
function cleanSelect(columns: string | undefined): string {
  let quoted = false;
  return (columns ?? "*")
    .split("")
    .map((c) => {
      if (/\s/.test(c) && !quoted) return "";
      if (c === '"') quoted = !quoted;
      return c;
    })
    .join("");
}

function parseSelectList(src: string): SelectItem[] {
  const text = src === "" ? "*" : src;
  const pos = { i: 0 };
  const items = parseSelectLevel(text, pos, 0);
  if (pos.i < text.length) throw notImplemented(`select list syntax near "${text.slice(pos.i)}"`);
  return items;
}

function parseSelectLevel(s: string, pos: { i: number }, depth: number): SelectItem[] {
  const items: SelectItem[] = [];
  while (pos.i < s.length) {
    const start = pos.i;
    while (pos.i < s.length && !",()".includes(s[pos.i])) pos.i++;
    const token = s.slice(start, pos.i);
    if (s[pos.i] === "(") {
      pos.i++;
      const inner = parseSelectLevel(s, pos, depth + 1);
      if (s[pos.i] !== ")") throw notImplemented(`select list "${s}" (unbalanced parentheses)`);
      pos.i++;
      items.push(makeEmbed(token, inner));
    } else if (token !== "") {
      items.push(makeColumn(token));
    }
    if (s[pos.i] === ",") {
      pos.i++;
      continue;
    }
    if (s[pos.i] === ")") {
      if (depth === 0) throw notImplemented(`select list "${s}" (unbalanced parentheses)`);
      break;
    }
  }
  return items;
}

function makeColumn(token: string): SelectItem {
  if (token === "*") return { kind: "star" };
  if (token.includes("::") || token.includes("->") || token.includes("!")) throw notImplemented(`select item "${token}"`);
  const colon = token.indexOf(":");
  if (colon >= 0) return { kind: "column", name: token.slice(colon + 1), alias: token.slice(0, colon) };
  return { kind: "column", name: token, alias: token };
}

function makeEmbed(token: string, items: SelectItem[]): SelectItem {
  let rest = token;
  let alias: string | null = null;
  const colon = rest.indexOf(":");
  if (colon >= 0) {
    alias = rest.slice(0, colon);
    rest = rest.slice(colon + 1);
  }
  const parts = rest.split("!");
  const relation = parts[0];
  const inner = parts.slice(1).includes("inner");
  return { kind: "embed", relation, alias: alias ?? relation, inner, items };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Internal: the database engine
// ═════════════════════════════════════════════════════════════════════════════════════════════

interface Outcome {
  data: unknown;
  error: PgError | null;
  count: number | null;
  status: number;
}

type Tri = boolean | null;
type RowTest = (row: Row) => Tri;

const RPC_REQUIRED = ["p_medication_id", "p_quantity", "p_type"];
const RPC_ALLOWED = [...RPC_REQUIRED, "p_note"];

function escapeRegExp(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** SQL LIKE (backslash escape) with PostgREST's `*` -> `%` convenience. */
function likeToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let out = "^";
  const chars = Array.from(pattern);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\\" && i + 1 < chars.length) out += escapeRegExp(chars[++i]);
    else if (ch === "%" || ch === "*") out += ".*";
    else if (ch === "_") out += ".";
    else out += escapeRegExp(ch);
  }
  return new RegExp(`${out}$`, caseInsensitive ? "isu" : "su");
}

/**
 * Splits `in.(a,b,"c,d")` the way PostgREST does. An element is EITHER quoted - it starts with a double quote, may use
 * backslash escapes inside, and its closing quote is followed by `,` or the list's `)` - OR it is taken literally up to
 * the next `,` or `)`. A quote or backslash inside an unquoted element is an ordinary character, which is why
 * postgrest-js can send `say "hi"` and `x\y` unwrapped (it only wraps values containing , ( or )). A stray `)` closes
 * the list early and leaves text behind: a parse error. (This is PostgREST's pListElement as remembered from its
 * source, not checked against a running server - see ASSUMPTIONS in the header.)
 */
function parseInList(raw: string, whole: string): string[] {
  const malformed = (): PgError => new PgError("PGRST100", `"failed to parse filter (${whole})"`, { status: 400 });
  if (!raw.startsWith("(") || !raw.endsWith(")")) throw malformed();
  const inner = raw.slice(1, -1);
  if (inner === "") return [];
  const items: string[] = [];
  let i = 0;
  for (;;) {
    const quoted = inner[i] === '"' ? readQuotedElement(inner, i) : null;
    if (quoted) {
      items.push(quoted.value);
      i = quoted.next;
    } else {
      let end = i;
      while (end < inner.length && inner[end] !== "," && inner[end] !== ")") end++;
      items.push(inner.slice(i, end));
      i = end;
    }
    if (i >= inner.length) return items;
    if (inner[i] !== ",") throw malformed();
    i += 1;
  }
}

/** The quoted element whose opening quote is at `start`, with the index after its closing quote; null when it is not one. */
function readQuotedElement(s: string, start: number): { value: string; next: number } | null {
  let value = "";
  for (let k = start + 1; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\") {
      if (k + 1 >= s.length) return null;
      k += 1;
      value += s[k];
    } else if (ch === '"') {
      const next = k + 1;
      // only the FIRST unescaped quote can close the element; what follows it decides whether it was a quoted element at all
      return next >= s.length || s[next] === "," || s[next] === ")" ? { value, next } : null;
    } else {
      value += ch;
    }
  }
  return null;
}

class Database {
  readonly schema: Record<TableName, TableDef>;
  readonly tables: Record<TableName, Row[]> = { categories: [], medications: [], transactions: [] };
  readonly sequences: Record<TableName, number> = { categories: 0, medications: 0, transactions: 0 };
  private lastTick = 0;
  private uuidCounter = 0;
  private readonly compareText: (a: string, b: string) => number;

  constructor(
    readonly options: { -readonly [K in keyof ResolvedFakeOptions]: ResolvedFakeOptions[K] },
    private readonly clock: () => Date
  ) {
    this.schema = buildSchema(options);
    if (options.collation === "C") {
      this.compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    } else {
      const collator = new Intl.Collator("en-US");
      this.compareText = (a, b) => collator.compare(a, b);
    }
  }

  // ── utilities ──────────────────────────────────────────────────────────────

  /** Statement timestamp: strictly increasing so consecutive statements never share a `now()`. */
  tick(): number {
    const t = Math.max(this.clock().getTime(), this.lastTick + 1);
    this.lastTick = t;
    return t;
  }

  tableDef(name: string): TableDef {
    if (!(TABLE_NAMES as readonly string[]).includes(name)) {
      throw new PgError("PGRST205", `Could not find the table 'public.${name}' in the schema cache`, { status: 404 });
    }
    return this.schema[name as TableName];
  }

  allows(table: TableName, op: RlsOperation): boolean {
    return this.options.rls[table][op];
  }

  private column(def: TableDef, name: string): ColumnDef {
    const col = def.columns.find((c) => c.name === name);
    if (!col) throw new PgError("42703", `column ${def.name}.${name} does not exist`);
    return col;
  }

  private rlsViolation(table: string, usingExpression = false): PgError {
    return new PgError(
      "42501",
      usingExpression
        ? `new row violates row-level security policy (USING expression) for table "${table}"`
        : `new row violates row-level security policy for table "${table}"`
    );
  }

  private defaultFor(def: TableDef, col: ColumnDef, ts: number): string | number | boolean | null {
    const d = col.default;
    if (!d) return null;
    switch (d.kind) {
      case "value":
        return d.value;
      case "now":
        return formatTimestamp(ts);
      case "sequence":
        this.sequences[def.name] += 1; // consumed even if the statement later fails (like a Postgres sequence)
        return this.sequences[def.name];
      case "uuid":
        this.uuidCounter += 1;
        return `a0000000-0000-4000-8000-${String(this.uuidCounter).padStart(12, "0")}`;
    }
  }

  // ── select list ────────────────────────────────────────────────────────────

  compileSelect(def: TableDef, cols: string | null): SelectItem[] {
    const items = parseSelectList(cols ?? "*");
    this.validateSelect(def, items);
    return items;
  }

  private validateSelect(def: TableDef, items: SelectItem[]): void {
    for (const it of items) {
      if (it.kind === "column") this.column(def, it.name);
      else if (it.kind === "embed") {
        const rel = def.relations.find((r) => r.name === it.relation);
        if (!rel) {
          throw new PgError("PGRST200", `Could not find a relationship between '${def.name}' and '${it.relation}' in the schema cache`, {
            details: `Searched for a foreign key relationship between '${def.name}' and '${it.relation}' in the schema 'public', but no matches were found.`,
            status: 400,
          });
        }
        this.validateSelect(this.schema[rel.target], it.items);
      }
    }
  }

  private project(def: TableDef, row: Row, items: SelectItem[]): Row | null {
    const out: Row = {};
    for (const it of items) {
      if (it.kind === "star") {
        for (const c of def.columns) out[c.name] = row[c.name];
      } else if (it.kind === "column") {
        out[it.alias] = row[it.name];
      } else {
        const rel = def.relations.find((r) => r.name === it.relation);
        if (!rel) continue; // validated earlier
        const targetDef = this.schema[rel.target];
        const pool = this.allows(rel.target, "select") ? this.tables[rel.target] : [];
        const local = row[rel.localColumn];
        const related =
          local === null || local === undefined
            ? []
            : pool.filter((t) => t[rel.targetColumn] !== null && keyOf(t[rel.targetColumn]) === keyOf(local));
        const projected = related.map((t) => this.project(targetDef, t, it.items)).filter((r): r is Row => r !== null);
        if (rel.kind === "one") {
          const first = projected[0] ?? null;
          if (it.inner && first === null) return null;
          out[it.alias] = first;
        } else {
          if (it.inner && projected.length === 0) return null;
          out[it.alias] = projected;
        }
      }
    }
    return out;
  }

  // ── filters / ordering ─────────────────────────────────────────────────────

  compileWhere(def: TableDef, filters: PlanFilter[]): (row: Row) => boolean {
    const tests = filters.map((f) => this.compileFilter(def, f));
    return (row) => tests.every((t) => t(row) === true);
  }

  private compileFilter(def: TableDef, f: PlanFilter): RowTest {
    const col = this.column(def, f.column);
    let expr = f.expr;
    let negate = false;
    if (expr.startsWith("not.")) {
      negate = true;
      expr = expr.slice(4);
    }
    const dot = expr.indexOf(".");
    if (dot < 0) throw new PgError("PGRST100", `"failed to parse filter (${f.expr})"`, { status: 400 });
    const op = expr.slice(0, dot);
    const raw = expr.slice(dot + 1);
    const read = (row: Row): unknown => {
      const v = row[col.name];
      return v === undefined ? null : v;
    };

    let test: RowTest;
    switch (op) {
      case "eq":
      case "neq":
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const target = fromText(raw, col.type);
        test = (row) => {
          const v = read(row);
          if (v === null) return null; // SQL three-valued logic: NULL <op> x is NULL, never true
          if (op === "eq") return equalValues(col.type, v, target);
          if (op === "neq") return !equalValues(col.type, v, target);
          const c = this.compareValues(col.type, v, target);
          return op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : c <= 0;
        };
        break;
      }
      case "like":
      case "ilike": {
        if (col.type !== "text") {
          throw new PgError("42883", `operator does not exist: ${TYPE_LABEL[col.type]} ~~${op === "ilike" ? "*" : ""} unknown`, { status: 404 });
        }
        const re = likeToRegExp(raw, op === "ilike");
        test = (row) => {
          const v = read(row);
          return v === null ? null : re.test(String(v));
        };
        break;
      }
      case "is": {
        const word = raw.toLowerCase();
        if (word === "null") test = (row) => read(row) === null;
        else if (word === "true" || word === "false" || word === "unknown") {
          if (col.type !== "bool") {
            throw new PgError("42804", `argument of IS ${word.toUpperCase()} must be type boolean, not type ${TYPE_LABEL[col.type]}`);
          }
          test = (row) => {
            const v = read(row);
            return word === "unknown" ? v === null : v === (word === "true");
          };
        } else {
          throw new PgError("PGRST100", `"failed to parse filter (${f.expr})"`, {
            details: `unexpected "${raw[0] ?? ""}" expecting null or trilean value (unknown, true, false)`,
            status: 400,
          });
        }
        break;
      }
      case "in": {
        const values = parseInList(raw, f.expr).map((item) => fromText(item, col.type));
        test = (row) => {
          const v = read(row);
          if (v === null) return null;
          return values.some((t) => equalValues(col.type, v, t));
        };
        break;
      }
      default:
        throw new PgError("PGRST100", `"failed to parse filter (${f.expr})"`, {
          details: `unexpected "${op}" expecting operator (eq, gt, gte, lt, lte, neq, like, ilike, in, is, not)`,
          status: 400,
        });
    }
    if (!negate) return test;
    return (row) => {
      const r = test(row);
      return r === null ? null : !r;
    };
  }

  private compareValues(type: ColType, a: unknown, b: unknown): number {
    switch (type) {
      case "int4":
      case "int8":
        return (a as number) - (b as number);
      case "bool":
        return Number(a) - Number(b);
      case "timestamptz":
        return (parseTimestamp(String(a)) ?? 0) - (parseTimestamp(String(b)) ?? 0);
      case "uuid": {
        const x = String(a);
        const y = String(b);
        return x < y ? -1 : x > y ? 1 : 0;
      }
      case "text":
        return this.compareText(String(a), String(b));
    }
  }

  compileOrder(def: TableDef, orders: PlanOrder[]): ((a: Row, b: Row) => number) | null {
    if (orders.length === 0) return null;
    const keys = orders.map((o) => ({
      col: this.column(def, o.column),
      ascending: o.ascending,
      // Postgres default: NULLS LAST for ASC, NULLS FIRST for DESC
      nullsFirst: o.nullsFirst ?? !o.ascending,
    }));
    return (a, b) => {
      for (const k of keys) {
        const x = a[k.col.name] ?? null;
        const y = b[k.col.name] ?? null;
        if (x === null || y === null) {
          if (x === null && y === null) continue;
          return x === null ? (k.nullsFirst ? -1 : 1) : k.nullsFirst ? 1 : -1;
        }
        const c = this.compareValues(k.col.type, x, y);
        if (c !== 0) return k.ascending ? c : -c;
      }
      return 0;
    };
  }

  // ── reading ────────────────────────────────────────────────────────────────

  private window(plan: Plan): { offset: number; limit: number } {
    const offset = plan.offset ?? 0;
    const limit = plan.limit ?? Number.POSITIVE_INFINITY;
    const bad =
      !Number.isInteger(offset) || offset < 0 || (limit !== Number.POSITIVE_INFINITY && (!Number.isInteger(limit) || limit < 0));
    if (bad) {
      throw new PgError("PGRST100", "invalid limit or offset", { details: `limit=${String(plan.limit)}, offset=${String(plan.offset)}`, status: 400 });
    }
    return { offset, limit: Math.min(limit, this.options.maxRows) }; // db-max-rows truncates silently
  }

  /** `count` as the client would see it: the true number of matching rows, or null when no count was requested/supported. */
  private countOf(plan: Plan, n: number): number | null {
    return plan.count && this.options.countSupported ? n : null;
  }

  private assertSingle(plan: Plan, n: number): void {
    if (plan.single === "single" && n !== 1) {
      throw new PgError("PGRST116", "JSON object requested, multiple (or no) rows returned", {
        details: `The result contains ${n} rows`,
        status: 406,
      });
    }
  }

  private shape(plan: Plan, rows: Row[]): { data: unknown; error: PgError | null } {
    if (plan.single === "single") return { data: rows[0], error: null };
    if (plan.single === "maybeSingle") {
      if (rows.length > 1) {
        return {
          data: null,
          error: new PgError("PGRST116", "JSON object requested, multiple (or no) rows returned", {
            details: `Results contain ${rows.length} rows, application/vnd.pgrst.object+json requires 1 row`,
            status: 406,
          }),
        };
      }
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  }

  private readResult(def: TableDef, matched: Row[], plan: Plan, items: SelectItem[], sorter: ((a: Row, b: Row) => number) | null): Outcome {
    const { offset, limit } = this.window(plan);
    const count = this.countOf(plan, matched.length);
    if (count !== null && offset > 0 && offset >= count) {
      // PostgREST answers 416 when a count was requested and the page starts beyond the table. APPROXIMATION: real
      // PostgREST may answer 200 [] when offset == count exactly; a route that never asks for such a page is safe either way.
      throw new PgError("PGRST103", "Requested range not satisfiable", {
        details: `An offset of ${offset} was requested, but there are only ${count} rows.`,
        status: 416,
      });
    }
    const sorted = sorter ? [...matched].sort(sorter) : matched.slice();
    const projected = sorted.map((r) => this.project(def, r, items)).filter((r): r is Row => r !== null);
    const end = Number.isFinite(limit) ? offset + limit : undefined;
    const rows = projected.slice(offset, end);
    const status = count !== null && rows.length < count ? 206 : 200;
    if (plan.head) return { data: null, error: null, count, status };
    this.assertSingle(plan, rows.length);
    const shaped = this.shape(plan, rows);
    return { data: shaped.data, error: shaped.error, count: shaped.error ? null : count, status: shaped.error ? 406 : status };
  }

  private runSelect(plan: Plan): Outcome {
    const def = this.tableDef(plan.table ?? "");
    const items = this.compileSelect(def, plan.selectCols);
    const where = this.compileWhere(def, plan.filters);
    const sorter = this.compileOrder(def, plan.orders);
    const base = this.allows(def.name, "select") ? this.tables[def.name] : [];
    return this.readResult(def, base.filter(where), plan, items, sorter);
  }

  // ── writing: shared helpers ────────────────────────────────────────────────

  private parsePayloadRows(def: TableDef, wire: unknown): { rows: Row[]; columns: Set<string> } {
    const list = Array.isArray(wire) ? wire : [wire];
    if (wire === undefined || wire === null || list.some((r) => !isPlainObject(r))) {
      throw new PgError("PGRST102", "Empty or invalid json", { status: 400 });
    }
    const rows = list as Row[];
    const columns = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r)) columns.add(k);
    this.assertKnownColumns(def, columns);
    return { rows, columns };
  }

  private assertKnownColumns(def: TableDef, columns: Iterable<string>): void {
    for (const k of columns) {
      if (!def.columns.some((c) => c.name === k)) {
        throw new PgError("PGRST204", `Could not find the '${k}' column of '${def.name}' in the schema cache`, { status: 400 });
      }
    }
  }

  /** Builds a full row from a wire object: coercion (22xxx), defaults. Columns in the union but missing -> NULL. */
  private buildRow(def: TableDef, wire: Row, columns: Set<string>, defaultToNull: boolean, ts: number): Row {
    const row: Row = {};
    for (const col of def.columns) {
      const present = Object.prototype.hasOwnProperty.call(wire, col.name);
      if (present) row[col.name] = coerceWire(wire[col.name], col);
      else if (columns.has(col.name) && defaultToNull) row[col.name] = null;
      else row[col.name] = this.defaultFor(def, col, ts);
    }
    return row;
  }

  private checkRowConstraints(def: TableDef, row: Row): void {
    for (const col of def.columns) {
      if (col.notNull && (row[col.name] === null || row[col.name] === undefined)) {
        throw new PgError("23502", `null value in column "${col.name}" of relation "${def.name}" violates not-null constraint`);
      }
    }
    for (const ck of def.checks) {
      if (ck.holds(row) === false) {
        throw new PgError("23514", `new row for relation "${def.name}" violates check constraint "${ck.name}"`);
      }
    }
  }

  /** Post-statement uniqueness check over the whole resulting table (NULLs are distinct, like Postgres). */
  private checkUnique(def: TableDef, after: Row[]): void {
    for (const u of def.uniques) {
      const seen = new Set<string>();
      for (const r of after) {
        const v = r[u.column];
        if (v === null || v === undefined) continue;
        const k = keyOf(v);
        if (seen.has(k)) {
          throw new PgError("23505", `duplicate key value violates unique constraint "${u.name}"`, {
            details: `Key (${u.column})=(${k}) already exists.`,
          });
        }
        seen.add(k);
      }
    }
  }

  /** Child-side FK check; referenced rows are read WITHOUT RLS (Postgres RI checks bypass row security). */
  private checkForeignKeys(def: TableDef, rows: Row[], onlyColumns?: Set<string>): void {
    for (const fk of def.fks) {
      if (onlyColumns && !onlyColumns.has(fk.column)) continue;
      const referenced = new Set(this.tables[fk.refTable].map((r) => keyOf(r[fk.refColumn])));
      for (const row of rows) {
        const v = row[fk.column];
        if (v === null || v === undefined) continue;
        if (!referenced.has(keyOf(v))) {
          throw new PgError("23503", `insert or update on table "${def.name}" violates foreign key constraint "${fk.name}"`, {
            details: `Key (${fk.column})=(${keyOf(v)}) is not present in table "${fk.refTable}".`,
          });
        }
      }
    }
  }

  private mutationReturn(def: TableDef, plan: Plan, items: SelectItem[] | null, rows: Row[]): Row[] {
    if (!items) return [];
    const sorter = this.compileOrder(def, plan.orders);
    const ordered = sorter ? [...rows].sort(sorter) : rows;
    return ordered.map((r) => this.project(def, r, items)).filter((r): r is Row => r !== null);
  }

  private assertNoWindowOnMutation(plan: Plan): void {
    if (plan.limit !== null || plan.offset !== null) throw notImplemented("limit()/range() on an insert/update/delete/upsert");
  }

  private mutationOutcome(plan: Plan, def: TableDef, items: SelectItem[] | null, affected: Row[], status: number): Outcome {
    const returned = this.mutationReturn(def, plan, items, affected);
    const count = this.countOf(plan, affected.length);
    if (!items) return { data: null, error: null, count, status: status === 200 ? 204 : status };
    const shaped = this.shape(plan, returned);
    return { data: shaped.data, error: shaped.error, count: shaped.error ? null : count, status: shaped.error ? 406 : status };
  }

  // ── INSERT ─────────────────────────────────────────────────────────────────

  insertRows(def: TableDef, wire: unknown, plan: Plan, bypassRls: boolean, defaultToNull: boolean, items: SelectItem[] | null): Row[] {
    const { rows: wireRows, columns } = this.parsePayloadRows(def, wire);
    const ts = this.tick();
    const created: Row[] = [];
    for (const w of wireRows) {
      const row = this.buildRow(def, w, columns, defaultToNull, ts);
      if (!bypassRls) this.checkInsertRls(def, items !== null);
      this.checkRowConstraints(def, row);
      created.push(row);
    }
    this.checkUnique(def, [...this.tables[def.name], ...created]);
    this.checkForeignKeys(def, created);
    this.assertSingle(plan, created.length);
    this.tables[def.name] = [...this.tables[def.name], ...created];
    return created;
  }

  private checkInsertRls(def: TableDef, returning: boolean): void {
    if (!this.allows(def.name, "insert") || (returning && !this.allows(def.name, "select"))) throw this.rlsViolation(def.name);
  }

  private runInsert(plan: Plan, wire: unknown): Outcome {
    const def = this.tableDef(plan.table ?? "");
    this.assertNoWindowOnMutation(plan);
    const items = plan.returning ? this.compileSelect(def, plan.selectCols) : null;
    const created = this.insertRows(def, wire, plan, false, plan.defaultToNull, items);
    return this.mutationOutcome(plan, def, items, created, 201);
  }

  // ── UPDATE ─────────────────────────────────────────────────────────────────

  private parsePatch(def: TableDef, wire: unknown): Row {
    if (!isPlainObject(wire)) throw new PgError("PGRST102", "Empty or invalid json", { status: 400 });
    this.assertKnownColumns(def, Object.keys(wire));
    const patch: Row = {};
    for (const col of def.columns) {
      if (Object.prototype.hasOwnProperty.call(wire, col.name)) patch[col.name] = coerceWire(wire[col.name], col);
    }
    return patch;
  }

  private runUpdate(plan: Plan, wire: unknown): Outcome {
    const def = this.tableDef(plan.table ?? "");
    this.assertNoWindowOnMutation(plan);
    const items = plan.returning ? this.compileSelect(def, plan.selectCols) : null;
    const where = this.compileWhere(def, plan.filters);
    if (plan.filters.length === 0) {
      throw new PgError("21000", "UPDATE requires a WHERE clause", { hint: 'To update all rows in a table, use "WHERE true" or similar.', status: 400 });
    }
    const patch = this.parsePatch(def, wire);
    // An UPDATE needs at least one column to SET, so PostgREST compiles a body without columns ({} - which is also what
    // `update({ name: undefined })` sends, JSON drops the key) into `SELECT .. WHERE false`: it matches no rows. The
    // caller sees [] (or 204 without .select(), or PGRST116 with .single()); nothing is written and no trigger runs.
    const hasColumns = Object.keys(patch).length > 0;
    // The WHERE clause reads columns, so Postgres also applies the SELECT policy; the UPDATE policy filters too.
    const allowed = hasColumns && this.allows(def.name, "select") && this.allows(def.name, "update");
    const candidates = allowed ? this.tables[def.name].filter(where) : [];
    const ts = this.tick();
    const changedColumns = new Set(Object.keys(patch));
    const pairs = candidates.map((old) => {
      const next: Row = { ...old, ...patch };
      if (def.updatedAtColumn && changedColumns.size > 0) next[def.updatedAtColumn] = formatTimestamp(ts); // BEFORE UPDATE trigger
      return { old, next };
    });
    for (const p of pairs) this.checkRowConstraints(def, p.next);
    const byOld = new Map(pairs.map((p) => [p.old, p.next]));
    const after = this.tables[def.name].map((r) => byOld.get(r) ?? r);
    const changedFk = new Set<string>();
    for (const fk of def.fks) {
      if (pairs.some((p) => !(p.old[fk.column] === p.next[fk.column]))) changedFk.add(fk.column);
    }
    this.checkUnique(def, after);
    this.checkForeignKeys(def, pairs.map((p) => p.next), changedFk);
    this.assertSingle(plan, pairs.length);
    this.tables[def.name] = after;
    return this.mutationOutcome(plan, def, items, pairs.map((p) => p.next), 200);
  }

  // ── DELETE ─────────────────────────────────────────────────────────────────

  private cascadeDelete(
    table: TableName,
    victims: Row[],
    ts: number,
    removed: Map<TableName, Set<Row>>,
    replaced: Map<TableName, Map<Row, Row>>
  ): void {
    const gone = removed.get(table) ?? new Set<Row>();
    for (const v of victims) gone.add(v);
    removed.set(table, gone);
    for (const childDef of Object.values(this.schema)) {
      for (const fk of childDef.fks) {
        if (fk.refTable !== table) continue;
        const keys = new Set(victims.map((v) => keyOf(v[fk.refColumn])));
        const children = this.tables[childDef.name].filter(
          (c) => c[fk.column] !== null && keys.has(keyOf(c[fk.column])) && !removed.get(childDef.name)?.has(c)
        );
        if (children.length === 0) continue;
        if (fk.onDelete === "restrict") {
          throw new PgError("23503", `update or delete on table "${table}" violates foreign key constraint "${fk.name}" on table "${childDef.name}"`, {
            details: `Key (${fk.refColumn})=(${keyOf(children[0][fk.column])}) is still referenced from table "${childDef.name}".`,
          });
        }
        if (fk.onDelete === "cascade") {
          this.cascadeDelete(childDef.name, children, ts, removed, replaced);
        } else {
          const map = replaced.get(childDef.name) ?? new Map<Row, Row>();
          for (const c of children) {
            const next: Row = { ...(map.get(c) ?? c), [fk.column]: null };
            if (childDef.updatedAtColumn) next[childDef.updatedAtColumn] = formatTimestamp(ts); // SET NULL is an UPDATE
            map.set(c, next);
          }
          replaced.set(childDef.name, map);
        }
      }
    }
  }

  private runDelete(plan: Plan): Outcome {
    const def = this.tableDef(plan.table ?? "");
    this.assertNoWindowOnMutation(plan);
    const items = plan.returning ? this.compileSelect(def, plan.selectCols) : null;
    const where = this.compileWhere(def, plan.filters);
    if (plan.filters.length === 0) {
      throw new PgError("21000", "DELETE requires a WHERE clause", { hint: 'To delete all rows in a table, use "WHERE true" or similar.', status: 400 });
    }
    const allowed = this.allows(def.name, "select") && this.allows(def.name, "delete");
    const victims = allowed ? this.tables[def.name].filter(where) : [];
    const ts = this.tick();
    const removed = new Map<TableName, Set<Row>>();
    const replaced = new Map<TableName, Map<Row, Row>>();
    if (victims.length > 0) this.cascadeDelete(def.name, victims, ts, removed, replaced);
    this.assertSingle(plan, victims.length);
    for (const name of TABLE_NAMES) {
      const gone = removed.get(name);
      const swap = replaced.get(name);
      if (!gone && !swap) continue;
      this.tables[name] = this.tables[name].filter((r) => !gone?.has(r)).map((r) => swap?.get(r) ?? r);
    }
    return this.mutationOutcome(plan, def, items, victims, 200);
  }

  // ── UPSERT (INSERT .. ON CONFLICT) ─────────────────────────────────────────

  private runUpsert(plan: Plan, wire: unknown): Outcome {
    const def = this.tableDef(plan.table ?? "");
    this.assertNoWindowOnMutation(plan);
    const items = plan.returning ? this.compileSelect(def, plan.selectCols) : null;
    const { rows: wireRows, columns } = this.parsePayloadRows(def, wire);
    const targetColumns = (plan.onConflict ?? "id").split(",").map((s) => s.trim());
    if (targetColumns.length !== 1) throw notImplemented("multi-column on_conflict");
    const target = targetColumns[0];
    if (!def.uniques.some((u) => u.column === target)) {
      throw new PgError("42P10", "there is no unique or exclusion constraint matching the ON CONFLICT specification", { status: 400 });
    }
    const ts = this.tick();
    const existingByKey = new Map<string, Row>();
    for (const r of this.tables[def.name]) {
      const v = r[target];
      if (v !== null && v !== undefined) existingByKey.set(keyOf(v), r);
    }
    const touched = new Set<string>();
    const created: Row[] = [];
    const replacements = new Map<Row, Row>();
    const affected: Row[] = [];

    for (const w of wireRows) {
      const proposed = this.buildRow(def, w, columns, plan.defaultToNull, ts);
      this.checkInsertRls(def, items !== null); // the INSERT policy applies to the proposed row even when it conflicts
      this.checkRowConstraints(def, proposed);
      const v = proposed[target];
      const k = v === null || v === undefined ? null : keyOf(v);
      if (k !== null && touched.has(k)) {
        if (plan.ignoreDuplicates) continue;
        throw new PgError("21000", "ON CONFLICT DO UPDATE command cannot affect row a second time", {
          hint: "Ensure that no rows proposed for insertion within the same command have duplicate constrained values.",
          status: 400,
        });
      }
      const existing = k === null ? undefined : existingByKey.get(k);
      if (existing) {
        if (plan.ignoreDuplicates) continue;
        if (!this.allows(def.name, "select") || !this.allows(def.name, "update")) throw this.rlsViolation(def.name, true);
        const next: Row = { ...existing };
        for (const c of columns) next[c] = proposed[c]; // DO UPDATE SET col = EXCLUDED.col for the payload's columns
        if (def.updatedAtColumn) next[def.updatedAtColumn] = formatTimestamp(ts);
        this.checkRowConstraints(def, next);
        replacements.set(existing, next);
        affected.push(next);
      } else {
        created.push(proposed);
        affected.push(proposed);
      }
      if (k !== null) touched.add(k);
    }
    const after = [...this.tables[def.name].map((r) => replacements.get(r) ?? r), ...created];
    this.checkUnique(def, after);
    this.checkForeignKeys(def, affected);
    this.assertSingle(plan, affected.length);
    this.tables[def.name] = after;
    return this.mutationOutcome(plan, def, items, affected, 201);
  }

  // ── RPC ────────────────────────────────────────────────────────────────────

  private functionNotFound(fn: string, names: string[]): PgError {
    const sorted = [...names].sort();
    return new PgError("PGRST202", `Could not find the function public.${fn}(${sorted.join(", ")}) in the schema cache`, {
      details: `Searched for the function public.${fn} with parameter names ${sorted.join(", ")} or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`,
      hint: fn === "record_transaction" ? `Perhaps you meant to call the function public.record_transaction(${RPC_ALLOWED.slice().sort().join(", ")})` : null,
      status: 404,
    });
  }

  /** supabase/schema.sql `record_transaction`, statement for statement. SECURITY DEFINER => no RLS. Atomic. */
  private runRpc(plan: Plan, wire: unknown): Outcome {
    const fn = plan.fn ?? "";
    const args: Row = isPlainObject(wire) ? wire : {};
    const names = Object.keys(args);
    if (fn !== "record_transaction" || !RPC_REQUIRED.every((n) => names.includes(n)) || names.some((n) => !RPC_ALLOWED.includes(n))) {
      throw this.functionNotFound(fn, names);
    }
    const medDef = this.schema.medications;
    const txDef = this.schema.transactions;
    const pId = coerceWire(args.p_medication_id, { type: "int8" }) as number | null;
    const pType = coerceWire(args.p_type, { type: "text" }) as string | null;
    const pQuantity = coerceWire(args.p_quantity, { type: "int4" }) as number | null;
    const pNote = coerceWire(args.p_note, { type: "text" }) as string | null;

    // SELECT stock INTO v_stock FROM medications WHERE id = p_medication_id FOR UPDATE;  IF NOT FOUND THEN RAISE ...
    const med = pId === null ? undefined : this.tables.medications.find((m) => m.id === pId);
    if (!med) throw new PgError("P0001", "Medication not found");
    const stock = med.stock as number;
    if (pType === "dispense" && pQuantity !== null && stock < pQuantity) {
      throw new PgError("P0001", `Insufficient stock. Current stock: ${stock}`);
    }
    const delta = pQuantity === null ? null : pType === "receive" ? pQuantity : -pQuantity;

    // INSERT INTO transactions (medication_id, type, quantity, note) VALUES (...)
    const ts = this.tick();
    const columns = new Set(["medication_id", "type", "quantity", "note"]);
    const txRow = this.buildRow(txDef, { medication_id: pId, type: pType, quantity: pQuantity, note: pNote }, columns, true, ts);
    this.checkRowConstraints(txDef, txRow);
    this.checkForeignKeys(txDef, [txRow]);

    // UPDATE medications SET stock = stock + v_delta WHERE id = p_medication_id;   (+ updated_at trigger)
    const newStock = delta === null ? null : stock + delta;
    if (newStock !== null && (newStock > 2147483647 || newStock < -2147483648)) throw new PgError("22003", "integer out of range");
    const next: Row = { ...med, stock: newStock, updated_at: formatTimestamp(ts) };
    this.checkRowConstraints(medDef, next);

    // RETURN QUERY SELECT * FROM medications WHERE id = p_medication_id;
    const items = this.compileSelect(medDef, plan.selectCols);
    const where = this.compileWhere(medDef, plan.filters);
    const sorter = this.compileOrder(medDef, plan.orders);
    const result = this.readResult(medDef, [next].filter(where), plan, items, sorter);
    if (result.error === null) {
      this.tables.transactions = [...this.tables.transactions, txRow];
      this.tables.medications = this.tables.medications.map((m) => (m === med ? next : m));
    }
    return result;
  }

  // ── dispatch ───────────────────────────────────────────────────────────────

  execute(plan: Plan, wire: unknown): Outcome {
    switch (plan.op) {
      case "select":
        return this.runSelect(plan);
      case "insert":
        return this.runInsert(plan, wire);
      case "update":
        return this.runUpdate(plan, wire);
      case "upsert":
        return this.runUpsert(plan, wire);
      case "delete":
        return this.runDelete(plan);
      case "rpc":
        return this.runRpc(plan, wire);
    }
  }

  // ── seeding (bypasses RLS and triggers; enforces every constraint; sequences are advanced like setval) ──

  seed(tableName: TableName, rows: readonly Row[]): void {
    const def = this.tableDef(tableName);
    try {
      const wire = toWire(rows) as Row[];
      const plan = newPlan("insert", tableName);
      this.insertRows(def, wire, plan, true, false, null);
      const idCol = def.columns.find((c) => c.name === "id");
      if (idCol && idCol.type === "int8") {
        this.sequences[tableName] = this.tables[tableName].reduce((max, r) => Math.max(max, r.id as number), this.sequences[tableName]);
      }
    } catch (e) {
      if (e instanceof PgError) {
        throw new Error(`fake-supabase seed(${tableName}) failed: [${e.code}] ${e.message}${e.details ? ` — ${e.details}` : ""}`);
      }
      throw e;
    }
  }
}

function newPlan(op: Plan["op"], table: string | null): Plan {
  return {
    op,
    table,
    fn: null,
    body: undefined,
    selectCols: null,
    returning: false,
    head: false,
    count: null,
    filters: [],
    orders: [],
    limit: null,
    offset: null,
    single: null,
    onConflict: null,
    ignoreDuplicates: false,
    defaultToNull: true,
    throwOnError: false,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Internal: builders (the supabase-js surface)
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The Error postgrest-js throws when `.throwOnError()` is used. */
class FakePostgrestError extends Error {
  readonly details: string | null;
  readonly hint: string | null;
  readonly code: string;
  constructor(e: FakeError) {
    super(e.message);
    this.name = "PostgrestError";
    this.details = e.details;
    this.hint = e.hint;
    this.code = e.code;
  }
}

class Builder implements FakeFilterBuilder {
  constructor(
    private readonly plan: Plan,
    private readonly runner: (plan: Plan) => FakeResponse
  ) {}

  select(columns?: string): FakeFilterBuilder {
    this.plan.selectCols = cleanSelect(columns);
    this.plan.returning = true;
    return this;
  }

  private addFilter(column: string, operator: string, value: unknown, expr: string): this {
    this.plan.filters.push({ column, expr, operator, value });
    return this;
  }

  eq(column: string, value: unknown): FakeFilterBuilder {
    return this.addFilter(column, "eq", value, `eq.${String(value)}`);
  }
  neq(column: string, value: unknown): FakeFilterBuilder {
    return this.addFilter(column, "neq", value, `neq.${String(value)}`);
  }
  gt(column: string, value: unknown): FakeFilterBuilder {
    return this.addFilter(column, "gt", value, `gt.${String(value)}`);
  }
  gte(column: string, value: unknown): FakeFilterBuilder {
    return this.addFilter(column, "gte", value, `gte.${String(value)}`);
  }
  lt(column: string, value: unknown): FakeFilterBuilder {
    return this.addFilter(column, "lt", value, `lt.${String(value)}`);
  }
  lte(column: string, value: unknown): FakeFilterBuilder {
    return this.addFilter(column, "lte", value, `lte.${String(value)}`);
  }
  like(column: string, pattern: string): FakeFilterBuilder {
    return this.addFilter(column, "like", pattern, `like.${pattern}`);
  }
  ilike(column: string, pattern: string): FakeFilterBuilder {
    return this.addFilter(column, "ilike", pattern, `ilike.${pattern}`);
  }
  is(column: string, value: unknown): FakeFilterBuilder {
    return this.addFilter(column, "is", value, `is.${String(value)}`);
  }
  in(column: string, values: readonly unknown[]): FakeFilterBuilder {
    const cleaned = Array.from(new Set(values))
      .map((s) => (typeof s === "string" && /[,()]/.test(s) ? `"${s}"` : String(s)))
      .join(",");
    return this.addFilter(column, "in", values, `in.(${cleaned})`);
  }
  not(column: string, operator: string, value: unknown): FakeFilterBuilder {
    return this.addFilter(column, `not.${operator}`, value, `not.${operator}.${String(value)}`);
  }
  match(query: Record<string, unknown>): FakeFilterBuilder {
    for (const [column, value] of Object.entries(query)) {
      if (value !== undefined) this.addFilter(column, "eq", value, `eq.${String(value)}`);
    }
    return this;
  }
  filter(column: string, operator: string, value: unknown): FakeFilterBuilder {
    return this.addFilter(column, operator, value, `${operator}.${String(value)}`);
  }

  order(
    column: string,
    options: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string; foreignTable?: string } = {}
  ): FakeFilterBuilder {
    if (options.referencedTable !== undefined || options.foreignTable !== undefined) throw notImplemented("order() on a referenced table");
    this.plan.orders.push({ column, ascending: options.ascending ?? true, nullsFirst: options.nullsFirst ?? null });
    return this;
  }
  limit(count: number, options: { referencedTable?: string; foreignTable?: string } = {}): FakeFilterBuilder {
    if (options.referencedTable !== undefined || options.foreignTable !== undefined) throw notImplemented("limit() on a referenced table");
    this.plan.limit = count;
    return this;
  }
  range(from: number, to: number, options: { referencedTable?: string; foreignTable?: string } = {}): FakeFilterBuilder {
    if (options.referencedTable !== undefined || options.foreignTable !== undefined) throw notImplemented("range() on a referenced table");
    this.plan.offset = from;
    this.plan.limit = to - from + 1;
    return this;
  }
  single(): FakeFilterBuilder {
    this.plan.single = "single";
    return this;
  }
  maybeSingle(): FakeFilterBuilder {
    this.plan.single = "maybeSingle";
    return this;
  }
  throwOnError(): FakeFilterBuilder {
    this.plan.throwOnError = true;
    return this;
  }
  returns(): FakeFilterBuilder {
    return this;
  }
  overrideTypes(): FakeFilterBuilder {
    return this;
  }
  abortSignal(signal: AbortSignal): FakeFilterBuilder {
    void signal;
    return this;
  }
  retry(enabled: boolean): FakeFilterBuilder {
    void enabled;
    return this;
  }

  then<TResult1 = FakeResponse, TResult2 = never>(
    onfulfilled?: ((value: FakeResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    // Like the real client, the request is made when the builder is awaited (once per `then`).
    return new Promise<FakeResponse>((resolve, reject) => {
      try {
        const response = this.runner(this.plan);
        if (this.plan.throwOnError && response.error) throw new FakePostgrestError(response.error);
        resolve(response);
      } catch (e) {
        reject(e);
      }
    }).then(onfulfilled, onrejected);
  }
}

const UNSUPPORTED_BUILDER_METHODS = [
  "or",
  "contains",
  "containedBy",
  "overlaps",
  "textSearch",
  "rangeGt",
  "rangeGte",
  "rangeLt",
  "rangeLte",
  "rangeAdjacent",
  "isDistinct",
  "notIn",
  "likeAllOf",
  "likeAnyOf",
  "ilikeAllOf",
  "ilikeAnyOf",
  "regexMatch",
  "regexIMatch",
  "csv",
  "geojson",
  "explain",
  "rollback",
  "maxAffected",
  "stripNulls",
  "setHeader",
] as const;

for (const name of UNSUPPORTED_BUILDER_METHODS) {
  Object.defineProperty(Builder.prototype, name, {
    enumerable: false,
    value: function unsupported(): never {
      throw notImplemented(`.${name}()`);
    },
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Public: factory
// ═════════════════════════════════════════════════════════════════════════════════════════════

const DEFAULT_RLS: Record<TableName, Record<RlsOperation, boolean>> = {
  medications: { select: true, insert: true, update: true, delete: true },
  categories: { select: true, insert: true, update: true, delete: true },
  // supabase/rls.sql: SELECT only. Inserts happen inside the SECURITY DEFINER rpc; cascades bypass RLS.
  transactions: { select: true, insert: false, update: false, delete: false },
};

function resolvePolicy(base: Record<RlsOperation, boolean>, policy: RlsPolicy | undefined): Record<RlsOperation, boolean> {
  if (policy === undefined) return { ...base };
  if (typeof policy === "boolean") return { select: policy, insert: policy, update: policy, delete: policy };
  return { ...base, ...policy };
}

function bodySize(body: unknown): number {
  if (typeof body === "string") return body.length;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  return 0;
}

function matchesFailure(m: FailureMatcher | undefined, call: Pick<RecordedCall, "table" | "fn" | "bucket" | "op">): boolean {
  if (!m) return true;
  if (m.table !== undefined && m.table !== call.table) return false;
  if (m.fn !== undefined && m.fn !== call.fn) return false;
  if (m.bucket !== undefined && m.bucket !== call.bucket) return false;
  if (m.op !== undefined) {
    const ops = Array.isArray(m.op) ? m.op : [m.op];
    if (!ops.includes(call.op)) return false;
  }
  return true;
}

interface InjectedFailure {
  error: FakeError;
  status: number;
  matcher: FailureMatcher | undefined;
  once: boolean;
}

function toFakeError(e: ErrorLike): { error: FakeError; status: number } {
  const code = e.code ?? "";
  return {
    error: { code, message: e.message, details: e.details ?? null, hint: e.hint ?? null },
    status: e.status ?? statusForCode(code),
  };
}

export function createFakeSupabase(options: FakeSupabaseOptions = {}): FakeSupabase {
  const idType = options.categoryIdType ?? "uuid";
  if (idType !== "uuid" && idType !== "bigint") throw new Error(`fake-supabase: unknown categoryIdType "${String(idType)}"`);
  // Fail fast on typos: a misspelt table or operation in `rls` would otherwise silently keep the permissive default.
  for (const [table, policy] of Object.entries(options.rls ?? {})) {
    if (!(TABLE_NAMES as readonly string[]).includes(table)) throw new Error(`fake-supabase: unknown table "${table}" in options.rls`);
    if (policy !== null && typeof policy === "object") {
      for (const op of Object.keys(policy)) {
        if (!["select", "insert", "update", "delete"].includes(op)) throw new Error(`fake-supabase: unknown operation "${op}" in options.rls.${table}`);
      }
    }
  }
  if (options.maxRows !== undefined && !(options.maxRows > 0)) throw new Error("fake-supabase: maxRows must be a positive number (or omitted for no cap)");
  const resolved: { -readonly [K in keyof ResolvedFakeOptions]: ResolvedFakeOptions[K] } = {
    categoryIdType: idType,
    hasSupplierColumn: options.hasSupplierColumn ?? true,
    rls: {
      categories: resolvePolicy(DEFAULT_RLS.categories, options.rls?.categories),
      medications: resolvePolicy(DEFAULT_RLS.medications, options.rls?.medications),
      transactions: resolvePolicy(DEFAULT_RLS.transactions, options.rls?.transactions),
    },
    maxRows: options.maxRows ?? Number.POSITIVE_INFINITY,
    categoryFkOnDelete: options.categoryFkOnDelete ?? "restrict",
    collation: options.collation ?? "en-US",
    countSupported: options.countSupported ?? true,
  };
  const db = new Database(resolved, options.now ?? (() => new Date()));

  const calls: RecordedCall[] = [];
  const failures: InjectedFailure[] = [];
  const hooks: CallHook[] = [];
  const storedUploads: UploadRecord[] = [];
  let seq = 0;

  /** Runs the registered hooks for `record`, which was just pushed onto `calls`. A hook that throws aborts the call. */
  function runHooks(record: RecordedCall): void {
    const index = calls.length - 1;
    for (const hook of [...hooks]) {
      if (hooks.includes(hook)) hook(record, index); // skip a hook another hook removed earlier in this round
    }
  }

  function takeFailure(call: Pick<RecordedCall, "table" | "fn" | "bucket" | "op">): InjectedFailure | null {
    const queued = failures.findIndex((f) => f.once && matchesFailure(f.matcher, call));
    if (queued >= 0) return failures.splice(queued, 1)[0];
    return failures.find((f) => !f.once && matchesFailure(f.matcher, call)) ?? null;
  }

  function respond(error: FakeError, status: number): FakeResponse {
    return { success: false, error, data: null, count: null, status, statusText: STATUS_TEXT[status] ?? "" };
  }

  function runPlan(plan: Plan): FakeResponse {
    const wire = toWire(plan.body);
    const record: RecordedCall = {
      seq: ++seq,
      op: plan.op,
      table: plan.table,
      fn: plan.fn,
      bucket: null,
      filters: plan.filters.map((f) => ({ ...f })),
      payload: wire,
      select: plan.returning ? plan.selectCols : null,
      returning: plan.returning,
      order: plan.orders.map((o) => ({ ...o })),
      limit: plan.limit,
      offset: plan.offset,
      single: plan.single,
      count: plan.count,
      onConflict: plan.onConflict,
      injected: false,
      result: null,
    };
    calls.push(record);
    runHooks(record);

    const failure = takeFailure(record);
    if (failure) {
      record.injected = true;
      record.result = { status: failure.status, error: failure.error, rows: null };
      return respond(failure.error, failure.status);
    }
    try {
      const outcome = db.execute(plan, wire);
      if (outcome.error) {
        const err = outcome.error.toFake();
        record.result = { status: outcome.error.status, error: err, rows: null };
        return respond(err, outcome.error.status);
      }
      const data = outcome.data === undefined ? null : (structuredClone(outcome.data) as unknown);
      const rows = Array.isArray(data) ? data.length : data === null ? null : 1;
      record.result = { status: outcome.status, error: null, rows };
      return {
        success: true,
        error: null,
        data,
        count: outcome.count,
        status: outcome.status,
        statusText: STATUS_TEXT[outcome.status] ?? "",
      };
    } catch (e) {
      if (e instanceof PgError) {
        const err = e.toFake();
        record.result = { status: e.status, error: err, rows: null };
        return respond(err, e.status);
      }
      throw e;
    }
  }

  function makeBuilder(plan: Plan): FakeFilterBuilder {
    return new Builder(plan, runPlan);
  }

  function from(table: string): FakeQueryBuilder {
    if (typeof table !== "string" || table.trim() === "") throw new Error("Invalid relation name: relation must be a non-empty string.");
    return {
      select(columns, opts) {
        const plan = newPlan("select", table);
        plan.selectCols = cleanSelect(columns);
        plan.returning = true;
        plan.head = opts?.head === true;
        plan.count = opts?.count ?? null;
        return makeBuilder(plan);
      },
      insert(values, opts) {
        const plan = newPlan("insert", table);
        plan.body = values;
        plan.count = opts?.count ?? null;
        plan.defaultToNull = opts?.defaultToNull ?? true;
        return makeBuilder(plan);
      },
      upsert(values, opts) {
        const plan = newPlan("upsert", table);
        plan.body = values;
        plan.onConflict = opts?.onConflict ?? null;
        plan.ignoreDuplicates = opts?.ignoreDuplicates ?? false;
        plan.count = opts?.count ?? null;
        plan.defaultToNull = opts?.defaultToNull ?? true;
        return makeBuilder(plan);
      },
      update(values, opts) {
        const plan = newPlan("update", table);
        plan.body = values;
        plan.count = opts?.count ?? null;
        return makeBuilder(plan);
      },
      delete(opts) {
        const plan = newPlan("delete", table);
        plan.count = opts?.count ?? null;
        return makeBuilder(plan);
      },
    };
  }

  function rpc(fn: string, args: Record<string, unknown> = {}, opts?: { count?: CountMode }): FakeFilterBuilder {
    const plan = newPlan("rpc", null);
    plan.fn = fn;
    plan.body = args;
    plan.returning = true;
    plan.selectCols = "*";
    plan.count = opts?.count ?? null;
    return makeBuilder(plan);
  }

  const storage: FakeClient["storage"] = {
    from(bucket: string): FakeStorageBucket {
      return {
        async upload(path, body, uploadOptions) {
          const contentType = uploadOptions?.contentType ?? null;
          const size = bodySize(body);
          const record: RecordedCall = {
            seq: ++seq,
            op: "storage.upload",
            table: null,
            fn: null,
            bucket,
            filters: [],
            payload: { path, contentType, size, upsert: uploadOptions?.upsert === true },
            select: null,
            returning: false,
            order: [],
            limit: null,
            offset: null,
            single: null,
            count: null,
            onConflict: null,
            injected: false,
            result: null,
          };
          calls.push(record);
          runHooks(record);
          const storageError = (message: string, status: number): FakeStorageError => ({
            name: "StorageApiError",
            message,
            status,
            statusCode: String(status),
          });
          const failure = takeFailure(record);
          if (failure) {
            record.injected = true;
            record.result = { status: failure.status, error: failure.error, rows: null };
            return { data: null, error: storageError(failure.error.message, failure.status) };
          }
          const exists = storedUploads.some((u) => u.bucket === bucket && u.path === path);
          if (exists && uploadOptions?.upsert !== true) {
            const err = { code: "Duplicate", message: "The resource already exists", details: null, hint: null };
            record.result = { status: 409, error: err, rows: null };
            return { data: null, error: storageError("The resource already exists", 409) };
          }
          if (!exists) storedUploads.push({ bucket, path, contentType, size });
          record.result = { status: 200, error: null, rows: 1 };
          return { data: { id: `fake-object-${storedUploads.length}`, path, fullPath: `${bucket}/${path}` }, error: null };
        },
        getPublicUrl(path) {
          return { data: { publicUrl: `https://fake-supabase.invalid/storage/v1/object/public/${bucket}/${path}` } };
        },
      };
    },
  };

  const helpers = {
    options: resolved,
    calls,
    callsFor(name: string): RecordedCall[] {
      return calls.filter((c) => c.table === name || c.fn === name || c.bucket === name);
    },
    writes(): RecordedCall[] {
      const writeOps: CallOp[] = ["insert", "update", "upsert", "delete", "rpc", "storage.upload"];
      return calls.filter((c) => writeOps.includes(c.op));
    },
    clearCalls(): void {
      calls.length = 0;
    },
    failNext(error: ErrorLike, matcher?: FailureMatcher): void {
      failures.push({ ...toFakeError(error), matcher, once: true });
    },
    failAll(error: ErrorLike, matcher?: FailureMatcher): void {
      failures.push({ ...toFakeError(error), matcher, once: false });
    },
    clearFailures(): void {
      failures.length = 0;
    },
    onCall(hook: CallHook): () => void {
      hooks.push(hook);
      return () => {
        const at = hooks.indexOf(hook);
        if (at >= 0) hooks.splice(at, 1);
      };
    },
    clearHooks(): void {
      hooks.length = 0;
    },
    seedCategories(rows: readonly SeedCategory[]): void {
      db.seed(
        "categories",
        rows.map((r) => {
          const { created_at: createdAt, ...rest } = r;
          return createdAt === null || createdAt === undefined ? { ...rest } : { ...rest, created_at: createdAt };
        })
      );
    },
    seedMedications(rows: readonly SeedMedication[]): void {
      db.seed(
        "medications",
        rows.map((r) => {
          const copy: Row = { ...r };
          if (!resolved.hasSupplierColumn && (r.supplier_order_number === null || r.supplier_order_number === undefined)) {
            delete copy.supplier_order_number;
          }
          return copy;
        })
      );
    },
    seedTransactions(rows: readonly SeedTransaction[]): void {
      db.seed(
        "transactions",
        rows.map((r) => ({ ...r }))
      );
    },
    dump(table: TableName): Row[] {
      return structuredClone(db.tableDef(table) && db.tables[table]);
    },
    setRls(table: TableName, policy: RlsPolicy): void {
      resolved.rls[table] = resolvePolicy(DEFAULT_RLS[table], policy);
    },
    uploads(): UploadRecord[] {
      return storedUploads.map((u) => ({ ...u }));
    },
  };

  return Object.assign({ from, rpc, storage }, helpers) satisfies FakeSupabase;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Public: vi.mock helpers (accessor over a globalThis slot + delegating client)
// ═════════════════════════════════════════════════════════════════════════════════════════════

// The installed fake lives on globalThis, NOT in a module variable. vi.resetModules() makes the next import of this file
// a second copy of the module, and a `vi.mock("@/lib/db", factory)` whose factory imports this file (pattern A) hands
// that copy's `supabaseProxy` to the route; a module-level variable would be null in the copy while the test installed
// its fake through the first copy. A global-registry symbol is the same slot for every copy in the same worker.
const INSTALLED_KEY = Symbol.for("medication-inventory.fake-supabase.installed");

function readInstalled(): FakeSupabase | null {
  const value: unknown = Reflect.get(globalThis, INSTALLED_KEY);
  return value === undefined || value === null ? null : (value as FakeSupabase);
}

/** Creates a fresh fake and makes it the one `supabaseProxy` delegates to. Call it in `beforeEach`. */
export function installFake(options?: FakeSupabaseOptions): FakeSupabase {
  const fake = createFakeSupabase(options);
  Reflect.set(globalThis, INSTALLED_KEY, fake);
  return fake;
}

/** Forgets the installed fake, so a route that runs without one fails loudly. Optional: call it in `afterEach`. */
export function uninstallFake(): void {
  Reflect.deleteProperty(globalThis, INSTALLED_KEY);
}

export function getFake(): FakeSupabase {
  const fake = readInstalled();
  if (!fake) throw new Error("fake-supabase: no fake installed. Call installFake() (usually in beforeEach) before the route runs.");
  return fake;
}

/** A stable client whose every call goes to the fake currently installed with installFake(). Mock `@/lib/db` with this. */
export const supabaseProxy: FakeClient = {
  from: (table) => getFake().from(table),
  rpc: (fn, args, opts) => getFake().rpc(fn, args, opts),
  storage: { from: (bucket) => getFake().storage.from(bucket) },
};

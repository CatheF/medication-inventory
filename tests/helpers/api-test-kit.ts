// Small shared kit for the requirement-driven API tests (tests/api/*.test.ts). Test support only; synthetic data.
//
//   * ID_SHAPES      the two database shapes every id-related test runs against (live uuid / schema.sql bigint)
//   * json helpers   route responses are `unknown` on purpose; these narrow them with readable failures
//   * snapshotDb     the whole fake database, for "nothing changed" assertions
import type { FakeSupabase, FakeSupabaseOptions, Row } from "./fake-supabase";
import { LIVE_AFTER_MIGRATION, REPO_SCHEMA_SHAPE } from "./fake-supabase";
import type { IdShape } from "./fixtures";

export type ShapeCase = {
  /** "uuid" | "bigint": used in test titles through $name */
  name: IdShape;
  shape: IdShape;
  /** Human wording for titles: "live database (uuid ids)" */
  label: string;
  options: FakeSupabaseOptions;
};

/**
 * Both database shapes. "uuid" is the live Health Center project (after the planned migration: categories readable and
 * insertable by anon, supplier column present); "bigint" is supabase/schema.sql as written.
 */
export const ID_SHAPES: readonly ShapeCase[] = [
  { name: "uuid", shape: "uuid", label: "live database (uuid ids)", options: LIVE_AFTER_MIGRATION },
  { name: "bigint", shape: "bigint", label: "schema.sql (bigint ids)", options: REPO_SCHEMA_SHAPE },
];

/** A well-formed category id that no seeded category has, in the given shape. */
export function absentCategoryId(shape: IdShape): string {
  return shape === "uuid" ? "deadbeef-0000-4000-8000-00000000ffff" : "987654";
}

/** A well-formed id of the OTHER shape (what a stale or hand-made request might send). */
export function foreignShapeCategoryId(shape: IdShape): string {
  return shape === "uuid" ? "7" : "deadbeef-0000-4000-8000-000000000001";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` as an object, or a thrown Error that shows what it was (so a failing test says why). */
export function asRecord(value: unknown, what = "response body"): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Expected ${what} to be a JSON object, got ${JSON.stringify(value)}`);
  return value;
}

/** `value` as an array of objects. */
export function asRecordList(value: unknown, what = "response body"): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`Expected ${what} to be a JSON array, got ${JSON.stringify(value)}`);
  return value.map((entry, index) => asRecord(entry, `${what}[${index}]`));
}

export async function bodyRecord(res: Response): Promise<Record<string, unknown>> {
  return asRecord((await res.json()) as unknown);
}

export async function bodyList(res: Response): Promise<Record<string, unknown>[]> {
  return asRecordList((await res.json()) as unknown);
}

/** The `error` text of an error response body ("" when there is none). */
export function errorTextOf(body: unknown): string {
  return isRecord(body) && typeof body.error === "string" ? body.error : "";
}

/** The whole fake database as stored (deep copies), for before/after comparisons. */
export function snapshotDb(fake: FakeSupabase): { categories: Row[]; medications: Row[]; transactions: Row[] } {
  return { categories: fake.dump("categories"), medications: fake.dump("medications"), transactions: fake.dump("transactions") };
}

/** The stored medication row with this id (throws when it is not there). */
export function storedMedication(fake: FakeSupabase, id: number): Row {
  const row = fake.dump("medications").find((r) => r.id === id);
  if (!row) throw new Error(`No stored medication with id ${id}`);
  return row;
}

/** The seeded item whose name starts with `prefix` (throws when there is none). */
export function itemNamed<T extends { name: string | null }>(items: readonly T[], prefix: string): T {
  const found = items.find((item) => item.name !== null && item.name.startsWith(prefix));
  if (!found) throw new Error(`No seeded item whose name starts with "${prefix}"`);
  return found;
}

/** A copy of `row` without the named keys (handy to compare two versions of an item while ignoring `updated_at`). */
export function omitKeys(row: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
}

/** True for a canonical lowercase UUID. */
export function looksLikeUuid(text: unknown): boolean {
  return typeof text === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text);
}

// Extra helpers for API-route tests (complements tests/helpers/fixtures.ts, which is not modified).
// Synthetic data only.
//
//   const fake = installFake(LIVE_AFTER_MIGRATION);
//   const { categories, medications } = seedStandard(fake);          // 6 categories, 27 items, right id shape
//   const res = await PUT(jsonRequest("PUT", "/api/medications/100", { barcode: "x" }), routeParams({ id: "100" }));
//   expect(res.status).toBe(200);
import { NextRequest } from "next/server";
import type { Category, Medication } from "@/lib/db";
import type { FakeSupabase, FakeSupabaseOptions, SeedTransaction } from "./fake-supabase";
import { createFakeSupabase } from "./fake-supabase";
import { buildCategories, buildMedications } from "./fixtures";

/** Builds a NextRequest. `url` may be a path ("/api/categories") or a full URL; a body is sent as JSON. */
export function jsonRequest(method: string, url: string, body?: unknown): NextRequest {
  const absolute = url.startsWith("/") ? `http://localhost${url}` : url;
  return new NextRequest(absolute, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Second argument of a dynamic route handler in Next 16: `{ params: Promise<{ id: string }> }`. */
export function routeParams<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

/** Parses a route response body as JSON (typed `unknown` on purpose: narrow it in the test). */
export async function readJson(res: Response): Promise<unknown> {
  return (await res.json()) as unknown;
}

export interface SeedStandardOptions {
  /** assign the seed categories to items (default true) */
  withCategories?: boolean;
  /** include seed supplier order numbers (default true; forced off when the fake has no supplier column) */
  withSupplierNumbers?: boolean;
  /** also seed a few receive/dispense transactions (default false) */
  withTransactions?: boolean;
}

/**
 * Seeds the standard synthetic fixtures into `fake`, using the id shape (uuid | bigint) the fake was created with.
 * Returns what was seeded in the app's normalized form (ids are strings) for assertions.
 */
export function seedStandard(
  fake: FakeSupabase,
  opts: SeedStandardOptions = {}
): { categories: Category[]; medications: Medication[] } {
  const shape = fake.options.categoryIdType;
  const categories = buildCategories(shape);
  const medications = buildMedications({
    shape,
    withCategories: opts.withCategories ?? true,
    withSupplierNumbers: fake.options.hasSupplierColumn ? (opts.withSupplierNumbers ?? true) : false,
  });
  fake.seedCategories(categories);
  fake.seedMedications(medications);
  if (opts.withTransactions) fake.seedTransactions(buildTransactionSeeds(medications));
  return { categories, medications };
}

/** createFakeSupabase + seedStandard in one call. */
export function standardFake(
  options?: FakeSupabaseOptions,
  seedOptions?: SeedStandardOptions
): { fake: FakeSupabase; categories: Category[]; medications: Medication[] } {
  const fake = createFakeSupabase(options);
  return { fake, ...seedStandard(fake, seedOptions) };
}

/**
 * A few transactions for the first six items: a dispense one day before `now` and a receive five days before.
 * (Seeded rows are inserted as-is; item stock is NOT recomputed from them.)
 */
export function buildTransactionSeeds(medications: readonly Medication[], now: Date = new Date()): SeedTransaction[] {
  const day = 24 * 60 * 60 * 1000;
  const out: SeedTransaction[] = [];
  medications.slice(0, 6).forEach((m, i) => {
    out.push({
      medication_id: m.id,
      type: "dispense",
      quantity: 2 + i,
      note: "synthetic dispense",
      created_at: new Date(now.getTime() - day).toISOString(),
    });
    out.push({
      medication_id: m.id,
      type: "receive",
      quantity: 10 + i,
      note: null,
      created_at: new Date(now.getTime() - 5 * day).toISOString(),
    });
  });
  return out;
}

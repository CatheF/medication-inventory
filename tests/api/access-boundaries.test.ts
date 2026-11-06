// DOCUMENTATION of the access boundary as it is TODAY (TASK.md section 8: "Apply the same access rules to the new category,
// ordering-code, and report operations", "authentication, permissions, and any tenant boundaries").
//
// READ THIS BEFORE RELYING ON IT: these tests describe existing behavior; they are NOT a security guarantee. The app has
// NO authentication: every /api route runs with the Supabase anon key and no login, no session, no tenant. Anyone who can
// reach the site can call every route below. The tests exist so that any future change to that picture (a new route, a new
// HTTP method, an added login) is a deliberate decision that makes a test fail and gets reviewed, instead of a surprise.
//
// What the database enforces is modelled by tests/helpers/fake-supabase.ts from supabase/rls.sql: anon has full CRUD on
// medications, SELECT on transactions (writes only through the SECURITY DEFINER function), and, once the migration is
// applied, SELECT + INSERT on categories (no rename, no delete).
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Medication } from "@/lib/db";
import { asRecordList, bodyList, bodyRecord, errorTextOf, itemNamed, snapshotDb, storedMedication } from "../helpers/api-test-kit";
import { installFake, LIVE_AFTER_MIGRATION, LIVE_BEFORE_MIGRATION, REPO_SCHEMA_SHAPE, type FakeSupabase } from "../helpers/fake-supabase";
import { jsonRequest, seedStandard } from "../helpers/fixtures-extra";
import { api } from "../helpers/route-client";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

import * as analyticsRoute from "@/app/api/analytics/route";
import * as categoriesRoute from "@/app/api/categories/route";
import * as importRoute from "@/app/api/import/route";
import * as medicationsRoute from "@/app/api/medications/route";
import * as medicationRoute from "@/app/api/medications/[id]/route";
import * as barcodeRoute from "@/app/api/medications/barcode/[code]/route";
import * as exportRoute from "@/app/api/order-sheet/xlsx/route";
import * as transactionsRoute from "@/app/api/transactions/route";
import * as uploadRoute from "@/app/api/upload/route";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** Route directories (relative to app/api) that contain a route.ts, e.g. "medications/[id]". */
function routeDirectories(dir: string, base = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...routeDirectories(full, base === "" ? entry : `${base}/${entry}`));
    else if (/^route\.(ts|tsx|js|jsx|mjs)$/.test(entry)) found.push(base);
  }
  return found.sort();
}

function methodsOf(mod: Record<string, unknown>): string[] {
  return Object.keys(mod)
    .filter((key) => (HTTP_METHODS as readonly string[]).includes(key) && typeof mod[key] === "function")
    .sort();
}

describe("the HTTP surface (documentation: every route and the methods it answers)", () => {
  const SURFACE: ReadonlyArray<readonly [string, Record<string, unknown>, readonly string[]]> = [
    ["analytics", analyticsRoute, ["GET"]],
    ["categories", categoriesRoute, ["GET", "POST"]],
    ["import", importRoute, ["POST"]],
    ["medications", medicationsRoute, ["GET", "POST"]],
    ["medications/[id]", medicationRoute, ["DELETE", "GET", "PUT"]],
    ["medications/barcode/[code]", barcodeRoute, ["GET"]],
    ["order-sheet/xlsx", exportRoute, ["POST"]],
    ["transactions", transactionsRoute, ["GET", "POST"]],
    ["upload", uploadRoute, ["POST"]],
  ];

  it("consists of exactly these nine route files: a new route must be added here on purpose", () => {
    expect(routeDirectories(path.join(REPO_ROOT, "app", "api"))).toEqual(SURFACE.map(([name]) => name).sort());
  });

  it.each(SURFACE.map(([name, mod, methods]) => ({ name, mod, methods })))("api/$name answers exactly these methods: $methods", ({ mod, methods }) => {
    expect(methodsOf(mod)).toEqual([...methods]);
  });

  it("offers no way to rename or delete a category, and no way to edit or delete a stock transaction (usage history is append-only through the API)", () => {
    expect(methodsOf(categoriesRoute)).toEqual(["GET", "POST"]);
    expect(methodsOf(transactionsRoute)).toEqual(["GET", "POST"]);
  });

  it("makes the order sheet route a POST that only reads (it has no other method; a GET cannot trigger it)", () => {
    expect(methodsOf(exportRoute)).toEqual(["POST"]);
  });
});

describe("there is no authentication layer (documentation)", () => {
  it("has no middleware or proxy file, no login route and no auth helper in the repository", () => {
    for (const candidate of ["middleware.ts", "middleware.js", "proxy.ts", "proxy.js", "src/middleware.ts", "src/proxy.ts"]) {
      expect(existsSync(path.join(REPO_ROOT, candidate)), candidate).toBe(false);
    }
    const routes = routeDirectories(path.join(REPO_ROOT, "app", "api"));
    expect(routes.filter((r) => /auth|login|session|token/i.test(r))).toEqual([]);
    expect(readdirSync(path.join(REPO_ROOT, "lib")).filter((f) => /auth|session|login/i.test(f))).toEqual([]);
  });

  it("describes one shared inventory: item rows carry no tenant, owner, clinic or user column", async () => {
    const fake = installFake(REPO_SCHEMA_SHAPE);
    seedStandard(fake);
    const items = await bodyList(await api.listItems());
    for (const key of Object.keys(items[0])) expect(key).not.toMatch(/tenant|owner|org|clinic|site|user|account|team/i);
    for (const row of fake.dump("medications")) for (const key of Object.keys(row)) expect(key).not.toMatch(/tenant|owner|org|clinic|site|user|account|team/i);
  });
});

describe("anonymous callers can use every route (documentation: this is how the app works today, not a guarantee)", () => {
  let fake: FakeSupabase;
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake(LIVE_AFTER_MIGRATION);
    ({ medications } = seedStandard(fake));
  });

  const csvRequest = (headers?: Record<string, string>): NextRequest =>
    new NextRequest("http://localhost/api/import", { method: "POST", body: "name,barcode\nImported,IMP-ANON\n", headers });
  const photoRequest = (headers?: Record<string, string>): NextRequest => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1])], "p.png", { type: "image/png" }));
    return new NextRequest("http://localhost/api/upload", { method: "POST", body: form, headers });
  };

  const WRITES: ReadonlyArray<{ label: string; status: number; call: () => Promise<Response> }> = [
    { label: "create an item", status: 201, call: () => api.createItem({ barcode: "ANON-1", name: "Created anonymously" }) },
    { label: "edit an item (including its category and supplier order number)", status: 200, call: () => api.updateItem(100, { stock: 3, supplier_order_number: "ANON-0001" }) },
    { label: "delete an item", status: 200, call: () => api.deleteItem(101) },
    { label: "create a category", status: 201, call: () => api.createCategory("Created anonymously") },
    { label: "record a stock adjustment", status: 201, call: () => transactionsRoute.POST(jsonRequest("POST", "/api/transactions", { medication_id: 102, type: "receive", quantity: 5 })) },
    { label: "import a CSV (create and update items)", status: 200, call: () => importRoute.POST(csvRequest()) },
    { label: "upload a photo", status: 200, call: () => uploadRoute.POST(photoRequest()) },
  ];

  it.each(WRITES)("lets an anonymous caller $label", async ({ status, call }) => {
    const res = await call();
    expect(res.status).toBe(status);
  });

  it("lets an anonymous caller read items, categories, history, analytics and prepare the order sheet", async () => {
    expect((await api.listItems()).status).toBe(200);
    expect((await api.listCategories()).status).toBe(200);
    expect((await transactionsRoute.GET(jsonRequest("GET", "/api/transactions"))).status).toBe(200);
    expect((await analyticsRoute.GET(jsonRequest("GET", "/api/analytics"))).status).toBe(200);
    expect((await api.exportXlsx({ date: "2026-11-05", rows: [{ id: 100 }] })).status).toBe(200);
  });

  it("ignores credentials and origin: a request with a forged Authorization header, a forged cookie and a foreign Origin is handled exactly like an anonymous one", async () => {
    const forged = { Authorization: "Bearer forged-token", Cookie: "sb-access-token=forged; session=admin", Origin: "https://evil.example" };
    const anonymousCreate = await api.createItem({ barcode: "CRED-1", name: "x" });
    const forgedCreate = await medicationsRoute.POST(
      new NextRequest("http://localhost/api/medications", { method: "POST", body: JSON.stringify({ barcode: "CRED-2", name: "x" }), headers: { ...forged, "content-type": "application/json" } })
    );
    expect(forgedCreate.status).toBe(anonymousCreate.status);
    expect((await importRoute.POST(csvRequest(forged))).status).toBe(200);
    expect((await uploadRoute.POST(photoRequest(forged))).status).toBe(200);
    const forgedExport = await exportRoute.POST(
      new NextRequest("http://localhost/api/order-sheet/xlsx", {
        method: "POST",
        body: JSON.stringify({ date: "2026-11-05", rows: [{ id: 100 }] }),
        headers: { ...forged, "content-type": "application/json" },
      })
    );
    expect(forgedExport.status).toBe(200);
  });

  it("lets stock change three ways without logging in: a recorded adjustment, a direct item edit and a CSV import (the last two leave no history row)", async () => {
    const target = itemNamed(medications, "Naproxen 220 mg");
    expect(fake.dump("transactions")).toHaveLength(0);
    expect((await transactionsRoute.POST(jsonRequest("POST", "/api/transactions", { medication_id: target.id, type: "receive", quantity: 1 }))).status).toBe(201);
    expect(fake.dump("transactions")).toHaveLength(1);
    expect((await api.updateItem(target.id, { stock: 500 })).status).toBe(200);
    expect(fake.dump("transactions")).toHaveLength(1); // a direct edit writes no history
    const csv = new NextRequest("http://localhost/api/import", { method: "POST", body: `name,barcode,stock\nNaproxen,${target.barcode},42\n` });
    expect((await importRoute.POST(csv)).status).toBe(200);
    expect(fake.dump("transactions")).toHaveLength(1); // nor does an import
    expect(storedMedication(fake, target.id).stock).toBe(42);
  });
});

describe("the new operations follow the same database rules as the old ones (documentation)", () => {
  let fake: FakeSupabase;
  let ids: { naproxen: number; aspirin: number };
  let naproxenBarcode: string;
  beforeEach(() => {
    fake = installFake(LIVE_AFTER_MIGRATION);
    const { medications } = seedStandard(fake);
    const naproxen = itemNamed(medications, "Naproxen 220 mg");
    ids = { naproxen: naproxen.id, aspirin: itemNamed(medications, "Aspirin 81 mg").id };
    naproxenBarcode = naproxen.barcode;
  });

  it("treats saving a supplier order number like any other item edit: with the update permission revoked it fails (nothing stored), exactly as editing stock does", async () => {
    fake.setRls("medications", { select: true, insert: true, update: false, delete: true });
    const before = snapshotDb(fake);
    const supplierSave = await api.updateItem(ids.aspirin, { supplier_order_number: "ZZ-1" });
    const stockSave = await api.updateItem(ids.aspirin, { stock: 1 });
    expect(supplierSave.ok).toBe(false);
    expect(stockSave.ok).toBe(false);
    expect(supplierSave.status).toBe(stockSave.status);
    expect(snapshotDb(fake)).toEqual(before);
  });

  it("treats assigning a category as an item edit only: it needs no write access to categories and works while categories are entirely hidden", async () => {
    const category = fake.dump("categories")[0];
    fake.setRls("categories", false);
    const res = await api.updateItem(ids.aspirin, { category_id: String(category.id) });
    expect(res.status).toBe(200);
    expect(String(storedMedication(fake, ids.aspirin).category_id)).toBe(String(category.id));
  });

  it("lets a read-only database role prepare an order sheet: the export needs SELECT on medications and nothing else", async () => {
    fake.setRls("medications", { select: true, insert: false, update: false, delete: false });
    fake.setRls("categories", false);
    fake.setRls("transactions", false);
    const res = await api.exportXlsx({ date: "2026-11-05", rows: [{ id: ids.naproxen, qty: "10", unit: "box" }] });
    expect(res.status).toBe(200);
    expect(fake.writes()).toEqual([]);
  });

  it("makes every write route fail (never succeed) for that same read-only role, so only the reading routes work", async () => {
    fake.setRls("medications", { select: true, insert: false, update: false, delete: false });
    const before = snapshotDb(fake);
    expect((await api.createItem({ barcode: "RO-1", name: "x" })).status).toBe(403);
    expect((await api.updateItem(ids.naproxen, { stock: 1 })).ok).toBe(false);
    expect((await api.deleteItem(ids.naproxen)).ok).toBe(false);
    expect((await api.listItems()).status).toBe(200);
    expect((await api.lookup(naproxenBarcode)).status).toBe(200);
    expect(snapshotDb(fake)).toEqual(before);
  });

  it("limits the live database after the migration to reading and creating categories: a created category is readable, and the API has no call that could rename or delete it", async () => {
    const created = await bodyRecord(await api.createCategory("Splints"));
    expect((await bodyList(await api.listCategories())).some((c) => c.id === created.id)).toBe(true);
    expect(fake.options.rls.categories).toEqual({ select: true, insert: true, update: false, delete: false });
  });
});

describe("limitations that follow from how row-level security answers (documentation)", () => {
  it("makes rows hidden by a missing SELECT policy on medications look like an empty inventory: the list is an empty 200, an item lookup is 404, and creating an item fails with 403", async () => {
    // Postgres answers a SELECT that row-level security blocks with ZERO ROWS and no error. This layer cannot tell
    // "hidden" from "empty", which is why the dashboard must treat an empty list from a live database with suspicion
    // (see the missing-inventory investigation). If this test starts failing, the API gained a way to tell the two apart.
    const fake = installFake(LIVE_AFTER_MIGRATION);
    const { medications } = seedStandard(fake);
    fake.setRls("medications", { select: false, insert: true, update: true, delete: true });
    const listed = await api.listItems();
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([]);
    expect((await api.getItem(medications[0].id)).status).toBe(404);
    expect((await api.lookup(medications[0].barcode)).status).toBe(404);
    const create = await api.createItem({ barcode: "HIDDEN-1", name: "x" });
    expect(create.status).toBe(403); // INSERT ... RETURNING needs SELECT too: the scanner cannot silently duplicate hidden items
    expect(fake.dump("medications")).toHaveLength(medications.length);
  });

  it("answers the same categories-list question the same way on the live database before the migration: an empty 200 while the rows exist", async () => {
    const fake = installFake(LIVE_BEFORE_MIGRATION);
    seedStandard(fake);
    const res = await api.listCategories();
    expect(res.status).toBe(200);
    expect(asRecordList(await res.json())).toEqual([]);
    expect(fake.dump("categories").length).toBeGreaterThan(0);
  });

  it("reports a missing privilege (as opposed to a missing policy) as an error with a message, on reads too", async () => {
    const fake = installFake(LIVE_AFTER_MIGRATION);
    seedStandard(fake);
    fake.failNext({ code: "42501", message: "permission denied for table medications" }, { table: "medications" });
    const res = await api.listItems();
    expect(res.status).toBe(403);
    expect(errorTextOf(await res.json())).toMatch(/does not have permission to read/i);
    expect(Array.isArray(await (await api.listItems()).json())).toBe(true); // the next, healthy request lists items again
  });
});

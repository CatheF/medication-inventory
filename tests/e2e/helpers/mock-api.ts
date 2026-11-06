// Playwright helper: fulfills the app's /api/* calls in the browser with synthetic data, re-implementing the
// API contract of the real routes (partial PUT, id-type-agnostic category ids, honest errors, ...).
// It lets the real Next.js pages run end-to-end without a database. The real routes are covered separately by
// the vitest route tests; keep this file in step with them.
import type { Page, Route } from "@playwright/test";
import { rejectUnsafeRequest } from "@/app/api/_guard";
import type { Category, Medication } from "@/lib/db";
import { parseCategoryId, sameId } from "@/lib/ids";
import { parseSupplierOrderNumber } from "@/lib/supplier-order-number";
import { buildSheet } from "@/lib/order-sheet/build";
import type { SheetRowInput } from "@/lib/order-sheet/types";
import { buildOrderSheetXlsx } from "@/lib/order-sheet/xlsx";
import { buildCategories, buildMedications, fakeUuid, type IdShape } from "../../helpers/fixtures";

export type RecordedRequest = { method: string; path: string; search: string; body: unknown };

export type MockApiOptions = {
  /** uuid (live schema, default) or bigint (supabase/schema.sql) ids */
  shape?: IdShape;
  medications?: Medication[];
  categories?: Category[];
  /** Reproduces the live defect: GET /api/categories -> [] and POST /api/categories -> 403 (real route's message). */
  categoriesBlocked?: boolean;
  /** Pre-migration database: writes that mention supplier_order_number -> 409 (real route behavior). */
  supplierColumnMissing?: boolean;
  /** Artificial latency per request in ms (to see loading states). */
  latencyMs?: number;
};

export type FailureSpec = {
  method?: string;
  path: RegExp;
  status?: number;
  body?: unknown;
  /** how many matching requests fail (default 1) */
  times?: number;
  /** abort the request like a network failure instead of answering */
  networkError?: boolean;
};

export type MockApi = {
  /** live references: mutated as the app saves, so tests can assert on what would be in the database */
  medications: Medication[];
  categories: Category[];
  requests: RecordedRequest[];
  failNext(spec: FailureSpec): void;
  setCategoriesBlocked(blocked: boolean): void;
  setSupplierColumnMissing(missing: boolean): void;
  requestsTo(method: string, path: RegExp): RecordedRequest[];
};

// What the real routes answer (lib/api-errors.ts): plain words in `error` for staff, the technical cause in `technical`.
// tests/api/e2e-mock-contract.test.ts compares every one of these with the real mapping, so they cannot drift.
const CATEGORIES_BLOCKED_MESSAGE =
  "Categories cannot be saved yet. This needs a one-time database update by whoever looks after this app. " +
  "You can still save the item without a category.";
const CATEGORIES_BLOCKED_TECHNICAL =
  "Row-level security refused the insert into the categories table (code 42501). " +
  "The categories access migration has not been applied to this database: see supabase/migrations/.";
/** An edit the database refuses as a whole: nothing on the item changes. */
const SUPPLIER_MISSING_MESSAGE =
  "Supplier order numbers cannot be saved yet. This needs a one-time database update by whoever looks after this app. " +
  "Nothing was changed on this item.";
/** A create the database refuses: no item is made. */
const SUPPLIER_MISSING_ON_CREATE_MESSAGE =
  "Supplier order numbers cannot be saved yet. This needs a one-time database update by whoever looks after this app. " +
  "The item was not created.";
const SUPPLIER_MISSING_TECHNICAL =
  "The medications table has no supplier_order_number column (code PGRST204). Apply the latest migration in supabase/migrations/.";
// The database's own words, which the real routes put in `detail` beside the plain `error` (lib/api-errors.ts). The Admin page
// prints them in its small "Technical details" line, so the mock must send them too, or a test could say "no database words on
// screen" while the real server shows some.
const CATEGORIES_BLOCKED_DETAIL = 'new row violates row-level security policy for table "categories"';
const SUPPLIER_MISSING_DETAIL = "Could not find the 'supplier_order_number' column of 'medications' in the schema cache";
const NO_CATEGORY_MESSAGE = "That category no longer exists, so nothing was saved. Reload the page and choose another category.";
const ITEM_NOT_FOUND_MESSAGE = "Item not found. It may have been deleted by someone else. Reload the list to see what is there.";
const DUPLICATE_BARCODE_MESSAGE = "Barcode already exists: another item uses it, so nothing was saved. Search for that item, or use a different barcode.";

/** Whole answer bodies, exactly as the real routes send them; tests/api/e2e-mock-contract.test.ts compares each with the real mapping. */
export const MOCK_ERROR_BODIES = {
  categoriesBlocked: { error: CATEGORIES_BLOCKED_MESSAGE, code: "42501", detail: CATEGORIES_BLOCKED_DETAIL, technical: CATEGORIES_BLOCKED_TECHNICAL },
  supplierMissingOnUpdate: {
    error: SUPPLIER_MISSING_MESSAGE,
    code: "PGRST204",
    detail: SUPPLIER_MISSING_DETAIL,
    technical: SUPPLIER_MISSING_TECHNICAL,
    field: "supplier_order_number",
  },
  supplierMissingOnCreate: {
    error: SUPPLIER_MISSING_ON_CREATE_MESSAGE,
    code: "PGRST204",
    detail: SUPPLIER_MISSING_DETAIL,
    technical: SUPPLIER_MISSING_TECHNICAL,
    field: "supplier_order_number",
  },
} as const;

/** The mock's fixed answers, exported so a unit test can hold them against the real routes' wording. */
export const MOCK_ERROR_TEXT = {
  categoriesBlocked: CATEGORIES_BLOCKED_MESSAGE,
  categoriesBlockedTechnical: CATEGORIES_BLOCKED_TECHNICAL,
  supplierMissingOnUpdate: SUPPLIER_MISSING_MESSAGE,
  supplierMissingOnCreate: SUPPLIER_MISSING_ON_CREATE_MESSAGE,
  supplierMissingTechnical: SUPPLIER_MISSING_TECHNICAL,
  noCategory: NO_CATEGORY_MESSAGE,
  itemNotFound: ITEM_NOT_FOUND_MESSAGE,
  duplicateBarcode: DUPLICATE_BARCODE_MESSAGE,
} as const;

type PwRequest = ReturnType<Route["request"]>;

/**
 * The real routes refuse a POST that is not declared as JSON (415) or that the browser marks as cross-site (403) before they
 * read it. This runs the real check (app/api/_guard.ts) on the request the page made, so a caller that forgot its
 * Content-Type fails these browser tests the way it would fail against the real server.
 */
async function refusedByGuard(request: PwRequest): Promise<{ status: number; body: unknown } | null> {
  const probe = new Request(request.url(), { method: request.method(), headers: request.headers() });
  const refused = rejectUnsafeRequest(probe);
  return refused ? { status: refused.status, body: (await refused.json()) as unknown } : null;
}

const UPDATABLE = [
  "name",
  "barcode",
  "photo_url",
  "stock",
  "threshold",
  "vendor_url",
  "unit",
  "notes",
  "category_id",
  "supplier_order_number",
] as const;

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function json(route: Route, status: number, data: unknown) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(data),
  });
}

function nonNegativeInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

export async function installMockApi(page: Page, options: MockApiOptions = {}): Promise<MockApi> {
  const shape: IdShape = options.shape ?? "uuid";
  const medications = (options.medications ?? buildMedications({ shape })).map((m) => ({ ...m }));
  const categories = (options.categories ?? buildCategories(shape)).map((c) => ({ ...c }));
  const flags = {
    categoriesBlocked: options.categoriesBlocked ?? false,
    supplierColumnMissing: options.supplierColumnMissing ?? false,
  };
  const failures: Array<FailureSpec & { left: number }> = [];
  const requests: RecordedRequest[] = [];
  let nextMedicationId = 100_000;
  let nextCategoryNumber = 1_000;

  const categoryExists = (id: string) => categories.some((c) => sameId(c.id, id));

  function takeFailure(method: string, path: string): FailureSpec | null {
    const f = failures.find((x) => x.left > 0 && (!x.method || x.method === method) && x.path.test(path));
    if (!f) return null;
    f.left -= 1;
    return f;
  }

  /** Applies validated fields from `body` to `target`; returns an error response description or null. */
  function applyFields(target: Medication, body: Dict, isCreate: boolean): { status: number; body: Dict } | null {
    for (const key of UPDATABLE) {
      if (!(key in body)) continue;
      const v = body[key];
      switch (key) {
        case "name":
          target.name = typeof v === "string" && v.trim() ? v.trim() : null;
          break;
        case "barcode": {
          if (typeof v !== "string" || !v.trim()) return { status: 400, body: { error: "Barcode is required", field: "barcode" } };
          const barcode = v.trim();
          if (medications.some((m) => m.id !== target.id && m.barcode === barcode)) {
            return { status: 409, body: { error: DUPLICATE_BARCODE_MESSAGE } };
          }
          target.barcode = barcode;
          break;
        }
        case "stock":
        case "threshold": {
          const n = nonNegativeInt(v);
          if (n === null) return { status: 400, body: { error: `${key} must be a whole number of 0 or more.`, field: key } };
          target[key] = n;
          break;
        }
        case "category_id": {
          const parsed = parseCategoryId(v);
          if (!parsed.ok) return { status: 400, body: { error: parsed.reason, field: "category_id" } };
          if (parsed.value !== null && !categoryExists(parsed.value)) {
            return { status: 400, body: { error: NO_CATEGORY_MESSAGE, field: "category_id" } };
          }
          target.category_id = parsed.value;
          break;
        }
        case "supplier_order_number": {
          const parsed = parseSupplierOrderNumber(v);
          if (!parsed.ok) return { status: 400, body: { error: parsed.reason, field: key } };
          // The real route only writes the column when it was provided; pre-migration that fails with 409.
          if (flags.supplierColumnMissing && (parsed.value !== null || !isCreate)) {
            return {
              status: 409,
              body: { ...(isCreate ? MOCK_ERROR_BODIES.supplierMissingOnCreate : MOCK_ERROR_BODIES.supplierMissingOnUpdate) },
            };
          }
          target.supplier_order_number = parsed.value;
          break;
        }
        case "unit":
          target.unit = typeof v === "string" && v.trim() ? v.trim() : "units";
          break;
        default:
          // photo_url, vendor_url, notes
          target[key] = typeof v === "string" && v ? v : null;
      }
    }
    return null;
  }

  async function handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const path = url.pathname;

    let body: unknown;
    if (method !== "GET" && method !== "HEAD") {
      try {
        body = req.postDataJSON();
      } catch {
        body = req.postData() ?? undefined;
      }
    }
    requests.push({ method, path, search: url.search, body });
    if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));

    const failure = takeFailure(method, path);
    if (failure) {
      if (failure.networkError) return route.abort("failed");
      return json(route, failure.status ?? 500, failure.body ?? { error: "Unexpected database error." });
    }

    // ── categories ────────────────────────────────────────────────────────────────────────────
    if (path === "/api/categories") {
      if (method === "GET") {
        if (flags.categoriesBlocked) return json(route, 200, []); // RLS: empty list, no error (the live defect)
        const sorted = [...categories].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
        return json(route, 200, sorted);
      }
      if (method === "POST") {
        const refused = await refusedByGuard(req);
        if (refused) return json(route, refused.status, refused.body);
        const name = isDict(body) && typeof body.name === "string" ? body.name.trim() : "";
        if (!name || name.length > 60) return json(route, 400, { error: "Category name is required (1–60 characters)." });
        if (flags.categoriesBlocked) {
          return json(route, 403, { ...MOCK_ERROR_BODIES.categoriesBlocked });
        }
        const existing = categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
        if (existing) return json(route, 200, existing);
        nextCategoryNumber += 1;
        const created: Category = {
          id: shape === "uuid" ? fakeUuid(nextCategoryNumber) : String(nextCategoryNumber),
          name,
          created_at: new Date().toISOString(),
        };
        categories.push(created);
        return json(route, 201, created);
      }
    }

    // ── medications ───────────────────────────────────────────────────────────────────────────
    if (path === "/api/medications") {
      if (method === "GET") {
        let rows = medications;
        const category = url.searchParams.get("category");
        if (category === "none") rows = rows.filter((m) => m.category_id === null);
        else if (category) rows = rows.filter((m) => sameId(m.category_id, category));
        if (url.searchParams.get("unnamed") === "true") rows = rows.filter((m) => m.is_unnamed);
        if (url.searchParams.get("lowStock") === "true") rows = rows.filter((m) => m.stock <= m.threshold);
        const sorted = [...rows].sort((a, b) => {
          if (a.name === null && b.name !== null) return 1;
          if (b.name === null && a.name !== null) return -1;
          return (a.name ?? "").localeCompare(b.name ?? "") || a.barcode.localeCompare(b.barcode) || a.id - b.id;
        });
        return json(route, 200, sorted);
      }
      if (method === "POST") {
        const refused = await refusedByGuard(req);
        if (refused) return json(route, refused.status, refused.body);
        if (!isDict(body)) return json(route, 400, { error: "Invalid request body." });
        const created: Medication = {
          id: ++nextMedicationId,
          name: null,
          barcode: "",
          photo_url: null,
          stock: 0,
          threshold: 10,
          vendor_url: null,
          unit: "units",
          notes: null,
          category_id: null,
          supplier_order_number: null,
          is_unnamed: body.is_unnamed === true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        const keys = { ...body };
        if (!("barcode" in keys)) return json(route, 400, { error: "Barcode is required", field: "barcode" });
        const err = applyFields(created, keys, true);
        if (err) return json(route, err.status, err.body);
        medications.push(created);
        return json(route, 201, created);
      }
    }

    const barcodeMatch = path.match(/^\/api\/medications\/barcode\/(.+)$/);
    if (barcodeMatch && method === "GET") {
      const code = decodeURIComponent(barcodeMatch[1]);
      const found = medications.find((m) => m.barcode === code);
      return found ? json(route, 200, found) : json(route, 404, { error: "Medication not found" });
    }

    const idMatch = path.match(/^\/api\/medications\/(\d+)$/);
    if (idMatch) {
      const id = Number(idMatch[1]);
      const target = medications.find((m) => m.id === id);
      if (method === "GET") return target ? json(route, 200, target) : json(route, 404, { error: "Medication not found" });
      if (method === "PUT") {
        if (!target) return json(route, 404, { error: ITEM_NOT_FOUND_MESSAGE });
        if (!isDict(body) || !UPDATABLE.some((k) => k in body)) return json(route, 400, { error: "Nothing to update." });
        const draft = { ...target };
        const err = applyFields(draft, body, false);
        if (err) return json(route, err.status, err.body);
        Object.assign(target, draft, { is_unnamed: false, updated_at: new Date().toISOString() });
        return json(route, 200, target);
      }
      if (method === "DELETE") {
        if (!target) return json(route, 404, { error: ITEM_NOT_FOUND_MESSAGE });
        medications.splice(medications.indexOf(target), 1);
        return json(route, 200, { success: true });
      }
    }

    // ── stock operations (emulated for the scan-flow regression tests) ────
    if (path === "/api/transactions") {
      if (method === "GET") return json(route, 200, []);
      if (method === "POST" && isDict(body)) {
        const target = medications.find((m) => m.id === Number(body.medication_id));
        const quantity = Number(body.quantity);
        if (!target) return json(route, 400, { error: "Medication not found" });
        if (body.type === "dispense" && target.stock < quantity) {
          return json(route, 400, { error: `Insufficient stock. Current stock: ${target.stock}` });
        }
        target.stock += body.type === "receive" ? quantity : -quantity;
        return json(route, 201, target);
      }
    }
    if (path === "/api/analytics") return json(route, 200, { medications: [], days: 30, date_range: [] });

    if (path === "/api/upload" && method === "POST") {
      const svg =
        "data:image/svg+xml;utf8," +
        encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#cbd5e1"/></svg>');
      return json(route, 200, { url: svg });
    }

    // ── order-sheet export: the REAL sheet builder and workbook writer run here; only the database read is replaced
    // by the mock's rows. The real route's validation and read-only behavior are covered by tests/api.
    if (path === "/api/order-sheet/xlsx" && method === "POST") {
      const refused = await refusedByGuard(req);
      if (refused) return json(route, refused.status, refused.body);
      if (!isDict(body) || !Array.isArray(body.rows) || body.rows.length === 0) {
        return json(route, 400, { error: "Add at least one item to the order sheet before exporting.", field: "rows" });
      }
      const inputs: SheetRowInput[] = [];
      for (const [index, r] of body.rows.entries()) {
        if (!isDict(r) || typeof r.id !== "number" || !Number.isInteger(r.id) || r.id <= 0) {
          return json(route, 400, { error: "Each row needs a valid item id.", field: `rows[${index}].id` });
        }
        inputs.push({ id: r.id, qty: typeof r.qty === "string" ? r.qty : "", unit: typeof r.unit === "string" ? r.unit : "" });
      }
      const date = typeof body.date === "string" ? body.date : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(route, 400, { error: "The date must look like 2026-11-05.", field: "date" });
      const missingIds = inputs.map((r) => r.id).filter((id) => !medications.some((m) => m.id === id));
      if (missingIds.length > 0) {
        return json(route, 422, {
          error: `${missingIds.length} item(s) on the order sheet are no longer in the inventory.`,
          missingIds,
        });
      }
      const sheet = buildSheet(medications, inputs, {
        title: typeof body.title === "string" ? body.title : "",
        date,
        preparedBy: typeof body.preparedBy === "string" ? body.preparedBy : "",
        notes: typeof body.notes === "string" ? body.notes : "",
        showOnHand: body.showOnHand === true,
        showBarcode: body.showBarcode === true,
      });
      const bytes = await buildOrderSheetXlsx(sheet);
      return route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": `attachment; filename="order-sheet-${date}.xlsx"`,
          "cache-control": "no-store",
        },
        body: Buffer.from(bytes),
      });
    }

    // Anything else is not mocked here.
    return route.fallback();
  }

  await page.route("**/api/**", handle);

  return {
    medications,
    categories,
    requests,
    failNext(spec) {
      failures.push({ ...spec, left: spec.times ?? 1 });
    },
    setCategoriesBlocked(blocked) {
      flags.categoriesBlocked = blocked;
    },
    setSupplierColumnMissing(missing) {
      flags.supplierColumnMissing = missing;
    },
    requestsTo(method, pathPattern) {
      return requests.filter((r) => r.method === method && pathPattern.test(r.path));
    },
  };
}

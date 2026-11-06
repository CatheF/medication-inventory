// Helpers shared by the medication routes (list/create, get/update/delete, barcode lookup).
// This is a plain module, not a route: App Router only serves `route.ts`, and a route file may not export extra names,
// so the request validation that POST and PUT must share lives here.
//
// PUT is a PARTIAL update: only keys that are present in the body are validated and written, an explicit null clears a
// nullable column, and an absent key is never touched. (A PUT that wrote every column on every save would turn an edit
// that never mentioned the category into `category_id: null` and wipe it.)
import { NextResponse } from "next/server";
import { mapSupabaseError, type ErrorContext } from "@/lib/api-errors";
import { parseCategoryId } from "@/lib/ids";
import {
  BARCODE_MAX_LENGTH,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  PHOTO_URL_MAX_LENGTH,
  UNIT_MAX_LENGTH,
  VENDOR_URL_MAX_LENGTH,
  exceedsLength,
} from "@/lib/limits";
import { isHttpUrlText, isVendorLinkText } from "@/lib/safe-url";
import { parseSupplierOrderNumber } from "@/lib/supplier-order-number";
import { readJsonBody } from "../_guard";

/** Largest value a Postgres INTEGER column (stock, threshold) can hold. */
const INT4_MAX = 2_147_483_647;
/** Postgres text cannot store NUL; PostgREST would answer with an opaque error, so reject it up front. */
const NUL = String.fromCharCode(0);

// ── HTTP helpers ────────────────────────────────────────────────────────────────────────────────

/** JSON response that must never be served from a cache (stale inventory looks like data loss). */
export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Maps a Supabase/PostgREST error (or a thrown exception) to the shared error response. The plain message goes to the
 * browser; the log line also carries the technical facts (code, the database's own message, what to fix) for whoever looks
 * after the app.
 */
export function errorResponse(err: unknown, ctx: ErrorContext, label: string): NextResponse {
  const { status, body } = mapSupabaseError(err, ctx);
  if (status >= 500 || status === 403) {
    console.error(
      `[${label}] ${status}${body.code ? ` ${body.code}` : ""}${body.detail ? ` ${body.detail}` : ""}${body.technical ? ` | ${body.technical}` : ""}`
    );
  }
  return json(body, status);
}

export function invalidIdResponse(): NextResponse {
  return json({ error: "Invalid medication id.", field: "id" }, 400);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const REQUEST_TOO_LARGE = "The request is too large.";

/**
 * Reads the JSON object a POST or PUT sends. `status` is 413 for a body over the size limit (refused before it is read when
 * the declared Content-Length already says so) and 400 for anything that is not a JSON object.
 */
export async function readJsonObject(
  request: Request
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: 400 | 413; error: string }> {
  const read = await readJsonBody(request);
  if (!read.ok) {
    return read.reason === "too-large"
      ? { ok: false, status: 413, error: REQUEST_TOO_LARGE }
      : { ok: false, status: 400, error: "Request body must be valid JSON." };
  }
  if (!isRecord(read.value)) return { ok: false, status: 400, error: "Request body must be a JSON object." };
  return { ok: true, body: read.value };
}

// ── Field validation ────────────────────────────────────────────────────────────────────────────

export type FieldError = { error: string; field: string };
type Failure = { ok: false } & FieldError;
type Parsed<T> = { ok: true; value: T } | Failure;

/** Columns a client may write. Everything else in a body (id, created_at, updated_at, is_unnamed on PUT…) is ignored. */
export type MedicationPatch = {
  name?: string | null;
  barcode?: string;
  photo_url?: string | null;
  stock?: number;
  threshold?: number;
  vendor_url?: string | null;
  unit?: string;
  notes?: string | null;
  category_id?: string | null;
  supplier_order_number?: string | null;
};

export type MedicationInsert = {
  name: string | null;
  barcode: string;
  photo_url: string | null;
  stock: number;
  threshold: number;
  vendor_url: string | null;
  unit: string;
  notes: string | null;
  category_id: string | null;
  is_unnamed: boolean;
  /** Only present when the client supplied one, so creating items keeps working before the column exists. */
  supplier_order_number?: string;
};

function fail(error: string, field: string): Failure {
  return { ok: false, error, field };
}

/** A key counts as "provided" when it is present and not undefined (JSON cannot carry undefined). */
function provided(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
}

/** How a nullable text column is read: what it is called in messages, its size limit and whether it must be a web address. */
type TextRule = {
  /** Start of the message: "Name" reads "Name is too long", "Notes" reads "Notes are too long". */
  label: string;
  verb: "is" | "are";
  field: string;
  max: number;
  /** Trim the ends before storing (false keeps the person's own spacing and line breaks, as notes do). */
  trim: boolean;
  /**
   * "address": must be an absolute http:// or https:// address (the photo address, which the browser requests as it is).
   * "link": the same, or a bare "shop.example.com/reorder" that every screen already shows as an https link (the vendor link).
   */
  url: false | "address" | "link";
};

/**
 * Nullable text column: null or blank clears it; anything that is not a string is rejected rather than coerced, and so is
 * text that is too long (counted in characters, on the value that will be stored) or, for an address, text that is not a
 * real http or https address.
 */
function parseOptionalText(v: unknown, rule: TextRule): Parsed<string | null> {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== "string") return fail(`${rule.label} must be text.`, rule.field);
  if (v.includes(NUL)) return fail(`${rule.label} can’t contain null characters.`, rule.field);
  if (v.trim() === "") return { ok: true, value: null };
  const value = rule.trim ? v.trim() : v;
  if (exceedsLength(value, rule.max)) return fail(tooLong(rule.label, rule.verb, rule.max), rule.field);
  if (rule.url === "address" && !isHttpUrlText(value)) {
    return fail(`${rule.label} must be a web address that starts with http:// or https://.`, rule.field);
  }
  if (rule.url === "link" && !isVendorLinkText(value)) {
    return fail(`${rule.label} must be a web address, for example https://shop.example.com/reorder.`, rule.field);
  }
  return { ok: true, value };
}

function tooLong(label: string, verb: "is" | "are", max: number): string {
  return `${label} ${verb} too long (maximum ${max} characters).`;
}

const NAME_RULE: TextRule = { label: "Name", verb: "is", field: "name", max: NAME_MAX_LENGTH, trim: true, url: false };
const PHOTO_URL_RULE: TextRule = { label: "Photo URL", verb: "is", field: "photo_url", max: PHOTO_URL_MAX_LENGTH, trim: true, url: "address" };
const VENDOR_URL_RULE: TextRule = { label: "Vendor URL", verb: "is", field: "vendor_url", max: VENDOR_URL_MAX_LENGTH, trim: true, url: "link" };
// Notes keep their own line breaks and spacing; only an all-blank value is treated as "no notes".
const NOTES_RULE: TextRule = { label: "Notes", verb: "are", field: "notes", max: NOTES_MAX_LENGTH, trim: false, url: false };

function parseBarcode(v: unknown): Parsed<string> {
  if (v === null || v === undefined) return fail("Barcode is required", "barcode");
  if (typeof v !== "string") return fail("Barcode must be text.", "barcode");
  const s = v.trim();
  if (s === "") return fail("Barcode is required", "barcode");
  if (s.includes(NUL)) return fail("Barcode can’t contain null characters.", "barcode");
  if (exceedsLength(s, BARCODE_MAX_LENGTH)) return fail(tooLong("Barcode", "is", BARCODE_MAX_LENGTH), "barcode");
  return { ok: true, value: s };
}

function parseCount(v: unknown, label: string, field: string): Parsed<number> {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= INT4_MAX) {
    return { ok: true, value: v === 0 ? 0 : v }; // normalizes -0
  }
  return fail(`${label} must be a whole number from 0 to ${INT4_MAX}.`, field);
}

function parseUnit(v: unknown): Parsed<string> {
  if (v === null) return { ok: true, value: "units" };
  if (typeof v !== "string") return fail("Unit must be text.", "unit");
  if (v.includes(NUL)) return fail("Unit can’t contain null characters.", "unit");
  const unit = v.trim();
  if (exceedsLength(unit, UNIT_MAX_LENGTH)) return fail(tooLong("Unit", "is", UNIT_MAX_LENGTH), "unit");
  return { ok: true, value: unit || "units" };
}

/**
 * Validates every writable key that is present in `body`. Absent keys are simply not in the result, so callers can
 * write exactly what the client sent. Returns the first problem as `{ ok: false, error, field }`.
 */
export function readMedicationFields(body: Record<string, unknown>): { ok: true; patch: MedicationPatch } | Failure {
  const patch: MedicationPatch = {};

  if (provided(body, "name")) {
    const r = parseOptionalText(body.name, NAME_RULE);
    if (!r.ok) return r;
    patch.name = r.value;
  }
  if (provided(body, "barcode")) {
    const r = parseBarcode(body.barcode);
    if (!r.ok) return r;
    patch.barcode = r.value;
  }
  if (provided(body, "photo_url")) {
    const r = parseOptionalText(body.photo_url, PHOTO_URL_RULE);
    if (!r.ok) return r;
    patch.photo_url = r.value;
  }
  if (provided(body, "stock")) {
    const r = parseCount(body.stock, "Stock", "stock");
    if (!r.ok) return r;
    patch.stock = r.value;
  }
  if (provided(body, "threshold")) {
    const r = parseCount(body.threshold, "Threshold", "threshold");
    if (!r.ok) return r;
    patch.threshold = r.value;
  }
  if (provided(body, "vendor_url")) {
    const r = parseOptionalText(body.vendor_url, VENDOR_URL_RULE);
    if (!r.ok) return r;
    patch.vendor_url = r.value;
  }
  if (provided(body, "unit")) {
    const r = parseUnit(body.unit);
    if (!r.ok) return r;
    patch.unit = r.value;
  }
  if (provided(body, "notes")) {
    const r = parseOptionalText(body.notes, NOTES_RULE);
    if (!r.ok) return r;
    patch.notes = r.value;
  }
  if (provided(body, "category_id")) {
    const r = parseCategoryId(body.category_id);
    if (!r.ok) return fail(r.reason, "category_id");
    patch.category_id = r.value;
  }
  if (provided(body, "supplier_order_number")) {
    const r = parseSupplierOrderNumber(body.supplier_order_number);
    if (!r.ok) return fail(r.reason, "supplier_order_number");
    patch.supplier_order_number = r.value;
  }

  return { ok: true, patch };
}

/** Builds the row for POST /api/medications: validated fields plus the documented defaults. */
export function buildMedicationInsert(body: Record<string, unknown>): { ok: true; row: MedicationInsert } | Failure {
  const fields = readMedicationFields(body);
  if (!fields.ok) return fields;
  const { patch } = fields;

  if (patch.barcode === undefined) return fail("Barcode is required", "barcode");

  let isUnnamed = false;
  if (provided(body, "is_unnamed") && body.is_unnamed !== null) {
    if (typeof body.is_unnamed !== "boolean") return fail("is_unnamed must be true or false.", "is_unnamed");
    isUnnamed = body.is_unnamed;
  }

  const row: MedicationInsert = {
    name: patch.name ?? null,
    barcode: patch.barcode,
    photo_url: patch.photo_url ?? null,
    stock: patch.stock ?? 0,
    threshold: patch.threshold ?? 10,
    vendor_url: patch.vendor_url ?? null,
    unit: patch.unit ?? "units",
    notes: patch.notes ?? null,
    category_id: patch.category_id ?? null,
    is_unnamed: isUnnamed,
  };
  // Never send the column unless there is something to store: a database that has not been migrated yet must still
  // accept new items without a supplier order number.
  if (patch.supplier_order_number) row.supplier_order_number = patch.supplier_order_number;
  return { ok: true, row };
}

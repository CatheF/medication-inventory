import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import type { Medication } from "@/lib/db";
import { mapSupabaseError } from "@/lib/api-errors";
import { parseMedicationId } from "@/lib/ids";
import { normalizeMedication } from "@/lib/normalize";
import { buildSheet, exceedsLength, normalizeQty, normalizeUnit } from "@/lib/order-sheet/build";
import { MAX_SHEET_YEAR, MIN_SHEET_YEAR, isValidISODate } from "@/lib/order-sheet/draft";
import { ORDER_SHEET_LIMITS } from "@/lib/order-sheet/types";
import type { SheetOptions, SheetRowInput } from "@/lib/order-sheet/types";
import { buildOrderSheetXlsx } from "@/lib/order-sheet/xlsx";

// POST /api/order-sheet/xlsx
//
// Turns the order sheet the browser is showing into a real .xlsx file. This route is strictly READ-ONLY: it only
// reads the named medications (select) and never inserts, updates, deletes, upserts or calls an RPC. Generating a
// sheet therefore cannot place an order, send anything to a supplier, or change stock.

export const runtime = "nodejs";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** A legitimate request is a few tens of KB (500 rows). Refuse anything much larger before parsing it. */
const MAX_BODY_CHARS = 262144;
/** Ids per `.in("id", …)` read, to keep the request URL short. */
const READ_CHUNK_SIZE = 200;
/** Said when the date is not a real day, or is outside the years the order sheet accepts (the same range the page saves). */
const DATE_MESSAGE = `Date must be a real calendar date from the year ${MIN_SHEET_YEAR} to ${MAX_SHEET_YEAR}, written YYYY-MM-DD (for example 2026-11-05).`;

type Validated =
  | { ok: true; options: SheetOptions; inputs: SheetRowInput[] }
  | { ok: false; error: string; field?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(error: string, field?: string): { ok: false; error: string; field?: string } {
  return field ? { ok: false, error, field } : { ok: false, error };
}

function jsonError(status: number, error: string, field?: string): NextResponse {
  return NextResponse.json(field ? { error, field } : { error }, { status });
}

/** Optional text field: missing / null → "". A non-string, or a string over the limit, is rejected (never truncated). */
function readText(
  body: Record<string, unknown>,
  key: string,
  label: string,
  max: number
): { ok: true; value: string } | { ok: false; error: string; field: string } {
  const value = body[key];
  if (value === undefined || value === null) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, error: `${label} must be text.`, field: key };
  if (exceedsLength(value, max)) {
    return { ok: false, error: `${label} must be at most ${max} characters.`, field: key };
  }
  return { ok: true, value };
}

/** Optional strict boolean: missing → false. Anything that is not true/false is rejected. */
function readFlag(
  body: Record<string, unknown>,
  key: string,
  label: string
): { ok: true; value: boolean } | { ok: false; error: string; field: string } {
  const value = body[key];
  if (value === undefined) return { ok: true, value: false };
  if (typeof value !== "boolean") return { ok: false, error: `${label} must be true or false.`, field: key };
  return { ok: true, value };
}

function validateRequest(body: unknown): Validated {
  if (!isRecord(body)) return failure("The request must be a JSON object.");

  const title = readText(body, "title", "Title", ORDER_SHEET_LIMITS.title);
  if (!title.ok) return title;
  const preparedBy = readText(body, "preparedBy", "Prepared by", ORDER_SHEET_LIMITS.preparedBy);
  if (!preparedBy.ok) return preparedBy;
  const notes = readText(body, "notes", "Notes", ORDER_SHEET_LIMITS.notes);
  if (!notes.ok) return notes;

  if (typeof body.date !== "string" || !isValidISODate(body.date)) {
    return failure(DATE_MESSAGE, "date");
  }
  const showOnHand = readFlag(body, "showOnHand", "Show on-hand");
  if (!showOnHand.ok) return showOnHand;
  const showBarcode = readFlag(body, "showBarcode", "Show barcode");
  if (!showBarcode.ok) return showBarcode;

  const rows = body.rows;
  if (!Array.isArray(rows)) return failure("rows must be a list of order sheet rows.", "rows");
  if (rows.length === 0) {
    return failure("Add at least one item to the order sheet before exporting.", "rows");
  }
  if (rows.length > ORDER_SHEET_LIMITS.rows) {
    return failure(`An order sheet can have at most ${ORDER_SHEET_LIMITS.rows} items.`, "rows");
  }

  const inputs: SheetRowInput[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < rows.length; index += 1) {
    const entry: unknown = rows[index];
    const label = `Row ${index + 1}`;
    if (!isRecord(entry)) return failure(`${label} is not a valid row.`, `rows[${index}]`);

    const id = parseMedicationId(entry.id);
    if (id === null) return failure(`${label} has an invalid item id.`, `rows[${index}].id`);
    if (seen.has(id)) continue; // a repeated item is listed once: the first occurrence wins
    seen.add(id);

    let qtyText = "";
    if (entry.qty !== undefined && entry.qty !== null) {
      if (typeof entry.qty !== "string") return failure(`${label}: order quantity must be text.`, `rows[${index}].qty`);
      qtyText = entry.qty;
    }
    const qty = normalizeQty(qtyText);
    if (!qty.ok) return failure(`${label}: ${qty.reason}`, `rows[${index}].qty`);

    let unitText = "";
    if (entry.unit !== undefined && entry.unit !== null) {
      if (typeof entry.unit !== "string") return failure(`${label}: order unit must be text.`, `rows[${index}].unit`);
      unitText = entry.unit;
    }
    if (exceedsLength(unitText.trim(), ORDER_SHEET_LIMITS.unit)) {
      return failure(`${label}: order unit must be at most ${ORDER_SHEET_LIMITS.unit} characters.`, `rows[${index}].unit`);
    }

    inputs.push({ id, qty: qty.value, unit: normalizeUnit(unitText) });
  }

  return {
    ok: true,
    options: {
      title: title.value,
      date: body.date,
      preparedBy: preparedBy.value,
      notes: notes.value,
      showOnHand: showOnHand.value,
      showBarcode: showBarcode.value,
    },
    inputs,
  };
}

function dbErrorResponse(error: unknown): NextResponse {
  const mapped = mapSupabaseError(error, "order-sheet.read");
  return NextResponse.json(mapped.body, { status: mapped.status });
}

/**
 * Reads the named medications, up to 200 ids per request. Only `select` is ever used.
 *
 * A database may answer a read with fewer rows than it was asked for: its own per-request row cap (PostgREST
 * `max-rows`) can be lower than the chunk. Trusting the first answer would report items that DO exist as "no longer in
 * the inventory". So after each answer the ids that did not come back are asked for again, and the loop ends when
 * everything has come back or a read makes no progress; only ids still absent then are genuinely missing. Every round
 * that continues strictly shrinks the pending list, so this is bounded by the number of ids (at most 500).
 */
async function readMedications(ids: number[]): Promise<Medication[] | NextResponse> {
  const items: Medication[] = [];
  for (let start = 0; start < ids.length; start += READ_CHUNK_SIZE) {
    let pending = ids.slice(start, start + READ_CHUNK_SIZE);
    while (pending.length > 0) {
      const { data, error } = await supabase.from("medications").select("*").in("id", pending);
      if (error) return dbErrorResponse(error);
      const rows = (data ?? []).map(normalizeMedication);
      if (rows.length === 0) break; // nothing came back: the remaining ids do not exist
      for (const row of rows) items.push(row);
      const found = new Set(rows.map((row) => row.id));
      const stillPending = pending.filter((id) => !found.has(id));
      if (stillPending.length === pending.length) break; // no progress (rows that were not asked for): stop, never loop
      pending = stillPending;
    }
  }
  return items;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return jsonError(413, "The order sheet is too large to export.");
    body = JSON.parse(text);
  } catch {
    return jsonError(400, "The request body must be valid JSON.");
  }

  const parsed = validateRequest(body);
  if (!parsed.ok) return jsonError(400, parsed.error, parsed.field);

  let items: Medication[] | NextResponse;
  try {
    items = await readMedications(parsed.inputs.map((input) => input.id));
  } catch (error) {
    console.error("order-sheet export: reading medications failed", error instanceof Error ? error.message : "");
    return dbErrorResponse(error);
  }
  if (items instanceof NextResponse) return items;

  const sheet = buildSheet(items, parsed.inputs, parsed.options);
  if (sheet.missingIds.length > 0) {
    const count = sheet.missingIds.length;
    return NextResponse.json(
      {
        error:
          count === 1
            ? "1 item on the order sheet is no longer in the inventory. Remove it from the sheet and export again."
            : `${count} items on the order sheet are no longer in the inventory. Remove them from the sheet and export again.`,
        missingIds: sheet.missingIds,
      },
      { status: 422 }
    );
  }

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await buildOrderSheetXlsx(sheet);
  } catch (error) {
    console.error("order-sheet export: building the workbook failed", error instanceof Error ? error.message : "");
    return jsonError(500, "Couldn’t create the Excel file. Try again, or use Print / Save as PDF instead.");
  }

  // The filename comes ONLY from the validated YYYY-MM-DD date, never from anything staff typed.
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": XLSX_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="order-sheet-${parsed.options.date}.xlsx"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

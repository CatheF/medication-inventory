import type { Category, Medication } from "./db";
import { toIdString } from "./ids";

// Rows come back from PostgREST with whatever column types the database has (uuid → string, bigint → number),
// and without `supplier_order_number` until the migration is applied. These helpers give the rest of the app
// one stable shape.

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function normalizeCategory(row: Record<string, unknown>): Category {
  return {
    id: toIdString(row.id) ?? "",
    name: typeof row.name === "string" ? row.name : "",
    created_at: str(row.created_at),
  };
}

export function normalizeMedication(row: Record<string, unknown>): Medication {
  return {
    id: Number(row.id),
    name: str(row.name),
    barcode: typeof row.barcode === "string" ? row.barcode : String(row.barcode ?? ""),
    photo_url: str(row.photo_url),
    stock: Number(row.stock ?? 0),
    threshold: Number(row.threshold ?? 0),
    vendor_url: str(row.vendor_url),
    unit: typeof row.unit === "string" ? row.unit : "units",
    notes: str(row.notes),
    category_id: toIdString(row.category_id),
    supplier_order_number: str(row.supplier_order_number),
    is_unnamed: row.is_unnamed === true,
    created_at: typeof row.created_at === "string" ? row.created_at : "",
    updated_at: typeof row.updated_at === "string" ? row.updated_at : "",
  };
}

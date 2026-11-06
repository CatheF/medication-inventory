import { NextRequest } from "next/server";
import { supabase } from "@/lib/db";
import { parseCategoryId } from "@/lib/ids";
import { normalizeMedication } from "@/lib/normalize";
import { rejectUnsafeRequest } from "../_guard";
import { readAllRows } from "../_paging";
import { buildMedicationInsert, errorResponse, json, readJsonObject } from "./_shared";

// Never serve a cached inventory: a stale response makes saved changes look like data loss.
export const dynamic = "force-dynamic";

type ListFilters = {
  unnamed: boolean;
  /** null = no category filter, "none" = uncategorized only, otherwise an opaque category id string */
  category: "none" | { id: string } | null;
};

function listQuery(filters: ListFilters, withCount: boolean) {
  let query = supabase
    .from("medications")
    .select("*", withCount ? { count: "exact" } : {})
    .order("name", { ascending: true, nullsFirst: false })
    .order("barcode", { ascending: true })
    .order("id", { ascending: true });

  if (filters.unnamed) query = query.eq("is_unnamed", true);
  if (filters.category === "none") query = query.is("category_id", null);
  else if (filters.category) query = query.eq("category_id", filters.category.id);
  return query;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const lowStock = searchParams.get("lowStock") === "true";
    const unnamed = searchParams.get("unnamed") === "true";

    let category: ListFilters["category"] = null;
    const categoryParam = searchParams.get("category");
    if (categoryParam !== null) {
      if (categoryParam.trim().toLowerCase() === "none") {
        category = "none";
      } else {
        const parsed = parseCategoryId(categoryParam);
        if (!parsed.ok) return json({ error: parsed.reason, field: "category" }, 400);
        if (parsed.value !== null) category = { id: parsed.value };
      }
    }

    // Every page, so a database that answers at most N rows per request can never hand back a silently short inventory.
    const result = await readAllRows((from, to, withCount) => listQuery({ unnamed, category }, withCount).range(from, to));
    if (!result.ok) {
      if ("tooLarge" in result) return json({ error: "Inventory is too large to load in one request" }, 500);
      return errorResponse(result.error, "medications.read", "GET /api/medications");
    }

    const items = result.rows.map(normalizeMedication);
    // Column-to-column comparison is not available in PostgREST filters, so low stock is filtered here, after
    // every page has been read.
    return json(lowStock ? items.filter((m) => m.stock <= m.threshold) : items);
  } catch (err) {
    return errorResponse(err, "medications.read", "GET /api/medications");
  }
}

export async function POST(request: NextRequest) {
  try {
    // A web page on another site must not be able to create items with a "simple" POST: see app/api/_guard.ts.
    const refused = rejectUnsafeRequest(request);
    if (refused) return refused;

    const parsedBody = await readJsonObject(request);
    if (!parsedBody.ok) return json({ error: parsedBody.error }, parsedBody.status);

    const built = buildMedicationInsert(parsedBody.body);
    if (!built.ok) return json({ error: built.error, field: built.field }, 400);

    const { data, error } = await supabase.from("medications").insert(built.row).select("*").single();
    if (error) return errorResponse(error, "medications.create", "POST /api/medications");

    return json(normalizeMedication(data), 201);
  } catch (err) {
    return errorResponse(err, "medications.create", "POST /api/medications");
  }
}

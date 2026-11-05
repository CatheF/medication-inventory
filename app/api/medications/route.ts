import { NextRequest } from "next/server";
import { supabase } from "@/lib/db";
import { parseCategoryId } from "@/lib/ids";
import { normalizeMedication } from "@/lib/normalize";
import { buildMedicationInsert, errorResponse, json, readJsonObject } from "./_shared";

// Never serve a cached inventory: a stale response makes saved changes look like data loss.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

type Row = Record<string, unknown>;

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

type FetchAll = { ok: true; rows: Row[] } | { ok: false; error: unknown } | { ok: false; tooLarge: true };

/**
 * Reads EVERY matching row. PostgREST caps a response at its max-rows setting (1000 by default, configurable per
 * project), so a single query can silently return a partial list. Pages are requested until the data runs out.
 *
 * How the end is recognised:
 *   - the first page also asks for the exact total, and the loop stops once that many rows have been read;
 *   - an empty page always ends the loop (rows deleted while reading make the total overstate what is left);
 *   - a SHORT page never does. A page holds fewer than PAGE_SIZE rows whenever the server's cap is below PAGE_SIZE,
 *     so "short" cannot be told apart from "last". Without a total (a proxy that strips the count header) the empty
 *     page is therefore the only end marker, which costs one extra request instead of a silently truncated list.
 */
async function fetchAllRows(filters: ListFilters): Promise<FetchAll> {
  const rows: Row[] = [];
  const seen = new Set<string>();
  let from = 0;
  let total: number | null = null;

  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) return { ok: false, tooLarge: true };

    const { data, error, count } = await listQuery(filters, page === 0).range(from, from + PAGE_SIZE - 1);
    if (error) return { ok: false, error };

    const batch: Row[] = data ?? [];
    if (page === 0 && typeof count === "number") total = count;

    for (const row of batch) {
      // Offset paging can repeat a row when data changes between pages; keep the first copy.
      if (row.id !== null && row.id !== undefined) {
        const key = String(row.id);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      rows.push(row);
    }

    from += batch.length;
    if (batch.length === 0) break;
    if (total !== null && from >= total) break;
  }
  return { ok: true, rows };
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

    const result = await fetchAllRows({ unnamed, category });
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
    const parsedBody = await readJsonObject(request);
    if (!parsedBody.ok) return json({ error: parsedBody.error }, 400);

    const built = buildMedicationInsert(parsedBody.body);
    if (!built.ok) return json({ error: built.error, field: built.field }, 400);

    const { data, error } = await supabase.from("medications").insert(built.row).select("*").single();
    if (error) return errorResponse(error, "medications.create", "POST /api/medications");

    return json(normalizeMedication(data), 201);
  } catch (err) {
    return errorResponse(err, "medications.create", "POST /api/medications");
  }
}

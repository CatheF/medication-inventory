import { NextRequest, NextResponse } from "next/server";
import { supabase, type Category } from "@/lib/db";
import { mapSupabaseError, type ErrorContext } from "@/lib/api-errors";
import { CATEGORY_NAME_MAX_LENGTH, exceedsLength } from "@/lib/limits";
import { normalizeCategory } from "@/lib/normalize";
import { hasInvisibleOrControlCharacter } from "@/lib/text-safety";
import { readJsonBody, rejectUnsafeRequest } from "../_guard";
import { readAllRows } from "../_paging";

// Never serve a cached category list: a stale response makes saved categories look like they vanished.
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(err: unknown, ctx: ErrorContext): NextResponse {
  const { status, body } = mapSupabaseError(err, ctx);
  if (status >= 500 || status === 403) {
    // The browser gets the plain message; the log also carries the technical facts for whoever looks after the app.
    console.error(
      `[/api/categories] ${ctx}: ${status}${body.code ? ` ${body.code}` : ""}${body.detail ? ` ${body.detail}` : ""}${body.technical ? ` | ${body.technical}` : ""}`
    );
  }
  return json(body, status);
}

/** Natural, case-insensitive order by name; ties fall back to the raw name and id so the order is deterministic. */
function byName(a: Category, b: Category): number {
  const natural = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  if (natural !== 0) return natural;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Key for the case-insensitive duplicate check (also folds composed/decomposed accents). */
function nameKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

type ParsedName = { ok: true; value: string } | { ok: false; error: string };

function parseName(input: unknown): ParsedName {
  if (input === null || input === undefined) return { ok: false, error: "Category name is required." };
  if (typeof input !== "string") return { ok: false, error: "Category name must be text." };
  const name = input.trim();
  if (name === "") return { ok: false, error: "Category name is required." };
  if (hasInvisibleOrControlCharacter(name)) {
    return { ok: false, error: "Category name can’t contain line breaks, tabs or other invisible control characters." };
  }
  if (exceedsLength(name, CATEGORY_NAME_MAX_LENGTH)) {
    return { ok: false, error: `Category name is too long (maximum ${CATEGORY_NAME_MAX_LENGTH} characters).` };
  }
  return { ok: true, value: name };
}

type AllCategories = { ok: true; categories: Category[] } | { ok: false; response: NextResponse };

/**
 * Reads EVERY category, page by page (the same loop and the same 50-page safety limit as the item list). The database may
 * answer at most N rows per request, and a list that is silently short would hide categories from the screens and let a
 * duplicate name slip past the check in POST. Pages are ordered by id so none is skipped or repeated; the answer is sorted
 * by name afterwards.
 */
async function readAllCategories(ctx: ErrorContext): Promise<AllCategories> {
  const result = await readAllRows((from, to, withCount) =>
    supabase.from("categories").select("*", withCount ? { count: "exact" } : {}).order("id", { ascending: true }).range(from, to)
  );
  if (result.ok) return { ok: true, categories: result.rows.map(normalizeCategory) };
  // A list that is too long to read is an error, like a database error: never a short list that looks complete.
  if ("tooLarge" in result) return { ok: false, response: json({ error: "The category list is too large to load in one request." }, 500) };
  return { ok: false, response: failure(result.error, ctx) };
}

export async function GET() {
  try {
    // A database error must never become an empty list: "No categories" and "couldn't load categories" are different.
    const all = await readAllCategories("categories.read");
    if (!all.ok) return all.response;
    return json(all.categories.sort(byName));
  } catch (err) {
    return failure(err, "categories.read");
  }
}

export async function POST(request: NextRequest) {
  try {
    // A web page on another site must not be able to create categories with a "simple" POST: see app/api/_guard.ts.
    const refused = rejectUnsafeRequest(request);
    if (refused) return refused;

    const read = await readJsonBody(request);
    if (!read.ok) {
      return read.reason === "too-large"
        ? json({ error: "The request is too large." }, 413)
        : json({ error: "Request body must be valid JSON." }, 400);
    }
    const raw = read.value;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return json({ error: "Request body must be a JSON object." }, 400);
    }

    const parsed = parseName((raw as Record<string, unknown>).name);
    if (!parsed.ok) return json({ error: parsed.error, field: "name" }, 400);
    const name = parsed.value;

    // Same name in a different case (or accent composition) is the same category: hand back the existing one.
    const existing = await readAllCategories("categories.create");
    if (!existing.ok) return existing.response;
    const key = nameKey(name);
    const duplicate = existing.categories.find((c) => nameKey(c.name) === key);
    if (duplicate) return json(duplicate, 200);

    const { data, error } = await supabase.from("categories").insert({ name }).select("*").single();
    if (error) {
      if (error.code === "23505") {
        // Lost a race with another request that created the same name: return the winner.
        const winner = await supabase.from("categories").select("*").eq("name", name).maybeSingle();
        if (!winner.error && winner.data) return json(normalizeCategory(winner.data), 200);
      }
      return failure(error, "categories.create");
    }
    return json(normalizeCategory(data), 201);
  } catch (err) {
    return failure(err, "categories.create");
  }
}

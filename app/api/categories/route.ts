import { NextRequest, NextResponse } from "next/server";
import { supabase, type Category } from "@/lib/db";
import { mapSupabaseError, type ErrorContext } from "@/lib/api-errors";
import { normalizeCategory } from "@/lib/normalize";
import { hasInvisibleOrControlCharacter } from "@/lib/text-safety";

// Never serve a cached category list: a stale response makes saved categories look like they vanished.
export const dynamic = "force-dynamic";

const NAME_MAX_LENGTH = 60;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(err: unknown, ctx: ErrorContext): NextResponse {
  const { status, body } = mapSupabaseError(err, ctx);
  if (status >= 500 || status === 403) {
    console.error(`[/api/categories] ${ctx}: ${status}${body.code ? ` ${body.code}` : ""}${body.detail ? ` ${body.detail}` : ""}`);
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
  if ([...name].length > NAME_MAX_LENGTH) {
    return { ok: false, error: `Category name is too long (maximum ${NAME_MAX_LENGTH} characters).` };
  }
  return { ok: true, value: name };
}

export async function GET() {
  try {
    const { data, error } = await supabase.from("categories").select("*");
    // A database error must never become an empty list: "No categories" and "couldn't load categories" are different.
    if (error) return failure(error, "categories.read");
    return json((data ?? []).map(normalizeCategory).sort(byName));
  } catch (err) {
    return failure(err, "categories.read");
  }
}

export async function POST(request: NextRequest) {
  try {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ error: "Request body must be valid JSON." }, 400);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return json({ error: "Request body must be a JSON object." }, 400);
    }

    const parsed = parseName((raw as Record<string, unknown>).name);
    if (!parsed.ok) return json({ error: parsed.error, field: "name" }, 400);
    const name = parsed.value;

    // Same name in a different case (or accent composition) is the same category: hand back the existing one.
    const existing = await supabase.from("categories").select("*");
    if (existing.error) return failure(existing.error, "categories.create");
    const key = nameKey(name);
    const duplicate = (existing.data ?? []).map(normalizeCategory).find((c) => nameKey(c.name) === key);
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

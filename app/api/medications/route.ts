import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const lowStock = searchParams.get("lowStock") === "true";
    const unnamed = searchParams.get("unnamed") === "true";
    const categoryId = searchParams.get("category");

    let query = supabase.from("medications").select("*").order("name", { nullsFirst: false }).order("barcode");

    if (categoryId) {
      query = query.eq("category_id", Number(categoryId)) as typeof query;
    }

    if (unnamed) {
      query = query.eq("is_unnamed", true) as typeof query;
    }

    const { data, error } = await query;
    if (error) throw error;

    const rows = data ?? [];

    if (lowStock) {
      // Column-to-column comparison not supported in Supabase filter — do client-side
      return NextResponse.json(rows.filter((m) => m.stock <= m.threshold));
    }

    return NextResponse.json(rows);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to fetch medications" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, barcode, photo_url, stock, threshold, vendor_url, unit, notes, category_id, is_unnamed } = body;

    if (!barcode) {
      return NextResponse.json({ error: "Barcode is required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("medications")
      .insert({
        name: name?.trim() || null,
        barcode,
        photo_url: photo_url || null,
        stock: stock ?? 0,
        threshold: threshold ?? 10,
        vendor_url: vendor_url || null,
        unit: unit || "units",
        notes: notes || null,
        category_id: category_id ?? null,
        is_unnamed: is_unnamed ?? false,
      })
      .select()
      .single();

    if (error) {
      console.error("[POST /api/medications] Supabase error:", error);
      if (error.code === "23505") {
        return NextResponse.json({ error: "Barcode already exists" }, { status: 409 });
      }
      if (error.code === "42501" || error.message?.includes("row-level security")) {
        return NextResponse.json({ error: "Insert blocked by Row Level Security — check Supabase RLS policies" }, { status: 403 });
      }
      if (error.code === "23502") {
        return NextResponse.json({ error: `Missing required field: ${error.message}`, detail: error.message, code: error.code }, { status: 400 });
      }
      return NextResponse.json(
        { error: error.message || "Failed to create medication", detail: error.details ?? error.hint ?? "", code: error.code },
        { status: 500 }
      );
    }

    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/medications] Unexpected error:", msg);
    return NextResponse.json(
      { error: msg.includes("ENOTFOUND") ? "Cannot reach Supabase — check NEXT_PUBLIC_SUPABASE_URL in .env.local" : "Failed to create medication", detail: msg },
      { status: 500 }
    );
  }
}

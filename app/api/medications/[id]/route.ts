import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { data, error } = await supabase
      .from("medications")
      .select("*")
      .eq("id", Number(id))
      .single();

    if (error || !data) {
      return NextResponse.json({ error: "Medication not found" }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to fetch medication" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, barcode, photo_url, stock, threshold, vendor_url, unit, notes, category_id } = body;

    if (!barcode) {
      return NextResponse.json({ error: "Barcode is required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("medications")
      .update({
        name: name?.trim() || null,
        barcode,
        photo_url: photo_url || null,
        stock: stock ?? 0,
        threshold: threshold ?? 10,
        vendor_url: vendor_url || null,
        unit: unit || "units",
        notes: notes || null,
        category_id: category_id ?? null,
        is_unnamed: false, // any admin edit clears the unnamed flag
      })
      .eq("id", Number(id))
      .select()
      .single();

    if (error) {
      console.error("[PUT /api/medications] Supabase error:", error);
      if (error.code === "23505") {
        return NextResponse.json({ error: "Barcode already exists" }, { status: 409 });
      }
      if (error.code === "42501" || error.message?.includes("row-level security")) {
        return NextResponse.json({ error: "Update blocked by Row Level Security — check Supabase RLS policies" }, { status: 403 });
      }
      return NextResponse.json({ error: error.message || "Failed to update medication", detail: error.details ?? "", code: error.code }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: "Medication not found" }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[PUT /api/medications] Unexpected error:", msg);
    return NextResponse.json(
      { error: msg.includes("ENOTFOUND") ? "Cannot reach Supabase — check NEXT_PUBLIC_SUPABASE_URL in .env.local" : "Failed to update medication", detail: msg },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Transactions are deleted automatically via ON DELETE CASCADE
    const { error } = await supabase
      .from("medications")
      .delete()
      .eq("id", Number(id));

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to delete medication" }, { status: 500 });
  }
}

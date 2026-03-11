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
    const { name, barcode, photo_url, stock, threshold, vendor_url, unit, notes } = body;

    if (!name || !barcode) {
      return NextResponse.json({ error: "Name and barcode are required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("medications")
      .update({
        name,
        barcode,
        photo_url: photo_url || null,
        stock: stock ?? 0,
        threshold: threshold ?? 10,
        vendor_url: vendor_url || null,
        unit: unit || "units",
        notes: notes || null,
      })
      .eq("id", Number(id))
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "Barcode already exists" }, { status: 409 });
      }
      throw error;
    }

    if (!data) {
      return NextResponse.json({ error: "Medication not found" }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to update medication" }, { status: 500 });
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

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const lowStock = searchParams.get("lowStock") === "true";

    let query = supabase.from("medications").select("*").order("name");

    if (lowStock) {
      // Supabase doesn't support column-to-column comparisons in .filter(),
      // so we use a raw Postgres filter via .lte combined with a sub-expression.
      // Workaround: fetch all and filter client-side for this simple case.
      const { data, error } = await supabase
        .from("medications")
        .select("*")
        .order("name");

      if (error) throw error;
      const filtered = (data ?? []).filter((m) => m.stock <= m.threshold);
      return NextResponse.json(filtered);
    }

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json(data ?? []);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to fetch medications" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, barcode, photo_url, stock, threshold, vendor_url, unit, notes } = body;

    if (!name || !barcode) {
      return NextResponse.json({ error: "Name and barcode are required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("medications")
      .insert({
        name,
        barcode,
        photo_url: photo_url || null,
        stock: stock ?? 0,
        threshold: threshold ?? 10,
        vendor_url: vendor_url || null,
        unit: unit || "units",
        notes: notes || null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "Barcode already exists" }, { status: 409 });
      }
      throw error;
    }

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to create medication" }, { status: 500 });
  }
}

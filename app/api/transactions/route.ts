import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const medicationId = searchParams.get("medicationId");
    const days = Number(searchParams.get("days") ?? 30);

    if (medicationId) {
      const { data, error } = await supabase
        .from("transactions")
        .select("*, medications(name, unit)")
        .eq("medication_id", Number(medicationId))
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) throw error;

      // Flatten the joined fields to match old shape
      const rows = (data ?? []).map((t) => ({
        ...t,
        medication_name: (t.medications as { name: string } | null)?.name,
        unit: (t.medications as { unit: string } | null)?.unit,
        medications: undefined,
      }));

      return NextResponse.json(rows);
    }

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("transactions")
      .select("*, medications(name, unit)")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) throw error;

    const rows = (data ?? []).map((t) => ({
      ...t,
      medication_name: (t.medications as { name: string } | null)?.name,
      unit: (t.medications as { unit: string } | null)?.unit,
      medications: undefined,
    }));

    return NextResponse.json(rows);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to fetch transactions" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { medication_id, type, quantity, note } = body;

    if (!medication_id || !type || !quantity) {
      return NextResponse.json(
        { error: "medication_id, type, and quantity are required" },
        { status: 400 }
      );
    }

    if (!["receive", "dispense"].includes(type)) {
      return NextResponse.json({ error: "type must be receive or dispense" }, { status: 400 });
    }

    if (quantity <= 0) {
      return NextResponse.json({ error: "quantity must be positive" }, { status: 400 });
    }

    // Call the atomic PostgreSQL function that checks stock, inserts the
    // transaction, and updates stock in a single database transaction.
    const { data, error } = await supabase.rpc("record_transaction", {
      p_medication_id: Number(medication_id),
      p_type: type,
      p_quantity: quantity,
      p_note: note || null,
    });

    if (error) {
      // Surface domain errors (insufficient stock, not found) to the client
      if (error.message.includes("Insufficient stock") || error.message.includes("not found")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    // rpc with RETURNS SETOF returns an array; we want the single updated row
    const updated = Array.isArray(data) ? data[0] : data;
    return NextResponse.json(updated, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to record transaction" }, { status: 500 });
  }
}

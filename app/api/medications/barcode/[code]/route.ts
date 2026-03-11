import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;
    const { data, error } = await supabase
      .from("medications")
      .select("*")
      .eq("barcode", decodeURIComponent(code))
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

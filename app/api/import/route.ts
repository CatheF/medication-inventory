import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import Papa from "papaparse";

type CsvRow = {
  name?: string;
  barcode?: string;
  stock?: string;
  threshold?: string;
  unit?: string;
  vendor_url?: string;
  notes?: string;
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const { data, errors } = Papa.parse<CsvRow>(body, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
    });

    if (errors.length > 0) {
      return NextResponse.json(
        { error: "CSV parse error", details: errors.slice(0, 5) },
        { status: 400 }
      );
    }

    const skipped: string[] = [];
    const validRows: {
      name: string;
      barcode: string;
      stock: number;
      threshold: number;
      unit: string;
      vendor_url: string | null;
      notes: string | null;
    }[] = [];

    for (const row of data) {
      if (!row.name || !row.barcode) {
        skipped.push(`Row missing name or barcode: ${JSON.stringify(row)}`);
        continue;
      }
      validRows.push({
        name: row.name.trim(),
        barcode: row.barcode.trim(),
        stock: Number(row.stock ?? 0),
        threshold: Number(row.threshold ?? 10),
        unit: row.unit?.trim() || "units",
        vendor_url: row.vendor_url?.trim() || null,
        notes: row.notes?.trim() || null,
      });
    }

    if (validRows.length === 0) {
      return NextResponse.json({
        inserted: 0,
        updated: 0,
        skipped: skipped.length,
        skippedDetails: skipped,
      });
    }

    // Fetch existing barcodes to determine insert vs update counts
    const barcodes = validRows.map((r) => r.barcode);
    const { data: existing } = await supabase
      .from("medications")
      .select("barcode")
      .in("barcode", barcodes);

    const existingBarcodes = new Set((existing ?? []).map((r) => r.barcode));
    const inserted = validRows.filter((r) => !existingBarcodes.has(r.barcode)).length;
    const updated = validRows.filter((r) => existingBarcodes.has(r.barcode)).length;

    // Upsert — Supabase handles ON CONFLICT(barcode) DO UPDATE
    const { error } = await supabase
      .from("medications")
      .upsert(validRows, { onConflict: "barcode" });

    if (error) throw error;

    return NextResponse.json({
      inserted,
      updated,
      skipped: skipped.length,
      skippedDetails: skipped,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Import failed" }, { status: 500 });
  }
}

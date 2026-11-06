import { NextRequest } from "next/server";
import { supabase } from "@/lib/db";
import { normalizeMedication } from "@/lib/normalize";
import { errorResponse, json } from "../../_shared";

// A lookup answered from a cache could show an old stock level to someone about to dispense from it.
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  try {
    // Next.js has already URL-decoded the path parameter once, and every caller encodes the barcode exactly once, so
    // the value received IS the barcode. It is looked up as it is, once, and never decoded again: a second decode would
    // turn a barcode that really contains "%41" into "A" and answer with the record of a different item, and a scan
    // would then change that other item's stock.
    const { code } = await params;

    const { data, error } = await supabase.from("medications").select("*").eq("barcode", code).maybeSingle();
    // Only "no such row" is a 404. Any other failure must not look like an unknown barcode: the scanner creates a
    // new unnamed item whenever it is told a barcode does not exist.
    if (error) return errorResponse(error, "barcode.lookup", "GET /api/medications/barcode/[code]");
    if (!data) return json({ error: "Medication not found" }, 404);
    return json(normalizeMedication(data));
  } catch (err) {
    return errorResponse(err, "barcode.lookup", "GET /api/medications/barcode/[code]");
  }
}

import { NextRequest } from "next/server";
import { supabase } from "@/lib/db";
import { normalizeMedication } from "@/lib/normalize";
import { errorResponse, json } from "../../_shared";

// A lookup answered from a cache could show an old stock level to someone about to dispense from it.
export const dynamic = "force-dynamic";

/**
 * Values to try, in order. Next.js has already URL-decoded the route param once, so the value as received is the
 * barcode. A second decode is only a fallback for callers that encoded twice, and it never throws on a stray "%".
 */
function candidates(code: string): string[] {
  try {
    const decoded = decodeURIComponent(code);
    return decoded !== code ? [code, decoded] : [code];
  } catch {
    return [code];
  }
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await params;

    for (const barcode of candidates(code)) {
      const { data, error } = await supabase.from("medications").select("*").eq("barcode", barcode).maybeSingle();
      // Only "no such row" is a 404. Any other failure must not look like an unknown barcode: the scanner creates a
      // new unnamed item whenever it is told a barcode does not exist.
      if (error) return errorResponse(error, "barcode.lookup", "GET /api/medications/barcode/[code]");
      if (data) return json(normalizeMedication(data));
    }
    return json({ error: "Medication not found" }, 404);
  } catch (err) {
    return errorResponse(err, "barcode.lookup", "GET /api/medications/barcode/[code]");
  }
}

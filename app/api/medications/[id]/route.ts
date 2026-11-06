import { NextRequest } from "next/server";
import { supabase } from "@/lib/db";
import { ITEM_NOT_FOUND_MESSAGE } from "@/lib/api-errors";
import { parseMedicationId } from "@/lib/ids";
import { normalizeMedication } from "@/lib/normalize";
import { errorResponse, invalidIdResponse, json, readJsonObject, readMedicationFields } from "../_shared";

// Never serve a cached item: a stale response makes a saved edit look lost.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const NOT_FOUND = ITEM_NOT_FOUND_MESSAGE;

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const id = parseMedicationId((await params).id);
    if (id === null) return invalidIdResponse();

    const { data, error } = await supabase.from("medications").select("*").eq("id", id).maybeSingle();
    if (error) return errorResponse(error, "medications.read", "GET /api/medications/[id]");
    if (!data) return json({ error: "Medication not found" }, 404);

    return json(normalizeMedication(data));
  } catch (err) {
    return errorResponse(err, "medications.read", "GET /api/medications/[id]");
  }
}

/**
 * Partial update: only keys present in the body are written. An omitted key is never touched (a body without
 * `category_id` must not clear the category); an explicit null clears a nullable column.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const id = parseMedicationId((await params).id);
    if (id === null) return invalidIdResponse();

    const parsedBody = await readJsonObject(request);
    if (!parsedBody.ok) return json({ error: parsedBody.error }, parsedBody.status);

    const fields = readMedicationFields(parsedBody.body);
    if (!fields.ok) return json({ error: fields.error, field: fields.field }, 400);
    if (Object.keys(fields.patch).length === 0) return json({ error: "Nothing to update" }, 400);

    const { data, error } = await supabase
      .from("medications")
      // Any successful edit clears the "unnamed — needs review" flag (SPEC 2.6, unchanged from the original route).
      // The flag means "created by a scan, nobody has looked at it yet", so saving counts as the review even when the
      // edit does not touch the name. Open product decision: clearing it only when a name is sent would keep an item in
      // the review queue after an unrelated edit, but staff could then never dismiss an item they choose not to name.
      // To change the rule, replace `is_unnamed: false` here and update the tests marked "documented contract".
      .update({ ...fields.patch, is_unnamed: false })
      .eq("id", id)
      .select("*")
      .single();
    if (error) return errorResponse(error, "medications.update", "PUT /api/medications/[id]");
    if (!data) return json({ error: NOT_FOUND }, 404);

    return json(normalizeMedication(data));
  } catch (err) {
    return errorResponse(err, "medications.update", "PUT /api/medications/[id]");
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const id = parseMedicationId((await params).id);
    if (id === null) return invalidIdResponse();

    // Transactions are deleted automatically via ON DELETE CASCADE.
    // Ask for the deleted rows back so "nothing matched" is reported instead of a false success.
    const { data, error } = await supabase.from("medications").delete().eq("id", id).select("id");
    if (error) return errorResponse(error, "medications.delete", "DELETE /api/medications/[id]");
    if (!data || data.length === 0) return json({ error: NOT_FOUND }, 404);

    return json({ success: true });
  } catch (err) {
    return errorResponse(err, "medications.delete", "DELETE /api/medications/[id]");
  }
}

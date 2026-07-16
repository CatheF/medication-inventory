import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

const BUCKET = "medication-photos";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }
    if (!file.type.startsWith("image/")) {
      return NextResponse.json({ error: "File must be an image" }, { status: 400 });
    }
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: "File too large (max 5 MB)" }, { status: 400 });
    }

    const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const buffer = Buffer.from(await file.arrayBuffer());

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .upload(filename, buffer, { contentType: file.type, upsert: false });

    if (error) {
      console.error("Supabase Storage upload error:", error);
      return NextResponse.json(
        { error: `Storage error: ${error.message}` },
        { status: 500 }
      );
    }

    const { data: { publicUrl } } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(data.path);

    return NextResponse.json({ url: publicUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Upload route error:", err);
    return NextResponse.json({ error: `Upload failed: ${message}` }, { status: 500 });
  }
}

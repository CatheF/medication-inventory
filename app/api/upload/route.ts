import { NextRequest, NextResponse } from "next/server";
import formidable from "formidable";
import path from "path";
import fs from "fs";
import { IncomingMessage } from "http";
import { Readable } from "stream";

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function nextRequestToIncomingMessage(req: NextRequest): IncomingMessage {
  const readable = new Readable() as IncomingMessage;
  readable.headers = Object.fromEntries(req.headers.entries());
  readable.method = req.method;
  readable.url = req.url;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (readable as any).push = Readable.prototype.push;

  req.arrayBuffer().then((buffer) => {
    readable.push(Buffer.from(buffer));
    readable.push(null);
  });

  return readable;
}

export async function POST(request: NextRequest) {
  try {
    const form = formidable({
      uploadDir: UPLOAD_DIR,
      keepExtensions: true,
      maxFileSize: 5 * 1024 * 1024, // 5MB
      filter: ({ mimetype }) => !!mimetype && mimetype.startsWith("image/"),
    });

    const incomingMsg = nextRequestToIncomingMessage(request);

    const [, files] = await form.parse(incomingMsg);

    const fileField = files.file;
    if (!fileField || fileField.length === 0) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const file = fileField[0];
    const filename = path.basename(file.filepath);
    const publicUrl = `/uploads/${filename}`;

    return NextResponse.json({ url: publicUrl });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to upload file" }, { status: 500 });
  }
}

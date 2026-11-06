// Request checks shared by the routes that accept a JSON body. This is a plain module, not a route (App Router only serves
// `route.ts`).
//
// WHY: the app has no login, so the only thing standing between a staff member's browser and the API is the browser's own
// cross-site rules. A web page the person visits can still fire a "simple" POST at this app without any permission check
// (no preflight) as long as the Content-Type is text/plain, application/x-www-form-urlencoded or multipart/form-data, and
// the routes used to parse the body as JSON whatever its type. Two cheap checks close that door:
//   1. the body must be declared as application/json (a page on another site cannot send that without a preflight, which
//      the app never answers, so the browser stops it), and
//   2. a request the browser itself marks as coming from another site (Sec-Fetch-Site: cross-site) is refused outright.
// Only routes that parse a JSON body use this. PUT and DELETE already need a preflight in a browser.
import { NextResponse } from "next/server";
import { MAX_JSON_BODY_BYTES } from "@/lib/limits";

function refusal(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

/** True when the Content-Type header names JSON (parameters such as "; charset=utf-8" and letter case are ignored). */
function declaresJson(request: Request): boolean {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return type === "application/json";
}

/**
 * Returns the response to send when the request must be refused, or null when it may go on:
 *   403  the browser says the request was made by a page on another site (Sec-Fetch-Site: cross-site)
 *   415  the body is not declared as application/json
 * Same-origin, same-site and "none" (typed into the address bar) requests, and callers that send no Sec-Fetch-Site header at
 * all (scripts, curl, older browsers), pass the first check; the second one still applies to all of them.
 */
export function rejectUnsafeRequest(request: Request): NextResponse | null {
  if ((request.headers.get("sec-fetch-site") ?? "").trim().toLowerCase() === "cross-site") {
    return refusal("This request came from another website, so it was not accepted.", 403);
  }
  if (!declaresJson(request)) {
    return refusal("The request must be sent as JSON (Content-Type: application/json).", 415);
  }
  return null;
}

export type JsonBody = { ok: true; value: unknown } | { ok: false; reason: "too-large" | "invalid-json" };

/**
 * Reads and parses a JSON body of at most `maxBytes` bytes.
 *   - A declared Content-Length above the limit is refused BEFORE the body is read.
 *   - A body that arrives without a (truthful) Content-Length, for example a chunked upload, is checked once it has been
 *     read, so the limit holds either way.
 * The caller chooses the wording of its own error messages.
 */
export async function readJsonBody(request: Request, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<JsonBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null && declared.trim() !== "") {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) return { ok: false, reason: "too-large" };
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await request.arrayBuffer();
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (bytes.byteLength > maxBytes) return { ok: false, reason: "too-large" };

  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
}

// Browser side of "Download Excel (.xlsx)": posts the sheet to POST /api/order-sheet/xlsx and saves the file the
// server returns. The workbook is built by the server (lib/order-sheet/xlsx.ts); this module must never import it.
// Nothing here places an order or changes stock: the endpoint only reads the inventory.

import type { BuiltSheet } from "@/lib/order-sheet/types";
import { isTimeoutError, timeLimit } from "./request-limit";

const XLSX_CONTENT_TYPE_PART = "spreadsheetml.sheet";

export type ExportOutcome =
  | { ok: true; fileName: string }
  | {
      ok: false;
      message: string;
      /** The server says some items are no longer in the inventory: the page should reload its item list. */
      inventoryChanged: boolean;
    };

const GENERIC_FAILURE = "The Excel file could not be created. Try again, or use Print / Save as PDF instead.";
// Said when the server took longer than the time limit (see request-limit.ts): a request nobody answers must end in an error
// with Retry, not in "Creating the Excel file..." for ever.
const TOO_SLOW = "The server took too long to answer while creating the Excel file. Try again, or use Print / Save as PDF instead.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(message: string, inventoryChanged = false): ExportOutcome {
  return { ok: false, message, inventoryChanged };
}

/** Reads `{ error, missingIds }` from a JSON error body; anything else (HTML from a proxy, empty body) is "no details". */
async function readErrorBody(response: Response): Promise<{ error: string | null; missingCount: number | null }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return { error: null, missingCount: null };
  try {
    const body: unknown = await response.json();
    if (!isRecord(body)) return { error: null, missingCount: null };
    const error = typeof body.error === "string" && body.error.trim() !== "" ? body.error.trim() : null;
    const missingCount = Array.isArray(body.missingIds) ? body.missingIds.length : null;
    return { error, missingCount };
  } catch {
    return { error: null, missingCount: null };
  }
}

/** Turns a failed response into one clear sentence: what happened and what to do. */
async function describeFailure(response: Response): Promise<ExportOutcome> {
  const { error, missingCount } = await readErrorBody(response);
  switch (response.status) {
    case 400:
      return failure(error ?? "The server could not read this sheet. Check the quantities and try again.");
    case 413:
      return failure(error ?? "The order sheet is too large to export. Remove some items and try again.");
    case 422: {
      const count = missingCount ?? 0;
      if (count > 0) {
        const noun = count === 1 ? "1 item" : `${count} items`;
        return failure(`${noun} on the sheet ${count === 1 ? "is" : "are"} no longer in the inventory. Remove ${count === 1 ? "it" : "them"} and try again.`, true);
      }
      return failure(error ?? "Some items on the sheet are no longer in the inventory. Remove them and try again.", true);
    }
    case 503:
      return failure(error ?? "The server is unavailable right now. Try again in a minute.");
    default:
      return failure(error ?? `${GENERIC_FAILURE} (HTTP ${response.status})`);
  }
}

/** Takes the file name from Content-Disposition, but only if it is a plain safe .xlsx name. */
function fileNameFrom(disposition: string | null, fallback: string): string {
  const match = disposition ? /filename="([^"]+)"/i.exec(disposition) : null;
  const candidate = match ? match[1] : "";
  return /^[A-Za-z0-9._-]{1,100}\.xlsx$/.test(candidate) ? candidate : fallback;
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser time to start the download before the temporary address is released.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Exactly the rows that print (items that no longer exist are not in sheet.rows). Quantities are the validated ones. */
export async function downloadWorkbook(sheet: BuiltSheet): Promise<ExportOutcome> {
  const { options, rows } = sheet;
  const payload = {
    title: options.title,
    date: options.date,
    preparedBy: options.preparedBy,
    notes: options.notes,
    showOnHand: options.showOnHand,
    showBarcode: options.showBarcode,
    rows: rows.map((row) => ({ id: row.id, qty: row.qty, unit: row.unit })),
  };

  let response: Response;
  try {
    response = await fetch("/api/order-sheet/xlsx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: timeLimit(),
    });
  } catch (error) {
    return isTimeoutError(error) ? failure(TOO_SLOW) : failure("Can’t reach the server. Check your internet connection and try again.");
  }

  // Check the status and the content type BEFORE reading the body as a file: an error page must never be saved as .xlsx.
  if (!response.ok) return describeFailure(response);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes(XLSX_CONTENT_TYPE_PART)) {
    return failure("The server did not send an Excel file. Try again, or use Print / Save as PDF instead.");
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch (error) {
    // The same limit covers receiving the file: one that stops arriving is "too slow", not a connection that is gone.
    return isTimeoutError(error) ? failure(TOO_SLOW) : failure("The Excel file did not finish downloading. Check your connection and try again.");
  }
  if (blob.size === 0) return failure("The server sent an empty file. Try again.");

  const fileName = fileNameFrom(response.headers.get("content-disposition"), `order-sheet-${options.date}.xlsx`);
  saveBlob(blob, fileName);
  return { ok: true, fileName };
}

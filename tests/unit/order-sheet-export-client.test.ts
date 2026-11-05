// The browser side of "Download Excel (.xlsx)" (app/order-sheet/export-client.ts), with a fake fetch and a fake document.
// Pinned here: what is SENT (only the ticked rows' id, quantity and unit: never a remembered item name, a barcode or a
// stock figure) and what staff are told when it fails (the server's own words; an error page is never saved as a file).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadWorkbook } from "@/app/order-sheet/export-client";
import { buildSheet } from "@/lib/order-sheet/build";
import type { BuiltSheet, SheetOptions } from "@/lib/order-sheet/types";
import { buildMedications } from "@/tests/helpers/fixtures";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const OPTIONS: SheetOptions = { title: "Winter order", date: "2026-11-05", preparedBy: "N. Rivera", notes: "Call first.", showOnHand: true, showBarcode: false };
const items = buildMedications();

type FakeResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  blob(): Promise<Blob>;
};

function response(status: number, init: { type?: string; disposition?: string; json?: unknown; blob?: Blob | "throws" } = {}): FakeResponse {
  const headers: Record<string, string> = {};
  if (init.type) headers["content-type"] = init.type;
  if (init.disposition) headers["content-disposition"] = init.disposition;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => {
      if (init.json === undefined) throw new SyntaxError("Unexpected end of JSON input");
      return init.json;
    },
    blob: async () => {
      if (init.blob === "throws") throw new TypeError("network error");
      return init.blob ?? new Blob([new Uint8Array([0x50, 0x4b, 3, 4])]);
    },
  };
}

type Saved = { href: string; download: string; rel: string; clicked: boolean };
let saved: Saved[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function installBrowser(answer: () => Promise<FakeResponse>) {
  saved = [];
  fetchMock = vi.fn(answer);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("document", {
    createElement: () => {
      const link = {
        href: "",
        download: "",
        rel: "",
        style: {},
        clicked: false,
        click() {
          this.clicked = true;
        },
        remove() {},
      };
      saved.push(link);
      return link;
    },
    body: { appendChild() {} },
  });
  vi.stubGlobal("window", { setTimeout: () => 0 });
}

function sentBody(): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

beforeEach(() => {
  installBrowser(async () => response(200, { type: XLSX_TYPE, disposition: 'attachment; filename="order-sheet-2026-11-05.xlsx"' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what is sent", () => {
  it("POSTs the sheet's options and, for each printed row, only its id, quantity and unit", async () => {
    const sheet = buildSheet(items, [{ id: 100, qty: "007", unit: " box " }, { id: 101, qty: "", unit: "" }], OPTIONS);
    const outcome = await downloadWorkbook(sheet);
    expect(outcome).toEqual({ ok: true, fileName: "order-sheet-2026-11-05.xlsx" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/order-sheet/xlsx");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    const body = sentBody();
    expect(Object.keys(body).sort()).toEqual(["date", "notes", "preparedBy", "rows", "showBarcode", "showOnHand", "title"]);
    expect(body).toMatchObject({ title: "Winter order", date: "2026-11-05", preparedBy: "N. Rivera", notes: "Call first.", showOnHand: true, showBarcode: false });
    const rows = body.rows as Array<Record<string, unknown>>;
    expect(rows).toEqual([{ id: 100, qty: "7", unit: "box" }, { id: 101, qty: "", unit: "" }]);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["id", "qty", "unit"]);
  });

  it("never sends a draft row's remembered name, an item name, a barcode, a supplier number or stock", async () => {
    // The draft rows carry a remembered name; the sheet is built from them; only id/qty/unit may leave the browser.
    const draftRows = [{ id: 100, qty: "5", unit: "case", name: "REMEMBERED NAME <b>x</b>" }];
    const sheet = buildSheet(items, draftRows, OPTIONS);
    await downloadWorkbook(sheet);
    const text = String((fetchMock.mock.calls[0][1] as RequestInit).body);
    expect(text).not.toContain("REMEMBERED NAME");
    expect(text).not.toContain(items[0].name ?? "NO NAME");
    expect(text).not.toContain(items[0].barcode);
    expect(text).not.toContain("00417-B"); // its supplier order number
    expect(text).not.toContain("onHand");
    expect(text).not.toContain("120"); // its stock
  });

  it("sends exactly three keys even if a row object carries extra properties (it picks fields, it does not serialize the row)", async () => {
    const sheet = buildSheet(items, [{ id: 100, qty: "5", unit: "case" }], OPTIONS);
    const rowWithExtras = { ...sheet.rows[0], name: "WRONG", rememberedName: "WRONG", secret: "WRONG" };
    const tampered: BuiltSheet = { ...sheet, rows: [rowWithExtras] };
    await downloadWorkbook(tampered);
    expect((sentBody().rows as Array<Record<string, unknown>>)[0]).toEqual({ id: 100, qty: "5", unit: "case" });
  });
});

describe("what is saved", () => {
  it("saves the file under the server's plain .xlsx name and reports it", async () => {
    const sheet = buildSheet(items, [{ id: 100, qty: "", unit: "" }], OPTIONS);
    const outcome = await downloadWorkbook(sheet);
    expect(outcome).toEqual({ ok: true, fileName: "order-sheet-2026-11-05.xlsx" });
    expect(saved).toHaveLength(1);
    expect(saved[0].download).toBe("order-sheet-2026-11-05.xlsx");
    expect(saved[0].clicked).toBe(true);
    expect(saved[0].rel).toBe("noopener");
    expect(saved[0].href).toMatch(/^blob:/);
  });

  it.each([
    ["no Content-Disposition at all", undefined],
    ["a path in the name", 'attachment; filename="../../evil.xlsx"'],
    ["a name that is not .xlsx", 'attachment; filename="order-sheet.exe"'],
    ["a name with spaces and quotes", 'attachment; filename="my sheet.xlsx"'],
  ])("falls back to a name built from the sheet's date when the server sends %s", async (_label, disposition) => {
    installBrowser(async () => response(200, { type: XLSX_TYPE, disposition }));
    const outcome = await downloadWorkbook(buildSheet(items, [{ id: 100, qty: "", unit: "" }], OPTIONS));
    expect(outcome).toEqual({ ok: true, fileName: "order-sheet-2026-11-05.xlsx" });
    expect(saved[0].download).toBe("order-sheet-2026-11-05.xlsx");
  });
});

describe("what staff are told when it fails (and nothing is saved)", () => {
  const sheet = buildSheet(items, [{ id: 100, qty: "5", unit: "box" }], OPTIONS);

  async function failWith(res: FakeResponse | Error) {
    installBrowser(async () => {
      if (res instanceof Error) throw res;
      return res;
    });
    const outcome = await downloadWorkbook(sheet);
    expect(saved, "no file is saved for a failure").toHaveLength(0);
    expect(outcome.ok).toBe(false);
    return outcome as { ok: false; message: string; inventoryChanged: boolean };
  }

  it("400: the server's own text", async () => {
    const outcome = await failWith(response(400, { type: "application/json", json: { error: "Row 1: Order quantity must be a whole number.", field: "rows[0].qty" } }));
    expect(outcome.message).toBe("Row 1: Order quantity must be a whole number.");
    expect(outcome.inventoryChanged).toBe(false);
  });

  it("400 without a readable body: a plain sentence that says what to do", async () => {
    const outcome = await failWith(response(400, { type: "text/html" }));
    expect(outcome.message).toBe("The server could not read this sheet. Check the quantities and try again.");
  });

  it("413: too large", async () => {
    expect((await failWith(response(413, { type: "application/json", json: { error: "The order sheet is too large to export." } }))).message).toBe("The order sheet is too large to export.");
    expect((await failWith(response(413))).message).toBe("The order sheet is too large to export. Remove some items and try again.");
  });

  it("422: says how many items are gone, asks to remove them, and tells the page to reload its list", async () => {
    const one = await failWith(response(422, { type: "application/json", json: { error: "x", missingIds: [105] } }));
    expect(one.message).toBe("1 item on the sheet is no longer in the inventory. Remove it and try again.");
    expect(one.inventoryChanged).toBe(true);
    const two = await failWith(response(422, { type: "application/json", json: { error: "x", missingIds: [105, 106] } }));
    expect(two.message).toBe("2 items on the sheet are no longer in the inventory. Remove them and try again.");
    const unknown = await failWith(response(422, { type: "application/json", json: {} }));
    expect(unknown.message).toBe("Some items on the sheet are no longer in the inventory. Remove them and try again.");
    expect(unknown.inventoryChanged).toBe(true);
  });

  it("503 and 500: the server's words (with the status when there are none)", async () => {
    expect((await failWith(response(503, { type: "application/json", json: { error: "Can’t reach the database. Check the connection, and that the Supabase project isn’t paused." } }))).message).toBe(
      "Can’t reach the database. Check the connection, and that the Supabase project isn’t paused."
    );
    expect((await failWith(response(503))).message).toBe("The server is unavailable right now. Try again in a minute.");
    expect((await failWith(response(500, { type: "application/json", json: { error: "Unexpected database error.", code: "XX000" } }))).message).toBe("Unexpected database error.");
    expect((await failWith(response(502, { type: "text/html" }))).message).toBe("The Excel file could not be created. Try again, or use Print / Save as PDF instead. (HTTP 502)");
  });

  it("a network failure is not the server's fault and says so", async () => {
    expect((await failWith(new TypeError("Failed to fetch"))).message).toBe("Can’t reach the server. Check your internet connection and try again.");
  });

  it("a 200 that is not a spreadsheet (a proxy's error page) is never saved as .xlsx", async () => {
    const outcome = await failWith(response(200, { type: "text/html; charset=utf-8", blob: new Blob(["<html>Sign in</html>"]) }));
    expect(outcome.message).toBe("The server did not send an Excel file. Try again, or use Print / Save as PDF instead.");
  });

  it("an empty file or an interrupted download is an error", async () => {
    expect((await failWith(response(200, { type: XLSX_TYPE, blob: new Blob([]) }))).message).toBe("The server sent an empty file. Try again.");
    expect((await failWith(response(200, { type: XLSX_TYPE, blob: "throws" }))).message).toBe("The Excel file did not finish downloading. Check your connection and try again.");
  });
});

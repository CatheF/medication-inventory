// Requirement-driven tests: POST /api/order-sheet/xlsx, the HTTP contract.
//
//   "Preparing, printing, or exporting the sheet must not place an order, email a supplier, change stock balances, mark
//    goods as ordered, or rewrite usage history."                                      -> ZERO writes, on every path
//   "show generation errors clearly"                                                    -> every failure is JSON with a message
//   Missing items -> 422 with missingIds; invalid input -> 400; the file itself is covered in order-sheet-export-file.test.ts.
//
// Both id shapes are exercised (the categories on the items differ; the sheet must not care).
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Medication } from "@/lib/db";
import { asRecord, bodyRecord, errorTextOf, ID_SHAPES, isRecord, itemNamed, snapshotDb } from "../helpers/api-test-kit";
import { installFake, type FakeSupabase, type RecordedCall } from "../helpers/fake-supabase";
import { buildCategories, buildManyMedications } from "../helpers/fixtures";
import { seedStandard } from "../helpers/fixtures-extra";
import { api } from "../helpers/route-client";
import { readXlsx } from "../helpers/xlsx-reader";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

import { POST as exportRoute } from "@/app/api/order-sheet/xlsx/route";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

type Row = { id: unknown; qty?: unknown; unit?: unknown };

/** `rows` is deliberately untyped: several tests send malformed rows on purpose. */
function sheetBody(rows: readonly unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: "Supply order", date: "2026-11-05", preparedBy: "Nurse A", notes: "", showOnHand: false, showBarcode: false, rows, ...overrides };
}

function rawExport(raw: string): Promise<Response> {
  // The body is the test's own (not necessarily JSON), but the request is declared as JSON like the page's own call.
  return exportRoute(new NextRequest("http://localhost/api/order-sheet/xlsx", { method: "POST", headers: { "content-type": "application/json" }, body: raw }));
}

/** Every database call the export made was a plain read of the medications table (nothing else, ever). */
function expectOnlyMedicationReads(fake: FakeSupabase): void {
  expect(fake.writes()).toEqual([]);
  for (const call of fake.calls) {
    expect(call.op).toBe("select");
    expect(call.table).toBe("medications");
    expect(call.select).toBe("*"); // never names the supplier column, so it also works before the migration
  }
}

function idsRequestedBy(call: RecordedCall): number[] {
  const filter = call.filters.find((f) => f.column === "id" && f.operator === "in");
  if (!filter || !Array.isArray(filter.value)) throw new Error("expected an in() filter on id");
  return filter.value.map((v) => Number(v));
}

/**
 * Watches every way this process could reach another machine: global fetch, and any TCP connection made through node's
 * net, tls, http or https (they all end in net.Socket.prototype.connect). The spies REFUSE the attempt as well as recording
 * it, so a regression cannot send anything anywhere while a test runs. Not watched: UDP and child processes.
 */
function watchNetwork() {
  const fetches = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network access is blocked in tests"));
  const connections = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket) {
    return this; // refuse to open anything
  });
  return {
    fetches,
    connections,
    /**
     * Passes only when nothing tried to go out, after letting work the route started in the background reach the network
     * layer: a turn of the event loop, then a zero-delay timer (timers with the same delay fire in the order they were
     * queued, so any zero-delay timer the route set earlier has already run), then one more turn. No fixed waiting time.
     */
    assertQuiet: async (): Promise<void> => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fetches, "global fetch was called").not.toHaveBeenCalled();
      expect(connections, "a network connection was attempted").not.toHaveBeenCalled();
    },
  };
}

describe.each(ID_SHAPES)("POST /api/order-sheet/xlsx on the $label", ({ options, shape }) => {
  let fake: FakeSupabase;
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake(options);
    ({ medications } = seedStandard(fake, { withTransactions: true }));
  });

  const pick = (...prefixes: string[]): Row[] => prefixes.map((p) => ({ id: itemNamed(medications, p).id }));

  describe("a successful export has no side effects at all", () => {
    it("reads the medications it needs and writes nothing: no insert, update, delete, upsert, rpc or upload", async () => {
      const res = await api.exportXlsx(sheetBody(pick("Acetaminophen 500 mg", "Ibuprofen 200 mg", "Aspirin 81 mg", "Nitrile gloves, M", "IV start kit")));
      expect(res.status).toBe(200);
      expectOnlyMedicationReads(fake);
      expect(fake.calls.length).toBeGreaterThan(0);
    });

    it("leaves every table exactly as it was, including stock balances, usage history, categories and supplier numbers", async () => {
      const before = snapshotDb(fake);
      const res = await api.exportXlsx(sheetBody(pick("Acetaminophen 500 mg", "Ibuprofen 200 mg", "Thermometer probe covers")));
      expect(res.status).toBe(200);
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("does not change stock when the typed order quantity is larger than stock (the order quantity is a document value only)", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg"); // stock 9
      const before = snapshotDb(fake);
      const res = await api.exportXlsx(sheetBody([{ id: item.id, qty: "500", unit: "case" }]));
      expect(res.status).toBe(200);
      expect(snapshotDb(fake).medications).toEqual(before.medications);
      expect(fake.dump("medications").find((m) => m.id === item.id)?.stock).toBe(item.stock);
      expect(fake.dump("transactions")).toEqual(before.transactions);
    });

    it("exporting twice in a row changes nothing and writes nothing, so a repeated click cannot 'order' twice", async () => {
      const before = snapshotDb(fake);
      const body = sheetBody(pick("Acetaminophen 500 mg", "Ibuprofen 200 mg"), {});
      expect((await api.exportXlsx(body)).status).toBe(200);
      expect((await api.exportXlsx(body)).status).toBe(200);
      expectOnlyMedicationReads(fake);
      expect(snapshotDb(fake)).toEqual(before);
    });

    it("opens no network connection of its own, not through fetch and not through any node socket (http, https, tls, net): nothing is uploaded to a conversion service, emailed or sent to a supplier", async () => {
      const network = watchNetwork();
      const res = await api.exportXlsx(sheetBody(pick("Acetaminophen 500 mg", "Ibuprofen 200 mg"), { showBarcode: true, showOnHand: true }));
      expect(res.status).toBe(200);
      await network.assertQuiet();
    });

    it.each([
      ["a request the export rejects (400)", sheetBody([{ id: 100, qty: "abc" }]), undefined, 400],
      ["an item that is no longer in the inventory (422)", sheetBody([{ id: 424242 }]), undefined, 422],
      [
        "an unreachable database (503)",
        sheetBody([{ id: 100 }]),
        (f: FakeSupabase) => f.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "medications" }),
        503,
      ],
      [
        "a database client that throws (500)",
        sheetBody([{ id: 100 }]),
        (f: FakeSupabase) =>
          f.onCall(() => {
            throw new Error("socket hang up");
          }),
        500,
      ],
    ])("opens no network connection on the error path either, so a failure is not reported to a third party: %s", async (_label, body, prepare, status) => {
      prepare?.(fake);
      const network = watchNetwork();
      const res = await api.exportXlsx(body);
      expect(res.status).toBe(status);
      await network.assertQuiet();
    });

    it("tells staff to add at least one item when the sheet is empty", async () => {
      const res = await api.exportXlsx(sheetBody([]));
      expect(res.status).toBe(400);
      expect(errorTextOf(await res.json())).toMatch(/^Add at least one item/);
    });

    it("never reads transactions or categories to build the sheet (it needs neither)", async () => {
      await api.exportXlsx(sheetBody(pick("Acetaminophen 500 mg")));
      expect(fake.callsFor("transactions")).toEqual([]);
      expect(fake.callsFor("categories")).toEqual([]);
    });

    it("reads in chunks of at most 200 ids and still exports all 450 items of a long sheet", async () => {
      const fresh = installFake(options);
      fresh.seedCategories(buildCategories(shape));
      const bulk = buildManyMedications(450, shape);
      fresh.seedMedications(bulk);
      const res = await api.exportXlsx(sheetBody(bulk.map((m) => ({ id: m.id }))));
      expect(res.status).toBe(200);
      const reads = fresh.calls.filter((c) => c.table === "medications");
      expect(reads.length).toBe(3);
      for (const call of reads) expect(idsRequestedBy(call).length).toBeLessThanOrEqual(200);
      expect(new Set(reads.flatMap(idsRequestedBy)).size).toBe(450);
      expectOnlyMedicationReads(fresh);
    });

    it("ignores a repeated row entirely, so a later duplicate with a bad quantity or unit cannot fail the export (the first occurrence wins)", async () => {
      const id = itemNamed(medications, "Acetaminophen 500 mg").id;
      const res = await api.exportXlsx(sheetBody([{ id, qty: "5", unit: "box" }, { id, qty: "not a number", unit: 7 }]));
      expect(res.status).toBe(200);
    });

    it("does not log the sheet's title, notes or prepared-by text when the database client throws (the path on which the route logs)", async () => {
      const logged = vi.spyOn(console, "error");
      fake.onCall(() => {
        throw new Error("socket hang up");
      });
      const res = await api.exportXlsx(sheetBody(pick("Acetaminophen 500 mg"), { title: "SECRET-TITLE-7731", preparedBy: "SECRET-NAME-7731", notes: "SECRET-NOTE-7731" }));
      expect(res.status).toBe(500);
      expect(logged).toHaveBeenCalled(); // guards against a vacuous pass: the route did log something
      expect(JSON.stringify(logged.mock.calls)).not.toMatch(/SECRET-(TITLE|NAME|NOTE)-7731/);
      expect(JSON.stringify(await res.json())).not.toMatch(/SECRET-(TITLE|NAME|NOTE)-7731/);
    });

    it("writes no item name, barcode, title, notes or prepared-by text to any server log on a SUCCESSFUL export (inventory text must not end up in logs)", async () => {
      const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
      const item = itemNamed(medications, "Acetaminophen 500 mg");
      const res = await api.exportXlsx(
        sheetBody([{ id: item.id, qty: "2", unit: "box" }], { title: "SECRET-TITLE-7733", preparedBy: "SECRET-NAME-7733", notes: "SECRET-NOTE-7733", showBarcode: true })
      );
      expect(res.status).toBe(200);
      const written = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
      expect(written).not.toContain("Acetaminophen");
      expect(written).not.toContain(item.barcode);
      expect(written).not.toMatch(/SECRET-(TITLE|NAME|NOTE)-7733/);
    });

    it("does not log the sheet's title, notes or prepared-by text when the database answers with an error", async () => {
      const logged = vi.spyOn(console, "error");
      fake.failNext({ code: "XX000", message: "internal error" }, { table: "medications" });
      const res = await api.exportXlsx(sheetBody(pick("Acetaminophen 500 mg"), { title: "SECRET-TITLE-7732", preparedBy: "SECRET-NAME-7732", notes: "SECRET-NOTE-7732" }));
      expect(res.status).toBe(500);
      expect(JSON.stringify(logged.mock.calls)).not.toMatch(/SECRET-(TITLE|NAME|NOTE)-7732/);
      expect(JSON.stringify(await res.json())).not.toMatch(/SECRET-(TITLE|NAME|NOTE)-7732/);
    });

    it("does not issue a database read twice for an id that appears twice in the request", async () => {
      const item = itemNamed(medications, "Acetaminophen 500 mg");
      await api.exportXlsx(sheetBody([{ id: item.id }, { id: item.id, qty: "3" }]));
      expect(idsRequestedBy(fake.calls[0])).toEqual([item.id]);
    });
  });

  describe("the response of a successful export", () => {
    it("is 200 with the xlsx media type, an attachment filename built only from the date, no-store caching and the exact byte length", async () => {
      const res = await api.exportXlsx(sheetBody(pick("Acetaminophen 500 mg")));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="order-sheet-2026-11-05.xlsx"');
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
      expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]); // "PK": a zip package, i.e. a real xlsx and not CSV text
    });

    it.each([
      ["a quote and a line break", 'Order "A"\r\nSet-Cookie: session=1'],
      ["a path traversal", "../../etc/passwd"],
      ["a filename-breaking quote", 'x"; filename="evil.exe'],
      ["non-ASCII text", "Commande d’hiver 日本"],
    ])("never lets the title (%s) or prepared-by text leak into the filename or the response headers", async (_label, hostile) => {
      const res = await api.exportXlsx(sheetBody(pick("Acetaminophen 500 mg"), { title: hostile, preparedBy: hostile, notes: hostile }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="order-sheet-2026-11-05.xlsx"');
      expect(res.headers.get("set-cookie")).toBeNull();
    });

    it("names the file after the sheet's date, whatever the date is", async () => {
      const res = await api.exportXlsx(sheetBody(pick("Acetaminophen 500 mg"), { date: "2028-02-29" }));
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="order-sheet-2028-02-29.xlsx"');
    });

    it("accepts item ids written as digit strings and numbers alike", async () => {
      const item = itemNamed(medications, "Acetaminophen 500 mg");
      expect((await api.exportXlsx(sheetBody([{ id: item.id }]))).status).toBe(200);
      expect((await api.exportXlsx(sheetBody([{ id: String(item.id) }]))).status).toBe(200);
    });

    it("ignores unknown keys in the request and in rows (a client cannot inject names, codes or stock)", async () => {
      const item = itemNamed(medications, "Acetaminophen 500 mg");
      const before = snapshotDb(fake);
      const res = await api.exportXlsx({
        ...sheetBody([{ id: item.id, qty: "2", unit: "box", name: "Hacked", supplier_order_number: "HACK", stock: 99999 }]),
        extra: { anything: true },
        status: "ordered",
      });
      expect(res.status).toBe(200);
      expect(snapshotDb(fake)).toEqual(before);
      expectOnlyMedicationReads(fake);
    });

    it("exports a full sheet of 500 items", async () => {
      const fresh = installFake(options);
      fresh.seedCategories(buildCategories(shape));
      const bulk = buildManyMedications(500, shape);
      fresh.seedMedications(bulk);
      const res = await api.exportXlsx(sheetBody(bulk.map((m) => ({ id: m.id }))));
      expect(res.status).toBe(200);
      expectOnlyMedicationReads(fresh);
    });
  });

  describe("every failure is JSON with a message that says what is wrong, and still writes nothing", () => {
    type Failure = {
      label: string;
      status: number;
      /** What staff are told. Specific enough that a generic "Invalid request." (or any other catch-all) cannot pass. */
      message: RegExp;
      /** database set-up that must happen before the request */
      prepare?: (f: FakeSupabase) => void;
      body?: Record<string, unknown>;
      raw?: string;
      /** true when the request is rejected before any database read */
      noDatabaseRead?: boolean;
      field?: string;
    };
    const rows1 = (): Row[] => [{ id: 100 }];
    const NOT_JSON = /request body must be valid JSON/i;
    const NOT_OBJECT = /request must be a JSON object/i;
    const BAD_DATE = /^Date must be a real calendar date .*YYYY-MM-DD/;
    const NOT_A_LIST = /^rows must be a list of order sheet rows/i;
    const BAD_ID = /^Row 1 has an invalid item id/;
    const BAD_QTY = /^Row 1: Order quantity must be a whole number from 1 to 999,999,999/;
    const failures: Failure[] = [
      { label: "malformed JSON", status: 400, message: NOT_JSON, raw: "{not json", noDatabaseRead: true },
      { label: "an empty body", status: 400, message: NOT_JSON, raw: "", noDatabaseRead: true },
      { label: "a JSON array", status: 400, message: NOT_OBJECT, raw: "[]", noDatabaseRead: true },
      { label: "JSON null", status: 400, message: NOT_OBJECT, raw: "null", noDatabaseRead: true },
      { label: "a bare JSON string", status: 400, message: NOT_OBJECT, raw: '"x"', noDatabaseRead: true },
      { label: "a missing date", status: 400, message: BAD_DATE, body: { ...sheetBody(rows1()), date: undefined }, field: "date", noDatabaseRead: true },
      { label: "a date that is not a real day (2026-02-30)", status: 400, message: BAD_DATE, body: sheetBody(rows1(), { date: "2026-02-30" }), field: "date", noDatabaseRead: true },
      { label: "a date in the wrong format (11/05/2026)", status: 400, message: BAD_DATE, body: sheetBody(rows1(), { date: "11/05/2026" }), field: "date", noDatabaseRead: true },
      { label: "a date with a time (2026-11-05T10:00:00Z)", status: 400, message: BAD_DATE, body: sheetBody(rows1(), { date: "2026-11-05T10:00:00Z" }), field: "date", noDatabaseRead: true },
      { label: "a numeric date", status: 400, message: BAD_DATE, body: sheetBody(rows1(), { date: 20261105 }), field: "date", noDatabaseRead: true },
      { label: "no rows key", status: 400, message: NOT_A_LIST, body: { ...sheetBody(rows1()), rows: undefined }, field: "rows", noDatabaseRead: true },
      { label: "rows that are not a list", status: 400, message: NOT_A_LIST, body: sheetBody(rows1(), { rows: "100" }), field: "rows", noDatabaseRead: true },
      { label: "an empty sheet", status: 400, message: /^Add at least one item to the order sheet before exporting/, body: sheetBody([]), field: "rows", noDatabaseRead: true },
      { label: "501 rows", status: 400, message: /^An order sheet can have at most 500 items/, body: sheetBody(Array.from({ length: 501 }, (_, i) => ({ id: i + 1 }))), field: "rows", noDatabaseRead: true },
      { label: "a row that is not an object", status: 400, message: /^Row 1 is not a valid row/, body: sheetBody([5]), field: "rows[0]", noDatabaseRead: true },
      { label: "a row without an id", status: 400, message: BAD_ID, body: sheetBody([{ qty: "1" }]), field: "rows[0].id", noDatabaseRead: true },
      { label: "an id of zero", status: 400, message: BAD_ID, body: sheetBody([{ id: 0 }]), field: "rows[0].id", noDatabaseRead: true },
      { label: "a negative id", status: 400, message: BAD_ID, body: sheetBody([{ id: -4 }]), field: "rows[0].id", noDatabaseRead: true },
      { label: "a fractional id", status: 400, message: BAD_ID, body: sheetBody([{ id: 1.5 }]), field: "rows[0].id", noDatabaseRead: true },
      { label: "a text id", status: 400, message: BAD_ID, body: sheetBody([{ id: "abc" }]), field: "rows[0].id", noDatabaseRead: true },
      { label: "a quantity of letters", status: 400, message: BAD_QTY, body: sheetBody([{ id: 100, qty: "abc" }]), field: "rows[0].qty", noDatabaseRead: true },
      { label: "a decimal quantity", status: 400, message: BAD_QTY, body: sheetBody([{ id: 100, qty: "1.5" }]), field: "rows[0].qty", noDatabaseRead: true },
      { label: "a negative quantity", status: 400, message: BAD_QTY, body: sheetBody([{ id: 100, qty: "-2" }]), field: "rows[0].qty", noDatabaseRead: true },
      { label: "a quantity of zero", status: 400, message: BAD_QTY, body: sheetBody([{ id: 100, qty: "0" }]), field: "rows[0].qty", noDatabaseRead: true },
      { label: "a quantity with a thousands separator", status: 400, message: BAD_QTY, body: sheetBody([{ id: 100, qty: "1,000" }]), field: "rows[0].qty", noDatabaseRead: true },
      { label: "a quantity with a unit glued on", status: 400, message: BAD_QTY, body: sheetBody([{ id: 100, qty: "12 boxes" }]), field: "rows[0].qty", noDatabaseRead: true },
      { label: "a numeric JSON quantity", status: 400, message: /^Row 1: order quantity must be text/, body: sheetBody([{ id: 100, qty: 12 }]), field: "rows[0].qty", noDatabaseRead: true },
      { label: "a quantity above 999,999,999", status: 400, message: BAD_QTY, body: sheetBody([{ id: 100, qty: "1000000000" }]), field: "rows[0].qty", noDatabaseRead: true },
      { label: "a numeric unit", status: 400, message: /^Row 1: order unit must be text/, body: sheetBody([{ id: 100, unit: 5 }]), field: "rows[0].unit", noDatabaseRead: true },
      { label: "a 41-character unit", status: 400, message: /^Row 1: order unit must be at most 40 characters/, body: sheetBody([{ id: 100, unit: "u".repeat(41) }]), field: "rows[0].unit", noDatabaseRead: true },
      { label: "a 121-character title", status: 400, message: /^Title must be at most 120 characters/, body: sheetBody(rows1(), { title: "t".repeat(121) }), field: "title", noDatabaseRead: true },
      { label: "an 81-character prepared-by", status: 400, message: /^Prepared by must be at most 80 characters/, body: sheetBody(rows1(), { preparedBy: "p".repeat(81) }), field: "preparedBy", noDatabaseRead: true },
      { label: "1,001 characters of notes", status: 400, message: /^Notes must be at most 1000 characters/, body: sheetBody(rows1(), { notes: "n".repeat(1001) }), field: "notes", noDatabaseRead: true },
      { label: "a numeric title", status: 400, message: /^Title must be text/, body: sheetBody(rows1(), { title: 5 }), field: "title", noDatabaseRead: true },
      { label: "a numeric prepared-by", status: 400, message: /^Prepared by must be text/, body: sheetBody(rows1(), { preparedBy: 5 }), field: "preparedBy", noDatabaseRead: true },
      { label: "a numeric notes", status: 400, message: /^Notes must be text/, body: sheetBody(rows1(), { notes: 5 }), field: "notes", noDatabaseRead: true },
      { label: "a text show-on-hand flag", status: 400, message: /^Show on-hand must be true or false/, body: sheetBody(rows1(), { showOnHand: "yes" }), field: "showOnHand", noDatabaseRead: true },
      { label: "a null show-barcode flag", status: 400, message: /^Show barcode must be true or false/, body: sheetBody(rows1(), { showBarcode: null }), field: "showBarcode", noDatabaseRead: true },
      { label: "a body over 262,144 characters", status: 413, message: /too large to export/i, raw: `{"notes":"${"x".repeat(262_200)}"}`, noDatabaseRead: true },
      {
        label: "an item that is no longer in the inventory",
        status: 422,
        message: /^1 item on the order sheet is no longer in the inventory\. Remove it from the sheet and export again\./,
        body: sheetBody([{ id: 100 }, { id: 424242 }]),
      },
      {
        label: "items that the database hides (no read policy: it answers with no rows)",
        status: 422,
        message: /^1 item on the order sheet is no longer in the inventory\. Remove it from the sheet and export again\./,
        body: sheetBody([{ id: 100 }]),
        prepare: (f) => f.setRls("medications", { select: false, insert: true, update: true, delete: true }),
      },
      {
        label: "an unreachable database",
        status: 503,
        message: /^Can.t reach the database\. Check the internet connection and try again in a minute\./,
        body: sheetBody([{ id: 100 }]),
        prepare: (f) => f.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "medications" }),
      },
      {
        label: "a rejected API key",
        status: 500,
        message: /^The app.s connection to the database was refused, so the app cannot read anything right now\./,
        body: sheetBody([{ id: 100 }]),
        prepare: (f) => f.failNext({ code: "PGRST301", message: "JWT expired" }, { table: "medications" }),
      },
      {
        label: "a missing table privilege",
        status: 403,
        message: /^The app does not have permission to read this data\./,
        body: sheetBody([{ id: 100 }]),
        prepare: (f) => f.failNext({ code: "42501", message: "permission denied for table medications" }, { table: "medications" }),
      },
      {
        label: "an unexpected database error",
        status: 500,
        message: /^Something went wrong while reading from the database\./,
        body: sheetBody([{ id: 100 }]),
        prepare: (f) => f.failNext({ code: "XX000", message: "internal error" }, { table: "medications" }),
      },
      {
        label: "a database client that throws",
        status: 500,
        message: /^Something went wrong while reading from the database\./,
        body: sheetBody([{ id: 100 }]),
        prepare: (f) =>
          f.onCall(() => {
            throw new Error("socket hang up");
          }),
      },
    ];

    it.each(failures)("answers $label with $status and a JSON message that says what is wrong, leaving the database untouched", async (failure) => {
      failure.prepare?.(fake);
      const before = snapshotDb(fake);
      fake.clearCalls();
      const res = failure.raw !== undefined ? await rawExport(failure.raw) : await api.exportXlsx(failure.body ?? {});
      expect(res.status).toBe(failure.status);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expect(res.headers.get("content-disposition")).toBeNull();
      const body = asRecord(await res.json());
      const text = errorTextOf(body);
      expect(text).toMatch(failure.message); // staff read this on the page: it must name the problem, not just say "invalid"
      expect(text).not.toMatch(/undefined|\[object Object\]|NaN/); // a template that lost its value
      if (failure.field !== undefined) expect(body.field).toBe(failure.field);
      if (failure.noDatabaseRead) expect(fake.calls).toEqual([]);
      expectOnlyMedicationReads(fake);
      expect(snapshotDb(fake)).toEqual(before);
    });

    it.each([
      ["a quantity", { id: 102, qty: "abc" }, /^Row 3: Order quantity must be a whole number/],
      ["an item id", { id: "abc" }, /^Row 3 has an invalid item id/],
      ["an order unit", { id: 102, unit: "u".repeat(41) }, /^Row 3: order unit must be at most 40 characters/],
    ])("says WHICH row is wrong when %s on the third row is invalid, so staff can find it on a long sheet", async (_label, badRow, message) => {
      const res = await api.exportXlsx(sheetBody([{ id: 100 }, { id: 101 }, badRow]));
      expect(res.status).toBe(400);
      expect(errorTextOf(await res.json())).toMatch(message);
    });

    it("lists every missing id, in request order and once each, in a 422 that says how many items are gone", async () => {
      const here = itemNamed(medications, "Acetaminophen 500 mg").id;
      const res = await api.exportXlsx(sheetBody([{ id: 424242 }, { id: here }, { id: 111111 }, { id: 424242 }, { id: 222222 }]));
      expect(res.status).toBe(422);
      const body = await bodyRecord(res);
      expect(body.missingIds).toEqual([424242, 111111, 222222]);
      expect(errorTextOf(body)).toMatch(/^3 items on the order sheet are no longer in the inventory/);
      expectOnlyMedicationReads(fake);
    });

    it("says '1 item ... is no longer' for a single missing item", async () => {
      const res = await api.exportXlsx(sheetBody([{ id: 424242 }]));
      expect(res.status).toBe(422);
      expect(errorTextOf(await res.json())).toMatch(/^1 item on the order sheet is no longer in the inventory/);
    });

    it("produces no file for a partly missing sheet: a 422 with JSON, never a workbook that silently omits the missing items", async () => {
      const here = itemNamed(medications, "Acetaminophen 500 mg").id;
      const res = await api.exportXlsx(sheetBody([{ id: here }, { id: 424242 }]));
      expect(res.status).toBe(422);
      expect(res.headers.get("content-type")).toMatch(/json/);
      expect(isRecord(await res.json())).toBe(true);
    });

    it("answers 422 when an item on the sheet is deleted after the sheet was built", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      expect((await api.exportXlsx(sheetBody([{ id: item.id }]))).status).toBe(200);
      expect((await api.deleteItem(item.id)).status).toBe(200);
      fake.clearCalls();
      const res = await api.exportXlsx(sheetBody([{ id: item.id }]));
      expect(res.status).toBe(422);
      expect((await bodyRecord(res)).missingIds).toEqual([item.id]);
      expectOnlyMedicationReads(fake);
    });

    it("fails the whole export (no partial file) when the second chunk of a long sheet cannot be read", async () => {
      const fresh = installFake(options);
      fresh.seedCategories(buildCategories(shape));
      const bulk = buildManyMedications(450, shape);
      fresh.seedMedications(bulk);
      let reads = 0;
      fresh.onCall((call) => {
        if (call.op === "select" && call.table === "medications" && ++reads === 2) {
          fresh.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "medications" });
        }
      });
      const res = await api.exportXlsx(sheetBody(bulk.map((m) => ({ id: m.id }))));
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toMatch(/json/);
      expectOnlyMedicationReads(fresh);
    });

    it("rejects the request body before reading it all when it is oversize (413 says so)", async () => {
      const res = await rawExport(`{"notes":"${"x".repeat(300_000)}"}`);
      expect(res.status).toBe(413);
      expect(errorTextOf(await res.json())).toMatch(/too large/i);
    });
  });

  describe("accepts what staff actually type", () => {
    it.each([
      ["a plain number", "12", 200],
      ["a number with surrounding spaces", "  12  ", 200],
      ["a number with leading zeros (they are dropped)", "007", 200],
      ["a blank quantity (staff fill it in by hand after printing)", "", 200],
      ["the largest allowed quantity", "999999999", 200],
    ])("accepts %s as the order quantity", async (_label, qty, status) => {
      const res = await api.exportXlsx(sheetBody([{ id: itemNamed(medications, "Acetaminophen 500 mg").id, qty }]));
      expect(res.status).toBe(status);
    });

    it("accepts rows without qty and unit at all, with null values, and with a unit containing line breaks (they become spaces)", async () => {
      const id = itemNamed(medications, "Acetaminophen 500 mg").id;
      expect((await api.exportXlsx(sheetBody([{ id }]))).status).toBe(200);
      expect((await api.exportXlsx(sheetBody([{ id, qty: null, unit: null }]))).status).toBe(200);
      expect((await api.exportXlsx(sheetBody([{ id, qty: "1", unit: "box\nof\r\n10" }]))).status).toBe(200);
    });

    it("accepts the longest title, prepared-by and notes counted in characters (emoji count once)", async () => {
      const id = itemNamed(medications, "Acetaminophen 500 mg").id;
      const res = await api.exportXlsx(
        sheetBody([{ id }], { title: "\u{1F48A}".repeat(120), preparedBy: "\u{1F48A}".repeat(80), notes: "\u{1F48A}".repeat(1000) })
      );
      expect(res.status).toBe(200);
    });

    it("accepts a request without title, prepared-by and notes (they default to empty)", async () => {
      const id = itemNamed(medications, "Acetaminophen 500 mg").id;
      const res = await api.exportXlsx({ date: "2026-11-05", rows: [{ id }] });
      expect(res.status).toBe(200);
    });
  });
});

// A guard that cannot fail proves nothing, so the guard used above is itself tested: each way of reaching another machine
// must be noticed. (http and https are what a route would use to bypass a check that only watches fetch.)
describe("the network guard used by the export tests really notices an outbound connection", () => {
  it("stays quiet when nothing is sent", async () => {
    const network = watchNetwork();
    await network.assertQuiet();
  });

  it("notices a call to fetch", async () => {
    const network = watchNetwork();
    await expect(fetch("http://127.0.0.1:9/never-sent")).rejects.toThrow(/blocked/);
    await expect(network.assertQuiet()).rejects.toThrow(/fetch was called/);
  });

  it("notices a request made through node:https", async () => {
    const network = watchNetwork();
    const request = https.request({ host: "127.0.0.1", port: 9, method: "POST", path: "/upload" }, () => undefined);
    request.on("error", () => undefined);
    request.end("x");
    request.destroy();
    await expect(network.assertQuiet()).rejects.toThrow(/connection was attempted/);
  });

  it("notices a request made through node:http", async () => {
    const network = watchNetwork();
    const request = http.request({ host: "127.0.0.1", port: 9, method: "POST", path: "/upload" }, () => undefined);
    request.on("error", () => undefined);
    request.end("x");
    request.destroy();
    await expect(network.assertQuiet()).rejects.toThrow(/connection was attempted/);
  });

  it("notices a raw node:net connection", async () => {
    const network = watchNetwork();
    const socket = net.connect(9, "127.0.0.1");
    socket.on("error", () => undefined);
    socket.destroy();
    await expect(network.assertQuiet()).rejects.toThrow(/connection was attempted/);
  });
});

// PostgREST answers at most `db-max-rows` rows per request and says nothing when it cuts an answer short (Supabase's usual
// value is 1000; this project's real value is not confirmed). The inventory LIST copes with a cap (medications-list.test.ts).
// The export reads the items it needs 200 ids at a time and treats every id missing from an answer as "deleted", so with a
// cap BELOW 200 it reports items that exist as "no longer in the inventory" (422) and the sheet cannot be exported at all.
// The cases whose cap is below the 200-id read size need readMedications to ask again for the ids that did not come back
// (trusting the first answer would report items that exist as missing). The cases with a very small cap need many
// repeats, so a retry that happens only once would still fail them. The control cases pin the boundary where a single read
// suffices.
describe.each(ID_SHAPES)("export when the database returns at most N rows per read, on the $label", ({ options, shape }) => {
  function seedItems(maxRows: number, count: number): { fake: FakeSupabase; items: Medication[] } {
    const fake = installFake({ ...options, maxRows });
    fake.seedCategories(buildCategories(shape));
    const items = buildManyMedications(count, shape);
    fake.seedMedications(items);
    return { fake, items };
  }

  async function expectFileWithEveryItem(res: Response, items: readonly Medication[]): Promise<void> {
    const answer = res.status === 200 ? "" : await res.clone().text();
    expect(res.status, `the export answered ${res.status} instead of a file: ${answer.slice(0, 240)}`).toBe(200);
    const rows = readXlsx(new Uint8Array(await res.arrayBuffer())).sheet("Order sheet").table().rows;
    expect(rows.map((row) => row.Item?.text)).toEqual(items.map((item) => item.name));
  }

  it.each([
    ["100 rows", 100, 150],
    ["199 rows (one below the 200-id read size)", 199, 200],
    ["40 rows (four reads are needed for 150 items)", 40, 150],
    ["1 row (one read per item)", 1, 25],
  ])("exports every item on the sheet when the database returns at most %s per read (never 'no longer in the inventory' for items that exist)", async (_label, maxRows, count) => {
    const { fake, items } = seedItems(maxRows, count);
    const res = await api.exportXlsx(sheetBody(items.map((item) => ({ id: item.id }))));
    await expectFileWithEveryItem(res, items);
    expectOnlyMedicationReads(fake);
  });

  it("names only the item that is really gone when some items are missing and the database caps its reads (it must not call 50 existing items deleted)", async () => {
    const { items } = seedItems(100, 150);
    const res = await api.exportXlsx(sheetBody([...items.map((item) => ({ id: item.id })), { id: 424242 }]));
    expect(res.status).toBe(422);
    const named = (await bodyRecord(res)).missingIds;
    const missingIds = Array.isArray(named) ? named : [];
    const existButNamed = missingIds.filter((id) => id !== 424242);
    expect(existButNamed.length, `${existButNamed.length} items that exist were reported as no longer in the inventory (first: ${existButNamed.slice(0, 3).join(", ")})`).toBe(0);
    expect(missingIds).toEqual([424242]);
  });

  it.each([
    ["200 rows (the read size itself)", 200, 450],
    ["1000 rows (Supabase's usual cap)", 1000, 450],
    ["100 rows, with exactly 100 items on the sheet", 100, 100],
  ])("exports every item when the database returns at most %s per read", async (_label, maxRows, count) => {
    const { fake, items } = seedItems(maxRows, count);
    const res = await api.exportXlsx(sheetBody(items.map((item) => ({ id: item.id }))));
    await expectFileWithEveryItem(res, items);
    expectOnlyMedicationReads(fake);
  });
});

describe("when the workbook cannot be built", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/order-sheet/xlsx");
    vi.resetModules();
  });

  it("answers 500 with a JSON message that points to Print / Save as PDF, and writes nothing", async () => {
    const fake = installFake({ categoryIdType: "uuid" });
    const { medications } = seedStandard(fake);
    const before = snapshotDb(fake);

    vi.resetModules();
    vi.doMock("@/lib/order-sheet/xlsx", () => ({
      buildOrderSheetXlsx: async () => {
        throw new Error("zip writer exploded");
      },
    }));
    const { POST } = await import("@/app/api/order-sheet/xlsx/route");
    const res = await POST(
      new NextRequest("http://localhost/api/order-sheet/xlsx", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sheetBody([{ id: medications[0].id }])),
      })
    );

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/json/);
    const text = errorTextOf(await res.json());
    expect(text).toMatch(/Excel file/);
    expect(text).toMatch(/Print/);
    expect(text).not.toMatch(/exploded/); // internals are not shown to staff
    expectOnlyMedicationReads(fake);
    expect(snapshotDb(fake)).toEqual(before);
  });
});

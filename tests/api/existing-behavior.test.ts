// Regression tests for the routes that must keep working as they are: /api/transactions, /api/analytics, /api/import and
// /api/upload. Requirement: stock adjustments, usage history, analytics and existing reports are not broken.
//
// These tests pin what those routes do TODAY, so a regression would show. They are characterization tests: where today's
// behavior is plainly unfortunate (for example a fractional quantity ends in a 500) the test says "documents" and only
// pins the safe part (nothing changed). Both id shapes are exercised where item rows (with their category id) are returned.
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Medication } from "@/lib/db";
import { asRecord, asRecordList, bodyList, bodyRecord, errorTextOf, ID_SHAPES, itemNamed, snapshotDb, storedMedication } from "../helpers/api-test-kit";
import { installFake, type FakeSupabase } from "../helpers/fake-supabase";
import { jsonRequest, seedStandard } from "../helpers/fixtures-extra";
import { api } from "../helpers/route-client";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

import { GET as analyticsGet } from "@/app/api/analytics/route";
import { POST as importPost } from "@/app/api/import/route";
import { GET as transactionsGet, POST as transactionsPost } from "@/app/api/transactions/route";
import { POST as uploadPost } from "@/app/api/upload/route";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const record = (medicationId: unknown, type: unknown, quantity: unknown, note?: unknown): Promise<Response> =>
  transactionsPost(jsonRequest("POST", "/api/transactions", { medication_id: medicationId, type, quantity, note }));

describe.each(ID_SHAPES)("stock adjustments: POST /api/transactions on the $label", ({ options }) => {
  let fake: FakeSupabase;
  let medications: Medication[];
  let item: Medication; // Acetaminophen 500 mg: stock 120
  beforeEach(() => {
    fake = installFake(options);
    ({ medications } = seedStandard(fake));
    item = itemNamed(medications, "Acetaminophen 500 mg");
  });

  it("receiving adds to stock: 201, the updated item comes back, and one 'receive' transaction is recorded with its note", async () => {
    const res = await record(item.id, "receive", 30, "Delivery from supplier");
    expect(res.status).toBe(201);
    expect(await bodyRecord(res)).toMatchObject({ id: item.id, stock: 150 });
    expect(storedMedication(fake, item.id).stock).toBe(150);
    const transactions = fake.dump("transactions");
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({ medication_id: item.id, type: "receive", quantity: 30, note: "Delivery from supplier" });
  });

  it("dispensing subtracts from stock and records a 'dispense' transaction", async () => {
    const res = await record(item.id, "dispense", 20);
    expect(res.status).toBe(201);
    expect((await bodyRecord(res)).stock).toBe(100);
    expect(fake.dump("transactions")[0]).toMatchObject({ medication_id: item.id, type: "dispense", quantity: 20, note: null });
  });

  it("allows dispensing exactly the stock on hand (stock becomes 0)", async () => {
    expect((await record(item.id, "dispense", 120)).status).toBe(201);
    expect(storedMedication(fake, item.id).stock).toBe(0);
  });

  it("refuses to dispense more than the stock on hand: 400 'Insufficient stock', stock and history unchanged", async () => {
    const before = snapshotDb(fake);
    const res = await record(item.id, "dispense", 121);
    expect(res.status).toBe(400);
    expect(errorTextOf(await res.json())).toBe("Insufficient stock. Current stock: 120");
    expect(snapshotDb(fake)).toEqual(before);
  });

  it("refuses an item that does not exist with 400 and a 'not found' message, and records nothing", async () => {
    const before = snapshotDb(fake);
    const res = await record(987654, "receive", 5);
    expect(res.status).toBe(400);
    expect(errorTextOf(await res.json())).toMatch(/not found/i);
    expect(snapshotDb(fake)).toEqual(before);
  });

  it.each([
    ["no item", { type: "receive", quantity: 1 }, "medication_id, type, and quantity are required"],
    ["no type", { medication_id: 100, quantity: 1 }, "medication_id, type, and quantity are required"],
    ["no quantity", { medication_id: 100, type: "receive" }, "medication_id, type, and quantity are required"],
    ["a quantity of zero", { medication_id: 100, type: "receive", quantity: 0 }, "medication_id, type, and quantity are required"],
    ["an unknown type", { medication_id: 100, type: "discard", quantity: 1 }, "type must be receive or dispense"],
    ["a negative quantity", { medication_id: 100, type: "dispense", quantity: -3 }, "quantity must be positive"],
  ])("rejects %s with 400 and changes nothing", async (_label, payload, message) => {
    const before = snapshotDb(fake);
    const res = await transactionsPost(jsonRequest("POST", "/api/transactions", payload));
    expect(res.status).toBe(400);
    expect(errorTextOf(await res.json())).toBe(message);
    expect(snapshotDb(fake)).toEqual(before);
    expect(fake.writes()).toEqual([]);
  });

  it("documents that a fractional quantity is not accepted by the database function: not a success, and stock is unchanged", async () => {
    const before = snapshotDb(fake);
    const res = await record(item.id, "dispense", 1.5);
    expect(res.ok).toBe(false);
    expect(snapshotDb(fake)).toEqual(before);
  });

  it("answers 500 'Failed to record transaction' and changes nothing when the database call fails (the change is all-or-nothing)", async () => {
    const before = snapshotDb(fake);
    fake.failNext({ code: "", message: "TypeError: fetch failed" }, { fn: "record_transaction" });
    const res = await record(item.id, "receive", 5);
    expect(res.status).toBe(500);
    expect(errorTextOf(await res.json())).toBe("Failed to record transaction");
    expect(snapshotDb(fake)).toEqual(before);
  });

  it("sends the database function exactly the item id (as a number), the type, the quantity and the note (null when empty)", async () => {
    await record(String(item.id), "receive", 4, "");
    const call = fake.writes().find((c) => c.op === "rpc");
    expect(call?.fn).toBe("record_transaction");
    expect(call?.payload).toEqual({ p_medication_id: item.id, p_type: "receive", p_quantity: 4, p_note: null });
  });

  it("accepts the exact payloads the Scan tab and kiosk send (item id as a number, quantity 1, no note)", async () => {
    expect((await transactionsPost(jsonRequest("POST", "/api/transactions", { medication_id: item.id, type: "dispense", quantity: 1 }))).status).toBe(201);
    expect((await transactionsPost(jsonRequest("POST", "/api/transactions", { medication_id: item.id, type: "receive", quantity: 5, note: "typed note" }))).status).toBe(201);
    expect(storedMedication(fake, item.id).stock).toBe(124);
  });

  it("changes only stock: the item's category, supplier order number, name and barcode stay as they were", async () => {
    const before = await bodyRecord(await api.getItem(item.id));
    expect((await record(item.id, "dispense", 7)).status).toBe(201);
    const after = await bodyRecord(await api.getItem(item.id));
    const { stock: _s, updated_at: _u, ...beforeRest } = before;
    const { stock: _s2, updated_at: _u2, ...afterRest } = after;
    void [_s, _u, _s2, _u2];
    expect(afterRest).toEqual(beforeRest);
    expect(after.stock).toBe(113);
  });

  it("keeps a running balance across several adjustments, and the balance matches the sum of the recorded history", async () => {
    await record(item.id, "dispense", 10);
    await record(item.id, "receive", 25);
    await record(item.id, "dispense", 5);
    expect(storedMedication(fake, item.id).stock).toBe(130);
    const history = fake.dump("transactions").filter((t) => t.medication_id === item.id);
    const net = history.reduce((sum, t) => sum + (t.type === "receive" ? 1 : -1) * (t.quantity as number), 0);
    expect(120 + net).toBe(130);
  });
});

describe.each(ID_SHAPES)("usage history: GET /api/transactions on the $label", ({ options }) => {
  let fake: FakeSupabase;
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake(options);
    ({ medications } = seedStandard(fake, { withTransactions: true }));
  });

  it("returns one item's history newest first with the item name and unit flattened in (and no nested 'medications' key)", async () => {
    const item = medications[0];
    const res = await transactionsGet(jsonRequest("GET", `/api/transactions?medicationId=${item.id}`));
    expect(res.status).toBe(200);
    const rows = asRecordList(await res.json());
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.type)).toEqual(["dispense", "receive"]); // yesterday before five days ago
    for (const row of rows) {
      expect(row).toMatchObject({ medication_id: item.id, medication_name: item.name, unit: "units" });
      expect(row).not.toHaveProperty("medications");
    }
  });

  it("returns recent history across all items for the last 30 days by default, newest first", async () => {
    const rows = asRecordList(await (await transactionsGet(jsonRequest("GET", "/api/transactions"))).json());
    expect(rows).toHaveLength(12);
    const times = rows.map((r) => Date.parse(String(r.created_at)));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("limits history to the requested number of days (days=3 keeps yesterday's dispenses and drops the older receives)", async () => {
    const rows = asRecordList(await (await transactionsGet(jsonRequest("GET", "/api/transactions?days=3"))).json());
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row.type).toBe("dispense");
  });

  it("answers an item without history with an empty list", async () => {
    const quiet = medications[10];
    const res = await transactionsGet(jsonRequest("GET", `/api/transactions?medicationId=${quiet.id}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("answers 500 'Failed to fetch transactions' when the database fails (never an empty history)", async () => {
    fake.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "transactions" });
    const res = await transactionsGet(jsonRequest("GET", "/api/transactions"));
    expect(res.status).toBe(500);
    expect(errorTextOf(await res.json())).toBe("Failed to fetch transactions");
  });

  it("keeps the history of items intact when other items are edited or categorized (usage history is never rewritten)", async () => {
    const before = fake.dump("transactions");
    const item = itemNamed(medications, "Thermometer probe covers");
    await api.updateItem(item.id, { stock: 1, supplier_order_number: "T-1" });
    await api.updateItem(medications[0].id, { category_id: null, name: "Renamed" });
    expect(fake.dump("transactions")).toEqual(before);
  });
});

describe.each(ID_SHAPES)("analytics: GET /api/analytics on the $label", ({ options }) => {
  let fake: FakeSupabase;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T12:00:00.000Z"));
    fake = installFake(options);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** One item with stock 120 / threshold 40 that dispensed 30 units over the last 30 days: a rate of exactly 1 per day. */
  function seedBusyItem(): void {
    fake.seedMedications([
      { id: 1, barcode: "BUSY-1", name: "Busy item", stock: 120, threshold: 40 },
      { id: 2, barcode: "QUIET-1", name: "Quiet item", stock: 50, threshold: 10 },
      { id: 3, barcode: "AAA-1", name: "Another quiet item", stock: 5, threshold: 10 },
    ]);
    fake.seedTransactions([
      { medication_id: 1, type: "dispense", quantity: 10, created_at: "2026-11-04T09:00:00.000Z" },
      { medication_id: 1, type: "dispense", quantity: 20, created_at: "2026-10-20T09:00:00.000Z" },
      { medication_id: 1, type: "receive", quantity: 100, created_at: "2026-10-10T09:00:00.000Z" },
      { medication_id: 1, type: "dispense", quantity: 999, created_at: "2026-08-01T09:00:00.000Z" }, // outside the 30-day window
    ]);
  }

  it("reports totals, daily rate and the reorder estimate for a 30-day window exactly as before", async () => {
    seedBusyItem();
    const res = await analyticsGet(jsonRequest("GET", "/api/analytics"));
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    expect(body.days).toBe(30);
    const dates = body.date_range as string[];
    expect(dates).toHaveLength(30);
    expect(dates[dates.length - 1]).toBe("2026-11-05");
    expect(dates[0]).toBe("2026-10-07");
    const busy = asRecordList(body.medications).find((m) => m.id === 1);
    expect(busy).toMatchObject({
      name: "Busy item",
      barcode: "BUSY-1",
      unit: "units",
      current_stock: 120,
      threshold: 40,
      total_dispensed: 30,
      total_received: 100,
      daily_rate: 1,
      days_until_threshold: 80,
      days_until_empty: 120,
      reorder_date: "2027-01-24",
    });
    expect((busy?.daily as unknown[]).length).toBe(30);
  });

  it("gives items that were never dispensed no estimate (null), not a guess", async () => {
    seedBusyItem();
    const body = asRecord(await (await analyticsGet(jsonRequest("GET", "/api/analytics"))).json());
    const quiet = asRecordList(body.medications).find((m) => m.id === 2);
    expect(quiet).toMatchObject({ total_dispensed: 0, total_received: 0, daily_rate: 0, days_until_threshold: null, days_until_empty: null, reorder_date: null });
  });

  it("lists items with an estimate first (soonest to reach the threshold first), then the others by name", async () => {
    seedBusyItem();
    const body = asRecord(await (await analyticsGet(jsonRequest("GET", "/api/analytics"))).json());
    expect(asRecordList(body.medications).map((m) => m.name)).toEqual(["Busy item", "Another quiet item", "Quiet item"]);
  });

  it.each([
    ["is raised to 7 when smaller", "?days=1", 7],
    ["is lowered to 180 when larger", "?days=999", 180],
    ["is used as given inside the range", "?days=14", 14],
  ])("keeps the window within 7 to 180 days: a request of days %s", async (_label, query, expected) => {
    seedBusyItem();
    const body = asRecord(await (await analyticsGet(jsonRequest("GET", `/api/analytics${query}`))).json());
    expect(body.days).toBe(expected);
    expect(body.date_range as unknown[]).toHaveLength(expected);
  });

  it("reads only the columns it always read, so it keeps working before the supplier column exists, and writes nothing", async () => {
    seedBusyItem();
    await analyticsGet(jsonRequest("GET", "/api/analytics"));
    const read = fake.callsFor("medications")[0];
    expect(read.select?.replace(/\s/g, "")).toBe("id,name,barcode,unit,stock,threshold,category_id,is_unnamed");
    expect(fake.writes()).toEqual([]);
  });

  it("passes each item's category id through exactly as the database stores it (a uuid string or a bigint number), unchanged by this work", async () => {
    const seeded = seedStandard(fake);
    const body = asRecord(await (await analyticsGet(jsonRequest("GET", "/api/analytics"))).json());
    const stored = new Map(fake.dump("medications").map((m) => [m.id, m.category_id]));
    const entries = asRecordList(body.medications);
    expect(entries).toHaveLength(seeded.medications.length);
    for (const entry of entries) expect(entry.category_id).toEqual(stored.get(entry.id));
    expect(entries.some((m) => m.category_id !== null)).toBe(true);
  });

  it("answers 500 'Failed to fetch analytics' when the database fails", async () => {
    seedBusyItem();
    fake.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "medications" });
    const res = await analyticsGet(jsonRequest("GET", "/api/analytics"));
    expect(res.status).toBe(500);
    expect(errorTextOf(await res.json())).toBe("Failed to fetch analytics");
  });
});

describe.each(ID_SHAPES)("CSV import: POST /api/import on the $label", ({ options }) => {
  let fake: FakeSupabase;
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake(options);
    ({ medications } = seedStandard(fake));
  });

  const upload = (csv: string): Promise<Response> => importPost(new NextRequest("http://localhost/api/import", { method: "POST", body: csv }));
  const HEADER = "name,barcode,stock,threshold,unit,vendor_url,notes";

  it("adds new items from a CSV and reports how many were inserted", async () => {
    const res = await upload(`${HEADER}\nSaline flush 10 mL,0049000011111,40,12,box,https://example.invalid/v,Keep cool\nBandage roll,BND-ROLL,7,5,,,\n`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 2, updated: 0, skipped: 0, skippedDetails: [] });
    const stored = fake.dump("medications").find((m) => m.barcode === "0049000011111");
    expect(stored).toMatchObject({ name: "Saline flush 10 mL", stock: 40, threshold: 12, unit: "box", vendor_url: "https://example.invalid/v", notes: "Keep cool", category_id: null });
    expect(fake.dump("medications").find((m) => m.barcode === "BND-ROLL")).toMatchObject({ unit: "units", vendor_url: null, notes: null });
  });

  it("keeps leading zeros in barcodes (they are text) and handles commas, quotes and line breaks inside quoted fields", async () => {
    const res = await upload(`${HEADER}\n"Gauze pads 4""x4"", sterile",0000123400,10,5,units,,"Line one\nLine two"\n`);
    expect(res.status).toBe(200);
    const stored = fake.dump("medications").find((m) => m.barcode === "0000123400");
    expect(stored).toMatchObject({ name: 'Gauze pads 4"x4", sterile', notes: "Line one\nLine two" });
  });

  it("accepts header names in any case and with spaces (Name, Barcode, Vendor URL)", async () => {
    const res = await upload("Name,Barcode,Stock,Threshold,Unit,Vendor URL,Notes\nWidget,WID-1,3,2,pcs,https://example.invalid/w,n\n");
    expect(res.status).toBe(200);
    expect(fake.dump("medications").find((m) => m.barcode === "WID-1")).toMatchObject({ name: "Widget", vendor_url: "https://example.invalid/w" });
  });

  it("updates an existing item found by barcode (counted as updated) and replaces its stock and CSV fields", async () => {
    const existing = itemNamed(medications, "Naproxen 220 mg");
    const res = await upload(`${HEADER}\nNaproxen 220 mg tablets (new label),${existing.barcode},77,15,units,,\n`);
    expect(await res.json()).toMatchObject({ inserted: 0, updated: 1 });
    expect(storedMedication(fake, existing.id)).toMatchObject({ name: "Naproxen 220 mg tablets (new label)", stock: 77, threshold: 15 });
  });

  it("keeps an existing item's category, supplier order number and photo when a CSV row updates it (the import never sends those columns)", async () => {
    const existing = itemNamed(medications, "Acetaminophen 500 mg");
    expect(existing.category_id).not.toBeNull();
    expect(existing.supplier_order_number).toBe("00417-B");
    const res = await upload(`${HEADER}\nAcetaminophen 500 mg tablets,${existing.barcode},120,40,units,,\n`);
    expect(res.status).toBe(200);
    const stored = storedMedication(fake, existing.id);
    expect(String(stored.category_id)).toBe(existing.category_id);
    expect(stored.supplier_order_number).toBe("00417-B");
    const payload = asRecordList(fake.writes()[0].payload);
    expect(Object.keys(payload[0]).sort()).toEqual(["barcode", "name", "notes", "stock", "threshold", "unit", "vendor_url"]);
  });

  it("documents that CSV import of supplier order numbers is not built: a supplier_order_number column is ignored, and an existing item keeps the number it has", async () => {
    const existing = itemNamed(medications, "Acetaminophen 500 mg");
    const res = await upload(`name,barcode,stock,supplier_order_number\nAcetaminophen 500 mg tablets,${existing.barcode},120,CSV-OVERWRITE\nNew imported item,IMP-SUP-1,3,CSV-NEW\n`);
    expect(res.status).toBe(200);
    expect(storedMedication(fake, existing.id).supplier_order_number).toBe("00417-B");
    expect(fake.dump("medications").find((m) => m.barcode === "IMP-SUP-1")?.supplier_order_number).toBeNull();
    for (const row of asRecordList(fake.writes()[0].payload)) expect(Object.keys(row)).not.toContain("supplier_order_number");
  });

  it("documents a PRE-EXISTING hazard of the unchanged import route: a blank stock or threshold cell in a re-imported CSV sets that item's stock and threshold to 0, with HTTP 200 and no warning", async () => {
    // Number("") is 0, so an empty cell is read as the number zero rather than 'not provided'. No page in the app calls
    // /api/import (only direct HTTP calls reach it) and the route is deliberately left unchanged, so this is pinned, not fixed.
    // If someone fixes it on purpose, change this test together with the route.
    const existing = itemNamed(medications, "Acetaminophen 500 mg"); // stock 120, threshold 40
    const res = await upload(`name,barcode,stock,threshold\nAcetaminophen renamed,${existing.barcode},,\n`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ inserted: 0, updated: 1 });
    expect(storedMedication(fake, existing.id)).toMatchObject({ name: "Acetaminophen renamed", stock: 0, threshold: 0 });
  });

  it("skips rows that lack a name or a barcode and says which, importing the rest", async () => {
    const res = await upload(`${HEADER}\n,NO-NAME-1,1,1,,,\nNo barcode,,1,1,,,\nGood row,GOOD-1,1,1,,,\n`);
    const body = asRecord(await res.json());
    expect(body).toMatchObject({ inserted: 1, updated: 0, skipped: 2 });
    expect((body.skippedDetails as string[]).length).toBe(2);
    expect(fake.dump("medications").some((m) => m.barcode === "GOOD-1")).toBe(true);
  });

  it("touches the database not at all when every row is skipped", async () => {
    const res = await upload(`${HEADER}\n,A,1,1,,,\nB,,1,1,,,\n`);
    expect(await res.json()).toMatchObject({ inserted: 0, updated: 0, skipped: 2 });
    expect(fake.calls).toEqual([]);
  });

  it("rejects a malformed CSV with 400 'CSV parse error' and writes nothing", async () => {
    const res = await upload(`${HEADER}\n"unterminated,quote,1,1,,,\n`);
    expect(res.status).toBe(400);
    expect(errorTextOf(await res.json())).toBe("CSV parse error");
    expect(fake.writes()).toEqual([]);
  });

  it("fails the whole import (500 'Import failed') and stores nothing when one row has a non-numeric stock (all or nothing)", async () => {
    const before = snapshotDb(fake);
    const res = await upload(`${HEADER}\nFine row,FINE-1,5,2,,,\nBroken row,BROKEN-1,lots,2,,,\n`);
    expect(res.status).toBe(500);
    expect(errorTextOf(await res.json())).toBe("Import failed");
    expect(snapshotDb(fake)).toEqual(before);
  });

  it("answers 500 'Import failed' when the database can't be reached", async () => {
    fake.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "medications", op: "upsert" });
    const res = await upload(`${HEADER}\nWidget,WID-9,3,2,pcs,,\n`);
    expect(res.status).toBe(500);
    expect(errorTextOf(await res.json())).toBe("Import failed");
  });

  it("lists items imported with a category still absent as uncategorized in every view (imports never invent categories)", async () => {
    await upload(`${HEADER}\nImported item,IMP-1,3,2,,,\n`);
    const none = await bodyList(await api.listItems("?category=none"));
    expect(none.some((m) => m.barcode === "IMP-1")).toBe(true);
  });
});

describe("photo upload: POST /api/upload", () => {
  let fake: FakeSupabase;
  beforeEach(() => {
    fake = installFake({ categoryIdType: "uuid" });
  });

  const send = (file: File | null): Promise<Response> => {
    const form = new FormData();
    if (file) form.append("file", file);
    return uploadPost(new NextRequest("http://localhost/api/upload", { method: "POST", body: form }));
  };

  it("stores an image in the medication-photos bucket and returns its public URL", async () => {
    const res = await send(new File([new Uint8Array([1, 2, 3, 4])], "pill.PNG", { type: "image/png" }));
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    expect(String(body.url)).toMatch(/medication-photos\/\d+-[a-z0-9]+\.png$/);
    expect(fake.uploads()).toHaveLength(1);
    expect(fake.uploads()[0]).toMatchObject({ bucket: "medication-photos", contentType: "image/png", size: 4 });
  });

  it("rejects a request without a file with 400", async () => {
    const res = await send(null);
    expect(res.status).toBe(400);
    expect(errorTextOf(await res.json())).toBe("No file uploaded");
    expect(fake.uploads()).toEqual([]);
  });

  it("rejects a file that is not an image with 400", async () => {
    const res = await send(new File(["hello"], "notes.txt", { type: "text/plain" }));
    expect(res.status).toBe(400);
    expect(errorTextOf(await res.json())).toBe("File must be an image");
    expect(fake.uploads()).toEqual([]);
  });

  it("rejects an image over 5 MB with 400", async () => {
    const res = await send(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.jpg", { type: "image/jpeg" }));
    expect(res.status).toBe(400);
    expect(errorTextOf(await res.json())).toMatch(/too large/i);
    expect(fake.uploads()).toEqual([]);
  });

  it("answers 500 with the storage error text when the storage service fails", async () => {
    fake.failNext({ code: "", message: "bucket unavailable" }, { bucket: "medication-photos" });
    const res = await send(new File([new Uint8Array([1])], "pill.jpg", { type: "image/jpeg" }));
    expect(res.status).toBe(500);
    expect(errorTextOf(await res.json())).toMatch(/^Storage error: bucket unavailable/);
  });
});

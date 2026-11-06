// Requirement-driven tests: GET /api/medications/barcode/[code] (TASK.md "existing barcode scanner previously worked and
// must remain functional", sections 8 and 9; SPEC 2.6).
//
// The Scan tab and /kiosk treat HTTP 404 from this route as "this barcode is not in the inventory" and then CREATE a new
// unnamed item. A 404 sent for any other reason (database down, key rejected, a policy problem) would therefore create
// a duplicate item for a barcode that already exists, so: 404 only when there is genuinely no row.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Category, Medication } from "@/lib/db";
import { bodyRecord, errorTextOf, ID_SHAPES, itemNamed, snapshotDb } from "../helpers/api-test-kit";
import { installFake, LIVE_BEFORE_MIGRATION, type FakeSupabase } from "../helpers/fake-supabase";
import { seedStandard } from "../helpers/fixtures-extra";
import { api } from "../helpers/route-client";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

import * as barcodeRoute from "@/app/api/medications/barcode/[code]/route";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe.each(ID_SHAPES)("GET /api/medications/barcode/[code] on the $label", ({ options }) => {
  let fake: FakeSupabase;
  let categories: Category[];
  let medications: Medication[];
  beforeEach(() => {
    fake = installFake(options);
    ({ categories, medications } = seedStandard(fake));
  });

  describe("finding items", () => {
    it("returns the item for its exact barcode, with its category and supplier order number", async () => {
      const item = itemNamed(medications, "Acetaminophen 500 mg");
      const res = await api.lookup(item.barcode);
      expect(res.status).toBe(200);
      expect(await bodyRecord(res)).toMatchObject({
        id: item.id,
        name: item.name,
        barcode: item.barcode,
        stock: item.stock,
        threshold: item.threshold,
        unit: "units",
        category_id: categories[0].id,
        supplier_order_number: "00417-B",
        is_unnamed: false,
      });
    });

    it("finds every seeded item by its own barcode (numeric with leading zeros, and alphanumeric)", async () => {
      expect(medications.some((m) => m.barcode.startsWith("0"))).toBe(true);
      expect(medications.some((m) => /[A-Za-z]/.test(m.barcode))).toBe(true);
      for (const item of medications) {
        const res = await api.lookup(item.barcode);
        expect(res.status, `barcode ${item.barcode}`).toBe(200);
        expect((await bodyRecord(res)).id).toBe(item.id);
      }
    });

    it("keeps barcodes that differ only by leading zeros apart (0049000028911 is not 49000028911)", async () => {
      fake.seedMedications([
        { id: 801, barcode: "0001234567", name: "With zeros" },
        { id: 802, barcode: "1234567", name: "Without zeros" },
      ]);
      expect((await bodyRecord(await api.lookup("0001234567"))).id).toBe(801);
      expect((await bodyRecord(await api.lookup("1234567"))).id).toBe(802);
    });

    it("finds barcodes containing spaces, slashes, plus signs, percent signs and non-ASCII characters", async () => {
      const odd = ["AB 12", "AB/12", "AB+12", "50%OFF", "100%", "éè-77", "日本-1", "A.B-C_D"];
      fake.seedMedications(odd.map((barcode, index) => ({ id: 900 + index, barcode, name: `Odd ${index}` })));
      for (const [index, barcode] of odd.entries()) {
        const res = await api.lookup(barcode);
        expect(res.status, barcode).toBe(200);
        expect((await bodyRecord(res)).id).toBe(900 + index);
      }
    });

    it("looks up exactly the barcode it receives and decodes nothing further: 'AB%2F12' is a different barcode from 'AB/12'", async () => {
      // Next has already URL-decoded the path parameter once. A second decode would turn a barcode that really contains
      // "%2F" into another one, so a code that arrives as "AB%2F12" is looked up as "AB%2F12" and nothing else.
      fake.seedMedications([{ id: 901, barcode: "AB/12", name: "Slash item" }]);
      expect((await api.lookup("AB%2F12")).status).toBe(404);
      expect((await bodyRecord(await api.lookup("AB/12"))).id).toBe(901);
    });

    it("finds a barcode that really contains a percent escape by itself, and never confuses it with the decoded text ('A%41' is not 'AA')", async () => {
      fake.seedMedications([
        { id: 902, barcode: "A%41", name: "Literal percent code" },
        { id: 903, barcode: "AA", name: "Different item" },
      ]);
      expect((await bodyRecord(await api.lookup("A%41"))).id).toBe(902);
      expect((await bodyRecord(await api.lookup("AA"))).id).toBe(903);
    });

    it("answers 404 for an ABSENT barcode that looks like a percent escape instead of returning a different item (a scan would have changed the wrong item's stock)", async () => {
      fake.seedMedications([{ id: 903, barcode: "AA", name: "Different item" }]);
      const res = await api.lookup("A%41");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Medication not found" });
    });

    it("asks the database for the received barcode once, and only for that barcode", async () => {
      fake.seedMedications([{ id: 903, barcode: "AA", name: "Different item" }]);
      fake.clearCalls();
      await api.lookup("A%41");
      const selects = fake.callsFor("medications").filter((call) => call.op === "select");
      expect(selects).toHaveLength(1);
      expect(selects[0].filters.map((filter) => [filter.column, filter.value])).toEqual([["barcode", "A%41"]]);
    });

    it("treats the barcode as an exact match: wildcard characters match nothing special", async () => {
      for (const probe of ["%", "*", "_", "0%", "ME_-1003", "MED-*"]) {
        const res = await api.lookup(probe);
        expect(res.status, probe).toBe(404);
      }
    });
  });

  describe("404 only when the item is not there", () => {
    it("answers 404 'Medication not found' for a barcode that does not exist", async () => {
      const res = await api.lookup("9999999999999");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Medication not found" });
    });

    it("answers 404 for a barcode that differs only in case (barcodes are exact text)", async () => {
      const alnum = medications.find((m) => /^MED-/.test(m.barcode));
      if (!alnum) throw new Error("fixture has no MED- barcode");
      expect((await api.lookup(alnum.barcode.toLowerCase())).status).toBe(404);
    });

    it("answers 404 (not a 500) for a stray percent sign and for malformed percent-escapes", async () => {
      expect((await api.lookup("100%")).status).toBe(404);
      expect((await api.lookup("%E0%A4%A")).status).toBe(404);
      expect((await api.lookup("%")).status).toBe(404);
    });

    it("answers 404 (not a 500) for a very long barcode", async () => {
      expect((await api.lookup("9".repeat(5000))).status).toBe(404);
    });

    it("answers 404 after the item was deleted", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      expect((await api.deleteItem(item.id)).status).toBe(200);
      expect((await api.lookup(item.barcode)).status).toBe(404);
    });

    it("answers 404 when the barcode only exists inside another item's name or notes, not as a barcode", async () => {
      fake.seedMedications([{ id: 950, barcode: "REAL-1", name: "MENTIONS-0042 in the name", notes: "also 0042 in the notes" }]);
      expect((await api.lookup("0042")).status).toBe(404);
      expect((await api.lookup("MENTIONS-0042")).status).toBe(404);
    });
  });

  describe("a failing database is never reported as 'not found'", () => {
    it.each([
      { label: "the database can't be reached", error: { code: "", message: "TypeError: fetch failed" }, status: 503, message: /can.t reach the database/i },
      { label: "the database rejects the app's key", error: { code: "PGRST301", message: "JWT expired" }, status: 500, message: /connection to the database was refused/i },
      { label: "the database user lacks the privilege", error: { code: "42501", message: "permission denied for table medications" }, status: 403, message: /does not have permission to read/i },
      { label: "a row-level-security error is raised", error: { code: "42501", message: 'new row violates row-level security policy for table "medications"' }, status: 403, message: /did not allow the app to read/i },
      { label: "an unexpected database error happens", error: { code: "XX000", message: "internal error" }, status: 500, message: /something went wrong while reading/i },
      { label: "the request times out", error: { code: "", message: "ETIMEDOUT" }, status: 503, message: /can.t reach the database/i },
    ])("answers with $status and a message, never 404, when $label", async ({ error, status, message }) => {
      const item = itemNamed(medications, "Acetaminophen 500 mg");
      fake.failNext(error, { table: "medications" });
      const res = await api.lookup(item.barcode);
      expect(res.status).toBe(status);
      expect(res.status).not.toBe(404);
      expect(errorTextOf(await res.json())).toMatch(message);
    });

    it("answers 404 when the database itself says 'no rows' (PGRST116): that is the one error that means 'not in the inventory'", async () => {
      fake.failNext({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: "The result contains 0 rows" }, { table: "medications" });
      const res = await api.lookup("whatever-barcode");
      expect(res.status).toBe(404);
    });

    it("answers 500 instead of 404 when the database client throws", async () => {
      fake.onCall(() => {
        throw new Error("socket hang up");
      });
      const res = await api.lookup(medications[0].barcode);
      expect(res.status).toBe(500);
    });

    it("never writes anything while looking up, so an outage during a scan creates no item", async () => {
      const before = snapshotDb(fake);
      fake.failNext({ code: "", message: "TypeError: fetch failed" }, { table: "medications" });
      expect((await api.lookup("0049000055555")).status).toBe(503);
      expect((await api.lookup("0049000055555")).status).toBe(404);
      expect(fake.writes()).toEqual([]);
      expect(snapshotDb(fake)).toEqual(before);
    });
  });

  describe("the scan flow end to end", () => {
    it("unknown barcode: 404, then the scanner's create succeeds, then the same barcode is found as a new unnamed item", async () => {
      const barcode = "0049000066666";
      expect((await api.lookup(barcode)).status).toBe(404);
      const created = await api.createItem({ name: null, barcode, stock: 0, threshold: 10, unit: "units", is_unnamed: true });
      expect(created.status).toBe(201);
      const found = await api.lookup(barcode);
      expect(found.status).toBe(200);
      expect(await bodyRecord(found)).toMatchObject({ barcode, name: null, is_unnamed: true, stock: 0, category_id: null });
    });

    it("a second device creating the same unknown barcode gets 409 and can then look the item up, so nothing is duplicated", async () => {
      const barcode = "0049000077777";
      const body = { name: null, barcode, stock: 0, threshold: 10, unit: "units", is_unnamed: true };
      expect((await api.createItem(body)).status).toBe(201);
      expect((await api.createItem(body)).status).toBe(409);
      expect((await api.lookup(barcode)).status).toBe(200);
      expect(fake.dump("medications").filter((m) => m.barcode === barcode)).toHaveLength(1);
    });

    it("a stock change recorded after a scan shows up in the next lookup (lookups are never served stale)", async () => {
      const item = itemNamed(medications, "Naproxen 220 mg");
      const first = await bodyRecord(await api.lookup(item.barcode));
      expect(first.stock).toBe(item.stock);
      expect((await api.updateItem(item.id, { stock: item.stock + 5 })).status).toBe(200);
      expect((await bodyRecord(await api.lookup(item.barcode))).stock).toBe(item.stock + 5);
    });
  });

  describe("headers", () => {
    it("opts out of static caching and marks found and not-found answers no-store, so a stale stock level is never shown", async () => {
      expect(barcodeRoute.dynamic).toBe("force-dynamic");
      expect((await api.lookup(medications[0].barcode)).headers.get("cache-control")).toBe("no-store");
      expect((await api.lookup("0000000000000")).headers.get("cache-control")).toBe("no-store");
    });
  });
});

describe("barcode lookup on the live database as deployed today (no supplier column, categories hidden)", () => {
  it("still finds items, with supplier_order_number null", async () => {
    const fake = installFake(LIVE_BEFORE_MIGRATION);
    const { medications } = seedStandard(fake);
    const item = itemNamed(medications, "Acetaminophen 500 mg");
    const res = await api.lookup(item.barcode);
    expect(res.status).toBe(200);
    expect(await bodyRecord(res)).toMatchObject({ id: item.id, supplier_order_number: null, category_id: item.category_id });
  });
});

describe("every in-repo caller encodes the barcode exactly once", () => {
  // The route looks up the path parameter exactly as Next hands it over (decoded once). A caller that encoded twice would
  // therefore search for the wrong text, and one that did not encode would break on "/" or "%". So every URL built from
  // /api/medications/barcode/ in the browser code must end in a single encodeURIComponent(...).
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
      else if (/\.(ts|tsx)$/.test(entry)) found.push(full);
    }
    return found;
  }

  const callers = sourceFiles(path.join(REPO_ROOT, "app"))
    .filter((file) => !path.relative(path.join(REPO_ROOT, "app"), file).startsWith(`api${path.sep}`))
    .flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const urls = [...text.matchAll(/`\/api\/medications\/barcode\/([^`]*)`/g)].map((match) => match[1]);
      return urls.length === 0 ? [] : [{ file: path.relative(REPO_ROOT, file), urls }];
    });

  it("finds the scanner callers (the Scan tab and the kiosk)", () => {
    expect(callers.map((caller) => caller.file).sort()).toEqual(["app/kiosk/page.tsx", "app/page.tsx"]);
  });

  it.each(callers)("$file builds every lookup URL with one encodeURIComponent and nothing else", ({ urls }) => {
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toMatch(/^\$\{encodeURIComponent\([A-Za-z0-9_.]+\)\}$/);
  });
});

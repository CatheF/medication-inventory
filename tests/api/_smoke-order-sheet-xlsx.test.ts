// Smoke test for POST /api/order-sheet/xlsx.
//
// "@/lib/db" is replaced by a stub that RECORDS EVERY CALL made on the Supabase client (any method, any depth), so
// the tests can prove the route is read-only: nothing but from("medications").select("*").in("id", …) may happen.
import { strFromU8, unzipSync } from "fflate";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as routeModule from "@/app/api/order-sheet/xlsx/route";
import { POST } from "@/app/api/order-sheet/xlsx/route";
import { FORMULA_NAMES, buildManyMedications, buildMedications } from "@/tests/helpers/fixtures";

const db = vi.hoisted(() => {
  const state = {
    calls: [] as Array<{ method: string; args: unknown[] }>,
    rows: [] as Array<Record<string, unknown>>,
    /** returned as { data: null, error } when set */
    error: null as unknown,
    /** thrown (rejected) when the query is awaited */
    thrown: null as unknown,
  };

  // Any property read on a query builder returns a function that records the call and returns another builder;
  // awaiting a builder resolves like PostgREST would. So an unexpected insert/update/delete/upsert/rpc is recorded.
  function builder(ids: unknown[]): unknown {
    return new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
              if (state.thrown !== null) {
                reject(state.thrown);
                return;
              }
              if (state.error !== null) {
                resolve({ data: null, error: state.error });
                return;
              }
              resolve({ data: state.rows.filter((row) => ids.includes(row.id)), error: null });
            };
          }
          return (...args: unknown[]) => {
            state.calls.push({ method: String(prop), args });
            return builder(prop === "in" && Array.isArray(args[1]) ? (args[1] as unknown[]) : ids);
          };
        },
      }
    );
  }

  const supabase = {
    from(table: string) {
      state.calls.push({ method: "from", args: [table] });
      return builder([]);
    },
    rpc(...args: unknown[]) {
      state.calls.push({ method: "rpc", args });
      return builder([]);
    },
  };
  return { state, supabase };
});

vi.mock("@/lib/db", () => ({ supabase: db.supabase }));

const URL_ = "http://localhost/api/order-sheet/xlsx";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const WRITE_METHODS = ["insert", "update", "delete", "upsert", "rpc"];

function body(rows: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: "Supply order", date: "2026-11-05", preparedBy: "Jane Doe", notes: "", showOnHand: false, showBarcode: false, rows, ...extra };
}

function post(payload: unknown, rawText?: string): Promise<Response> {
  return POST(
    new NextRequest(URL_, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rawText ?? JSON.stringify(payload),
    })
  );
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** Minimal view into the returned workbook (zip of XML parts). */
function inspect(bytes: Uint8Array) {
  const files = unzipSync(bytes);
  const parts = Object.fromEntries(Object.entries(files).map(([name, data]) => [name, strFromU8(data)]));
  const shared = [...parts["xl/sharedStrings.xml"].matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => {
    const t = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(m[1]);
    return unescapeXml(t ? t[1] : "");
  });
  const sheet = parts["xl/worksheets/sheet1.xml"];
  const cell = (ref: string): string | number | null => {
    const m = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`).exec(sheet);
    const v = m && m[2] ? /<v>([\s\S]*?)<\/v>/.exec(m[2]) : null;
    if (!m || !v) return null;
    return /\bt="s"/.test(m[1]) ? shared[Number(v[1])] : Number(v[1]);
  };
  /** Values of one column from row `from` down, until the first empty "No." cell */
  const dataColumn = (letter: string, from = 6): Array<string | number | null> => {
    const out: Array<string | number | null> = [];
    for (let row = from; cell(`A${row}`) !== null; row += 1) out.push(cell(`${letter}${row}`));
    return out;
  };
  const hasFormula = Object.entries(parts)
    .filter(([name]) => name.endsWith(".xml") || name.endsWith(".rels"))
    .some(([, text]) => /<f[\s>/]/.test(text));
  return { parts, shared, sheet, cell, dataColumn, hasFormula };
}

async function bytesOf(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

function recordedMethods(): string[] {
  return db.state.calls.map((c) => c.method);
}

beforeEach(() => {
  db.state.calls.length = 0;
  db.state.rows = buildMedications() as unknown as Array<Record<string, unknown>>;
  db.state.error = null;
  db.state.thrown = null;
});

describe("POST /api/order-sheet/xlsx: success", () => {
  it("returns a real .xlsx download with the right headers and a filename built only from the date", async () => {
    const res = await post(body([{ id: 100, qty: "12", unit: "box" }, { id: 101, qty: "", unit: "" }]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(XLSX_TYPE);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="order-sheet-2026-11-05.xlsx"');
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="order-sheet-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const bytes = await bytesOf(res);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe("PK");
    expect(res.headers.get("content-length")).toBe(String(bytes.length));

    const wb = inspect(bytes);
    expect(wb.parts["xl/workbook.xml"]).toContain('name="Order sheet"');
    // the downloaded file also prints properly from a spreadsheet app: one page wide, header row repeated on every page
    expect(wb.sheet).toContain('<pageSetUpPr fitToPage="1"/>');
    expect(wb.sheet).toContain('<pageSetup orientation="portrait" fitToWidth="1" fitToHeight="0"/>');
    expect(wb.parts["xl/workbook.xml"]).toContain(`<definedName name="_xlnm.Print_Titles" localSheetId="0">'Order sheet'!$5:$5</definedName>`);
    expect(wb.cell("B1")).toBe("Supply order");
    expect(wb.cell("B2")).toBe("2026-11-05");
    expect(wb.cell("B3")).toBe("Jane Doe");
    expect(wb.dataColumn("B")).toEqual(["Acetaminophen 500 mg, tablets", "Ibuprofen 200 mg, tablets"]);
    expect(wb.dataColumn("C")).toEqual(["00417-B", "0092"]);
    expect(wb.dataColumn("D")).toEqual([12, null]);
    expect(wb.dataColumn("E")).toEqual(["box", null]);
  });

  it("never lets staff text reach the filename or headers", async () => {
    const res = await post(
      body([{ id: 100 }], {
        title: '../../etc/passwd"; filename="evil.xlsx',
        preparedBy: "a\r\nSet-Cookie: x=1",
        filename: "../../evil.xlsx",
        date: "2026-01-09",
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="order-sheet-2026-01-09.xlsx"');
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("ignores unknown keys at the top level and in rows", async () => {
    const res = await post(body([{ id: 100, qty: "3", unit: "box", name: "INJECTED", supplier: "EVIL" }], { evil: "INJECTED", stock: 999999 }));
    expect(res.status).toBe(200);
    const wb = inspect(await bytesOf(res));
    expect(wb.shared.join("|")).not.toContain("INJECTED");
    expect(wb.shared.join("|")).not.toContain("EVIL");
    expect(wb.dataColumn("B")).toEqual(["Acetaminophen 500 mg, tablets"]);
  });

  it("lists rows in the sheet's order, not the database's order", async () => {
    const requested = [104, 100, 103]; // the database would return them as 100, 103, 104
    const res = await post(body(requested.map((id) => ({ id }))));
    expect(res.status).toBe(200);
    const wb = inspect(await bytesOf(res));
    const nameOf = (id: number) => db.state.rows.find((r) => r.id === id)?.name;
    expect(wb.dataColumn("B")).toEqual(requested.map(nameOf));
    expect(wb.dataColumn("B")[0]).toBe("Acetaminophen 160 mg/5 mL, \"children's\" suspension"); // quotes survive
    expect(wb.dataColumn("A")).toEqual([1, 2, 3]);
  });

  it("shows the optional On hand and Barcode columns only when asked", async () => {
    const plain = inspect(await bytesOf(await post(body([{ id: 101 }]))));
    expect(plain.cell("F5")).toBeNull();
    const both = inspect(await bytesOf(await post(body([{ id: 101 }], { showOnHand: true, showBarcode: true }))));
    expect([both.cell("F5"), both.cell("G5"), both.cell("F6"), both.cell("G6")]).toEqual(["On hand", "Barcode", "18 units", db.state.rows[1].barcode]);
  });

  it("defaults a missing or null quantity and unit to blank and accepts digit-string ids", async () => {
    const res = await post(body([{ id: 100 }, { id: "101", qty: null, unit: null }, { id: 102, qty: "007" }]));
    expect(res.status).toBe(200);
    const wb = inspect(await bytesOf(res));
    expect(wb.dataColumn("D")).toEqual([null, null, 7]);
    expect(wb.dataColumn("E")).toEqual([null, null, null]);
  });

  it("works before the supplier_order_number migration: rows without that column show the missing marker", async () => {
    db.state.rows = buildMedications().map((m) => {
      const copy: Record<string, unknown> = { ...m };
      delete copy.supplier_order_number;
      return copy;
    });
    const res = await post(body([{ id: 100 }, { id: 101 }]));
    expect(res.status).toBe(200);
    expect(inspect(await bytesOf(res)).dataColumn("C")).toEqual(["—", "—"]);
  });

  it("writes formula-looking names from the database as literal text, never as formulas", async () => {
    db.state.rows = FORMULA_NAMES.map((name, i) => ({ ...buildMedications()[0], id: 500 + i, name, supplier_order_number: `=${i}` }));
    const res = await post(body(FORMULA_NAMES.map((_n, i) => ({ id: 500 + i, qty: String(i + 1) }))));
    expect(res.status).toBe(200);
    const wb = inspect(await bytesOf(res));
    expect(wb.hasFormula).toBe(false);
    expect(wb.dataColumn("B")).toEqual(FORMULA_NAMES.map((n) => n.trim()));
    expect(wb.dataColumn("C")).toEqual(FORMULA_NAMES.map((_n, i) => `=${i}`));
  });

  it("accepts the documented maximums exactly", async () => {
    db.state.rows = buildManyMedications(500) as unknown as Array<Record<string, unknown>>;
    const rows = db.state.rows.map((r) => ({ id: r.id, qty: "999999999", unit: "u".repeat(40) }));
    const res = await post(
      body(rows, { title: "t".repeat(120), preparedBy: "p".repeat(80), notes: "n".repeat(1000), showOnHand: true, showBarcode: true })
    );
    expect(res.status).toBe(200);
    const wb = inspect(await bytesOf(res));
    expect(wb.dataColumn("A", 7)).toHaveLength(500); // notes row exists, so the data starts at row 7
    expect(wb.cell("B1")).toBe("t".repeat(120));
  });

  it("exposes nothing but POST (no GET/PUT/PATCH/DELETE handlers)", () => {
    expect(Object.keys(routeModule).sort()).toEqual(["POST", "runtime"]);
    expect(routeModule.runtime).toBe("nodejs");
  });
});

describe("POST /api/order-sheet/xlsx: strictly read-only", () => {
  it("only ever issues from('medications').select('*').in('id', …)", async () => {
    const res = await post(body([{ id: 100, qty: "5" }, { id: 101 }, { id: 102 }]));
    expect(res.status).toBe(200);
    expect(recordedMethods()).toEqual(["from", "select", "in"]);
    expect(db.state.calls[0].args).toEqual(["medications"]);
    expect(db.state.calls[1].args).toEqual(["*"]);
    expect(db.state.calls[2].args).toEqual(["id", [100, 101, 102]]);
    for (const method of WRITE_METHODS) expect(recordedMethods()).not.toContain(method);
  });

  it("does not touch the database at all when the request is invalid", async () => {
    await post(body([]));
    await post(body([{ id: 0 }]));
    await post(null, "{");
    expect(db.state.calls).toEqual([]);
  });

  it("does not touch the database after a failed read either (no retries that write, no cleanup writes)", async () => {
    db.state.error = { code: "42501", message: "permission denied for table medications" };
    await post(body([{ id: 100 }]));
    expect(recordedMethods()).toEqual(["from", "select", "in"]);
  });

  it("leaves the stub inventory exactly as it was", async () => {
    const before = JSON.stringify(db.state.rows);
    await post(body([{ id: 100, qty: "999", unit: "case" }, { id: 101, qty: "5" }]));
    expect(JSON.stringify(db.state.rows)).toBe(before);
  });
});

describe("POST /api/order-sheet/xlsx: duplicate ids and chunked reads", () => {
  it("de-duplicates ids: one read, one row each, the first occurrence wins", async () => {
    const res = await post(body([{ id: 100, qty: "2", unit: "box" }, { id: 101 }, { id: 100, qty: "99", unit: "case" }, { id: 100 }]));
    expect(res.status).toBe(200);
    const inCalls = db.state.calls.filter((c) => c.method === "in");
    expect(inCalls).toHaveLength(1);
    expect(inCalls[0].args).toEqual(["id", [100, 101]]);
    const wb = inspect(await bytesOf(res));
    expect(wb.dataColumn("A")).toEqual([1, 2]);
    expect(wb.dataColumn("D")).toEqual([2, null]);
    expect(wb.dataColumn("E")).toEqual(["box", null]);
  });

  it("reads 450 ids in chunks of 200 (200 + 200 + 50), each id exactly once, and keeps every row", async () => {
    db.state.rows = buildManyMedications(450) as unknown as Array<Record<string, unknown>>;
    const ids = db.state.rows.map((r) => r.id as number);
    const res = await post(body(ids.map((id) => ({ id }))));
    expect(res.status).toBe(200);
    const inCalls = db.state.calls.filter((c) => c.method === "in");
    expect(inCalls.map((c) => (c.args[1] as number[]).length)).toEqual([200, 200, 50]);
    expect(inCalls.flatMap((c) => c.args[1] as number[])).toEqual(ids);
    expect(recordedMethods().filter((m) => m !== "from" && m !== "select" && m !== "in")).toEqual([]);
    const wb = inspect(await bytesOf(res));
    expect(wb.dataColumn("A")).toHaveLength(450);
    expect(wb.dataColumn("A").at(-1)).toBe(450);
  });
});

describe("POST /api/order-sheet/xlsx: validation (400)", () => {
  const manyRows = Array.from({ length: 501 }, (_v, i) => ({ id: i + 1 }));
  const cases: Array<[string, unknown, string]> = [
    ["no rows", body([]), "rows"],
    ["rows is not a list", body("100"), "rows"],
    ["rows missing", { title: "x", date: "2026-11-05" }, "rows"],
    ["more than 500 rows", body(manyRows), "rows"],
    ["row is not an object", body([5]), "rows[0]"],
    ["id is zero", body([{ id: 0 }]), "rows[0].id"],
    ["id is negative", body([{ id: -5 }]), "rows[0].id"],
    ["id is fractional", body([{ id: 1.5 }]), "rows[0].id"],
    ["id is not a number", body([{ id: "abc" }]), "rows[0].id"],
    ["id is missing", body([{ qty: "1" }]), "rows[0].id"],
    ["second row has a bad id", body([{ id: 100 }, { id: null }]), "rows[1].id"],
    ["quantity has a decimal", body([{ id: 100, qty: "1.5" }]), "rows[0].qty"],
    ["quantity is negative", body([{ id: 100, qty: "-3" }]), "rows[0].qty"],
    ["quantity is zero", body([{ id: 100, qty: "0" }]), "rows[0].qty"],
    ["quantity has letters", body([{ id: 100, qty: "12a" }]), "rows[0].qty"],
    ["quantity is a formula", body([{ id: 100, qty: "=1+1" }]), "rows[0].qty"],
    ["quantity is above the maximum", body([{ id: 100, qty: "1000000000" }]), "rows[0].qty"],
    ["quantity is a JSON number", body([{ id: 100, qty: 5 }]), "rows[0].qty"],
    ["unit is not text", body([{ id: 100, unit: 5 }]), "rows[0].unit"],
    ["unit is too long", body([{ id: 100, unit: "u".repeat(41) }]), "rows[0].unit"],
    ["date is missing", body([{ id: 100 }], { date: undefined }), "date"],
    ["date does not exist", body([{ id: 100 }], { date: "2026-02-30" }), "date"],
    ["date has the wrong shape", body([{ id: 100 }], { date: "11/05/2026" }), "date"],
    ["date is not text", body([{ id: 100 }], { date: 20261105 }), "date"],
    ["date is in the year 0026 (a year typed as 26)", body([{ id: 100 }], { date: "0026-11-05" }), "date"],
    ["date is in the year 0001", body([{ id: 100 }], { date: "0001-01-01" }), "date"],
    ["date is before the year 2000", body([{ id: 100 }], { date: "1999-12-31" }), "date"],
    ["date is after the year 2099", body([{ id: 100 }], { date: "2100-01-01" }), "date"],
    ["date is in the year 9999", body([{ id: 100 }], { date: "9999-12-31" }), "date"],
    ["date has five digits in the year", body([{ id: 100 }], { date: "20265-11-05" }), "date"],
    ["date has a time part", body([{ id: 100 }], { date: "2026-11-05T00:00:00Z" }), "date"],
    ["title is not text", body([{ id: 100 }], { title: 5 }), "title"],
    ["title is too long", body([{ id: 100 }], { title: "t".repeat(121) }), "title"],
    ["prepared by is too long", body([{ id: 100 }], { preparedBy: "p".repeat(81) }), "preparedBy"],
    ["notes are too long", body([{ id: 100 }], { notes: "n".repeat(1001) }), "notes"],
    ["show on hand is not a boolean", body([{ id: 100 }], { showOnHand: "yes" }), "showOnHand"],
    ["show barcode is not a boolean", body([{ id: 100 }], { showBarcode: 1 }), "showBarcode"],
  ];

  it.each(cases)("rejects %s with 400, a message and the field name, without reading the database", async (_label, payload, field) => {
    const res = await post(payload);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; field?: string };
    expect(json.error.length).toBeGreaterThan(5);
    expect(json.field).toBe(field);
    expect(db.state.calls).toEqual([]);
  });

  it("says clearly which dates are accepted (real calendar days from 2000 to 2099, YYYY-MM-DD) and names the field", async () => {
    for (const date of ["0026-11-05", "1999-12-31", "2100-01-01", "2026-02-30", "11/05/2026"]) {
      const res = await post(body([{ id: 100 }], { date }));
      expect(res.status, date).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      const json = (await res.json()) as { error: string; field?: string };
      expect(json.field).toBe("date");
      expect(json.error).toMatch(/2000/);
      expect(json.error).toMatch(/2099/);
      expect(json.error).toMatch(/YYYY-MM-DD/);
    }
    expect(db.state.calls).toEqual([]); // rejected before the database was asked anything
  });

  it.each(["2000-01-01", "2000-02-29", "2024-02-29", "2099-12-31"])("accepts the date %s (inside the years the order sheet accepts) and builds the file name from it", async (date) => {
    const res = await post(body([{ id: 100 }], { date }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="order-sheet-${date}.xlsx"`);
    expect(inspect(await bytesOf(res)).cell("B2")).toBe(date);
  });

  it("says what to do when the sheet is empty", async () => {
    const res = await post(body([]));
    expect(((await res.json()) as { error: string }).error).toMatch(/^Add at least one item/);
  });

  it("rejects bodies that are not JSON objects", async () => {
    for (const raw of ["{", "", "null", "[]", '"text"', "123", "true"]) {
      const res = await post(null, raw);
      expect(res.status, raw).toBe(400);
      expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(5);
    }
    expect(db.state.calls).toEqual([]);
  });

  it("refuses an oversized body before parsing it (413)", async () => {
    const res = await post(null, JSON.stringify(body([{ id: 100 }], { notes: "n".repeat(300000) })));
    expect(res.status).toBe(413);
    expect(db.state.calls).toEqual([]);
  });

  it("does not validate (or read) a repeated row twice: a later duplicate with a bad quantity is simply ignored", async () => {
    const res = await post(body([{ id: 100, qty: "4" }, { id: 100, qty: "not a number" }]));
    expect(res.status).toBe(200);
    expect(inspect(await bytesOf(res)).dataColumn("D")).toEqual([4]);
  });
});

describe("POST /api/order-sheet/xlsx: items that are no longer in the inventory (422)", () => {
  it("never echoes a draft row's remembered name (the response lists ids only)", async () => {
    const res = await post(body([{ id: 100 }, { id: 9999, name: "Deleted item <b>remembered</b>" }]));
    expect(res.status).toBe(422);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("Deleted item");
    expect(text).toContain("9999");
  });

  it("lists every missing id and returns no file", async () => {
    const res = await post(body([{ id: 100 }, { id: 9999 }, { id: 101 }, { id: 8888 }]));
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = (await res.json()) as { error: string; missingIds: number[] };
    expect(json.missingIds).toEqual([9999, 8888]);
    expect(json.error).toMatch(/2 items/);
    expect(json.error).toMatch(/no longer in the inventory/);
  });

  it("uses the singular for one missing item", async () => {
    const res = await post(body([{ id: 100 }, { id: 9999 }]));
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string; missingIds: number[] };
    expect(json.missingIds).toEqual([9999]);
    expect(json.error).toMatch(/^1 item /);
  });

  it("returns 422 even when every requested item is missing", async () => {
    db.state.rows = [];
    const res = await post(body([{ id: 1 }, { id: 2 }]));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { missingIds: number[] }).missingIds).toEqual([1, 2]);
  });
});

describe("POST /api/order-sheet/xlsx: database and generation failures", () => {
  it("maps an unreachable database (returned error) to 503 with a message staff can act on", async () => {
    db.state.error = { message: "TypeError: fetch failed", details: "", hint: "", code: "" };
    const res = await post(body([{ id: 100 }]));
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("reach the database");
    expect(json.error).toContain("paused");
  });

  it("maps a thrown network failure to 503 as well", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.state.thrown = new TypeError("fetch failed");
    const res = await post(body([{ id: 100 }]));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("reach the database");
    spy.mockRestore();
  });

  it("maps a permissions error to 403 and an unknown one to 500, never a file", async () => {
    db.state.error = { code: "42501", message: "permission denied for table medications" };
    const denied = await post(body([{ id: 100 }]));
    expect(denied.status).toBe(403);
    expect(denied.headers.get("content-type")).toContain("application/json");

    db.state.error = { code: "XX000", message: "boom" };
    const unknown = await post(body([{ id: 100 }]));
    expect(unknown.status).toBe(500);
    expect(((await unknown.json()) as { error: string; code?: string }).code).toBe("XX000");
  });

  it("stops at the first failing chunk and never builds a partial sheet", async () => {
    db.state.rows = buildManyMedications(450) as unknown as Array<Record<string, unknown>>;
    db.state.error = { message: "TypeError: fetch failed", code: "" };
    const res = await post(body(db.state.rows.map((r) => ({ id: r.id }))));
    expect(res.status).toBe(503);
    expect(db.state.calls.filter((c) => c.method === "in")).toHaveLength(1);
  });

  it("returns a clear 500 (and no file) when the workbook cannot be built", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.resetModules();
    vi.doMock("@/lib/order-sheet/xlsx", () => ({
      buildOrderSheetXlsx: async () => {
        throw new Error("writer exploded");
      },
    }));
    try {
      const { POST: failing } = await import("@/app/api/order-sheet/xlsx/route");
      const res = await failing(
        new NextRequest(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body([{ id: 100 }])) })
      );
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("application/json");
      const json = (await res.json()) as { error: string };
      expect(json.error).toMatch(/Couldn’t create the Excel file/);
      expect(json.error).toMatch(/Print/);
      expect(json.error).not.toContain("writer exploded"); // internals are not leaked
    } finally {
      vi.doUnmock("@/lib/order-sheet/xlsx");
      spy.mockRestore();
    }
  });
});

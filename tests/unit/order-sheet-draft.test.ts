import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DRAFT,
  DRAFT_EVENT,
  MAX_SHEET_YEAR,
  MIN_SHEET_YEAR,
  STORAGE_KEY,
  addRows,
  cleanRowName,
  clearRows,
  hasRow,
  isValidISODate,
  parseDraft,
  removeRow,
  removeRows,
  rememberNames,
  restoreRow,
  resolveDate,
  sanitizeDraft,
  serializeDraft,
  todayISO,
  toggleRow,
  updateRow,
} from "@/lib/order-sheet/draft";
import type { OrderDraft } from "@/lib/order-sheet/draft";
import { ORDER_SHEET_LIMITS } from "@/lib/order-sheet/types";
import type { UseOrderDraft } from "@/lib/order-sheet/use-order-draft";

function draftWith(overrides: Partial<OrderDraft> = {}): OrderDraft {
  return { ...DEFAULT_DRAFT, rows: [], ...overrides };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

describe("DEFAULT_DRAFT", () => {
  it("has the documented defaults", () => {
    expect(DEFAULT_DRAFT).toEqual({
      version: 1,
      rows: [],
      title: "Supply order",
      date: null,
      preparedBy: "",
      notes: "",
      showOnHand: false,
      showBarcode: false,
      paper: "letter",
    });
    expect(STORAGE_KEY).toBe("medinventory.orderSheet.v1");
  });

  it("is deeply frozen so it can be the stable server snapshot", () => {
    expect(Object.isFrozen(DEFAULT_DRAFT)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DRAFT.rows)).toBe(true);
    expect(() => {
      (DEFAULT_DRAFT.rows as unknown as number[]).push(1);
    }).toThrow();
  });

  it("is never changed by the draft helpers", () => {
    const snapshot = JSON.stringify(DEFAULT_DRAFT);
    addRows(DEFAULT_DRAFT, [1, 2, 3]);
    toggleRow(DEFAULT_DRAFT, 4);
    removeRow(DEFAULT_DRAFT, 1);
    updateRow(DEFAULT_DRAFT, 1, { qty: "5" });
    clearRows(DEFAULT_DRAFT);
    parseDraft(serializeDraft(DEFAULT_DRAFT));
    expect(JSON.stringify(DEFAULT_DRAFT)).toBe(snapshot);
  });
});

describe("parseDraft never throws on garbage", () => {
  const garbage: Array<[string, string | null | undefined]> = [
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace", "   "],
    ["unterminated object", "{"],
    ["stray brace", "}"],
    ["json null", "null"],
    ["json true", "true"],
    ["json number", "123"],
    ["json string", '"just text"'],
    ["empty array", "[]"],
    ["array of numbers", "[1,2,3]"],
    ["array holding a draft", '[{"version":1,"rows":[]}]'],
    ["empty object (no version)", "{}"],
    ["future version", '{"version":2,"rows":[{"id":1,"qty":"","unit":""}]}'],
    ["string version", '{"version":"1","rows":[]}'],
    ["javascript, not json", "{'version':1}"],
    ["the word undefined", "undefined"],
    ["NUL character", String.fromCharCode(0)],
    ["huge string over the size guard", "x".repeat(3_000_000)],
    ["deeply nested array", "[".repeat(200_000)],
    ["truncated draft", '{"version":1,"rows":[{"id":1,"qty":"5","un'],
  ];

  it.each(garbage)("returns the empty draft for %s", (_label, raw) => {
    expect(() => parseDraft(raw)).not.toThrow();
    expect(parseDraft(raw)).toEqual(DEFAULT_DRAFT);
  });

  it("returns the same frozen default object, so the server snapshot is stable", () => {
    expect(parseDraft(null)).toBe(DEFAULT_DRAFT);
    expect(parseDraft("")).toBe(DEFAULT_DRAFT);
    expect(parseDraft("{")).toBe(DEFAULT_DRAFT);
  });

  it("does not throw when handed a non-string at runtime", () => {
    for (const value of [5, {}, [], true, Symbol.iterator, () => 1]) {
      expect(parseDraft(value as unknown as string)).toEqual(DEFAULT_DRAFT);
    }
  });

  it("falls back per field when types are wrong", () => {
    const raw = JSON.stringify({
      version: 1,
      rows: "nope",
      title: 5,
      date: 20260101,
      preparedBy: ["x"],
      notes: { a: 1 },
      showOnHand: "yes",
      showBarcode: 1,
      paper: "legal",
    });
    expect(parseDraft(raw)).toEqual(DEFAULT_DRAFT);
  });

  it("drops every malformed row but keeps the good ones", () => {
    const raw = JSON.stringify({
      version: 1,
      rows: [
        null,
        1,
        "x",
        [],
        {},
        { id: "abc" },
        { id: -1 },
        { id: 0 },
        { id: 1.5 },
        { id: 1e30 },
        { id: null },
        { id: true },
        { id: { a: 1 } },
        { id: 7, qty: "3", unit: "box" },
      ],
    });
    expect(parseDraft(raw).rows).toEqual([{ id: 7, qty: "3", unit: "box" }]);
  });

  it("de-duplicates ids (first occurrence wins) and accepts digit-string ids", () => {
    const raw = JSON.stringify({
      version: 1,
      rows: [
        { id: 5, qty: "1", unit: "a" },
        { id: 6, qty: "2", unit: "b" },
        { id: 5, qty: "99", unit: "z" },
        { id: "6", qty: "88", unit: "y" },
        { id: "7", qty: "3", unit: "c" },
      ],
    });
    expect(parseDraft(raw).rows).toEqual([
      { id: 5, qty: "1", unit: "a" },
      { id: 6, qty: "2", unit: "b" },
      { id: 7, qty: "3", unit: "c" },
    ]);
  });

  it("replaces a wrong-typed qty or unit with an empty string", () => {
    const raw = JSON.stringify({ version: 1, rows: [{ id: 1, qty: 12, unit: ["box"] }, { id: 2 }] });
    expect(parseDraft(raw).rows).toEqual([
      { id: 1, qty: "", unit: "" },
      { id: 2, qty: "", unit: "" },
    ]);
  });

  it("keeps what staff typed, even an invalid quantity (it is flagged later, never fixed silently)", () => {
    const raw = JSON.stringify({ version: 1, rows: [{ id: 1, qty: "1.5", unit: " box " }, { id: 2, qty: "abc", unit: "" }] });
    expect(parseDraft(raw).rows).toEqual([
      { id: 1, qty: "1.5", unit: " box " },
      { id: 2, qty: "abc", unit: "" },
    ]);
  });

  it("clamps text lengths (code points) to the documented limits", () => {
    const emoji = String.fromCodePoint(0x1f48a);
    const parsed = parseDraft(
      JSON.stringify({
        version: 1,
        title: "t".repeat(500),
        preparedBy: "p".repeat(200),
        notes: emoji.repeat(2000),
        rows: [{ id: 1, qty: "1234567890123", unit: "u".repeat(100) }],
      })
    );
    expect(Array.from(parsed.title)).toHaveLength(ORDER_SHEET_LIMITS.title);
    expect(Array.from(parsed.preparedBy)).toHaveLength(ORDER_SHEET_LIMITS.preparedBy);
    expect(Array.from(parsed.notes)).toHaveLength(ORDER_SHEET_LIMITS.notes);
    expect(parsed.notes.isWellFormed()).toBe(true);
    expect(parsed.rows[0].qty).toBe("1234567890123"); // 13 digits: kept whole (it is shown with a message), never cut to a valid 9-digit number
    expect(parsed.rows[0].unit).toBe("u".repeat(ORDER_SHEET_LIMITS.unit));
    expect([ORDER_SHEET_LIMITS.title, ORDER_SHEET_LIMITS.preparedBy, ORDER_SHEET_LIMITS.notes, ORDER_SHEET_LIMITS.unit]).toEqual([
      120, 80, 1000, 40,
    ]);
  });

  it("keeps a stored quantity of more than 9 digits exactly as it was typed (the page explains it); only absurd lengths are cut", () => {
    const stored = (qty: string) => parseDraft(JSON.stringify({ version: 1, rows: [{ id: 1, qty, unit: "" }] })).rows[0].qty;
    expect(stored("999999999999")).toBe("999999999999");
    expect(stored("0".repeat(30) + "12")).toBe("0".repeat(30) + "12");
    expect(stored("9".repeat(500))).toBe("9".repeat(ORDER_SHEET_LIMITS.qtyTyped));
    expect(ORDER_SHEET_LIMITS.qtyTyped).toBeGreaterThan(ORDER_SHEET_LIMITS.qtyDigits);
  });

  it("survives a huge (but under the size guard) string field", () => {
    const parsed = parseDraft(JSON.stringify({ version: 1, title: "t".repeat(1_500_000) }));
    expect(parsed.title).toBe("t".repeat(120));
  });

  it("caps the number of rows and does not scan an unbounded array", () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => ({ id: i + 1, qty: "", unit: "" }));
    const raw = JSON.stringify({ version: 1, rows });
    expect(raw.length).toBeLessThan(2_000_000); // under the raw-size guard, so the rows really are inspected
    const parsed = parseDraft(raw);
    expect(parsed.rows).toHaveLength(ORDER_SHEET_LIMITS.rows);
    expect(parsed.rows[0].id).toBe(1);
    expect(parsed.rows[499].id).toBe(500);
  });

  it("does not even parse a stored value larger than any real draft", () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => ({ id: i + 1, qty: "", unit: "" }));
    expect(parseDraft(JSON.stringify({ version: 1, rows }))).toBe(DEFAULT_DRAFT);
  });

  it("scans a bounded number of entries when most of a large array is junk", () => {
    const junk = Array.from({ length: 20_000 }, () => "not a row");
    const raw = JSON.stringify({ version: 1, rows: [...junk, { id: 1, qty: "", unit: "" }] });
    expect(raw.length).toBeLessThan(2_000_000);
    // The good row sits beyond the scan bound; the point is that the work is bounded and nothing throws.
    expect(() => parseDraft(raw)).not.toThrow();
    expect(parseDraft(raw).rows.length).toBeLessThanOrEqual(ORDER_SHEET_LIMITS.rows);
  });

  it("only accepts real calendar dates", () => {
    const dateOf = (date: unknown) => parseDraft(JSON.stringify({ version: 1, date })).date;
    expect(dateOf("2026-11-05")).toBe("2026-11-05");
    expect(dateOf("2024-02-29")).toBe("2024-02-29");
    for (const bad of ["2025-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-01-00", "2026-1-5", "20260105", "2026-01-05T10:00", " 2026-01-05", "0000-01-01", "", null, 5, {}]) {
      expect(dateOf(bad)).toBeNull();
    }
  });

  it("only accepts dates from 2000 to 2099: a stale draft with another year falls back to 'today' (null)", () => {
    const dateOf = (date: unknown) => parseDraft(JSON.stringify({ version: 1, date })).date;
    expect(dateOf("2000-01-01")).toBe("2000-01-01");
    expect(dateOf("2099-12-31")).toBe("2099-12-31");
    for (const stale of ["0026-11-05", "0001-01-01", "1999-12-31", "2100-01-01", "1970-01-01", "9999-12-31", "0202-02-02"]) {
      expect(dateOf(stale), stale).toBeNull();
    }
    // the rest of the draft is still loaded
    const draft = parseDraft(JSON.stringify({ version: 1, date: "0026-11-05", title: "Kept", rows: [{ id: 4, qty: "3", unit: "box" }] }));
    expect(draft).toMatchObject({ date: null, title: "Kept" });
    expect(draft.rows).toEqual([{ id: 4, qty: "3", unit: "box" }]);
  });

  it("accepts only strict booleans and the two paper sizes", () => {
    const parsed = parseDraft(JSON.stringify({ version: 1, showOnHand: true, showBarcode: true, paper: "a4" }));
    expect(parsed).toMatchObject({ showOnHand: true, showBarcode: true, paper: "a4" });
    const wrong = parseDraft(JSON.stringify({ version: 1, showOnHand: "true", showBarcode: 1, paper: "A4" }));
    expect(wrong).toMatchObject({ showOnHand: false, showBarcode: false, paper: "letter" });
  });

  it("ignores unknown keys and cannot be used for prototype pollution", () => {
    const raw =
      '{"version":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"extra":"x",' +
      '"rows":[{"id":1,"qty":"","unit":"","__proto__":{"polluted":true},"extra":1}]}';
    const parsed = parseDraft(raw);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(parsed).sort()).toEqual(
      ["date", "notes", "paper", "preparedBy", "rows", "showBarcode", "showOnHand", "title", "version"]
    );
    expect(Object.keys(parsed.rows[0]).sort()).toEqual(["id", "qty", "unit"]);
  });
});

describe("serializeDraft / parseDraft round trip", () => {
  it("round-trips a populated draft exactly, without trimming typed text", () => {
    const draft = draftWith({
      rows: [
        { id: 12, qty: "007", unit: "cardboard box " },
        { id: 3, qty: "", unit: "" },
      ],
      title: "Weekly order — “pharmacy” <b>",
      date: "2026-11-05",
      preparedBy: "  Jane Doe ",
      notes: "Line one\nLine two\n=SUM(1,2)",
      showOnHand: true,
      showBarcode: true,
      paper: "a4",
    });
    expect(parseDraft(serializeDraft(draft))).toEqual(draft);
  });

  it("is idempotent: sanitizing a sanitized draft changes nothing", () => {
    const messy = {
      version: 1,
      rows: [{ id: "4", qty: "12345678901", unit: "x".repeat(99) }, { id: 4 }, { id: 9, qty: 1 }],
      title: "t".repeat(300),
      date: "nope",
    };
    const once = sanitizeDraft(messy);
    expect(sanitizeDraft(once)).toEqual(once);
    expect(parseDraft(serializeDraft(once))).toEqual(once);
  });

  it("always writes valid, versioned JSON even if handed a malformed object", () => {
    const text = serializeDraft({ nonsense: true } as unknown as OrderDraft);
    expect(JSON.parse(text)).toMatchObject({ version: 1, rows: [] });
    expect(serializeDraft(null as unknown as OrderDraft)).toBe(JSON.stringify(DEFAULT_DRAFT));
  });
});

describe("row operations", () => {
  it("hasRow reports presence", () => {
    const d = draftWith({ rows: [{ id: 4, qty: "", unit: "" }] });
    expect(hasRow(d, 4)).toBe(true);
    expect(hasRow(d, 5)).toBe(false);
  });

  it("addRows appends only missing ids, preserves order and never duplicates", () => {
    const d1 = addRows(DEFAULT_DRAFT, [5, 3, 5, 9]);
    expect(d1.rows.map((r) => r.id)).toEqual([5, 3, 9]);
    const d2 = addRows(d1, [9, 1, 3, 1, 7]);
    expect(d2.rows.map((r) => r.id)).toEqual([5, 3, 9, 1, 7]);
    expect(d2.rows.every((r) => r.qty === "" && r.unit === "")).toBe(true);
  });

  it("addRows ignores invalid ids", () => {
    const bad = [0, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60] as number[];
    expect(addRows(DEFAULT_DRAFT, bad)).toBe(DEFAULT_DRAFT);
    expect(addRows(DEFAULT_DRAFT, [0, 8, -1]).rows.map((r) => r.id)).toEqual([8]);
  });

  it("returns the SAME object when nothing changes", () => {
    const d = draftWith({ rows: [{ id: 1, qty: "2", unit: "box" }] });
    expect(addRows(d, [])).toBe(d);
    expect(addRows(d, [1])).toBe(d);
    expect(removeRow(d, 99)).toBe(d);
    expect(updateRow(d, 99, { qty: "5" })).toBe(d);
    expect(updateRow(d, 1, {})).toBe(d);
    expect(updateRow(d, 1, { qty: "2", unit: "box" })).toBe(d);
    expect(clearRows(DEFAULT_DRAFT)).toBe(DEFAULT_DRAFT);
  });

  it("removeRow removes exactly that row", () => {
    const d = addRows(DEFAULT_DRAFT, [1, 2, 3]);
    expect(removeRow(d, 2).rows.map((r) => r.id)).toEqual([1, 3]);
  });

  it("toggleRow adds then removes", () => {
    const on = toggleRow(DEFAULT_DRAFT, 6);
    expect(on.rows.map((r) => r.id)).toEqual([6]);
    expect(toggleRow(on, 6).rows).toEqual([]);
  });

  it("updateRow changes only the targeted row and only the given fields", () => {
    const d = addRows(DEFAULT_DRAFT, [1, 2]);
    const withQty = updateRow(d, 2, { qty: "12" });
    expect(withQty.rows).toEqual([
      { id: 1, qty: "", unit: "" },
      { id: 2, qty: "12", unit: "" },
    ]);
    const withUnit = updateRow(withQty, 2, { unit: "case " });
    expect(withUnit.rows[1]).toEqual({ id: 2, qty: "12", unit: "case " }); // typed text is kept as typed
    expect(withUnit.rows[0]).toBe(d.rows[0]); // untouched rows are not re-created
  });

  it("updateRow never changes the id and does not add a row that is not there", () => {
    const d = addRows(DEFAULT_DRAFT, [1]);
    const patched = updateRow(d, 1, { qty: "3", id: 99 } as unknown as { qty: string });
    expect(patched.rows).toEqual([{ id: 1, qty: "3", unit: "" }]);
    expect(updateRow(d, 2, { qty: "3" }).rows.map((r) => r.id)).toEqual([1]);
  });

  it("updateRow bounds the unit like a maxLength would, but keeps a long quantity so the page can explain it", () => {
    const d = addRows(DEFAULT_DRAFT, [1]);
    const longTyped = updateRow(d, 1, { qty: "12345678901234", unit: "u".repeat(80) });
    expect(longTyped.rows[0].qty).toBe("12345678901234"); // not cut to 9 digits: that would turn a mistake into a valid, wrong quantity
    expect(longTyped.rows[0].unit).toBe("u".repeat(40));
    expect(updateRow(d, 1, { qty: "7".repeat(300) }).rows[0].qty).toBe("7".repeat(ORDER_SHEET_LIMITS.qtyTyped));
  });

  it("clearRows removes the rows but keeps the typed options", () => {
    const d = draftWith({ rows: [{ id: 1, qty: "1", unit: "a" }], title: "Mine", notes: "n", preparedBy: "me", date: "2026-01-01", paper: "a4", showOnHand: true });
    expect(clearRows(d)).toEqual({ ...d, rows: [] });
  });

  it("never mutates its input (works on deeply frozen drafts)", () => {
    const frozen = deepFreeze(draftWith({ rows: [{ id: 1, qty: "1", unit: "a" }] }));
    expect(() => {
      addRows(frozen, [2, 3]);
      removeRow(frozen, 1);
      toggleRow(frozen, 4);
      updateRow(frozen, 1, { qty: "9", unit: "b" });
      clearRows(frozen);
    }).not.toThrow();
    expect(frozen.rows).toEqual([{ id: 1, qty: "1", unit: "a" }]);
  });

  it("caps the sheet at the row limit and never silently drops what is already there", () => {
    const ids = Array.from({ length: ORDER_SHEET_LIMITS.rows + 25 }, (_, i) => i + 1);
    const full = addRows(DEFAULT_DRAFT, ids);
    expect(full.rows).toHaveLength(ORDER_SHEET_LIMITS.rows);
    expect(full.rows[0].id).toBe(1);
    expect(addRows(full, [100000])).toBe(full);
    expect(removeRow(full, 1).rows).toHaveLength(ORDER_SHEET_LIMITS.rows - 1);
  });

  it("keeps ids unique and in first-added order over a long random sequence of operations", () => {
    // mulberry32: a tiny seeded PRNG so the sequence is reproducible
    let seed = 20261105;
    const next = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let draft: OrderDraft = DEFAULT_DRAFT;
    const model: number[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const id = 1 + Math.floor(next() * 40);
      const op = Math.floor(next() * 4);
      if (op === 0) {
        draft = addRows(draft, [id, 1 + Math.floor(next() * 40)]);
      } else if (op === 1) {
        draft = toggleRow(draft, id);
      } else if (op === 2) {
        draft = removeRow(draft, id);
      } else {
        draft = updateRow(draft, id, { qty: String(i % 1000) });
      }
      // independent model of the expected id order
      const ids = draft.rows.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      model.length = 0;
      model.push(...ids);
    }
    expect(model.length).toBeLessThanOrEqual(40);
  });
});

describe("remembered item names (the optional `name` of a draft row)", () => {
  const PILL = String.fromCodePoint(0x1f48a);
  const named = (): OrderDraft =>
    draftWith({
      rows: [
        { id: 1, qty: "2", unit: "box", name: "Alpha 10 mg, tablets" },
        { id: 2, qty: "", unit: "", name: "Beta" },
        { id: 3, qty: "9", unit: "case", name: "Gamma" },
      ],
    });

  it("a draft saved before names existed loads unchanged: the rows have no name key at all", () => {
    const legacy = JSON.stringify({
      version: 1,
      rows: [
        { id: 3, qty: "4", unit: "box" },
        { id: 9, qty: "", unit: "" },
      ],
      title: "Old draft",
      date: "2026-01-02",
      preparedBy: "",
      notes: "",
      showOnHand: false,
      showBarcode: false,
      paper: "letter",
    });
    const parsed = parseDraft(legacy);
    expect(parsed.rows).toEqual([
      { id: 3, qty: "4", unit: "box" },
      { id: 9, qty: "", unit: "" },
    ]);
    for (const row of parsed.rows) {
      expect("name" in row).toBe(false); // absent, not `undefined`
      expect(Object.keys(row).sort()).toEqual(["id", "qty", "unit"]);
    }
    expect(serializeDraft(parsed)).not.toContain('"name"'); // saving it again adds nothing
  });

  it("keeps a name that is text, next to the id, qty and unit of its own row", () => {
    const raw = JSON.stringify({
      version: 1,
      rows: [
        { id: 7, qty: "3", unit: "box", name: "Cetirizine 10 mg, tablets" },
        { id: 8, qty: "", unit: "" },
      ],
    });
    const rows = parseDraft(raw).rows;
    expect(rows).toEqual([{ id: 7, qty: "3", unit: "box", name: "Cetirizine 10 mg, tablets" }, { id: 8, qty: "", unit: "" }]);
    expect(Object.keys(rows[0]).sort()).toEqual(["id", "name", "qty", "unit"]);
    expect("name" in rows[1]).toBe(false);
  });

  it.each<[string, unknown]>([
    ["a number", 12],
    ["null", null],
    ["a boolean", true],
    ["an array", ["Alpha"]],
    ["an object", { toString: "x", name: "Alpha" }],
    ["an empty string", ""],
    ["blank text", "   \t\n "],
  ])("ignores a stored name that is %s: the key stays absent and the row still loads", (_label, name) => {
    const rows = parseDraft(JSON.stringify({ version: 1, rows: [{ id: 5, qty: "1", unit: "a", name }] })).rows;
    expect(rows).toEqual([{ id: 5, qty: "1", unit: "a" }]);
    expect("name" in rows[0]).toBe(false);
  });

  it("clamps a long name to 120 characters by code points (an emoji is never split)", () => {
    expect(ORDER_SHEET_LIMITS.name).toBe(120);
    const long = parseDraft(JSON.stringify({ version: 1, rows: [{ id: 1, qty: "", unit: "", name: "n".repeat(500) }] })).rows[0];
    expect(long.name).toBe("n".repeat(120));
    const pills = parseDraft(JSON.stringify({ version: 1, rows: [{ id: 1, qty: "", unit: "", name: PILL.repeat(300) }] })).rows[0];
    expect(Array.from(pills.name ?? "")).toHaveLength(120);
    expect(pills.name?.isWellFormed()).toBe(true);
    const exactly = "x".repeat(120);
    expect(parseDraft(JSON.stringify({ version: 1, rows: [{ id: 1, qty: "", unit: "", name: exactly }] })).rows[0].name).toBe(exactly);
    // a huge name (under the raw-size guard) is cut without blowing up
    const huge = parseDraft(JSON.stringify({ version: 1, rows: [{ id: 1, qty: "", unit: "", name: "h".repeat(1_500_000) }] })).rows[0];
    expect(huge.name).toBe("h".repeat(120));
  });

  it("cleanRowName: text is cut to 120 code points, anything else (or blank) is 'no name', cleaning twice changes nothing", () => {
    expect(cleanRowName("Alpha")).toBe("Alpha");
    expect(cleanRowName("  padded  ")).toBe("  padded  "); // not trimmed: shown as the item is called
    expect(cleanRowName(PILL.repeat(200))).toBe(PILL.repeat(120));
    for (const bad of [undefined, null, 5, {}, [], "", "  ", "\n\t", Symbol("x"), () => "x"]) expect(cleanRowName(bad as unknown)).toBeUndefined();
    for (const text of ["Alpha", PILL.repeat(200), "a".repeat(119) + " b c d", "x".repeat(120)]) {
      const once = cleanRowName(text);
      expect(cleanRowName(once)).toBe(once);
    }
  });

  it("round-trips through serialize/parse exactly and is idempotent when sanitized again", () => {
    const draft = draftWith({
      rows: [
        { id: 12, qty: "007", unit: "cardboard box ", name: 'Acetaminophen 160 mg/5 mL, "children\'s" suspension' },
        { id: 3, qty: "", unit: "" },
        { id: 44, qty: "5", unit: "", name: "日本語の薬品名 💊 " + PILL },
      ],
    });
    expect(parseDraft(serializeDraft(draft))).toEqual(draft);
    const once = sanitizeDraft(draft);
    expect(sanitizeDraft(once)).toEqual(once);
    expect(serializeDraft(once)).toBe(serializeDraft(draft));
  });

  it("keeps each name with its own id however the stored rows are ordered; a repeated id keeps the first row's name", () => {
    const ordered = [
      { id: 1, qty: "", unit: "", name: "One" },
      { id: 2, qty: "", unit: "", name: "Two" },
      { id: 3, qty: "", unit: "", name: "Three" },
    ];
    const shuffled = [ordered[2], ordered[0], ordered[1]];
    const rows = parseDraft(JSON.stringify({ version: 1, rows: shuffled })).rows;
    expect(rows.map((r) => [r.id, r.name])).toEqual([[3, "Three"], [1, "One"], [2, "Two"]]);
    const dup = parseDraft(
      JSON.stringify({ version: 1, rows: [{ id: 1, qty: "1", unit: "", name: "First" }, { id: 2, qty: "", unit: "" }, { id: "1", qty: "9", unit: "", name: "Second" }] })
    ).rows;
    expect(dup.map((r) => [r.id, r.qty, r.name])).toEqual([[1, "1", "First"], [2, "", undefined]]);
  });

  it("hostile names stay inert text: markup, script, formulas and prototype keys are only ever stored as strings", () => {
    const hostile = [
      '<img src=x onerror="alert(1)">',
      '"><script>window.__pwned=1</script>',
      "javascript:alert(1)",
      '=HYPERLINK("http://example.invalid","click")',
      "+1+1",
      "@SUM(A1:A2)",
      "__proto__",
      "constructor",
      "toString",
      "{{7*7}} ${7*7} %s %d",
      "line one\nline two\r\ttab",
    ];
    const rows = hostile.map((name, i) => ({ id: i + 1, qty: "", unit: "", name }));
    const parsed = parseDraft(JSON.stringify({ version: 1, rows }));
    expect(parsed.rows.map((r) => r.name)).toEqual(hostile); // verbatim, nothing escaped, stripped or executed
    for (const row of parsed.rows) expect(typeof row.name).toBe("string");
    expect(Object.keys(parsed.rows[0]).sort()).toEqual(["id", "name", "qty", "unit"]); // no extra keys appear
    expect(parseDraft(serializeDraft(parsed)).rows).toEqual(parsed.rows);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // a hostile ROW (prototype keys, nested objects) does not leak anything either
    const raw =
      '{"version":1,"rows":[{"id":1,"qty":"","unit":"","name":"ok","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}]}';
    const row = parseDraft(raw).rows[0];
    expect(row).toEqual({ id: 1, qty: "", unit: "", name: "ok" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(row).sort()).toEqual(["id", "name", "qty", "unit"]);
  });

  it("parseDraft stays total for rows with odd names (never throws)", () => {
    const odd = [Number.NaN, Number.POSITIVE_INFINITY, -0, 1e308, "\u0000", "\ud800" /* lone surrogate */, { a: { b: { c: [1, 2, 3] } } }];
    for (const name of odd) {
      const raw = JSON.stringify({ version: 1, rows: [{ id: 1, qty: "", unit: "", name }] });
      expect(() => parseDraft(raw)).not.toThrow();
      expect(parseDraft(raw).rows).toHaveLength(1);
    }
  });

  it("addRows remembers the names of the rows it ADDS and never renames a row that is already on the sheet", () => {
    const base = named();
    const added = addRows(base, [3, 4, 5], new Map([[3, "RENAMED Gamma"], [4, "Delta"], [5, "Epsilon"], [99, "Not added"]]));
    expect(added.rows.map((r) => [r.id, r.name])).toEqual([[1, "Alpha 10 mg, tablets"], [2, "Beta"], [3, "Gamma"], [4, "Delta"], [5, "Epsilon"]]);
    expect(added.rows[2]).toBe(base.rows[2]); // untouched row, same object
    expect(added.rows.every((r) => r.id !== 99)).toBe(true);
  });

  it("addRows without names (or with unusable names) adds rows without a name key", () => {
    for (const names of [undefined, new Map<number, string>(), new Map([[1, ""]]), new Map([[1, "   "]]), new Map([[1, 5 as unknown as string]]), new Map([[2, "other id"]])]) {
      const rows = addRows(DEFAULT_DRAFT, [1], names).rows;
      expect(rows).toEqual([{ id: 1, qty: "", unit: "" }]);
      expect("name" in rows[0]).toBe(false);
    }
    // not a Map at all: ignored, no throw
    for (const bogus of [{ 1: "Alpha" }, ["Alpha"], "Alpha", 7, null]) {
      expect(() => addRows(DEFAULT_DRAFT, [1], bogus as unknown as ReadonlyMap<number, string>)).not.toThrow();
      expect(addRows(DEFAULT_DRAFT, [1], bogus as unknown as ReadonlyMap<number, string>).rows).toEqual([{ id: 1, qty: "", unit: "" }]);
    }
  });

  it("addRows clamps a long name and keeps a hostile one verbatim; the row cap still applies", () => {
    const rows = addRows(DEFAULT_DRAFT, [1, 2], new Map([[1, PILL.repeat(400)], [2, "<b>x</b>"]])).rows;
    expect(Array.from(rows[0].name ?? "")).toHaveLength(120);
    expect(rows[1].name).toBe("<b>x</b>");
    const ids = Array.from({ length: ORDER_SHEET_LIMITS.rows + 5 }, (_, i) => i + 1);
    const names = new Map(ids.map((id) => [id, `Item ${id}`] as const));
    const full = addRows(DEFAULT_DRAFT, ids, names);
    expect(full.rows).toHaveLength(ORDER_SHEET_LIMITS.rows);
    expect(full.rows.every((r) => r.name === `Item ${r.id}`)).toBe(true);
  });

  it("toggleRow remembers the name when it adds, removes without caring about it, and ignores a non-text second argument", () => {
    const on = toggleRow(DEFAULT_DRAFT, 6, "Zeta 5 mg");
    expect(on.rows).toEqual([{ id: 6, qty: "", unit: "", name: "Zeta 5 mg" }]);
    expect(toggleRow(on, 6, "ignored").rows).toEqual([]);
    expect(toggleRow(DEFAULT_DRAFT, 6).rows).toEqual([{ id: 6, qty: "", unit: "" }]); // no name given: none stored
    // `[1, 2, 3].forEach(toggle)` calls toggle(id, index, array): an index is not a name
    let d: OrderDraft = DEFAULT_DRAFT;
    [1, 2, 3].forEach((id, index, all) => {
      d = (toggleRow as (draft: OrderDraft, id: number, name?: unknown, ...rest: unknown[]) => OrderDraft)(d, id, index, all);
    });
    expect(d.rows).toEqual([{ id: 1, qty: "", unit: "" }, { id: 2, qty: "", unit: "" }, { id: 3, qty: "", unit: "" }]);
    expect(toggleRow(DEFAULT_DRAFT, 0 as number, "x")).toBe(DEFAULT_DRAFT); // an invalid id adds nothing, whatever the name
    expect(toggleRow(DEFAULT_DRAFT, 7, "x" as string).rows[0].id).toBe(7);
  });

  it("updateRow keeps the name (qty and unit edits), cannot change it, and still returns the same object when nothing changes", () => {
    const d = named();
    const typed = updateRow(updateRow(d, 2, { qty: "12" }), 2, { unit: "case of 6" });
    expect(typed.rows[1]).toEqual({ id: 2, qty: "12", unit: "case of 6", name: "Beta" });
    expect(typed.rows[0]).toBe(d.rows[0]);
    expect(typed.rows[2]).toBe(d.rows[2]);
    const sneaky = updateRow(d, 1, { qty: "7", name: "EVIL", id: 99 } as unknown as { qty: string });
    expect(sneaky.rows[0]).toEqual({ id: 1, qty: "7", unit: "box", name: "Alpha 10 mg, tablets" });
    expect(updateRow(d, 1, { qty: "2", unit: "box" })).toBe(d);
    expect(updateRow(d, 1, {})).toBe(d);
    expect(updateRow(d, 99, { qty: "1" })).toBe(d);
  });

  it("names survive removing rows, toggling a row off and on, and clearing/adding again; a re-added row is a new row", () => {
    const d = named();
    const without = removeRow(d, 2);
    expect(without.rows.map((r) => [r.id, r.name])).toEqual([[1, "Alpha 10 mg, tablets"], [3, "Gamma"]]);
    const back = toggleRow(without, 2, "Beta"); // moves to the end, like any newly added row
    expect(back.rows.map((r) => [r.id, r.name])).toEqual([[1, "Alpha 10 mg, tablets"], [3, "Gamma"], [2, "Beta"]]);
    expect(back.rows[2]).toEqual({ id: 2, qty: "", unit: "", name: "Beta" }); // qty/unit start empty again
    const cleared = clearRows(d);
    expect(cleared.rows).toEqual([]);
    expect(addRows(cleared, [1], new Map([[1, "Alpha again"]])).rows).toEqual([{ id: 1, qty: "", unit: "", name: "Alpha again" }]);
    // the title and the other options are untouched by all of it
    expect(removeRow(d, 2)).toMatchObject({ title: d.title, paper: d.paper });
  });

  it("rememberNames sets missing names and refreshes changed ones without touching qty, unit or the order", () => {
    const d = draftWith({
      rows: [
        { id: 1, qty: "2", unit: "box" },
        { id: 2, qty: "", unit: "", name: "Old Beta" },
        { id: 3, qty: "9", unit: "case", name: "Gamma" },
      ],
    });
    const next = rememberNames(d, new Map([[1, "Alpha"], [2, "New Beta"], [3, "Gamma"]]));
    expect(next.rows).toEqual([
      { id: 1, qty: "2", unit: "box", name: "Alpha" },
      { id: 2, qty: "", unit: "", name: "New Beta" },
      { id: 3, qty: "9", unit: "case", name: "Gamma" },
    ]);
    expect(next.rows[2]).toBe(d.rows[2]); // unchanged row: same object
    expect(next).toMatchObject({ title: d.title, paper: d.paper, date: d.date });
  });

  it("rememberNames returns the SAME draft when nothing changes, so applying it twice is a no-op", () => {
    const d = named();
    const names = new Map([[1, "Alpha 10 mg, tablets"], [2, "Beta"], [3, "Gamma"]]);
    expect(rememberNames(d, names)).toBe(d);
    const legacy = draftWith({ rows: [{ id: 1, qty: "", unit: "" }] });
    const once = rememberNames(legacy, new Map([[1, "Alpha"]]));
    expect(once).not.toBe(legacy);
    expect(rememberNames(once, new Map([[1, "Alpha"]]))).toBe(once);
    expect(rememberNames(DEFAULT_DRAFT, new Map([[1, "Alpha"]]))).toBe(DEFAULT_DRAFT);
    expect(rememberNames(d, new Map())).toBe(d);
  });

  it("rememberNames never erases a known name: a missing id, blank text or a non-text value leaves the row as it is", () => {
    const d = named();
    const next = rememberNames(d, new Map<number, string>([[1, ""], [2, "   "], [3, 42 as unknown as string], [99, "Not on the sheet"]]));
    expect(next).toBe(d);
    // an item that is gone from the inventory is simply absent from the map: its row keeps what it was called
    const partial = rememberNames(d, new Map([[1, "Alpha renamed"]]));
    expect(partial.rows.map((r) => r.name)).toEqual(["Alpha renamed", "Beta", "Gamma"]);
  });

  it("rememberNames clamps names, keeps hostile ones as plain text and never throws on a bad map", () => {
    const d = draftWith({ rows: [{ id: 1, qty: "", unit: "" }, { id: 2, qty: "", unit: "" }] });
    const next = rememberNames(d, new Map([[1, PILL.repeat(400)], [2, '<script>alert("x")</script>']]));
    expect(Array.from(next.rows[0].name ?? "")).toHaveLength(120);
    expect(next.rows[1].name).toBe('<script>alert("x")</script>');
    for (const bogus of [undefined, null, {}, [], "x", 5, { get: () => "x" }]) {
      expect(() => rememberNames(d, bogus as unknown as ReadonlyMap<number, string>)).not.toThrow();
      expect(rememberNames(d, bogus as unknown as ReadonlyMap<number, string>)).toBe(d);
    }
  });

  it("the row helpers stay total: odd ids, odd patches and odd name arguments never throw and change nothing they should not", () => {
    const d = named();
    for (const ids of [undefined, null, 5, "123", {}, true] as unknown[]) {
      expect(() => addRows(d, ids as number[], new Map([[1, "x"]]))).not.toThrow();
      expect(addRows(d, ids as number[])).toBe(d);
    }
    expect(addRows(d, new Set([8, 9]) as unknown as number[]).rows.map((r) => r.id)).toEqual([1, 2, 3, 8, 9]); // any iterable of ids works
    for (const patch of [undefined, null, 5, "qty", true, []] as unknown[]) {
      expect(() => updateRow(d, 1, patch as { qty: string })).not.toThrow();
      expect(updateRow(d, 1, patch as { qty: string })).toBe(d);
    }
    for (const id of [Number.NaN, -1, 0, 1.5, Number.POSITIVE_INFINITY, "7", null, undefined] as unknown[]) {
      expect(() => toggleRow(d, id as number, "name")).not.toThrow();
      expect(() => removeRow(d, id as number)).not.toThrow();
      expect(() => hasRow(d, id as number)).not.toThrow();
    }
    expect(toggleRow(d, Number.NaN, "x")).toBe(d);
    expect(toggleRow(d, 1.5, "x")).toBe(d);
  });

  it("none of the name helpers mutate their input (they work on deeply frozen drafts)", () => {
    const frozen = deepFreeze(named());
    expect(() => {
      addRows(frozen, [4], new Map([[4, "Delta"]]));
      toggleRow(frozen, 5, "Epsilon");
      toggleRow(frozen, 1, "x");
      removeRow(frozen, 2);
      updateRow(frozen, 1, { qty: "1" });
      rememberNames(frozen, new Map([[1, "Alpha renamed"], [2, "Beta renamed"]]));
      clearRows(frozen);
      serializeDraft(frozen);
    }).not.toThrow();
    expect(frozen.rows.map((r) => r.name)).toEqual(["Alpha 10 mg, tablets", "Beta", "Gamma"]);
  });

  it("the names add little to what is stored: 500 rows with 120-character names stay far below the size guard", () => {
    const rows = Array.from({ length: ORDER_SHEET_LIMITS.rows }, (_, i) => ({ id: i + 1, qty: "123456789", unit: "u".repeat(40), name: "N".repeat(120) }));
    const text = serializeDraft(draftWith({ rows }));
    expect(text.length).toBeLessThan(200_000);
    expect(parseDraft(text).rows).toHaveLength(ORDER_SHEET_LIMITS.rows);
  });
});

describe("putting rows back (Undo of a removal) and taking exactly some rows off (Undo of an Add all)", () => {
  const A = { id: 1, qty: "12", unit: "boxes", name: "Alpha" };
  const B = { id: 2, qty: "24", unit: "bottles", name: "Beta" };
  const C = { id: 3, qty: "6", unit: "packs", name: "Gamma" };

  it("restoreRow puts a removed row back at its place with its quantity, unit and remembered name", () => {
    const before = draftWith({ rows: [A, B, C] });
    const afterRemove = removeRow(before, B.id);
    expect(afterRemove.rows.map((r) => r.id)).toEqual([1, 3]);
    const restored = restoreRow(afterRemove, B, 1);
    expect(restored.rows).toEqual([A, B, C]);
    expect(restored).toEqual(before);
  });

  it("restoreRow keeps whatever was typed in other rows in the meantime", () => {
    const afterRemove = removeRow(draftWith({ rows: [A, B, C] }), B.id);
    const edited = updateRow(afterRemove, C.id, { qty: "99", unit: "cases" });
    const restored = restoreRow(edited, B, 1);
    expect(restored.rows).toEqual([A, B, { ...C, qty: "99", unit: "cases" }]);
  });

  it("restoreRow puts the first and the last row back where they were", () => {
    const d = draftWith({ rows: [A, B, C] });
    expect(restoreRow(removeRow(d, A.id), A, 0).rows).toEqual([A, B, C]);
    expect(restoreRow(removeRow(d, C.id), C, 2).rows).toEqual([A, B, C]);
  });

  it("restoreRow clamps a position that no longer exists: too big appends, negative or not a number goes by the rules", () => {
    const d = draftWith({ rows: [A] });
    expect(restoreRow(d, B, 99).rows.map((r) => r.id)).toEqual([1, 2]);
    expect(restoreRow(d, B, -4).rows.map((r) => r.id)).toEqual([2, 1]);
    expect(restoreRow(d, B, Number.NaN).rows.map((r) => r.id)).toEqual([1, 2]);
    expect(restoreRow(d, B, 0.5).rows.map((r) => r.id)).toEqual([1, 2]);
    expect(restoreRow(draftWith(), B, 5).rows).toEqual([B]); // an emptied sheet
  });

  it("restoreRow never makes a second row for an item that is on the sheet again, and returns the SAME draft then", () => {
    const d = draftWith({ rows: [A, { ...B, qty: "1", unit: "x" }] });
    expect(restoreRow(d, B, 1)).toBe(d);
    expect(d.rows).toHaveLength(2);
  });

  it("restoreRow stops at the row limit instead of growing past it", () => {
    const full = draftWith({ rows: Array.from({ length: ORDER_SHEET_LIMITS.rows }, (_, i) => ({ id: i + 10, qty: "", unit: "" })) });
    expect(restoreRow(full, B, 0)).toBe(full);
  });

  it("restoreRow ignores a row it cannot use (no valid id) and cleans lengths like every other way into the draft", () => {
    const d = draftWith({ rows: [A] });
    expect(restoreRow(d, { id: 0, qty: "1", unit: "" }, 0)).toBe(d);
    expect(restoreRow(d, { id: 1.5, qty: "1", unit: "" }, 0)).toBe(d);
    expect(restoreRow(d, null as unknown as typeof B, 0)).toBe(d);
    const long = restoreRow(d, { id: 5, qty: "9".repeat(300), unit: "u".repeat(99), name: "N".repeat(400) }, 1).rows[1];
    expect(long.qty).toHaveLength(ORDER_SHEET_LIMITS.qtyTyped);
    expect(long.unit).toBe("u".repeat(ORDER_SHEET_LIMITS.unit));
    expect(Array.from(long.name ?? "")).toHaveLength(ORDER_SHEET_LIMITS.name);
  });

  it("restoreRow never changes its input (works on a deeply frozen draft and row)", () => {
    const frozen = deepFreeze(draftWith({ rows: [A, C] }));
    const row = deepFreeze({ ...B });
    expect(() => restoreRow(frozen, row, 1)).not.toThrow();
    expect(restoreRow(frozen, row, 1).rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("removeRows takes off exactly the listed rows and leaves the others, in order, with what was typed", () => {
    const d = draftWith({ rows: [A, B, C], title: "Kept" });
    const next = removeRows(d, [2, 3]);
    expect(next.rows).toEqual([A]);
    expect(next.title).toBe("Kept");
    expect(next.rows[0]).toBe(d.rows[0]); // the row that stays is not re-created
  });

  it("removeRows ignores ids that are not on the sheet, repeated ids and junk, and returns the SAME draft when nothing matches", () => {
    const d = draftWith({ rows: [A, B] });
    expect(removeRows(d, [7, 8])).toBe(d);
    expect(removeRows(d, [])).toBe(d);
    expect(removeRows(d, undefined as unknown as number[])).toBe(d);
    expect(removeRows(d, [2, 2, 2, Number.NaN, -1, "x" as unknown as number]).rows).toEqual([A]);
  });

  it("an Add all followed by removeRows of exactly what it added gives back the sheet as it was (typed values included)", () => {
    const before = draftWith({ rows: [{ id: 1, qty: "5", unit: "box", name: "Alpha" }] });
    const added = addRows(before, [1, 2, 3], new Map([[2, "Beta"], [3, "Gamma"]]));
    const addedIds = added.rows.slice(before.rows.length).map((r) => r.id);
    expect(addedIds).toEqual([2, 3]); // row 1 was already there: it is not part of the action
    expect(removeRows(added, addedIds)).toEqual(before);
  });

  it("removeRows never changes its input", () => {
    const frozen = deepFreeze(draftWith({ rows: [A, B, C] }));
    expect(removeRows(frozen, [1]).rows.map((r) => r.id)).toEqual([2, 3]);
  });
});

describe("dates", () => {
  it("todayISO formats the LOCAL calendar date with zero padding", () => {
    expect(todayISO(new Date(2026, 0, 5, 23, 59, 59))).toBe("2026-01-05");
    expect(todayISO(new Date(2026, 11, 31, 0, 0, 0))).toBe("2026-12-31");
    expect(todayISO(new Date(2026, 2, 4, 12, 0, 0))).toBe("2026-03-04");
    expect(todayISO(new Date(2024, 1, 29, 8, 0, 0))).toBe("2024-02-29");
  });

  it("todayISO uses the local date, not the UTC date (an evening order is not dated tomorrow)", (ctx) => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const evening = new Date("2026-01-06T07:30:00Z"); // 23:30 on Jan 5 in Los Angeles
      // Some runtimes (e.g. worker threads) cannot change the time zone at run time; then this check cannot be made.
      if (evening.getDate() !== 5) ctx.skip();
      expect(evening.toISOString().slice(0, 10)).toBe("2026-01-06");
      expect(todayISO(evening)).toBe("2026-01-05");

      process.env.TZ = "Pacific/Kiritimati"; // UTC+14
      const morning = new Date("2026-01-05T12:00:00Z"); // 02:00 on Jan 6 locally
      expect(morning.toISOString().slice(0, 10)).toBe("2026-01-05");
      expect(todayISO(morning)).toBe("2026-01-06");
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("todayISO falls back to the current date for an invalid Date", () => {
    expect(isValidISODate(todayISO(new Date(Number.NaN)))).toBe(true);
    expect(isValidISODate(todayISO())).toBe(true);
  });

  it("resolveDate prefers the typed date and otherwise uses today", () => {
    expect(resolveDate(draftWith({ date: "2026-01-02" }), "2030-05-06")).toBe("2026-01-02");
    expect(resolveDate(draftWith({ date: null }), "2030-05-06")).toBe("2030-05-06");
  });

  it("isValidISODate is strict", () => {
    expect(isValidISODate("2026-11-05")).toBe(true);
    expect(isValidISODate("2026-11-5")).toBe(false);
    expect(isValidISODate("2026-02-29")).toBe(false);
    expect(isValidISODate("2100-02-29")).toBe(false); // outside the accepted years (2100 is not a leap year either)
    expect(isValidISODate("2000-02-29")).toBe(true); // 2000 is a leap year (divisible by 400)
    expect(isValidISODate("2096-02-29")).toBe(true);
    expect(isValidISODate("2097-02-29")).toBe(false);
    expect(isValidISODate(20261105)).toBe(false);
    expect(isValidISODate(undefined)).toBe(false);
  });

  it("isValidISODate accepts exactly the years 2000 to 2099", () => {
    expect([MIN_SHEET_YEAR, MAX_SHEET_YEAR]).toEqual([2000, 2099]);
    expect(isValidISODate("2000-01-01")).toBe(true);
    expect(isValidISODate("2099-12-31")).toBe(true);
    expect(isValidISODate("1999-12-31")).toBe(false);
    expect(isValidISODate("2100-01-01")).toBe(false);
    // a year typed as "26" is read by the browser as year 0026, and "20265" as a fifth digit: neither is a real order date
    expect(isValidISODate("0026-11-05")).toBe(false);
    expect(isValidISODate("0001-01-01")).toBe(false);
    expect(isValidISODate("9999-12-31")).toBe(false);
    expect(isValidISODate("20265-11-05")).toBe(false);
    // every month of the first and last accepted year is still checked as a real calendar date
    for (const year of [2000, 2099]) {
      for (let month = 1; month <= 12; month += 1) {
        const mm = String(month).padStart(2, "0");
        expect(isValidISODate(`${year}-${mm}-01`), `${year}-${mm}-01`).toBe(true);
        expect(isValidISODate(`${year}-${mm}-32`), `${year}-${mm}-32`).toBe(false);
      }
    }
  });
});

// ── The browser store behind useOrderDraft ──────────────────────────────────────────────────────────────────────────
// The store is plain module state over window.localStorage, so it can be exercised in Node with a fake window.

class FakeStorage {
  readonly map = new Map<string, string>();
  gets = 0;
  sets = 0;
  getItem(key: string): string | null {
    this.gets += 1;
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.sets += 1;
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function installWindow(storage: unknown): EventTarget {
  // HTMLIFrameElement is only here for the tests that render with React DOM (see reactHarness): it checks it after a commit.
  const win = Object.assign(new EventTarget(), { localStorage: storage, HTMLIFrameElement: class {} });
  vi.stubGlobal("window", win);
  return win;
}

function storageEvent(key: string | null): Event {
  return Object.assign(new Event("storage"), { key });
}

/** A fresh copy of the store modules (module state is per-import), so tests cannot leak into each other. */
async function loadStore() {
  vi.resetModules();
  const hook = await import("@/lib/order-sheet/use-order-draft");
  const draft = await import("@/lib/order-sheet/draft");
  return { store: hook.orderDraftStore, useOrderDraft: hook.useOrderDraft, draft };
}

describe("draft store (the state behind useOrderDraft)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getServerSnapshot is the shared empty draft, even in a browser", async () => {
    const { store, draft } = await loadStore();
    installWindow(new FakeStorage());
    expect(store.getServerSnapshot()).toBe(draft.DEFAULT_DRAFT);
    expect(store.getServerSnapshot()).toBe(store.getServerSnapshot());
  });

  it("getServerSnapshot stays the empty draft even when this browser holds a saved draft (server render and hydration must match)", async () => {
    const { store, draft } = await loadStore();
    const storage = new FakeStorage();
    storage.map.set(draft.STORAGE_KEY, draft.serializeDraft(draftWith({ rows: [{ id: 3, qty: "4", unit: "box" }], title: "Saved in this browser" })));
    installWindow(storage);
    expect(store.getSnapshot().rows).toHaveLength(1); // the browser really does have a draft...
    expect(store.getServerSnapshot()).toBe(draft.DEFAULT_DRAFT); // ...but the server snapshot never reads it
    expect(store.getServerSnapshot().rows).toEqual([]);
  });

  it("returns the identical snapshot object until the stored text changes (no render loop)", async () => {
    const { store, draft } = await loadStore();
    const storage = new FakeStorage();
    installWindow(storage);
    const first = store.getSnapshot();
    expect(first).toBe(draft.DEFAULT_DRAFT);
    const seen = new Set<unknown>();
    for (let i = 0; i < 1000; i += 1) seen.add(store.getSnapshot());
    expect(seen.size).toBe(1);

    store.update((d) => draft.addRows(d, [1, 2]));
    const afterUpdate = store.getSnapshot();
    expect(afterUpdate).not.toBe(first);
    for (let i = 0; i < 1000; i += 1) expect(store.getSnapshot()).toBe(afterUpdate);
  });

  it("also keeps one object when it re-reads pre-existing stored text", async () => {
    const { store, draft } = await loadStore();
    const storage = new FakeStorage();
    storage.map.set(draft.STORAGE_KEY, draft.serializeDraft(draftWith({ rows: [{ id: 3, qty: "4", unit: "box" }] })));
    installWindow(storage);
    const a = store.getSnapshot();
    expect(a.rows).toEqual([{ id: 3, qty: "4", unit: "box" }]);
    expect(store.getSnapshot()).toBe(a);
    expect(store.getSnapshot()).toBe(a);
  });

  it("persists an update to localStorage and notifies subscribers in the same tab", async () => {
    const { store, draft } = await loadStore();
    const storage = new FakeStorage();
    const win = installWindow(storage);
    const calls: number[] = [];
    const unsubscribe = store.subscribe(() => calls.push(store.getSnapshot().rows.length));

    store.update((d) => draft.addRows(d, [10]));
    expect(calls).toEqual([1]);
    expect(JSON.parse(storage.map.get(draft.STORAGE_KEY) as string)).toMatchObject({
      version: 1,
      rows: [{ id: 10, qty: "", unit: "" }],
    });

    // a second, independent subscriber (another hook instance) hears the same event
    const other: number[] = [];
    const off2 = store.subscribe(() => other.push(1));
    store.update((d) => draft.toggleRow(d, 11));
    expect(calls).toEqual([1, 2]);
    expect(other).toEqual([1]);

    unsubscribe();
    off2();
    store.update((d) => draft.toggleRow(d, 12));
    expect(calls).toEqual([1, 2]); // unsubscribed
    win.dispatchEvent(new Event(draft.DRAFT_EVENT));
    expect(calls).toEqual([1, 2]);
  });

  it("a no-op update neither writes nor notifies nor changes the snapshot", async () => {
    const { store, draft } = await loadStore();
    const storage = new FakeStorage();
    installWindow(storage);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    const before = store.getSnapshot();
    store.update((d) => draft.clearRows(d)); // already empty
    store.update((d) => draft.removeRow(d, 123)); // not there
    store.update((d) => draft.addRows(d, [])); // nothing to add
    store.update((d) => ({ ...d })); // a new object with identical content
    expect(storage.sets).toBe(0);
    expect(notified).toBe(0);
    expect(store.getSnapshot()).toBe(before);
  });

  it("reacts to changes made by another tab (storage event) and ignores unrelated keys", async () => {
    const { store, draft } = await loadStore();
    const storage = new FakeStorage();
    const win = installWindow(storage);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    const before = store.getSnapshot();

    win.dispatchEvent(storageEvent("some.other.key"));
    expect(notified).toBe(0);

    storage.map.set(draft.STORAGE_KEY, draft.serializeDraft(draftWith({ rows: [{ id: 8, qty: "2", unit: "" }], title: "From tab B" })));
    win.dispatchEvent(storageEvent(draft.STORAGE_KEY));
    expect(notified).toBe(1);
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.title).toBe("From tab B");
    expect(after.rows.map((r) => r.id)).toEqual([8]);
    expect(store.getSnapshot()).toBe(after);

    // localStorage.clear() in another tab arrives as key === null
    storage.map.clear();
    win.dispatchEvent(storageEvent(null));
    expect(notified).toBe(2);
    expect(store.getSnapshot()).toBe(draft.DEFAULT_DRAFT);
  });

  it("starts from the empty draft when the stored text is corrupt, and the next update repairs it", async () => {
    const { store, draft } = await loadStore();
    const storage = new FakeStorage();
    storage.map.set(draft.STORAGE_KEY, '{"version":1,"rows":[{"id":1');
    installWindow(storage);
    expect(() => store.getSnapshot()).not.toThrow();
    expect(store.getSnapshot()).toBe(draft.DEFAULT_DRAFT);
    store.update((d) => draft.addRows(d, [4]));
    expect(store.getSnapshot().rows.map((r) => r.id)).toEqual([4]);
    expect(() => JSON.parse(storage.map.get(draft.STORAGE_KEY) as string)).not.toThrow();
  });

  it("update() starts from what is in storage right now, so a change another tab has saved is not overwritten", async () => {
    const { store, draft } = await loadStore();
    const storage = new FakeStorage();
    installWindow(storage);
    store.update((d) => draft.addRows(d, [1])); // this tab's cache now holds row 1
    // Another tab saves its own draft. The "storage" event has not reached this tab (events arrive later), but the next
    // update must still be built on the stored draft, not on this tab's cached copy.
    storage.map.set(
      draft.STORAGE_KEY,
      draft.serializeDraft(draftWith({ rows: [{ id: 5, qty: "2", unit: "case" }], title: "From tab B", paper: "a4" }))
    );
    store.update((d) => draft.addRows(d, [9]));
    expect(store.getSnapshot().rows).toEqual([
      { id: 5, qty: "2", unit: "case" },
      { id: 9, qty: "", unit: "" },
    ]);
    expect(store.getSnapshot()).toMatchObject({ title: "From tab B", paper: "a4" });
    const stored = JSON.parse(storage.map.get(draft.STORAGE_KEY) as string) as { rows: Array<{ id: number }> };
    expect(stored.rows.map((r) => r.id)).toEqual([5, 9]); // and what was written back keeps the other tab's row
  });

  it("composes two updates made back to back instead of overwriting the first", async () => {
    const { store, draft } = await loadStore();
    installWindow(new FakeStorage());
    store.update((d) => draft.toggleRow(d, 1));
    store.update((d) => draft.toggleRow(d, 2));
    store.update((d) => draft.updateRow(d, 2, { qty: "6" }));
    expect(store.getSnapshot().rows).toEqual([
      { id: 1, qty: "", unit: "" },
      { id: 2, qty: "6", unit: "" },
    ]);
  });

  it("keeps typed text as typed (a trailing space survives) and enforces the length limits itself", async () => {
    const { store, draft } = await loadStore();
    installWindow(new FakeStorage());
    store.update((d) => draft.addRows(d, [1]));
    store.update((d) => draft.updateRow(d, 1, { unit: "cardboard " }));
    expect(store.getSnapshot().rows[0].unit).toBe("cardboard ");
    store.update((d) => ({ ...d, notes: "n".repeat(5000), title: "" }));
    expect(store.getSnapshot().notes).toHaveLength(ORDER_SHEET_LIMITS.notes);
    expect(store.getSnapshot().title).toBe(""); // an emptied title stays empty
  });

  it("works from memory when reading localStorage throws", async () => {
    const { store, draft } = await loadStore();
    const storage = {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("SecurityError");
      },
    };
    installWindow(storage);
    expect(store.getSnapshot()).toBe(draft.DEFAULT_DRAFT);
    expect(() => store.update((d) => draft.addRows(d, [1, 2]))).not.toThrow();
    const snap = store.getSnapshot();
    expect(snap.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(store.getSnapshot()).toBe(snap);
  });

  it("keeps the new state in memory when a write fails (quota exceeded) instead of showing stale storage", async () => {
    const { store, draft } = await loadStore();
    const storage = new FakeStorage();
    storage.map.set(draft.STORAGE_KEY, draft.serializeDraft(draftWith({ rows: [{ id: 50, qty: "", unit: "" }] })));
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    installWindow(storage);
    expect(store.getSnapshot().rows.map((r) => r.id)).toEqual([50]);
    store.update((d) => draft.addRows(d, [51]));
    expect(store.getSnapshot().rows.map((r) => r.id)).toEqual([50, 51]); // not reverted to the stale stored value
    store.update((d) => draft.toggleRow(d, 50));
    expect(store.getSnapshot().rows.map((r) => r.id)).toEqual([51]);
    const snap = store.getSnapshot();
    expect(store.getSnapshot()).toBe(snap);
  });

  it("works from memory when merely touching window.localStorage throws", async () => {
    const { store, draft } = await loadStore();
    const win = installWindow(null);
    Object.defineProperty(win, "localStorage", {
      get() {
        throw new Error("SecurityError: access denied");
      },
    });
    expect(() => store.getSnapshot()).not.toThrow();
    expect(() => store.update((d) => draft.addRows(d, [7]))).not.toThrow();
    expect(store.getSnapshot().rows.map((r) => r.id)).toEqual([7]);
  });

  it("reports where the draft lives: 'browser' while saving works, 'memory' once the browser refuses a write, and tells subscribers", async () => {
    const { store, draft } = await loadStore();
    const storage = new FakeStorage();
    installWindow(storage);
    const modes: string[] = [];
    store.subscribe(() => modes.push(store.getStorageMode()));

    expect(store.getStorageMode()).toBe("browser");
    store.update((d) => draft.addRows(d, [1]));
    expect(modes).toEqual(["browser"]);

    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    store.update((d) => draft.addRows(d, [2]));
    expect(store.getStorageMode()).toBe("memory");
    expect(modes).toEqual(["browser", "memory"]); // the change that could not be saved is announced together with the new mode
    expect(store.getSnapshot().rows.map((r) => r.id)).toEqual([1, 2]); // and the sheet itself keeps working
  });

  it("keeps trying to save: when the browser accepts writes again the whole draft is stored and the mode returns to 'browser'", async () => {
    const { store, draft } = await loadStore();
    const storage = new FakeStorage();
    installWindow(storage);
    store.update((d) => draft.addRows(d, [1]));

    const realSetItem = storage.setItem.bind(storage);
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    store.update((d) => draft.addRows(d, [2]));
    store.update((d) => draft.addRows(d, [3]));
    expect(store.getStorageMode()).toBe("memory");
    const storedIds = () => (JSON.parse(storage.map.get(draft.STORAGE_KEY) as string) as { rows: Array<{ id: number }> }).rows.map((r) => r.id);
    expect(storedIds()).toEqual([1]); // storage is behind while writes fail

    storage.setItem = realSetItem;
    store.update((d) => draft.addRows(d, [4]));
    expect(store.getStorageMode()).toBe("browser");
    expect(storedIds()).toEqual([1, 2, 3, 4]); // nothing typed in the meantime was lost

    // reads come from storage again, so a change another tab saves afterwards is honoured
    storage.map.set(draft.STORAGE_KEY, draft.serializeDraft(draftWith({ rows: [{ id: 9, qty: "", unit: "" }] })));
    expect(store.getSnapshot().rows.map((r) => r.id)).toEqual([9]);
  });

  it("reports 'memory' as soon as merely reading localStorage throws, and never claims a problem on the server", async () => {
    const { store } = await loadStore();
    expect(store.getServerStorageMode()).toBe("browser");
    installWindow({
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("SecurityError");
      },
    });
    expect(store.getStorageMode()).toBe("browser"); // nothing has been tried yet
    store.getSnapshot();
    expect(store.getStorageMode()).toBe("memory");
    expect(store.getServerStorageMode()).toBe("browser"); // the server snapshot never reports a problem, so markup matches on hydration
  });

  it("is inert on the server: no window means no reads, no writes, no listeners", async () => {
    const { store, draft } = await loadStore();
    expect(typeof window).toBe("undefined");
    expect(store.getSnapshot()).toBe(draft.DEFAULT_DRAFT);
    expect(store.getServerSnapshot()).toBe(draft.DEFAULT_DRAFT);
    expect(() => store.update((d) => draft.addRows(d, [1]))).not.toThrow();
    expect(store.getSnapshot()).toBe(draft.DEFAULT_DRAFT);
    const off = store.subscribe(() => undefined);
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
  });

  it("server-renders through the hook without touching the browser, using the empty draft", async () => {
    const { useOrderDraft } = await loadStore();
    function Probe() {
      const { count, draft } = useOrderDraft();
      return createElement("p", null, `${count}|${draft.title}|${draft.paper}`);
    }
    expect(typeof window).toBe("undefined");
    expect(renderToString(createElement(Probe))).toContain("0|Supply order|letter");
  });

  it("the hook's add / remove / toggle / clear / update act on the shared store", async () => {
    const { store, useOrderDraft } = await loadStore();
    let api: ReturnType<typeof useOrderDraft> | undefined;
    function Probe() {
      api = useOrderDraft();
      return createElement("p", null, String(api.count));
    }
    renderToString(createElement(Probe));
    expect(api).toBeDefined();
    installWindow(new FakeStorage());

    api!.add([1, 2, 2, 3]);
    expect(store.getSnapshot().rows.map((r) => r.id)).toEqual([1, 2, 3]);
    api!.remove(2);
    expect(store.getSnapshot().rows.map((r) => r.id)).toEqual([1, 3]);
    api!.toggle(3);
    api!.toggle(9);
    expect(store.getSnapshot().rows.map((r) => r.id)).toEqual([1, 9]);
    api!.update((d) => ({ ...d, title: "Renamed", paper: "a4" }));
    expect(store.getSnapshot()).toMatchObject({ title: "Renamed", paper: "a4" });
    api!.clear();
    expect(store.getSnapshot().rows).toEqual([]);
    expect(store.getSnapshot().title).toBe("Renamed"); // clear() only removes rows
    expect(api!.has(1)).toBe(false); // bound to the (empty) draft this render saw
  });

  it("saves a name with the row it was added with; refreshing names writes only when a name really changed; typing keeps the name", async () => {
    const { store, draft } = await loadStore();
    const storage = new FakeStorage();
    installWindow(storage);
    const stored = () => JSON.parse(storage.map.get(draft.STORAGE_KEY) as string) as { rows: Array<{ id: number; qty: string; unit: string; name?: string }> };

    store.update((d) => draft.addRows(d, [1, 2], new Map([[1, "Alpha"], [2, "Beta"]])));
    expect(stored().rows).toEqual([{ id: 1, qty: "", unit: "", name: "Alpha" }, { id: 2, qty: "", unit: "", name: "Beta" }]);
    const writes = storage.sets;

    store.update((d) => draft.rememberNames(d, new Map([[1, "Alpha"], [2, "Beta"]]))); // the same names: nothing to do
    expect(storage.sets).toBe(writes);
    store.update((d) => draft.rememberNames(d, new Map([[2, "Beta (renamed)"]])));
    expect(storage.sets).toBe(writes + 1);
    expect(stored().rows.map((r) => r.name)).toEqual(["Alpha", "Beta (renamed)"]);

    store.update((d) => draft.updateRow(d, 1, { qty: "5", unit: "box" }));
    expect(stored().rows[0]).toEqual({ id: 1, qty: "5", unit: "box", name: "Alpha" });
    store.update((d) => draft.removeRow(d, 1));
    expect(stored().rows).toEqual([{ id: 2, qty: "", unit: "", name: "Beta (renamed)" }]);
    expect(store.getSnapshot().rows).toEqual(stored().rows); // memory and storage agree
  });

  it("a draft saved before names existed loads from storage, learns its names once, and then stops writing", async () => {
    const { store, draft } = await loadStore();
    const storage = new FakeStorage();
    storage.map.set(
      draft.STORAGE_KEY,
      JSON.stringify({ version: 1, rows: [{ id: 3, qty: "4", unit: "box" }, { id: 8, qty: "", unit: "" }], title: "Saved last week", date: "2026-10-30", preparedBy: "J", notes: "n", showOnHand: true, showBarcode: false, paper: "a4" })
    );
    installWindow(storage);
    expect(store.getSnapshot().rows).toEqual([{ id: 3, qty: "4", unit: "box" }, { id: 8, qty: "", unit: "" }]);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    const names = new Map([[3, "Cetirizine 10 mg, tablets"]]); // item 8 is not in the inventory any more: nobody knows its name
    store.update((d) => draft.rememberNames(d, names));
    expect(store.getSnapshot().rows).toEqual([{ id: 3, qty: "4", unit: "box", name: "Cetirizine 10 mg, tablets" }, { id: 8, qty: "", unit: "" }]);
    expect(store.getSnapshot()).toMatchObject({ title: "Saved last week", date: "2026-10-30", preparedBy: "J", notes: "n", showOnHand: true, paper: "a4" });
    expect(notified).toBe(1);
    expect(storage.sets).toBe(1);

    store.update((d) => draft.rememberNames(d, names)); // again: no change, no write, no notification
    expect(notified).toBe(1);
    expect(storage.sets).toBe(1);
  });

  it("a name another tab saved arrives with its row (storage event)", async () => {
    const { store, draft } = await loadStore();
    const storage = new FakeStorage();
    const win = installWindow(storage);
    store.getSnapshot();
    storage.map.set(draft.STORAGE_KEY, draft.serializeDraft(draftWith({ rows: [{ id: 6, qty: "1", unit: "", name: "From tab B" }] })));
    win.dispatchEvent(storageEvent(draft.STORAGE_KEY));
    expect(store.getSnapshot().rows).toEqual([{ id: 6, qty: "1", unit: "", name: "From tab B" }]);
  });

  it("keeps remembered names when the browser cannot save (they live in memory with the rest of the draft)", async () => {
    const { store, draft } = await loadStore();
    const storage = new FakeStorage();
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    installWindow(storage);
    store.update((d) => draft.addRows(d, [1], new Map([[1, "Alpha"]])));
    store.update((d) => draft.rememberNames(d, new Map([[1, "Alpha renamed"]])));
    expect(store.getStorageMode()).toBe("memory");
    expect(store.getSnapshot().rows).toEqual([{ id: 1, qty: "", unit: "", name: "Alpha renamed" }]);
  });

  it("uses the documented storage key and event name", async () => {
    const { draft } = await loadStore();
    expect(draft.STORAGE_KEY).toBe("medinventory.orderSheet.v1");
    expect(draft.DRAFT_EVENT).toBe("medinventory:orderDraft");
    expect(DRAFT_EVENT).toBe("medinventory:orderDraft");
  });
});

// ── The hook itself, rendered and re-rendered by the real React ─────────────────────────────────────────────────────
// The store tests above cannot see what the hook does between renders: a wrong useCallback / useMemo dependency list
// (has() answering from an old draft, the returned object never refreshing, a new object on every render) only shows
// when a component is rendered more than once. No DOM library (jsdom / happy-dom) is installed, and the hook needs none:
// it only talks to localStorage and window events. React DOM just needs a container that looks like an element (it reads
// the tag name) and a window that has HTMLIFrameElement (it checks that when it restores focus after a commit). The probe
// component renders null, so no DOM node is ever created. The reconciler and useSyncExternalStore / useCallback /
// useMemo are the real ones, running the real hook.

type Mounted = {
  /** Every value the hook returned, one per render of the probe component */
  renders: UseOrderDraft[];
  readonly latest: UseOrderDraft;
  render(tick?: number): Promise<void>;
  unmount(): Promise<void>;
};

const reactRoots: Array<{ unmount(): void }> = [];

async function reactHarness() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const loaded = await loadStore();
  const storage = new FakeStorage();
  const win = installWindow(storage);

  function mount(): Mounted {
    const renders: UseOrderDraft[] = [];
    function Probe(props: { tick: number }) {
      void props.tick; // a new tick re-renders the component without touching the store
      renders.push(loaded.useOrderDraft());
      return null;
    }
    const container = {
      nodeType: 1,
      tagName: "DIV",
      addEventListener() {},
      removeEventListener() {},
      ownerDocument: null,
    } as unknown as Element;
    const root = createRoot(container);
    reactRoots.push(root);
    return {
      renders,
      get latest() {
        return renders[renders.length - 1];
      },
      render: (tick = 1) =>
        act(async () => {
          root.render(createElement(Probe, { tick }));
        }),
      unmount: () =>
        act(async () => {
          root.unmount();
        }),
    };
  }
  return { ...loaded, storage, win, mount };
}

describe("useOrderDraft rendered by React", () => {
  afterEach(async () => {
    for (const root of reactRoots.splice(0)) {
      try {
        await act(async () => {
          root.unmount();
        });
      } catch {
        // already unmounted
      }
    }
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.unstubAllGlobals();
  });

  it("re-renders with the new draft after add / remove / toggle / update / clear: count, draft and has() all follow the store", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await reactHarness();
    const view = h.mount();
    await view.render();
    expect(view.latest.count).toBe(0);
    expect(view.latest.has(1)).toBe(false);

    await act(async () => {
      view.latest.add([1, 2, 2, 3]);
    });
    expect(view.latest.count).toBe(3);
    expect(view.latest.draft.rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect([1, 2, 3, 4].map((id) => view.latest.has(id))).toEqual([true, true, true, false]);

    await act(async () => {
      view.latest.remove(2);
    });
    expect(view.latest.count).toBe(2);
    expect([1, 2, 3, 4].map((id) => view.latest.has(id))).toEqual([true, false, true, false]);

    await act(async () => {
      view.latest.toggle(4);
      view.latest.toggle(1);
    });
    expect([1, 2, 3, 4].map((id) => view.latest.has(id))).toEqual([false, false, true, true]);

    await act(async () => {
      view.latest.update((d) => h.draft.updateRow({ ...d, title: "Renamed" }, 4, { qty: "6" }));
    });
    expect(view.latest.draft.title).toBe("Renamed");
    expect(view.latest.draft.rows.find((r) => r.id === 4)?.qty).toBe("6");
    expect(view.latest.count).toBe(2);

    await act(async () => {
      view.latest.clear();
    });
    expect(view.latest.count).toBe(0);
    expect(view.latest.has(3)).toBe(false);
    expect(view.latest.draft.title).toBe("Renamed"); // clear() only removes rows
    expect(errors).not.toHaveBeenCalled(); // no React warning (unstable snapshot, update during render, missing act)
  });

  it("add(ids, names) and toggle(id, name) remember names; toggle is safe to hand to forEach; the draft re-renders with them", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await reactHarness();
    const view = h.mount();
    await view.render();

    await act(async () => {
      view.latest.add([1, 2, 2], new Map([[1, "Alpha"], [2, "Beta"]]));
    });
    expect(view.latest.draft.rows.map((r) => [r.id, r.name])).toEqual([[1, "Alpha"], [2, "Beta"]]);

    await act(async () => {
      view.latest.toggle(3, "Gamma");
    });
    expect(view.latest.draft.rows[2]).toEqual({ id: 3, qty: "", unit: "", name: "Gamma" });

    await act(async () => {
      view.latest.toggle(3, "Gamma"); // a second press removes it again
    });
    expect(view.latest.has(3)).toBe(false);

    // `[4, 5].forEach(toggle)` passes an index as the second argument: it is not a name and nothing throws
    await act(async () => {
      [4, 5].forEach(view.latest.toggle as unknown as (id: number, index: number) => void);
    });
    expect(view.latest.draft.rows.slice(2)).toEqual([{ id: 4, qty: "", unit: "" }, { id: 5, qty: "", unit: "" }]);

    await act(async () => {
      view.latest.update((d) => h.draft.rememberNames(d, new Map([[4, "Delta"], [1, "Alpha renamed"]])));
    });
    expect(view.latest.draft.rows.map((r) => r.name)).toEqual(["Alpha renamed", "Beta", "Delta", undefined]);
    expect(view.latest.count).toBe(4);

    // a refresh that changes nothing does not even produce a new hook value
    const before = view.latest;
    await act(async () => {
      view.latest.update((d) => h.draft.rememberNames(d, new Map([[4, "Delta"]])));
    });
    expect(view.latest).toBe(before);
    expect(errors).not.toHaveBeenCalled();
  });

  it("hands back the very same objects while nothing has changed, however often the component re-renders", async () => {
    const h = await reactHarness();
    const view = h.mount();
    await view.render(1);
    await act(async () => {
      view.latest.add([1]);
    });

    const rendersBefore = view.renders.length;
    await view.render(2);
    await view.render(3);
    expect(view.renders.length).toBe(rendersBefore + 2); // it really did render again each time
    const [previous, current] = view.renders.slice(-2);
    expect(current).toBe(previous); // one object, so a memoised consumer does not re-render for nothing
    expect(current.has).toBe(previous.has);
    expect(current.draft).toBe(previous.draft);
  });

  it("hands back a new object after a real change, while the action functions stay the same ones", async () => {
    const h = await reactHarness();
    const view = h.mount();
    await view.render();
    const before = view.latest;
    await act(async () => {
      before.add([7]);
    });
    const after = view.latest;
    expect(after).not.toBe(before);
    expect(after.draft).not.toBe(before.draft);
    expect(after.has).not.toBe(before.has); // bound to the new draft
    expect(before.has(7)).toBe(false); // the old render's has() still answers for the draft that render saw
    expect(after.has(7)).toBe(true);
    for (const action of ["update", "add", "remove", "toggle", "clear"] as const) {
      expect(after[action], action).toBe(before[action]); // safe to list in an effect's dependencies
    }
  });

  it("shares one draft between components: a change made through one shows up in the other", async () => {
    const h = await reactHarness();
    const first = h.mount();
    const second = h.mount();
    await first.render();
    await second.render();
    await act(async () => {
      first.latest.toggle(8);
    });
    expect(second.latest.count).toBe(1);
    expect(second.latest.has(8)).toBe(true);
    await act(async () => {
      second.latest.remove(8);
    });
    expect(first.latest.has(8)).toBe(false);
    expect(first.latest.count).toBe(0);
  });

  it("follows a change another tab saved (storage event) and stops listening once the component is gone", async () => {
    const h = await reactHarness();
    const added = vi.spyOn(h.win, "addEventListener");
    const removed = vi.spyOn(h.win, "removeEventListener");
    const view = h.mount();
    await view.render();
    expect(added.mock.calls.map((call) => call[0]).sort()).toEqual([h.draft.DRAFT_EVENT, "storage"]);

    h.storage.map.set(h.draft.STORAGE_KEY, h.draft.serializeDraft(draftWith({ rows: [{ id: 8, qty: "2", unit: "" }], title: "From tab B" })));
    await act(async () => {
      h.win.dispatchEvent(storageEvent(h.draft.STORAGE_KEY));
    });
    expect(view.latest.count).toBe(1);
    expect(view.latest.has(8)).toBe(true);
    expect(view.latest.draft.title).toBe("From tab B");

    await view.unmount();
    expect(removed.mock.calls.map((call) => call[0]).sort()).toEqual([h.draft.DRAFT_EVENT, "storage"]);
    const addedListener = new Map(added.mock.calls.map((call) => [call[0], call[1]]));
    for (const [type, listener] of removed.mock.calls) {
      expect(listener, `${type} listener`).toBe(addedListener.get(type)); // the very function that was added is the one removed
    }
  });

  it("tells the page when the browser cannot save the draft, and when it can again", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await reactHarness();
    const view = h.mount();
    await view.render();
    expect(view.latest.storage).toBe("browser");

    const realSetItem = h.storage.setItem.bind(h.storage);
    h.storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    await act(async () => {
      view.latest.add([1]);
    });
    expect(view.latest.storage).toBe("memory");
    expect(view.latest.has(1)).toBe(true); // the sheet itself keeps working

    const whileFailing = view.latest;
    await view.render(2);
    expect(view.latest).toBe(whileFailing); // one stable object while nothing changes

    h.storage.setItem = realSetItem;
    await act(async () => {
      view.latest.add([2]);
    });
    expect(view.latest.storage).toBe("browser");
    expect(view.latest.count).toBe(2);
    expect(errors).not.toHaveBeenCalled();
  });

  it("server rendering reports the storage as 'browser' (it makes no claim about a browser that is not there)", async () => {
    const { useOrderDraft } = await loadStore();
    function Probe() {
      const { storage } = useOrderDraft();
      return createElement("p", null, storage);
    }
    expect(typeof window).toBe("undefined");
    expect(renderToString(createElement(Probe))).toContain("browser");
  });

  it("shows the draft saved in this browser as soon as a client-side render happens (only server rendering uses the empty snapshot)", async () => {
    const h = await reactHarness();
    h.storage.map.set(h.draft.STORAGE_KEY, h.draft.serializeDraft(draftWith({ rows: [{ id: 3, qty: "", unit: "" }] })));
    const view = h.mount();
    await view.render();
    expect(view.latest.count).toBe(1);
    expect(view.latest.has(3)).toBe(true);
    expect(h.store.getServerSnapshot().rows).toEqual([]);
  });
});

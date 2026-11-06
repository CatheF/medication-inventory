import { describe, expect, it } from "vitest";
import { idKey, parseCategoryId, parseMedicationId, sameId, toIdString } from "@/lib/ids";

// Odd characters are built from code points on purpose: written literally (or as \u escapes) they are unreadable in
// a diff and some tooling rewrites them.
const cp = (n: number): string => String.fromCodePoint(n);

const UUID = "3f2b8c1e-5a47-4d0b-9c63-1e8f7a2d4b90";

const NBSP = cp(0x00a0);
const EM_SPACE = cp(0x2003);
const BOM = cp(0xfeff);
const ZWSP = cp(0x200b);
const ZWJ = cp(0x200d);
const RLO = cp(0x202e);
const NUL = cp(0);
const ARABIC_INDIC_THREE = cp(0x0663);
const FULLWIDTH_ONE = cp(0xff11);
const FULLWIDTH_TWO = cp(0xff12);
const FULLWIDTH_SEVEN = cp(0xff17);
const FULLWIDTH_HYPHEN = cp(0xff0d);

function describeInput(v: unknown): string {
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  if (typeof v === "string") return JSON.stringify(v);
  return Object.prototype.toString.call(v);
}

function expectOk(input: unknown, value: string | null) {
  expect(parseCategoryId(input), `parseCategoryId(${describeInput(input)})`).toEqual({ ok: true, value });
}

function expectRejected(input: unknown) {
  const r = parseCategoryId(input);
  expect(r.ok, `parseCategoryId(${describeInput(input)}) should be rejected`).toBe(false);
  if (!r.ok) {
    // The reason is shown to staff: a sentence, never "undefined" / "NaN" / "[object Object]".
    expect(r.reason).toMatch(/UUID|whole number/);
    expect(r.reason).not.toMatch(/undefined|NaN|\[object/);
  }
}

describe("parseCategoryId", () => {
  describe("means 'no category'", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["empty string", ""],
      ["one space", " "],
      ["three spaces", "   "],
      ["tab", "\t"],
      ["newline", "\n"],
      ["CRLF", "\r\n"],
      ["mixed whitespace", " \t \n "],
      ["non-breaking space", NBSP],
      ["em space", EM_SPACE],
      ["byte order mark", BOM],
    ])("%s -> ok, null", (_label, input) => expectOk(input, null));
  });

  describe("UUIDs (the live database shape)", () => {
    it("accepts a lowercase UUID unchanged", () => expectOk(UUID, UUID));
    it("lowercases an uppercase UUID", () => expectOk(UUID.toUpperCase(), UUID));
    it("lowercases a mixed-case UUID", () => expectOk("3F2b8C1e-5A47-4d0B-9c63-1E8f7A2d4B90", UUID));
    it("trims whitespace and newlines around a UUID", () => {
      expectOk(`  ${UUID}  `, UUID);
      expectOk(`\n${UUID}\t`, UUID);
    });
    it("accepts the nil UUID (format check only)", () => {
      expectOk("00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000000");
    });

    it.each([
      ["braces", `{${UUID}}`],
      ["urn prefix", `urn:uuid:${UUID}`],
      ["no hyphens", UUID.replaceAll("-", "")],
      ["one hyphen missing", UUID.replace("-", "")],
      ["extra trailing group", `${UUID}-0`],
      ["non-hex digit", UUID.replace("3f2b", "3g2b")],
      ["too short by one", UUID.slice(0, -1)],
      ["too long by one", `${UUID}0`],
      ["internal space", `${UUID.slice(0, 8)} ${UUID.slice(8)}`],
      ["internal newline", `${UUID.slice(0, 8)}\n${UUID.slice(8)}`],
      ["trailing newline then text", `${UUID}\nfoo`],
      ["leading zero-width space", `${ZWSP}${UUID}`],
      ["trailing zero-width space", `${UUID}${ZWSP}`],
      ["right-to-left override", `${RLO}${UUID}`],
      ["zero-width joiner inside", `${UUID.slice(0, 4)}${ZWJ}${UUID.slice(4)}`],
      ["fullwidth hyphens", UUID.replaceAll("-", FULLWIDTH_HYPHEN)],
      ["fullwidth digit", UUID.replace("3f2b", `${cp(0xff13)}f2b`)],
      ["percent-encoded hyphen", UUID.replace("-", "%2D")],
      ["two uuids", `${UUID},${UUID}`],
      ["uuid with SQL tail", `${UUID}; drop table categories`],
      ["NUL inside", `${UUID.slice(0, 8)}${NUL}${UUID.slice(8)}`],
    ])("rejects %s", (_label, input) => expectRejected(input));
  });

  describe("digit strings (the supabase/schema.sql bigint shape)", () => {
    it.each([
      ["1", "1"],
      ["7", "7"],
      ["42", "42"],
      ["  42  ", "42"],
      ["\n42\n", "42"],
      ["999999999999999999", "999999999999999999"], // 18 digits
    ])("%j -> %j", (input, value) => expectOk(input, value));

    it("strips leading zeros so '007' and '7' are the same category", () => {
      expectOk("007", "7");
      expectOk("10".padStart(18, "0"), "10"); // exactly 18 characters
    });

    it.each([
      ["zero", "0"],
      ["double zero", "00"],
      ["many zeros", "000000"],
      ["negative", "-1"],
      ["negative zero", "-0"],
      ["plus sign", "+5"],
      ["decimal", "1.5"],
      ["decimal with zero fraction", "1.0"],
      ["exponent", "1e3"],
      ["hex", "0x1F"],
      ["binary", "0b11"],
      ["list", "1,2"],
      ["two numbers", "1 2"],
      ["underscore separator", "1_000"],
      ["trailing letters", "12abc"],
      ["leading letters", "abc12"],
      ["Arabic-indic digit", ARABIC_INDIC_THREE],
      ["fullwidth digits", FULLWIDTH_ONE + FULLWIDTH_TWO],
      ["19 digits (above the accepted length even though it fits bigint)", "1234567890123456789"],
      ["26 digits", "99999999999999999999999999"],
      ["zero-width space inside", `1${ZWSP}2`],
      ["newline inside", "1\n2"],
    ])("rejects %s", (_label, input) => expectRejected(input));
  });

  describe("numbers", () => {
    it.each([1, 2, 42, 1000, Number.MAX_SAFE_INTEGER])("accepts the positive safe integer %d as its string", (n) => {
      expectOk(n, String(n));
    });

    it.each([
      NaN,
      Infinity,
      -Infinity,
      0,
      -0,
      -1,
      -42,
      1.5,
      0.1,
      1e21,
      2 ** 53, // first integer that is not safe
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      Number.EPSILON,
    ])("rejects %s", (n) => expectRejected(n));
  });

  describe("strings that are really bugs leaking through", () => {
    // These are what a form sends when it turns an id into a number or into text without checking: Number(uuid) -> NaN -> JSON null, or String() of a missing value.
    it.each(["NaN", "nan", "undefined", "null", "NULL", "None", "none", "true", "false", "Infinity", "-Infinity", "[object Object]", "{}", "[]"])(
      "rejects %j instead of treating it as an id or as 'no category'",
      (input) => expectRejected(input)
    );
  });

  describe("other types", () => {
    it.each([
      ["true", true],
      ["false", false],
      ["empty object", {}],
      ["object with an id", { id: UUID }],
      ["empty array", []],
      ["array holding a uuid", [UUID]],
      ["array holding a number", [1]],
      ["function", () => UUID],
      ["symbol", Symbol("x")],
      ["bigint", BigInt(5)],
      ["String object", new String(UUID)],
      ["Number object", new Number(5)],
      ["Date", new Date(0)],
    ])("rejects %s", (_label, input) => expectRejected(input));
  });

  describe("injection-looking text", () => {
    it.each([
      "1 OR 1=1",
      "1; DROP TABLE categories",
      "eq.1",
      "in.(1,2)",
      "1&category_id=2",
      "%31",
      "../1",
      "<script>alert(1)</script>",
      "💊",
      NUL,
    ])("rejects %j", (input) => expectRejected(input));
  });

  it("only ever returns null, a lowercase UUID, or digits without a leading zero", () => {
    const samples: unknown[] = [
      null, undefined, "", " ", UUID, UUID.toUpperCase(), "7", "007", "42", 1, 99, "NaN", NaN, 0, -1, 1.5, {}, [], "x",
      "  12  ", `  ${UUID.toUpperCase()}  `,
    ];
    for (const s of samples) {
      const r = parseCategoryId(s);
      if (!r.ok || r.value === null) continue;
      expect(r.value).toMatch(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[1-9][0-9]*)$/);
    }
  });

  it("is idempotent: parsing an accepted value again returns the same value", () => {
    for (const input of [UUID.toUpperCase(), "007", "  15 ", 15, UUID]) {
      const first = parseCategoryId(input);
      expect(first.ok).toBe(true);
      if (first.ok && first.value !== null) expect(parseCategoryId(first.value)).toEqual(first);
    }
  });

  it("round-trips through JSON the way the admin form sends it (a string id survives, NaN would not)", () => {
    expect(JSON.parse(JSON.stringify({ category_id: UUID })).category_id).toBe(UUID);
    // The defect this guards against: Number(uuid) is NaN and JSON.stringify turns NaN into null ("no category").
    expect(JSON.stringify({ category_id: Number(UUID) })).toBe('{"category_id":null}');
    // ...and the API refuses the textual forms of that mistake rather than saving them.
    expectRejected("NaN");
  });
});

describe("toIdString", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["abc", "abc"],
    [UUID, UUID],
    ["", ""],
    [42, "42"],
    [0, "0"],
    [-1, "-1"],
    [NaN, null],
    [Infinity, null],
    [-Infinity, null],
    [true, null],
    [false, null],
    [{}, null],
    [[], null],
    [["a"], null],
    [BigInt(5), null],
    [Symbol("s"), null],
  ])("%s -> %j", (input, expected) => {
    expect(toIdString(input)).toBe(expected);
  });

  it("never produces the text 'NaN', 'undefined' or 'null'", () => {
    for (const v of [NaN, undefined, null, Infinity, {}, [], true]) {
      const out = toIdString(v);
      expect(out === null || !/^(NaN|undefined|null)$/.test(out)).toBe(true);
    }
  });
});

describe("sameId", () => {
  it("treats a bigint number and its string as the same id", () => {
    expect(sameId(3, "3")).toBe(true);
    expect(sameId("3", 3)).toBe(true);
    expect(sameId(0, "0")).toBe(true);
  });

  it("compares UUIDs case-insensitively", () => {
    expect(sameId(UUID, UUID.toUpperCase())).toBe(true);
    expect(sameId(UUID.toUpperCase(), UUID)).toBe(true);
  });

  it("treats null and undefined as the same 'no id'", () => {
    expect(sameId(null, null)).toBe(true);
    expect(sameId(undefined, undefined)).toBe(true);
    expect(sameId(null, undefined)).toBe(true);
  });

  it("never equates 'no id' with a real id", () => {
    expect(sameId(null, "x")).toBe(false);
    expect(sameId("x", null)).toBe(false);
    expect(sameId(undefined, 0)).toBe(false);
    expect(sameId(null, "")).toBe(false);
    expect(sameId("", null)).toBe(false);
    expect(sameId(null, UUID)).toBe(false);
  });

  it("does not equate different ids, including zero-padded or whitespace variants", () => {
    expect(sameId("3", "4")).toBe(false);
    expect(sameId("3", "03")).toBe(false);
    expect(sameId("3", " 3")).toBe(false);
    expect(sameId("3", "3 ")).toBe(false);
    expect(sameId(UUID, `${UUID} `)).toBe(false);
    expect(sameId(UUID, "3f2b8c1e-5a47-4d0b-9c63-1e8f7a2d4b91")).toBe(false);
  });

  it("does not equate a real id with NaN", () => {
    expect(sameId(NaN, 3)).toBe(false);
    expect(sameId(3, NaN)).toBe(false);
    expect(sameId(NaN, "NaN")).toBe(false);
  });

  it("is symmetric", () => {
    const values: unknown[] = [null, undefined, "", "3", 3, UUID, UUID.toUpperCase(), 0, "0", NaN];
    for (const a of values) for (const b of values) expect(sameId(a, b)).toBe(sameId(b, a));
  });
});

// The comparison key the view logic, the filter chips and the Inventory components all use for a category id: one definition.
describe("idKey", () => {
  it.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["empty text", ""],
    ["blank text", "   \t\n"],
    ["a no-break space", NBSP],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
  ])("is null for %s (no id at all)", (_label, value) => {
    expect(idKey(value)).toBeNull();
  });

  it("trims and lower-cases, so a UUID compares the way the view logic compares it", () => {
    expect(idKey(`  ${UUID.toUpperCase()} `)).toBe(UUID);
    expect(idKey("AbC")).toBe("abc");
    expect(idKey(UUID)).toBe(UUID);
  });

  it("turns numbers and digit strings into the same key (bigint ids), and never reads them as numbers", () => {
    expect(idKey(42)).toBe("42");
    expect(idKey("42")).toBe("42");
    expect(idKey(" 0042 ")).toBe("0042"); // leading zeros survive: "42" and "0042" are different keys
    expect(idKey(0)).toBe("0");
    expect(idKey(-1)).toBe("-1");
  });

  it("gives equal keys for the ids sameId calls equal, when neither has blanks around it", () => {
    for (const [a, b] of [
      [3, "3"],
      [UUID, UUID.toUpperCase()],
      ["abc", "ABC"],
    ] as const) {
      expect(sameId(a, b)).toBe(true);
      expect(idKey(a)).toBe(idKey(b));
    }
  });
});

// Ids are identity, not search text: search ignores accents and look-alike forms, ids never do. A category is told apart
// from another by its id, and two ids that differ in an accent or a look-alike letter are two ids.
describe("ids are compared exactly: they are not folded the way search text is", () => {
  const E_ACUTE = cp(0x00e9);
  const E_GRAVE_UPPER = cp(0x00c8);
  const COMBINING_ACUTE = cp(0x0301);

  it("keeps an accented id apart from the plain one, in both comparisons", () => {
    expect(sameId(`caf${E_ACUTE}`, "cafe")).toBe(false);
    expect(sameId(`cafe${COMBINING_ACUTE}`, "cafe")).toBe(false);
    expect(idKey(`caf${E_ACUTE}`)).not.toBe(idKey("cafe"));
    expect(idKey(E_GRAVE_UPPER)).toBe(cp(0x00e8)); // lower-cased, accent kept
  });

  it("keeps look-alike forms apart", () => {
    expect(sameId(FULLWIDTH_ONE + FULLWIDTH_TWO, "12")).toBe(false);
    expect(idKey(FULLWIDTH_ONE + FULLWIDTH_TWO)).not.toBe("12");
  });
});

describe("parseMedicationId", () => {
  it.each([
    [1, 1],
    [7, 7],
    [123456, 123456],
    ["1", 1],
    ["7", 7],
    ["123", 123],
    [" 123 ", 123],
    ["\n123\t", 123],
    ["999999999999999", 999999999999999], // 15 digits
  ])("%j -> %j", (input, expected) => {
    expect(parseMedicationId(input)).toBe(expected);
  });

  it.each([
    ["zero", 0],
    ["negative zero", -0],
    ["negative", -1],
    ["fraction", 1.5],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["above safe range", 2 ** 53],
    ["1e21", 1e21],
    ["string zero", "0"],
    ["string zeros", "000"],
    ["leading zeros", "007"],
    ["negative string", "-7"],
    ["plus sign", "+7"],
    ["decimal", "7.0"],
    ["decimal 7.5", "7.5"],
    ["exponent", "7e0"],
    ["hex", "0x7"],
    ["16 digits", "1000000000000000"],
    ["20 digits", "12345678901234567890"],
    ["empty", ""],
    ["blank", "   "],
    ["NaN text", "NaN"],
    ["undefined text", "undefined"],
    ["null text", "null"],
    ["letters", "abc"],
    ["mixed", "12abc"],
    ["two numbers", "1 2"],
    ["comma", "1,2"],
    ["Arabic-indic digit", ARABIC_INDIC_THREE],
    ["fullwidth digit", FULLWIDTH_SEVEN],
    ["zero-width space inside", `1${ZWSP}2`],
    ["uuid", UUID],
    ["null", null],
    ["undefined", undefined],
    ["true", true],
    ["object", {}],
    ["array", [7]],
    ["bigint", BigInt(7)],
    ["Number object", new Number(7)],
    ["String object", new String("7")],
  ])("rejects %s", (_label, input) => {
    expect(parseMedicationId(input)).toBeNull();
  });

  it("returns a real number type, not a string", () => {
    expect(typeof parseMedicationId("42")).toBe("number");
  });
});

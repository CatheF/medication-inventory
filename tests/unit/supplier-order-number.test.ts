import { describe, expect, it } from "vitest";
import { parseSupplierOrderNumber, SUPPLIER_ORDER_NUMBER_MAX_LENGTH } from "@/lib/supplier-order-number";
import { TRICKY_SUPPLIER_NUMBERS } from "../helpers/fixtures";

// Invisible characters are built from code points on purpose: written literally (or as \u escapes) they are
// unreadable in review and some tooling rewrites them.
const cp = (n: number): string => String.fromCodePoint(n);

const NBSP = cp(0x00a0);
const EM_SPACE = cp(0x2003);
const IDEOGRAPHIC_SPACE = cp(0x3000);
const BOM = cp(0xfeff);
const ZWSP = cp(0x200b);

function ok(input: unknown): string | null {
  const r = parseSupplierOrderNumber(input);
  if (!r.ok) throw new Error(`expected ok for ${JSON.stringify(input)}, got: ${r.reason}`);
  return r.value;
}

function reason(input: unknown): string {
  const r = parseSupplierOrderNumber(input);
  if (r.ok) throw new Error(`expected a rejection for ${JSON.stringify(input)}, got value ${JSON.stringify(r.value)}`);
  return r.reason;
}

describe("parseSupplierOrderNumber", () => {
  it("has a 64 character limit", () => {
    expect(SUPPLIER_ORDER_NUMBER_MAX_LENGTH).toBe(64);
  });

  describe("'not set'", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["empty string", ""],
      ["one space", " "],
      ["five spaces", "     "],
      ["tab", "\t"],
      ["newline", "\n"],
      ["CRLF", "\r\n"],
      ["mixed whitespace", " \t\r\n "],
      ["non-breaking space", NBSP],
      ["two em spaces", EM_SPACE + EM_SPACE],
      ["ideographic space", IDEOGRAPHIC_SPACE],
      ["byte order mark", BOM],
    ])("%s -> null", (_label, input) => {
      expect(ok(input)).toBeNull();
    });
  });

  describe("keeps exactly what staff typed", () => {
    it.each([
      "0092",
      "000000",
      "00417-B",
      "AX-1182/4",
      "1E5", // spreadsheet scientific notation
      "12345678901234567890", // beyond 15 significant digits
      "00-1.50",
      "2026-11-05", // looks like a date
      "=1+1", // formula text is the export's problem, not the parser's
      "+1",
      "-2",
      "@A1",
      "NÅ-00ß",
      "ab-CD-ef", // case untouched
      "A  B", // internal double space untouched
      "A B C",
      "a.b,c;d:e!f?g#h%i&j*k",
      "(123)[456]{789}",
      "'quoted'",
      '"double"',
      "back\\slash",
      "<tag>&amp;",
      "日本語-001",
      "دواء-٥٠",
      "📦-001",
      "0",
      "00",
      "7",
    ])("%j", (input) => {
      expect(ok(input)).toBe(input);
    });

    it("keeps a decomposed accent as typed (no Unicode normalization)", () => {
      const decomposed = `e${cp(0x0301)}-1`;
      expect(ok(decomposed)).toBe(decomposed);
      expect(ok(decomposed)).not.toBe("é-1");
    });

    it("never changes a value that is already clean (idempotent)", () => {
      for (const value of TRICKY_SUPPLIER_NUMBERS) {
        const once = ok(value);
        expect(once).toBe(value);
        expect(ok(once)).toBe(once);
      }
    });

    it("does not strip leading zeros, normalize case or collapse spaces", () => {
      expect(ok("00417-b")).toBe("00417-b");
      expect(ok("00417-B")).toBe("00417-B");
      expect(ok("007")).toBe("007");
      expect(ok("A   B")).toBe("A   B");
    });
  });

  describe("trims the ends only", () => {
    it.each([
      ["spaces", "  00417-B  ", "00417-B"],
      ["tab and newline", "\t00417-B\n", "00417-B"],
      ["CRLF", "\r\n0092\r\n", "0092"],
      ["non-breaking spaces", `${NBSP}${NBSP}0092${NBSP}`, "0092"],
      ["ideographic spaces", `${IDEOGRAPHIC_SPACE}0092${IDEOGRAPHIC_SPACE}`, "0092"],
      ["leading BOM", `${BOM}0092`, "0092"],
      ["around a spaced value", " A B ", "A B"],
    ])("%s", (_label, input, expected) => {
      expect(ok(input)).toBe(expected);
    });

    it("does not touch whitespace-like characters inside the value", () => {
      expect(ok(`A${NBSP}B`)).toBe(`A${NBSP}B`); // a visible non-breaking space inside is kept
      expect(ok("A B")).toBe("A B");
    });
  });

  describe("rejects line breaks, tabs and control characters", () => {
    it.each([
      ["tab inside", "A\tB"],
      ["newline inside", "A\nB"],
      ["carriage return inside", "A\rB"],
      ["CRLF inside", "A\r\nB"],
      ["vertical tab", `A${cp(0x0b)}B`],
      ["form feed", `A${cp(0x0c)}B`],
      ["NUL", `A${cp(0x00)}B`],
      ["NUL alone", cp(0x00)],
      ["bell", `A${cp(0x07)}B`],
      ["escape", `A${cp(0x1b)}B`],
      ["unit separator", `A${cp(0x1f)}B`],
      ["DEL", `A${cp(0x7f)}B`],
      ["C1 NEL (next line)", `A${cp(0x85)}B`],
      ["C1 control", `A${cp(0x9f)}B`],
      ["line separator", `A${cp(0x2028)}B`],
      ["paragraph separator", `A${cp(0x2029)}B`],
      ["zero width space", `A${cp(0x200b)}B`],
      ["zero width non-joiner", `A${cp(0x200c)}B`],
      ["zero width joiner", `A${cp(0x200d)}B`],
      ["left-to-right mark", `A${cp(0x200e)}B`],
      ["right-to-left mark", `A${cp(0x200f)}B`],
      ["left-to-right embedding", `A${cp(0x202a)}B`],
      ["right-to-left embedding", `A${cp(0x202b)}B`],
      ["pop directional formatting", `A${cp(0x202c)}B`],
      ["left-to-right override", `A${cp(0x202d)}B`],
      ["right-to-left override (spoofing)", `00417${cp(0x202e)}B-`],
      ["word joiner", `A${cp(0x2060)}B`],
      ["invisible separator", `A${cp(0x2063)}B`],
      ["BOM inside", `A${BOM}B`],
      ["zero width space only", ZWSP],
      ["zero width space at the start", `${ZWSP}0092`],
      ["zero width space at the end", `0092${ZWSP}`],
      ["control character in the middle of a long value", `${"A".repeat(20)}\n${"B".repeat(20)}`],
    ])("%s", (_label, input) => {
      const r = reason(input);
      expect(r).toMatch(/control characters/i);
      expect(r).toMatch(/line breaks/i);
    });
  });

  describe("length limit", () => {
    it("accepts 64 characters", () => {
      const v = "A".repeat(64);
      expect(ok(v)).toBe(v);
    });

    it("rejects 65 characters with a message that names the limit", () => {
      const r = reason("A".repeat(65));
      expect(r).toContain("64");
      expect(r).toMatch(/too long/i);
    });

    it("measures the limit after trimming", () => {
      expect(ok(`${"A".repeat(64)}   `)).toBe("A".repeat(64));
      expect(ok(`   ${"A".repeat(64)}`)).toBe("A".repeat(64));
      expect(parseSupplierOrderNumber(`  ${"A".repeat(65)}  `).ok).toBe(false);
    });

    it("counts characters, not UTF-16 code units (64 emoji are allowed, 65 are not)", () => {
      const sixtyFour = "💊".repeat(64);
      expect(sixtyFour.length).toBe(128); // UTF-16 length is double
      expect(ok(sixtyFour)).toBe(sixtyFour);
      expect(parseSupplierOrderNumber("💊".repeat(65)).ok).toBe(false);
    });

    it("rejects an enormous value without throwing", () => {
      expect(parseSupplierOrderNumber("9".repeat(100_000)).ok).toBe(false);
    });

    it("rejects an over-long value whichever rule it breaks", () => {
      // The trailing newline is trimmed away, but 70 characters remain.
      expect(parseSupplierOrderNumber(`${"A".repeat(70)}\n`).ok).toBe(false);
      // Too long AND contains a line break inside.
      expect(parseSupplierOrderNumber(`${"A".repeat(35)}\n${"B".repeat(35)}`).ok).toBe(false);
    });
  });

  describe("never coerces other types (leading zeros would already be gone)", () => {
    it.each([
      ["number", 92],
      ["number zero", 0],
      ["negative number", -1],
      ["float", 1.5],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["bigint", BigInt(92)],
      ["true", true],
      ["false", false],
      ["empty object", {}],
      ["object with value", { value: "0092" }],
      ["array", ["0092"]],
      ["empty array", []],
      ["String object", new String("0092")],
      ["Number object", new Number(92)],
      ["function", () => "0092"],
      ["symbol", Symbol("0092")],
      ["Date", new Date(0)],
    ])("rejects a %s as 'must be text'", (_label, input) => {
      expect(reason(input)).toMatch(/must be text/i);
    });
  });

  it("returns a plain reason string that is safe to show next to the field", () => {
    for (const bad of ["A\nB", "A".repeat(65), 12, {}]) {
      const r = reason(bad);
      expect(typeof r).toBe("string");
      expect(r.length).toBeGreaterThan(10);
      expect(r).not.toMatch(/undefined|NaN|\[object/);
    }
  });

  it("is not affected by regex state between calls (no sticky/global regex)", () => {
    for (let i = 0; i < 5; i += 1) {
      expect(ok("0092")).toBe("0092");
      expect(parseSupplierOrderNumber("A\tB").ok).toBe(false);
    }
  });
});

// Regression: the parser used to keep a hand-written list of forbidden ranges that stopped at U+2064. It let the four
// bidi ISOLATE controls (U+2066-U+2069) through, although they reorder displayed text exactly like the override
// characters rejected above, and about 150 other invisible or formatting characters with them. A code containing
// any of them reads differently on screen and on the printed sheet. The rule is now a Unicode-category rule
// (lib/text-safety.ts): control (Cc), format (Cf), line/paragraph separators (Zl, Zp) and Default_Ignorable code
// points are rejected, variation selectors excepted.
describe("bidi isolates and other invisible format characters", () => {
  it.each([
    ["left-to-right isolate U+2066", 0x2066],
    ["right-to-left isolate U+2067", 0x2067],
    ["first strong isolate U+2068", 0x2068],
    ["pop directional isolate U+2069", 0x2069],
  ])("rejects %s", (_label, codePoint) => {
    expect(parseSupplierOrderNumber(`00417${cp(codePoint)}B-`).ok).toBe(false);
  });

  // The code points the review found accepted, by name, so the table reads without a Unicode chart.
  const INVISIBLE_BEYOND_THE_OLD_LIST: Array<[string, number]> = [
    ["soft hyphen", 0x00ad],
    ["combining grapheme joiner", 0x034f],
    ["Arabic number sign", 0x0600],
    ["Arabic sign safha", 0x0603],
    ["Arabic number mark above", 0x0605],
    ["Arabic letter mark", 0x061c],
    ["Arabic end of ayah", 0x06dd],
    ["Syriac abbreviation mark", 0x070f],
    ["Hangul choseong filler", 0x115f],
    ["Hangul jungseong filler", 0x1160],
    ["Khmer vowel inherent AQ", 0x17b4],
    ["Khmer vowel inherent AA", 0x17b5],
    ["Mongolian vowel separator", 0x180e],
    ["unassigned code point reserved for formatting", 0x2065],
    ["inhibit symmetric swapping", 0x206a],
    ["activate symmetric swapping", 0x206b],
    ["inhibit Arabic form shaping", 0x206c],
    ["activate Arabic form shaping", 0x206d],
    ["national digit shapes", 0x206e],
    ["nominal digit shapes", 0x206f],
    ["Hangul filler", 0x3164],
    ["halfwidth Hangul filler", 0xffa0],
    ["interlinear annotation anchor", 0xfff9],
    ["interlinear annotation separator", 0xfffa],
    ["interlinear annotation terminator", 0xfffb],
    ["language tag", 0xe0001],
    ["tag space", 0xe0020],
    ["tag latin small letter a", 0xe0061],
    ["cancel tag", 0xe007f],
  ];

  const hex = (n: number): string => `U+${n.toString(16).toUpperCase().padStart(4, "0")}`;
  const NAMED: Array<[string, number]> = INVISIBLE_BEYOND_THE_OLD_LIST.map(([label, codePoint]) => [`${label} ${hex(codePoint)}`, codePoint]);

  it.each(NAMED)("rejects %s inside a code", (_label, codePoint) => {
    const r = reason(`00417${cp(codePoint)}B-`);
    expect(r).toMatch(/control characters/i);
    expect(r).toMatch(/line breaks/i);
  });

  it.each(NAMED)("rejects %s at either end of a code (trim does not remove it)", (_label, codePoint) => {
    expect(parseSupplierOrderNumber(`0092${cp(codePoint)}`).ok).toBe(false);
    expect(parseSupplierOrderNumber(`${cp(codePoint)}0092`).ok).toBe(false);
  });

  it("rejects EVERY invisible, format, control or separator code point (exhaustive over U+0000-U+10FFFF)", () => {
    const invisible = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]$/u;
    const variationSelector = /^\p{Variation_Selector}$/u;
    const wronglyAccepted: string[] = [];
    const wronglyRejected: string[] = [];
    let rejectedCount = 0;
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue; // lone surrogates cannot be built with fromCodePoint
      const ch = cp(codePoint);
      const mustReject = invisible.test(ch) && !variationSelector.test(ch);
      const accepted = parseSupplierOrderNumber(`A${ch}B`).ok;
      if (mustReject) rejectedCount += 1;
      const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
      if (mustReject && accepted) wronglyAccepted.push(label);
      if (!mustReject && !accepted) wronglyRejected.push(label);
    }
    expect(wronglyAccepted).toEqual([]);
    expect(wronglyRejected).toEqual([]);
    // Sanity: the enumeration really covered the invisible blocks (a typo in the property names above would make
    // the sets empty and the test pass for the wrong reason). About 4,000 code points qualify.
    expect(rejectedCount).toBeGreaterThan(3000);
  });

  describe("does not reject what staff really type", () => {
    it("accepts every printable ASCII character inside a code", () => {
      for (let codePoint = 0x21; codePoint <= 0x7e; codePoint += 1) {
        const value = `A${cp(codePoint)}B`;
        expect(ok(value)).toBe(value);
      }
    });

    it("accepts a plain space, a no-break space and an ideographic space INSIDE a code (visible spacing)", () => {
      expect(ok("A B")).toBe("A B");
      expect(ok(`A${NBSP}B`)).toBe(`A${NBSP}B`);
      expect(ok(`A${IDEOGRAPHIC_SPACE}B`)).toBe(`A${IDEOGRAPHIC_SPACE}B`);
    });

    it("accepts variation selectors, which emoji need to be drawn as emoji", () => {
      for (const selector of [0xfe00, 0xfe0e, 0xfe0f, 0xe0100, 0xe01ef]) {
        const value = `☎${cp(selector)}-001`;
        expect(ok(value)).toBe(value);
      }
    });

    it("accepts letters and digits of several scripts, combining accents and emoji", () => {
      for (const value of ["Ωμέγα-12", "Привет-7", "שלום-3", "हिन्दी-४२", "ไทย-9", "한글-5", `e${cp(0x0301)}-1`, "👩-001", "💊💊"]) {
        expect(ok(value)).toBe(value);
      }
    });
  });
});

import { describe, expect, it } from "vitest";
import { hasInvisibleOrControlCharacter } from "@/lib/text-safety";

// Invisible characters are built from code points on purpose: written literally they are unreadable in review
// and some tooling rewrites them.
const cp = (n: number): string => String.fromCodePoint(n);
const hex = (n: number): string => `U+${n.toString(16).toUpperCase().padStart(4, "0")}`;

describe("hasInvisibleOrControlCharacter", () => {
  it("is false for empty text and for ordinary visible text", () => {
    for (const text of [
      "",
      " ",
      "Antibiotics",
      "00417-B",
      "Pain & Fever",
      'Gauze pads 4"x4", sterile',
      "Crème antiseptique 1 %, 30 g",
      "日本語の薬品名",
      "دواء-٥٠",
      cp(0x1f469), // an emoji on its own (no joiner)
      "A  B", // internal spaces are visible spacing
      `A${cp(0x00a0)}B`, // no-break space
      `A${cp(0x3000)}B`, // ideographic space
      `e${cp(0x0301)}`, // combining accent
    ]) {
      expect(hasInvisibleOrControlCharacter(text), JSON.stringify(text)).toBe(false);
    }
  });

  describe("is true when the text contains", () => {
    const CASES: Array<[string, number]> = [
      ["NUL", 0x0000],
      ["tab", 0x0009],
      ["line feed", 0x000a],
      ["carriage return", 0x000d],
      ["escape", 0x001b],
      ["DEL", 0x007f],
      ["C1 control (NEXT LINE)", 0x0085],
      ["soft hyphen", 0x00ad],
      ["combining grapheme joiner", 0x034f],
      ["Arabic letter mark", 0x061c],
      ["Hangul choseong filler", 0x115f],
      ["Khmer vowel inherent AQ", 0x17b4],
      ["Mongolian vowel separator", 0x180e],
      ["zero width space", 0x200b],
      ["zero width non-joiner", 0x200c],
      ["zero width joiner", 0x200d],
      ["left-to-right mark", 0x200e],
      ["right-to-left mark", 0x200f],
      ["line separator", 0x2028],
      ["paragraph separator", 0x2029],
      ["right-to-left override", 0x202e],
      ["word joiner", 0x2060],
      ["invisible separator", 0x2063],
      ["unassigned code point reserved for formatting", 0x2065],
      ["left-to-right isolate", 0x2066],
      ["pop directional isolate", 0x2069],
      ["inhibit symmetric swapping", 0x206a],
      ["nominal digit shapes", 0x206f],
      ["Hangul filler", 0x3164],
      ["byte order mark", 0xfeff],
      ["halfwidth Hangul filler", 0xffa0],
      ["interlinear annotation anchor", 0xfff9],
      ["language tag", 0xe0001],
      ["cancel tag", 0xe007f],
    ];

    it.each(CASES.map(([label, codePoint]): [string, number] => [`${label} ${hex(codePoint)}`, codePoint]))("%s", (_label, codePoint) => {
      const ch = cp(codePoint);
      expect(hasInvisibleOrControlCharacter(ch)).toBe(true);
      expect(hasInvisibleOrControlCharacter(`Pain${ch}Fever`)).toBe(true);
      expect(hasInvisibleOrControlCharacter(`${ch}Pain`)).toBe(true);
      expect(hasInvisibleOrControlCharacter(`Pain${ch}`)).toBe(true);
    });
  });

  it("allows variation selectors, which emoji need to be drawn as emoji", () => {
    for (const selector of [0x180b, 0x180d, 0x180f, 0xfe00, 0xfe0e, 0xfe0f, 0xe0100, 0xe01ef]) {
      expect(hasInvisibleOrControlCharacter(`☎${cp(selector)}`), hex(selector)).toBe(false);
    }
    // ...but a selector does not make an adjacent invisible character acceptable
    expect(hasInvisibleOrControlCharacter(`☎${cp(0xfe0f)}${cp(0x200b)}`)).toBe(true);
  });

  it("classifies EVERY code point by Unicode category (exhaustive over U+0000-U+10FFFF)", () => {
    const invisible = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]$/u;
    const variationSelector = /^\p{Variation_Selector}$/u;
    const mismatches: string[] = [];
    let flagged = 0;
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue; // lone surrogates cannot be built with fromCodePoint
      const ch = cp(codePoint);
      const expected = invisible.test(ch) && !variationSelector.test(ch);
      if (expected) flagged += 1;
      if (hasInvisibleOrControlCharacter(ch) !== expected) mismatches.push(hex(codePoint));
    }
    expect(mismatches).toEqual([]);
    // About 4,000 code points qualify; far fewer would mean the property names above silently matched nothing.
    expect(flagged).toBeGreaterThan(3000);
  });

  it("gives the same answer every time it is asked (no sticky or global regex state between calls)", () => {
    const isolate = cp(0x2066);
    const variationSelector = `☎${cp(0xfe0f)}`;
    for (let i = 0; i < 6; i += 1) {
      // The same invisible character twice in a row, and as the first character: a regex with a `g` or `y` flag
      // would start the second search where the first one stopped and miss it.
      expect(hasInvisibleOrControlCharacter(isolate)).toBe(true);
      expect(hasInvisibleOrControlCharacter(`${isolate}${isolate}`)).toBe(true);
      expect(hasInvisibleOrControlCharacter(`A${isolate}B`)).toBe(true);
      expect(hasInvisibleOrControlCharacter("AB")).toBe(false);
      expect(hasInvisibleOrControlCharacter(variationSelector)).toBe(false);
    }
  });

  it("handles very long text without throwing", () => {
    expect(hasInvisibleOrControlCharacter("9".repeat(200_000))).toBe(false);
    expect(hasInvisibleOrControlCharacter(`${"9".repeat(200_000)}${cp(0x2069)}`)).toBe(true);
  });

  it("treats a lone surrogate as ordinary text (it is neither invisible nor a control character)", () => {
    expect(hasInvisibleOrControlCharacter(String.fromCharCode(0xd800))).toBe(false);
  });
});

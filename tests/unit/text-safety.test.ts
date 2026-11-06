import { describe, expect, it } from "vitest";
import { hasInvisibleOrControlCharacter, stripInvisibleCharacters } from "@/lib/text-safety";

// Invisible characters are built from code points on purpose: written literally they are unreadable in a diff
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

// ── stripInvisibleCharacters: the search-side rule ───────────────────────────────────────────────────────────────
// Drops every Cf and every Default_Ignorable_Code_Point character and nothing else. It replaced four private copies of the
// same regex (the Inventory search, the combobox search, the Inventory filter chip, the Admin filter chip), which were
// identical; the sweep below pins the behaviour they all had.

describe("stripInvisibleCharacters", () => {
  const STRIPPED: Array<[string, number]> = [
    ["soft hyphen", 0x00ad],
    ["combining grapheme joiner", 0x034f],
    ["Arabic number sign", 0x0600],
    ["Arabic letter mark", 0x061c],
    ["Hangul choseong filler", 0x115f],
    ["Khmer vowel inherent AQ", 0x17b4],
    ["Mongolian vowel separator", 0x180e],
    ["zero width space", 0x200b],
    ["zero width non-joiner", 0x200c],
    ["zero width joiner", 0x200d],
    ["left-to-right mark", 0x200e],
    ["right-to-left mark", 0x200f],
    ["left-to-right embedding", 0x202a],
    ["right-to-left override", 0x202e],
    ["word joiner", 0x2060],
    ["invisible times", 0x2062],
    ["invisible separator", 0x2063],
    ["unassigned code point reserved for formatting", 0x2065],
    ["left-to-right isolate", 0x2066],
    ["pop directional isolate", 0x2069],
    ["nominal digit shapes", 0x206f],
    ["Hangul filler", 0x3164],
    ["byte order mark", 0xfeff],
    ["halfwidth Hangul filler", 0xffa0],
    ["interlinear annotation anchor", 0xfff9],
    ["language tag", 0xe0001],
    ["cancel tag", 0xe007f],
  ];

  it("leaves text without invisible characters exactly as it was", () => {
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
      cp(0x1f469), // an emoji on its own
      "𠮷野家", // a character outside the BMP (surrogate pair) next to ordinary ones
      "  two  spaces and a trailing blank  ", // it only drops characters: it does not trim or collapse
      `A${cp(0x00a0)}B`, // no-break space is visible spacing
      `A${cp(0x3000)}B`, // ideographic space
      `A${cp(0x2800)}B`, // Braille blank is drawn as a (blank) cell: it is text for a search
      `e${cp(0x0301)}`, // combining accent
    ]) {
      expect(stripInvisibleCharacters(text), JSON.stringify(text)).toBe(text);
    }
  });

  describe("removes", () => {
    it.each(STRIPPED.map(([label, codePoint]): [string, number] => [`${label} ${hex(codePoint)}`, codePoint]))("%s", (_label, codePoint) => {
      const ch = cp(codePoint);
      expect(stripInvisibleCharacters(ch)).toBe("");
      expect(stripInvisibleCharacters(`${ch}${ch}${ch}`)).toBe("");
      expect(stripInvisibleCharacters(`Pain${ch}Fever`)).toBe("PainFever");
      expect(stripInvisibleCharacters(`${ch}Pain`)).toBe("Pain");
      expect(stripInvisibleCharacters(`Pain${ch}`)).toBe("Pain");
      expect(stripInvisibleCharacters(`Pain ${ch} Fever`)).toBe("Pain  Fever"); // the spaces around it stay
    });
  });

  it("removes zero-width space, soft hyphen, joiners and direction marks from a pasted word", () => {
    const pasted = `ibu${cp(0x200b)}pro${cp(0x00ad)}fen${cp(0x200d)}${cp(0x200c)}${cp(0x200e)}${cp(0x200f)}${cp(0x202e)}${cp(0x2066)}`;
    expect(stripInvisibleCharacters(pasted)).toBe("ibuprofen");
  });

  it("removes variation selectors (unlike hasInvisibleOrControlCharacter, which allows them for emoji)", () => {
    // "heart" typed with the emoji selector must still match a stored "heart" without it, and a pasted blank made only of
    // selectors is no search: for SEARCHING they are invisible. For SAVING a name they are legitimate (emoji presentation).
    for (const selector of [0x180b, 0x180d, 0x180f, 0xfe00, 0xfe0e, 0xfe0f, 0xe0100, 0xe01ef]) {
      expect(stripInvisibleCharacters(`☎${cp(selector)}`), hex(selector)).toBe("☎");
      expect(stripInvisibleCharacters(cp(selector)), hex(selector)).toBe("");
      expect(hasInvisibleOrControlCharacter(`☎${cp(selector)}`), `${hex(selector)} is accepted by the validation rule`).toBe(false);
    }
  });

  it("keeps what the validation rule refuses but a search must keep: control characters, line and paragraph separators", () => {
    // These are whitespace or text for a search (a tab between two words splits them), so they are NOT dropped here, while
    // hasInvisibleOrControlCharacter refuses them in a stored name or code. The two rules differ on purpose.
    for (const codePoint of [0x0000, 0x0009, 0x000a, 0x000d, 0x001b, 0x007f, 0x0085, 0x2028, 0x2029]) {
      const text = `A${cp(codePoint)}B`;
      expect(stripInvisibleCharacters(text), hex(codePoint)).toBe(text);
      expect(hasInvisibleOrControlCharacter(text), hex(codePoint)).toBe(true);
    }
  });

  it("removes the tag characters of an emoji tag sequence and keeps the emoji", () => {
    const tags = [0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f].map(cp).join("");
    expect(stripInvisibleCharacters(`${cp(0x1f3f4)}${tags}`)).toBe(cp(0x1f3f4));
  });

  it("closes the gap an invisible character leaves, so an accent still sits next to its letter", () => {
    expect(stripInvisibleCharacters(`e${cp(0x200b)}${cp(0x0301)}`)).toBe(`e${cp(0x0301)}`);
  });

  it("treats a lone surrogate as ordinary text", () => {
    const lone = String.fromCharCode(0xd800);
    expect(stripInvisibleCharacters(lone)).toBe(lone);
    expect(stripInvisibleCharacters(`${lone}${cp(0x200b)}x`)).toBe(`${lone}x`);
  });

  it("is idempotent, never longer than its input, and keeps no state between calls (the regex has the g flag)", () => {
    const samples = [`A${cp(0x200b)}B`, `${cp(0x200b)}${cp(0x200b)}`, "plain", "", `x${cp(0xfe0f)}${cp(0x00ad)}y${cp(0x2066)}`];
    for (let round = 0; round < 4; round += 1) {
      for (const text of samples) {
        const once = stripInvisibleCharacters(text);
        expect(stripInvisibleCharacters(once), JSON.stringify(text)).toBe(once);
        expect(once.length).toBeLessThanOrEqual(text.length);
      }
    }
    // Alternating an invisible character at the start with one in the middle would expose a regex that remembers where it stopped.
    for (let i = 0; i < 6; i += 1) {
      expect(stripInvisibleCharacters(`${cp(0x200b)}ab`)).toBe("ab");
      expect(stripInvisibleCharacters(`abcdef${cp(0x200b)}`)).toBe("abcdef");
      expect(stripInvisibleCharacters(`a${cp(0x200b)}b`)).toBe("ab");
    }
  });

  it("handles very long text", () => {
    expect(stripInvisibleCharacters("9".repeat(200_000))).toBe("9".repeat(200_000));
    expect(stripInvisibleCharacters(cp(0x200b).repeat(200_000))).toBe("");
    expect(stripInvisibleCharacters(`${"9".repeat(100_000)}${cp(0x200b)}${"9".repeat(100_000)}`)).toBe("9".repeat(200_000));
  });

  it("drops EXACTLY the Cf and Default_Ignorable_Code_Point characters (exhaustive over U+0000-U+10FFFF)", () => {
    // The oracle is written differently on purpose: two single-property regexes, not the character class the function uses.
    const format = /^\p{Cf}$/u;
    const ignorable = /^\p{Default_Ignorable_Code_Point}$/u;
    // The rule the four private copies had before they were replaced by this function, spelled out as they spelled it.
    const before = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
    const mismatches: string[] = [];
    let dropped = 0;
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue; // lone surrogates cannot be built with fromCodePoint
      const ch = cp(codePoint);
      const expected = format.test(ch) || ignorable.test(ch);
      if (expected) dropped += 1;
      const alone = stripInvisibleCharacters(ch);
      if (alone !== (expected ? "" : ch)) mismatches.push(`${hex(codePoint)} alone`);
      const inside = `a${ch}b`;
      if (stripInvisibleCharacters(inside) !== inside.replace(before, "")) mismatches.push(`${hex(codePoint)} between letters`);
    }
    expect(mismatches).toEqual([]);
    // About 4,200 code points qualify; far fewer would mean the property names above silently matched nothing.
    expect(dropped).toBeGreaterThan(3000);
  });
});

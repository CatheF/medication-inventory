// Unit tests for lib/search-text.ts: the ONE definition of how typed search text is cleaned for display and how text is
// folded for comparison. The Inventory search, the Admin list search, the order sheet's item search and the Admin
// category picker (combobox) all go through it, so what it does is pinned here directly and, for each caller, in
// tests/unit/inventory-view.test.ts, tests/unit/combobox.test.ts and tests/unit/filter-chips.test.ts.
//
// Synthetic data only. Odd characters are built from code points on purpose: written literally they are unreadable in
// a diff, and an editor or tool that normalizes text would silently turn the decomposed cases into precomposed ones.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bodyList, bodyRecord } from "../helpers/api-test-kit";
import { installFake, LIVE_AFTER_MIGRATION, type FakeSupabase } from "../helpers/fake-supabase";
import { jsonRequest } from "../helpers/fixtures-extra";

vi.mock("@/lib/db", async () => {
  const { supabaseProxy } = await import("../helpers/fake-supabase");
  return { supabase: supabaseProxy };
});

import * as categoriesRoute from "@/app/api/categories/route";
import { displaySearchText, foldSearchText } from "@/lib/search-text";

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
const hex = (n: number): string => `U+${n.toString(16).toUpperCase().padStart(4, "0")}`;

const GRAVE = cp(0x0300); // combining marks
const ACUTE = cp(0x0301);
const TILDE = cp(0x0303);
const DIAERESIS = cp(0x0308);
const CEDILLA = cp(0x0327);
const ENCLOSING_CIRCLE = cp(0x20dd); // a mark of category Me, not Mn

const E_GRAVE = cp(0x00e8); // precomposed letters
const E_ACUTE = cp(0x00e9);
const E_ACUTE_UPPER = cp(0x00c9);
const E_CIRCUMFLEX_DOT_BELOW = cp(0x1ec7); // Vietnamese, two marks in one letter
const A_GRAVE = cp(0x00e0);
const A_RING = cp(0x00e5);
const C_CEDILLA = cp(0x00e7);
const I_DIAERESIS = cp(0x00ef);
const N_TILDE = cp(0x00f1);
const U_ACUTE = cp(0x00fa);
const U_DIAERESIS = cp(0x00fc);
const A_ACUTE = cp(0x00e1);
const S_CARON = cp(0x0161);
const Z_CARON = cp(0x017e);
const C_CARON_UPPER = cp(0x010c);
const RIGHT_QUOTE = cp(0x2019);

const ZWSP = cp(0x200b); // invisible characters
const ZWJ = cp(0x200d);
const SOFT_HYPHEN = cp(0x00ad);
const BOM = cp(0xfeff);
const NBSP = cp(0x00a0);

const MICRO_SIGN = cp(0x00b5);
const GREEK_MU = cp(0x03bc);
const FULLWIDTH_ABC = cp(0xff21, 0xff22, 0xff23);
const LIGATURE_FI = cp(0xfb01);
const SQUARE_MG = cp(0x338e);
const SUPERSCRIPT_TWO = cp(0x00b2);

const HANGUL_HAN = cp(0xd55c); // a syllable block: three letters (jamo) when decomposed
const HANGUL_HA = cp(0xd558); // its first two letters
const HANGUL_GEUL = cp(0xae00);

/** U+00A8, U+00B4 ... : spacing forms of a diacritic. NFKC turns each into a space plus a combining mark. */
const SPACING_DIACRITICS = [0x00a8, 0x00af, 0x00b4, 0x00b8, 0x02d8, 0x02d9, 0x02da, 0x02db, 0x02dc, 0x02dd].map((n) => cp(n));

const hasWord = (text: string): boolean => /\S/u.test(text);

// ── foldSearchText ──────────────────────────────────────────────────────────────

describe("foldSearchText", () => {
  describe("drops accents, whichever way they are written", () => {
    it.each<[string, string, string]>([
      ["a grave accent", `Cr${E_GRAVE}me`, "creme"],
      ["an acute accent", `Caf${E_ACUTE}`, "cafe"],
      ["a capital with an accent", `${E_ACUTE_UPPER}CLAIR`, "eclair"],
      ["several accents in one text", `${E_ACUTE_UPPER}mulsion ${A_GRAVE} l${RIGHT_QUOTE}huile (na${I_DIAERESIS}ve caf${E_ACUTE})`, `emulsion a l${RIGHT_QUOTE}huile (naive cafe)`],
      ["a tilde", `${N_TILDE}and${U_ACUTE}`, "nandu"],
      ["an umlaut", `${U_DIAERESIS}ber`, "uber"],
      ["a cedilla", `fa${C_CEDILLA}ade`, "facade"],
      ["a ring", `${A_RING}re`, "are"],
      ["carons and an acute accent (Czech)", `${C_CARON_UPPER}e${S_CARON}tina ${Z_CARON}lut${A_ACUTE}`, "cestina zluta"],
      ["two marks in one letter (Vietnamese)", `Vi${E_CIRCUMFLEX_DOT_BELOW}t`, "viet"],
      ["a letter and a combining grave accent", `Cre${GRAVE}me`, "creme"],
      ["a capital letter and a combining acute accent", `CAFE${ACUTE}`, "cafe"],
      ["two combining marks on one letter", `e${ACUTE}${CEDILLA}`, "e"],
      ["a combining mark on a digit", `5${ACUTE}0`, "50"],
      ["an enclosing mark (category Me)", `a${ENCLOSING_CIRCLE}b`, "ab"],
    ])("%s", (_label, input, expected) => {
      expect(foldSearchText(input)).toBe(expected);
    });

    it("gives composed and decomposed spellings of the same text one folded form", () => {
      const pairs: [string, string][] = [
        [`Cr${E_GRAVE}me`, `Cre${GRAVE}me`],
        [`Caf${E_ACUTE}`, `Cafe${ACUTE}`],
        [`${N_TILDE}and${U_ACUTE}`, `n${TILDE}andu${ACUTE}`],
        [`Vi${E_CIRCUMFLEX_DOT_BELOW}t`, `Vie${cp(0x0323, 0x0302)}t`],
      ];
      for (const [composed, decomposed] of pairs) {
        expect(composed).not.toBe(decomposed); // the pair really differs before folding
        expect(foldSearchText(composed)).toBe(foldSearchText(decomposed));
      }
    });

    it("gives an accented letter and its plain letter one folded form, in any case", () => {
      for (const [accented, plain] of [
        [`Cr${E_GRAVE}me`, "Creme"],
        [`CR${cp(0x00c8)}ME`, "creme"],
        [`${E_ACUTE_UPPER}clair`, "ECLAIR"],
      ] as const) {
        expect(foldSearchText(accented)).toBe(foldSearchText(plain));
      }
    });

    it("does not make different letters equal", () => {
      expect(foldSearchText(`Cr${E_GRAVE}me`)).not.toBe(foldSearchText("crime"));
      expect(foldSearchText(`Cr${E_GRAVE}me`)).not.toBe(foldSearchText("cree"));
      expect(foldSearchText(N_TILDE)).not.toBe(foldSearchText("m"));
    });

    it("composes an accent that an invisible character separates from its letter, then drops it", () => {
      expect(foldSearchText(`cafe${ZWSP}${ACUTE}`)).toBe("cafe");
      expect(foldSearchText(`Cre${ZWJ}${GRAVE}me`)).toBe("creme");
    });
  });

  describe("keeps what it did before", () => {
    it("lower-cases", () => {
      expect(foldSearchText("Amoxicillin 500 MG")).toBe("amoxicillin 500 mg");
    });

    it("removes invisible and format characters from anywhere", () => {
      for (const invisible of [ZWSP, ZWJ, SOFT_HYPHEN, BOM, cp(0x2060), cp(0x200e), cp(0xfe0f), cp(0x2066), cp(0xe0020)]) {
        expect(foldSearchText(`ab${invisible}cd`)).toBe("abcd");
        expect(foldSearchText(`${invisible}ab${invisible}`)).toBe("ab");
        expect(foldSearchText(invisible)).toBe("");
      }
    });

    it("treats compatibility forms as their plain spelling (NFKC)", () => {
      expect(foldSearchText(`10 ${MICRO_SIGN}g`)).toBe(foldSearchText(`10 ${GREEK_MU}g`));
      expect(foldSearchText(FULLWIDTH_ABC)).toBe("abc");
      expect(foldSearchText(`${LIGATURE_FI}ne`)).toBe("fine");
      expect(foldSearchText(SQUARE_MG)).toBe("mg");
      expect(foldSearchText(`cm${SUPERSCRIPT_TWO}`)).toBe("cm2");
    });

    it("leaves whitespace alone: collapsing and splitting is the caller's business", () => {
      expect(foldSearchText("a  b")).toBe("a  b");
      expect(foldSearchText(" a ")).toBe(" a ");
      expect(foldSearchText("a\t\nb")).toBe("a\t\nb");
    });

    it("returns an empty string for something that is not text (untyped callers)", () => {
      for (const value of [undefined, null, 42, {}, [], true]) {
        expect(foldSearchText(value as unknown as string)).toBe("");
      }
    });
  });

  describe("letters it does not fold (out of scope) are safe to search for", () => {
    // The folding is "an accent is a combining mark". These letters carry no mark: ligatures, the sharp s, the stroked o,
    // the Turkish dotless i. They must not crash and must find themselves; whether "oeuvre" should find the ligature is
    // not decided here.
    it.each<[string]>([[`${cp(0x0153)}uvre`], [`${cp(0x00e6)}ther`], [cp(0x00df)], [cp(0x00f8)], [cp(0x0131)], [`${cp(0x0142)}${cp(0x00f3)}d${cp(0x017a)}`]])(
      "%j",
      (text) => {
        expect(() => foldSearchText(text)).not.toThrow();
        expect(foldSearchText(text)).not.toBe("");
        expect(foldSearchText(foldSearchText(text))).toBe(foldSearchText(text));
        expect(foldSearchText(`x ${text} y`).includes(foldSearchText(text))).toBe(true); // it finds itself
      }
    );
  });

  describe("does not start matching more than accents", () => {
    it("keeps a Hangul syllable whole: the first two letters of 한 are not found inside it", () => {
      // Splitting a syllable block into its letters (NFD) is how accents are found; leaving it split would make a search
      // for 하 find 한 and every other block that starts with those two letters.
      expect(foldSearchText(HANGUL_HAN)).toBe(HANGUL_HAN);
      expect(foldSearchText(`${HANGUL_HAN}${HANGUL_GEUL}`).includes(foldSearchText(HANGUL_HA))).toBe(false);
      expect(foldSearchText(`${HANGUL_HAN}${HANGUL_GEUL}`).includes(foldSearchText(HANGUL_HAN))).toBe(true);
    });

    it("still gives a syllable typed as separate letters the folded form of the syllable", () => {
      expect(foldSearchText(HANGUL_HAN.normalize("NFD"))).toBe(foldSearchText(HANGUL_HAN));
    });
  });

  describe("text that is only accents", () => {
    it.each([[GRAVE], [ACUTE], [DIAERESIS], [ENCLOSING_CIRCLE], [cp(0x0903)], [`${ACUTE}${GRAVE}`]])("a lone combining mark %j folds to nothing", (mark) => {
      expect(foldSearchText(mark)).toBe("");
    });

    it.each(SPACING_DIACRITICS.map((ch) => [ch, hex(ch.codePointAt(0) ?? 0)] as const))(
      "the spacing diacritic %j (%s) folds to blank space: NFKC makes it a space plus a mark",
      (ch) => {
        expect(hasWord(foldSearchText(ch))).toBe(false);
      }
    );
  });

  it("never throws, is idempotent, and leaves no mark or invisible character, for every BMP character in three positions", () => {
    const marks = /\p{M}/u;
    const invisible = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
    const violations: string[] = [];
    // 65,536 characters x 3 positions: violations are collected and asserted once (an expect() per character is slow).
    for (let code = 0; code <= 0xffff; code += 1) {
      const ch = String.fromCharCode(code); // lone surrogates included: they are ordinary text to a search
      for (const text of [ch, `a${ch}b`, ` ${ch} `]) {
        const folded = foldSearchText(text);
        if (foldSearchText(folded) !== folded) violations.push(`${hex(code)} not idempotent`);
        if (marks.test(folded)) violations.push(`${hex(code)} mark left`);
        if (invisible.test(folded)) violations.push(`${hex(code)} invisible character left`);
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
  });
});

// ── displaySearchText ───────────────────────────────────────────────────────────

describe("displaySearchText", () => {
  it("shows the search as it was typed: accents, case, full-width letters and decomposed accents are all kept", () => {
    for (const text of [`Cr${E_GRAVE}me`, `CR${cp(0x00c8)}ME`, "creme", `Cre${GRAVE}me`, `${cp(0xff29)}buprofen`, `a${ACUTE}b`]) {
      expect(displaySearchText(text)).toBe(text);
    }
  });

  it("drops invisible characters, trims the ends and collapses inner whitespace to single spaces", () => {
    expect(displaySearchText(`  ibu${ZWSP}pro${SOFT_HYPHEN}fen \t 200\n\n mg  `)).toBe("ibuprofen 200 mg");
    expect(displaySearchText(`a${NBSP}${NBSP}b`)).toBe("a b");
    expect(displaySearchText(`a ${ZWSP} b`)).toBe("a b");
  });

  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["a number", 5],
    ["an object", {}],
    ["empty text", ""],
    ["spaces and a tab", " \t\n"],
    ["only invisible characters", `${ZWSP}${SOFT_HYPHEN} ${ZWJ}${BOM}`],
    ["a lone combining accent (nothing is left to search for)", ACUTE],
    ["several lone combining accents and spaces", ` ${ACUTE} ${GRAVE}${DIAERESIS} `],
    ["an accent after an invisible character", `${ZWSP}${ACUTE}`],
    ...SPACING_DIACRITICS.map((ch): [string, unknown] => [`the spacing diacritic ${hex(ch.codePointAt(0) ?? 0)}`, ch]),
  ])("is empty for %s", (_label, search) => {
    expect(displaySearchText(search)).toBe("");
  });

  it("keeps an accent that sits on a letter (it is part of what was typed)", () => {
    expect(displaySearchText(`e${ACUTE}`)).toBe(`e${ACUTE}`);
    expect(displaySearchText(` a ${ACUTE} `)).toBe(`a ${ACUTE}`); // one real word is left, so the search is kept as typed
  });

  it("is empty exactly when the folded search has no word in it (every BMP character in four positions)", () => {
    // "A filter is active" (the chip, the summary line, the empty-state message) and "the search has a term" (the match)
    // must never disagree: something is shown if and only if at least one term survives folding.
    const disagreements: string[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      const ch = String.fromCharCode(code);
      for (const search of [ch, `${ch}${ch}`, `a${ch}b`, ` ${ch} `]) {
        const shown = displaySearchText(search) !== "";
        const hasTerm = hasWord(foldSearchText(search));
        if (shown !== hasTerm) disagreements.push(`${hex(code)} in ${JSON.stringify(search)}: shown ${shown}, has a term ${hasTerm}`);
      }
    }
    expect(disagreements.slice(0, 10)).toEqual([]);
  });
});

// ── Folding is for searching only ───────────────────────────────────────────────

describe("category identity is not search folding", () => {
  // "Crème" and "Creme" are two different categories. Only the comparison of SEARCH text ignores accents; the rule that
  // decides whether a category name already exists (app/api/categories/route.ts) must keep telling them apart.
  let fake: FakeSupabase;
  beforeEach(() => {
    fake = installFake(LIVE_AFTER_MIGRATION);
  });

  it("keeps the accented and the plain spelling as two categories: the second is created, not the first handed back", async () => {
    const accented = await categoriesRoute.POST(jsonRequest("POST", "/api/categories", { name: `Cr${E_GRAVE}me` }));
    const plain = await categoriesRoute.POST(jsonRequest("POST", "/api/categories", { name: "Creme" }));
    expect(accented.status).toBe(201);
    expect(plain.status).toBe(201); // a new category, not the existing one handed back with 200
    const first = await bodyRecord(accented);
    const second = await bodyRecord(plain);
    expect(first.id).not.toBe(second.id);
    expect(fake.dump("categories").map((row) => row.name).sort()).toEqual(["Creme", `Cr${E_GRAVE}me`].sort());

    const listed = await bodyList(await categoriesRoute.GET());
    expect(listed.map((row) => row.name).sort()).toEqual(["Creme", `Cr${E_GRAVE}me`].sort()); // names exactly as typed
  });

  it("still hands back the existing category for the same name in another case or composition", async () => {
    const first = await bodyRecord(await categoriesRoute.POST(jsonRequest("POST", "/api/categories", { name: `Cr${E_GRAVE}me` })));
    for (const variant of [`CR${cp(0x00c8)}ME`, `Cre${GRAVE}me`]) {
      const again = await categoriesRoute.POST(jsonRequest("POST", "/api/categories", { name: variant }));
      expect(again.status, variant).toBe(200);
      expect((await bodyRecord(again)).id).toBe(first.id);
    }
    expect(fake.dump("categories")).toHaveLength(1);
  });
});

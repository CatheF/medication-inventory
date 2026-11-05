// Unit tests for lib/inventory-view.ts (the pure logic behind category browsing).
//
// Layout: table-driven tests per function, scenario tests for the failure modes the feature must never have
// (lost items, mislabeled categories, empty quotes), and a property-style matrix that runs every combination of
// search x stock x category x sort x grouped over uuid and bigint fixtures and checks the result against an
// independent, deliberately naive oracle. All data is synthetic (tests/helpers/fixtures.ts).
import { beforeAll, describe, expect, it } from "vitest";
import type { Category, Medication } from "@/lib/db";
import { parseCategoryId } from "@/lib/ids";
import {
  DEFAULT_VIEW,
  UNKNOWN_CATEGORY_FILTER,
  UNKNOWN_CATEGORY_ID,
  applyCategoryFilter,
  applySearchAndStock,
  categoryCounts,
  describeEmpty,
  groupByCategory,
  isLowStock,
  isUnknownCategoryFilter,
  matchesSearch,
  naturalCompare,
  selectView,
  sortItems,
  type CategoryCounts,
  type CategoryFilter,
  type EmptyKind,
  type ItemGroup,
  type SortKey,
  type StockFilter,
  type ViewState,
} from "@/lib/inventory-view";
import {
  CATEGORY_NAMES,
  SEED_ITEMS,
  buildCategories,
  buildManyMedications,
  buildMedications,
  categoryId,
  type IdShape,
} from "@/tests/helpers/fixtures";

// ── Helpers ─────────────────────────────────────────────────────────────────────

const LQ = "“"; // “
const RQ = "”"; // ”
const DOT = " · "; // " · "
// Invisible or look-alike characters are built from code points on purpose: as literals in source they are
// unreadable, and an editor that normalizes text would silently turn the NFD cases into NFC ones.
const NBSP = String.fromCodePoint(0x00a0); // no-break space
const COMBINING_ACUTE = String.fromCodePoint(0x0301);
const COMBINING_GRAVE = String.fromCodePoint(0x0300);
const ZWSP = String.fromCodePoint(0x200b); // zero width space
const ZWJ = String.fromCodePoint(0x200d); // zero width joiner
const SOFT_HYPHEN = String.fromCodePoint(0x00ad);
const MICRO_SIGN = String.fromCodePoint(0x00b5); // looks like the Greek mu below; "µg" is typed with either
const GREEK_MU = String.fromCodePoint(0x03bc);
const LIGATURE_FI = String.fromCodePoint(0xfb01);
const SQUARE_MG = String.fromCodePoint(0x338e); // one character that reads "mg"
const SUPERSCRIPT_TWO = String.fromCodePoint(0x00b2);
/** "Amox" typed with full-width letters (U+FF21..): the compatibility form IMEs and pasted web text produce. */
const fullWidth = (ascii: string): string => Array.from(ascii, (c) => String.fromCodePoint(c.charCodeAt(0) + 0xfee0)).join("");
/** "U+200B U+0020" for a string made of invisible characters, so test names stay readable. */
const codePoints = (text: string): string =>
  text === ""
    ? "empty"
    : Array.from(text, (c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`).join(" ");

// Characters that render as nothing. Pasted from web pages, PDFs, chat apps and email they make a search look blank
// while it is not, and inside a word they stop it from matching. The first twelve are the ones found in review;
// the rest are blank-looking too (U+3164 is the "invisible username" character) or can already sit in stored
// supplier numbers (the bidi isolates U+2066..2069, see the KNOWN FOUNDATION BUG tests in supplier-order-number.test.ts).
const INVISIBLE_CHARACTERS: readonly { label: string; char: string }[] = [
  { label: "U+200B zero width space", char: ZWSP },
  { label: "U+200C zero width non-joiner", char: String.fromCodePoint(0x200c) },
  { label: "U+200D zero width joiner", char: ZWJ },
  { label: "U+2060 word joiner", char: String.fromCodePoint(0x2060) },
  { label: "U+200E left-to-right mark", char: String.fromCodePoint(0x200e) },
  { label: "U+200F right-to-left mark", char: String.fromCodePoint(0x200f) },
  { label: "U+00AD soft hyphen", char: SOFT_HYPHEN },
  { label: "U+180E Mongolian vowel separator", char: String.fromCodePoint(0x180e) },
  { label: "U+2061 function application", char: String.fromCodePoint(0x2061) },
  { label: "U+FE0F variation selector-16", char: String.fromCodePoint(0xfe0f) },
  { label: "U+E0020 tag space", char: String.fromCodePoint(0xe0020) },
  { label: "U+FEFF byte order mark", char: String.fromCodePoint(0xfeff) },
  { label: "U+2066 left-to-right isolate", char: String.fromCodePoint(0x2066) },
  { label: "U+2069 pop directional isolate", char: String.fromCodePoint(0x2069) },
  { label: "U+202E right-to-left override", char: String.fromCodePoint(0x202e) },
  { label: "U+034F combining grapheme joiner", char: String.fromCodePoint(0x034f) },
  { label: "U+3164 Hangul filler", char: String.fromCodePoint(0x3164) },
];
const SHAPES: readonly IdShape[] = ["uuid", "bigint"];
const SORTS: readonly SortKey[] = ["name", "stock-asc", "category"];
const STOCKS: readonly StockFilter[] = ["all", "low", "ok"];

type Selected = ReturnType<typeof selectView>;

function item(id: number, overrides: Partial<Medication> = {}): Medication {
  return {
    id,
    name: `Item ${id}`,
    barcode: String(id).padStart(12, "0"),
    photo_url: null,
    stock: 10,
    threshold: 5,
    vendor_url: null,
    unit: "units",
    notes: null,
    category_id: null,
    supplier_order_number: null,
    is_unnamed: false,
    created_at: "2026-08-11T16:00:00+00:00",
    updated_at: "2026-10-28T16:02:00+00:00",
    ...overrides,
  };
}

function cat(id: string, name: string): Category {
  return { id, name, created_at: null };
}

function view(overrides: Partial<ViewState> = {}): ViewState {
  return { ...DEFAULT_VIEW, ...overrides };
}

const ids = (list: readonly Medication[]): number[] => list.map((m) => m.id);
const names = (list: readonly Medication[]): (string | null)[] => list.map((m) => m.name);
const titles = (groups: readonly ItemGroup[]): string[] => groups.map((g) => g.title);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Deterministic Fisher-Yates shuffle (mulberry32), so a failing permutation is reproducible. */
function shuffled<T>(list: readonly T[], seed: number): T[] {
  const out = list.slice();
  let state = seed >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const seedLowCount = SEED_ITEMS.filter((s) => s.stock <= s.threshold).length;
const seedUncategorizedCount = SEED_ITEMS.filter((s) => s.category === null).length;

// ── DEFAULT_VIEW ────────────────────────────────────────────────────────────────

describe("DEFAULT_VIEW", () => {
  it("matches the contract", () => {
    expect(DEFAULT_VIEW).toEqual({
      search: "",
      stock: "all",
      category: { kind: "all" },
      sort: "name",
      grouped: true,
    });
  });

  it("is frozen (also its category filter), and spreading it yields independent editable copies", () => {
    expect(Object.isFrozen(DEFAULT_VIEW)).toBe(true);
    expect(Object.isFrozen(DEFAULT_VIEW.category)).toBe(true);
    const copy = { ...DEFAULT_VIEW, search: "x" };
    expect(copy.search).toBe("x");
    expect(DEFAULT_VIEW.search).toBe("");
  });
});

// ── naturalCompare ──────────────────────────────────────────────────────────────

describe("naturalCompare", () => {
  const ordered: [string, string][] = [
    ["Item 2", "Item 10"],
    ["item 9", "ITEM 10"],
    ["apple", "Banana"],
    ["a", "B"],
    ["Zinc", "zz"],
    ["", "a"],
    ["Gloves M", "Gloves S"],
    ["10 mg", "100 mg"],
    ["Vitamin B2", "Vitamin B12"],
  ];

  it.each(ordered.map(([a, b]) => ({ a, b })))("orders $a before $b", ({ a, b }) => {
    expect(naturalCompare(a, b)).toBeLessThan(0);
    expect(naturalCompare(b, a)).toBeGreaterThan(0);
  });

  it.each([
    ["apple", "APPLE"],
    ["resume", "résumé"],
    ["e" + COMBINING_ACUTE, "é"],
    ["", ""],
  ])("treats %j and %j as equal (case and accents never decide the order)", (a, b) => {
    expect(naturalCompare(a, b)).toBe(0);
  });

  it("has the same ordering as localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })", () => {
    const corpus = [
      "", " ", " leading", "a", "A", "á", "b", "B", "Item 1", "item 2", "Item 10", "ITEM 100", "item 02",
      "9", "10", "09", "9a", "Zed", "zed", "é", "e" + COMBINING_ACUTE, "ß", "ss", "Crème 1%", "Creme 10%",
      "Acetaminophen 500 mg, tablets", "Acetaminophen 160 mg/5 mL", "MED-1003", "MED-999", "0049000028911",
      "012345600007", "日本語", String.fromCodePoint(0x627, 0x644), "Emoji 💊", "x".repeat(40), "x".repeat(41),
    ];
    const options = { numeric: true, sensitivity: "base" } as const;
    const disagreements: string[] = [];
    for (const a of corpus) {
      for (const b of corpus) {
        const expected = Math.sign(a.localeCompare(b, undefined, options));
        if (Math.sign(naturalCompare(a, b)) !== expected) disagreements.push(`${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      }
    }
    expect(disagreements).toEqual([]);
  });
});

// ── matchesSearch ───────────────────────────────────────────────────────────────

describe("matchesSearch", () => {
  const amox = item(1, {
    name: "Amoxicillin 500 mg, capsules",
    barcode: "0123456789012",
    supplier_order_number: "AMX-500",
  });
  const unnamed = item(2, { name: null, barcode: "0049000028911", is_unnamed: true });
  const plain = item(3, { name: "Foo", barcode: "123", supplier_order_number: "BAR" });
  const gauze = item(4, { name: 'Gauze pads 4"x4", sterile', barcode: "MED-1004" });
  const creme = item(5, { name: "Crème antiseptique 1 %" });
  const cremeDecomposed = item(6, { name: "Cre" + COMBINING_GRAVE + "me antiseptique 1 %" });
  const japanese = item(7, { name: "日本語の薬品名 500mg" });
  const leadingZero = item(8, { name: "Ibuprofen", barcode: "000123", supplier_order_number: "0092" });

  const cases: { label: string; med: Medication; search: string; expected: boolean }[] = [
    { label: "empty search matches everything", med: amox, search: "", expected: true },
    { label: "whitespace-only search matches everything", med: amox, search: "   ", expected: true },
    { label: "tabs and newlines only match everything", med: unnamed, search: "\t\n ", expected: true },
    { label: "name, lower case", med: amox, search: "amox", expected: true },
    { label: "name, upper case", med: amox, search: "AMOXICILLIN", expected: true },
    { label: "name, mixed case", med: amox, search: "aMoXiCiLLiN", expected: true },
    { label: "punctuation inside the name", med: amox, search: "mg,", expected: true },
    { label: "barcode", med: amox, search: "0123456789012", expected: true },
    { label: "barcode prefix keeps its leading zero", med: amox, search: "0123", expected: true },
    { label: "barcode middle", med: amox, search: "56789", expected: true },
    { label: "supplier order number, lower case", med: amox, search: "amx-500", expected: true },
    { label: "supplier order number prefix", med: amox, search: "AMX", expected: true },
    { label: "supplier order number with leading zeros", med: leadingZero, search: "0092", expected: true },
    { label: "supplier order number suffix", med: leadingZero, search: "92", expected: true },
    { label: "two terms, both in the name", med: amox, search: "amox capsules", expected: true },
    { label: "term order does not matter", med: amox, search: "capsules amox", expected: true },
    { label: "multi-word AND: second term missing", med: amox, search: "amox tablets", expected: false },
    { label: "multi-word AND: first term missing", med: amox, search: "tablets capsules", expected: false },
    { label: "three terms, one missing", med: amox, search: "amox 500 zzz", expected: false },
    { label: "terms may come from different fields", med: amox, search: "amoxicillin 0123456789012 AMX-500", expected: true },
    { label: "name + supplier number terms", med: amox, search: "capsules amx", expected: true },
    { label: "extra spaces around and between terms", med: amox, search: "  amox   capsules  ", expected: true },
    { label: "tab between terms", med: amox, search: "amox\tcapsules", expected: true },
    { label: "newline between terms", med: amox, search: "amox\ncapsules", expected: true },
    { label: "no-break space between terms", med: amox, search: "amox" + NBSP + "capsules", expected: true },
    { label: "a term never matches across the name/barcode boundary", med: plain, search: "foo123", expected: false },
    { label: "a term never matches across the barcode/supplier boundary", med: plain, search: "123bar", expected: false },
    { label: "unnamed item matches on its barcode", med: unnamed, search: "0049000028911", expected: true },
    { label: "unnamed item matches on a barcode fragment", med: unnamed, search: "49000", expected: true },
    { label: "unnamed item does not match the text 'null'", med: unnamed, search: "null", expected: false },
    { label: "unnamed item does not match 'unnamed'", med: unnamed, search: "unnamed", expected: false },
    { label: "missing supplier number does not match 'null'", med: plain, search: "null", expected: false },
    { label: "missing supplier number does not match 'undefined'", med: plain, search: "undefined", expected: false },
    { label: "quotes are literal characters", med: gauze, search: '4"x4"', expected: true },
    { label: "regex metacharacters are literal: dot-star", med: plain, search: ".*", expected: false },
    { label: "regex metacharacters are literal: open paren", med: plain, search: "(", expected: false },
    { label: "regex metacharacters are literal: bracket", med: plain, search: "[", expected: false },
    { label: "regex metacharacters are literal: backslash", med: plain, search: "\\", expected: false },
    { label: "a plus sign is just a plus sign", med: plain, search: "+", expected: false },
    { label: "accented name, upper-case search", med: creme, search: "CRÈME", expected: true },
    { label: "precomposed name, decomposed search", med: creme, search: "cre" + COMBINING_GRAVE + "me", expected: true },
    { label: "decomposed name, precomposed search", med: cremeDecomposed, search: "crème", expected: true },
    { label: "non-Latin script", med: japanese, search: "日本語", expected: true },
    { label: "non-Latin script mixed with digits", med: japanese, search: "薬品名 500", expected: true },
  ];

  it.each(cases)("$label", ({ med, search, expected }) => {
    expect(matchesSearch(med, search)).toBe(expected);
  });
});

// ── matchesSearch: invisible characters and compatibility forms ─────────────────
//
// Review finding: text pasted from a web page, PDF or chat app carries zero-width and other format characters. They
// are not whitespace, so a search made only of them used to count as real text (every item hidden behind an
// empty-looking “” message), and one inside a word stopped it matching. Folding was also NFC-only, so look-alike
// forms (micro sign vs Greek mu in "µg", full-width letters, ligatures) never matched their plain spelling.

describe("matchesSearch: invisible characters and compatibility forms", () => {
  const amox = item(1, {
    name: "Amoxicillin 500 mg, capsules",
    barcode: "0123456789012",
    supplier_order_number: "AMX-500",
  });
  const unnamed = item(2, { name: null, barcode: "0049000028911", is_unnamed: true });

  it.each(INVISIBLE_CHARACTERS)("ignores $label typed inside a word, at either end, or in a supplier code", ({ char }) => {
    expect(matchesSearch(amox, `amox${char}icillin`)).toBe(true);
    expect(matchesSearch(amox, `${char}amox${char}`)).toBe(true);
    expect(matchesSearch(amox, `AMX${char}-500`)).toBe(true);
    expect(matchesSearch(amox, `01234${char}56789`)).toBe(true); // barcode
  });

  it.each(INVISIBLE_CHARACTERS)("ignores $label stored inside the name, the barcode and the supplier order number", ({ char }) => {
    const stored = item(3, { name: `Amox${char}icillin 500`, barcode: `01${char}23`, supplier_order_number: `00${char}417-B` });
    expect(matchesSearch(stored, "amoxicillin")).toBe(true);
    expect(matchesSearch(stored, "0123")).toBe(true);
    expect(matchesSearch(stored, "00417-b")).toBe(true);
    expect(matchesSearch(stored, `amox${char}icillin`)).toBe(true); // typed with the same character
  });

  it.each(INVISIBLE_CHARACTERS)("treats a search made only of $label as no search", ({ char }) => {
    for (const search of [char, char + char, ` ${char} `, `\t${char}\n${char}`]) {
      expect(matchesSearch(amox, search), codePoints(search)).toBe(true);
      expect(matchesSearch(unnamed, search), codePoints(search)).toBe(true);
    }
  });

  const compatibility: { label: string; name: string; search: string; expected: boolean }[] = [
    { label: "micro sign in the name, Greek mu typed", name: `Cyanocobalamin 500 ${MICRO_SIGN}g`, search: `${GREEK_MU}g`, expected: true },
    { label: "Greek mu in the name, micro sign typed", name: `Cyanocobalamin 500 ${GREEK_MU}g`, search: `${MICRO_SIGN}g`, expected: true },
    { label: "micro sign in both", name: `Cyanocobalamin 500 ${MICRO_SIGN}g`, search: `500 ${MICRO_SIGN}g`, expected: true },
    { label: "full-width letters typed", name: "Amoxicillin 500 mg", search: fullWidth("AMOX"), expected: true },
    { label: "full-width digits typed", name: "Amoxicillin 500 mg", search: fullWidth("500"), expected: true },
    { label: "full-width letters in the name", name: `${fullWidth("AMOX")} 500`, search: "amox", expected: true },
    { label: "ligature typed", name: "First aid kit", search: `${LIGATURE_FI}rst`, expected: true },
    { label: "ligature in the name", name: `${LIGATURE_FI}rst aid kit`, search: "first", expected: true },
    { label: "one-character unit sign in the name", name: `Aspirin 81 ${SQUARE_MG}`, search: "mg", expected: true },
    { label: "one-character unit sign typed", name: "Aspirin 81 mg", search: `81 ${SQUARE_MG}`, expected: true },
    { label: "superscript digit in the name", name: `Cream 5 mg/cm${SUPERSCRIPT_TWO}`, search: "cm2", expected: true },
    { label: "plain text is still plain text: a different letter does not match", name: `Cyanocobalamin 500 ${MICRO_SIGN}g`, search: "mg", expected: false },
    { label: "a character that is really there still has to be there", name: "Amoxicillin 500 mg", search: `amoxicillin${MICRO_SIGN}`, expected: false },
  ];

  it.each(compatibility)("$label", ({ name, search, expected }) => {
    expect(matchesSearch(item(4, { name }), search)).toBe(expected);
  });

  it("composes an accent that an invisible character separates from its letter, in the search and in the name", () => {
    const creme = item(5, { name: "Crème antiseptique 1 %" });
    expect(matchesSearch(creme, `cre${ZWJ}${COMBINING_GRAVE}me`)).toBe(true);
    expect(matchesSearch(item(6, { name: `Cre${ZWJ}${COMBINING_GRAVE}me antiseptique` }), "crème")).toBe(true);
  });

  it("still splits words on whitespace around an invisible character, and still needs every term", () => {
    expect(matchesSearch(amox, `amox ${ZWSP} capsules`)).toBe(true);
    expect(matchesSearch(amox, `amox${ZWSP} ${SOFT_HYPHEN}tablets`)).toBe(false);
    expect(matchesSearch(amox, `${ZWSP}zzz${ZWSP}`)).toBe(false);
  });

  it("does not let an invisible character glue two words or two fields into one term", () => {
    expect(matchesSearch(amox, `amoxicillin${ZWSP}capsules`)).toBe(false); // "amoxicilincapsules" is not in the text
    const plain = item(7, { name: `Foo${ZWSP}`, barcode: `${ZWSP}123`, supplier_order_number: "BAR" });
    expect(matchesSearch(plain, "foo123")).toBe(false);
    expect(matchesSearch(plain, `foo${ZWSP}123`)).toBe(false);
    expect(matchesSearch(plain, "123bar")).toBe(false);
    expect(matchesSearch(plain, "foo 123 bar")).toBe(true);
  });

  it("never disagrees with itself about what counts as a search, for every BMP character and the astral format blocks", () => {
    // The summary line, the empty-state message and the filter each decide "is there a search?". They must agree for
    // any character a user can paste: "reported as a filter" has to mean "has at least one term". The hollow item's
    // searchable text is only spaces, so a search with a term never matches it; a search without one always does.
    const hollow = item(1, { name: "", barcode: "" });
    const lone = [item(2, { name: "Alpha" })];
    const codePointsToCheck: number[] = [];
    const addRange = (from: number, to: number): void => {
      for (let cp = from; cp <= to; cp += 1) codePointsToCheck.push(cp);
    };
    addRange(0x0000, 0xffff); // includes the surrogate range: a lone surrogate must not throw either
    addRange(0x110bd, 0x110bd);
    addRange(0x110cd, 0x110cd);
    addRange(0x13430, 0x1343f);
    addRange(0x1bca0, 0x1bca3);
    addRange(0x1d173, 0x1d17a);
    addRange(0xe0000, 0xe01ef); // tags and variation selectors supplement

    const disagreements: string[] = [];
    const blank: number[] = [];
    for (const cp of codePointsToCheck) {
      const search = String.fromCodePoint(cp);
      const hasTerm = !matchesSearch(hollow, search);
      const { summary, visible } = selectView(lone, [], view({ search }));
      if (hasTerm !== summary.filtersActive) disagreements.push(`U+${cp.toString(16).toUpperCase()} filter/term mismatch`);
      if (!hasTerm) {
        blank.push(cp);
        if (visible.length !== 1) disagreements.push(`U+${cp.toString(16).toUpperCase()} blank search hid items`);
      }
    }
    expect(disagreements.slice(0, 5)).toEqual([]);
    // not vacuous: every character the review found is blank, and blank characters are a real set, not just spaces
    for (const { char } of INVISIBLE_CHARACTERS) expect(blank, codePoints(char)).toContain(char.codePointAt(0));
    expect(blank.length).toBeGreaterThan(150);
  });

  it("copes with lone surrogates, control characters and a very long paste", () => {
    const long = "amox".repeat(50_000);
    const odd = [0xd800, 0xdc00, 0x0000, 0x0085, 0x001d, 0x2800].map((cp) => String.fromCodePoint(cp));
    for (const search of [...odd, `a${odd[0]}b`, long, `${long}${ZWSP}`]) {
      expect(() => matchesSearch(amox, search)).not.toThrow();
      expect(() => selectView([amox], [], view({ search }))).not.toThrow();
    }
    expect(matchesSearch(amox, long)).toBe(false);
  });

  it("handles a character whose compatibility form contains a space: terms are split after folding, never empty", () => {
    // U+00A8 (diaeresis) normalizes to a space plus a combining diaeresis. Splitting before folding would leave a
    // term with a space inside it (or an empty term) and let it match across the name/barcode boundary.
    const diaeresis = String.fromCodePoint(0x00a8);
    expect(() => matchesSearch(amox, diaeresis)).not.toThrow();
    expect(matchesSearch(item(8, { name: `Cafe${diaeresis}` }), `cafe${diaeresis}`)).toBe(true);
    expect(matchesSearch(amox, `amox${diaeresis}`)).toBe(false);
  });
});

// ── applySearchAndStock ─────────────────────────────────────────────────────────

describe("applySearchAndStock", () => {
  const boundary: { stock: number; threshold: number; low: boolean }[] = [
    { stock: 0, threshold: 0, low: true },
    { stock: 0, threshold: 10, low: true },
    { stock: 4, threshold: 5, low: true },
    { stock: 5, threshold: 5, low: true },
    { stock: 6, threshold: 5, low: false },
    { stock: 1, threshold: 0, low: false },
    { stock: 100, threshold: 0, low: false },
  ];

  it.each(boundary)("stock $stock vs threshold $threshold -> low: $low", ({ stock, threshold, low }) => {
    const one = [item(1, { stock, threshold })];
    expect(isLowStock(one[0])).toBe(low);
    expect(applySearchAndStock(one, { search: "", stock: "low" })).toHaveLength(low ? 1 : 0);
    expect(applySearchAndStock(one, { search: "", stock: "ok" })).toHaveLength(low ? 0 : 1);
    expect(applySearchAndStock(one, { search: "", stock: "all" })).toHaveLength(1);
  });

  it.each(SHAPES)("low and ok partition the search results, never losing or duplicating an item (%s ids)", (shape) => {
    const items = buildMedications({ shape });
    for (const search of ["", "tablets", "mg", "amox", "zzz", "0092", "gloves"]) {
      const all = applySearchAndStock(items, { search, stock: "all" });
      const low = applySearchAndStock(items, { search, stock: "low" });
      const ok = applySearchAndStock(items, { search, stock: "ok" });
      expect(low.length + ok.length, `search ${JSON.stringify(search)}`).toBe(all.length);
      expect(new Set([...ids(low), ...ids(ok)]).size).toBe(all.length);
      expect(ids([...low, ...ok]).sort((a, b) => a - b)).toEqual(ids(all).sort((a, b) => a - b));
      expect(low.every(isLowStock)).toBe(true);
      expect(ok.some(isLowStock)).toBe(false);
    }
  });

  it("keeps the input order, returns a new array, and does not touch frozen input", () => {
    const items = deepFreeze(buildMedications());
    const result = applySearchAndStock(items, { search: "", stock: "all" });
    expect(result).not.toBe(items);
    expect(ids(result)).toEqual(ids(items));
    const tablets = applySearchAndStock(items, { search: "tablets", stock: "all" });
    expect(ids(tablets)).toEqual(ids(items.filter((m) => (m.name ?? "").includes("tablets"))));
  });

  it("counts an item with unusable stock as ok instead of losing it between the two filters", () => {
    const broken = item(1, { stock: Number.NaN, threshold: 5 });
    expect(applySearchAndStock([broken], { search: "", stock: "low" })).toHaveLength(0);
    expect(applySearchAndStock([broken], { search: "", stock: "ok" })).toHaveLength(1);
  });

  it("finds the fixture items by supplier order number, leading zeros included", () => {
    const items = buildMedications();
    const byLeadingZeros = applySearchAndStock(items, { search: "0092", stock: "all" });
    expect(byLeadingZeros.map((m) => m.supplier_order_number)).toContain("0092");
    const byCode = applySearchAndStock(items, { search: "00417-b", stock: "all" });
    expect(ids(byCode)).toEqual([100]);
    const byLetters = applySearchAndStock(items, { search: "GZ-44", stock: "all" });
    expect(byLetters.map((m) => m.supplier_order_number)).toEqual(["GZ-44/200"]);
  });
});

// ── categoryCounts ──────────────────────────────────────────────────────────────

describe("categoryCounts", () => {
  it.each(SHAPES)("counts every bucket for the fixtures (%s ids)", (shape) => {
    const categories = buildCategories(shape);
    const counts = categoryCounts(buildMedications({ shape }), categories);
    const expectedById: Record<string, number> = {};
    categories.forEach((c, i) => {
      expectedById[c.id] = SEED_ITEMS.filter((s) => s.category === i).length;
    });
    expect(counts).toEqual({
      all: SEED_ITEMS.length,
      uncategorized: seedUncategorizedCount,
      unknown: 0,
      byId: expectedById,
    });
  });

  it("lists categories without items with a count of 0", () => {
    const categories = [cat("a", "Alpha"), cat("b", "Beta")];
    const counts = categoryCounts([item(1, { category_id: "a" })], categories);
    expect(counts.byId).toEqual({ a: 1, b: 0 });
  });

  it("counts items whose category is missing from the list as unknown, never as uncategorized", () => {
    const categories = [cat("a", "Alpha")];
    const items = [
      item(1, { category_id: "a" }),
      item(2, { category_id: "ghost" }),
      item(3, { category_id: "ghost-2" }),
      item(4, { category_id: null }),
    ];
    expect(categoryCounts(items, categories)).toEqual({ all: 4, uncategorized: 1, unknown: 2, byId: { a: 1 } });
  });

  it("treats every categorized item as unknown when the category list is empty (categories failed to load)", () => {
    const items = buildMedications();
    const counts = categoryCounts(items, []);
    expect(counts).toEqual({
      all: items.length,
      uncategorized: seedUncategorizedCount,
      unknown: items.length - seedUncategorizedCount,
      byId: {},
    });
  });

  it("keeps the accounting identity all = uncategorized + unknown + sum(byId)", () => {
    for (const shape of SHAPES) {
      const full = buildCategories(shape);
      for (const categories of [full, [], full.slice(2), full.filter((_, i) => i % 2 === 0)]) {
        const counts = categoryCounts(buildMedications({ shape }), categories);
        const sum = Object.values(counts.byId).reduce((a, b) => a + b, 0);
        expect(counts.uncategorized + counts.unknown + sum).toBe(counts.all);
      }
    }
  });

  it("compares ids as strings: numeric ids from a bigint column still match, uuid case does not matter", () => {
    const categories = [cat("3", "Three"), cat("ABCDEF00-0000-4000-8000-000000000001", "Upper")];
    const items = [
      item(1, { category_id: 3 as unknown as string }), // a raw bigint that skipped normalization
      item(2, { category_id: "3" }),
      item(3, { category_id: "abcdef00-0000-4000-8000-000000000001" }),
    ];
    const counts = categoryCounts(items, categories);
    expect(counts.byId).toEqual({ "3": 2, "ABCDEF00-0000-4000-8000-000000000001": 1 });
    expect(counts.unknown).toBe(0);
  });

  it("treats a blank or missing category_id as uncategorized, not as unknown", () => {
    const rows = [
      item(1, { category_id: "" }),
      item(2, { category_id: "   " }),
      item(3, { category_id: undefined as unknown as null }),
      item(4, { category_id: null }),
    ];
    expect(categoryCounts(rows, [cat("a", "Alpha")])).toEqual({ all: 4, uncategorized: 4, unknown: 0, byId: { a: 0 } });
  });

  it("does not double count when the category list repeats an id", () => {
    const categories = [cat("a", "Alpha"), cat("a", "Alpha again")];
    const counts = categoryCounts([item(1, { category_id: "a" })], categories);
    expect(counts.byId).toEqual({ a: 1 });
    expect(counts.all).toBe(1);
  });

  it("returns zeros for an empty list", () => {
    expect(categoryCounts([], buildCategories())).toEqual({
      all: 0,
      uncategorized: 0,
      unknown: 0,
      byId: Object.fromEntries(buildCategories().map((c) => [c.id, 0])),
    });
  });
});

// ── applyCategoryFilter ─────────────────────────────────────────────────────────

describe("applyCategoryFilter", () => {
  const categories = [cat("a", "Alpha"), cat("b", "Beta")];
  const items = [
    item(1, { category_id: "a" }),
    item(2, { category_id: "b" }),
    item(3, { category_id: null }),
    item(4, { category_id: "ghost" }),
    item(5, { category_id: "a" }),
  ];

  const cases: { label: string; filter: CategoryFilter; expected: number[] }[] = [
    { label: "all keeps everything in order", filter: { kind: "all" }, expected: [1, 2, 3, 4, 5] },
    { label: "uncategorized keeps only items without a category", filter: { kind: "uncategorized" }, expected: [3] },
    { label: "a category keeps its items in order", filter: { kind: "category", id: "a" }, expected: [1, 5] },
    { label: "another category", filter: { kind: "category", id: "b" }, expected: [2] },
    { label: "the unknown pseudo id selects items whose category is missing", filter: { kind: "category", id: UNKNOWN_CATEGORY_ID }, expected: [4] },
    { label: "an id missing from the list still reaches its items", filter: { kind: "category", id: "ghost" }, expected: [4] },
    { label: "an id nobody uses gives an empty list", filter: { kind: "category", id: "nobody" }, expected: [] },
    { label: "a blank id selects nothing (it must not behave like uncategorized)", filter: { kind: "category", id: "" }, expected: [] },
    { label: "ids match case-insensitively", filter: { kind: "category", id: "A" }, expected: [1, 5] },
  ];

  it.each(cases)("$label", ({ filter, expected }) => {
    expect(ids(applyCategoryFilter(items, filter, categories))).toEqual(expected);
  });

  it("never lets a category that carries the reserved id 'unknown' shadow the 'Category unavailable' bucket", () => {
    const withImpostor = [cat(UNKNOWN_CATEGORY_ID, "Impostor"), cat("a", "Alpha")];
    const rows = [item(1, { category_id: UNKNOWN_CATEGORY_ID }), item(2, { category_id: "a" })];
    expect(ids(applyCategoryFilter(rows, { kind: "category", id: UNKNOWN_CATEGORY_ID }, withImpostor))).toEqual([1]);
    const result = selectView(rows, withImpostor, view());
    expect(titles(result.groups ?? [])).toEqual(["Alpha", "Category unavailable"]);
    expect(result.counts).toEqual({ all: 2, uncategorized: 0, unknown: 1, byId: { a: 1 } });
  });

  it("does not turn orphaned items into uncategorized ones", () => {
    const uncategorized = applyCategoryFilter(items, { kind: "uncategorized" }, categories);
    expect(ids(uncategorized)).not.toContain(4);
  });

  it("with the category list empty, 'unknown' covers every categorized item", () => {
    const result = applyCategoryFilter(items, { kind: "category", id: UNKNOWN_CATEGORY_ID }, []);
    expect(ids(result)).toEqual([1, 2, 4, 5]);
  });

  it("returns a new array and works on frozen input", () => {
    const frozen = deepFreeze(items.map((m) => ({ ...m })));
    const result = applyCategoryFilter(frozen, { kind: "all" }, categories);
    expect(result).not.toBe(frozen);
    expect(ids(result)).toEqual(ids(frozen));
  });

  it.each(SHAPES)("selects the fixture items of one category (%s ids)", (shape) => {
    const cats = buildCategories(shape);
    const meds = buildMedications({ shape });
    const antibioticsIndex = CATEGORY_NAMES.indexOf("Antibiotics");
    const result = applyCategoryFilter(meds, { kind: "category", id: categoryId(antibioticsIndex, shape) }, cats);
    expect(names(result)).toEqual([
      "Amoxicillin 500 mg, capsules",
      "Azithromycin 250 mg, tablets",
      "Nitrofurantoin 100 mg, capsules",
    ]);
  });
});

// ── sortItems ───────────────────────────────────────────────────────────────────

describe("sortItems", () => {
  it("name: natural order, so 2 comes before 10", () => {
    const list = ["Item 10", "Item 2", "Item 1", "Item 20", "Item 3"].map((name, i) => item(i + 1, { name }));
    expect(names(sortItems(list, "name", []))).toEqual(["Item 1", "Item 2", "Item 3", "Item 10", "Item 20"]);
  });

  it("name: case-insensitive", () => {
    const list = ["banana", "Apple", "cherry", "APRICOT", "Blueberry"].map((name, i) => item(i + 1, { name }));
    expect(names(sortItems(list, "name", []))).toEqual(["Apple", "APRICOT", "banana", "Blueberry", "cherry"]);
  });

  it("name: ignores leading and trailing blanks in the name", () => {
    const list = [item(1, { name: "  Zinc" }), item(2, { name: "Aspirin  " }), item(3, { name: " Magnesium" })];
    expect(names(sortItems(list, "name", []))).toEqual(["Aspirin  ", " Magnesium", "  Zinc"]);
  });

  it("name: unnamed items go last, ordered by barcode in natural order", () => {
    const list = [
      item(1, { name: null, barcode: "10" }),
      item(2, { name: "Zinc", barcode: "500" }),
      item(3, { name: null, barcode: "9" }),
      item(4, { name: "Aspirin", barcode: "400" }),
      item(5, { name: null, barcode: "2" }),
    ];
    expect(ids(sortItems(list, "name", []))).toEqual([4, 2, 5, 3, 1]);
  });

  it("name: a blank name counts as unnamed", () => {
    const list = [
      item(1, { name: "   ", barcode: "B" }),
      item(2, { name: "Zinc", barcode: "Z" }),
      item(3, { name: "", barcode: "A" }),
      item(4, { name: null, barcode: "C" }),
    ];
    expect(ids(sortItems(list, "name", []))).toEqual([2, 3, 1, 4]);
  });

  it("stock-asc: lowest stock first, then name; unnamed items last within the same stock", () => {
    const list = [
      item(1, { name: "Zinc", stock: 5 }),
      item(2, { name: "Aspirin", stock: 5 }),
      item(3, { name: "Mid", stock: 20 }),
      item(4, { name: "Empty", stock: 0 }),
      item(5, { name: null, barcode: "1", stock: 5 }),
      item(6, { name: "Item 10", stock: 5 }),
      item(7, { name: "Item 2", stock: 5 }),
    ];
    expect(ids(sortItems(list, "stock-asc", []))).toEqual([4, 2, 7, 6, 1, 5, 3]);
  });

  it("stock-asc: unusable stock values sort after real numbers instead of breaking the order", () => {
    // The NaN items are alphabetically first, so a comparator that treated NaN as "equal" would put them first.
    const list = [
      item(1, { name: "Anan-1", stock: Number.NaN }),
      item(2, { name: "Zeta", stock: 3 }),
      item(3, { name: "Zulu", stock: 0 }),
      item(4, { name: "Anan-2", stock: Number.NaN }),
      item(5, { name: "Zed", stock: 9 }),
    ];
    expect(ids(sortItems(list, "stock-asc", []))).toEqual([3, 2, 5, 1, 4]);
  });

  describe("category order", () => {
    const categories = [cat("c-z", "Zebra"), cat("c-a", "apple"), cat("c-m", "Mango")];
    const list = [
      item(1, { name: "Un-categorized B", category_id: null }),
      item(2, { name: "Zebra thing", category_id: "c-z" }),
      item(3, { name: "Orphan thing", category_id: "ghost" }),
      item(4, { name: "Apple B", category_id: "c-a" }),
      item(5, { name: "Mango thing", category_id: "c-m" }),
      item(6, { name: "Apple A", category_id: "c-a" }),
      item(7, { name: "Un-categorized A", category_id: null }),
    ];

    it("category name first (case-insensitive), then item name", () => {
      const result = sortItems(list, "category", categories);
      expect(names(result).slice(0, 4)).toEqual(["Apple A", "Apple B", "Mango thing", "Zebra thing"]);
    });

    it("then 'Category unavailable' items, with Uncategorized last", () => {
      const result = sortItems(list, "category", categories);
      expect(names(result).slice(4)).toEqual(["Orphan thing", "Un-categorized A", "Un-categorized B"]);
    });

    it("keeps equally named categories apart, in list order, instead of interleaving their items", () => {
      const twins = [cat("t2", "Twin"), cat("t1", "Twin")];
      const twinItems = [
        item(1, { name: "B", category_id: "t1" }),
        item(2, { name: "A", category_id: "t2" }),
        item(3, { name: "D", category_id: "t1" }),
        item(4, { name: "C", category_id: "t2" }),
      ];
      expect(ids(sortItems(twinItems, "category", twins))).toEqual([2, 4, 1, 3]);
    });

    it("with an empty category list every categorized item is 'unavailable': ordered by name, before Uncategorized", () => {
      const result = sortItems(list, "category", []);
      expect(names(result)).toEqual([
        "Apple A",
        "Apple B",
        "Mango thing",
        "Orphan thing",
        "Zebra thing",
        "Un-categorized A",
        "Un-categorized B",
      ]);
    });
  });

  describe("stability", () => {
    // Same sort keys, different identity: the output must keep the input order.
    const makeTwins = (): Medication[] => [
      item(1, { name: "Same", stock: 4, barcode: "999", category_id: "a" }),
      item(2, { name: "same", stock: 4, barcode: "111", category_id: "a" }),
      item(3, { name: "SAME", stock: 4, barcode: "555", category_id: "a" }),
      item(4, { name: "Same", stock: 4, barcode: "000", category_id: "a" }),
    ];

    it.each(SORTS)("%s: items that compare equal keep their input order", (sort) => {
      const twins = makeTwins();
      const categories = [cat("a", "A")];
      expect(ids(sortItems(twins, sort, categories))).toEqual([1, 2, 3, 4]);
      expect(ids(sortItems(twins.slice().reverse(), sort, categories))).toEqual([4, 3, 2, 1]);
      expect(ids(sortItems(shuffled(twins, 7), sort, categories))).toEqual(ids(shuffled(twins, 7)));
    });

    it("unnamed items with the same barcode keep their input order", () => {
      const list = [
        item(1, { name: null, barcode: "X" }),
        item(2, { name: null, barcode: "x" }),
        item(3, { name: null, barcode: "X" }),
      ];
      expect(ids(sortItems(list, "name", []))).toEqual([1, 2, 3]);
    });
  });

  it.each(SORTS)("%s: returns a new array, is idempotent, and does not mutate frozen input", (sort) => {
    const categories = deepFreeze(buildCategories());
    const items = deepFreeze(buildMedications());
    const once = sortItems(items, sort, categories);
    expect(once).not.toBe(items);
    expect(once).toHaveLength(items.length);
    expect(ids(sortItems(once, sort, categories))).toEqual(ids(once));
  });

  it.each(SORTS)("%s: with unique names the result does not depend on the input order", (sort) => {
    for (const shape of SHAPES) {
      const categories = buildCategories(shape);
      const items = [...buildMedications({ shape }), ...buildManyMedications(40, shape)];
      const reference = ids(sortItems(items, sort, categories));
      for (let seed = 1; seed <= 12; seed += 1) {
        expect(ids(sortItems(shuffled(items, seed), sort, categories)), `seed ${seed}`).toEqual(reference);
      }
    }
  });

  it("sorts the fixtures by name exactly like localeCompare would, with the unnamed item last", () => {
    const items = buildMedications();
    const result = sortItems(items, "name", buildCategories());
    const named = items.filter((m) => m.name !== null).map((m) => m.name as string);
    const expected = named.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    expect(names(result)).toEqual([...expected, null]);
  });
});

// ── groupByCategory ─────────────────────────────────────────────────────────────

describe("groupByCategory", () => {
  const categories = [cat("c-z", "Zebra"), cat("c-a", "apple"), cat("c-m", "Mango"), cat("c-e", "Empty one")];
  const list = [
    item(1, { name: "Un-categorized B", category_id: null }),
    item(2, { name: "Zebra thing", category_id: "c-z" }),
    item(3, { name: "Orphan thing", category_id: "ghost" }),
    item(4, { name: "Apple B", category_id: "c-a", stock: 1 }),
    item(5, { name: "Mango thing", category_id: "c-m" }),
    item(6, { name: "Apple A", category_id: "c-a", stock: 9 }),
    item(7, { name: "Un-categorized A", category_id: null }),
    item(8, { name: "Orphan 2", category_id: "ghost-2" }),
  ];

  it("orders groups: categories by title, then 'Category unavailable', then Uncategorized last", () => {
    const groups = groupByCategory(list, categories, "name");
    expect(titles(groups)).toEqual(["apple", "Mango", "Zebra", "Category unavailable", "Uncategorized"]);
  });

  it("describes each group (kind, id, key)", () => {
    const groups = groupByCategory(list, categories, "name");
    expect(groups.map((g) => [g.key, g.kind, g.id])).toEqual([
      ["c-a", "category", "c-a"],
      ["c-m", "category", "c-m"],
      ["c-z", "category", "c-z"],
      ["unknown", "unknown", null],
      ["uncategorized", "uncategorized", null],
    ]);
  });

  it("emits only non-empty groups (a category with no items has no group)", () => {
    const groups = groupByCategory(list, categories, "name");
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
    expect(titles(groups)).not.toContain("Empty one");
  });

  it("puts every item in exactly one group, and merges all unknown categories into one group", () => {
    const groups = groupByCategory(list, categories, "name");
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(list.length);
    expect(ids(groups.flatMap((g) => g.items)).sort((a, b) => a - b)).toEqual(ids(list));
    const unknown = groups.find((g) => g.kind === "unknown");
    expect(names(unknown?.items ?? [])).toEqual(["Orphan 2", "Orphan thing"]);
  });

  it("sorts the items inside a group by the given sort key", () => {
    const byName = groupByCategory(list, categories, "name").find((g) => g.key === "c-a");
    expect(names(byName?.items ?? [])).toEqual(["Apple A", "Apple B"]);
    const byStock = groupByCategory(list, categories, "stock-asc").find((g) => g.key === "c-a");
    expect(names(byStock?.items ?? [])).toEqual(["Apple B", "Apple A"]);
    const byCategory = groupByCategory(list, categories, "category").find((g) => g.key === "c-a");
    expect(names(byCategory?.items ?? [])).toEqual(["Apple A", "Apple B"]);
  });

  it("does not reorder the groups when the sort key changes", () => {
    for (const sort of SORTS) {
      expect(titles(groupByCategory(list, categories, sort))).toEqual([
        "apple",
        "Mango",
        "Zebra",
        "Category unavailable",
        "Uncategorized",
      ]);
    }
  });

  it("keeps equally named categories as separate groups, in list order, with distinct keys", () => {
    const twins = [cat("t2", "Twin"), cat("t1", "Twin")];
    const groups = groupByCategory(
      [item(1, { category_id: "t1" }), item(2, { category_id: "t2" })],
      twins,
      "name"
    );
    expect(groups.map((g) => g.key)).toEqual(["t2", "t1"]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(2);
  });

  it("treats a repeated category id as one category: one group, never two copies of the same items", () => {
    const repeated = [cat("a", "Alpha"), cat("a", "Alpha again"), cat("b", "Beta")];
    const rows = [item(1, { category_id: "a" }), item(2, { category_id: "b" }), item(3, { category_id: "a" })];
    expect(groupByCategory(rows, repeated, "name").map((g) => [g.title, ids(g.items)])).toEqual([
      ["Alpha", [1, 3]],
      ["Beta", [2]],
    ]);
    const result = selectView(rows, repeated, view());
    expect(result.visible).toHaveLength(3);
    expect(result.groups?.reduce((n, g) => n + g.items.length, 0)).toBe(3);
  });

  it("gives a category without a name a readable title instead of an empty heading", () => {
    const groups = groupByCategory([item(1, { category_id: "x" })], [cat("x", "   ")], "name");
    expect(titles(groups)).toEqual(["Unnamed category"]);
  });

  it("returns no groups for no items, and a single Uncategorized group for a legacy inventory", () => {
    expect(groupByCategory([], categories, "name")).toEqual([]);
    const legacy = buildMedications({ withCategories: false });
    const groups = groupByCategory(legacy, buildCategories(), "name");
    expect(groups.map((g) => [g.title, g.items.length])).toEqual([["Uncategorized", legacy.length]]);
  });

  it("orders the fixture categories by title and puts Uncategorized last (uuid and bigint)", () => {
    for (const shape of SHAPES) {
      const groups = groupByCategory(buildMedications({ shape }), buildCategories(shape), "name");
      expect(titles(groups)).toEqual([
        "Allergy & Cold",
        "Antibiotics",
        "First Aid",
        "IV & Fluids",
        "Pain & Fever",
        "PPE & Gloves",
        "Uncategorized",
      ]);
      const antibiotics = groups.find((g) => g.title === "Antibiotics");
      expect(antibiotics?.key).toBe(categoryId(CATEGORY_NAMES.indexOf("Antibiotics"), shape));
      expect(antibiotics?.id).toBe(antibiotics?.key);
    }
  });

  it("does not mutate frozen input", () => {
    const frozenItems = deepFreeze(list.map((m) => ({ ...m })));
    const frozenCategories = deepFreeze(categories.map((c) => ({ ...c })));
    expect(groupByCategory(frozenItems, frozenCategories, "stock-asc").length).toBeGreaterThan(0);
  });
});

// ── selectView: summary text ────────────────────────────────────────────────────

describe("selectView summary", () => {
  const categories = buildCategories("uuid");
  const items = buildMedications({ shape: "uuid" });
  const antibioticsId = categoryId(CATEGORY_NAMES.indexOf("Antibiotics"), "uuid");

  it("says 'Showing all N items.' when nothing is filtered (sort and grouping are not filters)", () => {
    for (const sort of SORTS) {
      for (const grouped of [true, false]) {
        const { summary } = selectView(items, categories, view({ sort, grouped }));
        expect(summary).toEqual({
          total: SEED_ITEMS.length,
          shown: SEED_ITEMS.length,
          filtersActive: false,
          text: `Showing all ${SEED_ITEMS.length} items.`,
        });
      }
    }
  });

  it("treats a whitespace-only search as no search", () => {
    const { summary } = selectView(items, categories, view({ search: " \t\n " }));
    expect(summary.filtersActive).toBe(false);
    expect(summary.text).toBe(`Showing all ${SEED_ITEMS.length} items.`);
  });

  const n = SEED_ITEMS.length;
  const tablets = SEED_ITEMS.filter((s) => (s.name ?? "").toLowerCase().includes("tablets"));
  const cases: { label: string; view: Partial<ViewState>; text: string; shown: number }[] = [
    {
      label: "category only",
      view: { category: { kind: "category", id: antibioticsId } },
      text: `Showing 3 of ${n} items${DOT}Category: Antibiotics`,
      shown: 3,
    },
    {
      label: "uncategorized only",
      view: { category: { kind: "uncategorized" } },
      text: `Showing ${seedUncategorizedCount} of ${n} items${DOT}Category: Uncategorized`,
      shown: seedUncategorizedCount,
    },
    {
      label: "stock low only",
      view: { stock: "low" },
      text: `Showing ${seedLowCount} of ${n} items${DOT}Stock: Low`,
      shown: seedLowCount,
    },
    {
      label: "stock adequate only",
      view: { stock: "ok" },
      text: `Showing ${n - seedLowCount} of ${n} items${DOT}Stock: Adequate`,
      shown: n - seedLowCount,
    },
    {
      label: "search only, with curly quotes",
      view: { search: "tablets" },
      text: `Showing ${tablets.length} of ${n} items${DOT}Search ${LQ}tablets${RQ}`,
      shown: tablets.length,
    },
    {
      label: "search is trimmed and inner whitespace collapsed",
      view: { search: "  nitrile    gloves  " },
      text: `Showing 2 of ${n} items${DOT}Search ${LQ}nitrile gloves${RQ}`,
      shown: 2,
    },
    {
      label: "category + stock + search, in that order",
      view: { category: { kind: "category", id: antibioticsId }, stock: "low", search: "azith" },
      text: `Showing 1 of ${n} items${DOT}Category: Antibiotics${DOT}Stock: Low${DOT}Search ${LQ}azith${RQ}`,
      shown: 1,
    },
    {
      label: "nothing matches",
      view: { search: "zzz-no-match" },
      text: `Showing 0 of ${n} items${DOT}Search ${LQ}zzz-no-match${RQ}`,
      shown: 0,
    },
    {
      label: "the unavailable-category pseudo filter when every category is known",
      view: { category: { kind: "category", id: UNKNOWN_CATEGORY_ID } },
      text: `Showing 0 of ${n} items${DOT}Category: Category unavailable`,
      shown: 0,
    },
  ];

  it.each(cases)("$label", ({ view: overrides, text, shown }) => {
    const { summary, visible } = selectView(items, categories, view(overrides));
    expect(summary.text).toBe(text);
    expect(summary.shown).toBe(shown);
    expect(summary.shown).toBe(visible.length);
    expect(summary.total).toBe(n);
    expect(summary.filtersActive).toBe(true);
  });

  it("uses the curly quote characters U+201C and U+201D, never straight quotes", () => {
    const { summary } = selectView(items, categories, view({ search: "amox" }));
    expect(summary.text).toContain("“amox”");
    expect(summary.text).not.toContain('"');
  });

  it("reproduces the example from the spec: 'Showing 9 of 38 items · Category: Antibiotics · Stock: Low · Search “amox”'", () => {
    const antibiotics = cat("c-abx", "Antibiotics");
    const other = cat("c-other", "Other");
    const rows: Medication[] = [];
    // 9 matches: Antibiotics, low stock, name contains "amox"
    for (let i = 1; i <= 9; i += 1) rows.push(item(i, { name: `Amoxicillin ${i * 125} mg`, category_id: "c-abx", stock: 1, threshold: 5 }));
    // near misses: wrong category, not low, no "amox" in the name
    for (let i = 10; i <= 14; i += 1) rows.push(item(i, { name: `Amoxicillin ${i} mg`, category_id: "c-other", stock: 1, threshold: 5 }));
    for (let i = 15; i <= 19; i += 1) rows.push(item(i, { name: `Amoxicillin ${i} mg`, category_id: "c-abx", stock: 50, threshold: 5 }));
    for (let i = 20; i <= 29; i += 1) rows.push(item(i, { name: `Azithromycin ${i} mg`, category_id: "c-abx", stock: 1, threshold: 5 }));
    for (let i = 30; i <= 38; i += 1) rows.push(item(i, { name: `Gauze ${i}`, category_id: null, stock: 1, threshold: 5 }));
    expect(rows).toHaveLength(38);

    const { summary, visible } = selectView(rows, [antibiotics, other], {
      search: "amox",
      stock: "low",
      category: { kind: "category", id: "c-abx" },
      sort: "name",
      grouped: true,
    });
    expect(visible).toHaveLength(9);
    expect(summary.text).toBe(
      "Showing 9 of 38 items · Category: Antibiotics · Stock: Low · Search “amox”"
    );
  });

  it("uses the singular for a one-item inventory", () => {
    const one = [item(1, { name: "Only" })];
    expect(selectView(one, [], view()).summary.text).toBe("Showing all 1 item.");
    expect(selectView(one, [], view({ stock: "low" })).summary.text).toBe(`Showing 0 of 1 item${DOT}Stock: Low`);
    expect(selectView([], [], view()).summary.text).toBe("Showing all 0 items.");
  });

  it("names a category the list does not know as 'Category unavailable' instead of showing its id", () => {
    const { summary } = selectView(items, categories, view({ category: { kind: "category", id: "9999" } }));
    expect(summary.text).toBe(`Showing 0 of ${n} items${DOT}Category: Category unavailable`);
  });

  it.each(INVISIBLE_CHARACTERS)("treats a search of only $label as no search: nothing is hidden, no empty quotes", ({ char }) => {
    for (const search of [char, ` ${char}${char} `, `\t${char}\n`]) {
      for (const grouped of [true, false]) {
        const { summary, visible, groups } = selectView(items, categories, view({ search, grouped }));
        expect(summary, codePoints(search)).toEqual({ total: n, shown: n, filtersActive: false, text: `Showing all ${n} items.` });
        expect(visible).toHaveLength(n);
        expect(groups === null ? n : groups.reduce((sum, g) => sum + g.items.length, 0)).toBe(n);
      }
    }
  });

  it("does not echo invisible characters back in the summary", () => {
    const { summary, visible } = selectView(items, categories, view({ search: `${ZWSP}amox${SOFT_HYPHEN}${ZWSP} ` }));
    expect(visible).toHaveLength(1);
    expect(summary.text).toBe(`Showing 1 of ${n} items${DOT}Search ${LQ}amox${RQ}`);
    const withStock = selectView(items, categories, view({ search: `  nitrile${ZWSP}   ${ZWJ}gloves `, stock: "low" }));
    expect(withStock.summary.text).toBe(`Showing 1 of ${n} items${DOT}Stock: Low${DOT}Search ${LQ}nitrile gloves${RQ}`);
  });

  it("keeps the typed characters in the summary (the text only drops what cannot be seen)", () => {
    const { summary } = selectView(items, categories, view({ search: `${fullWidth("AMOX")}` }));
    expect(summary.text).toBe(`Showing 1 of ${n} items${DOT}Search ${LQ}${fullWidth("AMOX")}${RQ}`);
  });
});

// ── describeEmpty ───────────────────────────────────────────────────────────────

describe("describeEmpty", () => {
  const categories = buildCategories("uuid");
  const antibioticsId = categoryId(CATEGORY_NAMES.indexOf("Antibiotics"), "uuid");
  const antibiotics: CategoryFilter = { kind: "category", id: antibioticsId };

  const cases: { label: string; total: number; view: Partial<ViewState>; kind: EmptyKind; title: string }[] = [
    { label: "empty inventory", total: 0, view: {}, kind: "no-items", title: "No items in the inventory yet." },
    { label: "empty inventory wins over active filters", total: 0, view: { search: "abc", stock: "low", category: antibiotics }, kind: "no-items", title: "No items in the inventory yet." },
    { label: "an empty category", total: 40, view: { category: antibiotics }, kind: "category-empty", title: "No items in Antibiotics yet." },
    { label: "an empty category with a blank search", total: 40, view: { category: antibiotics, search: "   " }, kind: "category-empty", title: "No items in Antibiotics yet." },
    { label: "an empty category, sorted and ungrouped (those are not filters)", total: 40, view: { category: antibiotics, sort: "stock-asc", grouped: false }, kind: "category-empty", title: "No items in Antibiotics yet." },
    { label: "no uncategorized items", total: 40, view: { category: { kind: "uncategorized" } }, kind: "category-empty", title: "No items in Uncategorized yet." },
    { label: "a category the list does not know", total: 40, view: { category: { kind: "category", id: "does-not-exist" } }, kind: "category-empty", title: "No items in Category unavailable yet." },
    { label: "no unavailable-category items", total: 40, view: { category: { kind: "category", id: UNKNOWN_CATEGORY_ID } }, kind: "category-empty", title: "No items in Category unavailable yet." },
    { label: "category + search", total: 40, view: { category: antibiotics, search: "amox" }, kind: "no-match", title: `No items match Category: Antibiotics${DOT}Search ${LQ}amox${RQ}.` },
    { label: "category + stock", total: 40, view: { category: antibiotics, stock: "low" }, kind: "no-match", title: `No items match Category: Antibiotics${DOT}Stock: Low.` },
    { label: "category + stock + search", total: 40, view: { category: antibiotics, stock: "ok", search: "x y" }, kind: "no-match", title: `No items match Category: Antibiotics${DOT}Stock: Adequate${DOT}Search ${LQ}x y${RQ}.` },
    { label: "uncategorized + search", total: 40, view: { category: { kind: "uncategorized" }, search: "zzz" }, kind: "no-match", title: `No items match Category: Uncategorized${DOT}Search ${LQ}zzz${RQ}.` },
    { label: "search only", total: 40, view: { search: "zzz" }, kind: "no-match", title: `No items match Search ${LQ}zzz${RQ}.` },
    { label: "search is trimmed and collapsed in the message", total: 40, view: { search: "  zzz   top  " }, kind: "no-match", title: `No items match Search ${LQ}zzz top${RQ}.` },
    { label: "stock only (blank search adds no empty quotes)", total: 40, view: { stock: "low", search: "   " }, kind: "no-match", title: "No items match Stock: Low." },
    { label: "stock adequate only", total: 40, view: { stock: "ok" }, kind: "no-match", title: "No items match Stock: Adequate." },
    { label: "nothing filtered but nothing to show (should not happen; stays well-formed)", total: 40, view: {}, kind: "no-match", title: "No items to show." },
  ];

  it.each(cases)("$label", ({ total, view: overrides, kind, title }) => {
    const result = describeEmpty(total, view(overrides), categories);
    expect(result.kind).toBe(kind);
    expect(result.title).toBe(title);
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it("tells staff what to do next", () => {
    expect(describeEmpty(0, view(), categories).detail).toBe(`Use ${LQ}+ Add${RQ} to create the first item.`);
    expect(describeEmpty(40, view({ category: antibiotics }), categories).detail).toBe(
      "Assign items to this category from the Admin page."
    );
    expect(describeEmpty(40, view({ category: { kind: "uncategorized" } }), categories).detail).toBe(
      "Every item has a category."
    );
    expect(describeEmpty(40, view({ stock: "low" }), categories).detail).toBe("Clear the filters to see all 40 items.");
    expect(describeEmpty(40, view({ search: "zzz" }), categories).detail).toBe(
      "Check the spelling or try fewer words. Clear the filters to see all 40 items."
    );
    expect(describeEmpty(1, view({ stock: "low" }), categories).detail).toBe("Clear the filters to see all 1 item.");
  });

  const filterChoices: CategoryFilter[] = [
    { kind: "all" },
    { kind: "uncategorized" },
    antibiotics,
    { kind: "category", id: UNKNOWN_CATEGORY_ID },
    { kind: "category", id: "" },
  ];

  // Searches that look blank (must never yield “” ), including the ones made of invisible characters (alone, doubled,
  // or mixed with whitespace) ...
  const blankSearches = [
    "",
    " ",
    "\t",
    "\n",
    NBSP,
    " " + NBSP + "\t\n ",
    ...INVISIBLE_CHARACTERS.flatMap(({ char }) => [char, ` ${char}\t${char} `]),
    ZWSP + SOFT_HYPHEN + ZWJ,
  ];
  // ... and searches whose text is the very word a sloppy template would leak.
  const wordySearches = ["a", "null", "undefined", "NaN", "0"];
  // "Blank" for the assertions below is deliberately broader than whitespace: nothing visible between the quotes.
  const BLANK = "[\\s\\p{Cf}\\p{Default_Ignorable_Code_Point}]*";
  const EMPTY_CURLY_QUOTES = new RegExp(`“${BLANK}”`, "u");
  const EMPTY_STRAIGHT_QUOTES = new RegExp(`"${BLANK}"|'${BLANK}'`, "u");

  it.each(blankSearches.map((search) => ({ search, label: codePoints(search) })))(
    "a blank search ($label) never produces quotes of its own or placeholder text",
    ({ search }) => {
      for (const total of [0, 1, 40]) {
        for (const stock of STOCKS) {
          for (const category of filterChoices) {
            const result = describeEmpty(total, view({ search, stock, category }), categories);
            const { title, detail } = result;
            for (const text of [title, detail]) {
              expect(text.trim().length).toBeGreaterThan(0);
              expect(text).not.toMatch(EMPTY_CURLY_QUOTES); // “” (the only quotes allowed are around "+ Add")
              expect(text).not.toMatch(EMPTY_STRAIGHT_QUOTES);
              expect(text).not.toMatch(/undefined|\[object|NaN|null|(^|\s)\.($|\s)| {2}/);
            }
            expect(title).not.toMatch(/[“”"']/);
            // A blank search is no search: the message is the very one an empty search gets.
            expect(result).toEqual(describeEmpty(total, view({ search: "", stock, category }), categories));
          }
        }
      }
    }
  );

  it("quotes a search without its invisible characters", () => {
    const title = describeEmpty(5, view({ search: `${ZWSP}zzz${SOFT_HYPHEN} ${ZWJ} top ` }), categories).title;
    expect(title).toBe(`No items match Search ${LQ}zzz top${RQ}.`);
  });

  it.each(wordySearches.map((search) => ({ search })))(
    "a real search ($search) is quoted verbatim and nothing else is leaked",
    ({ search }) => {
      for (const stock of STOCKS) {
        for (const category of filterChoices) {
          const { title, detail } = describeEmpty(40, view({ search, stock, category }), categories);
          expect(title).toContain(`${LQ}${search}${RQ}`);
          const outsideTheQuotedSearch = `${title} ${detail}`.replace(/“[^”]*”/g, "");
          expect(outsideTheQuotedSearch).not.toMatch(/undefined|\[object|NaN|null|“\s*”| {2}/);
        }
      }
    }
  );

  it("quotes the search text only when there is some", () => {
    const withText = describeEmpty(5, view({ search: "abc" }), categories).title;
    const without = describeEmpty(5, view({ search: "   ", stock: "low" }), categories).title;
    expect(withText).toContain(`${LQ}abc${RQ}`);
    expect(without).not.toContain(LQ);
    expect(without).not.toContain(RQ);
  });
});

// ── selectView: scenarios ───────────────────────────────────────────────────────

describe("selectView scenarios", () => {
  const antibioticsIndex = CATEGORY_NAMES.indexOf("Antibiotics");

  it.each(SHAPES)("returns every item, flat and grouped, for the default view (%s ids)", (shape) => {
    const items = buildMedications({ shape });
    const result = selectView(items, buildCategories(shape), DEFAULT_VIEW);
    expect(result.visible).toHaveLength(items.length);
    expect(result.groups).not.toBeNull();
    expect(result.groups?.reduce((n, g) => n + g.items.length, 0)).toBe(items.length);
    expect(result.counts.all).toBe(items.length);
  });

  it("returns groups only when grouping is on", () => {
    const items = buildMedications();
    const categories = buildCategories();
    expect(selectView(items, categories, view({ grouped: false })).groups).toBeNull();
    expect(Array.isArray(selectView(items, categories, view({ grouped: true })).groups)).toBe(true);
  });

  it("keeps the chip counts independent of the category filter, but not of search and stock", () => {
    const items = buildMedications();
    const categories = buildCategories();
    const everything = selectView(items, categories, view()).counts;
    for (const category of [
      { kind: "uncategorized" },
      { kind: "category", id: categoryId(antibioticsIndex, "uuid") },
      { kind: "category", id: UNKNOWN_CATEGORY_ID },
    ] as CategoryFilter[]) {
      expect(selectView(items, categories, view({ category })).counts).toEqual(everything);
    }

    const lowOnly = selectView(items, categories, view({ stock: "low" })).counts;
    expect(lowOnly.all).toBe(seedLowCount);
    expect(lowOnly).not.toEqual(everything);

    const searched = selectView(items, categories, view({ search: "nitrile" })).counts;
    expect(searched.all).toBe(2);
    expect(searched.byId[categoryId(CATEGORY_NAMES.indexOf("PPE & Gloves"), "uuid")]).toBe(2);
    expect(searched.byId[categoryId(antibioticsIndex, "uuid")]).toBe(0);
  });

  it("shows one category's items in a single group when that category is selected", () => {
    const items = buildMedications();
    const categories = buildCategories();
    const result = selectView(
      items,
      categories,
      view({ category: { kind: "category", id: categoryId(antibioticsIndex, "uuid") } })
    );
    expect(result.visible).toHaveLength(3);
    expect(titles(result.groups ?? [])).toEqual(["Antibiotics"]);
  });

  it("never hides items whose category can't be resolved: they appear as 'Category unavailable'", () => {
    const items = buildMedications();
    const categories: Category[] = []; // e.g. /api/categories failed or returned nothing
    const result = selectView(items, categories, view());
    expect(result.visible).toHaveLength(items.length);
    expect(result.counts.unknown).toBe(items.length - seedUncategorizedCount);
    expect(result.counts.uncategorized).toBe(seedUncategorizedCount);
    expect(titles(result.groups ?? [])).toEqual(["Category unavailable", "Uncategorized"]);
    const unavailable = result.groups?.find((g) => g.kind === "unknown");
    expect(unavailable?.items).toHaveLength(items.length - seedUncategorizedCount);
    // and they can be reached on their own
    const only = selectView(items, categories, view({ category: { kind: "category", id: UNKNOWN_CATEGORY_ID } }));
    expect(only.visible).toHaveLength(items.length - seedUncategorizedCount);
  });

  it("keeps Uncategorized items visible and last, in both grouped and flat category order", () => {
    const items = buildMedications();
    const categories = buildCategories();
    const grouped = selectView(items, categories, view({ sort: "category" }));
    expect(grouped.groups?.at(-1)?.title).toBe("Uncategorized");
    const flat = selectView(items, categories, view({ sort: "category", grouped: false }));
    const lastThree = flat.visible.slice(-seedUncategorizedCount);
    expect(lastThree.every((m) => m.category_id === null)).toBe(true);
  });

  it("moves an item to the right group after its category changes", () => {
    const categories = buildCategories();
    const before = buildMedications();
    const target = before.find((m) => m.name === "Thermometer probe covers");
    expect(target).toBeDefined();
    const firstAid = categoryId(CATEGORY_NAMES.indexOf("First Aid"), "uuid");
    const groupOf = (r: Selected, id: number): string | undefined => r.groups?.find((g) => g.items.some((m) => m.id === id))?.key;

    expect(groupOf(selectView(before, categories, view()), target?.id ?? -1)).toBe("uncategorized");
    const after = before.map((m) => (m.id === target?.id ? { ...m, category_id: firstAid } : m));
    const result = selectView(after, categories, view());
    expect(groupOf(result, target?.id ?? -1)).toBe(firstAid);
    expect(result.counts.uncategorized).toBe(seedUncategorizedCount - 1);
    expect(result.counts.byId[firstAid]).toBe(SEED_ITEMS.filter((s) => s.category === CATEGORY_NAMES.indexOf("First Aid")).length + 1);
  });

  it("finds an unnamed item by its barcode, shows it last by name, and puts it in Uncategorized", () => {
    const items = buildMedications();
    const categories = buildCategories();
    const unnamed = items.find((m) => m.name === null);
    expect(unnamed).toBeDefined();
    const search = selectView(items, categories, view({ search: unnamed?.barcode ?? "" }));
    expect(ids(search.visible)).toEqual([unnamed?.id]);
    expect(search.groups?.map((g) => g.key)).toEqual(["uncategorized"]);
    const all = selectView(items, categories, view({ grouped: false }));
    expect(all.visible.at(-1)?.id).toBe(unnamed?.id);
  });

  it("matches on the supplier order number, leading zeros and letters included", () => {
    const items = buildMedications();
    const categories = buildCategories();
    const run = (search: string): (string | null)[] =>
      selectView(items, categories, view({ search })).visible.map((m) => m.supplier_order_number);
    expect(run("0092")).toContain("0092");
    expect(run("00417-B")).toEqual(["00417-B"]);
    expect(run("000250")).toEqual(["000250"]);
    expect(run("nx-220")).toEqual(["NX-220/100"]);
    expect(run("MVI-120-FRUIT")).toEqual(["MVI-120-FRUIT-ASSORTED-LONG-CODE-0001"]);
  });

  it("applies every search term (AND), across name and supplier number", () => {
    const items = buildMedications();
    const categories = buildCategories();
    const count = (search: string): number => selectView(items, categories, view({ search })).visible.length;
    expect(count("nitrile gloves")).toBe(2);
    expect(count("nitrile masks")).toBe(0);
    expect(count("surgical masks")).toBe(1);
    expect(count("gloves GLV-L")).toBe(1);
    expect(count("gloves GLV-L GLV-M")).toBe(0);
  });

  it("combines search, stock and category", () => {
    const items = buildMedications();
    const categories = buildCategories();
    const painId = categoryId(CATEGORY_NAMES.indexOf("Pain & Fever"), "uuid");
    const result = selectView(
      items,
      categories,
      view({ search: "tablets", stock: "low", category: { kind: "category", id: painId } })
    );
    // Pain & Fever tablets at or below their threshold: Ibuprofen (18/40), Naproxen (9/20)
    expect(names(result.visible)).toEqual(["Ibuprofen 200 mg, tablets", "Naproxen 220 mg, tablets"]);
    expect(result.summary.text).toBe(
      `Showing 2 of ${items.length} items${DOT}Category: Pain & Fever${DOT}Stock: Low${DOT}Search ${LQ}tablets${RQ}`
    );
  });

  it("does not drop or merge duplicate rows it is given", () => {
    const a = item(1, { name: "A" });
    const result = selectView([a, a], [], view());
    expect(result.visible).toHaveLength(2);
    expect(result.summary.total).toBe(2);
  });

  it("is deterministic and does not mutate frozen input", () => {
    const items = deepFreeze(buildMedications());
    const categories = deepFreeze(buildCategories());
    const v = deepFreeze(view({ search: "tab", stock: "low", sort: "category" }));
    const first = selectView(items, categories, v);
    const second = selectView(items, categories, v);
    expect(second).toEqual(first);
    expect(first.visible).not.toBe(items);
  });

  it("handles an inventory larger than one API page (1,200 items) without losing any", () => {
    const items = buildManyMedications(1200, "uuid");
    const categories = buildCategories("uuid");
    const result = selectView(items, categories, view());
    expect(result.visible).toHaveLength(1200);
    expect(result.groups?.reduce((n, g) => n + g.items.length, 0)).toBe(1200);
    expect(new Set(ids(result.visible)).size).toBe(1200);
    expect(result.summary.text).toBe("Showing all 1200 items.");
  });

  it("stays fast on a very large list (guards against accidental quadratic behaviour)", () => {
    const items = buildManyMedications(5000, "uuid");
    const categories = buildCategories("uuid");
    const started = performance.now();
    const result = selectView(items, categories, view({ search: "bulk item", sort: "category" }));
    const elapsed = performance.now() - started;
    expect(result.visible).toHaveLength(5000);
    expect(elapsed).toBeLessThan(3000);
  });
});

// ── The "Category unavailable" selection ────────────────────────────────────────
//
// SPEC 2.7 gives CategoryFilter no variant for categories that cannot be resolved (categories failed to load, or
// are hidden), yet the UI needs a "Category unavailable" chip. The module selects that bucket with a reserved pseudo
// id. These tests pin the contract the Inventory UI relies on, including the moment the review flagged: the chip
// is only drawn while its count is above zero, so a user who picked it while the categories were missing must not
// end up on a chip that vanishes when they arrive.

describe("the 'Category unavailable' selection", () => {
  const known = buildCategories("uuid");
  const items = buildMedications({ shape: "uuid" });
  const categorized = items.length - seedUncategorizedCount;
  const sortedIds = (list: readonly Medication[]): number[] => ids(list).sort((a, b) => a - b);

  it("is exposed as a typed filter plus a predicate, so the UI never writes the reserved id by hand", () => {
    expect(UNKNOWN_CATEGORY_FILTER).toEqual({ kind: "category", id: UNKNOWN_CATEGORY_ID });
    expect(Object.isFrozen(UNKNOWN_CATEGORY_FILTER)).toBe(true);
    const cases: [CategoryFilter, boolean][] = [
      [UNKNOWN_CATEGORY_FILTER, true],
      [{ kind: "category", id: UNKNOWN_CATEGORY_ID }, true],
      [{ kind: "category", id: ` ${UNKNOWN_CATEGORY_ID.toUpperCase()} ` }, true], // the key applyCategoryFilter itself uses
      [{ kind: "all" }, false],
      [{ kind: "uncategorized" }, false],
      [{ kind: "category", id: known[0].id }, false],
      [{ kind: "category", id: "" }, false],
      [{ kind: "category", id: "9999" }, false],
    ];
    for (const [filter, expected] of cases) {
      expect(isUnknownCategoryFilter(filter), JSON.stringify(filter)).toBe(expected);
      if (expected) {
        // the predicate and the filter agree: with no categories listed, every categorized item is "unavailable"
        expect(applyCategoryFilter(items, filter, [])).toHaveLength(categorized);
      }
    }
  });

  it("selects exactly the items whose category cannot be found, flat and grouped, and the chip count matches", () => {
    const listed = known.filter((_, i) => i !== 1 && i !== 4); // two categories missing from the list
    const unlisted = items.filter((m) => m.category_id !== null && !listed.some((c) => c.id === m.category_id));
    expect(unlisted.length).toBeGreaterThan(0);
    for (const grouped of [true, false]) {
      const byConstant = selectView(items, listed, view({ category: UNKNOWN_CATEGORY_FILTER, grouped }));
      const byHand = selectView(items, listed, view({ category: { kind: "category", id: UNKNOWN_CATEGORY_ID }, grouped }));
      expect(sortedIds(byConstant.visible)).toEqual(sortedIds(unlisted));
      expect(byConstant).toEqual(byHand);
      expect(byConstant.visible).toHaveLength(byConstant.counts.unknown);
      if (grouped) expect(byConstant.groups?.map((g) => g.key)).toEqual([UNKNOWN_CATEGORY_ID]);
    }
  });

  it("keeps the spec'd test ids derivable from the module's own values", () => {
    // category-chip-unknown, group-heading-unknown and group-heading-uncategorized (SPEC section 3)
    expect(`category-chip-${UNKNOWN_CATEGORY_ID}`).toBe("category-chip-unknown");
    const groups = selectView(items, [], view()).groups ?? [];
    expect(groups.map((g) => `group-heading-${g.key}`)).toEqual(["group-heading-unknown", "group-heading-uncategorized"]);
    expect(groups[0].key).toBe(UNKNOWN_CATEGORY_ID);
  });

  it("cannot collide with a real category: the id validator behind every API route rejects it", () => {
    // The reserved id is only safe while no category can carry it. Category ids are uuids or digit strings and
    // parseCategoryId refuses everything else. If this fails, id validation was loosened and the reserved id needs
    // a typed CategoryFilter variant instead (see the note on UNKNOWN_CATEGORY_ID).
    for (const candidate of [UNKNOWN_CATEGORY_ID, UNKNOWN_CATEGORY_ID.toUpperCase(), ` ${UNKNOWN_CATEGORY_ID} `]) {
      expect(parseCategoryId(candidate), candidate).toMatchObject({ ok: false });
    }
  });

  it("stays explainable when the categories finish loading under a user who selected it", () => {
    const selected = view({ category: UNKNOWN_CATEGORY_FILTER });

    const loading = selectView(items, [], selected); // categories not here yet: every categorized item is unavailable
    expect(loading.counts.unknown).toBe(categorized);
    expect(loading.visible).toHaveLength(categorized);

    const loaded = selectView(items, known, selected); // categories arrive
    expect(loaded.counts.unknown).toBe(0); // the chip's own count is gone ...
    expect(isUnknownCategoryFilter(selected.category)).toBe(true); // ... but it is still the selection: keep drawing it
    expect(loaded.visible).toHaveLength(0);
    expect(loaded.summary).toMatchObject({ shown: 0, total: items.length, filtersActive: true }); // "Clear filters" shows
    expect(loaded.summary.text).toBe(`Showing 0 of ${items.length} items${DOT}Category: Category unavailable`);
    expect(describeEmpty(items.length, selected, known)).toMatchObject({
      kind: "category-empty",
      title: "No items in Category unavailable yet.",
    });
    expect(Object.keys(loaded.counts.byId)).toHaveLength(known.length); // every real category chip is there to switch to
    expect(loaded.counts.all).toBe(items.length);
  });

  it("a made-up sentinel selects nothing, so the UI must use the exported filter (or the exported id)", () => {
    // Documents the hazard behind the typed filter: there is no type error for a wrong string.
    for (const wrong of ["__unknown__", "Category unavailable", "none", "null"]) {
      const result = selectView(items, [], view({ category: { kind: "category", id: wrong } }));
      expect(result.visible, wrong).toHaveLength(0);
    }
    expect(selectView(items, [], view({ category: UNKNOWN_CATEGORY_FILTER })).visible).toHaveLength(categorized);
  });
});

// ── Property-style matrix ───────────────────────────────────────────────────────
//
// Every combination of search x stock x category filter x sort x grouped, over several datasets, checked against an
// independent oracle. The oracle is intentionally written differently from the implementation (per-field substring
// checks instead of one joined haystack, plain === on ids, its own collator) so a shared bug cannot hide.

const oracleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

type Dataset = {
  name: string;
  items: Medication[];
  categories: Category[];
  /** Category filters to try: all, uncategorized, every fixture category (even ones hidden from `categories`), unknown, a nonexistent id. */
  filters: CategoryFilter[];
  searches: string[];
  /** Real categories sorted by name (the order groups must have). */
  sortedCategories: Category[];
};

const SEED_SEARCHES = [
  "",
  "   ",
  "tablets",
  "AMOX",
  "amoxicillin 500",
  "00417",
  "0092",
  "nitrile  gloves",
  "zzz-no-match",
  "0049000028911",
  "capsules",
  "ibuprofen 200 tablets",
  // invisible characters and compatibility forms (the oracle below has its own, explicit idea of both)
  `amox${ZWSP}icillin`, // invisible inside a word: must still find Amoxicillin
  `${ZWSP}${SOFT_HYPHEN} ${ZWJ}`, // only invisible characters: no search at all
  `${ZWSP}zzz${SOFT_HYPHEN}`, // invisible around a term that matches nothing
  fullWidth("AMOX"), // full-width letters
];

/** A search for failure labels: printable ASCII as is, everything else as \u{...}, so invisible characters show. */
const printable = (text: string): string =>
  JSON.stringify(text).replace(/[^\x20-\x7e]/gu, (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`);
const BULK_SEARCHES = ["", "tablets item 00", "00012", "zzz-no-match"];

function buildDatasets(): Dataset[] {
  const out: Dataset[] = [];
  for (const shape of SHAPES) {
    const full = buildCategories(shape);
    const filtersFor = (): CategoryFilter[] => [
      { kind: "all" },
      { kind: "uncategorized" },
      ...full.map((c): CategoryFilter => ({ kind: "category", id: c.id })),
      { kind: "category", id: UNKNOWN_CATEGORY_ID },
      { kind: "category", id: categoryId(99, shape) },
    ];
    const make = (label: string, items: Medication[], categories: Category[], searches: string[]): void => {
      out.push(
        deepFreeze({
          name: `${label} [${shape}]`,
          items,
          categories,
          filters: filtersFor(),
          searches,
          sortedCategories: categories.slice().sort((a, b) => oracleCollator.compare(a.name, b.name)),
        })
      );
    };
    make("seed, all categories listed", buildMedications({ shape }), full, SEED_SEARCHES);
    make("seed, categories failed to load", buildMedications({ shape }), [], SEED_SEARCHES);
    make("seed, two categories hidden", buildMedications({ shape }), full.filter((_, i) => i !== 1 && i !== 4), SEED_SEARCHES);
    make("legacy, nothing categorized", buildMedications({ shape, withCategories: false }), full, SEED_SEARCHES);
    make("bulk 300", buildManyMedications(300, shape), full, BULK_SEARCHES);
  }
  return out;
}

type OracleBucket = "uncategorized" | "unknown" | { id: string };

function oracleBucket(m: Medication, categories: readonly Category[]): OracleBucket {
  const id = m.category_id;
  if (id === null) return "uncategorized";
  return categories.some((c) => c.id === id) ? { id } : "unknown";
}

// The oracle's own, explicit list of characters that render as nothing (the implementation uses Unicode property
// classes instead), and its own folding: strip, NFKC, lower case.
const ORACLE_INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xe0020, 0xe007f],
];

function oracleStrip(text: string): string {
  return Array.from(text)
    .filter((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return !ORACLE_INVISIBLE_RANGES.some(([from, to]) => cp >= from && cp <= to);
    })
    .join("");
}

/** The search as staff see it: invisible characters gone, trimmed, inner whitespace collapsed. */
const oracleClean = (search: string): string => oracleStrip(search).trim().replace(/\s+/g, " ");
// Memoized: the matrix folds the same few hundred field strings tens of thousands of times.
const oracleFoldCache = new Map<string, string>();
function oracleFold(text: string): string {
  let folded = oracleFoldCache.get(text);
  if (folded === undefined) {
    folded = oracleStrip(text).normalize("NFKC").toLowerCase();
    oracleFoldCache.set(text, folded);
  }
  return folded;
}

function oracleVisible(items: readonly Medication[], categories: readonly Category[], v: ViewState): Medication[] {
  const cleaned = oracleClean(v.search);
  const terms = cleaned === "" ? [] : oracleFold(cleaned).split(/\s+/).filter((t) => t !== "");
  return items.filter((m) => {
    const fields = [m.name ?? "", m.barcode, m.supplier_order_number ?? ""].map(oracleFold);
    if (!terms.every((t) => fields.some((f) => f.includes(t)))) return false;
    if (v.stock === "low" && !(m.stock <= m.threshold)) return false;
    if (v.stock === "ok" && !(m.stock > m.threshold)) return false;
    const filter = v.category;
    if (filter.kind === "all") return true;
    if (filter.kind === "uncategorized") return oracleBucket(m, categories) === "uncategorized";
    if (filter.id === UNKNOWN_CATEGORY_ID) return oracleBucket(m, categories) === "unknown";
    return m.category_id === filter.id;
  });
}

function oracleCounts(items: readonly Medication[], categories: readonly Category[], v: ViewState): CategoryCounts {
  const base = oracleVisible(items, categories, { ...v, category: { kind: "all" } });
  const byId: Record<string, number> = Object.fromEntries(categories.map((c) => [c.id, 0]));
  let uncategorized = 0;
  let unknown = 0;
  for (const m of base) {
    const bucket = oracleBucket(m, categories);
    if (bucket === "uncategorized") uncategorized += 1;
    else if (bucket === "unknown") unknown += 1;
    else byId[bucket.id] += 1;
  }
  return { all: base.length, uncategorized, unknown, byId };
}

/** Structural equality for counts: `byId` is a record, so its key order is irrelevant. */
function countsEqual(a: CategoryCounts, b: CategoryCounts): boolean {
  const entries = (c: CategoryCounts): string => JSON.stringify(Object.entries(c.byId).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return a.all === b.all && a.uncategorized === b.uncategorized && a.unknown === b.unknown && entries(a) === entries(b);
}

function oracleSummaryText(total: number, shown: number, v: ViewState, categories: readonly Category[]): string {
  const parts: string[] = [];
  const filter = v.category;
  if (filter.kind === "uncategorized") parts.push("Category: Uncategorized");
  if (filter.kind === "category") {
    const found = filter.id === UNKNOWN_CATEGORY_ID ? undefined : categories.find((c) => c.id === filter.id);
    parts.push(`Category: ${found ? found.name : "Category unavailable"}`);
  }
  if (v.stock === "low") parts.push("Stock: Low");
  if (v.stock === "ok") parts.push("Stock: Adequate");
  const search = oracleClean(v.search);
  if (search !== "") parts.push(`Search “${search}”`);
  const noun = total === 1 ? "item" : "items";
  return parts.length === 0 ? `Showing all ${total} ${noun}.` : [`Showing ${shown} of ${total} ${noun}`, ...parts].join(" · ");
}

const isNamed = (m: Medication): boolean => (m.name ?? "").trim() !== "";

/** True when `a` may come before `b` in name order: named first (natural order), unnamed last by barcode. */
function nameOrderOk(a: Medication, b: Medication): boolean {
  if (isNamed(a) && !isNamed(b)) return true;
  if (!isNamed(a) && isNamed(b)) return false;
  if (isNamed(a)) return oracleCollator.compare((a.name ?? "").trim(), (b.name ?? "").trim()) <= 0;
  return oracleCollator.compare(a.barcode, b.barcode) <= 0;
}

type Run = {
  dataset: Dataset;
  view: ViewState;
  label: string;
  result: Selected;
  expected: Medication[];
  expectedCounts: CategoryCounts;
};

const runs: Run[] = [];

function filterLabel(f: CategoryFilter): string {
  return f.kind === "category" ? `category:${f.id}` : f.kind;
}

beforeAll(() => {
  for (const dataset of buildDatasets()) {
    const cache = new Map<string, { expected: Medication[]; expectedCounts: CategoryCounts }>();
    for (const search of dataset.searches) {
      for (const stock of STOCKS) {
        for (const category of dataset.filters) {
          for (const sort of SORTS) {
            for (const grouped of [true, false]) {
              const v: ViewState = { search, stock, category, sort, grouped };
              const key = JSON.stringify([search, stock, category]);
              let oracle = cache.get(key);
              if (!oracle) {
                oracle = { expected: oracleVisible(dataset.items, dataset.categories, v), expectedCounts: oracleCounts(dataset.items, dataset.categories, v) };
                cache.set(key, oracle);
              }
              runs.push({
                dataset,
                view: v,
                label: `${dataset.name} | search=${printable(search)} stock=${stock} category=${filterLabel(category)} sort=${sort} grouped=${grouped}`,
                result: selectView(dataset.items, dataset.categories, v),
                ...oracle,
              });
            }
          }
        }
      }
    }
  }
}, 120_000);

/** Runs `check` on every run and returns up to five failing labels (empty array = all good). */
function failures(check: (run: Run) => boolean): string[] {
  const bad: string[] = [];
  for (const run of runs) {
    if (!check(run)) {
      bad.push(run.label);
      if (bad.length >= 5) break;
    }
  }
  return bad;
}

describe("property matrix: search x stock x category x sort x grouped", () => {
  it("covers a large number of combinations over uuid and bigint fixtures", () => {
    expect(runs.length).toBeGreaterThan(15000);
    expect(new Set(runs.map((r) => r.dataset.name)).size).toBe(10);
  });

  it("visible holds exactly the items matching search, stock and category, each once", () => {
    expect(
      failures(({ result, expected }) => {
        const got = ids(result.visible);
        return (
          new Set(got).size === got.length &&
          got.length === expected.length &&
          JSON.stringify(got.slice().sort((a, b) => a - b)) === JSON.stringify(ids(expected).slice().sort((a, b) => a - b))
        );
      })
    ).toEqual([]);
  });

  it("returns groups only in grouped mode, and the group sizes add up to visible.length", () => {
    expect(
      failures(({ result, view: v }) => {
        if (!v.grouped) return result.groups === null;
        if (result.groups === null) return false;
        const grouped = result.groups.flatMap((g) => ids(g.items));
        return (
          grouped.length === result.visible.length &&
          JSON.stringify(grouped.slice().sort((a, b) => a - b)) === JSON.stringify(ids(result.visible).slice().sort((a, b) => a - b))
        );
      })
    ).toEqual([]);
  });

  it("orders groups: categories by name, then Category unavailable, then Uncategorized last; none are empty", () => {
    expect(
      failures(({ result, dataset }) => {
        if (result.groups === null) return true;
        const expectedKeys: string[] = [];
        for (const category of dataset.sortedCategories) {
          if (result.visible.some((m) => m.category_id === category.id)) expectedKeys.push(category.id);
        }
        if (result.visible.some((m) => oracleBucket(m, dataset.categories) === "unknown")) expectedKeys.push("unknown");
        if (result.visible.some((m) => m.category_id === null)) expectedKeys.push("uncategorized");
        const keys = result.groups.map((g) => g.key);
        return (
          JSON.stringify(keys) === JSON.stringify(expectedKeys) &&
          new Set(keys).size === keys.length &&
          result.groups.every((g) => g.items.length > 0)
        );
      })
    ).toEqual([]);
  });

  it("puts each item in the right group with the right title/kind/id: never orphans in Uncategorized, never a category into the wrong group", () => {
    expect(
      failures(({ result, dataset }) => {
        if (result.groups === null) return true;
        return result.groups.every((g) =>
          g.items.every((m) => {
            const bucket = oracleBucket(m, dataset.categories);
            if (g.kind === "uncategorized") return bucket === "uncategorized" && g.title === "Uncategorized" && g.id === null && g.key === "uncategorized";
            if (g.kind === "unknown") return bucket === "unknown" && g.title === "Category unavailable" && g.id === null && g.key === "unknown";
            const category = dataset.categories.find((c) => c.id === g.id);
            return typeof bucket === "object" && bucket.id === g.id && category?.name === g.title && g.key === g.id;
          })
        );
      })
    ).toEqual([]);
  });

  it("lists the items of each group in the same relative order as the flat list", () => {
    expect(
      failures(({ result }) => {
        if (result.groups === null) return true;
        return result.groups.every((g) => {
          const inGroup = new Set(ids(g.items));
          return JSON.stringify(ids(g.items)) === JSON.stringify(ids(result.visible.filter((m) => inGroup.has(m.id))));
        });
      })
    ).toEqual([]);
  });

  it("computes chip counts from search + stock only (never from the category filter) and they add up", () => {
    expect(
      failures(({ result, expectedCounts }) => {
        const { counts } = result;
        const sum = Object.values(counts.byId).reduce((a, b) => a + b, 0);
        return countsEqual(counts, expectedCounts) && counts.uncategorized + counts.unknown + sum === counts.all;
      })
    ).toEqual([]);

    // same search + stock => identical counts whatever the category filter, sort or grouping
    const seen = new Map<string, string>();
    const mismatches: string[] = [];
    for (const run of runs) {
      const key = JSON.stringify([run.dataset.name, run.view.search, run.view.stock]);
      const counts = JSON.stringify(run.result.counts);
      const previous = seen.get(key);
      if (previous === undefined) seen.set(key, counts);
      else if (previous !== counts) mismatches.push(run.label);
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it("shows exactly as many items as the selected category's chip promises", () => {
    expect(
      failures(({ result, view: v, dataset }) => {
        const f = v.category;
        const { counts } = result;
        const chip =
          f.kind === "all"
            ? counts.all
            : f.kind === "uncategorized"
              ? counts.uncategorized
              : f.id === UNKNOWN_CATEGORY_ID
                ? counts.unknown
                : dataset.categories.some((c) => c.id === f.id)
                  ? counts.byId[f.id]
                  : null; // a category missing from the list has no chip; its items are reachable by id only
        return chip === null ? true : result.visible.length === chip;
      })
    ).toEqual([]);
  });

  it("sorts the flat list by the requested key", () => {
    const rank = new WeakMap<Dataset, (m: Medication) => number>();
    const rankFor = (dataset: Dataset): ((m: Medication) => number) => {
      let fn = rank.get(dataset);
      if (!fn) {
        const order = dataset.sortedCategories.map((c) => c.id);
        fn = (m: Medication): number => {
          if (m.category_id === null) return order.length + 1;
          const position = order.indexOf(m.category_id);
          return position === -1 ? order.length : position;
        };
        rank.set(dataset, fn);
      }
      return fn;
    };
    expect(
      failures(({ result, view: v, dataset }) => {
        const list = result.visible;
        const rankOf = rankFor(dataset);
        for (let i = 1; i < list.length; i += 1) {
          const a = list[i - 1];
          const b = list[i];
          const ok =
            v.sort === "name"
              ? nameOrderOk(a, b)
              : v.sort === "stock-asc"
                ? a.stock < b.stock || (a.stock === b.stock && nameOrderOk(a, b))
                : rankOf(a) < rankOf(b) || (rankOf(a) === rankOf(b) && nameOrderOk(a, b));
          if (!ok) return false;
        }
        return true;
      })
    ).toEqual([]);
  });

  it("writes the summary text exactly", () => {
    expect(
      failures(({ result, view: v, dataset }) => {
        const text = oracleSummaryText(dataset.items.length, result.visible.length, v, dataset.categories);
        const active = oracleClean(v.search) !== "" || v.stock !== "all" || v.category.kind !== "all";
        return (
          result.summary.text === text &&
          result.summary.total === dataset.items.length &&
          result.summary.shown === result.visible.length &&
          result.summary.filtersActive === active
        );
      })
    ).toEqual([]);
  });

  it("classifies and words every empty result correctly", () => {
    let emptyRuns = 0;
    const bad = failures((run) => {
      if (run.result.visible.length !== 0) return true;
      emptyRuns += 1;
      const { view: v, dataset } = run;
      const searching = oracleClean(v.search) !== "";
      const expectedKind: EmptyKind = v.category.kind !== "all" && !searching && v.stock === "all" ? "category-empty" : "no-match";
      const empty = describeEmpty(dataset.items.length, v, dataset.categories);
      const text = `${empty.title} ${empty.detail}`;
      const searchPart = oracleClean(v.search);
      return (
        empty.kind === expectedKind &&
        empty.title.length > 0 &&
        empty.detail.length > 0 &&
        !/“\s*”|"\s*"|undefined|\[object|NaN|null/.test(text) &&
        (searching ? empty.title.includes(`“${searchPart}”`) : !text.includes("“")) &&
        (expectedKind === "category-empty" ? empty.title.startsWith("No items in ") : empty.title.startsWith("No items match "))
      );
    });
    expect(bad).toEqual([]);
    expect(emptyRuns).toBeGreaterThan(500); // the matrix really exercises the empty states
  });

  it("is deterministic, and does not depend on the order the items arrive in (names are unique in the fixtures)", () => {
    const sample = runs.filter((_, i) => i % 41 === 0);
    expect(sample.length).toBeGreaterThan(300);
    const bad: string[] = [];
    sample.forEach((run, i) => {
      const again = selectView(run.dataset.items, run.dataset.categories, run.view);
      const reshuffled = selectView(shuffled(run.dataset.items, i + 1), run.dataset.categories, run.view);
      const same =
        JSON.stringify(again) === JSON.stringify(run.result) &&
        JSON.stringify(ids(reshuffled.visible)) === JSON.stringify(ids(run.result.visible)) &&
        JSON.stringify(reshuffled.groups?.map((g) => [g.key, ids(g.items)])) ===
          JSON.stringify(run.result.groups?.map((g) => [g.key, ids(g.items)])) &&
        JSON.stringify(reshuffled.counts) === JSON.stringify(run.result.counts) &&
        reshuffled.summary.text === run.result.summary.text;
      if (!same) bad.push(run.label);
    });
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { Category } from "@/lib/db";
import {
  categoryChipValue,
  categoryTitleByKey,
  categoryTitles,
  describeActiveFilters,
  idKey,
  searchChipText,
  searchChipValue,
  stockChipValue,
} from "@/lib/filter-chips";
import { idKey as idKeyFromIds } from "@/lib/ids";
import {
  DEFAULT_VIEW,
  UNKNOWN_CATEGORY_FILTER,
  UNKNOWN_CATEGORY_ID,
  selectView,
  type CategoryFilter,
  type StockFilter,
  type ViewState,
} from "@/lib/inventory-view";
import { displaySearchText } from "@/lib/search-text";
import { buildCategories, buildMedications, fakeUuid, type IdShape } from "../helpers/fixtures";

// Unit tests for lib/filter-chips.ts: the words on the filter chips of the Inventory tab and of the Admin list. Synthetic data
// only. Invisible characters are built from code points on purpose (written literally they are unreadable in a diff and some
// tooling rewrites them).

const cp = (n: number): string => String.fromCodePoint(n);
const hex = (n: number): string => `U+${n.toString(16).toUpperCase().padStart(4, "0")}`;

const ZWSP = cp(0x200b);
const ZWNJ = cp(0x200c);
const ZWJ = cp(0x200d);
const SOFT_HYPHEN = cp(0x00ad);
const LRM = cp(0x200e);
const BOM = cp(0xfeff);
const RLO = cp(0x202e); // right-to-left override
const VARIATION_SELECTOR_16 = cp(0xfe0f);
const HANGUL_FILLER = cp(0x3164);
const NBSP = cp(0x00a0);
const BRAILLE_BLANK = cp(0x2800);
const COMBINING_ACUTE = cp(0x0301);
const COMBINING_GRAVE = cp(0x0300);
const SPACING_DIAERESIS = cp(0x00a8); // NFKC turns it into a space plus a combining diaeresis
const E_GRAVE = cp(0x00e8);

const SHAPES: readonly IdShape[] = ["uuid", "bigint"];

function view(patch: Partial<ViewState>): ViewState {
  return { ...DEFAULT_VIEW, ...patch };
}

function category(id: string, name: string): Category {
  return { id, name, created_at: null };
}

/** The text a chip shows, as ActiveFilterChips composes it ("<label>: <value>"; it is also the remove button's name after "Remove filter "). */
const chipTexts = (specs: ReadonlyArray<{ label: string; value: string }>): string[] => specs.map((spec) => `${spec.label}: ${spec.value}`);

// Searches that must not count as a search at all.
const NO_SEARCH: Array<[string, unknown]> = [
  ["undefined", undefined],
  ["null", null],
  ["a number", 5],
  ["an object", {}],
  ["an array", []],
  ["empty text", ""],
  ["one space", " "],
  ["spaces, tab, newline and no-break space", ` \t\n${NBSP}  `],
  ["a zero-width space", ZWSP],
  ["zero-width space, soft hyphen, joiner and blanks", `${ZWSP}${SOFT_HYPHEN} ${ZWJ}\t${ZWNJ}`],
  ["a byte order mark", BOM],
  ["a bidi override", RLO],
  ["a variation selector", VARIATION_SELECTOR_16],
  ["a Hangul filler (the 'invisible username' character)", HANGUL_FILLER],
  ["a left-to-right mark between spaces", ` ${LRM} `],
  // Accents are ignored when searching, so a search made only of them has nothing to look for.
  ["a lone combining accent", COMBINING_ACUTE],
  ["combining accents between spaces", ` ${COMBINING_ACUTE} ${COMBINING_GRAVE} `],
  ["a spacing diaeresis (a space plus an accent once folded)", SPACING_DIAERESIS],
];

// ── idKey ────────────────────────────────────────────────────────────────────────

describe("idKey", () => {
  it.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["empty text", ""],
    ["blank text", "   \t"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("is null for %s", (_label, value) => {
    expect(idKey(value)).toBeNull();
  });

  it("trims and lower-cases, so a uuid compares the way the view logic compares it", () => {
    expect(idKey(`  ${fakeUuid(3).toUpperCase()} `)).toBe(fakeUuid(3));
    expect(idKey("AbC")).toBe("abc");
  });

  it("turns numbers and digit strings into the same key (bigint ids)", () => {
    expect(idKey(42)).toBe("42");
    expect(idKey("42")).toBe("42");
    expect(idKey(" 0042 ")).toBe("0042"); // never numeric: leading zeros survive
  });

  it("is the one idKey of lib/ids.ts, not a copy (the Inventory components import it from here)", () => {
    expect(idKey).toBe(idKeyFromIds);
  });
});

// ── categoryTitles / categoryTitleByKey ──────────────────────────────────────────

describe("categoryTitles", () => {
  it.each(SHAPES)("lists every category of the %s fixture in list order, each with its name as the title", (shape) => {
    const categories = buildCategories(shape);
    const titles = categoryTitles(categories);
    expect(titles.map((entry) => entry.title)).toEqual(categories.map((c) => c.name));
    expect(titles.map((entry) => entry.id)).toEqual(categories.map((c) => c.id));
    expect(titles.map((entry) => entry.position)).toEqual(categories.map((_c, index) => index));
    expect(titles.map((entry) => entry.key)).toEqual(categories.map((c) => c.id.toLowerCase()));
  });

  it("keeps the id as given and the key lower-cased", () => {
    const [entry] = categoryTitles([category("ABCDEF00-0000-4000-8000-000000000001", "Upper")]);
    expect(entry.id).toBe("ABCDEF00-0000-4000-8000-000000000001");
    expect(entry.key).toBe("abcdef00-0000-4000-8000-000000000001");
  });

  it("trims names; a blank or missing name reads 'Unnamed category'", () => {
    const titles = categoryTitles([
      category("1", "  Antibiotics  "),
      category("2", ""),
      category("3", " \t "),
      { id: "4", name: null as unknown as string, created_at: null },
    ]);
    expect(titles.map((entry) => entry.title)).toEqual(["Antibiotics", "Unnamed category", "Unnamed category", "Unnamed category"]);
  });

  it("leaves out blank ids, the reserved 'unknown' id (any case) and repeated ids; the first of a repeat wins", () => {
    const titles = categoryTitles([
      category("", "No id"),
      category("   ", "Blank id"),
      category(UNKNOWN_CATEGORY_ID, "Sneaky"),
      category(" UNKNOWN ", "Sneakier"),
      category("5", "First five"),
      category(" 5 ", "Second five"),
      category(fakeUuid(7), "Seven"),
      category(fakeUuid(7).toUpperCase(), "Seven again"),
      category("6", "Six"),
    ]);
    expect(titles.map((entry) => [entry.id, entry.title, entry.position])).toEqual([
      ["5", "First five", 4],
      [fakeUuid(7), "Seven", 6],
      ["6", "Six", 8],
    ]);
  });

  it("accepts a number as an id (a legacy bigint row) and reports it as text", () => {
    const [entry] = categoryTitles([{ id: 7 as unknown as string, name: "Seven", created_at: null }]);
    expect(entry).toMatchObject({ id: "7", key: "7", title: "Seven" });
  });

  it("gives an empty list for an empty list", () => {
    expect(categoryTitles([])).toEqual([]);
    expect(categoryTitleByKey([]).size).toBe(0);
  });
});

describe("categoryTitleByKey", () => {
  it.each(SHAPES)("maps the key of every %s category to its title", (shape) => {
    const categories = buildCategories(shape);
    const byKey = categoryTitleByKey(categories);
    expect(byKey.size).toBe(categories.length);
    for (const c of categories) expect(byKey.get(c.id.toLowerCase())).toBe(c.name);
  });

  it("never holds the reserved 'unknown' key", () => {
    expect(categoryTitleByKey([category(UNKNOWN_CATEGORY_ID, "Sneaky")]).has(UNKNOWN_CATEGORY_ID)).toBe(false);
  });
});

// ── The Search chip ──────────────────────────────────────────────────────────────

describe("searchChipText", () => {
  it.each(NO_SEARCH)("is empty for %s", (_label, search) => {
    expect(searchChipText(search)).toBe("");
  });

  it("drops zero-width characters, the soft hyphen, joiners and direction marks from inside a word", () => {
    expect(searchChipText(`ibu${ZWSP}pro${SOFT_HYPHEN}fen`)).toBe("ibuprofen");
    expect(searchChipText(`${ZWJ}${ZWNJ}ibuprofen${LRM}${BOM}`)).toBe("ibuprofen");
    expect(searchChipText(`${RLO}ibuprofen`)).toBe("ibuprofen"); // an override left in would print it backwards
  });

  it("drops variation selectors too (the same rule as the search itself)", () => {
    expect(searchChipText(`heart${VARIATION_SELECTOR_16}`)).toBe("heart");
  });

  it("trims the ends and collapses runs of whitespace of every kind to one space", () => {
    expect(searchChipText("  ibuprofen \t 200\n\n mg  ")).toBe("ibuprofen 200 mg");
    expect(searchChipText(`a${NBSP}${NBSP}b`)).toBe("a b");
    expect(searchChipText(`a ${ZWSP} b`)).toBe("a b"); // the gap the invisible character leaves collapses as well
  });

  it("leaves everything else as typed: case, accents, full-width letters, quotes, punctuation", () => {
    expect(searchChipText('Ｉbuprofen "200" Café, 5%')).toBe('Ｉbuprofen "200" Café, 5%');
    expect(searchChipText("“quoted” and ‘single’")).toBe("“quoted” and ‘single’");
  });

  it("does not treat a Braille blank or a control character as invisible (the view logic keeps them as text)", () => {
    expect(searchChipText(BRAILLE_BLANK)).toBe(BRAILLE_BLANK);
    expect(searchChipText("a\u0001b")).toBe("a\u0001b");
  });

  it("keeps a 200-character search whole (the chip cuts it short with CSS, never here)", () => {
    expect(searchChipText("x".repeat(200))).toBe("x".repeat(200));
    expect(searchChipText(`${ZWSP}${"x".repeat(200)}${ZWSP}`)).toBe("x".repeat(200));
    expect(searchChipText(`${"ab ".repeat(66)}`)).toBe(`${"ab ".repeat(66)}`.trim());
  });

  it("shows accents exactly as typed, however they are written: the search ignores them, the chip never rewrites them", () => {
    for (const typed of [`Cr${E_GRAVE}me`, `CR${cp(0x00c8)}ME`, `Cre${COMBINING_GRAVE}me`, "creme"]) {
      expect(searchChipText(typed)).toBe(typed);
      expect(searchChipValue(typed)).toBe(`“${typed}”`);
    }
    expect(searchChipText(` a${COMBINING_ACUTE} `)).toBe(`a${COMBINING_ACUTE}`); // an accent on a letter is part of the word
  });

  it("is the one display rule of lib/search-text.ts (the summary line of lib/inventory-view.ts uses it too)", () => {
    const corpus: unknown[] = [
      ...NO_SEARCH.map(([, search]) => search),
      "  ibuprofen \t 200\n mg ",
      `ibu${ZWSP}pro${SOFT_HYPHEN}fen`,
      `Cr${E_GRAVE}me`,
      `Cre${COMBINING_GRAVE}me`,
      `a${COMBINING_ACUTE}`,
      "Ｉbuprofen",
      BRAILLE_BLANK,
    ];
    for (const search of corpus) expect(searchChipText(search), JSON.stringify(search)).toBe(displaySearchText(search));
  });
});

describe("searchChipValue", () => {
  it.each(NO_SEARCH)("is null (no chip) for %s", (_label, search) => {
    expect(searchChipValue(search)).toBeNull();
  });

  it("puts the text between curly quotes", () => {
    expect(searchChipValue("tablets")).toBe("“tablets”");
    expect(searchChipValue("  tablets  ")).toBe("“tablets”");
  });

  it("is the same text for a pasted word with invisible characters in it", () => {
    expect(searchChipValue(`tab${ZWSP}lets`)).toBe("“tablets”");
    expect(searchChipValue(`${RLO}ibuprofen`)).toBe("“ibuprofen”");
  });

  it("leaves quotes inside the text as typed, and does not double them", () => {
    expect(searchChipValue('say "hi"')).toBe('“say "hi"”');
    expect(searchChipValue("“quoted”")).toBe("““quoted””");
    expect(searchChipValue("children's")).toBe("“children's”");
    expect(searchChipValue('"')).toBe('“"”'); // a lone quote mark is a search like any other
  });

  it("keeps a 200-character value whole, with its two quotes", () => {
    const long = "x".repeat(200);
    const value = searchChipValue(long);
    expect(value).toBe(`“${long}”`);
    expect(value).toHaveLength(202);
  });

  it("is never an empty pair of quotes", () => {
    for (const [, search] of NO_SEARCH) expect(searchChipValue(search)).not.toBe("“”");
  });
});

// ── The Stock chip ───────────────────────────────────────────────────────────────

describe("stockChipValue", () => {
  it("says nothing for All, 'Low' for low and 'Adequate' for ok", () => {
    expect(stockChipValue("all")).toBeNull();
    expect(stockChipValue("low")).toBe("Low");
    expect(stockChipValue("ok")).toBe("Adequate");
  });

  it("says nothing for a value that is not a stock filter", () => {
    for (const bad of ["LOW", "", "adequate", "high"]) expect(stockChipValue(bad as StockFilter)).toBeNull();
  });
});

// ── The Category chip ────────────────────────────────────────────────────────────

describe("categoryChipValue", () => {
  it.each(SHAPES)("names every %s category, and says Uncategorized / Category unavailable / nothing", (shape) => {
    const categories = buildCategories(shape);
    const byKey = categoryTitleByKey(categories);
    expect(categoryChipValue({ kind: "all" }, byKey)).toBeNull();
    expect(categoryChipValue({ kind: "uncategorized" }, byKey)).toBe("Uncategorized");
    expect(categoryChipValue(UNKNOWN_CATEGORY_FILTER, byKey)).toBe("Category unavailable");
    for (const c of categories) expect(categoryChipValue({ kind: "category", id: c.id }, byKey), c.id).toBe(c.name);
  });

  it("says 'Category unavailable' for an id the list cannot name (deleted since, or from another database)", () => {
    const byKey = categoryTitleByKey(buildCategories("uuid"));
    expect(categoryChipValue({ kind: "category", id: fakeUuid(999) }, byKey)).toBe("Category unavailable");
    expect(categoryChipValue({ kind: "category", id: "999" }, byKey)).toBe("Category unavailable");
    expect(categoryChipValue({ kind: "category", id: "" }, byKey)).toBe("Category unavailable");
    expect(categoryChipValue({ kind: "category", id: "   " }, byKey)).toBe("Category unavailable");
    expect(categoryChipValue({ kind: "category", id: "5" }, new Map())).toBe("Category unavailable"); // categories not loaded
  });

  it("finds a category whatever the case or padding of the id, like the view logic", () => {
    const [first] = buildCategories("uuid");
    const byKey = categoryTitleByKey([first]);
    expect(categoryChipValue({ kind: "category", id: first.id.toUpperCase() }, byKey)).toBe(first.name);
    expect(categoryChipValue({ kind: "category", id: `  ${first.id} ` }, byKey)).toBe(first.name);
  });

  it("reads a blank category name as 'Unnamed category'", () => {
    const byKey = categoryTitleByKey([category("8", "   ")]);
    expect(categoryChipValue({ kind: "category", id: "8" }, byKey)).toBe("Unnamed category");
  });

  it("never lets the reserved pseudo id name a real category", () => {
    const byKey = categoryTitleByKey([category(UNKNOWN_CATEGORY_ID, "Sneaky")]);
    expect(categoryChipValue(UNKNOWN_CATEGORY_FILTER, byKey)).toBe("Category unavailable");
  });

  it("is no chip for something that is not a category filter", () => {
    expect(categoryChipValue({ kind: "bogus" } as unknown as CategoryFilter, new Map())).toBeNull();
  });
});

// ── Together ─────────────────────────────────────────────────────────────────────

describe("describeActiveFilters", () => {
  const categories = buildCategories("uuid");
  const byKey = categoryTitleByKey(categories);
  const antibiotics = categories.find((c) => c.name === "Antibiotics");
  if (!antibiotics) throw new Error("fixture: Antibiotics");

  it("is empty while no filter narrows the list", () => {
    expect(describeActiveFilters(DEFAULT_VIEW, byKey)).toEqual([]);
    expect(describeActiveFilters(view({ search: "   " }), byKey)).toEqual([]);
    expect(describeActiveFilters(view({ search: `${ZWSP}${SOFT_HYPHEN}` }), byKey)).toEqual([]);
  });

  it("gives one entry per filter, with the label and the value the chip shows", () => {
    expect(describeActiveFilters(view({ category: { kind: "category", id: antibiotics.id } }), byKey)).toEqual([
      { key: "category", label: "Category", value: "Antibiotics" },
    ]);
    expect(describeActiveFilters(view({ category: { kind: "uncategorized" } }), byKey)).toEqual([
      { key: "category", label: "Category", value: "Uncategorized" },
    ]);
    expect(describeActiveFilters(view({ category: UNKNOWN_CATEGORY_FILTER }), byKey)).toEqual([
      { key: "category", label: "Category", value: "Category unavailable" },
    ]);
    expect(describeActiveFilters(view({ stock: "low" }), byKey)).toEqual([{ key: "stock", label: "Stock", value: "Low" }]);
    expect(describeActiveFilters(view({ stock: "ok" }), byKey)).toEqual([{ key: "stock", label: "Stock", value: "Adequate" }]);
    expect(describeActiveFilters(view({ search: "tablets" }), byKey)).toEqual([{ key: "search", label: "Search", value: "“tablets”" }]);
  });

  it("lists them in the order of the summary line (Category, Stock, Search) and composes the texts the chips show", () => {
    const specs = describeActiveFilters(
      view({ search: " tablets ", stock: "low", category: { kind: "category", id: antibiotics.id } }),
      byKey
    );
    expect(specs.map((spec) => spec.key)).toEqual(["category", "stock", "search"]);
    expect(chipTexts(specs)).toEqual(["Category: Antibiotics", "Stock: Low", "Search: “tablets”"]);
  });

  it("is what both screens show for a search: Search: “tablets” (the Admin chip once left the quotes out)", () => {
    // The Admin list has no stock filter and passes `stock: "all"`; the Inventory tab passes its whole view.
    const admin = describeActiveFilters(view({ search: "tablets", category: { kind: "all" } }), byKey);
    const inventory = describeActiveFilters(view({ search: "tablets", stock: "all", category: { kind: "all" }, sort: "stock-asc", grouped: false }), byKey);
    expect(chipTexts(admin)).toEqual(["Search: “tablets”"]);
    expect(admin).toEqual(inventory);
  });

  it("never gives a stock chip while the stock filter is All", () => {
    const specs = describeActiveFilters(view({ search: "a", category: { kind: "uncategorized" } }), byKey);
    expect(specs.map((spec) => spec.key)).toEqual(["category", "search"]);
  });

  it("only needs the three fields it reads", () => {
    expect(describeActiveFilters({ search: "a", stock: "ok", category: { kind: "all" } }, byKey).map((spec) => spec.key)).toEqual([
      "stock",
      "search",
    ]);
  });

  it("does not change what it is given", () => {
    const input = view({ search: " a ", stock: "low", category: { kind: "category", id: antibiotics.id } });
    const snapshot = JSON.stringify(input);
    describeActiveFilters(input, byKey);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ── The chips and the summary line say the same thing ────────────────────────────

describe("agrees with the summary line of lib/inventory-view.ts (so the two cannot drift apart)", () => {
  const SEARCHES: string[] = [
    "",
    "   ",
    ZWSP,
    `${ZWSP} ${SOFT_HYPHEN}`,
    "tablets",
    "  tablets  ",
    `tab${ZWSP}lets`,
    'say "hi"',
    "“quoted”",
    "a\t\nb",
    "x".repeat(200),
    `${RLO}ibuprofen`,
    BRAILLE_BLANK,
    "Ｉbuprofen",
    "children's",
    "100 % cotton, size L",
  ];
  const STOCKS: StockFilter[] = ["all", "low", "ok"];

  it.each(SHAPES)("for every search x stock level x category filter (%s ids)", (shape) => {
    const categories = buildCategories(shape);
    const items = buildMedications({ shape });
    const byKey = categoryTitleByKey(categories);
    const categoryFilters: CategoryFilter[] = [
      { kind: "all" },
      { kind: "uncategorized" },
      UNKNOWN_CATEGORY_FILTER,
      ...categories.map((c): CategoryFilter => ({ kind: "category", id: c.id })),
      { kind: "category", id: fakeUuid(999) }, // an id that is not in the list
      { kind: "category", id: "   " },
    ];
    let compared = 0;
    for (const search of SEARCHES) {
      for (const stock of STOCKS) {
        for (const filter of categoryFilters) {
          const current = view({ search, stock, category: filter });
          const specs = describeActiveFilters(current, byKey);
          const { summary } = selectView(items, categories, current);
          const label = JSON.stringify({ search, stock, filter });

          expect(summary.filtersActive, label).toBe(specs.length > 0);
          // The summary writes "Category: X", "Stock: Y" and (without a colon) Search “z”; the chips write "<label>: <value>".
          const parts = specs.map((spec) => (spec.key === "search" ? `${spec.label} ${spec.value}` : `${spec.label}: ${spec.value}`));
          const noun = summary.total === 1 ? "item" : "items";
          const expected =
            parts.length === 0
              ? `Showing all ${summary.total} ${noun}.`
              : [`Showing ${summary.shown} of ${summary.total} ${noun}`, ...parts].join(" · ");
          expect(summary.text, label).toBe(expected);
          compared += 1;
        }
      }
    }
    expect(compared).toBe(SEARCHES.length * STOCKS.length * categoryFilters.length);
  });

  it("agrees about what a search is for EVERY BMP character (alone, doubled, between letters, between spaces)", () => {
    const disagreements: string[] = [];
    for (let codePoint = 0; codePoint <= 0xffff; codePoint += 1) {
      const ch = String.fromCharCode(codePoint); // lone surrogates included: they are ordinary text
      for (const search of [ch, `${ch}${ch}`, `a${ch}b`, ` ${ch} `]) {
        const chip = searchChipValue(search);
        const { summary } = selectView([], [], view({ search }));
        if (chip === null) {
          if (summary.filtersActive) disagreements.push(`${hex(codePoint)}: summary has a search, the chip has none`);
        } else if (!summary.filtersActive || !summary.text.endsWith(`Search ${chip}`)) {
          disagreements.push(`${hex(codePoint)}: chip ${chip} vs summary "${summary.text}"`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("agrees for the invisible characters outside the BMP (tag characters, musical and shorthand format characters)", () => {
    const ranges: Array<[number, number]> = [
      [0xe0000, 0xe0fff], // tags, variation selectors supplement and the reserved code points between
      [0x1bca0, 0x1bca3], // shorthand format controls
      [0x1d173, 0x1d17a], // musical symbol begin/end beam, tie, slur, phrase
    ];
    const disagreements: string[] = [];
    for (const [from, to] of ranges) {
      for (let codePoint = from; codePoint <= to; codePoint += 1) {
        const ch = cp(codePoint);
        for (const search of [ch, `a${ch}b`, ` ${ch} `]) {
          const chip = searchChipValue(search);
          const { summary } = selectView([], [], view({ search }));
          if ((chip !== null) !== summary.filtersActive) disagreements.push(`${hex(codePoint)} in ${JSON.stringify(search)}`);
          if (chip !== null && !summary.text.endsWith(`Search ${chip}`)) disagreements.push(`${hex(codePoint)} text`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});

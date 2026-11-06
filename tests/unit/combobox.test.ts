// Unit tests for lib/combobox.ts (the pure logic behind the searchable category picker, app/components/Combobox.tsx).
//
// Layout: table-driven tests per function, boundary cases (0 / 1 / many options, only actions, duplicate labels, 1,000
// options), a seeded property test that checks filterOptions against an independent naive oracle, an exhaustive sweep of
// moveActive, a sweep of every BMP character through foldForSearch, and a cross-check that the search folding agrees
// with the Inventory search (lib/inventory-view.ts keeps its own private `fold`; both drop invisible characters with the one
// shared stripInvisibleCharacters of lib/text-safety.ts, the rest of the folding is written twice, hence this cross-check).
// Synthetic data only. The component itself has no DOM test (no jsdom in this repo): it is checked in the browser.
import { describe, expect, it, vi } from "vitest";
import type { Medication } from "@/lib/db";
import { matchesSearch } from "@/lib/inventory-view";
import {
  COMBOBOX_MIN_OPTIONS,
  filterOptions,
  findOptionByValue,
  foldForSearch,
  initialActiveIndex,
  moveActive,
  placePopup,
  repeatClickGuard,
  resultsMessage,
  shouldUseCombobox,
  singleMatchIndex,
  type ActiveKey,
  type ComboboxOption,
  type ViewportBox,
} from "@/lib/combobox";

// ── Helpers ─────────────────────────────────────────────────────────────────────

// Invisible or look-alike characters are built from code points on purpose: as literals in source they are unreadable,
// and an editor that normalizes text would silently turn the NFD cases into NFC ones.
const NBSP = String.fromCodePoint(0x00a0);
const EM_SPACE = String.fromCodePoint(0x2003);
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);
const ZWSP = String.fromCodePoint(0x200b);
const ZWJ = String.fromCodePoint(0x200d);
const ZWNJ = String.fromCodePoint(0x200c);
const SOFT_HYPHEN = String.fromCodePoint(0x00ad);
const WORD_JOINER = String.fromCodePoint(0x2060);
const BOM = String.fromCodePoint(0xfeff);
const LRM = String.fromCodePoint(0x200e);
const RLM = String.fromCodePoint(0x200f);
const BIDI_ISOLATE = String.fromCodePoint(0x2066);
const VARIATION_SELECTOR = String.fromCodePoint(0xfe0f);
const COMBINING_ACUTE = String.fromCodePoint(0x0301);
const MICRO_SIGN = String.fromCodePoint(0x00b5);
const GREEK_MU = String.fromCodePoint(0x03bc);
const LIGATURE_FI = String.fromCodePoint(0xfb01);
const SQUARE_MG = String.fromCodePoint(0x338e);
const FULLWIDTH_ABC = String.fromCodePoint(0xff21, 0xff22, 0xff23);
const E_ACUTE = String.fromCodePoint(0x00e9);
const A_UMLAUT = String.fromCodePoint(0x00e4);
const INVISIBLES = [ZWSP, ZWJ, ZWNJ, SOFT_HYPHEN, WORD_JOINER, BOM, LRM, RLM, BIDI_ISOLATE, VARIATION_SELECTOR];

function opt(value: string, label: string, extra: Partial<ComboboxOption> = {}): ComboboxOption {
  return { value, label, ...extra };
}

const action = (value: string, label: string): ComboboxOption => ({ value, label, kind: "action" });

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Small deterministic generator (mulberry32) so a failing property case can be reproduced from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS: readonly ActiveKey[] = ["ArrowDown", "ArrowUp", "Home", "End"];

// ── Constants ───────────────────────────────────────────────────────────────────

describe("COMBOBOX_MIN_OPTIONS / shouldUseCombobox", () => {
  it("is 11 (a native select up to 10 real options, the combobox from 11)", () => {
    expect(COMBOBOX_MIN_OPTIONS).toBe(11);
  });

  it.each([
    [0, false],
    [1, false],
    [10, false],
    [11, true],
    [12, true],
    [1000, true],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [-5, false],
  ])("shouldUseCombobox(%s) is %s", (count, expected) => {
    expect(shouldUseCombobox(count)).toBe(expected);
  });
});

// ── foldForSearch ───────────────────────────────────────────────────────────────

describe("foldForSearch", () => {
  it.each([
    ["Amoxicillin", "amoxicillin"],
    ["ANTIBIOTICS", "antibiotics"],
    ["", ""],
    ["   ", ""],
    ["  First   Aid  ", "first aid"],
    ["a\tb\nc\r\nd", "a b c d"],
    [`a${NBSP}b`, "a b"],
    [`a${EM_SPACE}${EM_SPACE}b`, "a b"],
    [`a${IDEOGRAPHIC_SPACE}b`, "a b"],
    ["Vitamin B12", "vitamin b12"],
    ["N-95 (masks)", "n-95 (masks)"],
  ])("folds %j to %j", (input, expected) => {
    expect(foldForSearch(input)).toBe(expected);
  });

  it("removes invisible and format characters, also from the middle of a word", () => {
    for (const invisible of INVISIBLES) {
      expect(foldForSearch(`ab${invisible}cd`)).toBe("abcd");
      expect(foldForSearch(`${invisible}ab`)).toBe("ab");
      expect(foldForSearch(`ab${invisible}`)).toBe("ab");
      expect(foldForSearch(invisible)).toBe("");
      expect(foldForSearch(`a ${invisible} b`)).toBe("a b");
    }
  });

  it("uses NFKC: look-alike and compatibility forms are equal", () => {
    expect(foldForSearch(`10 ${MICRO_SIGN}g`)).toBe(foldForSearch(`10 ${GREEK_MU}g`));
    expect(foldForSearch(FULLWIDTH_ABC)).toBe("abc");
    expect(foldForSearch(`${LIGATURE_FI}ne`)).toBe("fine");
    expect(foldForSearch(SQUARE_MG)).toBe("mg");
  });

  it("treats a composed accent and a letter plus combining accent as the same text", () => {
    expect(foldForSearch(`caf${E_ACUTE}`)).toBe(foldForSearch(`cafe${COMBINING_ACUTE}`));
    expect(foldForSearch(`CAFE${COMBINING_ACUTE}`)).toBe(`caf${E_ACUTE}`);
    // an accent separated from its letter by an invisible character still composes
    expect(foldForSearch(`cafe${ZWSP}${COMBINING_ACUTE}`)).toBe(`caf${E_ACUTE}`);
  });

  it("is accent-sensitive: a letter without its accent is a different letter", () => {
    expect(foldForSearch("cafe")).not.toBe(foldForSearch(`caf${E_ACUTE}`));
    expect(foldForSearch("a")).not.toBe(foldForSearch(A_UMLAUT));
  });

  it("is idempotent on a corpus of tricky text", () => {
    const corpus = [
      "Amoxicillin 500 mg",
      `${MICRO_SIGN}g ${GREEK_MU}g ${SQUARE_MG}`,
      `${ZWSP}${NBSP}  x  ${EM_SPACE}`,
      `ǅ ẞ İ Ω K Ⅷ ${LIGATURE_FI}`,
      FULLWIDTH_ABC,
      "",
    ];
    for (const text of corpus) expect(foldForSearch(foldForSearch(text))).toBe(foldForSearch(text));
  });

  it("never throws and always returns a trimmed, single-spaced string without invisible characters (every BMP character)", () => {
    const invisible = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
    // 65,536 characters x 3 positions: violations are collected and asserted once (an expect() per character is slow).
    const violations: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp += 1) {
      const ch = String.fromCodePoint(cp);
      for (const text of [ch, `a${ch}b`, ` ${ch} `]) {
        const folded = foldForSearch(text);
        if (folded !== folded.trim()) violations.push(`U+${cp.toString(16)} not trimmed`);
        if (/\s\s/.test(folded)) violations.push(`U+${cp.toString(16)} double space`);
        if (invisible.test(folded)) violations.push(`U+${cp.toString(16)} invisible character left`);
        if (foldForSearch(folded) !== folded) violations.push(`U+${cp.toString(16)} not idempotent`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("returns an empty string for something that is not a string (untyped callers)", () => {
    expect(foldForSearch(undefined as unknown as string)).toBe("");
    expect(foldForSearch(null as unknown as string)).toBe("");
    expect(foldForSearch(42 as unknown as string)).toBe("");
  });
});

// ── filterOptions ───────────────────────────────────────────────────────────────

describe("filterOptions", () => {
  const CATEGORIES: ComboboxOption[] = [
    opt("1", "Antibiotics"),
    opt("2", "Allergy & Cold"),
    opt("3", "First Aid"),
    opt("4", "Pain Relief", { description: "Analgesics and anti-inflammatories" }),
    opt("5", "Vaccines", { description: "Refrigerated" }),
    opt("", "Uncategorized"),
  ];
  const CREATE = action("__new__", "+ Create new category…");

  describe("boundaries", () => {
    it("0 options: nothing in, nothing out, for any query", () => {
      expect(filterOptions([], "")).toEqual([]);
      expect(filterOptions([], "anything")).toEqual([]);
    });

    it("1 option: kept when it matches, dropped when it does not", () => {
      const only = [opt("1", "Antibiotics")];
      expect(filterOptions(only, "anti")).toEqual(only);
      expect(filterOptions(only, "zzz")).toEqual([]);
      expect(filterOptions(only, "")).toEqual(only);
    });

    it("many options: keeps the matches in their original order", () => {
      expect(filterOptions(CATEGORIES, "a").map((o) => o.label)).toEqual([
        "Antibiotics",
        "Allergy & Cold",
        "First Aid",
        "Pain Relief",
        "Vaccines",
        "Uncategorized",
      ]);
      expect(filterOptions(CATEGORIES, "vacc").map((o) => o.label)).toEqual(["Vaccines"]);
    });

    it("only actions: all of them stay, in order, whatever the query", () => {
      const actions = [action("a", "+ Create new…"), action("b", "Manage categories…")];
      expect(filterOptions(actions, "")).toEqual(actions);
      expect(filterOptions(actions, "zzz")).toEqual(actions);
    });

    it("a query that matches nothing leaves only the actions", () => {
      expect(filterOptions([...CATEGORIES, CREATE], "zzz")).toEqual([CREATE]);
    });

    it("duplicate labels are all kept (the value tells them apart)", () => {
      const dupes = [opt("1", "Vaccines"), opt("2", "Vaccines"), opt("3", "Other")];
      expect(filterOptions(dupes, "vaccines").map((o) => o.value)).toEqual(["1", "2"]);
    });

    it('"" is a legitimate value and an option with it is found like any other', () => {
      expect(filterOptions(CATEGORIES, "uncat")).toEqual([opt("", "Uncategorized")]);
    });
  });

  describe("queries", () => {
    it.each([[""], ["   "], ["\t\n"], [NBSP], [ZWSP], [`${ZWSP}${ZWJ}${SOFT_HYPHEN}`], [`  ${ZWSP}  ${BOM} `]])(
      "an empty or invisible-only query (%j) returns everything",
      (query) => {
        expect(filterOptions(CATEGORIES, query)).toEqual(CATEGORIES);
      }
    );

    it("is case-insensitive in both directions", () => {
      expect(filterOptions(CATEGORIES, "ANTI").map((o) => o.value)).toEqual(["1", "4"]);
      expect(filterOptions(CATEGORIES, "first AID").map((o) => o.value)).toEqual(["3"]);
    });

    it("every term must match (AND), in any order", () => {
      expect(filterOptions(CATEGORIES, "aid first").map((o) => o.value)).toEqual(["3"]);
      expect(filterOptions(CATEGORIES, "allergy cold").map((o) => o.value)).toEqual(["2"]);
      expect(filterOptions(CATEGORIES, "allergy zzz")).toEqual([]);
    });

    it("splits terms on any whitespace and ignores extra spacing", () => {
      expect(filterOptions(CATEGORIES, `  first${NBSP}${NBSP}\taid  `).map((o) => o.value)).toEqual(["3"]);
    });

    it("searches the description too", () => {
      expect(filterOptions(CATEGORIES, "refrigerated").map((o) => o.value)).toEqual(["5"]);
      expect(filterOptions(CATEGORIES, "analgesics").map((o) => o.value)).toEqual(["4"]);
    });

    it("terms may be found in different fields of the same option", () => {
      expect(filterOptions(CATEGORIES, "pain analgesics").map((o) => o.value)).toEqual(["4"]);
      expect(filterOptions(CATEGORIES, "vaccines refrigerated").map((o) => o.value)).toEqual(["5"]);
    });

    it("does not search the value", () => {
      expect(filterOptions([opt("secret-id-77", "Plain")], "secret")).toEqual([]);
    });

    it("a term cannot match across the join of label and description", () => {
      const joined = [opt("1", "Alpha", { description: "Beta" })];
      expect(filterOptions(joined, "alphabeta")).toEqual([]);
      expect(filterOptions(joined, "alpha beta")).toEqual(joined);
    });

    it("is accent-sensitive and composition-insensitive", () => {
      const cafes = [opt("1", `Caf${E_ACUTE}`), opt("2", "Cafe")];
      expect(filterOptions(cafes, "caf").map((o) => o.value)).toEqual(["1", "2"]); // the shared start finds both
      expect(filterOptions(cafes, "cafe").map((o) => o.value)).toEqual(["2"]); // "cafe" is not inside "café"
      expect(filterOptions(cafes, `caf${E_ACUTE}`).map((o) => o.value)).toEqual(["1"]); // the accent narrows it
      expect(filterOptions(cafes, `cafe${COMBINING_ACUTE}`).map((o) => o.value)).toEqual(["1"]); // decomposed accent
      expect(filterOptions(cafes, `CAF${E_ACUTE.toUpperCase()}`).map((o) => o.value)).toEqual(["1"]);
      expect(filterOptions([opt("1", "Cafe")], `caf${E_ACUTE}`)).toEqual([]); // an accent is never ignored
    });

    it("ignores invisible characters in the query and in the label", () => {
      const options = [opt("1", `Anti${ZWSP}biotics`), opt("2", "Other")];
      expect(filterOptions(options, "antibiotics").map((o) => o.value)).toEqual(["1"]);
      expect(filterOptions(options, `anti${SOFT_HYPHEN}biotics`).map((o) => o.value)).toEqual(["1"]);
    });

    it("treats look-alike forms as equal (NFKC)", () => {
      const options = [opt("1", `10 ${MICRO_SIGN}g vials`), opt("2", "Other")];
      expect(filterOptions(options, `${GREEK_MU}g`).map((o) => o.value)).toEqual(["1"]);
      expect(filterOptions(options, `${FULLWIDTH_ABC.slice(0, 0)}vials`).map((o) => o.value)).toEqual(["1"]);
    });

    it("treats regex characters in the query as plain text", () => {
      const options = [opt("1", "N-95 (masks) [box]"), opt("2", "Gloves")];
      expect(filterOptions(options, "(masks)").map((o) => o.value)).toEqual(["1"]);
      expect(filterOptions(options, "[box]").map((o) => o.value)).toEqual(["1"]);
      expect(filterOptions(options, ".*")).toEqual([]);
      expect(filterOptions(options, "\\")).toEqual([]);
    });
  });

  describe("actions", () => {
    it("are never filtered out and come last", () => {
      const result = filterOptions([...CATEGORIES, CREATE], "vacc");
      expect(result.map((o) => o.value)).toEqual(["5", "__new__"]);
    });

    it("come last even when the input listed them earlier, and keep their relative order", () => {
      const a1 = action("a1", "First action");
      const a2 = action("a2", "Second action");
      const result = filterOptions([a1, opt("1", "One"), a2, opt("2", "Two")], "");
      expect(result.map((o) => o.value)).toEqual(["1", "2", "a1", "a2"]);
      expect(filterOptions([a1, opt("1", "One"), a2, opt("2", "Two")], "two").map((o) => o.value)).toEqual(["2", "a1", "a2"]);
    });

    it("do not need to match the query", () => {
      expect(filterOptions([CREATE], "vaccines")).toEqual([CREATE]);
    });

    it("an explicit kind of option behaves like no kind: it is filtered like any option and never kept like an action", () => {
      const explicit = [opt("1", "One", { kind: "option" }), opt("2", "Two")];
      // "two" does not match option 1. Were a kind of "option" treated like an action, option 1 would be kept and listed last.
      expect(filterOptions(explicit, "two").map((o) => o.value)).toEqual(["2"]);
      expect(filterOptions(explicit, "one").map((o) => o.value)).toEqual(["1"]);
      expect(filterOptions(explicit, "zzz")).toEqual([]);
      expect(filterOptions(explicit, "").map((o) => o.value)).toEqual(["1", "2"]);
    });
  });

  describe("purity", () => {
    it("returns a new array that holds the same option objects", () => {
      const options = [...CATEGORIES, CREATE];
      const result = filterOptions(options, "");
      expect(result).not.toBe(options);
      result.forEach((option, index) => expect(option).toBe(options[index]));
      const none = filterOptions(options, "vacc");
      expect(none[0]).toBe(options[4]);
    });

    it("never mutates its input (deep-frozen options and array)", () => {
      const frozen = deepFreeze([...CATEGORIES.map((o) => ({ ...o })), { ...CREATE }]);
      const before = JSON.stringify(frozen);
      for (const query of ["", "a", "anti", "zzz", "first aid", ZWSP]) {
        expect(() => filterOptions(frozen, query)).not.toThrow();
      }
      expect(JSON.stringify(frozen)).toBe(before);
    });

    it("returns a result that can be changed without touching the input", () => {
      const options = [opt("1", "One"), opt("2", "Two")];
      const result = filterOptions(options, "");
      result.pop();
      expect(options).toHaveLength(2);
    });

    it("keeps working on options with missing or odd text (untyped callers)", () => {
      const odd = [{ value: "1" } as unknown as ComboboxOption, opt("2", "Two")];
      expect(filterOptions(odd, "two").map((o) => o.value)).toEqual(["2"]);
      expect(filterOptions(odd, "")).toHaveLength(2);
    });
  });

  describe("1,000 options", () => {
    const THOUSAND: ComboboxOption[] = Array.from({ length: 1000 }, (_, i) =>
      opt(`id-${i}`, `Category ${String(i).padStart(4, "0")} ${i % 7 === 0 ? "Refrigerated" : "Ambient"}`, {
        description: i % 100 === 0 ? "Check weekly" : undefined,
      })
    );
    const WITH_ACTION = [...THOUSAND, CREATE];

    it("empty query returns all of them, in order, plus the action last", () => {
      const result = filterOptions(WITH_ACTION, "");
      expect(result).toHaveLength(1001);
      expect(result[0]).toBe(THOUSAND[0]);
      expect(result[999]).toBe(THOUSAND[999]);
      expect(result[1000]).toBe(CREATE);
    });

    it("filters to exactly the options an independent count says it should", () => {
      const expected = THOUSAND.filter((_, i) => i % 7 === 0).length;
      expect(filterOptions(WITH_ACTION, "refrigerated")).toHaveLength(expected + 1);
      expect(filterOptions(WITH_ACTION, "category 0123").map((o) => o.value)).toEqual(["id-123", "__new__"]);
      expect(filterOptions(WITH_ACTION, "check weekly")).toHaveLength(10 + 1);
      expect(filterOptions(WITH_ACTION, "refrigerated check")).toHaveLength(Math.ceil(1000 / 700) + 1); // multiples of 700: 0, 700 -> 2 items
    });

    it("folds each option once per pass, however many words the query has (linear work, counted, not timed)", () => {
      // foldForSearch normalizes exactly once per call, so the number of String.prototype.normalize calls is the number of
      // folds: one for the query plus one per regular option. A fold per option AND per word (quadratic-ish) would be 3,000.
      const normalize = vi.spyOn(String.prototype, "normalize");
      foldForSearch("Probe");
      const callsPerFold = normalize.mock.calls.length; // sanity: the spy sees a fold, and a fold normalizes once
      normalize.mockClear();
      filterOptions(WITH_ACTION, "category refrigerated check");
      const folds = normalize.mock.calls.length;
      normalize.mockRestore();
      expect(callsPerFold).toBe(1);
      expect(folds).toBeLessThanOrEqual(1 + 1000);
    });

    it("stays fast: 200 filter passes over 1,000 options (about 100 ms here; the bound only catches a large slowdown)", () => {
      const queries = ["c", "ca", "cat", "cate", "categ", "refrig", "ambient 9", "0999", "check weekly", "zzzz"];
      const started = performance.now();
      for (let round = 0; round < 20; round += 1) {
        for (const query of queries) filterOptions(WITH_ACTION, query);
      }
      expect(performance.now() - started).toBeLessThan(1000);
    });
  });

  describe("property: against an independent oracle (seeded random options and queries)", () => {
    const WORDS = [
      "Anti",
      "biotics",
      "First",
      "Aid",
      "Pain",
      "Relief",
      "Vaccine",
      "CAFÉ",
      "café",
      `cafe${COMBINING_ACUTE}`,
      "µg",
      `${GREEK_MU}g`,
      "N-95",
      "(box)",
      "Ａｌｐｈａ",
      `a${ZWSP}b`,
      "x",
      "12",
      "",
    ];
    const SEPARATORS = [" ", "  ", "\t", NBSP, " - ", ""];

    function sentence(random: () => number, max: number): string {
      const count = Math.floor(random() * (max + 1));
      let out = "";
      for (let i = 0; i < count; i += 1) {
        out += WORDS[Math.floor(random() * WORDS.length)] + SEPARATORS[Math.floor(random() * SEPARATORS.length)];
      }
      return out;
    }

    // The oracle shares only the folding (tested above) and is otherwise written the naive way.
    function oracle(options: readonly ComboboxOption[], query: string): ComboboxOption[] {
      const terms = foldForSearch(query).split(" ").filter((t) => t !== "");
      const regular = options.filter((o) => o.kind !== "action");
      const actions = options.filter((o) => o.kind === "action");
      const kept = regular.filter((o) => {
        const hay = foldForSearch(`${o.label} ${o.description ?? ""}`);
        for (const term of terms) if (hay.indexOf(term) === -1) return false;
        return true;
      });
      return [...kept, ...actions];
    }

    it("matches the oracle on 600 random cases and keeps its structural promises", () => {
      const random = rng(20260511);
      for (let caseNo = 0; caseNo < 600; caseNo += 1) {
        const size = Math.floor(random() * 31);
        const options: ComboboxOption[] = Array.from({ length: size }, (_, i) => {
          const base = opt(`v${i}`, sentence(random, 4));
          if (random() < 0.4) base.description = sentence(random, 3);
          if (random() < 0.12) base.kind = "action";
          return base;
        });
        const query = sentence(random, 3);
        const snapshot = JSON.stringify(options);

        const result = filterOptions(options, query);

        expect(result, `case ${caseNo}`).toEqual(oracle(options, query));
        expect(JSON.stringify(options), `case ${caseNo}: input changed`).toBe(snapshot);
        // actions: all present, all last, in input order
        const actions = options.filter((o) => o.kind === "action");
        expect(result.slice(result.length - actions.length)).toEqual(actions);
        // everything returned is one of the inputs (same object), nothing duplicated
        expect(new Set(result).size).toBe(result.length);
        for (const option of result) expect(options.includes(option)).toBe(true);
        // an empty-looking query keeps every option
        if (foldForSearch(query) === "") expect(result).toHaveLength(options.length);
      }
    });
  });
});

// ── Agreement with the Inventory search ─────────────────────────────────────────

describe("search folding agrees with lib/inventory-view.ts", () => {
  function itemNamed(name: string): Medication {
    return {
      id: 1,
      name,
      barcode: "",
      photo_url: null,
      stock: 1,
      threshold: 1,
      vendor_url: null,
      unit: "units",
      notes: null,
      category_id: null,
      supplier_order_number: null,
      is_unnamed: false,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
  }

  const LABELS = [
    "Amoxicillin 500 mg, capsules",
    `Ibuprofen 200 ${MICRO_SIGN}g`,
    `Caf${E_ACUTE} au lait`,
    "Cafe",
    `${LIGATURE_FI}ne bandages`,
    `${SQUARE_MG} strength`,
    `${FULLWIDTH_ABC} gloves`,
    `Anti${ZWSP}biotics`,
    `First${NBSP}Aid  kit`,
    "N-95 (masks)",
    "",
  ];
  const QUERIES = [
    "",
    "   ",
    ZWSP,
    "amox",
    "AMOX",
    "500 mg",
    "mg 500",
    "mg zzz",
    `${MICRO_SIGN}g`,
    `${GREEK_MU}g`,
    "cafe",
    `caf${E_ACUTE}`,
    `cafe${COMBINING_ACUTE}`,
    "fi",
    "fine band",
    "mg",
    "abc",
    "antibiotics",
    `anti${SOFT_HYPHEN}bio`,
    "first aid",
    "aid  first",
    "(masks)",
    "n-95",
    "zzz",
  ];

  it("keeps and drops exactly the same labels as the Inventory search does for the same text", () => {
    for (const label of LABELS) {
      for (const query of QUERIES) {
        const here = filterOptions([opt("v", label)], query).length === 1;
        const there = matchesSearch(itemNamed(label), query);
        expect(here, `label ${JSON.stringify(label)} query ${JSON.stringify(query)}`).toBe(there);
      }
    }
  });
});

// ── moveActive ──────────────────────────────────────────────────────────────────

describe("moveActive", () => {
  it.each([
    // current, count, key, expected
    [-1, 5, "ArrowDown", 0],
    [-1, 5, "ArrowUp", 4],
    [0, 5, "ArrowDown", 1],
    [3, 5, "ArrowDown", 4],
    [4, 5, "ArrowDown", 0], // wraps at the end
    [4, 5, "ArrowUp", 3],
    [1, 5, "ArrowUp", 0],
    [0, 5, "ArrowUp", 4], // wraps at the start
    [-1, 5, "Home", 0],
    [3, 5, "Home", 0],
    [-1, 5, "End", 4],
    [0, 5, "End", 4],
    [2, 5, "End", 4],
    [0, 1, "ArrowDown", 0],
    [0, 1, "ArrowUp", 0],
    [-1, 1, "ArrowDown", 0],
    [-1, 1, "ArrowUp", 0],
    [0, 1, "Home", 0],
    [0, 1, "End", 0],
  ] as const)("moveActive(%i, %i, %s) = %i", (current, count, key, expected) => {
    expect(moveActive(current, count, key)).toBe(expected);
  });

  it("an empty list always gives -1", () => {
    for (const key of KEYS) {
      for (const current of [-1, 0, 3]) expect(moveActive(current, 0, key)).toBe(-1);
    }
  });

  it("a count that is not a positive integer gives -1", () => {
    for (const count of [-1, -100, 0.5, 2.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const key of KEYS) expect(moveActive(0, count, key)).toBe(-1);
    }
  });

  it("a current that is not a valid index counts as none", () => {
    // too large: stale after the list got shorter
    expect(moveActive(9, 3, "ArrowDown")).toBe(0);
    expect(moveActive(9, 3, "ArrowUp")).toBe(2);
    expect(moveActive(3, 3, "ArrowDown")).toBe(0);
    // negative, fractional, NaN, infinite
    for (const current of [-2, -100, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(moveActive(current, 4, "ArrowDown")).toBe(0);
      expect(moveActive(current, 4, "ArrowUp")).toBe(3);
    }
  });

  it("a key that is not one of the four leaves the highlight where it is (untyped callers); a stale or missing one stays none", () => {
    const unknown = "PageDown" as ActiveKey;
    expect(moveActive(2, 5, unknown)).toBe(2);
    expect(moveActive(0, 5, unknown)).toBe(0);
    expect(moveActive(4, 5, unknown)).toBe(4);
    expect(moveActive(-1, 5, unknown)).toBe(-1);
    expect(moveActive(9, 5, unknown)).toBe(-1); // too large for this list: counts as none
    expect(moveActive(2, 0, unknown)).toBe(-1); // an empty list has nothing to highlight
  });

  it("always returns -1 or a valid index, for every count, current and key (exhaustive sweep)", () => {
    const currents = [-3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (let count = 0; count <= 12; count += 1) {
      for (const current of currents) {
        for (const key of KEYS) {
          const result = moveActive(current, count, key);
          const label = `moveActive(${current}, ${count}, ${key}) = ${result}`;
          expect(Number.isInteger(result), label).toBe(true);
          if (count === 0) expect(result, label).toBe(-1);
          else {
            expect(result, label).toBeGreaterThanOrEqual(0);
            expect(result, label).toBeLessThan(count);
          }
        }
      }
    }
  });

  it("pressing ArrowDown count times from none visits every option once, and wraps to the first", () => {
    for (const count of [1, 2, 3, 7, 12, 1000]) {
      const visited: number[] = [];
      let current = -1;
      for (let step = 0; step < count; step += 1) {
        current = moveActive(current, count, "ArrowDown");
        visited.push(current);
      }
      expect(visited).toEqual(Array.from({ length: count }, (_, i) => i));
      expect(moveActive(current, count, "ArrowDown")).toBe(0);
    }
  });

  it("pressing ArrowUp count times from none visits every option once, from the last to the first", () => {
    for (const count of [1, 2, 5, 12]) {
      const visited: number[] = [];
      let current = -1;
      for (let step = 0; step < count; step += 1) {
        current = moveActive(current, count, "ArrowUp");
        visited.push(current);
      }
      expect(visited).toEqual(Array.from({ length: count }, (_, i) => count - 1 - i));
      expect(moveActive(current, count, "ArrowUp")).toBe(count - 1);
    }
  });

  it("ArrowDown followed by ArrowUp comes back to where it started", () => {
    for (const count of [1, 2, 3, 9]) {
      for (let current = 0; current < count; current += 1) {
        expect(moveActive(moveActive(current, count, "ArrowDown"), count, "ArrowUp")).toBe(current);
      }
    }
  });
});

// ── findOptionByValue / initialActiveIndex / singleMatchIndex / resultsMessage ─────

describe("findOptionByValue", () => {
  const options = [opt("", "Uncategorized"), opt("1", "One"), opt("1", "Duplicate of one"), action("__new__", "+ Create")];

  it('finds the option for "" (a legitimate value)', () => {
    expect(findOptionByValue(options, "")).toBe(options[0]);
  });

  it("returns the first of several options with the same value", () => {
    expect(findOptionByValue(options, "1")).toBe(options[1]);
  });

  it("finds an action by its value too", () => {
    expect(findOptionByValue(options, "__new__")).toBe(options[3]);
  });

  it("returns undefined when there is none, also for an empty list", () => {
    expect(findOptionByValue(options, "nope")).toBeUndefined();
    expect(findOptionByValue([], "")).toBeUndefined();
  });
});

describe("initialActiveIndex", () => {
  const results = [opt("a", "A"), opt("b", "B"), action("n", "New")];

  it("is the position of the selected option in the listed results", () => {
    expect(initialActiveIndex(results, results[0])).toBe(0);
    expect(initialActiveIndex(results, results[1])).toBe(1);
    expect(initialActiveIndex(results, results[2])).toBe(2);
  });

  it("is -1 with no selection or when the selection is not listed", () => {
    expect(initialActiveIndex(results, undefined)).toBe(-1);
    expect(initialActiveIndex(results, opt("a", "A"))).toBe(-1); // equal text, different object: not the listed option
    expect(initialActiveIndex([], results[0])).toBe(-1);
  });
});

describe("singleMatchIndex", () => {
  it("is the index of the only regular option", () => {
    expect(singleMatchIndex([opt("1", "One")])).toBe(0);
    expect(singleMatchIndex([opt("1", "One"), action("n", "New")])).toBe(0);
    expect(singleMatchIndex([action("n", "New"), opt("1", "One")])).toBe(1);
  });

  it("is -1 with none, with only actions, or with several regular options", () => {
    expect(singleMatchIndex([])).toBe(-1);
    expect(singleMatchIndex([action("n", "New")])).toBe(-1);
    expect(singleMatchIndex([opt("1", "One"), opt("2", "Two")])).toBe(-1);
    expect(singleMatchIndex([opt("1", "One"), opt("2", "Two"), action("n", "New")])).toBe(-1);
  });
});

describe("resultsMessage", () => {
  it("says how many results, with the singular for one", () => {
    expect(resultsMessage([opt("1", "One")], "No matches")).toBe("1 result");
    expect(resultsMessage([opt("1", "One"), opt("2", "Two")], "No matches")).toBe("2 results");
    expect(resultsMessage(Array.from({ length: 1000 }, (_, i) => opt(String(i), `L${i}`)), "No matches")).toBe("1000 results");
  });

  it("says the empty text when nothing matched", () => {
    expect(resultsMessage([], "No matches")).toBe("No matches");
    expect(resultsMessage([], "No category found")).toBe("No category found");
  });

  it("does not count actions as results", () => {
    expect(resultsMessage([action("n", "+ Create")], "No matches")).toBe("No matches");
    expect(resultsMessage([opt("1", "One"), action("n", "+ Create")], "No matches")).toBe("1 result");
    expect(resultsMessage([opt("1", "One"), opt("2", "Two"), action("n", "+ Create")], "No matches")).toBe("2 results");
  });
});

// ── placePopup ──────────────────────────────────────────────────────────────────

describe("placePopup", () => {
  const DESKTOP: ViewportBox = { left: 0, top: 0, width: 1280, height: 800, layoutHeight: 800 };

  it("opens below the input with the full preferred height when there is room", () => {
    const p = placePopup({ top: 100, left: 200, bottom: 144, width: 400 }, DESKTOP);
    expect(p).toEqual({ side: "below", left: 200, width: 400, top: 148, bottom: null, maxHeight: 258 });
  });

  it("shrinks to the room below when that is still comfortable", () => {
    const p = placePopup({ top: 500, left: 0, bottom: 544, width: 300 }, DESKTOP); // 800 - 544 - 4 - 8 = 244
    expect(p.side).toBe("below");
    expect(p.maxHeight).toBe(244);
  });

  it("flips above when there is little room below and more above", () => {
    const p = placePopup({ top: 700, left: 100, bottom: 744, width: 300 }, DESKTOP); // below: 44, above: 688
    expect(p.side).toBe("above");
    expect(p.top).toBeNull();
    expect(p.bottom).toBe(800 - 700 + 4);
    expect(p.maxHeight).toBe(258);
  });

  it("stays below when there is little room on both sides but more below", () => {
    const tiny: ViewportBox = { left: 0, top: 0, width: 360, height: 200, layoutHeight: 200 };
    const p = placePopup({ top: 20, left: 16, bottom: 64, width: 328 }, tiny); // below 124, above 8
    expect(p.side).toBe("below");
    expect(p.maxHeight).toBe(124);
  });

  describe("which side (the comfortable height is 200px)", () => {
    // Desktop: 800 tall, an input 44 tall. Below the input there is `800 - bottom - 12` (gap 4 + margin 8) and above it `top - 12`.
    const at = (bottom: number) => placePopup({ top: bottom - 44, left: 100, bottom, width: 300 }, DESKTOP);

    it("opens below when the room below is exactly the comfortable 200px, even though there is more above", () => {
      const p = at(588); // below 200, above 532
      expect(p.side).toBe("below");
      expect(p.maxHeight).toBe(200);
    });

    it("opens above when the room below is one pixel short of that and there is more above", () => {
      const p = at(589); // below 199, above 533
      expect(p.side).toBe("above");
      expect(p.maxHeight).toBe(258);
    });

    it("opens above with about 150px below and far more above (150 is not comfortable)", () => {
      const p = at(638); // below 150, above 582
      expect(p.side).toBe("above");
      expect(p.bottom).toBe(800 - 594 + 4);
    });

    it("opens below with about 250px below even when there is more above", () => {
      const p = at(538); // below 250, above 482
      expect(p.side).toBe("below");
      expect(p.maxHeight).toBe(250);
    });

    it("opens below on a tie when neither side is comfortable", () => {
      const short: ViewportBox = { left: 0, top: 0, width: 360, height: 200, layoutHeight: 200 };
      const p = placePopup({ top: 78, left: 16, bottom: 122, width: 328 }, short); // below 66, above 66
      expect(p.side).toBe("below");
      expect(p.maxHeight).toBe(66);
    });
  });

  describe("on a short screen (phone in landscape, on-screen keyboard up)", () => {
    it("shrinks to the room that is left, so the popup ends at the margin instead of running off the screen", () => {
      const phone: ViewportBox = { left: 0, top: 0, width: 360, height: 180, layoutHeight: 180 };
      const p = placePopup({ top: 68, left: 16, bottom: 112, width: 328 }, phone); // below 56, above 56: a tie, so below
      expect(p.side).toBe("below");
      expect(p.maxHeight).toBe(56);
      expect((p.top ?? 0) + p.maxHeight).toBe(180 - 8); // bottom edge exactly at the margin
    });

    it("shrinks above the input too: the popup's top edge stays inside the screen", () => {
      const landscape: ViewportBox = { left: 0, top: 0, width: 800, height: 220, layoutHeight: 220 };
      const p = placePopup({ top: 130, left: 24, bottom: 174, width: 448 }, landscape); // below 34, above 118
      expect(p.side).toBe("above");
      expect(p.maxHeight).toBe(118);
      const popupTop = landscape.layoutHeight - (p.bottom ?? 0) - p.maxHeight;
      expect(popupTop).toBe(8); // top edge exactly at the margin
    });

    it("keeps working in the visible area of a pinch-zoomed or keyboard-covered page (offset visible area)", () => {
      const visible: ViewportBox = { left: 0, top: 300, width: 360, height: 180, layoutHeight: 900 };
      const p = placePopup({ top: 368, left: 16, bottom: 412, width: 328 }, visible); // below: 300+180-412-12 = 56
      expect(p.side).toBe("below");
      expect(p.maxHeight).toBe(56);
      expect((p.top ?? 0) + p.maxHeight).toBeLessThanOrEqual(300 + 180 - 8);
    });

    it("measures the room above from the top of the visible area, not from the top of the layout", () => {
      const visible: ViewportBox = { left: 0, top: 300, width: 360, height: 180, layoutHeight: 900 };
      const p = placePopup({ top: 380, left: 16, bottom: 424, width: 328 }, visible); // below 44, above 68
      expect(p.side).toBe("above");
      expect(p.maxHeight).toBe(68);
      expect(900 - (p.bottom ?? 0) - p.maxHeight).toBe(300 + 8); // the popup's top edge: the visible area's top plus the margin
    });

    it("never goes under the minimum height (default 48, about one row), so with no room at all it overhangs by the missing amount only", () => {
      const tiny: ViewportBox = { left: 0, top: 0, width: 360, height: 100, layoutHeight: 100 };
      const p = placePopup({ top: 10, left: 16, bottom: 54, width: 328 }, tiny); // below 34, above -2
      expect(p.side).toBe("below");
      expect(p.maxHeight).toBe(48);
      const overhang = (p.top ?? 0) + p.maxHeight - (100 - 8);
      expect(overhang).toBe(48 - 34);
    });

    it("the minimum height can be changed, and is never taller than the preferred height", () => {
      const tiny: ViewportBox = { left: 0, top: 0, width: 360, height: 100, layoutHeight: 100 };
      expect(placePopup({ top: 10, left: 16, bottom: 54, width: 328 }, tiny, { minHeight: 80 }).maxHeight).toBe(80);
      expect(placePopup({ top: 10, left: 16, bottom: 54, width: 328 }, tiny, { minHeight: 500, preferredHeight: 120 }).maxHeight).toBe(120);
    });
  });

  it("uses the visible area (on-screen keyboard up): the keyboard hides the lower part of the layout viewport", () => {
    // layout viewport 800 tall, keyboard covers the bottom 400px: the visible area is 400 tall
    const withKeyboard: ViewportBox = { left: 0, top: 0, width: 360, height: 400, layoutHeight: 800 };
    const p = placePopup({ top: 300, left: 16, bottom: 344, width: 328 }, withKeyboard); // below 44, above 288
    expect(p.side).toBe("above");
    expect(p.bottom).toBe(800 - 300 + 4); // measured from the LAYOUT viewport's bottom edge
    expect(p.maxHeight).toBe(258);
  });

  it("respects the offset of the visible area (pinch-zoom)", () => {
    const zoomed: ViewportBox = { left: 100, top: 300, width: 400, height: 300, layoutHeight: 800 };
    const p = placePopup({ top: 320, left: 120, bottom: 364, width: 200 }, zoomed); // below: 300+300-364-12 = 224
    expect(p.side).toBe("below");
    expect(p.maxHeight).toBe(224);
    expect(p.left).toBe(120);
  });

  it("matches the input's width but never gets narrower than the minimum", () => {
    expect(placePopup({ top: 0, left: 10, bottom: 44, width: 120 }, DESKTOP).width).toBe(192);
    expect(placePopup({ top: 0, left: 10, bottom: 44, width: 400 }, DESKTOP).width).toBe(400);
    expect(placePopup({ top: 0, left: 10, bottom: 44, width: 120 }, DESKTOP, { minWidth: 0 }).width).toBe(120);
  });

  it("pulls the popup back inside the viewport on the right", () => {
    const phone: ViewportBox = { left: 0, top: 0, width: 360, height: 640, layoutHeight: 640 };
    const p = placePopup({ top: 100, left: 250, bottom: 144, width: 100 }, phone); // 192 wide from 250 would end at 442
    expect(p.width).toBe(192);
    expect(p.left).toBe(360 - 8 - 192);
    expect(p.left + p.width).toBeLessThanOrEqual(360 - 8);
  });

  it("pulls the popup back inside the viewport on the left", () => {
    const p = placePopup({ top: 100, left: -50, bottom: 144, width: 300 }, DESKTOP);
    expect(p.left).toBe(8);
  });

  it("is never wider than the viewport allows", () => {
    const phone: ViewportBox = { left: 0, top: 0, width: 360, height: 640, layoutHeight: 640 };
    const p = placePopup({ top: 100, left: 0, bottom: 144, width: 800 }, phone);
    expect(p.width).toBe(344);
    expect(p.left).toBe(8);
  });

  it("does not change its inputs", () => {
    const anchor = deepFreeze({ top: 700, left: 100, bottom: 744, width: 300 });
    const viewport = deepFreeze({ ...DESKTOP });
    const options = deepFreeze({ gap: 2 });
    expect(() => placePopup(anchor, viewport, options)).not.toThrow();
  });

  it("always yields a usable box: finite numbers, a positive width and height, exactly one of top and bottom, and a popup inside the visible area whenever the room allows it", () => {
    const random = rng(7);
    for (let i = 0; i < 500; i += 1) {
      const viewport: ViewportBox = {
        left: Math.floor(random() * 50),
        top: Math.floor(random() * 300),
        width: 200 + Math.floor(random() * 1200),
        height: 100 + Math.floor(random() * 900),
        layoutHeight: 0,
      };
      viewport.layoutHeight = viewport.top + viewport.height + Math.floor(random() * 400);
      const top = Math.floor(random() * 1000) - 100;
      const anchor = { top, bottom: top + 30 + Math.floor(random() * 30), left: Math.floor(random() * 1300) - 50, width: 40 + Math.floor(random() * 700) };
      const p = placePopup(anchor, viewport);
      for (const n of [p.left, p.width, p.maxHeight]) expect(Number.isFinite(n)).toBe(true);
      expect(p.width).toBeGreaterThan(0);
      expect(p.maxHeight).toBeGreaterThanOrEqual(48);
      expect(p.maxHeight).toBeLessThanOrEqual(258);
      expect((p.top === null) !== (p.bottom === null)).toBe(true);
      expect(p.side === "below" ? p.top !== null : p.bottom !== null).toBe(true);
      expect(p.left).toBeGreaterThanOrEqual(viewport.left + 8 - 1e-9);
      expect(p.left + p.width).toBeLessThanOrEqual(viewport.left + viewport.width - 8 + 1e-9);

      // Vertical fit. `room` is the space on the chosen side after the gap (4) and the margin (8). With room for the minimum
      // height (48) the popup lies inside the visible area, margin included; with less it overhangs by exactly the shortfall.
      const visibleTop = viewport.top;
      const visibleBottom = viewport.top + viewport.height;
      const room = p.side === "below" ? visibleBottom - anchor.bottom - 12 : anchor.top - visibleTop - 12;
      const popupTop = p.side === "below" ? (p.top ?? 0) : viewport.layoutHeight - (p.bottom ?? 0) - p.maxHeight;
      const popupBottom = popupTop + p.maxHeight;
      const overhang = p.side === "below" ? popupBottom - (visibleBottom - 8) : visibleTop + 8 - popupTop;
      if (room >= 48) {
        expect(p.maxHeight).toBe(Math.min(258, room));
        expect(overhang).toBeLessThanOrEqual(1e-9);
      } else {
        expect(p.maxHeight).toBe(48);
        expect(overhang).toBeCloseTo(48 - room, 9);
      }
    }
  });
});

// ── repeatClickGuard ────────────────────────────────────────────────────────────

describe("repeatClickGuard", () => {
  const TYPES = ["mousedown", "mouseup", "click", "dblclick"] as const;
  type Step = readonly [type: (typeof TYPES)[number], detail: number];

  /** Feeds a sequence of pointer events through the guard, as the page listener does; returns what it did with each. */
  function run(sequence: readonly Step[], armed = true) {
    const swallowed: boolean[] = [];
    let state = armed;
    for (const [type, detail] of sequence) {
      const step = repeatClickGuard(state, type, detail);
      swallowed.push(step.swallow);
      state = step.armed;
    }
    return { swallowed, armed: state };
  }

  it("never swallows anything while it is not armed", () => {
    for (const type of TYPES) {
      for (const detail of [0, 1, 2, 3, 10]) {
        expect(repeatClickGuard(false, type, detail), `${type} ${detail}`).toEqual({ swallow: false, armed: false });
      }
    }
  });

  it("swallows every event of a multi-click (a click count above 1) and stays armed", () => {
    for (const type of TYPES) {
      for (const detail of [2, 3, 4, 100]) {
        expect(repeatClickGuard(true, type, detail), `${type} ${detail}`).toEqual({ swallow: true, armed: true });
      }
    }
  });

  it("a mousedown that counts as a first click starts a new sequence: it goes through and ends the guard", () => {
    expect(repeatClickGuard(true, "mousedown", 1)).toEqual({ swallow: false, armed: false });
    expect(repeatClickGuard(true, "mousedown", 0)).toEqual({ swallow: false, armed: false });
  });

  it("any other event that counts as a first click, or has no count (a keyboard click), goes through and leaves the guard armed", () => {
    for (const type of ["mouseup", "click", "dblclick"] as const) {
      for (const detail of [0, 1]) {
        expect(repeatClickGuard(true, type, detail), `${type} ${detail}`).toEqual({ swallow: false, armed: true });
      }
    }
  });

  it("a count that is not a number above 1 (NaN, negative) counts as a first click", () => {
    for (const detail of [Number.NaN, -1, -100, 0.5, 1]) {
      expect(repeatClickGuard(true, "click", detail)).toEqual({ swallow: false, armed: true });
      expect(repeatClickGuard(true, "mousedown", detail)).toEqual({ swallow: false, armed: false });
    }
  });

  it("the second click of a double-click that follows a pick is swallowed from its mousedown to its dblclick", () => {
    // The pick (click 1) is what armed the guard; the browser then reports the second click with a count of 2.
    const { swallowed, armed } = run([
      ["mousedown", 2],
      ["mouseup", 2],
      ["click", 2],
      ["dblclick", 2],
    ]);
    expect(swallowed).toEqual([true, true, true, true]);
    expect(armed).toBe(true);
  });

  it("a triple-click is swallowed to the end", () => {
    const { swallowed } = run([
      ["mousedown", 2],
      ["mouseup", 2],
      ["click", 2],
      ["dblclick", 2],
      ["mousedown", 3],
      ["mouseup", 3],
      ["click", 3],
    ]);
    expect(swallowed).toEqual([true, true, true, true, true, true, true]);
  });

  it("a deliberate double-click on another control right after a pick goes through, both clicks: the first mousedown ends the guard", () => {
    const { swallowed, armed } = run([
      ["mousedown", 1],
      ["mouseup", 1],
      ["click", 1],
      ["mousedown", 2],
      ["mouseup", 2],
      ["click", 2],
      ["dblclick", 2],
    ]);
    expect(swallowed).toEqual([false, false, false, false, false, false, false]);
    expect(armed).toBe(false);
  });

  it("a late second click (counted as a new first click) goes through, and so does the double-click after it", () => {
    const { swallowed } = run([
      ["mousedown", 1],
      ["mouseup", 1],
      ["click", 1],
      ["mousedown", 2],
      ["mouseup", 2],
      ["click", 2],
    ]);
    expect(swallowed.every((value) => !value)).toBe(true);
  });

  it("property: over random event sequences it swallows exactly the multi-click events seen while armed, and never re-arms", () => {
    const random = rng(99);
    const counts = [0, 0, 1, 1, 1, 2, 2, 3, 4, Number.NaN, -1];
    for (let caseNo = 0; caseNo < 300; caseNo += 1) {
      const length = 1 + Math.floor(random() * 12);
      let armed = true;
      let everDisarmed = false;
      for (let i = 0; i < length; i += 1) {
        const type = TYPES[Math.floor(random() * TYPES.length)];
        const detail = counts[Math.floor(random() * counts.length)];
        const step = repeatClickGuard(armed, type, detail);
        expect(step.swallow, `case ${caseNo} step ${i}`).toBe(armed && detail > 1);
        expect(step.armed, `case ${caseNo} step ${i}`).toBe(armed && !(type === "mousedown" && !(detail > 1)));
        if (!step.armed) everDisarmed = true;
        if (everDisarmed) expect(step.armed).toBe(false);
        armed = step.armed;
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  BARCODE_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
  MAX_JSON_BODY_BYTES,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  PHOTO_URL_MAX_LENGTH,
  SUPPLIER_ORDER_NUMBER_MAX_LENGTH,
  UNIT_MAX_LENGTH,
  VENDOR_URL_MAX_LENGTH,
  exceedsLength,
} from "@/lib/limits";
import { SUPPLIER_ORDER_NUMBER_MAX_LENGTH as FROM_SUPPLIER_MODULE } from "@/lib/supplier-order-number";

const EMOJI = "\u{1F48A}"; // one character, two UTF-16 units
const ASTRAL_PAIR = "\u{1D11E}\u{1D11E}"; // two characters, four UTF-16 units

describe("the size limits", () => {
  it("are the values the owner asked for", () => {
    expect([BARCODE_MAX_LENGTH, NAME_MAX_LENGTH, NOTES_MAX_LENGTH, VENDOR_URL_MAX_LENGTH, PHOTO_URL_MAX_LENGTH, UNIT_MAX_LENGTH]).toEqual([
      1024, 300, 5000, 2048, 2048, 40,
    ]);
    expect([CATEGORY_NAME_MAX_LENGTH, SUPPLIER_ORDER_NUMBER_MAX_LENGTH, MAX_JSON_BODY_BYTES]).toEqual([60, 64, 1_000_000]);
  });

  it("keep the supplier order number limit importable from where it was, so nothing that used it breaks", () => {
    expect(FROM_SUPPLIER_MODULE).toBe(SUPPLIER_ORDER_NUMBER_MAX_LENGTH);
  });
});

describe("exceedsLength (characters, not UTF-16 units)", () => {
  it.each([
    ["an empty string", "", 5, false],
    ["exactly the limit", "abcde", 5, false],
    ["one over the limit", "abcdef", 5, true],
    ["emoji at the limit (10 units, 5 characters)", EMOJI.repeat(5), 5, false],
    ["one emoji over the limit", EMOJI.repeat(6), 5, true],
    ["astral characters at the limit", ASTRAL_PAIR, 2, false],
    ["astral characters one over", `${ASTRAL_PAIR}${ASTRAL_PAIR}`, 3, true],
    ["a string far longer than twice the limit (decided without counting)", "x".repeat(1_000_000), 5, true],
    ["a lone surrogate counts as one character", "\ud83d", 1, false],
    ["accents written as two code points count as two", "é".repeat(3), 5, true],
  ])("%s", (_label, text, max, expected) => {
    expect(exceedsLength(text, max)).toBe(expected);
  });

  it("gives the same answer as counting the characters one by one, around every boundary", () => {
    const parts = ["a", EMOJI, "é", "\u{1D11E}", "日"];
    for (let length = 0; length <= 12; length += 1) {
      for (const part of parts) {
        const text = part.repeat(length);
        for (const max of [0, 1, 2, 5, 6, 11, 12, 13]) {
          expect(exceedsLength(text, max), `${JSON.stringify(text)} against ${max}`).toBe(Array.from(text).length > max);
        }
      }
    }
  });
});

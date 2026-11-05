// One rule for "this text must read the same on screen and on the printed sheet", shared by every field that is
// validated this way (supplier order numbers, category names).
//
// The rule is stated with Unicode properties, not with a list of code point ranges. A list has to be complete to be
// safe, and the earlier hand-written lists were not: one stopped at U+2064 and let the bidi isolates U+2066-U+2069
// through together with about 150 other invisible characters; the other stopped at U+2069 and missed U+206A-U+206F.
// A character is rejected when it is
//   Cc                            a control character: NUL, tab, line feed, carriage return, DEL, the C1 range
//   Cf                            a format character: zero-width space and joiners, direction marks, bidi embeddings,
//                                 overrides and isolates, soft hyphen, word joiner and the invisible operators,
//                                 Arabic letter mark, byte order mark, interlinear annotation, tag characters
//   Zl / Zp                       the line separator U+2028 / paragraph separator U+2029
//   Default_Ignorable_Code_Point  anything else a renderer is told not to draw: the combining grapheme joiner, the
//                                 Hangul and Khmer fillers, and the reserved code points inside the format blocks
// Variation selectors are also Default_Ignorable but stay allowed: an emoji needs U+FE0F to be drawn as an emoji.
// Ordinary spaces (including the no-break and ideographic space) are visible spacing and are not touched here.
//
// Written as property escapes (no \u escapes) so no tool can mangle the characters. The regexes have no `g` or `y`
// flag, so `.test()` keeps no state between calls.

const INVISIBLE_OR_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const VARIATION_SELECTOR = /\p{Variation_Selector}/u;

/** True when `text` contains a control, format, separator or other invisible character (variation selectors excepted). */
export function hasInvisibleOrControlCharacter(text: string): boolean {
  for (const ch of text) {
    if (INVISIBLE_OR_CONTROL.test(ch) && !VARIATION_SELECTOR.test(ch)) return true;
  }
  return false;
}

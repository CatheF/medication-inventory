// Two rules about characters that are not drawn, kept side by side because they answer different questions and must not be
// confused (they differ on purpose, see "The two rules" below).
//
//   hasInvisibleOrControlCharacter   VALIDATION: "must this text be refused?" One rule for "this text must read the same on
//                                    screen and on the printed sheet", shared by every field that is validated this way
//                                    (supplier order numbers, category names).
//   stripInvisibleCharacters         SEARCH AND DISPLAY: "what does a person see in this text?" The characters that render as
//                                    nothing are dropped before text is compared, searched or quoted back (the Inventory and
//                                    Admin search, the combobox search, the filter chips and the summary line).
//
// ── hasInvisibleOrControlCharacter ───────────────────────────────────────────────────────────────────────────────
// The rule is stated with Unicode properties, not with a list of code point ranges. A list has to be complete to be
// safe, and hand-written lists are easy to get wrong: one that stops at U+2064 lets the bidi isolates U+2066-U+2069
// through together with about 150 other invisible characters; one that stops at U+2069 misses U+206A-U+206F.
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
// ── stripInvisibleCharacters ─────────────────────────────────────────────────────────────────────────────────────
// Removes every Cf (format) character and every Default_Ignorable_Code_Point. Nothing else: control characters (Cc), the
// line and paragraph separators (Zl, Zp), ordinary and exotic spaces and U+2800 (Braille blank) stay, because they are
// whitespace or visible text for a search. Variation selectors ARE removed here (they are Default_Ignorable): a search for
// "heart" must find "heart" followed by U+FE0F, and a pasted blank made of nothing but selectors is no search.
//
// ── The two rules ────────────────────────────────────────────────────────────────────────────────────────────────
//                        Cc  Zl/Zp  Cf   Default_Ignorable   Variation selectors (U+FE0F and the rest)
//   refuse (validation)  yes  yes   yes  yes                 NO, allowed (emoji presentation)
//   drop (search)        no   no    yes  yes                 YES, dropped
// So U+FE0F is accepted in a stored name or code and ignored when searching for it; a tab or a line break is refused when
// saving and is kept (as whitespace) when searching. Do not merge the two.
//
// Written as property escapes (no \u escapes) so no tool can mangle the characters. The validation regexes have no `g` or
// `y` flag, so `.test()` keeps no state between calls. The strip regex has `g` and is only ever used with
// String.prototype.replace, which starts from the beginning every time, so it keeps no state either.

const INVISIBLE_OR_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const VARIATION_SELECTOR = /\p{Variation_Selector}/u;
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/** True when `text` contains a control, format, separator or other invisible character (variation selectors excepted). */
export function hasInvisibleOrControlCharacter(text: string): boolean {
  for (const ch of text) {
    if (INVISIBLE_OR_CONTROL.test(ch) && !VARIATION_SELECTOR.test(ch)) return true;
  }
  return false;
}

/**
 * `text` without the characters that render as nothing: every format (Cf) character (zero-width space, joiners and non-joiner,
 * soft hyphen, word joiner, direction marks, bidi embeddings, overrides and isolates, byte order mark, tag characters) and every
 * other Default_Ignorable_Code_Point (variation selectors, the combining grapheme joiner, Hangul and Khmer fillers). Text pasted
 * from web pages, PDFs, chat apps and email carries them. Everything else is left exactly as it was: whitespace, control
 * characters, letters, combining accents. The result is never longer than the input, and a string without such characters is
 * returned unchanged.
 */
export function stripInvisibleCharacters(text: string): string {
  return text.replace(INVISIBLE, "");
}

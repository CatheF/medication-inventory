// How text typed into a search box is cleaned for display and folded for comparison. Pure: no React, no DOM, no fetch.
//
// ONE definition, used by the Inventory and Admin list searches (lib/inventory-view.ts, which the order sheet's item search
// calls too), by the filter chips under both search boxes (lib/filter-chips.ts) and by the Admin category picker
// (lib/combobox.ts). They cannot disagree about what matches or about what the person typed.
//
// Folding is for COMPARING search text. Nothing the person sees is rewritten, and it is never used to decide whether two
// things are the same thing: ids (lib/ids.ts) and category names (the duplicate check in app/api/categories/route.ts) are
// compared exactly, accents included, so "Crème" and "Creme" are two categories even though a search for one finds both.

import { stripInvisibleCharacters } from "./text-safety";

// Every combining mark, not only the Latin accents: the accents are the part that matters to this app (French-labelled
// products such as "Crème antiseptique" sit next to plain ones), and the rest is the same kind of thing (the voiced-sound
// marks of kana, the vowel signs of Indic scripts, Arabic and Hebrew vowel points). Searching ignores them too: it finds
// more, and for any text a person would type never less. The regex has the `g` flag and is only ever used with String.prototype.replace, which starts
// from the beginning every time, so it keeps no state between calls.
const COMBINING_MARKS = /\p{M}/gu;

/**
 * The form used to compare search text, applied to the typed search and to the searched text alike:
 *   1. invisible characters are dropped first, so an accent that one separated from its letter still composes;
 *   2. NFKC: canonical equivalence ("é" as one character equals "e" + combining accent) and compatibility forms
 *      (the micro sign and the Greek mu in "µg"/"μg", full-width letters, ligatures like "ﬁ", the one-character "㎎");
 *   3. lower case;
 *   4. accents out: NFD takes every letter apart into its base letter and its combining marks, and the marks are dropped, so
 *      "creme", "crème" and "cre" + a combining grave accent + "me" all become "creme";
 *   5. NFC puts back together what is not an accent. NFD also splits a Korean syllable block into its letters, and left
 *      split a search for 하 would find 한 (and every other block that starts with those two letters).
 * Whitespace is left alone: callers split on it or collapse it as they need. "" for something that is not text.
 *
 * What it does not do: letters that carry no combining mark are left as they are. That covers ligatures such as œ and æ, the
 * sharp s, the stroked o and l, and the Turkish dotless i, so "oeuvre" does not find "œuvre".
 */
export function foldSearchText(text: string): string {
  if (typeof text !== "string") return "";
  return stripInvisibleCharacters(text).normalize("NFKC").toLowerCase().normalize("NFD").replace(COMBINING_MARKS, "").normalize("NFC");
}

/**
 * The search as staff see it: invisible characters dropped, trimmed, inner whitespace collapsed to single spaces. Accents,
 * case and everything else stay as typed (full-width letters stay full-width, "Crème" stays "Crème").
 *
 * "" means "no search". That includes a search with nothing left to look for once it is folded: one made only of accents
 * (a lone combining accent, or a spacing accent such as "¨", which NFKC turns into a space plus an accent). So "a filter is
 * active" (the chip, the summary line, the empty-state message) and "the search has a term" (the match) never disagree: when
 * this is not empty at least one search term survives folding. The unit tests sweep every BMP character. Not treated as
 * invisible: C0/C1 control characters and U+2800 (Braille blank) still count as text.
 */
export function displaySearchText(search: unknown): string {
  if (typeof search !== "string") return "";
  const text = stripInvisibleCharacters(search).trim().replace(/\s+/g, " ");
  return /\S/u.test(foldSearchText(text)) ? text : "";
}

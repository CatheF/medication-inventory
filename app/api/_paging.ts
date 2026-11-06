// Reads EVERY row a list query matches. A plain module, not a route (App Router only serves `route.ts`).
//
// PostgREST caps a response at its max-rows setting (1000 by default, configurable per project), so a single query can
// silently return a partial list. Pages are requested until the data runs out. Used by every route that hands a whole
// list to the browser (the items and the categories), so none of them can quietly drop rows.
type Row = Record<string, unknown>;

export const PAGE_SIZE = 1000;
/** Safety limit: more than this many pages is refused with an error instead of a list that is silently short. */
export const MAX_PAGES = 50;

export type PageAnswer = { data: Row[] | null; error: unknown; count?: number | null };

/** Asks for rows `from` to `to` (both included); `withCount` asks for the exact total as well (only the first page does). */
export type ReadPage = (from: number, to: number, withCount: boolean) => PromiseLike<PageAnswer>;

export type AllRows = { ok: true; rows: Row[] } | { ok: false; error: unknown } | { ok: false; tooLarge: true };

/**
 * How the end is recognised:
 *   - the first page also asks for the exact total, and the loop stops once that many rows have been read;
 *   - an empty page always ends the loop (rows deleted while reading make the total overstate what is left);
 *   - a SHORT page never does. A page holds fewer than PAGE_SIZE rows whenever the server's cap is below PAGE_SIZE,
 *     so "short" cannot be told apart from "last". Without a total (a proxy that strips the count header) the empty
 *     page is therefore the only end marker, which costs one extra request instead of a silently truncated list.
 * The query must have a deterministic order (end with a unique column), or pages can overlap or skip rows.
 */
export async function readAllRows(readPage: ReadPage): Promise<AllRows> {
  const rows: Row[] = [];
  const seen = new Set<string>();
  let from = 0;
  let total: number | null = null;

  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) return { ok: false, tooLarge: true };

    const { data, error, count } = await readPage(from, from + PAGE_SIZE - 1, page === 0);
    if (error) return { ok: false, error };

    const batch: Row[] = data ?? [];
    if (page === 0 && typeof count === "number") total = count;

    for (const row of batch) {
      // Offset paging can repeat a row when data changes between pages; keep the first copy.
      if (row.id !== null && row.id !== undefined) {
        const key = String(row.id);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      rows.push(row);
    }

    from += batch.length;
    if (batch.length === 0) break;
    if (total !== null && from >= total) break;
  }
  return { ok: true, rows };
}

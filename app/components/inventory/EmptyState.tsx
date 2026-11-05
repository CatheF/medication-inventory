import type { EmptyKind } from "@/lib/inventory-view";
import { InboxIcon, SearchIcon } from "./Icons";

/**
 * The three different "nothing to show" cases, kept visibly apart:
 *   no-items        the inventory itself is empty
 *   category-empty  the chosen category (or Uncategorized) holds no items
 *   no-match        the search / stock / category filters match nothing
 * The text comes from describeEmpty() in lib/inventory-view.ts.
 */
export function EmptyState({ kind, title, detail }: { kind: EmptyKind; title: string; detail: string }) {
  return (
    <div
      data-testid="inventory-empty"
      data-empty-kind={kind}
      className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-center"
    >
      <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full bg-gray-100 text-gray-600">
        {kind === "no-match" ? <SearchIcon className="h-7 w-7" /> : <InboxIcon className="h-7 w-7" />}
      </div>
      <p className="text-lg leading-snug font-bold text-gray-900 [overflow-wrap:anywhere]">{title}</p>
      <p className="mx-auto mt-1.5 max-w-[52ch] text-base text-gray-600 [overflow-wrap:anywhere]">{detail}</p>
    </div>
  );
}

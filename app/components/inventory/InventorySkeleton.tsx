import type { Ref } from "react";

/**
 * Placeholder shown while the inventory is loading. It is a polite status region (so screen readers hear
 * "Loading inventory…") and can take focus after a retry.
 */
export function InventorySkeleton({ ref }: { ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      aria-busy="true"
      data-testid="inventory-loading"
      className="outline-none"
    >
      <span className="sr-only">Loading inventory…</span>
      <div aria-hidden="true" className="animate-pulse motion-reduce:animate-none">
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="mb-3 h-5 w-24 rounded bg-gray-200" />
          <div className="flex flex-wrap gap-2">
            {[88, 120, 104, 136, 112, 96].map((width, index) => (
              <div key={index} className="h-11 rounded-full bg-gray-200" style={{ width }} />
            ))}
          </div>
          <div className="mt-5 h-11 rounded-[10px] bg-gray-200" />
        </div>
        <div className="mt-5 h-5 w-44 rounded bg-gray-200" />
        <div className="mt-4 overflow-hidden rounded-xl border border-gray-300 bg-white">
          <div className="h-[52px] border-b border-gray-300 bg-gray-100" />
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex gap-3 border-t border-gray-200 p-4 first:border-t-0">
              <div className="h-12 w-12 shrink-0 rounded-lg bg-gray-200" />
              <div className="flex-1">
                <div className="h-4 w-2/3 rounded bg-gray-200" />
                <div className="mt-2 h-3.5 w-24 rounded bg-gray-200" />
                <div className="mt-4 h-3.5 w-1/2 rounded bg-gray-200" />
              </div>
              <div className="hidden w-24 sm:block">
                <div className="ml-auto h-5 w-16 rounded bg-gray-200" />
                <div className="mt-2 ml-auto h-4 w-12 rounded bg-gray-200" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

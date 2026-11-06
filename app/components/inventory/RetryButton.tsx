"use client";

/**
 * "Retry" button for the notices on the Inventory tab. Sits under the message (so it has the full width on a
 * phone) and is 44px tall like the other controls on this tab.
 */
export function RetryButton({ onClick, busy = false }: { onClick: () => void; busy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-disabled={busy}
      className="mt-2.5 inline-flex min-h-11 items-center rounded-lg border border-current px-4 text-sm font-semibold hover:bg-white/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 aria-disabled:cursor-wait aria-disabled:opacity-70"
    >
      {busy ? "Retrying…" : "Retry"}
    </button>
  );
}

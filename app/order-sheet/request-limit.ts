// The time limit every request of the Order sheet gives the server: the inventory and category reads (hooks.ts) and the Excel
// download (export-client.ts). A paused or half-reachable database is the case where a request is accepted and then never
// answered; without a limit the page would say "Loading..." or "Creating the Excel file..." for ever, with no way out. It is the
// same 30 seconds the Home page and Admin use.

export const REQUEST_TIMEOUT_MS = 30_000;

/** A fresh time limit for ONE request (never shared: a limit that has run out stays out). Undefined where the browser has none. */
export function timeLimit(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
}

/** True for what a request fails with when its time limit runs out (TimeoutError) or the browser stops it (AbortError). */
export function isTimeoutError(error: unknown): boolean {
  const name = typeof error === "object" && error !== null && "name" in error ? error.name : null;
  return name === "TimeoutError" || name === "AbortError";
}

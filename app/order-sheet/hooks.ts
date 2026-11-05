"use client";

// Data hooks for the Order sheet page: the inventory (all items) and the categories (display only).
// Both report loading / error / ready, so a failed request can never look like an empty inventory.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Category, Medication } from "@/lib/db";
import { todayISO } from "@/lib/order-sheet/draft";

/** `loadedAt` is when the data was read from the server (milliseconds since 1970): the page says "as of 2:41 PM". */
export type Loaded<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T; loadedAt: number };

/**
 * When the person comes back to the page after at least this long, the inventory is read again. Shorter than that, an
 * alt-tab does not cost a request. (The on-hand and supplier columns can be changed from the kiosk or another computer.)
 */
export const STALE_AFTER_MS = 30_000;

const NETWORK_MESSAGE = "Can’t reach the server. Check your internet connection and try again.";
const UNEXPECTED_MESSAGE = "The server sent data this page doesn’t understand. Try again.";

type FetchOutcome = { ok: true; data: unknown } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fetches JSON. Failures become a plain-language message (the server's own `error` text when it sent one). Never rejects.
 * The request is never aborted: a request that is no longer wanted is simply ignored when it answers (see useLoaded).
 */
async function fetchJson(url: string): Promise<FetchOutcome> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
  } catch {
    return { ok: false, message: NETWORK_MESSAGE };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const serverText = isRecord(body) && typeof body.error === "string" && body.error.trim() !== "" ? body.error : null;
    return { ok: false, message: serverText ?? `The server answered with an error (HTTP ${response.status}). Try again.` };
  }
  return { ok: true, data: body };
}

function isMedication(value: unknown): value is Medication {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    typeof value.barcode === "string" &&
    typeof value.stock === "number" &&
    typeof value.threshold === "number" &&
    typeof value.unit === "string"
  );
}

function isCategory(value: unknown): value is Category {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string";
}

/** An array only when EVERY entry is understood: an item is never silently dropped from the list. */
function toList<T>(data: unknown, guard: (entry: unknown) => entry is T): T[] | null {
  if (!Array.isArray(data)) return null;
  const entries: unknown[] = data;
  return entries.every(guard) ? (entries as T[]) : null;
}

function useLoaded<T>(url: string, guard: (entry: unknown) => entry is T) {
  const [state, setState] = useState<Loaded<T[]>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  /** Counts the requests. Only the newest one may change the state, so a slow older answer never overwrites a newer one. */
  const newest = useRef(0);
  /** The refresh that is running right now, so a second request for one (focus + visibility, or a double click) joins it. */
  const running = useRef<Promise<boolean> | null>(null);
  /**
   * The load that is on its way (identified by url + attempt). React Strict Mode (development only) runs an effect, undoes it
   * and runs it again straight away; both runs join this ONE request, so nothing is aborted (the browser would report
   * net::ERR_ABORTED) and nothing is asked twice. It is forgotten as soon as it has answered, so showing the page again
   * later reads the server again instead of reusing an old answer. Same idea as the in-flight load in app/page.tsx.
   */
  const loading = useRef<{ key: string; request: Promise<FetchOutcome> } | null>(null);

  useEffect(() => {
    // False once this run of the effect has been cleaned up: the page was left (a real unmount), Retry started a new
    // attempt, or this is Strict Mode's first run. A request nobody waits for any more is not aborted; its answer is ignored.
    let waiting = true;
    newest.current += 1;
    const mine = newest.current;
    const key = `${attempt}\u0000${url}`;
    let entry = loading.current;
    if (entry === null || entry.key !== key) {
      const started = { key, request: fetchJson(url) };
      loading.current = started;
      void started.request.then(() => {
        if (loading.current === started) loading.current = null;
      });
      entry = started;
    }
    void entry.request.then((outcome) => {
      if (!waiting || mine !== newest.current) return;
      if (!outcome.ok) {
        setState({ status: "error", message: outcome.message });
        return;
      }
      const list = toList(outcome.data, guard);
      setState(list ? { status: "ready", data: list, loadedAt: Date.now() } : { status: "error", message: UNEXPECTED_MESSAGE });
    });
    return () => {
      waiting = false;
    };
  }, [url, guard, attempt]);

  /** Shows the loading state again and fetches again. */
  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  /**
   * Fetches again WITHOUT showing the loading state (keeps focus and typed values); keeps the old list on failure.
   * Resolves to true when fresh data arrived and false when it did not (the caller may say so).
   */
  const refresh = useCallback((): Promise<boolean> => {
    if (running.current) return running.current;
    newest.current += 1;
    const mine = newest.current;
    setRefreshing(true);
    const run = (async () => {
      const outcome = await fetchJson(url);
      const list = outcome.ok ? toList(outcome.data, guard) : null;
      if (list && mine === newest.current) setState({ status: "ready", data: list, loadedAt: Date.now() });
      return list !== null;
    })().finally(() => {
      running.current = null;
      setRefreshing(false);
    });
    running.current = run;
    return run;
  }, [url, guard]);

  return { state, reload, refresh, refreshing };
}

/**
 * Reads the inventory again when the person comes back to this page (tab shown again, or window focused) after
 * STALE_AFTER_MS or more. Failures are ignored: the earlier data stays on screen and the page keeps saying when it is from.
 */
function useRefreshOnReturn(enabled: boolean, loadedAt: number | null, refresh: () => Promise<boolean>): void {
  const lastLoaded = useRef<number | null>(loadedAt);
  useEffect(() => {
    lastLoaded.current = loadedAt;
  }, [loadedAt]);

  useEffect(() => {
    if (!enabled) return;
    const onReturn = () => {
      if (document.visibilityState === "hidden") return;
      const last = lastLoaded.current;
      if (last !== null && Date.now() - last < STALE_AFTER_MS) return;
      void refresh();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [enabled, refresh]);
}

export function useMedications() {
  const loaded = useLoaded<Medication>("/api/medications", isMedication);
  const ready = loaded.state.status === "ready";
  useRefreshOnReturn(ready, loaded.state.status === "ready" ? loaded.state.loadedAt : null, loaded.refresh);
  return loaded;
}

export function useCategories() {
  return useLoaded<Category>("/api/categories", isCategory);
}

// ── "Today" and "has the page mounted" ───────────────────────────────────────────────────────────────────────────

function subscribeNever(): () => void {
  return () => undefined;
}

function readToday(): string {
  return todayISO();
}

function serverToday(): string {
  return "";
}

/**
 * Today's local date (YYYY-MM-DD) once the page is running in the browser, "" while rendering on the server and during
 * hydration. useSyncExternalStore makes the first client render match the server HTML and then switches to the real
 * value, so there is no hydration mismatch and no effect is needed. Non-empty also means "the page has mounted".
 */
export function useToday(): string {
  return useSyncExternalStore(subscribeNever, readToday, serverToday);
}

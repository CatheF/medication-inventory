"use client";

// The Inventory tab's view (search, stock level, category, sort, grouping) kept in sessionStorage, so that leaving the
// page (the "Review order sheet" link) and coming back with the browser's Back button shows the view the person left.
//
//  * One module-level store read through useSyncExternalStore, the same pattern as lib/order-sheet/use-order-draft.ts.
//    The server render and the hydration render use DEFAULT_VIEW; the stored view is applied by the render that
//    follows, so the first client render always equals the server render (no hydration mismatch).
//  * Every storage access is wrapped in try/catch. When sessionStorage is unavailable (blocked site data, a sandboxed
//    frame) the view is kept in memory instead: it still survives going to another page and Back inside the same
//    browser tab (the page is not reloaded), it just does not survive a reload.
//  * Text that cannot be understood is ignored field by field (see view-state.ts).
//  * The view is browser-tab state: it never leaves this browser and is not shared with other tabs.

import { useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { DEFAULT_VIEW, type ViewState } from "@/lib/inventory-view";
import { VIEW_STORAGE_KEY, parseStoredView, sanitizeView, serializeView } from "./view-state";

type Cached = { raw: string | null; view: ViewState };

let cached: Cached = { raw: null, view: DEFAULT_VIEW };
/** The most recently written text; also the source of truth while the browser's storage cannot be used. */
let memoryRaw: string | null = null;
/** True after the latest read or write of sessionStorage threw. While true, reads come from memory. */
let storageFailed = false;
const listeners = new Set<() => void>();

function readRaw(): string | null {
  if (typeof window === "undefined" || storageFailed) return memoryRaw;
  try {
    return window.sessionStorage.getItem(VIEW_STORAGE_KEY);
  } catch {
    storageFailed = true;
    return memoryRaw;
  }
}

function writeRaw(raw: string): void {
  memoryRaw = raw;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(VIEW_STORAGE_KEY, raw);
    storageFailed = false; // saved: reads can come from storage again
  } catch {
    storageFailed = true; // keep working from memory
  }
}

/** The same object until the stored text changes (React re-renders forever if a fresh object is returned on every read). */
function getSnapshot(): ViewState {
  const raw = readRaw();
  if (raw !== cached.raw) cached = { raw, view: parseStoredView(raw) };
  return cached.view;
}

function getServerSnapshot(): ViewState {
  return DEFAULT_VIEW;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Same contract as the setter of useState: a new view, or a function from the latest view to the new one. */
function setView(action: SetStateAction<ViewState>): void {
  if (typeof window === "undefined") return;
  const previous = getSnapshot();
  const next = sanitizeView(typeof action === "function" ? action(previous) : action);
  const raw = serializeView(next);
  if (raw === serializeView(previous)) return; // nothing changed: keep the snapshot, skip the write and the re-render
  writeRaw(raw);
  cached = { raw, view: next };
  listeners.forEach((listener) => listener());
}

/** `[view, setView]` like useState. setView keeps one identity for the life of the page. */
export function useInventoryView(): [ViewState, Dispatch<SetStateAction<ViewState>>] {
  const view = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [view, setView];
}

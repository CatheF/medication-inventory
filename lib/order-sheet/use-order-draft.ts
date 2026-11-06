"use client";

// Browser-side store for the order-sheet draft, exposed as a React hook.
//
//  * One module-level store backed by localStorage[STORAGE_KEY], read through useSyncExternalStore.
//  * Same-tab updates are announced with a window event (DRAFT_EVENT); other tabs arrive through "storage".
//  * Every storage access is wrapped in try/catch. If localStorage is unavailable (private mode, blocked site data,
//    quota exceeded) the draft lives in memory instead of failing, and `storage` reports "memory" so the page can tell
//    staff that the draft will not survive closing or reloading the page. Every later change tries to save again; as
//    soon as the browser accepts a write the draft is stored again and `storage` goes back to "browser".
//  * getServerSnapshot returns DEFAULT_DRAFT, so server rendering / static prerendering never touches the browser.
//  * getSnapshot returns the SAME object until the stored text changes. React compares snapshots with Object.is and
//    re-renders forever if a fresh object is returned on every read.
//
// The draft is only a list of item ids plus text staff typed (and, per row, the item's last known name, which is display text
// for the builder page only). It places no order and never changes stock.

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  DEFAULT_DRAFT,
  DRAFT_EVENT,
  STORAGE_KEY,
  addRows,
  clearRows,
  hasRow,
  parseDraft,
  removeRow,
  sanitizeDraft,
  serializeDraft,
  toggleRow,
} from "./draft";
import type { OrderDraft } from "./draft";

type Cached = { raw: string | null; draft: OrderDraft };

/** Where the draft currently lives: saved in this browser, or only in memory because the browser refused to save it. */
export type DraftStorageMode = "browser" | "memory";

let cached: Cached = { raw: null, draft: DEFAULT_DRAFT };
/** The most recently written text. Also the source of truth while the last attempt to use localStorage failed. */
let memoryRaw: string | null = null;
/** True after the latest read or write of localStorage threw. While true, reads come from memory (storage may be stale). */
let storageFailed = false;

function readRaw(): string | null {
  if (typeof window === "undefined" || storageFailed) return memoryRaw;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    storageFailed = true;
    return memoryRaw;
  }
}

function writeRaw(raw: string): void {
  memoryRaw = raw;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, raw);
    storageFailed = false; // saved: storage is current again, so reads can come from it again
  } catch {
    storageFailed = true; // keep working from memory; the draft will not survive a reload until a write succeeds
  }
}

function getStorageMode(): DraftStorageMode {
  return storageFailed ? "memory" : "browser";
}

/** Server rendering and hydration never claim a storage problem (they cannot know), so markup always matches. */
function getServerStorageMode(): DraftStorageMode {
  return "browser";
}

function getSnapshot(): OrderDraft {
  const raw = readRaw();
  if (raw !== cached.raw) {
    cached = { raw, draft: parseDraft(raw) };
  }
  return cached.draft;
}

function getServerSnapshot(): OrderDraft {
  return DEFAULT_DRAFT;
}

/** What the hook reads: the draft plus where it lives, in ONE object so the hook needs only one subscription. */
type StoreView = { draft: OrderDraft; storage: DraftStorageMode };

const SERVER_VIEW: StoreView = { draft: DEFAULT_DRAFT, storage: "browser" };
let cachedView: StoreView = SERVER_VIEW;

/** The same object until the draft or the storage mode changes (React re-renders forever on a fresh object per read). */
function getViewSnapshot(): StoreView {
  const draft = getSnapshot(); // read the draft first: reading it is what first discovers that localStorage is unusable
  const storage = getStorageMode();
  if (cachedView.draft !== draft || cachedView.storage !== storage) cachedView = { draft, storage };
  return cachedView;
}

function getServerViewSnapshot(): StoreView {
  return SERVER_VIEW;
}

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(DRAFT_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(DRAFT_EVENT, onStoreChange);
  };
}

function notify(): void {
  try {
    window.dispatchEvent(new Event(DRAFT_EVENT));
  } catch {
    // no window / no Event constructor: nothing to notify
  }
}

/**
 * Applies `fn` to the latest draft, validates the result, persists it and notifies every subscriber.
 * Always reads the latest state first, so two updates in the same tick compose instead of overwriting each other.
 */
function update(fn: (d: OrderDraft) => OrderDraft): void {
  if (typeof window === "undefined") return;
  const prev = getSnapshot();
  const candidate = fn(prev);
  if (candidate === prev) return; // the draft helpers return the same object for a no-op
  const next = sanitizeDraft(candidate);
  const raw = serializeDraft(next);
  if (raw === serializeDraft(prev)) return; // nothing actually changed: keep the snapshot stable, skip the write
  writeRaw(raw);
  cached = { raw, draft: next };
  notify();
}

function add(ids: number[], names?: ReadonlyMap<number, string>): void {
  update((d) => addRows(d, ids, names));
}

function remove(id: number): void {
  update((d) => removeRow(d, id));
}

function toggle(id: number, name?: string): void {
  update((d) => toggleRow(d, id, name));
}

function clear(): void {
  update((d) => clearRows(d));
}

/** Exposed for unit tests of the store itself (React is not needed to exercise it). Not for application code. */
export const orderDraftStore = {
  subscribe,
  getSnapshot,
  getServerSnapshot,
  getStorageMode,
  getServerStorageMode,
  update,
} as const;

export type UseOrderDraft = {
  draft: OrderDraft;
  update(fn: (d: OrderDraft) => OrderDraft): void;
  /**
   * Adds the ids that are not on the sheet yet. `names` (optional, item id -> display name) is remembered with each NEW row,
   * so the sheet can still say which item a row was if the item is deleted later (see SheetRowInput.name).
   */
  add(ids: number[], names?: ReadonlyMap<number, string>): void;
  remove(id: number): void;
  /** Adds the item, or removes it when it is already on the sheet. `name` (optional) is remembered with a NEW row. */
  toggle(id: number, name?: string): void;
  clear(): void;
  has(id: number): boolean;
  /** Number of rows on the sheet */
  count: number;
  /**
   * "browser": the draft is saved in this browser and is still here after a reload.
   * "memory": the browser refused to save it (private window, blocked site data, full storage), so it only lives until
   * this page is closed or reloaded. Show a warning when this is "memory".
   */
  storage: DraftStorageMode;
};

export function useOrderDraft(): UseOrderDraft {
  const { draft, storage } = useSyncExternalStore(subscribe, getViewSnapshot, getServerViewSnapshot);
  const has = useCallback((id: number) => hasRow(draft, id), [draft]);
  return useMemo(
    () => ({ draft, update, add, remove, toggle, clear, has, count: draft.rows.length, storage }),
    [draft, has, storage]
  );
}

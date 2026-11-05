"use client";

// Which tab of the home page is showing, kept in the address: `/?tab=inventory` is the Inventory tab, plain `/` is the
// Scan tab. That makes the Inventory tab linkable (the Order sheet page links to it) and lets the browser's Back button
// return to it.
//
//  * The address is the truth. The server render and the first client render (hydration included) show "scan"; the
//    address is applied in a layout effect, which runs before the browser paints. So a client-side visit of
//    /?tab=inventory (Back from the Order sheet, a Link) is never painted as the Scan tab first, and the first client
//    render still equals the server render (no hydration mismatch). Next.js's router pushes the new address only after it
//    has rendered the page, so reading location while rendering would see the old address; reading it in a layout
//    effect sees the new one.
//  * Switching tabs uses history.replaceState: the address follows the tab without adding a history entry per click, and
//    without asking the server for anything (router.replace would fetch the page again). Next.js patches replaceState
//    and keeps usePathname / useSearchParams in step, so the router state stays correct. Only the `tab` parameter is
//    touched; other parameters and the #hash are kept.
//  * The browser's Back / Forward buttons arrive as "popstate" events and are followed.
//  * Links of the app that change the address while the page stays mounted (the "Scan" link of the top bar goes to "/")
//    are followed through <TabUrlSync />, which watches Next.js's own idea of the address (useSearchParams) and wakes
//    the hook up. Without it the address would say "/" while the Inventory tab is still showing.
//  * If the browser refuses to change the address (it throws), the tab still changes: the choice is then held in memory
//    until the next Back / Forward.

import { Suspense, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";

export type Tab = "scan" | "inventory";

/** Query parameter that carries the tab. */
export const TAB_PARAM = "tab";

/** Reads the tab from `location.search`. Anything but "inventory" (in any letter case) is the Scan tab. */
export function parseTab(search: string): Tab {
  const value = new URLSearchParams(search).get(TAB_PARAM);
  return value !== null && value.trim().toLowerCase() === "inventory" ? "inventory" : "scan";
}

/** path + query + hash of `location` with only the tab parameter changed. */
export function hrefWithTab(location: { pathname: string; search: string; hash: string }, tab: Tab): string {
  const params = new URLSearchParams(location.search);
  if (tab === "inventory") params.set(TAB_PARAM, "inventory");
  else params.delete(TAB_PARAM);
  const query = params.toString();
  return `${location.pathname}${query === "" ? "" : `?${query}`}${location.hash}`;
}

/** Announces a tab change made by setTabInUrl (replaceState fires no event of its own). */
const TAB_EVENT = "medinventory:tab";

/** Set only while the browser refused to change the address. */
let heldTab: Tab | null = null;

function currentTab(): Tab {
  return heldTab ?? parseTab(window.location.search);
}

/**
 * Calls `show` with the tab the address names now, and again whenever the address may have changed (Back / Forward, a
 * tab switch made by setTabInUrl, a router navigation reported by <TabUrlSync />). Returns the cleanup.
 */
function followUrl(show: (tab: Tab) => void): () => void {
  const onChange = () => show(currentTab());
  const onPopState = () => {
    heldTab = null; // Back / Forward: the address is the truth again
    onChange();
  };
  window.addEventListener("popstate", onPopState);
  window.addEventListener(TAB_EVENT, onChange);
  onChange();
  return () => {
    window.removeEventListener("popstate", onPopState);
    window.removeEventListener(TAB_EVENT, onChange);
  };
}

/** Shows `tab` and puts it in the address (replacing the current history entry, never adding one). */
export function setTabInUrl(tab: Tab): void {
  if (typeof window === "undefined") return;
  const { pathname, search, hash } = window.location;
  const next = hrefWithTab({ pathname, search, hash }, tab);
  try {
    if (next !== `${pathname}${search}${hash}`) window.history.replaceState(null, "", next);
    heldTab = null;
  } catch {
    heldTab = tab;
  }
  window.dispatchEvent(new Event(TAB_EVENT));
}

/** `[tab, setTab]`. setTab keeps one identity for the life of the page. Render <TabUrlSync /> once next to it. */
export function useTabInUrl(): readonly [Tab, (tab: Tab) => void] {
  const [tab, setTab] = useState<Tab>("scan");
  useLayoutEffect(() => followUrl(setTab), []);
  return [tab, setTabInUrl] as const;
}

function SearchWatcher() {
  const search = useSearchParams()?.toString() ?? "";
  useEffect(() => {
    // Runs after the router has put its address in the browser's, so reading location now gives the new address.
    window.dispatchEvent(new Event(TAB_EVENT));
  }, [search]);
  return null;
}

function subscribeNever(): () => void {
  return () => undefined;
}

/**
 * Renders nothing; keeps useTabInUrl in step with address changes made by Next.js's router (links, Back, Forward).
 *
 * useSearchParams makes a statically prerendered page fall back to client rendering up to the nearest <Suspense>, and
 * a page without that boundary fails `next build`. Two safeguards, so the build does not depend on either alone:
 * the watcher is only rendered in the browser (the prerender never reaches useSearchParams), and it has its own
 * <Suspense> boundary around this one empty component (so even a render that does reach it cannot take the page with it).
 * Do not call useSearchParams anywhere else on this page without the same care.
 */
export function TabUrlSync() {
  const inBrowser = useSyncExternalStore(subscribeNever, () => true, () => false);
  if (!inBrowser) return null;
  return (
    <Suspense fallback={null}>
      <SearchWatcher />
    </Suspense>
  );
}

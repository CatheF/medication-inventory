"use client";

import { useEffect, type RefObject } from "react";

/**
 * Name of the CSS variable that carries the room the order bar takes at the bottom of the window.
 * InventoryTab turns it into `scroll-margin-bottom` on the page's focusable controls (see KEEP_CLEAR_OF_BAR there);
 * the class name written in InventoryTab has to use this same name, because Tailwind needs to see it as plain text.
 */
export const BAR_SPACE_VAR = "--order-bar-space";

/** The order bar floats this far above the bottom edge of the window (Tailwind `bottom-3`). */
const BAR_BOTTOM_OFFSET_PX = 12;
/** Air between the bar and a control that has keyboard focus, so the focus ring does not touch the bar. */
const FOCUS_GAP_PX = 16;

/**
 * While the order bar floats over the page, publish its footprint (height + distance from the window edge + a small
 * gap) as a CSS variable on <html>.
 *
 * Why: when a control gets keyboard focus the browser scrolls it into view, and "into view" ends at the window's
 * bottom edge, which is exactly where the floating bar sits. Without room kept free, Tab walks straight into controls
 * the bar is covering (WCAG 2.2 SC 2.4.11 Focus Not Obscured). With the variable used as `scroll-margin-bottom` on the
 * controls of the page, the browser keeps each focused control above the bar.
 *
 * Why a margin on the controls and not `scroll-padding` on the page: padding applies to everything that gets focus,
 * including the bar's own buttons, which sit inside that padded zone; focusing one of them (Tab, Shift+Tab, or the
 * focus() call that opens the "Clear" question) made the browser scroll the page by half a screen to "bring it into
 * view". A margin on the page's controls leaves the bar's controls alone.
 *
 * Measured, not guessed: the bar changes height (confirmation question, warnings, narrow screens), so a
 * ResizeObserver keeps the value exact. When the bar is a plain block (short windows: see OrderBar) it covers nothing
 * and the variable is removed. It is also removed when the bar goes away.
 */
export function useBarClearance(barRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const bar = barRef.current;
    if (bar === null) return;
    const root = document.documentElement;

    const apply = () => {
      if (getComputedStyle(bar).position === "sticky") {
        const space = Math.ceil(bar.getBoundingClientRect().height) + BAR_BOTTOM_OFFSET_PX + FOCUS_GAP_PX;
        root.style.setProperty(BAR_SPACE_VAR, `${space}px`);
      } else {
        root.style.removeProperty(BAR_SPACE_VAR);
      }
    };

    apply();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    observer?.observe(bar);
    // A window resize can flip the bar between floating and in-flow (a media query) without changing its own size.
    window.addEventListener("resize", apply);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", apply);
      root.style.removeProperty(BAR_SPACE_VAR);
    };
  }, [barRef]);
}

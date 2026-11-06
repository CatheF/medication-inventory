"use client";

import { useEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent } from "react";

/** One applied filter: a short `label` ("Category"), the `value` it is set to ("Antibiotics"), and how to take it off. */
export type ActiveFilter = { key: string; label: string; value: string; onRemove: () => void };

type ActiveFilterChipsProps = {
  /** The filters that are on right now. Keys must be unique. An empty list renders nothing. */
  filters: readonly ActiveFilter[];
  /** When given, a "Clear all filters" text button follows the chips. */
  onClearAll?: () => void;
  clearAllLabel?: string;
  /** Test ids: container `${prefix}s`, chip `${prefix}-${key}`, remove button `${prefix}-remove-${key}`, clear-all `${prefix}-clear-all`. */
  testIdPrefix?: string;
  className?: string;
};

/**
 * Removable chips for the filters that are applied ("Category: Antibiotics  x", "Stock: Low  x"), so a person can see
 * what is narrowing the list and take one filter off without hunting for the control that set it.
 *
 * Markup: a wrapper (test id `${prefix}s`) holding a labelled list (aria-label "Active filters") of chips, then the
 * optional clear-all button. It is NOT a live region: the screen that owns the filters announces its results (a
 * separate summary line), so removing a chip does not speak twice.
 *
 * Long values: the value is cut visually at about 28 characters with an ellipsis (CSS, so the text itself stays whole
 * in the page); the whole "label: value" is in the chip's title and in the remove button's accessible name
 * ("Remove filter Category: Antibiotics"). On a phone the chips wrap onto several lines; nothing scrolls sideways.
 *
 * Touch targets: the remove button is 40x40px although its x glyph is 16px.
 *
 * One press, one action: a HELD Enter key repeats keydown, and every repeat would press the button again. With the focus
 * rule below a held key would hop to the next chip and press that one too, and so on until every chip was gone (a slow
 * or sticky key, a tremor). So a repeated Enter on the remove buttons and on clear-all is ignored; a new press is not.
 *
 * KEYBOARD FOCUS when a chip is removed (decided here, so every screen behaves the same):
 *   1. if the focus was on that chip's remove button, it moves to the remove button of the NEXT chip that is still there,
 *   2. else to the PREVIOUS chip's remove button,
 *   3. else to the clear-all button (only reachable while the list still renders, i.e. never after the last chip went),
 *   4. else it falls back to the document. This happens when the last chip is removed (the component renders null
 *      then) and when "Clear all" is pressed: the focused button is gone, so the CALLER decides where focus goes, in
 *      its onRemove / onClearAll handler (for example the search box). This component never takes focus back from a
 *      caller that already moved it: it only acts when focus was lost.
 * Focus is only restored when it was on the removed chip's button (a keyboard or screen-reader user). A mouse click that
 * did not focus the button (Safari) leaves focus alone. The restore waits up to 3 seconds for the caller to actually drop
 * the chip, so a filter that lives in the URL (updated a moment later) works the same as one in component state.
 */
export function ActiveFilterChips({
  filters,
  onClearAll,
  clearAllLabel = "Clear all filters",
  testIdPrefix = "active-filter",
  className = "",
}: ActiveFilterChipsProps) {
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const clearAllButton = useRef<HTMLButtonElement | null>(null);
  const pendingFocus = useRef<{ keys: readonly string[]; index: number } | null>(null);
  const pendingTimer = useRef(0);

  useEffect(() => () => window.clearTimeout(pendingTimer.current), []);

  // After every render: if a removal is waiting for focus and the chip is gone, put focus where the rules above say.
  useEffect(() => {
    const request = pendingFocus.current;
    if (request === null) return;
    const present = new Set(filters.map((filter) => filter.key));
    // The caller has not dropped the chip (yet): keep waiting; the timer in handleRemove gives up after 3 seconds.
    if (present.has(request.keys[request.index])) return;
    pendingFocus.current = null;
    window.clearTimeout(pendingTimer.current);
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return; // focus is somewhere real: leave it
    const target = focusTargetAfterRemoval(request.keys, request.index, present);
    const button = target !== null ? removeButtons.current.get(target) : clearAllButton.current;
    button?.focus();
  });

  if (filters.length === 0) return null;

  const handleRemove = (event: MouseEvent<HTMLButtonElement>, index: number) => {
    // Remember where focus has to go only when it is on this very button (keyboard, screen reader, Chrome click).
    if (document.activeElement === event.currentTarget) {
      const request = { keys: filters.map((filter) => filter.key), index };
      pendingFocus.current = request;
      window.clearTimeout(pendingTimer.current);
      pendingTimer.current = window.setTimeout(() => {
        if (pendingFocus.current === request) pendingFocus.current = null; // the caller never dropped the chip
      }, 3000);
    }
    filters[index].onRemove();
  };

  return (
    // min-w-0 / max-w-full: when this wrapper is itself a flex or grid item it may shrink below the width of its longest chip
    // (the chips then truncate) instead of pushing the page sideways on a phone.
    <div data-testid={`${testIdPrefix}s`} className={`flex max-w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2 ${className}`}>
      <ul role="list" aria-label="Active filters" className="flex min-w-0 max-w-full flex-wrap gap-2">
        {filters.map((filter, index) => {
          const full = `${filter.label}: ${filter.value}`;
          return (
            <li
              key={filter.key}
              data-testid={`${testIdPrefix}-${filter.key}`}
              className="inline-flex max-w-full items-center rounded-full border border-blue-200 bg-blue-50 text-sm text-blue-800"
            >
              {/* The label and the value are one text run ("Category: Antibiotics") for screen readers and for tests. */}
              <span title={full} className="flex min-w-0 items-center py-1.5 pr-0.5 pl-3.5 leading-5">
                <span className="max-w-[16ch] shrink-0 truncate whitespace-pre">{`${filter.label}: `}</span>
                <span className="min-w-0 max-w-[28ch] truncate font-semibold">{filter.value}</span>
              </span>
              <button
                type="button"
                ref={(element) => {
                  if (element) removeButtons.current.set(filter.key, element);
                  else removeButtons.current.delete(filter.key);
                }}
                data-testid={`${testIdPrefix}-remove-${filter.key}`}
                aria-label={`Remove filter ${full}`}
                onKeyDown={ignoreHeldEnter}
                onClick={(event) => handleRemove(event, index)}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-blue-800 hover:bg-blue-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-700"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </li>
          );
        })}
      </ul>
      {onClearAll && (
        <button
          type="button"
          ref={clearAllButton}
          data-testid={`${testIdPrefix}-clear-all`}
          onKeyDown={ignoreHeldEnter}
          onClick={onClearAll}
          className="inline-flex min-h-10 items-center rounded-full px-3 text-sm font-semibold text-blue-700 underline underline-offset-2 hover:bg-blue-50 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
        >
          {clearAllLabel}
        </button>
      )}
    </div>
  );
}

/**
 * Enter on a button "clicks" it on keydown, and a held key sends a keydown with `repeat` set every few dozen milliseconds.
 * Cancelling those repeats (preventDefault on keydown also suppresses the click) makes a held Enter press the button once.
 */
function ignoreHeldEnter(event: KeyboardEvent<HTMLButtonElement>): void {
  if (event.repeat && event.key === "Enter") event.preventDefault();
}

/** The key whose remove button gets focus after `keys[removedIndex]` went away: the next survivor, else the previous one, else null. */
function focusTargetAfterRemoval(keys: readonly string[], removedIndex: number, present: ReadonlySet<string>): string | null {
  for (let i = removedIndex + 1; i < keys.length; i += 1) if (present.has(keys[i])) return keys[i];
  for (let i = removedIndex - 1; i >= 0; i -= 1) if (present.has(keys[i])) return keys[i];
  return null;
}

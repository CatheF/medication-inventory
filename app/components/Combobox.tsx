"use client";

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, MouseEvent, Ref } from "react";
import {
  filterOptions,
  findOptionByValue,
  initialActiveIndex,
  moveActive,
  placePopup,
  repeatClickGuard,
  resultsMessage,
  singleMatchIndex,
  type ComboboxOption,
} from "@/lib/combobox";

export type ComboboxProps = {
  /** Goes on the text input, so an outside <label htmlFor={id}> names the combobox. The other ids are derived from it. */
  id: string;
  /** The chosen option's value. "" is a legitimate value (for example "Uncategorized"). */
  value: string;
  /** Option values must be unique: they are the row keys and how "the chosen option" is found. Up to a few thousand options stay fast. */
  options: readonly ComboboxOption[];
  /** Called with the chosen option's value, also for "action" options. Not called when the option that is already chosen is picked again. */
  onChange: (value: string) => void;
  placeholder?: string;
  /** Shown (and announced) when the typed text matches no option. Default "No matches". */
  emptyText?: string;
  disabled?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  /** Test id of the input. Derived ids: `${testId}-listbox`, `${testId}-popup`, `${testId}-status`, `${testId}-empty`, `${testId}-option-${value}`. */
  testId?: string;
  /** Classes for the wrapper (width limits such as `sm:max-w-md`). */
  className?: string;
  /** The text input, so a caller can move keyboard focus here (after creating a category, after a failed save). */
  ref?: Ref<HTMLInputElement>;
};

// A searchable single-select: a drop-in for <select value onChange> when the list is long.
//
// Pattern: WAI-ARIA 1.2 combobox with a listbox popup ("editable combobox with list autocomplete", manual selection).
// The text input keeps DOM focus the whole time; the highlighted option is exposed with aria-activedescendant.
//
//   Closed: the input shows the chosen option's label (truncated, with a title). Opening selects that text, so typing
//           replaces it; the list then starts with every option and the chosen one highlighted. A pick and Escape select
//           the label again for the same reason (typing right after a pick must replace it, not append to it).
//   Typing: opens the list and filters it (every word must occur in an option's label or description; "+ Create new..."
//           style action options are never filtered out). Nothing is highlighted after typing; ArrowDown goes to the first.
//   Keys:   ArrowDown / ArrowUp open and move (wrapping); Home / End move while open; Enter picks the highlighted option,
//           or the only match when nothing is highlighted, and ALWAYS prevents the default so a form never submits from
//           here (a barcode scanner types Enter); Escape closes and restores the label (a second Escape does nothing and
//           still reaches the page); Tab and blur close without picking.
//   Mouse:  the highlight follows the pointer; a click picks. Options prevent mousedown so the input never blurs first.
//           The second click of a double-click on an option is swallowed (see armRepeatClickGuard), so it cannot land on
//           the control that lay under the popup. A click on the closed input takes over the mousedown (handleMouseDown)
//           so the browser cannot undo the "whole label selected" state that typing relies on.
//   Touch:  tapping the input opens the list; picking closes it.
//   Screen readers: a visually hidden status line says "N results" / the empty text after filtering. The chosen option
//           has aria-selected AND a check mark (not colour alone).
//
// WHY THE POPUP IS NEVER CLIPPED: it is a `popover="manual"` element, which the browser draws in the TOP LAYER. A top-layer
// box ignores `overflow:hidden` / `overflow:auto` on every ancestor (a clipped card, a scrolling panel), and it sits above
// every z-index (the sticky order bar is z-30). It is positioned with `position:fixed` from the input's rectangle
// (lib/combobox.ts placePopup), re-measured while the page scrolls or resizes, opens above the input when there is no room
// below, and shrinks to the room that is left in the visible area (on-screen keyboard, a phone in landscape) down to about
// one row, so it never runs past the screen edge: a fixed popup cannot be scrolled into view. Browsers without the Popover
// API fall back to plain position:fixed with z-index 60 (same placement; only an ancestor with a transform/filter could
// then clip it).
// The popup stays inside this component's DOM, so ids, events and aria-controls work without a portal.
//
// PERFORMANCE: options render only while the list is open; rows are memoized (a hover or an arrow key re-renders two
// rows, not the list); filtering 1,000 options costs well under a millisecond.
//
// Hydration: nothing here depends on the browser until the first interaction, and every id derives from the `id` prop.

function labelTextOf(input: HTMLInputElement | null): string {
  if (input === null) return "";
  const names = Array.from(input.labels ?? [])
    .map((label) => (label.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter((name) => name !== "");
  return names.join(" ") || (input.getAttribute("aria-label") ?? "");
}

/** Measures the input and writes the popup's fixed position and the surface's max height straight to the DOM (no state, no re-render). */
function placeNow(input: HTMLInputElement, popup: HTMLElement, surface: HTMLElement): void {
  const rect = input.getBoundingClientRect();
  const doc = document.documentElement;
  const vv = window.visualViewport;
  const visible = vv
    ? { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height }
    : { left: 0, top: 0, width: doc.clientWidth, height: doc.clientHeight };
  const placement = placePopup(
    { top: rect.top, left: rect.left, bottom: rect.bottom, width: rect.width },
    { ...visible, layoutHeight: doc.clientHeight }
  );
  const style = popup.style;
  style.left = `${placement.left}px`;
  style.width = `${placement.width}px`;
  style.top = placement.top === null ? "auto" : `${placement.top}px`;
  style.bottom = placement.bottom === null ? "auto" : `${placement.bottom}px`;
  surface.style.maxHeight = `${placement.maxHeight}px`;
  popup.dataset.side = placement.side;
}

/**
 * Scrolls the list (not the page) so `row` is visible: "nearest" moves as little as possible, "center" centres it. The
 * first and the last row go all the way to the end of the list, so the list's own padding is not left cut off.
 */
function scrollRowIntoView(list: HTMLElement, row: HTMLElement, mode: "nearest" | "center"): void {
  const top = row.offsetTop;
  const bottom = top + row.offsetHeight;
  const view = list.clientHeight;
  if (mode === "center") {
    list.scrollTop = Math.max(0, top - (view - row.offsetHeight) / 2);
  } else if (top < list.scrollTop) {
    list.scrollTop = row === list.firstElementChild ? 0 : top;
  } else if (bottom > list.scrollTop + view) {
    list.scrollTop = row === list.lastElementChild ? list.scrollHeight : bottom - view;
  }
}

/** Keeps DOM focus in the input when the pointer goes down on the popup (a click on an option, or its scrollbar). */
function keepFocus(event: MouseEvent): void {
  event.preventDefault();
}

// ── The second click of a double-click ──
// Picking closes the popup on the FIRST click. The second click of a double-click (or a third of a triple-click) then
// lands on whatever lay under the popup: a button gets pressed, a checkbox toggles, a link is followed, a word of text is
// selected. A habitual double-click on an option must do none of that, as it does not with a native <select>.
// After a pointer pick this listens, for one gesture, on `window` in the capture phase (before any element or React
// handler sees an event) and stops every mousedown / mouseup / click / dblclick whose click count (`detail`) is above 1;
// lib/combobox.ts repeatClickGuard holds the rule. The browser does the counting (same spot, inside the system's
// double-click time), so a slow double-click is covered too and a deliberate click elsewhere is not: its mousedown counts as a
// first click, ends the guard and goes through. A timeout ends it as well. The listener belongs to the page, not to this
// component, so it still works when the pick closes a dialog that unmounts the Combobox. The app has no other
// double-click or pointerdown handlers; pointer events are left alone.
const REPEAT_GUARD_TYPES = ["mousedown", "mouseup", "click", "dblclick"] as const;
const REPEAT_GUARD_MAX_MS = 1500;
let disarmRepeatClickGuard: (() => void) | null = null;

function armRepeatClickGuard(): void {
  disarmRepeatClickGuard?.();
  let armed = true;
  let timer = 0;
  const disarm = () => {
    armed = false;
    window.clearTimeout(timer);
    for (const type of REPEAT_GUARD_TYPES) window.removeEventListener(type, onPointerEvent, true);
    if (disarmRepeatClickGuard === disarm) disarmRepeatClickGuard = null;
  };
  function onPointerEvent(event: Event): void {
    // (globalThis.MouseEvent: the DOM class; the name MouseEvent above is React's event type)
    const step = repeatClickGuard(armed, event.type, event instanceof globalThis.MouseEvent ? event.detail : 0);
    if (step.swallow) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
    if (!step.armed) disarm();
  }
  for (const type of REPEAT_GUARD_TYPES) window.addEventListener(type, onPointerEvent, true);
  timer = window.setTimeout(disarm, REPEAT_GUARD_MAX_MS);
  disarmRepeatClickGuard = disarm;
}

function CheckIcon({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ChevronIcon({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

type RowProps = {
  id: string;
  index: number;
  option: ComboboxOption;
  selected: boolean;
  active: boolean;
  /** First action after regular options: a thin rule above it. */
  separated: boolean;
  testId: string | undefined;
  /** `byPointer`: the pick came from a mouse click or a tap (not Enter). */
  onPick: (index: number, byPointer: boolean) => void;
  onHover: (index: number, x: number, y: number) => void;
};

const OptionRow = memo(function OptionRow({ id, index, option, selected, active, separated, testId, onPick, onHover }: RowProps) {
  const isAction = option.kind === "action";
  const tone = isAction ? "font-semibold text-blue-700" : selected ? "font-semibold text-gray-900" : "text-gray-900";
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      data-value={option.value}
      data-active={active ? "true" : undefined}
      data-kind={isAction ? "action" : undefined}
      data-testid={testId ? `${testId}-option-${option.value}` : undefined}
      onMouseDown={keepFocus}
      onMouseMove={(event) => onHover(index, event.clientX, event.clientY)}
      onClick={() => onPick(index, true)}
      className={`flex min-h-11 cursor-pointer items-start gap-2 px-3 py-2 text-base [overflow-wrap:anywhere] forced-colors:-outline-offset-2 ${tone} ${
        active ? "bg-blue-50 shadow-[inset_4px_0_0_var(--color-blue-700)] forced-colors:outline-2" : ""
      } ${separated ? "border-t border-gray-200" : ""}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block">{option.label}</span>
        {option.description ? <span className="mt-0.5 block text-sm font-normal text-gray-600">{option.description}</span> : null}
      </span>
      {selected ? <CheckIcon className="mt-0.5 h-5 w-5 shrink-0 text-blue-700" /> : null}
    </li>
  );
});

export function Combobox({
  id,
  value,
  options,
  onChange,
  placeholder,
  emptyText = "No matches",
  disabled = false,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  testId,
  className = "",
  ref,
}: ComboboxProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const scrollRequest = useRef<"nearest" | "center" | null>(null);
  const reselectText = useRef(false);
  const pointer = useRef({ x: -1, y: -1 });
  // The component needs its own handle on the input and the caller may want one too.
  const setInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref]
  );

  const [open, setOpen] = useState(false);
  /** What the input shows while the list is open. */
  const [text, setText] = useState("");
  /** True once the person typed since the list opened: only then does `text` filter. Opening alone shows every option. */
  const [filtering, setFiltering] = useState(false);
  /** Highlighted index in `results`, -1 for none. */
  const [active, setActive] = useState(-1);
  const [listLabel, setListLabel] = useState("");

  // A disabled input that was open gets no blur event: close it here (a guarded update during render is the supported way).
  if (disabled && open) setOpen(false);
  const isOpen = open && !disabled;

  const listboxId = `${id}-listbox`;
  const optionId = (index: number) => `${id}-option-${index}`;
  const emptyLabel = emptyText.trim() === "" ? "No matches" : emptyText;

  const selected = useMemo(() => findOptionByValue(options, value), [options, value]);
  const selectedLabel = selected?.label ?? "";
  const query = isOpen && filtering ? text : "";
  const results = useMemo(() => filterOptions(options, query), [options, query]);
  const activeIndex = active >= 0 && active < results.length ? active : -1;
  const message = isOpen ? resultsMessage(results, emptyLabel) : "";
  // No regular option left (actions do not count): say so above the actions, as well as in the status line.
  const noMatches = isOpen && !results.some((option) => option.kind !== "action");

  // Handlers read the latest results / value / onChange through a ref, so the callbacks given to the rows never change
  // and a re-render does not rebuild a thousand rows.
  const latest = useRef({ results, value, onChange });
  useLayoutEffect(() => {
    latest.current = { results, value, onChange };
  });

  const pick = useCallback((index: number, byPointer: boolean) => {
    const { results: listed, value: current, onChange: notify } = latest.current;
    const option = listed[index];
    if (option === undefined) return;
    setOpen(false);
    setFiltering(false);
    setActive(-1);
    // Focus stays in the input, so, as after Escape, its text is selected again once the label is back: typing right after
    // a pick replaces the label instead of being appended to it. (This relies on the caller applying the new value in the
    // same event, as a plain useState setter does; a value that arrives later is shown with the caret at the end.)
    reselectText.current = true;
    if (byPointer) armRepeatClickGuard();
    // An action is a command: always reported. A regular option is only reported when it changes the value.
    if (option.kind === "action" || option.value !== current) notify(option.value);
  }, []);

  const hover = useCallback((index: number, x: number, y: number) => {
    // A list that scrolls under a pointer that did not move (arrow keys) makes the browser send a mousemove with the old
    // coordinates: that is not the person pointing at a row, so it must not steal the highlight from the keyboard.
    if (pointer.current.x === x && pointer.current.y === y) return;
    pointer.current = { x, y };
    setActive(index);
  }, []);

  const beginOpen = () => {
    setListLabel(labelTextOf(inputRef.current) || "Options");
    setOpen(true);
  };

  const closeList = (reselect: boolean) => {
    setOpen(false);
    setFiltering(false);
    setActive(-1);
    if (reselect) reselectText.current = true;
  };

  /** Opens with every option listed and the chosen one highlighted (or, from the keyboard with no chosen one, the first / last). */
  const openList = (via: "pointer" | "ArrowDown" | "ArrowUp") => {
    if (disabled || isOpen) return;
    let start = initialActiveIndex(results, selected);
    if (start < 0 && via !== "pointer") start = moveActive(-1, results.length, via);
    setText(selectedLabel);
    setFiltering(false);
    setActive(start);
    scrollRequest.current = "center";
    beginOpen();
    inputRef.current?.select();
  };

  const moveTo = (index: number) => {
    scrollRequest.current = "nearest";
    setActive(index);
  };

  // A click on the CLOSED input opens the list with the whole label selected (openList), so typing replaces the label. Left
  // to itself the browser works against that: it places the caret on mousedown, and when the click lands inside text that is
  // already selected (after a pick, after Escape, after tabbing in) it collapses the selection only AFTER the click event,
  // undoing the select() made there; typing would then be appended to the label. So the browser's own handling of this
  // mousedown (caret, selection, text drag) is skipped and focus is moved by hand. While the list is open the input is an
  // ordinary text box: a click places the caret to edit the query. Other buttons and modified clicks are left alone.
  const handleMouseDown = (event: MouseEvent<HTMLInputElement>) => {
    if (disabled || isOpen) return;
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (document.activeElement !== event.currentTarget) event.currentTarget.focus();
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    setText(event.target.value);
    setFiltering(true);
    setActive(-1);
    scrollRequest.current = null;
    if (!isOpen) beginOpen();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return; // an IME is still composing: Enter / arrows belong to it
    const key = event.key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      if (isOpen) moveTo(moveActive(activeIndex, results.length, key));
      else openList(key);
    } else if ((key === "Home" || key === "End") && isOpen) {
      event.preventDefault();
      moveTo(moveActive(activeIndex, results.length, key));
    } else if (key === "Enter") {
      // Always: a barcode scanner ends with Enter, and an Enter here must never submit the form around this field.
      event.preventDefault();
      if (isOpen) {
        const index = activeIndex >= 0 ? activeIndex : singleMatchIndex(results);
        if (index >= 0) pick(index, false);
      }
    } else if (key === "Escape") {
      // Only the first Escape (list open) is ours; the next one goes on to the page (a dialog may close on it).
      // stopImmediatePropagation as well: in the App Router React's root is `document`, and stopPropagation alone would
      // still let a `document` keydown listener added later (a modal's "close on Escape") see this Escape.
      if (isOpen) {
        event.preventDefault();
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation();
        closeList(true);
      }
    } else if (key === "Tab" && isOpen) {
      closeList(false); // moves on without picking; the label comes back
    }
  };

  // ── Effects, in the order they must run ──

  // 1. Show the popup in the top layer, place it, and keep it placed while the page scrolls or resizes.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const input = inputRef.current;
    const popup = popupRef.current;
    const surface = surfaceRef.current;
    if (!input || !popup || !surface) return;
    if (typeof popup.showPopover === "function") {
      try {
        popup.showPopover();
      } catch {
        // already showing (a strict-mode replay): nothing to do
      }
    }
    placeNow(input, popup, surface);

    let frame = 0;
    const schedule = (event?: Event) => {
      if (event && event.target instanceof Node && popup.contains(event.target)) return; // the list's own scrolling
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        placeNow(input, popup, surface);
      });
    };
    window.addEventListener("scroll", schedule, true); // capture: any scrolling ancestor, not just the window
    window.addEventListener("resize", schedule);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      if (typeof popup.hidePopover === "function") {
        try {
          popup.hidePopover();
        } catch {
          // already hidden
        }
      }
    };
  }, [isOpen]);

  // 2. A new filter starts at the top of the list.
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query]);

  // 3. Keyboard moves and the opening of the list scroll the highlighted row into view (never a hover: the row is under the pointer).
  useLayoutEffect(() => {
    const mode = scrollRequest.current;
    if (!isOpen || mode === null) return;
    scrollRequest.current = null;
    const list = listRef.current;
    const row = list && activeIndex >= 0 ? list.children[activeIndex] : null;
    if (list && row instanceof HTMLElement) scrollRowIntoView(list, row, mode);
  });

  // 4. After Escape or a pick the label is back in the input: select it again so typing replaces it. Only while the input
  //    still has focus: a caller that moved focus on (a pick of "+ Create new..." that opens a field) keeps it there, and
  //    select() would pull focus back in Safari.
  useLayoutEffect(() => {
    if (!reselectText.current) return;
    reselectText.current = false;
    const input = inputRef.current;
    if (input !== null && document.activeElement === input) input.select();
  });

  return (
    <div className={`relative ${className}`}>
      <input
        ref={setInputRef}
        id={id}
        type="text"
        role="combobox"
        data-testid={testId}
        value={isOpen ? text : selectedLabel}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={(event) => event.currentTarget.select()}
        onMouseDown={handleMouseDown}
        onClick={() => openList("pointer")}
        onBlur={() => {
          if (isOpen) closeList(false);
        }}
        placeholder={placeholder}
        disabled={disabled}
        title={!isOpen && selectedLabel !== "" ? selectedLabel : undefined}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={isOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid ? true : undefined}
        className="min-h-11 w-full truncate rounded-[10px] border border-gray-400 bg-white py-2 pr-10 pl-3 text-base text-gray-900 placeholder:text-gray-500! focus-visible:border-blue-700 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-700 aria-invalid:border-red-600 aria-invalid:bg-red-50 aria-invalid:placeholder:text-gray-600! disabled:cursor-not-allowed disabled:opacity-60"
      />
      <ChevronIcon
        className={`pointer-events-none absolute top-1/2 right-3 h-[18px] w-[18px] -translate-y-1/2 transition-transform motion-reduce:transition-none ${
          disabled ? "text-gray-400" : "text-gray-600"
        } ${isOpen ? "rotate-180" : ""}`}
      />

      {/* The popup. `popover="manual"` puts it in the top layer (see the note at the top). It is always in the page, hidden,
          so aria-controls always points at an element; the options inside only exist while it is open. The user-agent styles
          of a popover (inset, margin, border, padding, background) are reset here; left/top/bottom/width are written by placeNow. */}
      <div
        ref={popupRef}
        popover="manual"
        hidden={!isOpen}
        data-testid={testId ? `${testId}-popup` : undefined}
        onMouseDown={keepFocus}
        className="fixed inset-auto z-60 m-0 overflow-visible border-0 bg-transparent p-0 text-gray-900 print:hidden"
      >
        <div ref={surfaceRef} className="flex flex-col overflow-hidden rounded-xl border border-gray-300 bg-white shadow-lg">
          {noMatches ? (
            <p data-testid={testId ? `${testId}-empty` : undefined} className="px-3 py-3 text-sm text-gray-700 [overflow-wrap:anywhere]">
              {emptyLabel}
            </p>
          ) : null}
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={listLabel || "Options"}
            hidden={!isOpen || results.length === 0}
            data-testid={testId ? `${testId}-listbox` : undefined}
            className={`relative max-h-64 min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 ${noMatches ? "border-t border-gray-200" : ""}`}
          >
            {isOpen
              ? results.map((option, index) => (
                  <OptionRow
                    key={option.value}
                    id={optionId(index)}
                    index={index}
                    option={option}
                    selected={option === selected}
                    active={index === activeIndex}
                    separated={option.kind === "action" && index > 0 && results[index - 1].kind !== "action"}
                    testId={testId}
                    onPick={pick}
                    onHover={hover}
                  />
                ))
              : null}
          </ul>
        </div>
      </div>

      {/* Spoken after filtering: "3 results" / "No matches". Empty while closed, so opening the list announces again. */}
      <div role="status" aria-live="polite" aria-atomic="true" data-testid={testId ? `${testId}-status` : undefined} className="sr-only">
        {message}
      </div>
    </div>
  );
}

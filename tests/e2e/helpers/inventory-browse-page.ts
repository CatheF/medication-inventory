// Helpers for the Inventory tab browser tests (tests/e2e/inventory-browse.spec.ts).
//
// Everything here opens the page, drives controls the way a person does, and reads back what a person can SEE (headings, chip
// numbers, summary text, rows, ticks) or what was REQUESTED (the mock API's request log). Nothing re-implements application
// logic: what the screen must show is computed by tests/e2e/helpers/inventory-oracle.ts, which does not import the app's code.
import { expect, type Locator, type Page } from "@playwright/test";
import type { Category, Medication } from "@/lib/db";
import { buildCategories, buildMedications, fakeUuid, type IdShape } from "../../helpers/fixtures";
import { installMockApi, type MockApi, type MockApiOptions } from "./mock-api";
import {
  expectedCounts,
  expectedEmpty,
  expectedFooter,
  expectedGroups,
  expectedSummary,
  expectedVisible,
  filterWords,
  itemsWord,
  type OracleCategory,
  type OracleView,
} from "./inventory-oracle";

/** The dev server compiles a route the first time it is asked for it, so the first load of a page is allowed to be slow. */
const FIRST_LOAD_TIMEOUT_MS = 120_000;

/** How long a screen may take to show its list. Lower it (E2E_SLOW_MS=5000) to see quickly that a build lacks the feature. */
export const SLOW_MS = Number(process.env.E2E_SLOW_MS) || 60_000;

/** localStorage key of the order sheet draft, and the sessionStorage key of the Inventory view (both documented in the app). */
export const DRAFT_KEY = "medinventory.orderSheet.v1";
export const VIEW_KEY = "medinventory.inventoryView.v1";

// ── Opening the tab ──────────────────────────────────────────────────────────────────────────────

export type OpenInventoryOptions = MockApiOptions & {
  /** Runs after the mock is installed and before the page loads: the place to inject failures or gate requests. */
  beforeLoad?: (api: MockApi) => void | Promise<void>;
  /** Ids already on the order sheet in this browser (seeded once, before the first load). */
  sheetIds?: readonly number[];
  /** What to wait for: the list ("ready", default), the error notice, the loading skeleton, or just the tab. */
  until?: "ready" | "error" | "loading" | "shell";
};

export async function openInventory(page: Page, options: OpenInventoryOptions = {}): Promise<MockApi> {
  const { beforeLoad, sheetIds, until = "ready", ...mock } = options;
  // Unless a test brings its own data it gets the standard seed with its deliberate edge values (see browseData).
  const standard = browseData(mock.shape ?? "uuid");
  const api = await installMockApi(page, {
    ...mock,
    medications: mock.medications ?? standard.medications,
    categories: mock.categories ?? standard.categories,
  });
  // The app honours the reduced-motion setting; with it on, no transition can be caught half way by a measurement.
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (sheetIds && sheetIds.length > 0) await seedSheet(page, sheetIds);
  if (beforeLoad) await beforeLoad(api);
  await gotoInventory(page, until);
  return api;
}

/** (Re)loads the Inventory tab on a page that already has the mock installed. */
export async function gotoInventory(page: Page, until: NonNullable<OpenInventoryOptions["until"]> = "ready"): Promise<void> {
  await page.goto("/?tab=inventory", { waitUntil: "domcontentloaded", timeout: FIRST_LOAD_TIMEOUT_MS });
  await expect(page.getByTestId("inventory-tab")).toBeVisible({ timeout: SLOW_MS });
  const waitFor = until === "ready" ? "inventory-summary" : until === "error" ? "inventory-error" : until === "loading" ? "inventory-loading" : null;
  if (waitFor !== null) await expect(page.getByTestId(waitFor)).toBeVisible({ timeout: SLOW_MS });
}

async function seedSheet(page: Page, ids: readonly number[]): Promise<void> {
  const draft = JSON.stringify({
    version: 1,
    rows: ids.map((id) => ({ id, qty: "", unit: "" })),
    title: "Supply order",
    date: null,
    preparedBy: "",
    notes: "",
    showOnHand: false,
    showBarcode: false,
    paper: "letter",
  });
  await page.addInitScript(
    ([key, value]) => {
      try {
        // Only the first load of this tab seeds: a reload in the middle of a test keeps what the person did since.
        if (window.sessionStorage.getItem("__e2e_sheet_seeded") === null) {
          window.sessionStorage.setItem("__e2e_sheet_seeded", "1");
          window.localStorage.setItem(key, value);
        }
      } catch {
        /* storage unavailable: the test fails on its own assertions */
      }
    },
    [DRAFT_KEY, draft] as const
  );
}

// ── Page errors ──────────────────────────────────────────────────────────────────────────────────

/** Errors the page itself raised (uncaught exceptions, React/Next console errors). Failed HTTP loads are expected in failure tests. */
export function watchRuntimeErrors(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/Failed to load resource/.test(text)) return; // the browser logs every non-2xx answer; failure tests cause them on purpose
    problems.push(`console.error: ${text}`);
  });
  return problems;
}

// ── Locators ─────────────────────────────────────────────────────────────────────────────────────

export const rowsOf = (page: Page): Locator => page.locator('[data-testid^="item-card-"]');
export const rowOf = (page: Page, id: number): Locator => page.getByTestId(`item-card-${id}`);
export const tickOf = (page: Page, id: number): Locator => page.getByTestId(`order-checkbox-${id}`);
export const chipOf = (page: Page, key: string): Locator => page.getByTestId(`category-chip-${key}`);
export const headingOf = (page: Page, key: string): Locator => page.getByTestId(`group-heading-${key}`);
export const summaryOf = (page: Page): Locator => page.getByTestId("inventory-summary");
export const orderBarOf = (page: Page): Locator => page.getByTestId("order-bar");
export const searchBoxOf = (page: Page): Locator => page.getByTestId("search-input");

/** The key a category filter uses in test ids: the category id, "uncategorized", "unknown" or "all". */
export function chipKey(filter: OracleCategory): string {
  return filter.kind === "category" ? filter.id : filter.kind;
}

// ── Reading the whole screen at once ─────────────────────────────────────────────────────────────

export type ScreenRow = {
  id: number;
  visible: boolean;
  text: string;
  onSheet: boolean;
  ticked: boolean;
  status: string | null;
  statusText: string;
  barcode: string;
  supplier: string;
};
export type ScreenGroup = { key: string; title: string; count: number; countWord: string; expanded: boolean; ids: number[] };
export type ScreenChip = { key: string; label: string; count: number; pressed: boolean };
export type Screen = {
  summary: string | null;
  footer: string | null;
  /** Every item row in the page (DOM order), including rows of collapsed groups. */
  rows: ScreenRow[];
  groups: ScreenGroup[];
  flat: boolean;
  chips: ScreenChip[];
  activeFilters: string[];
  clearFilters: boolean;
  empty: { kind: string | null; title: string } | null;
  error: boolean;
  loading: boolean;
  orderBar: string | null;
  bodyText: string;
  /** Which stock buttons are pressed (aria-pressed), the state of the group switch and the value of the sort box. */
  stockPressed: string[];
  groupedOn: boolean | null;
  sortValue: string | null;
};

export async function readScreen(page: Page): Promise<Screen> {
  return page.evaluate((): Screen => {
    const clean = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();
    const byId = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const idOf = (el: Element, prefix: string): string => (el.getAttribute("data-testid") ?? "").slice(prefix.length);

    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="item-card-"]')).map((el): ScreenRow => {
      const id = Number(idOf(el, "item-card-"));
      const status = el.querySelector<HTMLElement>(`[data-testid="stock-status-${id}"]`);
      const box = el.querySelector<HTMLInputElement>(`[data-testid="order-checkbox-${id}"]`);
      return {
        id,
        visible: el.checkVisibility(),
        text: clean(el.innerText),
        onSheet: el.getAttribute("data-on-sheet") === "true",
        ticked: box?.checked === true,
        status: status?.getAttribute("data-status") ?? null,
        statusText: clean(status?.textContent),
        barcode: clean(el.querySelector(`[data-testid="item-barcode-${id}"] dd`)?.textContent),
        supplier: clean(el.querySelector(`[data-testid="item-supplier-${id}"] dd`)?.textContent),
      };
    });

    const groups = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="group-heading-"]')).map((heading): ScreenGroup => {
      // innerText, not textContent: the title and "· 3 items" are separate flex items, a space apart only on screen.
      const text = clean(heading.innerText);
      const match = /^(.*?) · (\d+) (items?)\b/.exec(text);
      const section = heading.closest("section");
      const ids = section
        ? Array.from(section.querySelectorAll('[data-testid^="item-card-"]')).map((el) => Number(idOf(el, "item-card-")))
        : [];
      return {
        key: idOf(heading, "group-heading-"),
        title: match ? match[1] : text,
        count: match ? Number(match[2]) : Number.NaN,
        countWord: match ? match[3] : "",
        expanded: heading.querySelector("button")?.getAttribute("aria-expanded") === "true",
        ids,
      };
    });

    const chips = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="category-chip-"]')).map((el): ScreenChip => {
      const text = clean(el.textContent);
      const match = /^(.*?) \((\d+)\)$/.exec(text);
      return {
        key: idOf(el, "category-chip-"),
        label: match ? match[1] : text,
        count: match ? Number(match[2]) : Number.NaN,
        pressed: el.getAttribute("aria-pressed") === "true",
      };
    });

    const empty = byId("inventory-empty");
    return {
      summary: byId("inventory-summary") ? clean(byId("inventory-summary")?.textContent) : null,
      footer: byId("inventory-footer") ? clean(byId("inventory-footer")?.textContent) : null,
      rows,
      groups,
      flat: byId("flat-list") !== null,
      chips,
      activeFilters: Array.from(document.querySelectorAll<HTMLElement>('li[data-testid^="active-filter-"]')).map((el) => clean(el.textContent)),
      clearFilters: byId("clear-filters") !== null,
      empty: empty ? { kind: empty.getAttribute("data-empty-kind"), title: clean(empty.querySelector("h3")?.textContent) } : null,
      error: byId("inventory-error") !== null,
      loading: byId("inventory-loading") !== null,
      orderBar: byId("order-bar") ? clean(byId("order-bar")?.textContent) : null,
      bodyText: clean(document.body.innerText),
      stockPressed: Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="stock-filter-"]'))
        .filter((el) => el.getAttribute("aria-pressed") === "true")
        .map((el) => idOf(el, "stock-filter-")),
      groupedOn: document.querySelector<HTMLInputElement>('[data-testid="group-toggle"]')?.checked ?? null,
      sortValue: document.querySelector<HTMLSelectElement>('[data-testid="sort-select"]')?.value ?? null,
    };
  });
}

// ── Driving the controls ─────────────────────────────────────────────────────────────────────────

export async function setSearch(page: Page, text: string): Promise<void> {
  await searchBoxOf(page).fill(text);
}

export async function setStock(page: Page, stock: "all" | "low" | "ok"): Promise<void> {
  await page.getByTestId(`stock-filter-${stock}`).click();
}

export async function chooseChip(page: Page, filter: OracleCategory): Promise<void> {
  const target = chipOf(page, chipKey(filter));
  // On a phone with many categories the chips sit in a panel behind a button. Open it the way a person would.
  if (!(await target.isVisible())) {
    const toggle = page.getByTestId("category-filter-toggle");
    if (await toggle.isVisible()) await toggle.click();
  }
  await target.click();
}

export async function setSort(page: Page, sort: OracleView["sort"]): Promise<void> {
  await page.getByTestId("sort-select").selectOption(sort);
}

export async function setGrouped(page: Page, grouped: boolean): Promise<void> {
  const control = page.getByTestId("group-toggle");
  if (grouped) await control.check();
  else await control.uncheck();
}

/** Puts the page in `view` using the controls (search box, stock buttons, chips, sort, group switch). */
export async function applyView(page: Page, view: OracleView): Promise<void> {
  await setSearch(page, view.search);
  await setStock(page, view.stock);
  await chooseChip(page, view.category);
  await setSort(page, view.sort);
  await setGrouped(page, view.grouped);
}

// ── The big cross-check ──────────────────────────────────────────────────────────────────────────

const parseCounts = (text: string | null): { shown: number; total: number } | null => {
  if (text === null) return null;
  const all = /^Showing all (\d+) items?\.$/.exec(text);
  if (all) return { shown: Number(all[1]), total: Number(all[1]) };
  const some = /^Showing (\d+) of (\d+) items?/.exec(text);
  return some ? { shown: Number(some[1]), total: Number(some[2]) } : null;
};

/**
 * Waits until the results line says what the oracle says it must, then checks EVERYTHING else a person can see against the
 * oracle: rows (ids and order), headings (titles, counts, members), chip numbers, pressed chip, active-filter chips, the
 * Clear filters button, the empty state, and that no item was lost or shown twice. `categories` is the category list the
 * page was given (an empty list while the categories are blocked).
 */
export async function expectScreenMatches(
  page: Page,
  items: readonly Medication[],
  categories: readonly Category[],
  view: OracleView,
  label = ""
): Promise<Screen> {
  const where = label === "" ? JSON.stringify(view) : `${label} ${JSON.stringify(view)}`;
  const visible = expectedVisible(items, categories, view);
  const summary = expectedSummary(items.length, visible.length, view, categories);
  await expect(summaryOf(page), `results line for ${where}`).toHaveText(summary, { timeout: SLOW_MS });

  const screen = await readScreen(page);
  const domIds = screen.rows.map((row) => row.id);
  const flatIds = visible.map((item) => item.id);

  if (view.grouped) {
    const groups = expectedGroups(items, categories, view);
    expect(screen.flat, `flat list present for ${where}`).toBe(false);
    expect(
      screen.groups.map((g) => ({ key: g.key, title: g.title, count: g.count, countWord: g.countWord, ids: g.ids })),
      `headings for ${where}`
    ).toEqual(groups.map((g) => ({ key: g.key, title: g.title, count: g.ids.length, countWord: itemsWord(g.ids.length), ids: g.ids })));
    expect(domIds, `rows (grouped) for ${where}`).toEqual(groups.flatMap((g) => g.ids));
  } else {
    expect(screen.groups, `no headings in the flat list for ${where}`).toEqual([]);
    expect(screen.flat === (visible.length > 0), `flat list present iff there are rows for ${where}`).toBe(true);
    expect(domIds, `rows (flat) for ${where}`).toEqual(flatIds);
  }

  // Never lost, never twice.
  expect(new Set(domIds).size, `an item appears twice for ${where}`).toBe(domIds.length);
  expect([...domIds].sort((a, b) => a - b), `the set of shown ids for ${where}`).toEqual([...flatIds].sort((a, b) => a - b));

  // Summary numbers agree with the rows.
  const counts = parseCounts(screen.summary);
  expect(counts, `results line parses for ${where}: ${screen.summary}`).not.toBeNull();
  expect(counts?.shown, `results line count vs rows for ${where}`).toBe(domIds.length);
  expect(counts?.total, `results line total for ${where}`).toBe(items.length);

  // Chips.
  const wanted = expectedCounts(items, categories, view);
  const chipByKey = new Map(screen.chips.map((c) => [c.key, c]));
  expect(chipByKey.get("all")?.count, `All chip for ${where}`).toBe(wanted.all);
  expect(chipByKey.get("uncategorized")?.count, `Uncategorized chip for ${where}`).toBe(wanted.uncategorized);
  for (const category of categories) {
    expect(chipByKey.get(category.id)?.count, `chip "${category.name}" for ${where}`).toBe(wanted.byId[category.id]);
  }
  const unknownSelected = view.category.kind === "unknown";
  if (wanted.unknown > 0 || unknownSelected) expect(chipByKey.get("unknown")?.count, `Category unavailable chip for ${where}`).toBe(wanted.unknown);
  else expect(chipByKey.has("unknown"), `no Category unavailable chip when nothing is unavailable for ${where}`).toBe(false);
  const chipTotal = [...chipByKey.values()].filter((c) => c.key !== "all").reduce((sum, c) => sum + c.count, 0);
  expect(chipTotal, `category chips add up to All for ${where}`).toBe(wanted.all);
  expect(
    screen.chips.filter((c) => c.pressed).map((c) => c.key),
    `pressed chip for ${where}`
  ).toEqual([chipKey(view.category)]);

  // The controls themselves show what is applied.
  expect(screen.stockPressed, `pressed stock button for ${where}`).toEqual([view.stock]);
  expect(screen.groupedOn, `Group by category switch for ${where}`).toBe(view.grouped);
  expect(screen.sortValue, `sort box for ${where}`).toBe(view.sort);

  // Filter chips and the Clear filters button.
  const words = filterWords(view, categories);
  const chipTexts = words.map((w) => w.replace(/^Search /, "Search: "));
  expect(screen.activeFilters, `active-filter chips for ${where}`).toEqual(chipTexts);
  expect(screen.clearFilters, `Clear filters button for ${where}`).toBe(words.length > 0);

  // The footer under the list repeats the numbers and says how many items the filters hide (exact words, singular included).
  if (visible.length > 0) {
    expect(screen.footer, `footer for ${where}`).toBe(expectedFooter(items.length, visible.length, view, categories));
  }
  // Never a stray NaN / undefined / null where a name or number belongs (a category id turned into a number printed "NaN").
  // (What the person typed is allowed to say anything, and the page quotes it, so it is taken out before the scan.)
  const typed = view.search.trim();
  const scanned = typed === "" ? screen.bodyText : screen.bodyText.split(typed).join("");
  expect(scanned, `a stray NaN/undefined/null is on screen for ${where}`).not.toMatch(/\b(NaN|undefined|null)\b/);

  // Empty state: exactly when nothing is left.
  if (visible.length === 0) {
    const empty = expectedEmpty(items.length, view, categories);
    expect(screen.empty, `an empty state for ${where}`).not.toBeNull();
    expect(screen.empty?.kind, `empty kind for ${where}`).toBe(empty.kind);
    expect(screen.empty?.title, `empty title for ${where}`).toBe(empty.title);
    expect(screen.footer, `no footer while empty for ${where}`).toBeNull();
  } else {
    expect(screen.empty, `no empty state when there are rows for ${where}`).toBeNull();
  }
  expect(screen.error, `no error notice for ${where}`).toBe(false);
  expect(screen.loading, `no skeleton for ${where}`).toBe(false);
  return screen;
}

// ── Keyboard ─────────────────────────────────────────────────────────────────────────────────────

/** A short name for what has keyboard focus: its data-testid, else tag#id, else "body". */
export async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "body";
    return el.getAttribute("data-testid") ?? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}`;
  });
}

/** Presses Tab (or Shift+Tab) until `target` has focus. Fails with the focus trail when it is not reachable. */
export async function tabTo(page: Page, target: Locator, options: { max?: number; backwards?: boolean } = {}): Promise<number> {
  const max = options.max ?? 120;
  const key = options.backwards ? "Shift+Tab" : "Tab";
  const trail: string[] = [];
  for (let presses = 0; presses <= max; presses += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return presses;
    trail.push(await focusedName(page));
    await page.keyboard.press(key);
  }
  throw new Error(`The keyboard (${key}) did not reach the control within ${max} presses. Focus visited: ${trail.slice(-12).join(" > ")}`);
}

/** True when the focused control shows some visible focus indicator (an outline or a ring). */
export async function hasFocusIndicator(control: Locator): Promise<boolean> {
  return control.evaluate((el) => {
    const style = getComputedStyle(el);
    const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 1;
    const ring = style.boxShadow !== "none" && style.boxShadow !== "";
    return outline || ring;
  });
}

// ── Layout ───────────────────────────────────────────────────────────────────────────────────────

/** How many pixels wider than the window the page is (0 = no sideways scroll), and which visible items poke out. */
export async function horizontalOverflow(page: Page): Promise<{ overflow: number; offenders: string[] }> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth - width;
    const offenders: string[] = [];
    const watched = document.querySelectorAll<HTMLElement>(
      '[data-testid^="item-card-"], [data-testid^="group-heading-"], [data-testid^="category-chip-"], [data-testid="inventory-summary"], [data-testid="order-bar"], [data-testid="inventory-error"], [data-testid="inventory-empty"], [data-testid="categories-error"]'
    );
    for (const el of Array.from(watched)) {
      if (!el.checkVisibility()) continue;
      const rect = el.getBoundingClientRect();
      if (rect.right > width + 1 || rect.left < -1) offenders.push(`${el.getAttribute("data-testid")} [${Math.round(rect.left)}..${Math.round(rect.right)}] of ${width}`);
    }
    return { overflow, offenders };
  });
}

export async function expectNoHorizontalScroll(page: Page, where: string): Promise<void> {
  const { overflow, offenders } = await horizontalOverflow(page);
  expect(overflow, `${where}: the page is ${overflow}px wider than the window`).toBeLessThanOrEqual(0);
  expect(offenders, `${where}: items outside the window`).toEqual([]);
}

/** Size of the thing a finger has to hit: the control itself, or its label when the control is a hidden-ish native input. */
export async function targetSize(control: Locator): Promise<{ width: number; height: number }> {
  const box = await control.boundingBox();
  if (box === null) throw new Error("control has no box (not visible?)");
  return { width: box.width, height: box.height };
}

/** How one long value sits in its row. */
export type ValueFit = {
  text: string;
  /** How many lines its text takes (1 = not wrapped). */
  lines: number;
  /** The element's own box holds its text (nothing sticks out of it). */
  fits: boolean;
  /** Every line of its text lies inside the row's box (nothing is drawn outside the row). */
  inside: boolean;
};

/**
 * Reads a value the way a person sees it: the lines its text is drawn on, and whether they stay inside the box and inside the
 * row. This is not the same as "the page does not scroll sideways": the lists clip what overflows them, so a name or code that
 * is not allowed to wrap is cut off at the edge, and the page itself is exactly as wide as before.
 */
export async function inspectValue(page: Page, rowId: number, selector: string): Promise<ValueFit | null> {
  return page.evaluate(
    ({ rowId: id, selector: css }): ValueFit | null => {
      const row = document.querySelector<HTMLElement>(`[data-testid="item-card-${id}"]`);
      const el = row?.querySelector<HTMLElement>(css) ?? null;
      if (!row || !el) return null;
      const rowBox = row.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      return {
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        lines: new Set(rects.map((r) => Math.round(r.top))).size,
        fits: el.scrollWidth <= el.clientWidth + 1,
        inside: rects.length > 0 && rects.every((r) => r.left >= rowBox.left - 1 && r.right <= rowBox.right + 1),
      };
    },
    { rowId, selector }
  );
}

/** The three free-text values of a row that can be arbitrarily long: its name, its barcode and its supplier order number. */
export async function inspectLongValues(page: Page, rowId: number): Promise<Record<"name" | "barcode" | "supplier order number", ValueFit | null>> {
  return {
    name: await inspectValue(page, rowId, `#item-name-${rowId}`),
    barcode: await inspectValue(page, rowId, `[data-testid="item-barcode-${rowId}"] dd`),
    "supplier order number": await inspectValue(page, rowId, `[data-testid="item-supplier-${rowId}"] dd span`),
  };
}

/**
 * Every visible control of the Inventory tab (links, buttons, fields, switches; a checkbox through its label, because the
 * square itself is only part of the target) that is smaller than `min` px in either direction. Empty = every control is big enough.
 */
export async function smallTouchTargets(page: Page, min = 39.5): Promise<string[]> {
  return page.evaluate((limit): string[] => {
    const root = document.querySelector('[data-testid="inventory-tab"]');
    if (!root) return ["the Inventory tab is not on the page"];
    const small: string[] = [];
    const seen = new Set<Element>();
    const controls = root.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, summary, [role="button"], [role="switch"], [role="checkbox"], [role="combobox"], [tabindex]:not([tabindex="-1"])'
    );
    for (const control of Array.from(controls)) {
      if (!control.checkVisibility()) continue;
      const isBox = control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio");
      const target: Element = isBox ? (control.closest("label") ?? control) : control;
      if (seen.has(target)) continue;
      seen.add(target);
      const box = target.getBoundingClientRect();
      if (box.width < limit || box.height < limit) {
        const label = control.getAttribute("data-testid") ?? control.getAttribute("aria-label") ?? (control.textContent ?? "").trim().slice(0, 30);
        small.push(`${label || control.tagName.toLowerCase()} is ${Math.round(box.width)}x${Math.round(box.height)}px`);
      }
    }
    return small;
  }, min);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

export type Dataset = { categories: Category[]; medications: Medication[] };

const baseItem = (id: number, name: string, categoryId: string | null, patch: Partial<Medication> = {}): Medication => ({
  id,
  name,
  barcode: `0${String(55500000000 + id).slice(0, 11)}`,
  photo_url: null,
  stock: 20,
  threshold: 10,
  vendor_url: null,
  unit: "units",
  notes: null,
  category_id: categoryId,
  supplier_order_number: null,
  is_unnamed: false,
  created_at: "2026-08-11T16:00:00+00:00",
  updated_at: "2026-10-28T16:02:00+00:00",
  ...patch,
});

export const EXTRA_CATEGORY_NAMES = ["Dental", "Eye & Ear Care", "Lab Supplies", "Empty shelf"] as const;

// ── The standard data: the shared seed plus a few DELIBERATE edge values it cannot show ──────────
// Without them every display fact would be the same on every row, so a bug that changes it for all rows (every supplier
// number upper-cased, every unit written "units", a status that is wrong exactly at the threshold) could not be told from
// correct behaviour. Each value below is asserted by name in the spec, and the oracle reads the data, so the matrices see them too.

/** Shown exactly as stored: lower-case and upper-case letters, a digit and a dash. */
export const MIXED_CASE_SUPPLIER = "ab-12Cd";
export const MIXED_CASE_ITEM = "Loratadine 10 mg"; // Allergy & Cold; the shared seed gives it no supplier order number
/** Stock equals the threshold (20 / 20): the status is Low, the Low filter lists it, the alert and the Low Stock card count it. */
export const AT_THRESHOLD_ITEM = "Aspirin 81 mg"; // Pain & Fever; the shared seed has 60 / 20
/** One above the threshold (26 / 25): the status is OK. */
export const ABOVE_THRESHOLD_ITEM = "Surgical masks"; // PPE & Gloves; the shared seed has 80 / 25
/** Counted in boxes: the stock line reads "24 boxes", not "24 units". */
export const BOXES_ITEM = "Nitrile gloves, M"; // PPE & Gloves; stock 24
export const BOXES_UNIT = "boxes";

export function browseMedications(shape: IdShape): Medication[] {
  return buildMedications({ shape }).map((item): Medication => {
    const name = item.name ?? "";
    if (name.startsWith(MIXED_CASE_ITEM)) return { ...item, supplier_order_number: MIXED_CASE_SUPPLIER };
    if (name.startsWith(AT_THRESHOLD_ITEM)) return { ...item, stock: 20, threshold: 20 };
    if (name.startsWith(ABOVE_THRESHOLD_ITEM)) return { ...item, stock: 26, threshold: 25 };
    if (name.startsWith(BOXES_ITEM)) return { ...item, unit: BOXES_UNIT };
    return item;
  });
}

export function browseData(shape: IdShape): Dataset {
  return { categories: buildCategories(shape), medications: browseMedications(shape) };
}

/**
 * The seed data plus four more categories (10 in all, so 12 chips: a phone shows the category button instead of the chip rows).
 * "Dental", "Eye & Ear Care" and "Lab Supplies" hold one item each; "Empty shelf" holds none.
 */
export function manyCategories(shape: IdShape): Dataset {
  const categories = buildCategories(shape);
  const extraIds = EXTRA_CATEGORY_NAMES.map((_, i) => (shape === "uuid" ? fakeUuid(60 + i) : String(60 + i)));
  EXTRA_CATEGORY_NAMES.forEach((name, i) => categories.push({ id: extraIds[i], name, created_at: "2026-11-01T12:00:00+00:00" }));
  const medications = browseMedications(shape);
  medications.push(
    baseItem(900, "Dental floss, waxed", extraIds[0], { supplier_order_number: "DNT-01" }),
    baseItem(901, "Saline eye wash, 118 mL", extraIds[1], { stock: 3, threshold: 8 }),
    baseItem(902, "Specimen cups, 4 oz", extraIds[2], { supplier_order_number: "00-SPC" })
  );
  return { categories, medications };
}

/** The seed items with some uncategorized and categorized rows removed, so a chip can be empty. */
export function withoutUncategorized(shape: IdShape): Dataset {
  return { categories: buildCategories(shape), medications: browseMedications(shape).filter((m) => m.category_id !== null) };
}

/** Looks up a seed item by the start of its name (so no test depends on how the fixtures are numbered). */
export function seedByName(medications: readonly Medication[], prefix: string): Medication {
  const found = medications.find((m) => m.name?.startsWith(prefix));
  if (!found) throw new Error(`No item starts with "${prefix}".`);
  return found;
}

export function categoryByName(categories: readonly Category[], name: string): Category {
  const found = categories.find((c) => c.name === name);
  if (!found) throw new Error(`No category named "${name}".`);
  return found;
}

// ── The Admin screen, only to save a category change the way staff do ────────────────────────────

const clean = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Chooses a category by the name people read: a native <select>, or the searchable combobox that replaces it from 11 categories on. */
export async function chooseCategory(page: Page, name: string): Promise<void> {
  const control = page.getByTestId("category-select");
  await expect(control).toBeVisible();
  const native = await control.evaluate((el) => el instanceof HTMLSelectElement);
  if (native) {
    await control.selectOption({ label: name });
    return;
  }
  await control.click();
  await page.getByRole("option", { name: clean(name), exact: true }).click();
}

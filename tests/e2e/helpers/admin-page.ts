// Helpers for the Admin page browser tests (tests/e2e/admin.spec.ts).
//
// Locators use the data-testid values the Admin page defines (category-select, save-button, ...) plus labels and roles. Nothing here re-implements
// application logic: the helpers open pages, drive controls and read what a person (or a request body) can observe.
import { expect, type Locator, type Page } from "@playwright/test";
import type { Medication } from "@/lib/db";
import { STORAGE_KEY as ORDER_SHEET_STORAGE_KEY } from "@/lib/order-sheet/draft";
import { installMockApi, type MockApi, type MockApiOptions } from "./mock-api";

/** The dev server compiles a route the first time it is asked for it, so the first load of a page is allowed to be slow. */
const FIRST_LOAD_TIMEOUT_MS = 120_000;

/**
 * How long a screen may take to show its list or summary line. Raise it on a cold dev server. Lower it
 * (E2E_SLOW_MS=5000) to see quickly that the tests cannot pass on a build that lacks the feature, instead of waiting a
 * minute per test for an element that will never come.
 */
export const SLOW_MS = Number(process.env.E2E_SLOW_MS) || 60_000;

export type OpenAdminOptions = MockApiOptions & {
  /** Runs after the mock is installed and before the page loads: the place to inject failures or reshape the data. */
  beforeLoad?: (api: MockApi) => void | Promise<void>;
};

/** Installs the mocked /api/*, opens /admin and waits until the list (or its error / empty state) is on screen. */
export async function openAdmin(page: Page, options: OpenAdminOptions = {}): Promise<MockApi> {
  const { beforeLoad, ...mockOptions } = options;
  const api = await installMockApi(page, mockOptions);
  if (beforeLoad) await beforeLoad(api);
  await gotoAdmin(page);
  return api;
}

/** Loads /admin (again) on a page that already has the mock installed. Waits for the list's summary line. */
export async function gotoAdmin(page: Page): Promise<void> {
  await page.goto("/admin", { waitUntil: "domcontentloaded", timeout: FIRST_LOAD_TIMEOUT_MS });
  await expect(page.getByTestId("admin-summary")).toBeVisible({ timeout: SLOW_MS });
}

// ── The category field: a native <select>, or the searchable combobox that replaces it from 11 categories on ──

async function isNativeSelect(control: Locator): Promise<boolean> {
  return control.evaluate((el) => el instanceof HTMLSelectElement);
}

const clean = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Chooses a category by the name people read ("Antibiotics", "— Uncategorized —", "+ Create new category…"). */
export async function chooseCategory(page: Page, name: string): Promise<void> {
  const control = page.getByTestId("category-select");
  await expect(control).toBeVisible();
  if (await isNativeSelect(control)) {
    await control.selectOption({ label: name });
    return;
  }
  await control.click();
  await page.getByRole("option", { name, exact: true }).click();
}

/** The name the category field currently shows. */
export async function chosenCategory(page: Page): Promise<string> {
  const control = page.getByTestId("category-select");
  return clean(
    await control.evaluate((el) => {
      if (el instanceof HTMLSelectElement) return el.selectedOptions[0]?.textContent ?? "";
      if (el instanceof HTMLInputElement) return el.value;
      return "";
    })
  );
}

/** Every choice the category field offers, in order. (A combobox is opened to read them and closed again.) */
export async function categoryChoices(page: Page): Promise<string[]> {
  const control = page.getByTestId("category-select");
  if (await isNativeSelect(control)) return (await control.locator("option").allTextContents()).map(clean);
  await control.click();
  const texts = (await page.getByTestId("category-select-listbox").getByRole("option").allTextContents()).map(clean);
  await control.press("Escape");
  return texts;
}

// ── The item form ────────────────────────────────────────────────────────────────────────────────

export type ItemFields = {
  name?: string;
  barcode?: string;
  supplier?: string;
  category?: string;
  unit?: string;
  stock?: string;
  threshold?: string;
  vendorUrl?: string;
  notes?: string;
};

/** Types into the fields that are given; the others are left as they are. */
export async function fillItemForm(page: Page, fields: ItemFields): Promise<void> {
  if (fields.name !== undefined) await page.getByTestId("name-input").fill(fields.name);
  if (fields.barcode !== undefined) await page.getByTestId("barcode-input").fill(fields.barcode);
  if (fields.supplier !== undefined) await page.getByTestId("supplier-order-number-input").fill(fields.supplier);
  if (fields.category !== undefined) await chooseCategory(page, fields.category);
  if (fields.unit !== undefined) await page.getByTestId("unit-input").fill(fields.unit);
  if (fields.stock !== undefined) await page.getByTestId("stock-input").fill(fields.stock);
  if (fields.threshold !== undefined) await page.getByTestId("threshold-input").fill(fields.threshold);
  if (fields.vendorUrl !== undefined) await page.getByTestId("vendor-url-input").fill(fields.vendorUrl);
  if (fields.notes !== undefined) await page.getByTestId("notes-input").fill(fields.notes);
}

/**
 * Puts `text` into a field the way a paste does: the old text is selected and the whole new text arrives in ONE insertion,
 * with no key presses. This is the route by which an input's `maxlength` would cut a long value off silently.
 */
export async function pasteInto(page: Page, testId: string, text: string): Promise<void> {
  const field = page.getByTestId(testId);
  await field.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
}

export async function openNewItemForm(page: Page): Promise<void> {
  await page.getByTestId("admin-add-button").click();
  await expect(page.getByTestId("admin-form")).toBeVisible();
  await expect(page.getByRole("heading", { name: "New Medication" })).toBeVisible();
}

export async function openEditForm(page: Page, medicationId: number): Promise<void> {
  await page.getByTestId(`admin-edit-${medicationId}`).click();
  await expect(page.getByTestId("admin-form")).toBeVisible();
  await expect(page.getByRole("heading", { name: /^(Edit|Complete unnamed item):/ })).toBeVisible();
}

export async function saveItem(page: Page): Promise<void> {
  await page.getByTestId("save-button").click();
}

// ── What was sent / what the mock database holds ─────────────────────────────────────────────────

/** The JSON body of the most recent request, as the page sent it. Fails the test when there was none. */
export function lastBody(api: MockApi, method: string, path: RegExp): Record<string, unknown> {
  const request = api.requestsTo(method, path).at(-1);
  if (!request) throw new Error(`The page never sent ${method} ${path}.`);
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    throw new Error(`The body of ${method} ${path} was not a JSON object.`);
  }
  return request.body as Record<string, unknown>;
}

/** The row the mock database holds for an item. Fails the test when it does not exist. */
export function stored(api: MockApi, id: number): Medication {
  const row = api.medications.find((m) => m.id === id);
  if (!row) throw new Error(`The mock database has no item ${id}.`);
  return row;
}

/** The row for a barcode (a created item has no known id up front). */
export function storedByBarcode(api: MockApi, barcode: string): Medication {
  const row = api.medications.find((m) => m.barcode === barcode);
  if (!row) throw new Error(`The mock database has no item with barcode ${barcode}.`);
  return row;
}

/** Every request that is not a plain read: what a visit changed, or tried to change. */
export function writes(api: MockApi): string[] {
  return api.requests.filter((r) => r.method !== "GET" && r.method !== "HEAD").map((r) => `${r.method} ${r.path}`);
}

export const PUT_ITEM = (id: number): RegExp => new RegExp(`/api/medications/${id}$`);
export const POST_ITEM = /\/api\/medications$/;

/**
 * Makes the mocked server behave like a database that ACCEPTS a save but keeps the old value for the chosen fields:
 * the request is rewritten (category_id / supplier_order_number set back to what the row held) before the mock handles
 * it, so the mock answers 200 with a row that does not carry what was sent. Returns the bodies the browser really sent.
 */
export async function serverIgnoresFields(
  page: Page,
  api: MockApi,
  spec: { category?: boolean; supplier?: boolean }
): Promise<Array<Record<string, unknown>>> {
  const sent: Array<Record<string, unknown>> = [];
  await page.route("**/api/medications**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const update = /^\/api\/medications\/(\d+)$/.exec(path);
    const isCreate = request.method() === "POST" && path === "/api/medications";
    if (!isCreate && !(request.method() === "PUT" && update)) return route.fallback();
    const body = request.postDataJSON() as Record<string, unknown>;
    sent.push(body);
    const current = update ? api.medications.find((m) => m.id === Number(update[1])) : undefined;
    const rewritten: Record<string, unknown> = { ...body };
    if (spec.category && "category_id" in rewritten) rewritten.category_id = current?.category_id ?? null;
    if (spec.supplier && "supplier_order_number" in rewritten) {
      rewritten.supplier_order_number = current?.supplier_order_number ?? null;
    }
    return route.fallback({ postData: JSON.stringify(rewritten) });
  });
  return sent;
}

/** A stock movement made on another screen (the Scan tab, the kiosk) while the Admin form is open. Returns the HTTP status. */
export async function dispenseFromAnotherScreen(page: Page, medicationId: number, quantity: number): Promise<number> {
  return page.evaluate(
    async ({ medicationId: id, quantity: qty }) => {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ medication_id: id, type: "dispense", quantity: qty }),
      });
      return res.status;
    },
    { medicationId, quantity }
  );
}

// ── Reading the page ─────────────────────────────────────────────────────────────────────────────

/** Ids of the items on screen, by test id prefix: "admin-row-" on the Admin list, "item-card-" on the Inventory tab. */
export async function visibleItemIds(page: Page, prefix: "admin-row-" | "item-card-"): Promise<number[]> {
  const ids = await page
    .locator(`[data-testid^="${prefix}"]:visible`)
    .evaluateAll(
      (elements, p) =>
        elements
          .map((el) => (el.getAttribute("data-testid") ?? "").slice(p.length))
          .filter((rest) => /^\d+$/.test(rest))
          .map(Number),
      prefix
    );
  return ids.sort((a, b) => a - b);
}

/** "Showing 9 of 27 items" -> { shown: 9, total: 27 }; "Showing all 27 items." -> { shown: 27, total: 27 }. */
export function parseCounts(summary: string): { shown: number; total: number } {
  const filtered = /Showing (\d+) of (\d+) items?/.exec(summary);
  if (filtered) return { shown: Number(filtered[1]), total: Number(filtered[2]) };
  const all = /Showing all (\d+) items?/.exec(summary);
  if (all) return { shown: Number(all[1]), total: Number(all[1]) };
  throw new Error(`Cannot read the item counts from "${summary}".`);
}

/** Describes the element that has keyboard focus: its data-testid, else tag#id. */
export async function focusedElement(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "body";
    return el.getAttribute("data-testid") ?? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}`;
  });
}

/** Errors the page itself raised (uncaught exceptions, React/Next console errors). Failed HTTP loads are expected in failure tests. */
export function watchRuntimeErrors(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (text.startsWith("Failed to load resource")) return;
    problems.push(`console.error: ${text}`);
  });
  return problems;
}

/**
 * How far the page is wider than the window, which elements stick out, and which elements HIDE part of their own content.
 * A phone must never scroll sideways, and it must never cut a value off either: a container that clips (overflow other than
 * visible) and holds content wider than itself keeps the page from scrolling while the reader loses the end of the text, so
 * "no sideways scroll" alone says nothing about long codes being readable. Fields (input, textarea, select) scroll their own
 * text by design, visually hidden text is hidden on purpose, and a cut with an ellipsis (the filter chips) keeps the whole
 * text in its title; none of those count.
 */
export async function horizontalOverflow(page: Page): Promise<{ overflow: number; offenders: string[]; clipped: string[] }> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const overflow = Math.max(doc.scrollWidth, document.body.scrollWidth) - doc.clientWidth;
    const describe = (el: Element): string => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}[${el.getAttribute("data-testid") ?? ""}]`;
    const offenders: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      if (el.closest(".sr-only") || el.closest("[hidden]")) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right > doc.clientWidth + 0.5 || box.left < -0.5) {
        offenders.push(`${describe(el)} ${Math.round(box.left)}..${Math.round(box.right)}`);
        if (offenders.length >= 8) break;
      }
    }
    const clipped: string[] = [];
    for (const el of [doc, document.body, ...Array.from(document.body.querySelectorAll("*"))]) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.closest(".sr-only")) continue;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (style.overflowX === "visible" || style.textOverflow === "ellipsis") continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        clipped.push(`${describe(el)} holds ${el.scrollWidth}px of content in a ${el.clientWidth}px box that cuts it off`);
        if (clipped.length >= 8) break;
      }
    }
    return { overflow, offenders, clipped };
  });
}

export async function expectNoHorizontalScroll(page: Page, where: string): Promise<void> {
  const { overflow, offenders, clipped } = await horizontalOverflow(page);
  expect(overflow, `${where}: the page is ${overflow}px wider than the window`).toBeLessThanOrEqual(0);
  expect(offenders, `${where}: elements outside the window`).toEqual([]);
  expect(clipped, `${where}: content that is cut off instead of wrapped`).toEqual([]);
}

export type TextFit = {
  /** Visible lines the text occupies (a value that does not fit on one line is only readable when this is above 1). */
  lines: number;
  left: number;
  right: number;
  viewportWidth: number;
  /** Ancestors that cut the text off: a box that clips (overflow other than visible) and ends before the text does. */
  cutOffBy: string[];
};

/**
 * Where the TEXT of an element really is on screen: how many lines it fills, how far left and right they reach, and which
 * clipping ancestors end before the text does. It measures the text itself (every text node, line by line), so a value that
 * is intact in the DOM but cut off by a container is told apart from one that wraps and can be read in full.
 */
export async function textFit(locator: Locator): Promise<TextFit> {
  return locator.evaluate((el) => {
    const rects: DOMRect[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.textContent ?? "").trim() === "") continue;
      if (node.parentElement?.closest(".sr-only")) continue; // visually hidden text is not on screen
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) if (rect.width > 0 && rect.height > 0) rects.push(rect);
    }
    const describe = (e: Element): string => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}[${e.getAttribute("data-testid") ?? ""}]`;
    const left = rects.length > 0 ? Math.min(...rects.map((r) => r.left)) : 0;
    const right = rects.length > 0 ? Math.max(...rects.map((r) => r.right)) : 0;
    const cutOffBy: string[] = [];
    for (let ancestor: Element | null = el; ancestor !== null; ancestor = ancestor.parentElement) {
      if (getComputedStyle(ancestor).overflowX === "visible") continue;
      const box = ancestor.getBoundingClientRect();
      if (rects.length > 0 && (right > box.right + 0.5 || left < box.left - 0.5)) {
        cutOffBy.push(`${describe(ancestor)} ends at ${Math.round(box.right)}px, the text reaches ${Math.round(right)}px`);
      }
    }
    return {
      lines: new Set(rects.map((r) => Math.round(r.top))).size,
      left,
      right,
      viewportWidth: document.documentElement.clientWidth,
      cutOffBy,
    };
  });
}

/**
 * Proves that a long value is READABLE IN FULL: its text sits inside the window, no clipping ancestor ends before it, and
 * (when `minLines` is given) it wraps over at least that many lines. Give `minLines` only for a value that cannot fit on
 * one line at this width: one line then means it was not wrapped.
 */
export async function expectReadableInFull(locator: Locator, what: string, options: { minLines?: number } = {}): Promise<void> {
  const fit = await textFit(locator);
  expect(fit.right, `${what}: no text was measured`).toBeGreaterThan(0);
  expect(fit.cutOffBy, `${what}: cut off instead of wrapped`).toEqual([]);
  expect(fit.left, `${what}: starts left of the window`).toBeGreaterThanOrEqual(-0.5);
  expect(fit.right, `${what}: runs past the right edge of the window (${fit.viewportWidth}px)`).toBeLessThanOrEqual(fit.viewportWidth + 0.5);
  if (options.minLines !== undefined) {
    expect(fit.lines, `${what}: should wrap over ${options.minLines}+ lines but sits on ${fit.lines}`).toBeGreaterThanOrEqual(options.minLines);
  }
}

/** True when the focused control shows some visible focus indicator (an outline or a ring). */
export async function hasVisibleFocusIndicator(control: Locator): Promise<boolean> {
  return control.evaluate((el) => {
    const style = getComputedStyle(el);
    const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 1 && style.outlineColor !== "rgba(0, 0, 0, 0)";
    const ring = style.boxShadow !== "none" && style.boxShadow !== "";
    return outline || ring;
  });
}

// ── The Admin list's own category filter (native select, or the combobox from 11 categories on) ────

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Filters the Admin list to one category by its name ("Antibiotics", "Uncategorized"); the choices read "Name (count)". */
export async function filterAdminByCategory(page: Page, name: string): Promise<void> {
  const control = page.getByTestId("admin-category-filter");
  await expect(control).toBeVisible();
  const label = new RegExp(`^${escapeRegExp(name)} \\(\\d+\\)$`);
  if (await isNativeSelect(control)) {
    const labels = (await control.locator("option").allTextContents()).map(clean);
    const found = labels.find((candidate) => label.test(candidate));
    if (found === undefined) throw new Error(`The category filter has no choice for "${name}": ${labels.join(" | ")}`);
    await control.selectOption({ label: found });
    return;
  }
  await control.click();
  await page.getByRole("option", { name: label }).click();
}

/** The label the Admin list's category filter shows right now ("All categories (27)", "Antibiotics (3)"), native select or combobox. */
export async function chosenAdminFilter(page: Page): Promise<string> {
  const control = page.getByTestId("admin-category-filter");
  return clean(
    await control.evaluate((el) => {
      if (el instanceof HTMLSelectElement) return el.selectedOptions[0]?.textContent ?? "";
      if (el instanceof HTMLInputElement) return el.value;
      return "";
    })
  );
}

/** The ids of the Admin list's rows in the order they appear on screen (top to bottom). */
export async function adminRowIdsInOrder(page: Page): Promise<number[]> {
  return page.locator('[data-testid^="admin-row-"]').evaluateAll((elements) =>
    elements
      .map((el) => (el.getAttribute("data-testid") ?? "").slice("admin-row-".length))
      .filter((rest) => /^\d+$/.test(rest))
      .map(Number)
  );
}

// ── The order sheet is only ever filled by a person (nothing is added automatically) ─────────────

/** How many items the browser's saved order-sheet draft holds. 0 when nothing was saved. Reads the key the app really uses. */
export async function orderSheetDraftRows(page: Page): Promise<number> {
  return page.evaluate((key) => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      return 0;
    }
    if (raw === null) return 0;
    try {
      const parsed: unknown = JSON.parse(raw);
      const rows = typeof parsed === "object" && parsed !== null ? (parsed as { rows?: unknown }).rows : undefined;
      return Array.isArray(rows) ? rows.length : 0;
    } catch {
      return 0;
    }
  }, ORDER_SHEET_STORAGE_KEY);
}

/** Saving or creating an item must not put anything on the order sheet. */
export async function expectOrderSheetUntouched(page: Page, when: string): Promise<void> {
  expect(await orderSheetDraftRows(page), `${when}: the item was put on the order sheet without anyone asking`).toBe(0);
}

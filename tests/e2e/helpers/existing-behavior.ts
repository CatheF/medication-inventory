// Helpers for the "existing behavior was preserved" browser specs (Scan tab, stock operations, Kiosk, Usage,
// resilience). Locators in these specs use visible text, roles and page structure only, so the SAME spec runs
// against the current app and against an older build of it, from before the category and order sheet features (point
// E2E_BASE_URL at that build). That is how it is shown that the behavior is preserved.
import { expect, type Locator, type Page } from "@playwright/test";
import type { Medication } from "@/lib/db";
import { buildMedications } from "../../helpers/fixtures";
import type { MockApi } from "./mock-api";

// ── Console hygiene ─────────────────────────────────────────────────────────────────────────────────────────

export type ExpectedNoise = {
  /**
   * "Failed to load resource" console lines are expected for these request URLs: requests the test makes fail on
   * purpose (Chromium logs every non-2xx answer and every aborted request).
   */
  failedLoads?: RegExp[];
  /** console.error texts the app writes on purpose in the situation under test (each use is explained at the call site). */
  consoleErrors?: RegExp[];
};

export type PageWatch = {
  /** Everything unexpected seen so far. `alsoAllowed` forgives extra lines for ONE assertion (the caller explains why). */
  problems(alsoAllowed?: RegExp[]): string[];
};

/**
 * Collects uncaught exceptions and console.error output of a page. Everything is a problem unless the test said
 * up front that it is expected. Warnings and info lines are not collected.
 */
export function watchPage(page: Page, expected: ExpectedNoise = {}): PageWatch {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    const url = message.location().url;
    if (/^Failed to load resource/.test(text) && (expected.failedLoads ?? []).some((pattern) => pattern.test(url))) return;
    if ((expected.consoleErrors ?? []).some((pattern) => pattern.test(text))) return;
    problems.push(`console.error: ${text.split("\n")[0]} (${url})`);
  });
  return { problems: (alsoAllowed = []) => problems.filter((line) => !alsoAllowed.some((pattern) => pattern.test(line))) };
}

// ── Request patterns ────────────────────────────────────────────────────────────────────────────────────────

export const MEDICATIONS_LIST = /\/api\/medications$/;
export const CATEGORIES_LIST = /\/api\/categories$/;
export const BARCODE_LOOKUP = /\/api\/medications\/barcode\/.+$/;
export const TRANSACTIONS = /\/api\/transactions$/;

// ── Synthetic data ──────────────────────────────────────────────────────────────────────────────────────────

/** Names of seed items (tests/helpers/fixtures.ts) the specs use, with what makes each one interesting. */
export const ITEM = {
  /** stock 18, threshold 40: low stock; numeric barcode with a leading zero */
  ibuprofen: "Ibuprofen 200 mg, tablets",
  /** stock 120, threshold 40: adequate; numeric barcode with a leading zero */
  acetaminophen: "Acetaminophen 500 mg, tablets",
  /** stock 60, threshold 20: alphanumeric barcode (MED-1003) */
  aspirin: "Aspirin 81 mg, chewable",
  /** stock 0: out of stock */
  nitrofurantoin: "Nitrofurantoin 100 mg, capsules",
  /** stock 4: the name contains a comma and double quotes */
  childrens: 'Acetaminophen 160 mg/5 mL, "children\'s" suspension',
} as const;

export function itemByName(items: Medication[], name: string): Medication {
  const found = items.find((m) => m.name === name);
  if (!found) throw new Error(`Fixture item not found: ${name}`);
  return found;
}

/** A fresh copy of the synthetic inventory (uuid category ids, the live-database shape). */
export function inventoryFixture(): Medication[] {
  return buildMedications({ shape: "uuid" });
}

/**
 * The synthetic inventory plus extra items: each is a copy of a plain seed item with `fields` laid over it
 * (no category, no supplier number, not flagged as unnamed). Their ids start at 9100.
 */
export function inventoryWith(extra: Partial<Medication>[]): Medication[] {
  const items = inventoryFixture();
  const template = itemByName(items, ITEM.aspirin);
  extra.forEach((fields, index) => {
    items.push({
      ...template,
      id: 9100 + index,
      name: `Extra item ${index + 1}`,
      category_id: null,
      supplier_order_number: null,
      is_unnamed: false,
      ...fields,
    });
  });
  return items;
}

/** The three numbers the Scan tab's stat cards must show for an inventory. */
export function expectedScanStats(items: Medication[]): { total: number; inStock: number; low: number } {
  return {
    total: items.length,
    inStock: items.filter((m) => m.stock > 0).length,
    low: items.filter((m) => m.stock <= m.threshold).length,
  };
}

// ── Page helpers (work on an older build of the app and on the current one) ─────────────────────────────────

/**
 * Opens a page of the app and waits until it has asked for the inventory and the categories: the page is then
 * hydrated and its key listener (physical scanner) is attached. Works whether the requests succeed, fail or abort.
 */
export async function openHome(page: Page, mock: MockApi, path = "/"): Promise<void> {
  await page.goto(path);
  await expect
    .poll(() => mock.requestsTo("GET", MEDICATIONS_LIST).length, { message: "the page asked for /api/medications" })
    .toBeGreaterThan(0);
  await expect
    .poll(() => mock.requestsTo("GET", CATEGORIES_LIST).length, { message: "the page asked for /api/categories" })
    .toBeGreaterThan(0);
}

/** The number on one Scan-tab stat card ("Total Items", "In Stock", "Low Stock"): the value paragraph above its label. */
export function statValue(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator("xpath=preceding-sibling::p[1]");
}

export function manualBarcodeBox(page: Page): Locator {
  return page.getByPlaceholder("Enter barcode manually...");
}

export async function lookupManually(page: Page, code: string): Promise<void> {
  await manualBarcodeBox(page).fill(code);
  await page.getByRole("button", { name: "Lookup", exact: true }).click();
}

/** Switches the Scan tab between its two stock modes. */
export async function chooseMode(page: Page, mode: "dispense" | "receive"): Promise<void> {
  await page.getByRole("button", { name: mode === "dispense" ? "▼ Dispense" : "▲ Receive" }).click();
}

export function quantityBox(page: Page): Locator {
  return page.locator('input[inputmode="numeric"]');
}

export function noteBox(page: Page): Locator {
  return page.getByPlaceholder("e.g. Patient ID, batch number...");
}

/** The line of the item card that reads "Current stock: 18 units". */
export function currentStock(page: Page): Locator {
  return page.getByText("Current stock:");
}

export async function openInventoryTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
}

export async function openScanTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Scan", exact: true }).click();
}

/** Takes keyboard focus away from whatever has it (a click on a button leaves that button focused). */
export async function dropFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
}

/**
 * Emulates a USB barcode scanner: the digits arrive as fast keystrokes, then Enter.
 *
 * Two situations, and a test must say which one it means:
 *  - default: nothing is focused (focus is dropped first). This is the situation an older build handles too, so the
 *    tests that also run against an older build use it.
 *  - `keepFocus: true`: the keystrokes go to whatever has focus right now, e.g. the tab button or the checkbox that
 *    staff clicked a moment before reaching for the scanner. That is how a scanner is really used, and an older build
 *    breaks in it (the scanner's Enter presses the focused button again), so only the tests of the current behavior use it.
 */
export async function scanWithKeyboard(page: Page, code: string, options: { keepFocus?: boolean } = {}): Promise<void> {
  if (options.keepFocus !== true) await dropFocus(page);
  await page.keyboard.type(code);
  await page.keyboard.press("Enter");
}

// ── Making races deterministic (no sleeps) ───────────────────────────────────────────────────────────────────

export type PageClock = {
  /** Pins the page's Date.now() at the current real time and returns that instant. Call after the page has loaded. */
  pin(): Promise<number>;
  /** Moves the pinned Date.now() to an exact instant (milliseconds since the epoch). */
  setTo(instant: number): Promise<void>;
};

/**
 * Puts the page's Date.now() under the test's control (it follows the real clock until pin()). The scanner's
 * double-read protection compares Date.now() values, so a test can say "the same label is read again 300 ms later"
 * exactly, however slow the machine is. Timers (setTimeout) are untouched. Call before page.goto.
 */
export async function controlPageClock(page: Page): Promise<PageClock> {
  await page.addInitScript(() => {
    const w = window as unknown as { __pinnedNow: number | null };
    w.__pinnedNow = null;
    const real = Date.now.bind(Date);
    Date.now = () => w.__pinnedNow ?? real();
  });
  return {
    pin: () =>
      page.evaluate(() => {
        const w = window as unknown as { __pinnedNow: number | null };
        const now = Date.now();
        w.__pinnedNow = now;
        return now;
      }),
    setTo: (instant) =>
      page.evaluate((value) => {
        (window as unknown as { __pinnedNow: number | null }).__pinnedNow = value;
      }, instant),
  };
}

/**
 * Records, inside the page and at the very moment the page calls fetch(), every request whose path matches `pattern`
 * ("GET /api/medications/barcode/0123"). Unlike the mock's own list (which fills when the request has crossed into the
 * test process), this is complete the instant a key press has been handled, so "the page asked for nothing" can be
 * asserted without waiting. Call before page.goto; the returned function reads the log.
 */
export async function recordPageFetches(page: Page, pattern: RegExp): Promise<() => Promise<string[]>> {
  await page.addInitScript((source: string) => {
    const w = window as unknown as { __fetchLog: string[] };
    w.__fetchLog = [];
    const wanted = new RegExp(source);
    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const path = new URL(request ? request.url : String(input), window.location.href).pathname;
      if (wanted.test(path)) w.__fetchLog.push(`${(init?.method ?? request?.method ?? "GET").toUpperCase()} ${path}`);
      return original(input, init);
    };
  }, pattern.source);
  return () => page.evaluate(() => (window as unknown as { __fetchLog: string[] }).__fetchLog);
}

/** From a recordPageFetches log over /api/medications: the barcode lookups the page made. */
export const lookupsIn = (log: string[]): string[] => log.filter((line) => line.startsWith("GET /api/medications/barcode/"));

/** From the same log: the requests that create something (saving a barcode that was not known). */
export const createsIn = (log: string[]): string[] => log.filter((line) => line.startsWith("POST "));

export type AnswerGate = {
  /** Lets every held request go on to the mock. */
  release(): void;
  /** How many requests have arrived at the gate so far. */
  arrived(): number;
};

/**
 * Holds back the answer to every request matching `urlGlob` until release(): the request is "in flight" for exactly as
 * long as the test wants. Install it AFTER installMockApi (the newest route runs first and hands on with fallback()).
 * Always release in a finally block so a failing test does not leave the page waiting.
 */
export async function holdAnswers(page: Page, urlGlob: string): Promise<AnswerGate> {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let arrived = 0;
  await page.route(urlGlob, async (route) => {
    arrived += 1;
    await opened;
    try {
      await route.fallback();
    } catch {
      // the test ended and the page is gone: nothing is waiting for this answer any more
    }
  });
  return { release: () => open(), arrived: () => arrived };
}

// ── Synthetic camera bookkeeping (needs Chromium's fake device flags, see the camera specs) ──────────────────

/** Counts, and keeps, every camera request the page makes: how it was asked and the stream it got. Call before page.goto. */
export async function trackCamera(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __streams: MediaStream[]; __cameraStarts: number; __cameraConstraints: unknown[] };
    w.__streams = [];
    w.__cameraStarts = 0;
    w.__cameraConstraints = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      w.__cameraStarts += 1;
      w.__cameraConstraints.push(constraints ?? null);
      const stream = await original(constraints);
      w.__streams.push(stream);
      return stream;
    };
  });
}

/** "live" / "ended" for every track of every stream the page was given, in the order they were handed out. */
export const cameraTrackStates = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks().map((t) => t.readyState)));

export const cameraStartCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __cameraStarts: number }).__cameraStarts);

/** The constraints object of every getUserMedia call, in order. */
export const cameraConstraints = (page: Page): Promise<unknown[]> =>
  page.evaluate(() => (window as unknown as { __cameraConstraints: unknown[] }).__cameraConstraints);

/** Which camera a getUserMedia request prefers ("environment" = the back camera of a phone), or null when it states no preference. */
export function requestedFacingMode(constraints: unknown): string | null {
  if (typeof constraints !== "object" || constraints === null) return null;
  const video = (constraints as { video?: unknown }).video;
  if (typeof video !== "object" || video === null) return null;
  const facing = (video as { facingMode?: unknown }).facingMode;
  if (typeof facing === "string") return facing;
  if (typeof facing === "object" && facing !== null) {
    const { exact, ideal } = facing as { exact?: unknown; ideal?: unknown };
    for (const candidate of [exact, ideal]) if (typeof candidate === "string") return candidate;
  }
  return null;
}

/**
 * True when the page is an older build of the app, from before the category and order sheet features: its top bar has
 * no "Order sheet" link. Only used to mark the few tests whose assertions describe an intentional improvement. Call it
 * on a page that shows the top bar (not on /kiosk).
 */
export async function isOriginalUi(page: Page): Promise<boolean> {
  return (await page.locator("body > nav").getByRole("link", { name: /^Order sheet/ }).count()) === 0;
}

/** Narrow type guard for request bodies the mock recorded as `unknown`. */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected an object request body, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

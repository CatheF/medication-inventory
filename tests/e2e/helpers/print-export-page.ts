// Browser-side helpers for tests/e2e/print-and-export.spec.ts: open the Order sheet with a seeded draft, read what the
// preview shows, find anything that would leak into print, and save a PDF the way the browser prints it.
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Medication } from "@/lib/db";
import { installMockApi } from "./mock-api";
import type { MockApi, MockApiOptions } from "./mock-api";

/** The localStorage key the order-sheet draft lives under (the same key the app documents; a change would be a breaking change). */
export const DRAFT_KEY = "medinventory.orderSheet.v1";

export type DraftSeed = {
  rows: Array<{ id: number; qty?: string; unit?: string }>;
  title?: string;
  /** a YYYY-MM-DD date, or null for "today"; omitted = 2026-11-05 so the printed date is deterministic */
  date?: string | null;
  preparedBy?: string;
  notes?: string;
  showOnHand?: boolean;
  showBarcode?: boolean;
  paper?: "letter" | "a4";
};

export const FIXED_DATE = "2026-11-05";

export function draftJson(seed: DraftSeed): string {
  return JSON.stringify({
    version: 1,
    rows: seed.rows.map((r) => ({ id: r.id, qty: r.qty ?? "", unit: r.unit ?? "" })),
    title: seed.title ?? "Supply order",
    date: seed.date === undefined ? FIXED_DATE : seed.date,
    preparedBy: seed.preparedBy ?? "",
    notes: seed.notes ?? "",
    showOnHand: seed.showOnHand ?? false,
    showBarcode: seed.showBarcode ?? false,
    paper: seed.paper ?? "letter",
  });
}

export type OpenOptions = {
  medications: Medication[];
  /** null or omitted = no saved draft (an empty sheet) */
  draft?: DraftSeed | null;
  mock?: Omit<MockApiOptions, "medications">;
};

/**
 * Opens /order-sheet with the mock API installed and (optionally) a draft already in this browser's storage. Resolves
 * when the sheet is on screen (the preview only renders once the page mounted AND the inventory has loaded).
 */
export async function openOrderSheet(page: Page, options: OpenOptions): Promise<MockApi> {
  const api = await installMockApi(page, { ...options.mock, medications: options.medications });
  if (options.draft) {
    await page.addInitScript(
      ([key, value]) => {
        try {
          // only seed once, so a reload in the middle of a test keeps what the person did since
          if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
        } catch {
          /* storage unavailable: the test will fail on its own assertions */
        }
      },
      [DRAFT_KEY, draftJson(options.draft)] as const
    );
  }
  await page.goto("/order-sheet", { waitUntil: "load", timeout: 120_000 });
  await expect(page.getByTestId("sheet-preview")).toBeVisible({ timeout: 60_000 });
  return api;
}

/**
 * Opens /order-sheet with a saved draft while the inventory is NOT available: "error" = every GET /api/medications answers
 * 503, "loading" = the answer is held back until `release()` is called. Resolves once the page shows that state (the load-error
 * notice or the loading skeleton). The sheet preview does not exist in either state.
 */
export async function openOrderSheetUnready(
  page: Page,
  options: { medications: Medication[]; draft: DraftSeed; state: "error" | "loading" }
): Promise<{ api: MockApi; release: () => void }> {
  const api = await installMockApi(page, { medications: options.medications });
  await page.addInitScript(
    ([key, value]) => {
      try {
        if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      } catch {
        /* storage unavailable: the test will fail on its own assertions */
      }
    },
    [DRAFT_KEY, draftJson(options.draft)] as const
  );
  let release: () => void = () => undefined;
  if (options.state === "error") {
    api.failNext({ method: "GET", path: /\/api\/medications$/, status: 503, body: { error: "Can’t reach the database." }, times: 50 });
  } else {
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // registered after the mock, so it runs first and hands the request on to the mock once the gate opens
    await page.route("**/api/medications", async (route) => {
      await gate;
      await route.fallback();
    });
  }
  await page.goto("/order-sheet", { waitUntil: "load", timeout: 120_000 });
  await expect(page.getByTestId(options.state === "error" ? "sheet-error" : "sheet-loading")).toBeVisible({ timeout: 60_000 });
  return { api, release };
}

/**
 * Replaces the rows of the saved draft with `ids` (blank quantity and unit) and tells the open page, the way a second tab
 * does. Much faster than reloading the page for every row count. The window event "medinventory:orderDraft" is the
 * documented same-tab update signal of the draft store (SPEC 2.8). Resolves once the builder lists exactly these rows.
 */
export async function setDraftRows(page: Page, ids: number[]): Promise<void> {
  await page.evaluate(
    ([key, rowIds]) => {
      const draft = JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
      draft.rows = rowIds.map((id) => ({ id, qty: "", unit: "" }));
      window.localStorage.setItem(key, JSON.stringify(draft));
      window.dispatchEvent(new Event("medinventory:orderDraft"));
    },
    [DRAFT_KEY, ids] as const
  );
  await expect(page.locator("[data-testid^=sheet-row-]")).toHaveCount(ids.length);
}

export type PreviewReading = {
  title: string;
  dateLine: string;
  preparedByLine: string;
  headers: string[];
  /** the item rows, each as the text of its cells (the notes row and the "no items" row are not included) */
  rows: string[][];
  notes: string;
  emptyMessage: string;
  footer: string;
};

/** What the on-screen "paper" shows: the same element the browser prints. Read from the DOM, as text. */
export async function readPreview(page: Page): Promise<PreviewReading> {
  return page.getByTestId("sheet-preview").evaluate((sheet): PreviewReading => {
    const text = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    const table = sheet.querySelector("table");
    const headers = Array.from(table?.querySelectorAll("thead th") ?? []).map((th) => text(th));
    const rows: string[][] = [];
    let notes = "";
    let emptyMessage = "";
    for (const tr of Array.from(table?.querySelectorAll("tbody tr") ?? [])) {
      const cells = Array.from(tr.children);
      if (cells.length === 1 && (cells[0] as HTMLTableCellElement).colSpan > 1) {
        const value = text(cells[0]);
        if (value.startsWith("Notes to supplier:")) notes = (cells[0].textContent ?? "").trim();
        else emptyMessage = value;
        continue;
      }
      rows.push(cells.map((c) => (c.textContent ?? "").trim()));
    }
    return {
      title: text(sheet.querySelector("h3")),
      dateLine: text(Array.from(sheet.querySelectorAll("dl > div")).find((d) => text(d).startsWith("Date:")) ?? null),
      preparedByLine: text(Array.from(sheet.querySelectorAll("dl > div")).find((d) => text(d).startsWith("Prepared by:")) ?? null),
      headers,
      rows,
      notes,
      emptyMessage,
      footer: text(table?.querySelector("tfoot") ?? null),
    };
  });
}

/**
 * With print media emulated: everything that is rendered (non-zero box, not hidden) outside the printable sheet and that
 * carries text or is a control (button, link, field, nav, image, svg). An empty list means nothing but the sheet prints.
 * The Next.js development overlay (a dev-server-only element) is ignored; it does not exist in a production build.
 */
export async function renderedOutsideSheet(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sheet = document.querySelector(".print-sheet");
    if (!sheet) return ["(no .print-sheet element on the page)"];
    const ignored = new Set(["SCRIPT", "STYLE", "NEXTJS-PORTAL", "NEXT-ROUTE-ANNOUNCER", "TEMPLATE", "NOSCRIPT", "HEAD", "TITLE", "META", "LINK"]);
    const controls = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "NAV", "IMG", "SVG", "LABEL", "HEADER", "H1", "H2"]);
    const found: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      if (ignored.has(el.tagName.toUpperCase())) continue;
      if (sheet.contains(el) || el.contains(sheet)) continue;
      if (el.closest("nextjs-portal, next-route-announcer")) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const ownText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
      if (ownText || controls.has(el.tagName.toUpperCase())) {
        const label = (el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? (el.textContent ?? "").trim()).slice(0, 60);
        found.push(`<${el.tagName.toLowerCase()}> ${label}`);
      }
    }
    return found;
  });
}

/** Collects uncaught page errors and console errors so a test can assert that a flow ran without any. */
export function collectPageProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`[pageerror] ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`[console.error] ${message.text()}`);
  });
  return problems;
}

/**
 * Saves the page as a PDF the way the browser prints it: print media, the page's own @page size and margins win over
 * `format` (preferCSSPageSize), background graphics off (the print dialog's default). `format` is passed on purpose in
 * the "wrong" size by some tests: if the PDF still comes out in the sheet's own paper size, the page's CSS decided it.
 */
export async function savePdf(page: Page, file: string, options: { format?: "Letter" | "A4" } = {}): Promise<void> {
  // The Next.js dev-server overlay is not part of the product and would be repeated on every printed page.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.pdf({ path: file, preferCSSPageSize: true, printBackground: false, ...(options.format ? { format: options.format } : {}) });
}

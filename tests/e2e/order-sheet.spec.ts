// Browser tests of the MANUAL order sheet: choosing items, typing quantities, keeping the draft, and never having side
// effects. Requirements: TASK.md sections 3, 4, 5 and 9; SPEC.md 2.10 and 3.3. Print layout and workbook internals have
// their own package (e2e-print-export); here the export is only used to show that what staff typed arrives unchanged.
//
// Every /api/* call is answered by tests/e2e/helpers/mock-api.ts (no database), with synthetic data only.
// Run: E2E_BASE_URL=http://127.0.0.1:3100 CHROMIUM_PATH=<chromium> npx playwright test tests/e2e/order-sheet.spec.ts
import fs from "node:fs";
import { expect, type Locator, type Page } from "@playwright/test";
import type { Medication } from "@/lib/db";
import { buildCategories, buildMedications } from "../helpers/fixtures";
import { readXlsx, type XlsxWorkbook } from "../helpers/xlsx-reader";
// `test` with an automatic extra: a FAILED test also says so when the app server was showing its error overlay (see the helper).
import { test } from "./helpers/app-server-guard";
import { holdAnswers } from "./helpers/existing-behavior";
import { installMockApi, type MockApi } from "./helpers/mock-api";

// Without an action timeout a missing control would wait for the whole test timeout; this keeps failures quick and readable.
test.use({ actionTimeout: 10_000, navigationTimeout: 30_000 });

/** localStorage key of the draft (SPEC 2.8). The tests rely on it only to seed legacy/corrupt drafts and to read what was kept. */
const STORAGE_KEY = "medinventory.orderSheet.v1";

// ── Synthetic inventory ───────────────────────────────────────────────────────────────────────────────────────────
const MEDS = buildMedications();
const CATEGORIES = buildCategories();

function nameOf(item: Medication): string {
  if (item.name === null) throw new Error(`fixture item ${item.id} has no name`);
  return item.name;
}

function fixture(pattern: RegExp): Medication {
  const found = MEDS.find((m) => m.name !== null && pattern.test(m.name));
  if (found === undefined) throw new Error(`Synthetic fixture item not found: ${String(pattern)}`);
  return found;
}

const ACETAMINOPHEN = fixture(/^Acetaminophen 500 mg/); // supplier 00417-B, plenty in stock
const IBUPROFEN = fixture(/^Ibuprofen/); // supplier 0092, low (18 of 40)
const ASPIRIN = fixture(/^Aspirin/); // no supplier number
const CETIRIZINE = fixture(/^Cetirizine/); // Allergy & Cold, supplier CT-10
const AMOXICILLIN = fixture(/^Amoxicillin/); // Antibiotics, supplier AMX-500, plenty in stock
const AZITHROMYCIN = fixture(/^Azithromycin/); // Antibiotics, low
const NITROFURANTOIN = fixture(/^Nitrofurantoin/); // Antibiotics, out of stock, no supplier number
const THERMOMETER = fixture(/^Thermometer/); // uncategorized, no supplier number
const MULTIVITAMIN = fixture(/^Multi-vitamin/); // uncategorized, a 115-character name and a 37-character supplier number

function categoryIdByName(name: string): string {
  const found = CATEGORIES.find((c) => c.name === name);
  if (found === undefined) throw new Error(`Synthetic category not found: ${name}`);
  return found.id;
}

const isLow = (m: Medication): boolean => m.stock <= m.threshold;

/** A synthetic item with sensible defaults; override what the test is about. */
function mk(id: number, name: string | null, over: Partial<Medication> = {}): Medication {
  return {
    id,
    name,
    barcode: `HX-${id}`,
    photo_url: null,
    stock: 5,
    threshold: 10,
    vendor_url: null,
    unit: "units",
    notes: null,
    category_id: null,
    supplier_order_number: null,
    is_unnamed: name === null,
    created_at: "2026-08-11T16:00:00+00:00",
    updated_at: "2026-10-28T16:02:00+00:00",
    ...over,
  };
}

// ── Page helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
type StoredRow = { id: number; qty: string; unit: string; name?: string };
type StoredDraft = {
  version: number;
  rows: StoredRow[];
  title: string;
  date: string | null;
  preparedBy: string;
  notes: string;
  showOnHand: boolean;
  showBarcode: boolean;
  paper: string;
};

const navSheetLink = (page: Page): Locator => page.getByRole("navigation").getByRole("link", { name: /^Order sheet/ });
const orderBar = (page: Page): Locator => page.getByTestId("order-bar");

async function waitSheetReady(page: Page): Promise<void> {
  await expect(page.getByTestId("sheet-preview")).toBeVisible();
  await expect(page.getByTestId("sheet-loading")).toHaveCount(0);
}

async function openSheet(page: Page): Promise<void> {
  await page.goto("/order-sheet");
  await waitSheetReady(page);
}

async function openInventory(page: Page): Promise<void> {
  await page.goto("/?tab=inventory");
  await expect(page.getByTestId("inventory-summary")).toBeVisible();
}

/** Lets pending effects and renders flush (two animation frames): a condition, not a sleep. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  );
}

async function readDraft(page: Page): Promise<StoredDraft | null> {
  const raw = await page.evaluate((key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }, STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as StoredDraft);
}

/** The saved rows reduced to what staff typed (item, quantity, unit): the remembered item name is not what these tests are about. */
async function typedRows(page: Page): Promise<Array<{ id: number; qty: string; unit: string }>> {
  return ((await readDraft(page))?.rows ?? []).map(({ id, qty, unit }) => ({ id, qty, unit }));
}

async function sheetRowIds(page: Page): Promise<number[]> {
  return page
    .locator('[data-testid^="sheet-row-"]')
    .evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.rowId)));
}

/** The rows on screen with what the quantity and unit boxes show (the boxes are what a person sees and prints from). */
async function screenRows(page: Page): Promise<Array<{ id: number; qty: string; unit: string }>> {
  return page.locator('[data-testid^="sheet-row-"]').evaluateAll((items) =>
    items.map((item) => ({
      id: Number((item as HTMLElement).dataset.rowId),
      qty: item.querySelector<HTMLInputElement>('input[data-testid^="qty-input-"]')?.value ?? "",
      unit: item.querySelector<HTMLInputElement>('input[data-testid^="unit-input-"]')?.value ?? "",
    }))
  );
}

/** The sheet on screen and the draft kept in localStorage must say the same thing after every step. */
async function expectScreenMatchesDraft(page: Page): Promise<void> {
  expect(await screenRows(page), "the rows on screen are the rows of the saved draft").toEqual(await typedRows(page));
}

/** What the screen shows for the printed table: header cells, and the body rows (cell texts as a person sees them). */
async function previewHeaders(page: Page): Promise<string[]> {
  return page
    .getByTestId("sheet-preview")
    .locator("thead th")
    .evaluateAll((ths) => ths.map((th) => (th as HTMLElement).innerText.trim()));
}

async function previewRows(page: Page): Promise<string[][]> {
  return page
    .getByTestId("sheet-preview")
    .locator("tbody tr")
    .evaluateAll((trs) =>
      trs
        .filter((tr) => {
          const first = tr.firstElementChild as HTMLTableCellElement | null;
          return first !== null && first.colSpan === 1; // skips the "no items" row and the notes row
        })
        .map((tr) => Array.from(tr.children).map((td) => (td as HTMLElement).innerText.trim()))
    );
}

async function addFromSearch(page: Page, query: string, item: Medication): Promise<void> {
  await page.getByTestId("add-search").fill(query);
  await page.getByTestId(`add-result-${item.id}`).click();
}

async function seedDraft(
  page: Page,
  rows: Array<{ id: number; qty?: string; unit?: string }>,
  extra: Partial<Omit<StoredDraft, "rows" | "version">> = {}
): Promise<void> {
  const draft: StoredDraft = {
    version: 1,
    rows: rows.map((r) => ({ id: r.id, qty: r.qty ?? "", unit: r.unit ?? "" })),
    title: "Supply order",
    date: null,
    preparedBy: "",
    notes: "",
    showOnHand: false,
    showBarcode: false,
    paper: "letter",
    ...extra,
  };
  await page.addInitScript(
    ([key, payload]) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, payload);
    },
    [STORAGE_KEY, JSON.stringify(draft)] as const
  );
}

/** Replaces window.print with a counter: the browser's print dialog cannot be driven, but a call to it can be counted. */
async function stubPrint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __printCalls: number };
    w.__printCalls = 0;
    window.print = () => {
      w.__printCalls += 1;
    };
  });
}

async function printCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __printCalls?: number }).__printCalls ?? 0);
}

async function downloadXlsx(page: Page): Promise<{ filename: string; workbook: XlsxWorkbook }> {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-xlsx").click()]);
  const path = await download.path();
  return { filename: download.suggestedFilename(), workbook: readXlsx(new Uint8Array(fs.readFileSync(path))) };
}

type ExportBody = {
  title: string;
  date: string;
  preparedBy: string;
  notes: string;
  showOnHand: boolean;
  showBarcode: boolean;
  rows: Array<{ id: number; qty: string; unit: string }>;
};

function exportBodies(mock: MockApi): ExportBody[] {
  return mock.requestsTo("POST", /\/api\/order-sheet\/xlsx$/).map((r) => r.body as ExportBody);
}

/** Every request that is not a plain read, as "METHOD /path". */
function writes(mock: MockApi): string[] {
  return mock.requests.filter((r) => r.method !== "GET" && r.method !== "HEAD").map((r) => `${r.method} ${r.path}`);
}

function inventorySnapshot(mock: MockApi): string {
  return JSON.stringify({ medications: mock.medications, categories: mock.categories });
}

/** Records uncaught exceptions and console errors, so a crash or a React error cannot hide behind green assertions. */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  return errors;
}

/** Sets a flag on window whenever the "empty sheet" card (or its wording) is in the page, to catch a flash while loading. */
async function watchForEmptyFlash(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __emptyFlashes: number; __loadingSeen: boolean };
    w.__emptyFlashes = 0;
    w.__loadingSeen = false;
    const check = () => {
      if (document.querySelector('[data-testid="sheet-empty"]')) w.__emptyFlashes += 1;
      if (/No items on the order sheet yet/.test(document.body?.innerText ?? "")) w.__emptyFlashes += 1;
      if (document.querySelector('[data-testid="sheet-loading"]')) w.__loadingSeen = true;
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
  });
}

async function emptyFlashes(page: Page): Promise<{ flashes: number; loadingSeen: boolean }> {
  return page.evaluate(() => {
    const w = window as unknown as { __emptyFlashes: number; __loadingSeen: boolean };
    return { flashes: w.__emptyFlashes, loadingSeen: w.__loadingSeen };
  });
}

const row = (page: Page, item: Medication): Locator => page.getByTestId(`sheet-row-${item.id}`);

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("Order sheet: choosing what goes on it", () => {
  test("ticking 'Add to order sheet' on the Inventory tab puts exactly those items on the sheet, in the order ticked, and unticking takes one off", async ({
    page,
  }) => {
    await installMockApi(page);
    await openInventory(page);
    await expect(orderBar(page)).toHaveCount(0);
    await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet");

    await page.getByTestId(`order-checkbox-${CETIRIZINE.id}`).check();
    await page.getByTestId(`order-checkbox-${IBUPROFEN.id}`).check();
    await page.getByTestId(`order-checkbox-${AMOXICILLIN.id}`).check();
    await expect(orderBar(page)).toContainText("3 items on the order sheet");
    await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet (3 items)");

    await page.getByTestId(`order-checkbox-${IBUPROFEN.id}`).uncheck();
    await expect(orderBar(page)).toContainText("2 items on the order sheet");

    await page.getByTestId("order-bar-review").click();
    await expect(page).toHaveURL(/\/order-sheet$/);
    await waitSheetReady(page);
    await expect.poll(() => sheetRowIds(page)).toEqual([CETIRIZINE.id, AMOXICILLIN.id]);
    expect((await previewRows(page)).map((cells) => cells[0])).toEqual([nameOf(CETIRIZINE), nameOf(AMOXICILLIN)]);
    await expect(row(page, IBUPROFEN)).toHaveCount(0);
    await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet (2 items)");
  });

  test("finding an item in the sheet's own search adds nothing until Add is pressed, then adds exactly that item and says so", async ({
    page,
  }) => {
    await installMockApi(page);
    await openSheet(page);
    await expect(page.getByTestId("sheet-empty")).toBeVisible();

    await page.getByTestId("add-search").fill("ibuprofen");
    await expect(page.getByTestId(`add-result-${IBUPROFEN.id}`)).toBeVisible();
    await settle(page);
    // a search result is only a suggestion: the sheet is still empty
    expect(await sheetRowIds(page)).toEqual([]);
    await expect(page.getByTestId("sheet-empty")).toBeVisible();

    await page.getByTestId(`add-result-${IBUPROFEN.id}`).click();
    await expect.poll(() => sheetRowIds(page)).toEqual([IBUPROFEN.id]);
    await expect(page.getByTestId("add-status")).toContainText(`Added ${nameOf(IBUPROFEN)}`);
    await expect(page.getByTestId("sheet-empty")).toHaveCount(0);
    await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet (1 item)");
    await expect(page.getByTestId(`add-result-${IBUPROFEN.id}`)).toContainText("On sheet");
  });

  test("the sheet's search finds items by barcode and by supplier order number, and shows each result's category", async ({
    page,
  }) => {
    await installMockApi(page);
    await openSheet(page);

    // by supplier order number (typed exactly as stored, leading zeros and letters included)
    await page.getByTestId("add-search").fill("00417-B");
    const bySupplier = page.getByTestId(`add-result-${ACETAMINOPHEN.id}`);
    await expect(bySupplier).toBeVisible();
    await expect(bySupplier).toContainText("00417-B");
    await expect(bySupplier).toContainText("Pain & Fever");
    await expect(page.locator('[data-testid^="add-result-"]')).toHaveCount(1);

    // by barcode
    await page.getByTestId("add-search").fill(CETIRIZINE.barcode);
    const byBarcode = page.getByTestId(`add-result-${CETIRIZINE.id}`);
    await expect(byBarcode).toBeVisible();
    await expect(byBarcode).toContainText("Allergy & Cold");
    await expect(page.locator('[data-testid^="add-result-"]')).toHaveCount(1);

    // an item without a category says so (never a blank, never a made-up category)
    await page.getByTestId("add-search").fill("thermometer");
    await expect(page.getByTestId(`add-result-${THERMOMETER.id}`)).toContainText("Uncategorized");
    // and an item without a supplier number says "Not set"
    await expect(page.getByTestId(`add-result-${THERMOMETER.id}`)).toContainText("Not set");

    await page.getByTestId("add-search").fill("no such item anywhere");
    await expect(page.locator('[data-testid^="add-result-"]')).toHaveCount(0);
    await expect(page.getByText(/No items match/)).toBeVisible();
  });

  test("when the categories cannot be read (the live defect: an empty list, no error) a search result says 'Category unavailable', never 'Uncategorized'; a really uncategorized item still says so", async ({
    page,
  }) => {
    await installMockApi(page, { categoriesBlocked: true }); // GET /api/categories answers 200 with []
    await openSheet(page);
    await page.getByTestId("add-search").fill("cetirizine");
    const categorized = page.getByTestId(`add-result-${CETIRIZINE.id}`);
    await expect(categorized).toContainText("Category unavailable");
    await expect(categorized).not.toContainText("Uncategorized");
    await expect(categorized).not.toContainText("Allergy & Cold"); // no name is made up either

    await page.getByTestId("add-search").fill("thermometer");
    await expect(page.getByTestId(`add-result-${THERMOMETER.id}`)).toContainText("Uncategorized");
    await expect(page.getByTestId(`add-result-${THERMOMETER.id}`)).not.toContainText("Category unavailable");
  });

  test("when the category request fails with an error a search result says 'Category unavailable', never 'Uncategorized'", async ({ page }) => {
    const mock = await installMockApi(page);
    mock.failNext({ method: "GET", path: /\/api\/categories$/, status: 500, body: { error: "Unexpected database error." } });
    await openSheet(page);
    // the failing request has been answered (it is the one the page made), so the label below is the failed state, not "loading"
    await expect.poll(() => mock.requestsTo("GET", /\/api\/categories$/).length).toBeGreaterThan(0);
    await page.getByTestId("add-search").fill("cetirizine");
    const categorized = page.getByTestId(`add-result-${CETIRIZINE.id}`);
    await expect(categorized).toContainText("Category unavailable");
    await expect(categorized).not.toContainText("Uncategorized");

    await page.getByTestId("add-search").fill("thermometer");
    await expect(page.getByTestId(`add-result-${THERMOMETER.id}`)).toContainText("Uncategorized");
  });

  test("the sheet's search lists at most 8 matches and says how many more there are", async ({ page }) => {
    await installMockApi(page);
    await openSheet(page);
    const matching = MEDS.filter((m) => `${m.name ?? ""} ${m.barcode} ${m.supplier_order_number ?? ""}`.toLowerCase().includes("mg"));
    expect(matching.length).toBeGreaterThan(8); // precondition of this test

    await page.getByTestId("add-search").fill("mg");
    await expect(page.locator('[data-testid^="add-result-"]')).toHaveCount(8);
    await expect(page.getByText(`Showing 8 of ${matching.length} matches`)).toBeVisible();
    // a narrower search brings the rest within reach
    await page.getByTestId("add-search").fill("mg tablets");
    await expect(page.locator('[data-testid^="add-result-"]').first()).toBeVisible();
    expect(await page.locator('[data-testid^="add-result-"]').count()).toBeLessThanOrEqual(8);
  });

  test("opening the order sheet with nothing ticked shows the empty state even though many items are low on stock; nothing is added by itself", async ({
    page,
  }) => {
    const mock = await installMockApi(page);
    expect(MEDS.filter(isLow).length).toBeGreaterThan(5); // many items are low in this inventory

    await openSheet(page);
    await expect.poll(() => mock.requestsTo("GET", /\/api\/categories$/).length).toBeGreaterThan(0);
    await settle(page);
    await expect(page.getByTestId("sheet-empty")).toBeVisible();
    await expect(page.getByTestId("sheet-empty")).toContainText("No items on the order sheet yet");
    expect(await sheetRowIds(page)).toEqual([]);
    await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet");
    expect((await readDraft(page))?.rows ?? []).toEqual([]);
    // the printed sheet says so too, and printing/exporting is switched off with a reason
    await expect(page.getByTestId("sheet-preview")).toContainText("No items on this order sheet");
    await expect(page.getByTestId("print-button")).toBeDisabled();
    await expect(page.getByTestId("export-xlsx")).toBeDisabled();
    await expect(page.getByText("Add at least one item to print or download the sheet.")).toBeVisible();

    // the Inventory tab does not tick low-stock items either, not even while the Low filter is on
    await openInventory(page);
    await page.getByTestId("stock-filter-low").click();
    await expect(page.getByTestId("inventory-summary")).toContainText(`Showing ${MEDS.filter(isLow).length} of ${MEDS.length}`);
    await settle(page);
    await expect(page.locator('[data-testid^="order-checkbox-"]:checked')).toHaveCount(0);
    await expect(orderBar(page)).toHaveCount(0);
  });

  test("'Add all low-stock items' is an explicit button: it adds only items at or below their level that are not on the sheet yet, and says how many", async ({
    page,
  }) => {
    const gloves = mk(7001, "Gloves, exactly at the low level", { stock: 10, threshold: 10 }); // low: at the level
    const gauze = mk(7002, "Gauze, one above the level", { stock: 11, threshold: 10 }); // not low
    const masks = mk(7003, "Masks, below the level", { stock: 3, threshold: 10 }); // low
    const saline = mk(7004, "Saline, out of stock", { stock: 0, threshold: 10 }); // low
    const syringes = mk(7005, "Syringes, plenty", { stock: 500, threshold: 10 }); // not low
    const tape = mk(7006, "Tape, nothing in stock and no level set", { stock: 0, threshold: 0 }); // low: 0 <= 0
    const bandages = mk(7007, "Bandages, low and already on the sheet", { stock: 2, threshold: 10 }); // low, added by hand first
    const lowIds = [gloves, masks, saline, tape, bandages].map((m) => m.id);
    await installMockApi(page, { medications: [gloves, gauze, masks, saline, syringes, tape, bandages] });
    await openSheet(page);

    // by hand: one low item (with typed values) and one item that is not low
    await addFromSearch(page, "bandages", bandages);
    await page.getByTestId(`qty-input-${bandages.id}`).fill("5");
    await page.getByTestId(`unit-input-${bandages.id}`).fill("box");
    await addFromSearch(page, "syringes", syringes);
    await expect.poll(() => sheetRowIds(page)).toEqual([bandages.id, syringes.id]);
    // nothing else was added in the meantime
    await settle(page);
    expect(await sheetRowIds(page)).toEqual([bandages.id, syringes.id]);

    const button = page.getByRole("button", { name: "Add all low-stock items" });
    await expect(button).toBeVisible();
    await expect(page.getByText(/Nothing is added unless you press this button/)).toBeVisible();
    await button.click();

    const status = page.getByTestId("low-stock-status");
    await expect(status).toHaveAttribute("role", "status");
    await expect(status).toContainText("Added 4 low-stock items");
    await expect(status).toContainText("1 already on the sheet");
    const ids = await sheetRowIds(page);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect([...ids].sort((a, b) => a - b)).toEqual([...lowIds, syringes.id].sort((a, b) => a - b));
    await expect(row(page, gauze)).toHaveCount(0); // one above the level is not low
    // what staff typed before is untouched; the new rows start empty
    await expect(page.getByTestId(`qty-input-${bandages.id}`)).toHaveValue("5");
    await expect(page.getByTestId(`unit-input-${bandages.id}`)).toHaveValue("box");
    for (const id of [gloves.id, masks.id, saline.id, tape.id]) {
      await expect(page.getByTestId(`qty-input-${id}`)).toHaveValue("");
      await expect(page.getByTestId(`unit-input-${id}`)).toHaveValue("");
    }

    // pressing it again adds nothing and says why. The reason goes to the line under the search box: the message under the button,
    // with the Undo of the first press, stays (a double tap must not cost the way back; see the Undo tests below).
    await button.click();
    await expect(page.getByTestId("add-status")).toContainText("already on the sheet. Nothing was added.");
    await expect(status).toContainText("Added 4 low-stock items");
    expect(await sheetRowIds(page)).toHaveLength(lowIds.length + 1);
  });

  test("'Add all low-stock items' says so and adds nothing when no item is low", async ({ page }) => {
    const healthy = [mk(7101, "Plenty A", { stock: 50, threshold: 10 }), mk(7102, "Plenty B", { stock: 11, threshold: 10 })];
    await installMockApi(page, { medications: healthy });
    await openSheet(page);
    await page.getByTestId("add-low-stock").click();
    await expect(page.getByTestId("low-stock-status")).toContainText("No items are at or below their low-stock level.");
    await settle(page);
    expect(await sheetRowIds(page)).toEqual([]);
    await expect(page.getByTestId("sheet-empty")).toBeVisible();
  });

  test("adding an item that is already on the sheet never makes a second row: the sheet says so and points to the existing row", async ({
    page,
  }) => {
    await installMockApi(page);
    await openSheet(page);
    await addFromSearch(page, "Ibuprofen", IBUPROFEN);
    await expect.poll(() => sheetRowIds(page)).toEqual([IBUPROFEN.id]);

    const result = page.getByTestId(`add-result-${IBUPROFEN.id}`);
    await expect(result).toContainText("On sheet");
    await expect(result).toHaveAttribute("aria-disabled", "true");
    // The button is aria-disabled (not `disabled`): a person can still press it and is taken to the row. `force` only skips
    // Playwright's own "aria-disabled means not enabled" actionability check.
    await result.click({ force: true });
    await expect(page.getByTestId("add-status")).toContainText("Already on the sheet");
    await expect(row(page, IBUPROFEN)).toBeFocused();
    expect(await sheetRowIds(page)).toEqual([IBUPROFEN.id]);

    // the same item on the Inventory tab is already ticked; unticking and ticking again leaves exactly one row
    await openInventory(page);
    const checkbox = page.getByTestId(`order-checkbox-${IBUPROFEN.id}`);
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await expect.poll(async () => (await readDraft(page))?.rows.length).toBe(0);
    await checkbox.check();
    await expect.poll(async () => (await readDraft(page))?.rows.map((r) => r.id)).toEqual([IBUPROFEN.id]);
  });

  test("a saved draft that lists the same item twice shows it once, with the first quantity", async ({ page }) => {
    await installMockApi(page);
    await seedDraft(page, [
      { id: IBUPROFEN.id, qty: "4", unit: "box" },
      { id: CETIRIZINE.id },
      { id: IBUPROFEN.id, qty: "9", unit: "case" },
    ]);
    await openSheet(page);
    expect(await sheetRowIds(page)).toEqual([IBUPROFEN.id, CETIRIZINE.id]);
    await expect(page.getByTestId(`qty-input-${IBUPROFEN.id}`)).toHaveValue("4");
    await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet (2 items)");
    expect(await previewRows(page)).toHaveLength(2);
  });

  test("ticked items stay on the sheet when the Inventory filters hide them, and the order bar says how many are hidden", async ({
    page,
  }) => {
    await installMockApi(page);
    await openInventory(page);
    for (const item of [CETIRIZINE, AMOXICILLIN, THERMOMETER]) await page.getByTestId(`order-checkbox-${item.id}`).check();
    await expect(orderBar(page)).toContainText("3 items on the order sheet");
    await expect(orderBar(page)).not.toContainText("hidden");

    // Antibiotics shows Amoxicillin only of the three ticked items: the other two are hidden, not removed
    await page.getByTestId(`category-chip-${categoryIdByName("Antibiotics")}`).click();
    await expect(orderBar(page)).toContainText("3 items on the order sheet");
    await expect(orderBar(page)).toContainText("2 hidden by current filters");
    await expect(page.getByTestId(`order-checkbox-${AMOXICILLIN.id}`)).toBeChecked();

    // a search with no match hides all three
    await page.getByTestId("search-input").fill("zzz-no-such-item");
    await expect(page.getByTestId("inventory-empty")).toBeVisible();
    await expect(orderBar(page)).toContainText("3 hidden by current filters");

    // the sheet itself is not filtered: all three are there
    await page.getByTestId("order-bar-review").click();
    await waitSheetReady(page);
    await expect.poll(() => sheetRowIds(page)).toEqual([CETIRIZINE.id, AMOXICILLIN.id, THERMOMETER.id]);

    // back on the Inventory tab the filters are still on (it remembers them for this visit), so the bar still says what they hide;
    // clearing them shows all three ticked again
    await openInventory(page);
    await expect(orderBar(page)).toContainText("3 hidden by current filters");
    await page.getByTestId("clear-filters").click();
    for (const item of [CETIRIZINE, AMOXICILLIN, THERMOMETER]) await expect(page.getByTestId(`order-checkbox-${item.id}`)).toBeChecked();
    await expect(orderBar(page)).toContainText("3 items on the order sheet");
    await expect(orderBar(page)).not.toContainText("hidden");
  });

  test("'Add all' on a category adds only what that category shows under the current filters, says how many, and Undo takes off exactly those and nothing that was on the sheet before", async ({
    page,
  }) => {
    await installMockApi(page);
    // Cetirizine is on the sheet before anything else happens, with a quantity and unit typed by staff. It is plenty in stock,
    // so the Low filter below hides it: "Add all" and "Undo" must both leave it alone.
    await seedDraft(page, [{ id: CETIRIZINE.id, qty: "7", unit: "box" }]);
    await openInventory(page);
    await expect(page.getByTestId(`order-checkbox-${CETIRIZINE.id}`)).toBeChecked();
    await page.getByTestId("stock-filter-low").click(); // Antibiotics then shows Azithromycin and Nitrofurantoin only
    await expect(page.getByTestId(`order-checkbox-${CETIRIZINE.id}`)).toHaveCount(0); // hidden by the filter, still on the sheet
    await expect(orderBar(page)).toContainText("1 item on the order sheet");
    await expect(orderBar(page)).toContainText("1 hidden by current filters");
    const antibiotics = categoryIdByName("Antibiotics");
    await page.getByTestId(`group-add-all-${antibiotics}`).click();

    await expect(page.getByTestId("bulk-status")).toContainText("Added 2 items from Antibiotics to the order sheet.");
    await expect(orderBar(page)).toContainText("3 items on the order sheet"); // the earlier row plus the two that were added
    await expect(page.getByTestId(`order-checkbox-${AZITHROMYCIN.id}`)).toBeChecked();
    await expect(page.getByTestId(`order-checkbox-${NITROFURANTOIN.id}`)).toBeChecked();
    const afterAdd = await typedRows(page);
    expect(afterAdd[0]).toEqual({ id: CETIRIZINE.id, qty: "7", unit: "box" }); // the earlier row keeps its place and its typed values
    expect(afterAdd.slice(1).map((r) => r.id).sort()).toEqual([AZITHROMYCIN.id, NITROFURANTOIN.id].sort());
    expect(afterAdd.slice(1).every((r) => r.qty === "" && r.unit === "")).toBe(true); // the new rows start empty

    await page.getByTestId("bulk-undo").click();
    await expect(page.getByTestId("bulk-status")).toContainText("Undid adding 2 items."); // 2, not 3: only what "Add all" added
    await expect(page.getByTestId(`order-checkbox-${AZITHROMYCIN.id}`)).not.toBeChecked();
    await expect(page.getByTestId(`order-checkbox-${NITROFURANTOIN.id}`)).not.toBeChecked();
    await expect(orderBar(page)).toContainText("1 item on the order sheet");
    expect(await typedRows(page)).toEqual([{ id: CETIRIZINE.id, qty: "7", unit: "box" }]);

    // with the filter off again the earlier item is still ticked; Amoxicillin (plenty in stock, hidden by the filter) never was
    await page.getByTestId("stock-filter-all").click();
    await expect(page.getByTestId(`order-checkbox-${CETIRIZINE.id}`)).toBeChecked();
    await expect(page.getByTestId(`order-checkbox-${AMOXICILLIN.id}`)).not.toBeChecked();
    await expect(orderBar(page)).toContainText("1 item on the order sheet");
  });

  test("two-step 'Clear sheet' asks first, keeps everything on Keep items or Escape, and clears only the rows on confirm (no browser pop-up)", async ({
    page,
  }) => {
    let dialogs = 0;
    page.on("dialog", (dialog) => {
      dialogs += 1;
      void dialog.dismiss();
    });
    const mock = await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id, qty: "4", unit: "box" }, { id: CETIRIZINE.id }, { id: AMOXICILLIN.id }], {
      title: "Kept title",
    });
    const before = inventorySnapshot(mock);
    await openSheet(page);

    await page.getByTestId("clear-sheet").click();
    const question = page.getByRole("group", { name: /Remove all 3 items from this sheet\?/ });
    await expect(question).toBeVisible();
    expect(await sheetRowIds(page)).toHaveLength(3); // asking changes nothing
    await question.getByRole("button", { name: "Keep items" }).click();
    await expect(question).toHaveCount(0);
    await expect(page.getByTestId(`qty-input-${IBUPROFEN.id}`)).toHaveValue("4");

    await page.getByTestId("clear-sheet").click();
    await expect(question).toBeVisible();
    await question.getByRole("button", { name: "Keep items" }).press("Escape");
    await expect(question).toHaveCount(0);
    expect(await sheetRowIds(page)).toHaveLength(3);

    await page.getByTestId("clear-sheet").click();
    await page.getByTestId("clear-sheet-confirm").click();
    await expect(page.getByTestId("sheet-empty")).toBeVisible();
    expect(await sheetRowIds(page)).toEqual([]);
    await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet");
    expect((await readDraft(page))?.rows).toEqual([]);
    await expect(page.getByTestId("sheet-title")).toHaveValue("Kept title"); // only the rows are cleared
    expect(dialogs).toBe(0);
    expect(inventorySnapshot(mock)).toBe(before); // clearing a sheet never touches stock
    expect(writes(mock)).toEqual([]);
  });

  test("Remove takes an item off the sheet, says so, and moves the keyboard to the next row's Remove button; the item can be added again", async ({
    page,
  }) => {
    await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id }, { id: CETIRIZINE.id }, { id: AMOXICILLIN.id }]);
    await openSheet(page);

    await page.getByTestId(`remove-row-${CETIRIZINE.id}`).click();
    await expect.poll(() => sheetRowIds(page)).toEqual([IBUPROFEN.id, AMOXICILLIN.id]);
    // The message sits with its Undo (see the Undo tests below), under "Add all low-stock items"; the line under the search box
    // stays quiet, so one removal is announced once.
    await expect(page.getByTestId("low-stock-status")).toHaveText(`Removed ${nameOf(CETIRIZINE)}. 2 items left.`);
    await expect(page.getByTestId("add-status")).toHaveText("");
    await expect(page.getByTestId(`remove-row-${AMOXICILLIN.id}`)).toBeFocused();
    expect((await previewRows(page)).map((cells) => cells[0])).toEqual([nameOf(IBUPROFEN), nameOf(AMOXICILLIN)]);
    expect((await readDraft(page))?.rows.map((r) => r.id)).toEqual([IBUPROFEN.id, AMOXICILLIN.id]);
    await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet (2 items)");

    // it is an ordinary, addable item again (the choice was reversible)
    await page.getByTestId("add-search").fill("cetirizine");
    const result = page.getByTestId(`add-result-${CETIRIZINE.id}`);
    await expect(result).toContainText("Add");
    await expect(result).not.toHaveAttribute("aria-disabled", "true");
    await result.click();
    await expect.poll(() => sheetRowIds(page)).toEqual([IBUPROFEN.id, AMOXICILLIN.id, CETIRIZINE.id]);
  });

  test("the builder list, the 'Items on this sheet' count, the menu badge and the printed preview always agree on which items print and in what order, and searching never hides a row", async ({
    page,
  }) => {
    const quoted = fixture(/children's/); // Acetaminophen 160 mg/5 mL, "children's" suspension
    const inches = fixture(/^Gauze pads/); // Gauze pads 4"x4", sterile
    const accented = fixture(/^Crème antiseptique/); // non-ASCII letters and a percent sign
    await installMockApi(page);
    await openSheet(page);
    await addFromSearch(page, "ibuprofen", IBUPROFEN);
    await addFromSearch(page, "children", quoted);
    await addFromSearch(page, "gauze", inches);
    await addFromSearch(page, "cetirizine", CETIRIZINE);
    await addFromSearch(page, "antiseptique", accented);

    const expectAgreement = async (items: Medication[]) => {
      await expect.poll(() => sheetRowIds(page)).toEqual(items.map((item) => item.id));
      expect((await previewRows(page)).map((cells) => cells[0])).toEqual(items.map(nameOf));
      await expect(page.getByRole("heading", { name: /Items on this sheet/ })).toContainText(`(${items.length})`);
      await expect(navSheetLink(page)).toHaveAccessibleName(`Order sheet (${items.length} items)`);
      for (const item of items) await expect(row(page, item)).toContainText(nameOf(item)); // quotes and commas intact
    };
    await expectAgreement([IBUPROFEN, quoted, inches, CETIRIZINE, accented]);

    // typing in the search box to look for another item never filters or hides the rows that are already on the sheet
    await page.getByTestId("add-search").fill("nitrofurantoin");
    await expect(page.getByTestId(`add-result-${NITROFURANTOIN.id}`)).toBeVisible();
    await expectAgreement([IBUPROFEN, quoted, inches, CETIRIZINE, accented]);
    await page.getByTestId("add-search").fill("zzz no such item");
    await expectAgreement([IBUPROFEN, quoted, inches, CETIRIZINE, accented]);

    await page.getByTestId(`remove-row-${quoted.id}`).click();
    await expectAgreement([IBUPROFEN, inches, CETIRIZINE, accented]);
  });

  test("'Clear' in the Inventory order bar asks first, un-ticks everything only after confirming, and says stock is not changed; the menu link then opens the empty sheet", async ({
    page,
  }) => {
    const mock = await installMockApi(page);
    const before = inventorySnapshot(mock);
    await openInventory(page);
    for (const item of [CETIRIZINE, AMOXICILLIN]) await page.getByTestId(`order-checkbox-${item.id}`).check();

    await page.getByTestId("order-bar-clear").click();
    await expect(orderBar(page)).toContainText("Remove all 2 items from the order sheet?");
    await expect(orderBar(page)).toContainText("Stock is not changed");
    await expect(page.getByTestId(`order-checkbox-${CETIRIZINE.id}`)).toBeChecked(); // asking changes nothing
    await page.getByTestId("order-bar-clear-cancel").click();
    await expect(orderBar(page)).toContainText("2 items on the order sheet");
    await expect(page.getByTestId(`order-checkbox-${CETIRIZINE.id}`)).toBeChecked();

    await page.getByTestId("order-bar-clear").click();
    await page.getByTestId("order-bar-clear-confirm").click();
    await expect(page.locator('[data-testid^="order-checkbox-"]:checked')).toHaveCount(0);
    await expect(orderBar(page)).toHaveCount(0);
    await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet");
    expect((await readDraft(page))?.rows).toEqual([]);

    await navSheetLink(page).click();
    await expect(page).toHaveURL(/\/order-sheet$/);
    await expect(page.getByTestId("sheet-empty")).toBeVisible();
    expect(inventorySnapshot(mock)).toBe(before);
    expect(writes(mock)).toEqual([]);
  });

  test("'Clear' in the Inventory order bar clears the WHOLE sheet, including ticked items the current filters hide; the question names every item, and nothing stays ticked once the filters are off", async ({
    page,
  }) => {
    const mock = await installMockApi(page);
    const before = inventorySnapshot(mock);
    await seedDraft(page, [{ id: CETIRIZINE.id, qty: "3", unit: "case" }, { id: AMOXICILLIN.id }]);
    await openInventory(page);
    await page.getByTestId(`category-chip-${categoryIdByName("Antibiotics")}`).click(); // hides Cetirizine, which stays on the sheet
    await expect(page.getByTestId(`order-checkbox-${CETIRIZINE.id}`)).toHaveCount(0);
    await expect(orderBar(page)).toContainText("2 items on the order sheet");
    await expect(orderBar(page)).toContainText("1 hidden by current filters");

    await page.getByTestId("order-bar-clear").click();
    // the question is about the whole sheet (2), not about the one row that happens to be on screen
    await expect(orderBar(page)).toContainText("Remove all 2 items from the order sheet?");
    await page.getByTestId("order-bar-clear-confirm").click();

    await expect(orderBar(page)).toHaveCount(0); // no rows left: the bar is gone, not "1 item (1 hidden)"
    expect(await typedRows(page)).toEqual([]);
    await expect(page.getByTestId(`order-checkbox-${AMOXICILLIN.id}`)).not.toBeChecked();
    await page.getByTestId("clear-filters").click();
    await expect(page.locator('[data-testid^="order-checkbox-"]:checked')).toHaveCount(0); // the hidden one was cleared too
    await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet");
    await navSheetLink(page).click();
    await expect(page.getByTestId("sheet-empty")).toBeVisible();
    expect(inventorySnapshot(mock)).toBe(before);
    expect(writes(mock)).toEqual([]);
  });

  test("the empty sheet points to both ways of choosing items: the Inventory tab, and the search box on the same page", async ({ page }) => {
    await installMockApi(page);
    await openSheet(page);
    await expect(page.getByTestId("sheet-empty")).toBeVisible();
    await page.getByTestId("empty-find-item").click();
    await expect(page.getByTestId("add-search")).toBeFocused();
    await page.getByTestId("empty-inventory-link").click();
    await expect(page).toHaveURL(/\/\?tab=inventory$/);
    await expect(page.getByTestId("inventory-summary")).toBeVisible();
    await expect(page.getByTestId(`order-checkbox-${IBUPROFEN.id}`)).toBeVisible();
  });

  test("when the sheet is full (500 items) the page says so and never goes past 500", async ({ page }) => {
    test.setTimeout(120_000);
    const many = Array.from({ length: 520 }, (_, i) => mk(20_000 + i, `Bulk low item ${String(i).padStart(4, "0")}`, { stock: 0, threshold: 5 }));
    const extra = mk(29_999, "Zzz not yet on the sheet", { stock: 100, threshold: 5 });
    await installMockApi(page, { medications: [...many, extra] });
    await openSheet(page);

    await page.getByTestId("add-low-stock").click();
    const status = page.getByTestId("low-stock-status");
    await expect(status).toContainText("Added 500 low-stock items", { timeout: 30_000 });
    await expect(status).toContainText("The sheet is full (500 items)");
    await expect(status).toContainText("20 could not be added");
    expect((await readDraft(page))?.rows).toHaveLength(500);
    await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet (500 items)");

    // adding one more by hand is refused out loud, and the count stays at 500
    await page.getByTestId("add-search").fill("Zzz not yet");
    await page.getByTestId(`add-result-${extra.id}`).click();
    await expect(page.getByTestId("add-status")).toContainText("The sheet is full (500 items)");
    expect((await readDraft(page))?.rows).toHaveLength(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("Order sheet: quantities and units are typed by staff and kept apart from stock", () => {
  test("order quantity and unit start empty on every row, including items that are out of stock or below their low-stock level", async ({
    page,
  }) => {
    const mock = await installMockApi(page);
    await openSheet(page);
    await page.getByTestId("add-low-stock").click();
    const low = MEDS.filter(isLow);
    await expect(page.getByTestId("low-stock-status")).toContainText(`Added ${low.length} low-stock items`);
    expect(await sheetRowIds(page)).toHaveLength(low.length);
    expect(low.some((m) => m.stock === 0)).toBe(true); // out-of-stock items are among them

    for (const item of low) {
      await expect(page.getByTestId(`qty-input-${item.id}`)).toHaveValue("");
      await expect(page.getByTestId(`qty-input-${item.id}`)).toHaveAttribute("inputmode", "numeric");
      await expect(page.getByTestId(`unit-input-${item.id}`)).toHaveValue("");
      await expect(page.getByTestId(`unit-input-${item.id}`)).toHaveAttribute("placeholder", "e.g. box, case");
    }
    // the stored draft and the printed sheet agree: nothing was computed or prefilled
    expect((await readDraft(page))?.rows.every((r) => r.qty === "" && r.unit === "")).toBe(true);
    expect((await previewRows(page)).every((cells) => cells[2] === "" && cells[3] === "")).toBe(true);
    // an item that only has a barcode is shown under a plain stand-in name, never as a blank row
    const unnamed = MEDS.find((m) => m.name === null);
    if (unnamed === undefined) throw new Error("fixture has no unnamed item");
    await expect(row(page, unnamed)).toContainText(`Unnamed item (barcode ${unnamed.barcode})`);
    expect((await previewRows(page)).some((cells) => cells[0] === `Unnamed item (barcode ${unnamed.barcode})`)).toBe(true);
    // the page tells staff that the empty boxes are for them to fill in
    await expect(page.getByTestId("empty-qty-summary")).toContainText(`${low.length} rows have no order quantity yet`);
    expect(writes(mock)).toEqual([]);
  });

  test("typed quantity and unit reach the printed sheet and the Excel request exactly as typed, row by row, and nothing else is sent", async ({
    page,
  }) => {
    const mock = await installMockApi(page);
    await openSheet(page);
    await addFromSearch(page, "ibuprofen", IBUPROFEN);
    await addFromSearch(page, "cetirizine", CETIRIZINE);
    await addFromSearch(page, "aspirin", ASPIRIN);

    await page.getByTestId(`qty-input-${IBUPROFEN.id}`).fill("12");
    await page.getByTestId(`unit-input-${IBUPROFEN.id}`).fill("box (10 x 100)");
    await page.getByTestId(`qty-input-${CETIRIZINE.id}`).fill("3");
    await page.getByTestId(`unit-input-${CETIRIZINE.id}`).fill("case");
    // Aspirin is left blank on purpose: staff may fill it in by hand after printing

    expect(await previewRows(page)).toEqual([
      [nameOf(IBUPROFEN), "0092", "12", "box (10 x 100)"],
      [nameOf(CETIRIZINE), "CT-10", "3", "case"],
      [nameOf(ASPIRIN), "—", "", ""],
    ]);

    const { filename, workbook } = await downloadXlsx(page);
    expect(filename).toMatch(/^order-sheet-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const bodies = exportBodies(mock);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].rows).toEqual([
      { id: IBUPROFEN.id, qty: "12", unit: "box (10 x 100)" },
      { id: CETIRIZINE.id, qty: "3", unit: "case" },
      { id: ASPIRIN.id, qty: "", unit: "" },
    ]);
    // the request carries the staff's own values only: no stock, no calculated quantity
    for (const sent of bodies[0].rows) expect(Object.keys(sent).sort()).toEqual(["id", "qty", "unit"]);
    expect(bodies[0].showOnHand).toBe(false);
    expect(bodies[0].showBarcode).toBe(false);

    const table = workbook.sheet("Order sheet").table();
    expect(table.rows.map((r) => [r["Item"]?.text, r["Order qty"]?.text ?? "", r["Unit"]?.text ?? ""])).toEqual([
      [nameOf(IBUPROFEN), "12", "box (10 x 100)"],
      [nameOf(CETIRIZINE), "3", "case"],
      [nameOf(ASPIRIN), "", ""],
    ]);
  });

  test("a quantity that is not a whole number of 1 or more gets an inline error, keeps exactly what was typed, and blocks Print and Excel until it is fixed", async ({
    page,
  }) => {
    const mock = await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id }, { id: CETIRIZINE.id, qty: "6", unit: "box" }]);
    await openSheet(page);
    const qty = page.getByTestId(`qty-input-${IBUPROFEN.id}`);
    const rowError = row(page, IBUPROFEN).getByRole("alert");

    for (const typed of ["abc", "2.5", "-3", "0", "1,000", "12 boxes", "1e3", "٣"]) {
      await test.step(`typed "${typed}"`, async () => {
        await qty.fill(typed);
        await expect(qty).toHaveValue(typed); // never "fixed" for the person
        await expect(qty).toHaveAttribute("aria-invalid", "true");
        await expect(rowError).toBeVisible();
        await expect(rowError).toContainText(/digits only|enter 1 or more/i);
        await expect(page.getByTestId("invalid-qty-summary")).toContainText("1 row has an order quantity that isn’t valid");
        await expect(page.getByTestId("print-button")).toBeDisabled();
        await expect(page.getByTestId("export-xlsx")).toBeDisabled();
        await expect(page.getByText(/Fix the order quantity on 1 row first/)).toBeVisible();
        // the printed sheet does not guess a number for it, and the stored draft keeps the typed text
        expect((await previewRows(page))[0][2]).toBe("");
        expect((await readDraft(page))?.rows.find((r) => r.id === IBUPROFEN.id)?.qty).toBe(typed);
        // the other row is untouched
        await expect(page.getByTestId(`qty-input-${CETIRIZINE.id}`)).toHaveValue("6");
        await expect(row(page, CETIRIZINE).getByRole("alert")).toHaveCount(0);
      });
    }
    expect(mock.requestsTo("POST", /xlsx/)).toHaveLength(0); // nothing was exported while it was invalid

    await qty.fill("25");
    await expect(rowError).toHaveCount(0);
    await expect(qty).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("print-button")).toBeEnabled();
    await expect(page.getByTestId("export-xlsx")).toBeEnabled();
    expect((await previewRows(page))[0][2]).toBe("25");
  });

  test("the quantity box keeps every digit typed (a number of more than 9 digits is explained, never cut down to a valid one); spaces and leading zeros are accepted and print as the plain number", async ({
    page,
  }) => {
    await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id }, { id: CETIRIZINE.id }]);
    await openSheet(page);

    const first = page.getByTestId(`qty-input-${IBUPROFEN.id}`);
    await first.click();
    await first.pressSequentially("1234567890");
    await expect(first).toHaveValue("1234567890"); // the 10th digit is kept: what is shown is what is stored
    expect((await readDraft(page))?.rows[0].qty).toBe("1234567890");
    await expect(row(page, IBUPROFEN).getByRole("alert")).toHaveText("Too large. Enter 999,999,999 or less.");
    expect((await previewRows(page))[0][2]).toBe(""); // the printed sheet never shows a guessed number
    await first.fill("123456789"); // nine digits is still a valid quantity
    await expect(row(page, IBUPROFEN).getByRole("alert")).toHaveCount(0);
    expect((await previewRows(page))[0][2]).toBe("123456789");

    const second = page.getByTestId(`qty-input-${CETIRIZINE.id}`);
    await second.fill(" 007 ");
    await expect(second).toHaveValue(" 007 "); // the box keeps what was typed
    await expect(row(page, CETIRIZINE).getByRole("alert")).toHaveCount(0);
    expect((await previewRows(page))[1][2]).toBe("7");
    await expect(page.getByTestId("print-button")).toBeEnabled();
  });

  test("on-hand stock is shown read-only beside each row, apart from the order quantity, and typing a quantity or a unit never changes or converts it", async ({
    page,
  }) => {
    const mock = await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id }]);
    const before = inventorySnapshot(mock);
    await openSheet(page);
    const target = row(page, IBUPROFEN);

    await expect(target).toContainText(`On hand now: ${IBUPROFEN.stock} units`);
    // the only things staff can type in are the quantity and the unit: the on-hand figure is not a field
    expect(await target.getByRole("textbox").count()).toBe(2);
    await expect(target.locator("input").nth(0)).toHaveAttribute("data-testid", `qty-input-${IBUPROFEN.id}`);
    // desktop: the column headings name the three things separately
    await expect(page.getByText("Order quantity", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("On hand now", { exact: true }).first()).toBeVisible();

    await page.getByTestId(`qty-input-${IBUPROFEN.id}`).fill("5");
    await page.getByTestId(`unit-input-${IBUPROFEN.id}`).fill("boxes of 100");
    await expect(target).toContainText(`On hand now: ${IBUPROFEN.stock} units`); // unchanged, not "boxes", not converted
    await expect(target).not.toContainText(/On hand now:[^]*box/i);
    expect(inventorySnapshot(mock)).toBe(before); // the stock in the database did not move

    // phone width: the same separation, with the labels written out next to each value
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(target.getByText("Order quantity", { exact: true })).toBeVisible();
    await expect(target.getByText("Order unit", { exact: true })).toBeVisible();
    await expect(target.getByText(`On hand now: `)).toBeVisible();
    await expect(target.getByText(`${IBUPROFEN.stock} units`)).toBeVisible();
    const qtyBox = await page.getByTestId(`qty-input-${IBUPROFEN.id}`).boundingBox();
    const onHandBox = await target.getByText(`${IBUPROFEN.stock} units`).boundingBox();
    expect(qtyBox).not.toBeNull();
    expect(onHandBox).not.toBeNull();
    if (qtyBox && onHandBox) {
      const overlap = qtyBox.x < onHandBox.x + onHandBox.width && onHandBox.x < qtyBox.x + qtyBox.width && qtyBox.y < onHandBox.y + onHandBox.height && onHandBox.y < qtyBox.y + qtyBox.height;
      expect(overlap).toBe(false);
    }
  });

  test("on a 360 px phone the whole order sheet page fits the screen width, with a 115-character name, 64-character code, long typed text, an error message and both optional columns on, and every control stays on screen", async ({
    page,
  }) => {
    const long64 = `0042-${"ABCDEFGHIJ".repeat(5)}-LONGCODE`;
    const codeItem = mk(8601, "Item with the longest supplier order number allowed", { supplier_order_number: long64, barcode: "9".repeat(40) });
    await page.setViewportSize({ width: 360, height: 800 });
    await installMockApi(page, { medications: [...MEDS, codeItem] });
    // the missing row (99 999) shows its own message; the others are a short name, the longest name and the longest code
    await seedDraft(page, [{ id: IBUPROFEN.id }, { id: MULTIVITAMIN.id }, { id: codeItem.id }, { id: THERMOMETER.id }, { id: 99_999 }]);
    await openSheet(page);
    await page.getByTestId("show-on-hand").check();
    await page.getByTestId("show-barcode").check();
    await page.getByTestId(`unit-input-${MULTIVITAMIN.id}`).fill("cases of 24 bottles, assorted flavors");
    await page.getByTestId(`qty-input-${IBUPROFEN.id}`).fill("12 boxes"); // not a valid quantity: its message is a whole sentence
    await page.getByTestId("sheet-title").fill("A long sheet title for the autumn clinic supply order, second delivery");
    await page.getByTestId("sheet-notes").fill("Please deliver to the side door of the clinic building and call on arrival. ".repeat(3));
    await expect(row(page, IBUPROFEN).getByRole("alert")).toBeVisible();

    const widths = await page.evaluate(() => ({
      window: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth, // what is left of the window after a classic scroll bar, if the browser draws one
    }));
    expect(widths.window).toBe(360); // precondition: this really is a 360 px window
    // no sideways scrolling of the page (an ordinary vertical scroll is fine)
    expect(widths.scroll, `the page is ${widths.scroll}px wide in a ${widths.client}px window`).toBeLessThanOrEqual(widths.client);

    // and nothing is merely clipped out of sight: what staff press and type in begins and ends inside the screen
    const reachable: Array<[string, Locator]> = [
      ["quantity box of the long-named item", page.getByTestId(`qty-input-${MULTIVITAMIN.id}`)],
      ["unit box of the long-named item", page.getByTestId(`unit-input-${MULTIVITAMIN.id}`)],
      ["Remove button of the long-named item", page.getByTestId(`remove-row-${MULTIVITAMIN.id}`)],
      ["quantity box of the long-code item", page.getByTestId(`qty-input-${codeItem.id}`)],
      ["Remove button of the missing item", page.getByTestId("remove-row-99999")],
      ["search box", page.getByTestId("add-search")],
      ["sheet title box", page.getByTestId("sheet-title")],
      ["Print button", page.getByTestId("print-button")],
      ["Excel button", page.getByTestId("export-xlsx")],
    ];
    for (const [label, locator] of reachable) {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      if (box === null) throw new Error(`${label} has no box on screen`);
      expect(box.x, `${label} starts inside the screen`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${label} ends inside the screen`).toBeLessThanOrEqual(widths.client + 1);
    }
  });

  test("an item counted in tablets keeps its own stock unit next to the on-hand figure; the order unit typed beside it is a separate word and nothing is converted", async ({
    page,
  }) => {
    const bottle = mk(8301, "Vitamin C 500 mg, bottle", { stock: 40, threshold: 10, unit: "tablets", supplier_order_number: "VC-500" });
    const mock = await installMockApi(page, { medications: [bottle] });
    await seedDraft(page, [{ id: bottle.id }]);
    await openSheet(page);
    await expect(row(page, bottle)).toContainText("On hand now: 40 tablets");

    await page.getByTestId(`qty-input-${bottle.id}`).fill("2");
    await page.getByTestId(`unit-input-${bottle.id}`).fill("cases of 24 bottles");
    await expect(row(page, bottle)).toContainText("On hand now: 40 tablets"); // still tablets, still 40
    await page.getByTestId("show-on-hand").check();
    expect(await previewRows(page)).toEqual([["Vitamin C 500 mg, bottle", "VC-500", "2", "cases of 24 bottles", "40 tablets"]]);
    const { workbook } = await downloadXlsx(page);
    const first = workbook.sheet("Order sheet").table().rows[0];
    expect([first["Order qty"]?.text, first["Unit"]?.text, first["On hand"]?.text]).toEqual(["2", "cases of 24 bottles", "40 tablets"]);
    expect(mock.medications[0].stock).toBe(40);
    expect(mock.medications[0].unit).toBe("tablets");
  });

  test("a new sheet starts clean: only Item, Supplier order no., Order qty and Unit print; the on-hand and barcode columns are off; the page says nothing is calculated", async ({
    page,
  }) => {
    await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id }]);
    await openSheet(page);

    expect(await previewHeaders(page)).toEqual(["Item", "Supplier order no.", "Order qty", "Unit"]);
    await expect(page.getByTestId("show-on-hand")).not.toBeChecked();
    await expect(page.getByTestId("show-barcode")).not.toBeChecked();
    await expect(page.getByTestId("paper-letter")).toBeChecked();
    await expect(page.getByText("On-hand stock and order quantity are separate. Order quantity and unit are typed by staff; nothing is calculated.")).toBeVisible();

    // switching the on-hand column on adds it as its own column, after Unit, with the stock and its unit
    await page.getByTestId("show-on-hand").check();
    expect(await previewHeaders(page)).toEqual(["Item", "Supplier order no.", "Order qty", "Unit", "On hand"]);
    expect((await previewRows(page))[0]).toEqual([nameOf(IBUPROFEN), "0092", "", "", `${IBUPROFEN.stock} units`]);
    await page.getByTestId("show-on-hand").uncheck();
    expect(await previewHeaders(page)).toEqual(["Item", "Supplier order no.", "Order qty", "Unit"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("Order sheet: the draft is kept in this browser", () => {
  test("the draft (items, quantities, units and sheet details) is still there after a reload", async ({ page }) => {
    await installMockApi(page);
    await openSheet(page);
    await addFromSearch(page, "ibuprofen", IBUPROFEN);
    await addFromSearch(page, "cetirizine", CETIRIZINE);
    await page.getByTestId(`qty-input-${IBUPROFEN.id}`).fill("12");
    await page.getByTestId(`unit-input-${IBUPROFEN.id}`).fill("box");
    await page.getByTestId(`qty-input-${CETIRIZINE.id}`).fill("2");
    await page.getByTestId("sheet-title").fill("Clinic supplies, November");
    await page.getByTestId("sheet-prepared-by").fill("N. Nurse");
    await page.getByTestId("sheet-notes").fill("Deliver to the side door.\nCall on arrival.");
    await page.getByTestId("sheet-date").fill("2026-11-20");
    await page.getByTestId("show-on-hand").check();
    await page.getByTestId("show-barcode").check();
    await page.getByTestId("paper-a4").check();

    await page.reload();
    await waitSheetReady(page);
    await expect.poll(() => sheetRowIds(page)).toEqual([IBUPROFEN.id, CETIRIZINE.id]);
    await expect(page.getByTestId(`qty-input-${IBUPROFEN.id}`)).toHaveValue("12");
    await expect(page.getByTestId(`unit-input-${IBUPROFEN.id}`)).toHaveValue("box");
    await expect(page.getByTestId(`qty-input-${CETIRIZINE.id}`)).toHaveValue("2");
    await expect(page.getByTestId(`unit-input-${CETIRIZINE.id}`)).toHaveValue("");
    await expect(page.getByTestId("sheet-title")).toHaveValue("Clinic supplies, November");
    await expect(page.getByTestId("sheet-prepared-by")).toHaveValue("N. Nurse");
    await expect(page.getByTestId("sheet-notes")).toHaveValue("Deliver to the side door.\nCall on arrival.");
    await expect(page.getByTestId("sheet-date")).toHaveValue("2026-11-20");
    await expect(page.getByTestId("show-on-hand")).toBeChecked();
    await expect(page.getByTestId("show-barcode")).toBeChecked();
    await expect(page.getByTestId("paper-a4")).toBeChecked();
    await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet (2 items)");
    expect((await previewRows(page))[0].slice(0, 4)).toEqual([nameOf(IBUPROFEN), "0092", "12", "box"]);

    // and the Inventory tab agrees about which items are on the sheet
    await openInventory(page);
    await expect(page.getByTestId(`order-checkbox-${IBUPROFEN.id}`)).toBeChecked();
    await expect(page.getByTestId(`order-checkbox-${CETIRIZINE.id}`)).toBeChecked();
    await expect(page.getByTestId(`order-checkbox-${AMOXICILLIN.id}`)).not.toBeChecked();
    await expect(orderBar(page)).toContainText("2 items on the order sheet");
  });

  test("a second tab sees the same draft, and a change made in one tab appears in the other without reloading", async ({ context }) => {
    const first = await context.newPage();
    const second = await context.newPage();
    await installMockApi(first);
    await installMockApi(second);
    await openSheet(first);
    await expect(first.getByTestId("sheet-empty")).toBeVisible();
    await openInventory(second);

    // ticking in the second tab shows up in the first, live
    await second.getByTestId(`order-checkbox-${IBUPROFEN.id}`).check();
    await expect(first.getByTestId(`sheet-row-${IBUPROFEN.id}`)).toBeVisible();
    await expect(first.getByTestId("sheet-empty")).toHaveCount(0);
    await expect(navSheetLink(first)).toHaveAccessibleName("Order sheet (1 item)");

    // a quantity typed in the first tab is there when the second tab opens the sheet
    await first.getByTestId(`qty-input-${IBUPROFEN.id}`).fill("8");
    await first.getByTestId(`unit-input-${IBUPROFEN.id}`).fill("case");
    await second.getByTestId("order-bar-review").click();
    await waitSheetReady(second);
    await expect(second.getByTestId(`qty-input-${IBUPROFEN.id}`)).toHaveValue("8");
    await expect(second.getByTestId(`unit-input-${IBUPROFEN.id}`)).toHaveValue("case");

    // an item added in the second tab appears in the first
    await addFromSearch(second, "cetirizine", CETIRIZINE);
    await expect(first.getByTestId(`sheet-row-${CETIRIZINE.id}`)).toBeVisible();
    await expect(navSheetLink(first)).toHaveAccessibleName("Order sheet (2 items)");

    // removing in the second tab empties the first
    await second.getByTestId(`remove-row-${IBUPROFEN.id}`).click();
    await second.getByTestId(`remove-row-${CETIRIZINE.id}`).click();
    await expect(first.getByTestId("sheet-empty")).toBeVisible();

    // a tab opened later sees the current (empty) draft too
    const third = await context.newPage();
    await installMockApi(third);
    await openSheet(third);
    await expect(third.getByTestId("sheet-empty")).toBeVisible();
  });

  for (const variant of [
    {
      name: "the browser refuses to save (storage full)",
      block: () => {
        Storage.prototype.setItem = function () {
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        };
      },
    },
    {
      name: "the browser denies access to site storage",
      block: () => {
        Object.defineProperty(window, "localStorage", {
          configurable: true,
          get() {
            throw new DOMException("Access is denied for this document.", "SecurityError");
          },
        });
      },
    },
  ]) {
    test(`when ${variant.name}, the sheet still works for the whole visit and warns that it will not be kept`, async ({ page }) => {
      await page.addInitScript(variant.block);
      const mock = await installMockApi(page);
      await openInventory(page);
      await page.getByTestId(`order-checkbox-${IBUPROFEN.id}`).check();
      await expect(orderBar(page)).toContainText("1 item on the order sheet");
      await expect(page.getByTestId("order-bar-storage-warning")).toContainText("This browser is not saving your order sheet");

      await page.getByTestId("order-bar-review").click();
      await waitSheetReady(page);
      const warning = page.getByTestId("storage-warning");
      await expect(warning).toBeVisible();
      await expect(warning).toContainText("This browser is not saving your order sheet. It will be lost if you close or reload this page.");
      await expect(warning).toContainText("Download the Excel file or print it before you leave.");
      await expect(page.getByText("Your draft is saved in this browser only.")).toHaveCount(0); // never claim it is saved

      // everything still works in this visit
      await expect(row(page, IBUPROFEN)).toBeVisible();
      await addFromSearch(page, "cetirizine", CETIRIZINE);
      await page.getByTestId(`qty-input-${CETIRIZINE.id}`).fill("5");
      await expect(page.getByTestId(`qty-input-${CETIRIZINE.id}`)).toHaveValue("5");
      expect((await previewRows(page)).map((cells) => cells[2])).toEqual(["", "5"]);
      await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet (2 items)");
      const { workbook } = await downloadXlsx(page);
      expect(workbook.sheet("Order sheet").table().rows).toHaveLength(2);
      await expect(page.getByTestId("export-success")).toBeVisible();
      expect(exportBodies(mock)[0].rows.map((r) => r.id)).toEqual([IBUPROFEN.id, CETIRIZINE.id]);

      // as warned, a reload starts again with an empty sheet (nothing was saved, nothing is pretended)
      await page.reload();
      await waitSheetReady(page);
      await expect(page.getByTestId("sheet-empty")).toBeVisible();
    });
  }

  test("the sheet date starts as today, a chosen date is kept after a reload and used for the file name, and clearing it goes back to today", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date(2026, 2, 9, 10, 0, 0)); // 9 March 2026, 10:00 local time
    const mock = await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id }]);
    await openSheet(page);
    await expect(page.getByTestId("sheet-date")).toHaveValue("2026-03-09");
    await expect(page.getByTestId("sheet-preview")).toContainText("Mar 9, 2026");

    await page.getByTestId("sheet-date").fill("2026-03-15");
    await expect(page.getByTestId("sheet-preview")).toContainText("Mar 15, 2026");
    await page.reload();
    await waitSheetReady(page);
    await expect(page.getByTestId("sheet-date")).toHaveValue("2026-03-15");
    await expect(page.getByTestId("sheet-preview")).toContainText("Mar 15, 2026");

    const { filename } = await downloadXlsx(page);
    expect(filename).toBe("order-sheet-2026-03-15.xlsx");
    expect(exportBodies(mock)[0].date).toBe("2026-03-15");

    await page.getByTestId("sheet-date").fill("");
    await page.getByTestId("sheet-date").blur();
    await expect(page.getByTestId("sheet-date")).toHaveValue("2026-03-09");
    await expect(page.getByTestId("sheet-preview")).toContainText("Mar 9, 2026");
    expect((await readDraft(page))?.date).toBeNull(); // "today" is stored as no date, so the sheet follows the calendar
  });

  test("a date the sheet cannot use (year 0026 or 2100, typing mistakes) is not used: a message names the date the sheet keeps, and the typo is never saved, printed or exported", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date(2026, 2, 9, 10, 0, 0)); // 9 March 2026, 10:00 local time
    const mock = await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id }]);
    await openSheet(page);
    const date = page.getByTestId("sheet-date");
    const problem = page.getByTestId("sheet-date-error");
    await expect(date).toHaveValue("2026-03-09");
    await expect(problem).toHaveCount(0);

    for (const typo of ["0026-11-05", "2100-01-01"]) {
      await test.step(`typed ${typo}`, async () => {
        await date.fill(typo);
        await date.blur(); // the message waits until the person leaves the box (a year is typed digit by digit)
        await expect(problem).toBeVisible();
        await expect(problem).toHaveAttribute("role", "alert");
        await expect(problem).toContainText("That date is not used");
        await expect(problem).toContainText("The sheet still shows Mar 9, 2026");
        await expect(date).toHaveAttribute("aria-invalid", "true");
        // the printed sheet and the saved draft never took the typo
        await expect(page.getByTestId("sheet-preview")).toContainText("Mar 9, 2026");
        await expect(page.getByTestId("sheet-preview")).not.toContainText(typo.slice(0, 4));
        expect((await readDraft(page))?.date ?? null).toBeNull();
      });
    }

    // the file is made with the date the sheet shows, never with the typo
    const { filename } = await downloadXlsx(page);
    expect(filename).toBe("order-sheet-2026-03-09.xlsx");
    expect(exportBodies(mock)[0].date).toBe("2026-03-09");

    // a usable date takes the message away and is used
    await date.fill("2026-11-05");
    await expect(problem).toHaveCount(0);
    await expect(date).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("sheet-preview")).toContainText("Nov 5, 2026");
    expect((await readDraft(page))?.date).toBe("2026-11-05");
  });

  test("a damaged saved draft never breaks the page: it opens as an empty sheet, a half-good one keeps its good rows, and the next change saves a clean draft", async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    await installMockApi(page);
    const damaged = [
      "this is not json",
      "[]",
      "null",
      JSON.stringify({ version: 2, rows: [{ id: IBUPROFEN.id, qty: "1", unit: "x" }] }),
      JSON.stringify({ version: 1, rows: "nope" }),
      JSON.stringify({ version: 1, rows: [null, 7, "x", { id: "abc" }, { id: -4 }, { id: 1.5 }] }),
      '{"version":1,"rows":[{"id":',
    ];
    await page.goto("/order-sheet");
    await waitSheetReady(page);
    for (const payload of damaged) {
      await test.step(`saved text ${payload.slice(0, 40)}`, async () => {
        await page.evaluate(([key, text]) => window.localStorage.setItem(key, text), [STORAGE_KEY, payload] as const);
        await page.reload();
        await waitSheetReady(page);
        await expect(page.getByTestId("sheet-empty")).toBeVisible();
        expect(await sheetRowIds(page)).toEqual([]);
        await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet");
      });
    }

    // a draft with one good row among junk keeps the good row, exactly as typed
    const mixed = JSON.stringify({ version: 1, rows: [{ id: IBUPROFEN.id, qty: "4", unit: "box" }, { id: "abc" }, null] });
    await page.evaluate(([key, text]) => window.localStorage.setItem(key, text), [STORAGE_KEY, mixed] as const);
    await page.reload();
    await waitSheetReady(page);
    expect(await sheetRowIds(page)).toEqual([IBUPROFEN.id]);
    await expect(page.getByTestId(`qty-input-${IBUPROFEN.id}`)).toHaveValue("4");

    // the next change replaces whatever was stored with a clean draft
    await page.evaluate(([key, text]) => window.localStorage.setItem(key, text), [STORAGE_KEY, "this is not json"] as const);
    await page.reload();
    await waitSheetReady(page);
    await addFromSearch(page, "ibuprofen", IBUPROFEN);
    await expect.poll(async () => (await readDraft(page))?.rows.map((r) => r.id)).toEqual([IBUPROFEN.id]);
    expect(errors).toEqual([]);
  });

  test("when storage works the page says the draft is saved in this browser only, and shows no warning", async ({ page }) => {
    await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id }]);
    await openSheet(page);
    await expect(page.getByText("Your draft is saved in this browser only.")).toBeVisible();
    await expect(page.getByTestId("storage-warning")).toHaveCount(0);
    await openInventory(page);
    await expect(page.getByTestId("order-bar-storage-warning")).toHaveCount(0);
  });

  test("a saved draft never flashes an empty sheet while the inventory loads, and a sheet with no draft shows loading first and the empty state only after", async ({
    page,
  }) => {
    await watchForEmptyFlash(page);
    await installMockApi(page, { latencyMs: 800 });
    await seedDraft(page, [{ id: IBUPROFEN.id, qty: "4" }, { id: CETIRIZINE.id }]);
    await page.goto("/order-sheet");
    await expect(page.getByTestId("sheet-loading")).toBeVisible();
    await expect(page.getByTestId("sheet-empty")).toHaveCount(0);
    await expect(row(page, IBUPROFEN)).toBeVisible({ timeout: 15_000 });
    const withDraft = await emptyFlashes(page);
    expect(withDraft.loadingSeen).toBe(true);
    expect(withDraft.flashes).toBe(0);
    await expect(page.getByTestId(`qty-input-${IBUPROFEN.id}`)).toHaveValue("4");
  });

  test("a sheet with no draft shows the loading state first and the empty state only once the inventory has loaded", async ({ page }) => {
    await watchForEmptyFlash(page);
    await installMockApi(page, { latencyMs: 800 });
    await page.goto("/order-sheet");
    await expect(page.getByTestId("sheet-loading")).toBeVisible();
    await expect(page.getByTestId("sheet-empty")).toHaveCount(0);
    await expect(page.getByTestId("sheet-empty")).toBeVisible({ timeout: 15_000 });
    expect((await emptyFlashes(page)).loadingSeen).toBe(true);
  });

  test("when the inventory cannot be loaded the sheet says so with Retry, never shows an empty sheet, keeps the saved draft, and Retry brings the rows back", async ({
    page,
  }) => {
    const mock = await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id, qty: "4", unit: "box" }, { id: CETIRIZINE.id }]);
    mock.failNext({ method: "GET", path: /\/api\/medications$/, status: 500, body: { error: "Unexpected database error.", code: "XX000" } });
    await page.goto("/order-sheet");

    const error = page.getByTestId("sheet-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("Unexpected database error.");
    await expect(error).toContainText("This does not mean the inventory is empty.");
    await expect(error).toContainText("Your order sheet (2 items) is still saved in this browser.");
    await expect(page.getByTestId("sheet-empty")).toHaveCount(0);
    await expect(page.getByTestId("sheet-preview")).toHaveCount(0);
    await expect(page.getByTestId("print-button")).toHaveCount(0);
    expect((await readDraft(page))?.rows.map((r) => r.id)).toEqual([IBUPROFEN.id, CETIRIZINE.id]);

    // a second failure, this time with no answer at all, is also a message and not an empty sheet
    mock.failNext({ method: "GET", path: /\/api\/medications$/, networkError: true });
    await error.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("sheet-error")).toContainText("Can’t reach the server");
    await expect(page.getByTestId("sheet-empty")).toHaveCount(0);

    await page.getByTestId("sheet-error").getByRole("button", { name: "Retry" }).click();
    await waitSheetReady(page);
    expect(await sheetRowIds(page)).toEqual([IBUPROFEN.id, CETIRIZINE.id]);
    await expect(page.getByTestId(`qty-input-${IBUPROFEN.id}`)).toHaveValue("4"); // what was typed was never lost
    await expect(page.getByTestId(`unit-input-${IBUPROFEN.id}`)).toHaveValue("box");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("Order sheet: supplier numbers, barcodes and items that are gone", () => {
  test("an item deleted since it was ticked says 'No longer in inventory', can be removed, and is left out of the preview and the Excel file", async ({
    page,
  }) => {
    const mock = await installMockApi(page);
    await openInventory(page);
    for (const item of [CETIRIZINE, AMOXICILLIN, IBUPROFEN]) await page.getByTestId(`order-checkbox-${item.id}`).check();

    // the item is deleted elsewhere (Admin, another computer) before the sheet is opened
    mock.medications.splice(mock.medications.findIndex((m) => m.id === AMOXICILLIN.id), 1);
    await page.reload();
    await expect(page.getByTestId("inventory-summary")).toBeVisible();
    await expect(orderBar(page)).toContainText("1 no longer in the inventory");

    await page.getByTestId("order-bar-review").click();
    await waitSheetReady(page);
    await expect(row(page, AMOXICILLIN)).toContainText(/no longer in inventory/i);
    await expect(row(page, AMOXICILLIN)).toContainText(nameOf(AMOXICILLIN)); // says WHICH item it was
    await expect(page.getByTestId("missing-items-summary")).toContainText("1 item is no longer in the inventory.");
    expect(await sheetRowIds(page)).toEqual([CETIRIZINE.id, AMOXICILLIN.id, IBUPROFEN.id]);
    expect((await previewRows(page)).map((cells) => cells[0])).toEqual([nameOf(CETIRIZINE), nameOf(IBUPROFEN)]);
    await expect(page.getByTestId("print-button")).toBeEnabled(); // the other rows still print
    await expect(page.getByTestId("export-xlsx")).toBeEnabled();

    const { workbook } = await downloadXlsx(page);
    expect(exportBodies(mock)[0].rows.map((r) => r.id)).toEqual([CETIRIZINE.id, IBUPROFEN.id]);
    expect(workbook.sheet("Order sheet").table().rows.map((r) => r["Item"]?.text)).toEqual([nameOf(CETIRIZINE), nameOf(IBUPROFEN)]);

    // Remove takes the dead row off; the warning goes with it
    await page.getByTestId(`remove-row-${AMOXICILLIN.id}`).click();
    await expect(row(page, AMOXICILLIN)).toHaveCount(0);
    await expect(page.getByTestId("missing-items-summary")).toHaveCount(0);
    await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet (2 items)");
  });

  test("a saved row whose item is gone and whose name was never stored is still shown, flagged and removable; when every row is gone Print and Excel say why they are off", async ({
    page,
  }) => {
    await installMockApi(page);
    await seedDraft(page, [{ id: 99_999 }, { id: 99_998 }]);
    await openSheet(page);

    await expect(page.getByTestId("sheet-row-99999")).toContainText(/No longer in inventory/i);
    await expect(page.getByTestId("sheet-row-99999")).toContainText("99999");
    await expect(page.getByTestId("missing-items-summary")).toContainText("2 items are no longer in the inventory.");
    expect(await previewRows(page)).toEqual([]);
    await expect(page.getByTestId("sheet-preview")).toContainText("No items on this order sheet");
    await expect(page.getByTestId("print-button")).toBeDisabled();
    await expect(page.getByTestId("export-xlsx")).toBeDisabled();
    await expect(page.getByText(/None of the items on the sheet are in the inventory any more/)).toBeVisible();

    await page.getByTestId("remove-row-99999").click();
    await page.getByTestId("remove-row-99998").click();
    await expect(page.getByTestId("sheet-empty")).toBeVisible();
  });

  test("items without a supplier order number are flagged with a count but never block printing or exporting; they print as a dash, never as the barcode", async ({
    page,
  }) => {
    await stubPrint(page);
    const numericBarcode = mk(8001, "Numeric barcode, no supplier number", { barcode: "0123456789012" });
    const mock = await installMockApi(page, { medications: [...MEDS, numericBarcode] });
    await openSheet(page);
    await addFromSearch(page, "ibuprofen", IBUPROFEN); // has 0092
    await addFromSearch(page, "aspirin", ASPIRIN); // none
    await addFromSearch(page, "numeric barcode", numericBarcode); // none, but has a barcode full of digits

    await expect(page.getByTestId("missing-supplier-summary")).toContainText("2 items have no supplier order number");
    await expect(row(page, ASPIRIN)).toContainText("Not set");
    await expect(row(page, numericBarcode)).toContainText("Not set");
    await expect(row(page, IBUPROFEN)).not.toContainText("Not set");
    expect((await previewRows(page)).map((cells) => cells[1])).toEqual(["0092", "—", "—"]); // never the barcode

    // the warning is information, not a gate
    await expect(page.getByTestId("print-button")).toBeEnabled();
    await expect(page.getByTestId("export-xlsx")).toBeEnabled();
    await page.getByTestId("print-button").click();
    expect(await printCalls(page)).toBe(1);
    const { workbook } = await downloadXlsx(page);
    expect(exportBodies(mock)).toHaveLength(1);
    const supplierCells = workbook.sheet("Order sheet").table().rows.map((r) => r["Supplier order no."]?.text);
    expect(supplierCells).toEqual(["0092", "—", "—"]);

    // fixing it (a number appears in the inventory) removes the warning after a refresh of the page
    mock.medications.find((m) => m.id === ASPIRIN.id)!.supplier_order_number = "ASP-81";
    mock.medications.find((m) => m.id === numericBarcode.id)!.supplier_order_number = "NB-1";
    await page.reload();
    await waitSheetReady(page);
    await expect(page.getByTestId("missing-supplier-summary")).toHaveCount(0);
  });

  test("supplier order numbers like 00417-B, 0092, AX-1182/4, ab-12x/Z (mixed case) and a 64-character code appear exactly, in the builder, the printed sheet and the Excel file", async ({
    page,
  }) => {
    const long64 = `0042-${"ABCDEFGHIJ".repeat(5)}-LONGCODE`;
    expect(long64).toHaveLength(64);
    const codes: Array<{ item: Medication; code: string }> = [
      { item: mk(8101, "Code with letters and a dash", { supplier_order_number: "00417-B" }), code: "00417-B" },
      { item: mk(8102, "Code with leading zeros only", { supplier_order_number: "0092" }), code: "0092" },
      { item: mk(8103, "Code with a slash", { supplier_order_number: "AX-1182/4" }), code: "AX-1182/4" },
      // Upper AND lower case ASCII letters: a sheet that folds the case either way (or only paints it that way) changes it.
      { item: mk(8105, "Code in mixed upper and lower case", { supplier_order_number: "ab-12x/Z" }), code: "ab-12x/Z" },
      { item: mk(8104, "Code at the 64-character limit", { supplier_order_number: long64 }), code: long64 },
    ];
    await installMockApi(page, { medications: codes.map((c) => c.item) });
    await seedDraft(page, codes.map((c) => ({ id: c.item.id })));
    await openSheet(page);

    for (const { item, code } of codes) {
      const shown = row(page, item).getByText(code, { exact: true });
      await expect(shown).toBeVisible(); // builder
      await expect(shown).toHaveText(code, { useInnerText: true }); // as drawn on screen (innerText follows CSS text-transform)
    }
    expect((await previewRows(page)).map((cells) => cells[1])).toEqual(codes.map((c) => c.code)); // printed sheet

    const { workbook } = await downloadXlsx(page);
    const cells = workbook.sheet("Order sheet").table().rows.map((r) => r["Supplier order no."]);
    expect(cells.map((c) => c?.text)).toEqual(codes.map((c) => c.code)); // Excel: still the same characters
    for (const cell of cells) {
      expect(cell?.hasFormula).toBe(false);
      expect(cell?.format).toBe("@"); // text-formatted, so "0092" stays "0092" when someone edits the cell
    }

    // and the sheet's search finds the item by its code
    await page.getByTestId("add-search").fill("AX-1182/4");
    await expect(page.getByTestId(`add-result-${codes[2].item.id}`)).toContainText("AX-1182/4");
  });

  test("an item deleted while the sheet is open: Download says so, the page refreshes its list and flags the row, and Retry exports only what is left", async ({
    page,
  }) => {
    const mock = await installMockApi(page);
    await seedDraft(page, [{ id: CETIRIZINE.id, qty: "2", unit: "box" }, { id: AMOXICILLIN.id, qty: "5", unit: "case" }]);
    await openSheet(page);
    await expect(row(page, AMOXICILLIN)).toContainText(nameOf(AMOXICILLIN));
    await expect(page.getByTestId("missing-items-summary")).toHaveCount(0);

    // another computer deletes the item after this page has loaded
    mock.medications.splice(mock.medications.findIndex((m) => m.id === AMOXICILLIN.id), 1);
    await page.getByTestId("export-xlsx").click();
    const error = page.getByTestId("export-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute("role", "alert");
    await expect(error).toContainText("1 item on the sheet is no longer in the inventory. Remove it and try again.");
    // the page re-read the inventory by itself, so the row is now flagged
    await expect(row(page, AMOXICILLIN)).toContainText(/no longer in inventory/i);
    await expect(page.getByTestId("missing-items-summary")).toBeVisible();
    await expect(page.getByTestId(`qty-input-${CETIRIZINE.id}`)).toHaveValue("2"); // typed values untouched

    await error.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("export-success")).toBeVisible();
    const bodies = exportBodies(mock);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].rows.map((r) => r.id)).toEqual([CETIRIZINE.id, AMOXICILLIN.id]); // the stale first attempt
    expect(bodies[1].rows).toEqual([{ id: CETIRIZINE.id, qty: "2", unit: "box" }]); // the retry: only what still exists
  });

  test("Refresh picks up a supplier number and stock changed elsewhere, keeps what was typed, and the printed sheet and Excel file use the new number", async ({
    page,
  }) => {
    const mock = await installMockApi(page);
    await seedDraft(page, [{ id: ASPIRIN.id, qty: "6", unit: "box" }]); // Aspirin has no supplier number yet
    await openSheet(page);
    await expect(row(page, ASPIRIN)).toContainText("Not set");
    await expect(page.getByTestId("missing-supplier-summary")).toBeVisible();

    // someone enters the number on the Admin page (another tab or computer) and the stock changes
    const stored = mock.medications.find((m) => m.id === ASPIRIN.id);
    if (stored === undefined) throw new Error("fixture item missing from the mock database");
    stored.supplier_order_number = "00ASP-81";
    stored.stock = 33;
    await page.getByRole("button", { name: "Refresh inventory" }).click();

    await expect(row(page, ASPIRIN).getByText("00ASP-81", { exact: true })).toBeVisible();
    await expect(page.getByTestId("missing-supplier-summary")).toHaveCount(0);
    await expect(row(page, ASPIRIN)).toContainText("On hand now: 33 units");
    await expect(page.getByTestId(`qty-input-${ASPIRIN.id}`)).toHaveValue("6"); // typed values survive a refresh
    await expect(page.getByTestId(`unit-input-${ASPIRIN.id}`)).toHaveValue("box");
    expect((await previewRows(page))[0]).toEqual([nameOf(ASPIRIN), "00ASP-81", "6", "box"]);
    const { workbook } = await downloadXlsx(page);
    expect(workbook.sheet("Order sheet").table().rows[0]["Supplier order no."]?.text).toBe("00ASP-81");
  });

  test("when Refresh cannot reach the server the page says so in plain sight, keeps the earlier data and everything typed, and a later successful Refresh clears the warning and brings the new data", async ({
    page,
  }) => {
    const mock = await installMockApi(page);
    await seedDraft(page, [{ id: ASPIRIN.id, qty: "6", unit: "box" }]);
    await openSheet(page);
    const freshness = page.getByTestId("inventory-freshness");
    await expect(freshness).toContainText("Inventory as of");
    await expect(row(page, ASPIRIN)).toContainText(`On hand now: ${ASPIRIN.stock} units`);

    // the stock changes elsewhere, but the refresh below fails, so the page cannot know and must not pretend it does
    const stored = mock.medications.find((m) => m.id === ASPIRIN.id);
    if (stored === undefined) throw new Error("fixture item missing from the mock database");
    stored.stock = 33;
    mock.failNext({ method: "GET", path: /\/api\/medications$/, status: 500, body: { error: "Unexpected database error." } });
    await page.getByRole("button", { name: "Refresh inventory" }).click();

    // The warning as a person reads it. (A screen-reader-only sentence in the same region also says "Couldn’t refresh", so only
    // this longer wording proves the warning is on screen.) It replaces the normal "Inventory as of ..." line instead of hiding behind it.
    await expect(page.getByText(/Couldn’t refresh\. Still showing the inventory as of/)).toBeVisible();
    await expect(freshness).not.toContainText("Inventory as of");
    await expect(row(page, ASPIRIN)).toContainText(`On hand now: ${ASPIRIN.stock} units`); // the earlier data, not the unseen change
    await expect(page.getByTestId(`qty-input-${ASPIRIN.id}`)).toHaveValue("6"); // what was typed is untouched
    await expect(page.getByTestId(`unit-input-${ASPIRIN.id}`)).toHaveValue("box");
    await expect(page.getByTestId("print-button")).toBeEnabled(); // the sheet is still usable with the data it has
    await expect(page.getByTestId("export-xlsx")).toBeEnabled();

    // pressing Refresh again works: the warning goes and the new stock is shown
    await page.getByRole("button", { name: "Refresh inventory" }).click();
    await expect(row(page, ASPIRIN)).toContainText("On hand now: 33 units");
    await expect(page.getByText(/Still showing the inventory as of/)).toHaveCount(0);
    await expect(freshness).toContainText("Inventory as of");
    await expect(page.getByTestId(`qty-input-${ASPIRIN.id}`)).toHaveValue("6");
  });

  test("supplier numbers that spreadsheets like to rewrite (1E5, 2026-11-05, =1+1, 20 digits, 00-1.50) stay the same characters on the sheet and in the Excel file", async ({
    page,
  }) => {
    const tricky = ["1E5", "2026-11-05", "=1+1", "12345678901234567890", "00-1.50", "000000", "NÅ-00ß"];
    const items = tricky.map((code, i) => mk(8400 + i, `Tricky code ${i + 1}`, { supplier_order_number: code }));
    await installMockApi(page, { medications: items });
    await seedDraft(page, items.map((item) => ({ id: item.id })));
    await openSheet(page);

    expect((await previewRows(page)).map((cells) => cells[1])).toEqual(tricky);
    for (const [i, code] of tricky.entries()) await expect(row(page, items[i]).getByText(code, { exact: true })).toBeVisible();
    const { workbook } = await downloadXlsx(page);
    const cells = workbook.sheet("Order sheet").table().rows.map((r) => r["Supplier order no."]);
    expect(cells.map((c) => c?.text)).toEqual(tricky);
    for (const cell of cells) {
      expect(cell?.hasFormula).toBe(false);
      expect(cell?.type === "shared-string" || cell?.type === "inline-string").toBe(true); // text, never a number or a formula
    }
  });

  test("what staff type (quotes, commas, tags, =formulas, accents) in the unit, title, prepared-by and notes appears literally on the sheet and in the Excel file", async ({
    page,
  }) => {
    const unit = `<b>case</b> "x", 2×10 =A1`;
    const title = '=HYPERLINK("http://example.invalid","click")';
    const preparedBy = "Zoë <nurse> & co";
    const notes = "Line one, \"quoted\"\n+SUM(A1:A2) line two";
    await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id, qty: "3" }]);
    await openSheet(page);
    await page.getByTestId(`unit-input-${IBUPROFEN.id}`).fill(unit);
    await page.getByTestId("sheet-title").fill(title);
    await page.getByTestId("sheet-prepared-by").fill(preparedBy);
    await page.getByTestId("sheet-notes").fill(notes);

    const preview = page.getByTestId("sheet-preview");
    await expect(preview).toContainText(title);
    await expect(preview).toContainText(preparedBy);
    await expect(preview).toContainText("+SUM(A1:A2) line two");
    expect((await previewRows(page))[0][3]).toBe(unit); // shown as text, not interpreted as markup
    expect(await preview.locator("b").count()).toBe(0);

    const { workbook } = await downloadXlsx(page);
    const sheet = workbook.sheet("Order sheet");
    const texts = sheet.cells.map((c) => c.text ?? "");
    expect(texts).toContain(title);
    expect(texts).toContain(preparedBy);
    expect(texts).toContain(unit);
    expect(texts.some((t) => t.includes("Line one, \"quoted\"") && t.includes("+SUM(A1:A2) line two"))).toBe(true);
    expect(sheet.cells.filter((c) => c.hasFormula)).toEqual([]); // not one formula in the whole file
  });

  test("the barcode is a separate optional column: off by default, shown only when switched on, never mixed with the supplier order number", async ({
    page,
  }) => {
    const item = mk(8201, "Barcode and supplier number differ", { barcode: "0049000028911", supplier_order_number: "SUP-77" });
    await installMockApi(page, { medications: [item] });
    await seedDraft(page, [{ id: item.id }]);
    await openSheet(page);

    // default: a clean sheet without barcodes, in the builder and in the preview
    expect(await previewHeaders(page)).toEqual(["Item", "Supplier order no.", "Order qty", "Unit"]);
    await expect(row(page, item)).not.toContainText("0049000028911");
    expect(await previewRows(page)).toEqual([["Barcode and supplier number differ", "SUP-77", "", ""]]);

    await page.getByTestId("show-barcode").check();
    expect(await previewHeaders(page)).toEqual(["Item", "Supplier order no.", "Order qty", "Unit", "Barcode"]);
    expect(await previewRows(page)).toEqual([["Barcode and supplier number differ", "SUP-77", "", "", "0049000028911"]]);
    await expect(row(page, item)).toContainText("Barcode 0049000028911"); // small, under the name
    await expect(row(page, item).getByText("SUP-77", { exact: true })).toBeVisible(); // supplier number untouched

    // it is part of the Excel file only when switched on, as its own column
    const { workbook } = await downloadXlsx(page);
    const table = workbook.sheet("Order sheet").table();
    expect(table.headers).toEqual(["No.", "Item", "Supplier order no.", "Order qty", "Unit", "Barcode"]);
    expect(table.rows[0]["Barcode"]?.text).toBe("0049000028911");
    expect(table.rows[0]["Supplier order no."]?.text).toBe("SUP-77");

    await page.getByTestId("show-barcode").uncheck();
    expect(await previewHeaders(page)).toEqual(["Item", "Supplier order no.", "Order qty", "Unit"]);
    await expect(row(page, item)).not.toContainText("0049000028911");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("Order sheet: it never orders, emails or changes stock", () => {
  test("the page states that preparing, printing or exporting does not place an order, email anyone or change stock, and offers no way to do any of those", async ({
    page,
  }) => {
    await installMockApi(page);
    const forbidden = /place (an? )?order|send (an? )?(order|e-?mail)|e-?mail (the )?(order|supplier|sheet)|submit (the )?order|mark(ed)? as ordered|purchase|check ?out|order now/i;
    for (const populated of [false, true]) {
      if (populated) {
        await addFromSearch(page, "ibuprofen", IBUPROFEN);
        await expect(row(page, IBUPROFEN)).toBeVisible();
      } else {
        await openSheet(page);
      }
      const disclaimer = page.getByTestId("sheet-disclaimer");
      await expect(disclaimer).toBeVisible();
      await expect(disclaimer).toContainText(/Preparing, printing or exporting this sheet does not place an order, email anyone,? or change stock/);
      // it is near the top: above the place where items are added
      const disclaimerBox = await disclaimer.boundingBox();
      const searchBox = await page.getByTestId("add-search").boundingBox();
      expect(disclaimerBox && searchBox && disclaimerBox.y < searchBox.y).toBe(true);
      await expect(page.getByRole("button", { name: forbidden })).toHaveCount(0);
      await expect(page.getByRole("link", { name: forbidden })).toHaveCount(0);
    }
  });

  test("Print / Save as PDF opens the browser's print window and sends nothing; the Excel button says it is an .xlsx file; there is no 'Download PDF' button", async ({
    page,
  }) => {
    await stubPrint(page);
    const mock = await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id, qty: "2", unit: "box" }]);
    await openSheet(page);
    const requestsBefore = mock.requests.length;

    await expect(page.getByRole("button", { name: "Print / Save as PDF" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Download Excel (.xlsx)" })).toBeEnabled();
    await expect(page.getByRole("button", { name: /download pdf|pdf download|save pdf/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /download pdf|pdf download/i })).toHaveCount(0);
    await expect(page.getByText(/opens your browser’s print window/)).toBeVisible();

    await page.getByTestId("print-button").click();
    expect(await printCalls(page)).toBe(1);
    await settle(page);
    expect(mock.requests.length).toBe(requestsBefore); // printing is the browser's job: no request at all
    expect(writes(mock)).toEqual([]);
  });

  test("if the Excel export fails the page says so with the server's message and a Retry; nothing changes; the button is off while the file is made; Retry then downloads it", async ({
    page,
  }) => {
    const mock = await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id, qty: "4", unit: "box" }]);
    await openSheet(page);
    const before = inventorySnapshot(mock);

    // 1) the server answers with an error
    mock.failNext({ method: "POST", path: /\/api\/order-sheet\/xlsx$/, status: 500, body: { error: "Unexpected database error.", code: "XX000" } });
    await page.getByTestId("export-xlsx").click();
    const error = page.getByTestId("export-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute("role", "alert");
    await expect(error).toContainText("Unexpected database error.");
    await expect(page.getByTestId("export-success")).toHaveCount(0);
    await expect(page.getByTestId(`qty-input-${IBUPROFEN.id}`)).toHaveValue("4"); // the sheet is exactly as it was

    // 2) no answer at all
    mock.failNext({ method: "POST", path: /\/api\/order-sheet\/xlsx$/, networkError: true });
    await error.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("export-error")).toContainText("Can’t reach the server");
    await expect(page.getByTestId("export-success")).toHaveCount(0);

    // 3) the server is slow: the button is off while the file is being made, so it cannot be pressed twice
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/order-sheet/xlsx", async (route) => {
      await gate;
      await route.fallback();
    });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      (async () => {
        await page.getByTestId("export-error").getByRole("button", { name: "Retry" }).click();
        await expect(page.getByTestId("export-xlsx")).toBeDisabled();
        await expect(page.getByText("Creating the Excel file…")).toBeVisible();
        release();
      })(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^order-sheet-\d{4}-\d{2}-\d{2}\.xlsx$/);
    await expect(page.getByTestId("export-success")).toBeVisible();
    await expect(page.getByTestId("export-error")).toHaveCount(0);
    await expect(page.getByTestId("export-xlsx")).toBeEnabled();
    expect(inventorySnapshot(mock)).toBe(before);
    expect(writes(mock).every((w) => w === "POST /api/order-sheet/xlsx")).toBe(true); // only the (failed or successful) exports
  });

  test("a full visit (tick, search, add low-stock, type quantities, change options, print, export, reload, remove, clear) makes only reads plus the single Excel export: no stock change, no inventory write, nothing leaves the app", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await stubPrint(page);
    const errors = collectPageErrors(page);
    const seen: Array<{ method: string; url: string }> = [];
    page.on("request", (request) => seen.push({ method: request.method(), url: request.url() }));
    const mock = await installMockApi(page);
    const before = inventorySnapshot(mock);

    // choose on the Inventory tab: two ticks and a whole category
    await openInventory(page);
    await page.getByTestId(`order-checkbox-${CETIRIZINE.id}`).check();
    await page.getByTestId(`order-checkbox-${ASPIRIN.id}`).check();
    await page.getByTestId(`group-add-all-${categoryIdByName("Antibiotics")}`).click();
    await expect(page.getByTestId("bulk-status")).toContainText("from Antibiotics");

    // continue on the sheet
    await page.getByTestId("order-bar-review").click();
    await waitSheetReady(page);
    await addFromSearch(page, "thermometer", THERMOMETER);
    await page.getByTestId("add-low-stock").click();
    await expect(page.getByTestId("low-stock-status")).toContainText("low-stock item");
    await page.getByTestId(`qty-input-${CETIRIZINE.id}`).fill("12");
    await page.getByTestId(`unit-input-${CETIRIZINE.id}`).fill("box");
    await page.getByTestId(`qty-input-${ASPIRIN.id}`).fill("4");
    await page.getByTestId("sheet-title").fill("Full visit");
    await page.getByTestId("sheet-prepared-by").fill("Test nurse");
    await page.getByTestId("sheet-notes").fill("Please deliver Monday");
    await page.getByTestId("show-on-hand").check();
    await page.getByTestId("show-barcode").check();
    await page.getByTestId("paper-a4").check();

    await page.getByTestId("print-button").click();
    expect(await printCalls(page)).toBe(1);
    const { workbook } = await downloadXlsx(page);
    expect(workbook.sheet("Order sheet").table().rows.length).toBeGreaterThan(5);

    // reload, remove one row, clear the sheet, look at the other screens
    await page.reload();
    await waitSheetReady(page);
    await page.getByTestId(`remove-row-${ASPIRIN.id}`).click();
    await expect(row(page, ASPIRIN)).toHaveCount(0);
    await page.getByTestId("clear-sheet").click();
    await page.getByTestId("clear-sheet-confirm").click();
    await expect(page.getByTestId("sheet-empty")).toBeVisible();
    await openInventory(page);
    await expect(page.locator('[data-testid^="order-checkbox-"]:checked')).toHaveCount(0);

    // the proof: writes are exactly one POST to the export route
    expect(writes(mock)).toEqual(["POST /api/order-sheet/xlsx"]);
    expect(mock.requestsTo("POST", /\/api\/transactions/)).toEqual([]);
    expect(mock.requests.filter((r) => /\/api\/medications/.test(r.path) && r.method !== "GET")).toEqual([]);
    // usage history, analytics, uploads and imports are not even read
    expect(mock.requests.filter((r) => /\/api\/(transactions|analytics|upload|import)/.test(r.path))).toEqual([]);
    expect(inventorySnapshot(mock)).toBe(before); // stock, names, supplier numbers, categories: identical
    // nothing was sent anywhere but this app (no third-party conversion or mail service)
    const origin = new URL(page.url()).origin;
    const foreign = seen.filter((r) => /^https?:/.test(r.url) && new URL(r.url).origin !== origin);
    expect(foreign).toEqual([]);
    const otherWrites = seen.filter((r) => r.method !== "GET" && r.method !== "HEAD" && !/\/_next\/|\/__nextjs/.test(r.url));
    expect(otherWrites.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(["POST /api/order-sheet/xlsx"]);
    expect(errors).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("Order sheet: what prints is only the sheet", () => {
  test("when printing, only the sheet is shown: navigation, controls, buttons and notices are hidden; the paper size chosen is the one asked of the printer", async ({
    page,
  }) => {
    await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id, qty: "2", unit: "box" }]);
    await openSheet(page);
    const pageRules = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("style"))
          .map((s) => s.textContent ?? "")
          .filter((text) => text.includes("@page"))
          .join("\n")
      );
    expect(await pageRules()).toMatch(/size:\s*letter portrait/i); // Letter is the default

    await page.getByTestId("paper-a4").check();
    expect(await pageRules()).toMatch(/size:\s*A4 portrait/i);
    expect(await pageRules()).not.toMatch(/size:\s*letter/i);

    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("navigation")).toBeHidden();
    await expect(page.getByTestId("sheet-disclaimer")).toBeHidden();
    await expect(page.getByTestId("add-search")).toBeHidden();
    await expect(page.getByTestId(`qty-input-${IBUPROFEN.id}`)).toBeHidden();
    await expect(page.getByTestId(`remove-row-${IBUPROFEN.id}`)).toBeHidden();
    await expect(page.getByTestId("print-button")).toBeHidden();
    await expect(page.getByTestId("export-xlsx")).toBeHidden();
    await expect(page.getByTestId("paper-a4")).toBeHidden();
    await expect(page.getByTestId("sheet-preview")).toBeVisible();
    await expect(page.getByTestId("sheet-preview")).toContainText(nameOf(IBUPROFEN));
    await expect(page.getByTestId("sheet-preview")).toContainText("0092");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// "Today" is the calendar day on the computer in front of the nurse, not the UTC day. The machine that runs these tests is in
// UTC, where the two are the same day, so each test below puts the browser in a zone whose day differs from the UTC day at the
// chosen moment (one behind UTC, one ahead). A sheet dated by the UTC day would print tomorrow's (or yesterday's) date.
test.describe("Order sheet: a new sheet is dated with the local calendar day, not the UTC day", () => {
  test.describe("in the evening in Los Angeles, when UTC is already the next day", () => {
    test.use({ timezoneId: "America/Los_Angeles" });

    test("at 20:30 on 9 March in Los Angeles the new sheet is dated 9 March: in the box, on the printed sheet and in the Excel file name", async ({
      page,
    }) => {
      await page.clock.setFixedTime(new Date("2026-03-10T03:30:00Z")); // 20:30 on 9 March in Los Angeles; 10 March in UTC
      const mock = await installMockApi(page);
      await seedDraft(page, [{ id: IBUPROFEN.id }]);
      await openSheet(page);
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe("America/Los_Angeles"); // precondition
      await expect(page.getByTestId("sheet-date")).toHaveValue("2026-03-09");
      await expect(page.getByTestId("sheet-preview")).toContainText("Mar 9, 2026");
      const { filename } = await downloadXlsx(page);
      expect(filename).toBe("order-sheet-2026-03-09.xlsx");
      expect(exportBodies(mock)[0].date).toBe("2026-03-09");
    });
  });

  test.describe("early in the morning in Auckland, when UTC is still the day before", () => {
    test.use({ timezoneId: "Pacific/Auckland" });

    test("at 12:30 on 10 March in Auckland the new sheet is dated 10 March: in the box, on the printed sheet and in the Excel file name", async ({
      page,
    }) => {
      await page.clock.setFixedTime(new Date("2026-03-09T23:30:00Z")); // 12:30 on 10 March in Auckland; 9 March in UTC
      const mock = await installMockApi(page);
      await seedDraft(page, [{ id: IBUPROFEN.id }]);
      await openSheet(page);
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe("Pacific/Auckland"); // precondition
      await expect(page.getByTestId("sheet-date")).toHaveValue("2026-03-10");
      await expect(page.getByTestId("sheet-preview")).toContainText("Mar 10, 2026");
      const { filename } = await downloadXlsx(page);
      expect(filename).toBe("order-sheet-2026-03-10.xlsx");
      expect(exportBodies(mock)[0].date).toBe("2026-03-10");
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// A read that is accepted and then never answered (what a paused or half-reachable database looks like). The Home page and
// Admin give up after 30 seconds (AbortSignal.timeout) and show an error with Retry; without that limit this page said
// "Loading the inventory…" for ever, with no way out. The real limit is 30 s: these tests shorten it to a moment from inside
// the page (the 30 s itself is checked by what the page asked for), so the behaviour can be watched without waiting.
test.describe("Order sheet: an inventory request that is never answered", () => {
  const TOO_SLOW = "The server took too long to answer while loading the inventory.";

  async function shortenRequestLimit(page: Page, ms = 600): Promise<void> {
    await page.addInitScript((short: number) => {
      const w = window as unknown as { __limitsAsked: number[] };
      w.__limitsAsked = [];
      const original = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = (asked: number) => {
        w.__limitsAsked.push(asked);
        return original(asked === 30_000 ? short : asked);
      };
    }, ms);
  }

  const limitsAsked = (page: Page): Promise<number[]> => page.evaluate(() => (window as unknown as { __limitsAsked: number[] }).__limitsAsked);

  test("a first load nobody answers ends in the same error screen as any other load failure, with Retry; the saved sheet is untouched and Retry brings it back", async ({
    page,
  }) => {
    await shortenRequestLimit(page);
    const mock = await installMockApi(page);
    const rows = [
      { id: IBUPROFEN.id, qty: "12", unit: "boxes" },
      { id: CETIRIZINE.id, qty: "3", unit: "case" },
    ];
    await seedDraft(page, rows, { title: "Kept title", notes: "Keep this note" });
    const gate = await holdAnswers(page, "**/api/medications"); // the inventory is accepted and never answered
    try {
      await page.goto("/order-sheet");
      const error = page.getByTestId("sheet-error");
      await expect(error, "the page gave up waiting and said so").toBeVisible({ timeout: 10_000 });
      await expect(error).toContainText("Couldn’t load the inventory");
      await expect(error).toContainText("This does not mean the inventory is empty.");
      await expect(error).toContainText(TOO_SLOW);
      await expect(error).toContainText("Your order sheet (2 items) is still saved in this browser.");
      await expect(page.getByTestId("sheet-loading"), "no spinner is left behind").toHaveCount(0);
      expect(await limitsAsked(page), "the limit the page asked for is the real 30 seconds").toContain(30_000);

      // nothing was lost, changed or sent meanwhile
      const draft = await readDraft(page);
      expect(draft?.rows.map(({ id, qty, unit }) => ({ id, qty, unit }))).toEqual(rows);
      expect(draft?.title).toBe("Kept title");
      expect(draft?.notes).toBe("Keep this note");
      expect(writes(mock)).toEqual([]);

      // Retry that is not answered either ends in the error again (it never sticks on the spinner)
      const asked = gate.arrived();
      await error.getByRole("button", { name: "Retry" }).click();
      await expect.poll(() => gate.arrived(), { message: "Retry asked the server once more" }).toBe(asked + 1);
      await expect(error).toBeVisible({ timeout: 10_000 });
      await expect(error).toContainText(TOO_SLOW);

      // and Retry that is answered shows the sheet exactly as it was saved
      gate.release();
      await error.getByRole("button", { name: "Retry" }).click();
      await waitSheetReady(page);
      expect(await sheetRowIds(page)).toEqual(rows.map((r) => r.id));
      expect(await typedRows(page)).toEqual(rows);
      await expect(page.getByTestId("sheet-title")).toHaveValue("Kept title");
    } finally {
      gate.release();
    }
  });

  test("a Refresh nobody answers ends too: the warning appears, the earlier inventory and everything typed stay, and Refresh works again", async ({ page }) => {
    await shortenRequestLimit(page);
    await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id, qty: "12", unit: "boxes" }]);
    await openSheet(page);
    const freshness = page.getByTestId("inventory-freshness");
    await expect(freshness).toContainText("Inventory as of");

    const gate = await holdAnswers(page, "**/api/medications"); // from now on the inventory is never answered
    try {
      await page.getByRole("button", { name: "Refresh inventory" }).click();
      await expect(freshness, "the refresh gave up and said so").toContainText("Couldn’t refresh. Still showing the inventory as of", { timeout: 10_000 });
      await expect(page.getByTestId(`qty-input-${IBUPROFEN.id}`)).toHaveValue("12");
      expect(await typedRows(page)).toEqual([{ id: IBUPROFEN.id, qty: "12", unit: "boxes" }]);

      gate.release();
      await page.getByRole("button", { name: "Refresh inventory" }).click();
      await expect(freshness).not.toContainText("Couldn’t refresh", { timeout: 10_000 });
      await expect(freshness).toContainText("Inventory as of");
    } finally {
      gate.release();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Undo. The Inventory tab's "Add all" has an Undo; the sheet's own "Add all low-stock items" and its Remove button had none, so a
// mis-tap could only be reversed with "Clear sheet" (which also wipes rows added by hand and every typed quantity) or by hand,
// one row at a time. One level of undo: the most recent bulk add or removal. The rules for when it stops being offered are the
// Inventory tab's: it goes when it is used or dismissed, when the sheet is cleared, and when a newer action replaces it.
test.describe("Order sheet: Undo for 'Add all low-stock items' and for Remove", () => {
  const gloves = mk(7301, "Gloves, nitrile", { stock: 2, threshold: 10 }); // low
  const masks = mk(7302, "Masks, surgical", { stock: 0, threshold: 10 }); // low
  const gauze = mk(7303, "Gauze pads, sterile", { stock: 3, threshold: 10 }); // low
  const syringes = mk(7304, "Syringes, 5 mL", { stock: 90, threshold: 10 }); // not low
  const tape = mk(7305, "Tape, medical", { stock: 60, threshold: 10 }); // not low
  const STOCK = [gloves, masks, gauze, syringes, tape];

  const status = (page: Page): Locator => page.getByTestId("low-stock-status");
  const undo = (page: Page): Locator => page.getByTestId("bulk-undo");
  const dismiss = (page: Page): Locator => page.getByTestId("bulk-dismiss");
  const addAll = (page: Page): Locator => page.getByTestId("add-low-stock");

  async function start(page: Page, rows: Array<{ id: number; qty?: string; unit?: string }>): Promise<MockApi> {
    const mock = await installMockApi(page, { medications: STOCK });
    await seedDraft(page, rows);
    await openSheet(page);
    return mock;
  }

  test.describe("Add all low-stock items", () => {
    test("says what it added and offers Undo; Undo takes off exactly the rows that action added and nothing else, whatever was typed meanwhile; the saved draft matches the screen at every step", async ({
      page,
    }) => {
      const mock = await start(page, [
        { id: gloves.id, qty: "12", unit: "boxes" }, // low, and already on the sheet before the action
        { id: tape.id, qty: "3", unit: "cases" },
      ]);
      const before = inventorySnapshot(mock);

      await addAll(page).click();
      await expect(status(page)).toHaveText("Added 2 low-stock items (1 already on the sheet). Order quantities are left empty.");
      await expect(undo(page)).toBeVisible();
      await expect(undo(page)).toHaveText("Undo");
      expect(await sheetRowIds(page)).toEqual([gloves.id, tape.id, gauze.id, masks.id]);
      expect(await typedRows(page)).toEqual([
        { id: gloves.id, qty: "12", unit: "boxes" },
        { id: tape.id, qty: "3", unit: "cases" },
        { id: gauze.id, qty: "", unit: "" },
        { id: masks.id, qty: "", unit: "" },
      ]);
      await expectScreenMatchesDraft(page);

      // staff keep working: a quantity typed in a row that was already there has nothing to do with the action
      await page.getByTestId(`qty-input-${tape.id}`).fill("20");
      await expect(undo(page), "typing a quantity does not end the offer").toBeVisible();
      await undo(page).click();

      await expect(status(page)).toHaveText("Undid adding 2 items.");
      expect(await sheetRowIds(page)).toEqual([gloves.id, tape.id]);
      expect(await typedRows(page)).toEqual([
        { id: gloves.id, qty: "12", unit: "boxes" }, // the row that was on the sheet before keeps its place and what was typed
        { id: tape.id, qty: "20", unit: "cases" }, // the edit made after the action is kept
      ]);
      await expectScreenMatchesDraft(page);
      expect((await previewRows(page)).map((cells) => cells[0])).toEqual([nameOf(gloves), nameOf(tape)]);
      await expect(page.getByRole("heading", { name: /Items on this sheet/ })).toContainText("(2)");
      await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet (2 items)");

      // it is used up: Undo is gone and nothing can be undone a second time
      await expect(undo(page)).toHaveCount(0);
      await settle(page);
      expect(await sheetRowIds(page)).toEqual([gloves.id, tape.id]);
      expect(inventorySnapshot(mock)).toBe(before);
      expect(writes(mock)).toEqual([]); // an Undo is a change of the draft in this browser only
    });

    test("one press of Undo undoes once, even when it is double-clicked: the second click does not dismiss the message", async ({ page }) => {
      await start(page, []);
      await addAll(page).click();
      await expect(status(page)).toContainText("Added 3 low-stock items");
      await undo(page).dblclick();
      await expect(status(page)).toHaveText("Undid adding 3 items.");
      await settle(page);
      await expect(status(page), "the second click of the double-click did not dismiss the answer").toHaveText("Undid adding 3 items.");
      expect(await sheetRowIds(page)).toEqual([]);
      await expectScreenMatchesDraft(page);
    });

    test("the keyboard reaches Undo, Enter presses it once and keeps the focus on a button that stays; Dismiss clears the message and returns to 'Add all low-stock items'; a HELD Enter presses only once", async ({
      page,
    }) => {
      await start(page, []);
      await addAll(page).focus();
      await page.keyboard.press("Enter");
      await expect(status(page)).toContainText("Added 3 low-stock items");

      await page.keyboard.press("Tab"); // the message is not a stop; the next control is Undo
      await expect(undo(page)).toBeFocused();
      await page.keyboard.down("Enter");
      await page.keyboard.down("Enter"); // the key is held: the repeat must not press the button focus has just moved to
      await page.keyboard.up("Enter");
      await expect(status(page)).toHaveText("Undid adding 3 items.");
      await expect(dismiss(page)).toBeFocused();
      expect(await sheetRowIds(page)).toEqual([]);

      await page.keyboard.press("Enter"); // a new press: Dismiss
      await expect(status(page)).toHaveText("");
      await expect(undo(page)).toHaveCount(0);
      await expect(dismiss(page)).toHaveCount(0);
      await expect(addAll(page)).toBeFocused();
    });

    test("the message is a polite live region of its own; the buttons are outside of it, so only the sentence is read out", async ({ page }) => {
      await start(page, []);
      await expect(status(page)).toHaveAttribute("role", "status"); // there before any result, so the first one is announced
      await addAll(page).click();
      await expect(status(page)).toContainText("Added 3 low-stock items");
      await expect(status(page)).toHaveAttribute("aria-live", "polite");
      await expect(status(page)).not.toContainText("Undo");
      await expect(status(page)).not.toContainText("Dismiss");
      await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(1);
    });

    test("Dismiss takes the message and its Undo away and leaves the rows alone", async ({ page }) => {
      await start(page, []);
      await addAll(page).click();
      await dismiss(page).click();
      await expect(status(page)).toHaveText("");
      await expect(undo(page)).toHaveCount(0);
      expect(await sheetRowIds(page)).toHaveLength(3);
      await expect(addAll(page)).toBeFocused();
    });

    test("an item added by hand ends the offer (the Inventory tab's rule for an item ticked by hand); the rows stay", async ({ page }) => {
      await start(page, []);
      await addAll(page).click();
      await expect(undo(page)).toBeVisible();
      await addFromSearch(page, "syringes", syringes);
      await expect(page.getByTestId("add-status")).toContainText(`Added ${nameOf(syringes)}`);
      await expect(undo(page)).toHaveCount(0);
      await expect(status(page)).toHaveText("");
      expect(await sheetRowIds(page)).toHaveLength(4);
      await expectScreenMatchesDraft(page);
    });

    test("Clear sheet ends the offer: nothing is left to undo on an empty sheet", async ({ page }) => {
      await start(page, []);
      await addAll(page).click();
      await expect(undo(page)).toBeVisible();
      await page.getByTestId("clear-sheet").click();
      await page.getByTestId("clear-sheet-confirm").click();
      await expect(page.getByTestId("sheet-empty")).toBeVisible();
      await expect(undo(page)).toHaveCount(0);
      await expect(status(page)).toHaveText("");
      expect(await sheetRowIds(page)).toEqual([]);
    });

    test("a second press that adds nothing keeps the first Undo (a double-tap must not cost the way back); the explanation goes to the line under the search box", async ({
      page,
    }) => {
      await start(page, []);
      await addAll(page).click();
      await expect(status(page)).toHaveText("Added 3 low-stock items. Order quantities are left empty.");
      await addAll(page).click(); // nothing left to add
      await expect(page.getByTestId("add-status")).toContainText("All 3 low-stock items are already on the sheet. Nothing was added.");
      await expect(status(page)).toHaveText("Added 3 low-stock items. Order quantities are left empty.");
      await expect(undo(page)).toBeVisible();
      expect(await sheetRowIds(page)).toHaveLength(3);

      await undo(page).click();
      await expect(status(page)).toHaveText("Undid adding 3 items.");
      expect(await sheetRowIds(page)).toEqual([]);
    });

    test("when nothing is on offer, a press that adds nothing says why in the message line (no Undo, no Dismiss)", async ({ page }) => {
      await start(page, [{ id: gloves.id }, { id: masks.id }, { id: gauze.id }]);
      await addAll(page).click();
      await expect(status(page)).toHaveText("All 3 low-stock items are already on the sheet. Nothing was added.");
      await expect(undo(page)).toHaveCount(0);
      await expect(dismiss(page)).toHaveCount(0);
    });

    test("only the latest action can be undone: a new Add all after a Remove replaces the offer, and Undo then takes off just what that action added", async ({
      page,
    }) => {
      await start(page, [{ id: gloves.id, qty: "7", unit: "box" }]);
      await addAll(page).click(); // adds Gauze and Masks
      await expect(status(page)).toContainText("Added 2 low-stock items");
      await page.getByTestId(`remove-row-${masks.id}`).click(); // a newer action replaces the offer
      await expect(status(page)).toHaveText(`Removed ${nameOf(masks)}. 2 items left.`);
      await addAll(page).click(); // adds Masks again
      await expect(status(page)).toHaveText("Added 1 low-stock item (2 already on the sheet). Order quantities are left empty.");
      await undo(page).click();
      await expect(status(page)).toHaveText("Undid adding 1 item.");
      expect(await typedRows(page)).toEqual([
        { id: gloves.id, qty: "7", unit: "box" },
        { id: gauze.id, qty: "", unit: "" },
      ]);
      await expectScreenMatchesDraft(page);
    });

    test("when another tab emptied the sheet in the meantime, Undo says there is nothing to undo and changes nothing", async ({ page }) => {
      await start(page, []);
      await addAll(page).click();
      await expect(undo(page)).toBeVisible();

      const other = await page.context().newPage();
      await installMockApi(other, { medications: STOCK });
      await other.goto("/order-sheet");
      await expect(other.getByTestId("sheet-preview")).toBeVisible();
      await other.getByTestId("clear-sheet").click();
      await other.getByTestId("clear-sheet-confirm").click();
      await expect(other.getByTestId("sheet-empty")).toBeVisible();
      await other.close();

      await expect(page.getByTestId("sheet-empty")).toBeVisible(); // this tab follows the other one
      await undo(page).click();
      await expect(status(page)).toHaveText("Nothing to undo: those items are no longer on the sheet.");
      expect(await sheetRowIds(page)).toEqual([]);
      await expect(undo(page)).toHaveCount(0);
    });
  });

  test.describe("Remove", () => {
    const THREE = [
      { id: IBUPROFEN.id, qty: "12", unit: "boxes" },
      { id: CETIRIZINE.id, qty: "24", unit: "bottles" },
      { id: AMOXICILLIN.id, qty: "6", unit: "packs" },
    ];

    async function startThree(page: Page): Promise<MockApi> {
      const mock = await installMockApi(page);
      await seedDraft(page, THREE);
      await openSheet(page);
      return mock;
    }

    test("Remove says which item went and how many are left, and offers Undo; Undo puts the row back at its place WITH its quantity and unit; a second Undo is not possible", async ({
      page,
    }) => {
      const mock = await startThree(page);
      const before = inventorySnapshot(mock);

      await page.getByTestId(`remove-row-${CETIRIZINE.id}`).click(); // the middle row
      await expect(status(page)).toHaveText(`Removed ${nameOf(CETIRIZINE)}. 2 items left.`);
      await expect(undo(page)).toBeVisible();
      expect(await sheetRowIds(page)).toEqual([IBUPROFEN.id, AMOXICILLIN.id]);
      await expect(page.getByTestId(`remove-row-${AMOXICILLIN.id}`), "the keyboard moved on to the next row").toBeFocused();
      await expectScreenMatchesDraft(page);

      await undo(page).click();
      await expect(status(page)).toHaveText(`Put ${nameOf(CETIRIZINE)} back on the sheet. 3 items on the sheet.`);
      expect(await sheetRowIds(page)).toEqual([IBUPROFEN.id, CETIRIZINE.id, AMOXICILLIN.id]); // in the middle again
      expect(await typedRows(page)).toEqual(THREE); // 12 boxes, 24 bottles, 6 packs: nothing was lost
      await expectScreenMatchesDraft(page);
      expect((await previewRows(page)).map((cells) => cells.slice(2))).toEqual([["12", "boxes"], ["24", "bottles"], ["6", "packs"]]);
      await expect(navSheetLink(page)).toHaveAccessibleName("Order sheet (3 items)");

      await expect(undo(page)).toHaveCount(0); // used: nothing to undo a second time
      await settle(page);
      expect(await typedRows(page)).toEqual(THREE);
      expect(inventorySnapshot(mock)).toBe(before);
      expect(writes(mock)).toEqual([]);
    });

    test("Undo keeps what was typed in another row after the removal", async ({ page }) => {
      await startThree(page);
      await page.getByTestId(`remove-row-${CETIRIZINE.id}`).click();
      await page.getByTestId(`qty-input-${AMOXICILLIN.id}`).fill("99");
      await page.getByTestId(`unit-input-${IBUPROFEN.id}`).fill("cases");
      await expect(undo(page), "typing does not end the offer").toBeVisible();
      await undo(page).click();
      expect(await typedRows(page)).toEqual([
        { id: IBUPROFEN.id, qty: "12", unit: "cases" },
        { id: CETIRIZINE.id, qty: "24", unit: "bottles" },
        { id: AMOXICILLIN.id, qty: "99", unit: "packs" },
      ]);
      await expectScreenMatchesDraft(page);
    });

    test("the first and the last row are put back where they were", async ({ page }) => {
      await startThree(page);
      await page.getByTestId(`remove-row-${IBUPROFEN.id}`).click();
      await undo(page).click();
      expect(await sheetRowIds(page)).toEqual([IBUPROFEN.id, CETIRIZINE.id, AMOXICILLIN.id]);
      await page.getByTestId(`remove-row-${AMOXICILLIN.id}`).click();
      await expect(status(page)).toHaveText(`Removed ${nameOf(AMOXICILLIN)}. 2 items left.`);
      await undo(page).click();
      expect(await typedRows(page)).toEqual(THREE);
    });

    test("one level only: removing a second row replaces the offer, and Undo puts back just that one", async ({ page }) => {
      await startThree(page);
      await page.getByTestId(`remove-row-${IBUPROFEN.id}`).click();
      await page.getByTestId(`remove-row-${AMOXICILLIN.id}`).click();
      await expect(status(page)).toHaveText(`Removed ${nameOf(AMOXICILLIN)}. 1 item left.`);
      await undo(page).click();
      expect(await typedRows(page)).toEqual([
        { id: CETIRIZINE.id, qty: "24", unit: "bottles" },
        { id: AMOXICILLIN.id, qty: "6", unit: "packs" },
      ]); // Ibuprofen stays removed
      await expect(undo(page)).toHaveCount(0);
      await expectScreenMatchesDraft(page);
    });

    test("removing the only row leaves an empty sheet that Undo fills again; the empty-sheet card is shown meanwhile", async ({ page }) => {
      await installMockApi(page);
      await seedDraft(page, [{ id: IBUPROFEN.id, qty: "5", unit: "box" }]);
      await openSheet(page);
      await page.getByTestId(`remove-row-${IBUPROFEN.id}`).click();
      await expect(status(page)).toHaveText(`Removed ${nameOf(IBUPROFEN)}. 0 items left.`);
      await expect(page.getByTestId("sheet-empty")).toBeVisible();
      await expect(undo(page)).toBeVisible();
      await undo(page).click();
      await expect(page.getByTestId("sheet-empty")).toHaveCount(0);
      expect(await typedRows(page)).toEqual([{ id: IBUPROFEN.id, qty: "5", unit: "box" }]);
      await expectScreenMatchesDraft(page);
    });

    test("an item added by hand, a Clear sheet and Dismiss each end the offer", async ({ page }) => {
      await startThree(page);
      await page.getByTestId(`remove-row-${CETIRIZINE.id}`).click();
      await expect(undo(page)).toBeVisible();
      await addFromSearch(page, "thermometer", THERMOMETER);
      await expect(undo(page)).toHaveCount(0);
      await expect(status(page)).toHaveText("");

      await page.getByTestId(`remove-row-${THERMOMETER.id}`).click();
      await expect(undo(page)).toBeVisible();
      await dismiss(page).click();
      await expect(undo(page)).toHaveCount(0);
      await expect(status(page)).toHaveText("");

      await page.getByTestId(`remove-row-${IBUPROFEN.id}`).click();
      await expect(undo(page)).toBeVisible();
      await page.getByTestId("clear-sheet").click();
      await page.getByTestId("clear-sheet-confirm").click();
      await expect(undo(page)).toHaveCount(0);
      await expect(status(page)).toHaveText("");
      expect(await sheetRowIds(page)).toEqual([]);
    });

    test("when the item is on the sheet again by the time Undo is pressed (another tab ticked it), nothing is duplicated and the message says so", async ({ page }) => {
      await startThree(page);
      await page.getByTestId(`remove-row-${CETIRIZINE.id}`).click();
      await expect(undo(page)).toBeVisible();

      const other = await page.context().newPage();
      await installMockApi(other);
      await other.goto("/?tab=inventory");
      await expect(other.getByTestId("inventory-summary")).toBeVisible();
      await other.getByTestId(`order-checkbox-${CETIRIZINE.id}`).check();
      await expect.poll(async () => (await readDraft(other))?.rows.length).toBe(3);
      await other.close();

      await expect.poll(() => sheetRowIds(page)).toEqual([IBUPROFEN.id, AMOXICILLIN.id, CETIRIZINE.id]); // this tab follows
      await undo(page).click();
      await expect(status(page)).toHaveText(`Nothing to undo: ${nameOf(CETIRIZINE)} is already on the sheet.`);
      expect(await sheetRowIds(page)).toEqual([IBUPROFEN.id, AMOXICILLIN.id, CETIRIZINE.id]);
    });

    test("when the sheet has filled up meanwhile (another tab), Undo says the row could not be put back, adds nothing and is used up", async ({ page }) => {
      // 499 rows whose items are gone from the inventory plus one real row: the sheet holds the most it can (500)
      const ghosts = Array.from({ length: 499 }, (_, index) => ({ id: 60_000 + index, qty: "", unit: "" }));
      await installMockApi(page);
      await seedDraft(page, [{ id: IBUPROFEN.id, qty: "5", unit: "box" }, ...ghosts]);
      await openSheet(page);
      await page.getByTestId(`remove-row-${IBUPROFEN.id}`).click();
      await expect(status(page)).toHaveText(`Removed ${nameOf(IBUPROFEN)}. 499 items left.`);

      // another tab fills the sheet up to 500 again, with a different item
      const other = await page.context().newPage();
      await installMockApi(other);
      await other.goto("/order-sheet");
      await other.evaluate(
        ([key, rows]) => {
          const draft: { rows: unknown } = JSON.parse(window.localStorage.getItem(key) ?? "{}");
          draft.rows = rows;
          window.localStorage.setItem(key, JSON.stringify(draft));
        },
        [STORAGE_KEY, [...ghosts, { id: 69_999, qty: "", unit: "" }]] as const
      );
      await other.close();
      await expect.poll(async () => (await readDraft(page))?.rows.length).toBe(500);

      await undo(page).click();
      await expect(status(page)).toHaveText(`The sheet is full (500 items), so ${nameOf(IBUPROFEN)} could not be put back.`);
      await expect(undo(page)).toHaveCount(0); // the offer is used up: it cannot wait for room
      expect((await readDraft(page))?.rows).toHaveLength(500);
      expect((await readDraft(page))?.rows.map((r) => r.id)).not.toContain(IBUPROFEN.id); // and nothing was added
    });

    test("a row whose item is gone from the inventory can be removed and put back like any other", async ({ page }) => {
      await installMockApi(page);
      await seedDraft(page, [{ id: IBUPROFEN.id, qty: "2", unit: "box" }, { id: 99_999, qty: "4", unit: "case" }]);
      await openSheet(page);
      await page.getByTestId("remove-row-99999").click();
      await expect(status(page)).toHaveText("Removed missing item 99999. 1 item left.");
      await undo(page).click();
      expect(await typedRows(page)).toEqual([{ id: IBUPROFEN.id, qty: "2", unit: "box" }, { id: 99_999, qty: "4", unit: "case" }]);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// A handheld scanner types the code and then Enter. Enter in "Add an item" did nothing, so a scan only filled the box and the
// next scan was glued onto it. With exactly one match Enter now adds it and empties the box; in every other case it does nothing.
test.describe("Order sheet: Enter in 'Add an item' adds a single match", () => {
  const SCAN_A = mk(7501, "Zinc lozenges, 24 count", { barcode: "0049000028911", supplier_order_number: "ZL-24" });
  const SCAN_B = mk(7502, "Vitamin C chewables", { barcode: "0073210045512" });
  const SCAN_C = mk(7503, "Vitamin D drops", { barcode: "0073210045529" });
  const STOCK = [SCAN_A, SCAN_B, SCAN_C];

  const search = (page: Page): Locator => page.getByTestId("add-search");

  async function start(page: Page, rows: Array<{ id: number }> = []): Promise<MockApi> {
    const mock = await installMockApi(page, { medications: STOCK });
    await seedDraft(page, rows);
    await openSheet(page);
    return mock;
  }

  /** What a scanner does: the characters one after the other, then Enter. */
  async function scan(page: Page, code: string): Promise<void> {
    await search(page).focus();
    await page.keyboard.type(code);
    await page.keyboard.press("Enter");
  }

  test("a scanned barcode that matches one item adds it, says so and empties the box; the next scan starts clean and is not glued onto the first", async ({ page }) => {
    const mock = await start(page);
    await scan(page, SCAN_A.barcode);
    await expect.poll(() => sheetRowIds(page)).toEqual([SCAN_A.id]);
    await expect(page.getByTestId("add-status")).toHaveText(`Added ${nameOf(SCAN_A)}. 1 item on the sheet.`);
    await expect(search(page)).toHaveValue("");
    await expect(search(page), "the box keeps the keyboard, so the next scan lands in it").toBeFocused();
    await expect(page.locator('[data-testid^="add-result-"]')).toHaveCount(0);

    await scan(page, SCAN_B.barcode);
    await expect.poll(() => sheetRowIds(page)).toEqual([SCAN_A.id, SCAN_B.id]);
    await expect(search(page)).toHaveValue("");
    expect(await typedRows(page)).toEqual([{ id: SCAN_A.id, qty: "", unit: "" }, { id: SCAN_B.id, qty: "", unit: "" }]);
    await expectScreenMatchesDraft(page);
    expect(writes(mock)).toEqual([]); // looking for an item never writes to the inventory
  });

  test("a name or a supplier order number that matches exactly one item works the same way", async ({ page }) => {
    await start(page);
    await search(page).fill("zinc loz");
    await expect(page.locator('[data-testid^="add-result-"]')).toHaveCount(1);
    await search(page).press("Enter");
    await expect.poll(() => sheetRowIds(page)).toEqual([SCAN_A.id]);
    await expect(search(page)).toHaveValue("");

    await search(page).fill("chewables");
    await search(page).press("Enter");
    await expect.poll(() => sheetRowIds(page)).toEqual([SCAN_A.id, SCAN_B.id]);

    await search(page).fill("vitamin d");
    await search(page).press("Enter");
    await expect.poll(() => sheetRowIds(page)).toEqual([SCAN_A.id, SCAN_B.id, SCAN_C.id]);
  });

  test("several matches: Enter does nothing visible, keeps the query and the list, and submits nothing", async ({ page }) => {
    const mock = await start(page);
    const navigations: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest()) navigations.push(request.url());
    });
    const requestsBefore = mock.requests.length;
    await search(page).fill("vitamin");
    await expect(page.locator('[data-testid^="add-result-"]')).toHaveCount(2);
    await search(page).press("Enter");
    await settle(page);
    expect(await sheetRowIds(page)).toEqual([]);
    await expect(search(page)).toHaveValue("vitamin");
    await expect(page.locator('[data-testid^="add-result-"]')).toHaveCount(2);
    await expect(page.getByTestId("add-status")).toHaveText("");
    expect(navigations).toEqual([]);
    expect(mock.requests.length).toBe(requestsBefore);
    expect(writes(mock)).toEqual([]);
    await expect(page.getByTestId("sheet-empty")).toBeVisible();
  });

  test("no match: Enter does nothing visible and keeps what was typed", async ({ page }) => {
    await start(page);
    await search(page).fill("no such item anywhere");
    await expect(page.getByText(/No items match/)).toBeVisible();
    await search(page).press("Enter");
    await settle(page);
    expect(await sheetRowIds(page)).toEqual([]);
    await expect(search(page)).toHaveValue("no such item anywhere");
    await expect(page.getByTestId("add-status")).toHaveText("");

    await search(page).fill("");
    await search(page).press("Enter"); // an empty box: nothing to add either
    await settle(page);
    expect(await sheetRowIds(page)).toEqual([]);
  });

  test("an item that is already on the sheet: Enter says so, adds no second row, empties the box and keeps the keyboard in it, so the next scan is not lost", async ({ page }) => {
    await start(page, [{ id: SCAN_A.id }]);
    await page.getByTestId(`qty-input-${SCAN_A.id}`).fill("5");
    await scan(page, SCAN_A.barcode);
    await expect(page.getByTestId("add-status")).toHaveText(`Already on the sheet: ${nameOf(SCAN_A)}.`);
    expect(await typedRows(page)).toEqual([{ id: SCAN_A.id, qty: "5", unit: "" }]); // nothing was added, nothing was reset
    await expect(search(page)).toHaveValue("");
    await expect(search(page), "the page shows the row, but the box keeps the keyboard").toBeFocused();

    // The next scan goes straight into the box (no click, no focus call): it is added, and nothing leaked into the quantity.
    await page.keyboard.type(SCAN_B.barcode);
    await page.keyboard.press("Enter");
    await expect.poll(() => sheetRowIds(page)).toEqual([SCAN_A.id, SCAN_B.id]);
    expect(await typedRows(page)).toEqual([{ id: SCAN_A.id, qty: "5", unit: "" }, { id: SCAN_B.id, qty: "", unit: "" }]);
  });

  test("a search made only of accents is no search: nothing is listed and Enter adds nothing", async ({ page }) => {
    await start(page);
    await search(page).fill("\u0308"); // a lone combining accent: nothing to look for once accents are ignored
    await settle(page);
    await expect(page.locator('[data-testid^="add-result-"]')).toHaveCount(0);
    await expect(page.getByText(/No items match/)).toHaveCount(0);
    await search(page).press("Enter");
    await settle(page);
    expect(await sheetRowIds(page)).toEqual([]);
  });

  test("Enter that confirms a text composition (IME) or is held down is not an add; a plain Enter afterwards is", async ({ page }) => {
    await start(page);
    await search(page).fill(SCAN_A.barcode);
    await search(page).evaluate((input) => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true }));
    });
    await settle(page);
    expect(await sheetRowIds(page)).toEqual([]);
    await expect(search(page)).toHaveValue(SCAN_A.barcode);
    await search(page).press("Enter");
    await expect.poll(() => sheetRowIds(page)).toEqual([SCAN_A.id]);
  });

  test("the help text under the box says that Enter adds a single match, and the box is described by it", async ({ page }) => {
    await start(page);
    const help = page.locator("#" + (await search(page).getAttribute("aria-describedby")));
    await expect(help).toContainText("Enter");
    await expect(help).toContainText("one item");
    await expect(help).toContainText("Add");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Wording the review found wrong or inconsistent, and limits that cut text off without saying so.
test.describe("Order sheet: wording that says what the controls do", () => {
  test("the on-hand and barcode checkboxes say that they change the Excel file too, and they do", async ({ page }) => {
    const mock = await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id, qty: "2", unit: "box" }]);
    await openSheet(page);
    const onHand = page.getByLabel("Show on-hand column (printed sheet and Excel file)");
    const barcode = page.getByLabel("Show barcode column (printed sheet and Excel file)");
    await expect(onHand).toHaveAttribute("data-testid", "show-on-hand");
    await expect(barcode).toHaveAttribute("data-testid", "show-barcode");
    await expect(page.getByText("Show on-hand column on the printed sheet")).toHaveCount(0);
    await expect(page.getByText("Show barcode column", { exact: true })).toHaveCount(0);

    // the label is true: both files follow the checkbox
    expect(await previewHeaders(page)).toEqual(["Item", "Supplier order no.", "Order qty", "Unit"]);
    await onHand.check();
    await barcode.check();
    expect(await previewHeaders(page)).toEqual(["Item", "Supplier order no.", "Order qty", "Unit", "On hand", "Barcode"]);
    const { workbook } = await downloadXlsx(page);
    expect(workbook.sheet("Order sheet").table().headers).toEqual(["No.", "Item", "Supplier order no.", "Order qty", "Unit", "On hand", "Barcode"]);
    expect(exportBodies(mock)[0]).toMatchObject({ showOnHand: true, showBarcode: true });
  });

  test("the notes under the rows read right for one item and for several (1 item: 'It prints'; 2 items: 'They print')", async ({ page }) => {
    await installMockApi(page);
    await seedDraft(page, [{ id: ASPIRIN.id }]); // no supplier order number, no quantity yet
    await openSheet(page);
    const supplier = page.getByTestId("missing-supplier-summary");
    const quantity = page.getByTestId("empty-qty-summary");
    await expect(supplier).toHaveText("1 item has no supplier order number. It prints as “—”. Add the number on the Admin page.");
    await expect(quantity).toHaveText("1 row has no order quantity yet. It prints with an empty box to fill in by hand.");

    await addFromSearch(page, "thermometer", THERMOMETER); // a second item without both
    await expect(supplier).toHaveText("2 items have no supplier order number. They print as “—”. Add the number on the Admin page.");
    await expect(quantity).toHaveText("2 rows have no order quantity yet. They print with an empty box to fill in by hand.");
  });

  test("the search boxes and the empty-sheet card call it a 'supplier order number', like every label", async ({ page }) => {
    await installMockApi(page);
    await openSheet(page);
    await expect(page.getByTestId("add-search")).toHaveAttribute("placeholder", "Name, barcode or supplier order no.");
    await expect(page.getByTestId("sheet-empty")).toContainText("find one here by name, barcode or supplier order number.");
    await expect(page.getByTestId("sheet-empty")).not.toContainText("supplier number");
    await openInventory(page);
    await expect(page.getByTestId("search-input")).toHaveAttribute("placeholder", "Name, barcode or supplier order no.");
  });

  test("a search result shows the barcode when the barcode is what matched, so the person can see why it is listed", async ({ page }) => {
    await installMockApi(page);
    await openSheet(page);
    await page.getByTestId("add-search").fill(CETIRIZINE.barcode);
    const byBarcode = page.getByTestId(`add-result-${CETIRIZINE.id}`);
    await expect(byBarcode).toContainText(`Barcode: ${CETIRIZINE.barcode}`);
    await page.getByTestId("add-search").fill("cetirizine");
    await expect(page.getByTestId(`add-result-${CETIRIZINE.id}`)).not.toContainText("Barcode");
    await page.getByTestId("add-search").fill("CT-10"); // matched by the supplier order number: that is already on the line
    await expect(page.getByTestId(`add-result-${CETIRIZINE.id}`)).not.toContainText("Barcode");
  });
});

test.describe("Order sheet: no box cuts typed text off without saying so", () => {
  /** Pastes (an input event the browser limits like a paste) instead of setting the value, so a maxLength would cut it. */
  async function paste(page: Page, box: Locator, text: string): Promise<void> {
    await box.focus();
    await page.keyboard.insertText(text);
  }

  test("a pasted 12-digit quantity stays as pasted, a message names the limit, Print and Excel stay blocked until it is fixed, and the saved draft keeps it as typed", async ({
    page,
  }) => {
    const mock = await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id }, { id: CETIRIZINE.id, qty: "6", unit: "box" }]);
    await openSheet(page);
    const qty = page.getByTestId(`qty-input-${IBUPROFEN.id}`);
    const rowError = row(page, IBUPROFEN).getByRole("alert");

    await paste(page, qty, "999999999999");
    await expect(qty, "the box keeps every digit that was pasted").toHaveValue("999999999999");
    await expect(qty).toHaveAttribute("aria-invalid", "true");
    await expect(rowError).toHaveText("Too large. Enter 999,999,999 or less.");
    await expect(page.getByTestId("invalid-qty-summary")).toContainText("1 row has an order quantity that isn’t valid");
    await expect(page.getByTestId("invalid-qty-summary")).toContainText("999,999,999");
    await expect(page.getByTestId("print-button")).toBeDisabled();
    await expect(page.getByTestId("export-xlsx")).toBeDisabled();
    await expect(page.getByText(/Fix the order quantity on 1 row first/)).toBeVisible();
    expect((await readDraft(page))?.rows.find((r) => r.id === IBUPROFEN.id)?.qty).toBe("999999999999"); // never a different, valid number
    expect((await previewRows(page))[0][2]).toBe("");
    await expectScreenMatchesDraft(page);

    // it survives a reload as typed: it is not cut down to a valid number on the way back in
    await page.reload();
    await waitSheetReady(page);
    await expect(page.getByTestId(`qty-input-${IBUPROFEN.id}`)).toHaveValue("999999999999");
    await expect(page.getByTestId("print-button")).toBeDisabled();

    // typing a 10th digit works the same way
    const second = page.getByTestId(`qty-input-${IBUPROFEN.id}`);
    await second.fill("");
    await second.focus();
    await page.keyboard.type("1234567890");
    await expect(second).toHaveValue("1234567890");
    await expect(row(page, IBUPROFEN).getByRole("alert")).toHaveText("Too large. Enter 999,999,999 or less.");

    expect(mock.requestsTo("POST", /xlsx/)).toHaveLength(0); // nothing was exported while it was wrong
    await second.fill("250000000"); // fixed: the largest valid size is still accepted
    await expect(row(page, IBUPROFEN).getByRole("alert")).toHaveCount(0);
    await expect(page.getByTestId("print-button")).toBeEnabled();
    await expect(page.getByTestId("export-xlsx")).toBeEnabled();
    expect((await previewRows(page))[0][2]).toBe("250000000");
  });

  test("a row's order unit says so when it reaches its 40-character limit (and the other boxes say so at theirs)", async ({ page }) => {
    await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id }]);
    await openSheet(page);

    const unit = page.getByTestId(`unit-input-${IBUPROFEN.id}`);
    const unitNote = page.getByTestId(`unit-limit-${IBUPROFEN.id}`);
    await paste(page, unit, "u".repeat(60));
    await expect(unit).toHaveValue("u".repeat(40));
    await expect(unitNote, "the cut is explained next to the box").toContainText("40 characters");
    await expect(unitNote).toBeVisible();
    await unit.fill("box");
    await expect(unitNote).toBeHidden(); // nothing to say while there is room

    const boxes: Array<[string, string, number]> = [
      ["sheet-title", "sheet-title-limit", 120],
      ["sheet-prepared-by", "sheet-prepared-by-limit", 80],
      ["sheet-notes", "sheet-notes-limit", 1000],
    ];
    for (const [boxId, noteId, limit] of boxes) {
      const box = page.getByTestId(boxId);
      const note = page.getByTestId(noteId);
      await expect(note, `${boxId}: no message while there is room`).toBeHidden();
      await box.fill("");
      await paste(page, box, "x".repeat(limit + 30));
      await expect(box, `${boxId} holds ${limit} characters`).toHaveValue("x".repeat(limit));
      await expect(note, `${boxId}: the cut is explained`).toBeVisible();
      await expect(note).toContainText(`${limit.toLocaleString("en-US")} characters`);
      await box.fill("short");
      await expect(note).toBeHidden();
    }
  });
});

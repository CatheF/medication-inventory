// Browser tests of the MANUAL order sheet: choosing items, typing quantities, keeping the draft, and never having side
// effects. Requirements: TASK.md sections 3, 4, 5 and 9; SPEC.md 2.10 and 3.3. Print layout and workbook internals have
// their own package (e2e-print-export); here the export is only used to show that what staff typed arrives unchanged.
//
// Every /api/* call is answered by tests/e2e/helpers/mock-api.ts (no database), with synthetic data only.
// Run: E2E_BASE_URL=http://127.0.0.1:3100 CHROMIUM_PATH=<chromium> npx playwright test tests/e2e/order-sheet.spec.ts
import fs from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Medication } from "@/lib/db";
import { buildCategories, buildMedications } from "../helpers/fixtures";
import { readXlsx, type XlsxWorkbook } from "../helpers/xlsx-reader";
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

async function sheetRowIds(page: Page): Promise<number[]> {
  return page
    .locator('[data-testid^="sheet-row-"]')
    .evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.rowId)));
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

    // pressing it again adds nothing and says why
    await button.click();
    await expect(status).toContainText("already on the sheet. Nothing was added.");
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

  test("'Add all' on a category adds only what that category shows under the current filters, says how many, and Undo takes off exactly those", async ({
    page,
  }) => {
    await installMockApi(page);
    await openInventory(page);
    await page.getByTestId("stock-filter-low").click(); // Antibiotics then shows Azithromycin and Nitrofurantoin only
    const antibiotics = categoryIdByName("Antibiotics");
    await page.getByTestId(`group-add-all-${antibiotics}`).click();

    await expect(page.getByTestId("bulk-status")).toContainText("Added 2 items from Antibiotics to the order sheet.");
    await expect(orderBar(page)).toContainText("2 items on the order sheet");
    await expect(page.getByTestId(`order-checkbox-${AZITHROMYCIN.id}`)).toBeChecked();
    await expect(page.getByTestId(`order-checkbox-${NITROFURANTOIN.id}`)).toBeChecked();
    expect((await readDraft(page))?.rows.map((r) => r.id).sort()).toEqual([AZITHROMYCIN.id, NITROFURANTOIN.id].sort());

    await page.getByTestId("bulk-undo").click();
    await expect(page.getByTestId("bulk-status")).toContainText("Undid adding 2 items.");
    await expect(page.getByTestId(`order-checkbox-${AZITHROMYCIN.id}`)).not.toBeChecked();
    expect((await readDraft(page))?.rows ?? []).toEqual([]);
    // Amoxicillin (plenty in stock, hidden by the filter) was never added
    await page.getByTestId("stock-filter-all").click();
    await expect(page.getByTestId(`order-checkbox-${AMOXICILLIN.id}`)).not.toBeChecked();
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
    await expect(page.getByTestId("add-status")).toContainText(`Removed ${nameOf(CETIRIZINE)} from the sheet. 2 items left.`);
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

  test("the quantity box stops at 9 digits and shows what it kept; spaces and leading zeros are accepted and print as the plain number", async ({
    page,
  }) => {
    await installMockApi(page);
    await seedDraft(page, [{ id: IBUPROFEN.id }, { id: CETIRIZINE.id }]);
    await openSheet(page);

    const first = page.getByTestId(`qty-input-${IBUPROFEN.id}`);
    await first.click();
    await first.pressSequentially("1234567890");
    await expect(first).toHaveValue("123456789"); // the browser refuses the 10th digit: what is shown is what is stored
    expect((await readDraft(page))?.rows[0].qty).toBe("123456789");
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

  test("supplier order numbers like 00417-B, 0092, AX-1182/4 and a 64-character code appear exactly, in the builder, the printed sheet and the Excel file", async ({
    page,
  }) => {
    const long64 = `0042-${"ABCDEFGHIJ".repeat(5)}-LONGCODE`;
    expect(long64).toHaveLength(64);
    const codes: Array<{ item: Medication; code: string }> = [
      { item: mk(8101, "Code with letters and a dash", { supplier_order_number: "00417-B" }), code: "00417-B" },
      { item: mk(8102, "Code with leading zeros only", { supplier_order_number: "0092" }), code: "0092" },
      { item: mk(8103, "Code with a slash", { supplier_order_number: "AX-1182/4" }), code: "AX-1182/4" },
      { item: mk(8104, "Code at the 64-character limit", { supplier_order_number: long64 }), code: long64 },
    ];
    await installMockApi(page, { medications: codes.map((c) => c.item) });
    await seedDraft(page, codes.map((c) => ({ id: c.item.id })));
    await openSheet(page);

    for (const { item, code } of codes) {
      await expect(row(page, item).getByText(code, { exact: true })).toBeVisible(); // builder
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

// Existing behavior that must be PRESERVED: the Scan tab must still load and work
// when the inventory or the category requests fail, are slow, or answer with something unexpected. Staff scan stock in
// and out all day; a problem with the LIST endpoints must never stop a barcode lookup or a stock movement.
//
// Everything here passes on the current app and on an older build of it (point E2E_BASE_URL at that build). What the
// current UI does BETTER when the inventory fails (error notice with Retry instead of an empty inventory) is in
// existing-resilience-improvements.spec.ts, which is expected to fail on an older build by design.
import { test, expect, type Page } from "@playwright/test";
import { installMockApi, type MockApi } from "./helpers/mock-api";
import {
  CATEGORIES_LIST,
  ITEM,
  MEDICATIONS_LIST,
  TRANSACTIONS,
  chooseMode,
  currentStock,
  expectedScanStats,
  inventoryFixture,
  isOriginalUi,
  itemByName,
  lookupManually,
  manualBarcodeBox,
  openHome,
  quantityBox,
  statValue,
  watchPage,
  type PageWatch,
} from "./helpers/existing-behavior";

/**
 * The ORIGINAL page logs the failed fetch / unreadable answer with console.error itself (the current page reports it
 * on screen instead and logs nothing). Only these lines are forgiven, and only for the failure modes that make the
 * original's fetch or JSON parsing throw.
 */
const ORIGINAL_UI_OWN_ERROR_LOG = [/TypeError: Failed to fetch/, /SyntaxError/];

/** Unexpected console output; the original UI's own error log is forgiven ONLY when the page really is the original UI. */
async function unexpectedConsole(page: Page, watch: PageWatch): Promise<string[]> {
  return watch.problems((await isOriginalUi(page)) ? ORIGINAL_UI_OWN_ERROR_LOG : []);
}

type Endpoint = "medications" | "categories";

const LIST_PATH: Record<Endpoint, RegExp> = { medications: MEDICATIONS_LIST, categories: CATEGORIES_LIST };

type FailureMode = {
  name: string;
  /** Makes GET of one inventory-data list endpoint fail from now on. */
  install(page: Page, mock: MockApi, endpoint: Endpoint): Promise<void>;
};

/** A list endpoint answer that is not JSON at all (what a gateway error page looks like). */
async function answerWithHtml(page: Page, mock: MockApi, endpoint: Endpoint): Promise<void> {
  await page.route(`**/api/${endpoint}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    mock.requests.push({ method: "GET", path: new URL(route.request().url()).pathname, search: "", body: undefined });
    return route.fulfill({ status: 502, contentType: "text/html", body: "<html><body>Bad gateway</body></html>" });
  });
}

const FAILURE_MODES: readonly FailureMode[] = [
  {
    name: "the server answers 500",
    install: async (_page, mock, endpoint) =>
      mock.failNext({ method: "GET", path: LIST_PATH[endpoint], status: 500, body: { error: "Unexpected database error." }, times: 999 }),
  },
  {
    name: "the database is unreachable (503)",
    install: async (_page, mock, endpoint) =>
      mock.failNext({
        method: "GET",
        path: LIST_PATH[endpoint],
        status: 503,
        body: { error: "Can’t reach the database. Check the connection, and that the Supabase project isn’t paused." },
        times: 999,
      }),
  },
  {
    name: "the connection drops",
    install: async (_page, mock, endpoint) => mock.failNext({ method: "GET", path: LIST_PATH[endpoint], networkError: true, times: 999 }),
  },
  {
    name: "the answer is a 200 with something that is not a list",
    install: async (_page, mock, endpoint) =>
      mock.failNext({ method: "GET", path: LIST_PATH[endpoint], status: 200, body: { message: "ok but not a list" }, times: 999 }),
  },
  { name: "the answer is an HTML error page, not JSON", install: answerWithHtml },
];

async function expectScanTabRenders(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Scan", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inventory", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manual", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Quick", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "▼ Dispense" })).toBeVisible();
  await expect(page.getByRole("button", { name: "▲ Receive" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Camera" })).toBeVisible();
  await expect(manualBarcodeBox(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Lookup", exact: true })).toBeVisible();
  for (const label of ["Total Items", "In Stock", "Low Stock"]) await expect(page.getByText(label, { exact: true })).toBeVisible();
}

/** The whole manual flow works: look an item up, dispense some, see the new stock. The barcode endpoints are not the failing ones. */
async function expectScanFlowWorks(page: Page, mock: MockApi): Promise<void> {
  const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
  await lookupManually(page, ibuprofen.barcode);
  await expect(currentStock(page)).toHaveText("Current stock: 18 units");
  await expect(page.getByText(ITEM.ibuprofen, { exact: true })).toBeVisible();
  await quantityBox(page).fill("2");
  await page.getByRole("button", { name: "Dispense 2 units" }).click();
  await expect(page.getByText(`Dispensed 2 units of ${ITEM.ibuprofen}. New stock: 16`)).toBeVisible();
  expect(ibuprofen.stock).toBe(16);
  expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([
    { medication_id: ibuprofen.id, type: "dispense", quantity: 2 },
  ]);
}

test.describe("the Scan tab still works when /api/medications fails", () => {
  for (const mode of FAILURE_MODES) {
    test(`the Scan tab renders, looks an item up and records a dispense when ${mode.name}`, async ({ page }) => {
      // The list requests fail on purpose, and keep failing for the whole test (also the refresh after the dispense).
      const watch = watchPage(page, { failedLoads: [MEDICATIONS_LIST] });
      const mock = await installMockApi(page, { medications: inventoryFixture() });
      await mode.install(page, mock, "medications");

      await openHome(page, mock);
      await expectScanTabRenders(page);
      await expectScanFlowWorks(page, mock);

      expect(await unexpectedConsole(page, watch)).toEqual([]);
    });
  }
});

test.describe("the Scan tab still works when /api/categories fails", () => {
  for (const mode of FAILURE_MODES) {
    test(`the Scan tab renders, looks an item up and records a dispense when ${mode.name}`, async ({ page }) => {
      const watch = watchPage(page, { failedLoads: [CATEGORIES_LIST] });
      const mock = await installMockApi(page, { medications: inventoryFixture() });
      await mode.install(page, mock, "categories");

      await openHome(page, mock);
      await expectScanTabRenders(page);
      await expectScanFlowWorks(page, mock);

      expect(await unexpectedConsole(page, watch)).toEqual([]);
    });
  }
});

test.describe("the Scan tab still works when both inventory requests fail", () => {
  test("the Scan tab renders, looks an item up and records a dispense when the server is down for both lists", async ({ page }) => {
    const watch = watchPage(page, { failedLoads: [MEDICATIONS_LIST, CATEGORIES_LIST] });
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    mock.failNext({ method: "GET", path: MEDICATIONS_LIST, status: 503, body: { error: "Can’t reach the database." }, times: 999 });
    mock.failNext({ method: "GET", path: CATEGORIES_LIST, status: 503, body: { error: "Can’t reach the database." }, times: 999 });

    await openHome(page, mock);
    await expectScanTabRenders(page);
    await expectScanFlowWorks(page, mock);

    expect(await unexpectedConsole(page, watch)).toEqual([]);
  });

  test("Receive works too, and an unknown barcode is still saved for staff review", async ({ page }) => {
    // The unknown code's lookup answers 404 by design (that is how the page learns it is new); Chromium logs it.
    const watch = watchPage(page, { failedLoads: [MEDICATIONS_LIST, CATEGORIES_LIST, /\/api\/medications\/barcode\/4440001112223$/] });
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    mock.failNext({ method: "GET", path: MEDICATIONS_LIST, status: 503, body: { error: "Can’t reach the database." }, times: 999 });
    mock.failNext({ method: "GET", path: CATEGORIES_LIST, status: 503, body: { error: "Can’t reach the database." }, times: 999 });
    await openHome(page, mock);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await chooseMode(page, "receive");
    await lookupManually(page, ibuprofen.barcode);
    await quantityBox(page).fill("5");
    await page.getByRole("button", { name: "Receive 5 units" }).click();
    await expect(page.getByText(`Added 5 units of ${ITEM.ibuprofen}. New stock: 23`)).toBeVisible();
    await page.getByRole("button", { name: "Scan another" }).click();

    await lookupManually(page, "4440001112223");
    await expect(page.getByText("New barcode — saved for staff review.")).toBeVisible();
    expect(mock.medications.find((m) => m.barcode === "4440001112223")).toMatchObject({ is_unnamed: true, stock: 0 });
    expect(await unexpectedConsole(page, watch)).toEqual([]);
  });
});

test.describe("the Scan tab does not wait for the inventory", () => {
  test("while the inventory request is still pending, a lookup and a dispense already work; when it answers the numbers appear", async ({
    page,
  }) => {
    const watch = watchPage(page);
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    // Hold the inventory answer back until the test lets it go (registered after the shared mock, so it runs first).
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/medications", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await gate;
      return route.fallback();
    });
    await page.goto("/");
    await expect(manualBarcodeBox(page)).toBeVisible();

    // Hydrated and listening, even though the inventory has not arrived.
    await expectScanTabRenders(page);
    await expectScanFlowWorks(page, mock);

    release();
    const stats = expectedScanStats(mock.medications);
    await expect(statValue(page, "Total Items")).toHaveText(String(stats.total));
    await expect(statValue(page, "Low Stock")).toHaveText(String(stats.low));
    expect(watch.problems()).toEqual([]);
  });
});

test.describe("recovering", () => {
  test("after a failed first load, reloading the page with the server back shows the real numbers", async ({ page }) => {
    // One failed load per list, on purpose.
    const watch = watchPage(page, { failedLoads: [MEDICATIONS_LIST, CATEGORIES_LIST] });
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    mock.failNext({ method: "GET", path: MEDICATIONS_LIST, status: 503, body: { error: "Can’t reach the database." } });
    mock.failNext({ method: "GET", path: CATEGORIES_LIST, status: 503, body: { error: "Can’t reach the database." } });
    await openHome(page, mock);
    await expectScanTabRenders(page);

    await page.reload();

    const stats = expectedScanStats(mock.medications);
    await expect(statValue(page, "Total Items")).toHaveText(String(stats.total));
    await expect(statValue(page, "In Stock")).toHaveText(String(stats.inStock));
    await expect(statValue(page, "Low Stock")).toHaveText(String(stats.low));
    expect(await unexpectedConsole(page, watch)).toEqual([]);
  });

  test("a stock movement made while the list was down shows in the numbers once the list answers again", async ({ page }) => {
    // The list fails twice on purpose: the page load, then the refresh after the dispense. The third answer is real.
    const watch = watchPage(page, { failedLoads: [MEDICATIONS_LIST] });
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    mock.failNext({ method: "GET", path: MEDICATIONS_LIST, status: 503, body: { error: "Can’t reach the database." }, times: 2 });
    await openHome(page, mock);

    await expectScanFlowWorks(page, mock); // dispenses 2 of 18 -> 16, the refresh after it fails too
    await page.getByRole("button", { name: "Scan another" }).click();
    // Another movement triggers a third list request, which succeeds: the numbers are now the real ones.
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    await chooseMode(page, "receive");
    await lookupManually(page, ibuprofen.barcode);
    await page.getByRole("button", { name: "Receive 1 units" }).click();
    await expect(page.getByText("New stock: 17")).toBeVisible();

    const stats = expectedScanStats(mock.medications);
    await expect(statValue(page, "Total Items")).toHaveText(String(stats.total));
    await expect(statValue(page, "Low Stock")).toHaveText(String(stats.low));
    expect(await unexpectedConsole(page, watch)).toEqual([]);
  });
});

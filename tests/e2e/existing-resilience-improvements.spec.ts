// NEW-UI-ONLY BY DESIGN: when the inventory cannot be loaded, the Inventory tab and the Scan tab SAY so (error notice +
// Retry, dashes instead of zeros) instead of looking like an empty inventory. An older build swallowed every API error
// into an empty list ("No medications yet", stat cards at 0); these tests catch that behavior coming back.
//
// Expected results:
//   * against the current app: every test passes;
//   * against an older build of the app (point E2E_BASE_URL at it): 5 of the 6 tests fail, each on the first assertion
//     that looks for the error notice / warning (it does not exist there). That failure is the evidence that these tests
//     detect the defect. The 6th ("the notice is shown ... only when the inventory is missing") is a negative control:
//     it checks there is no false alarm when everything loaded, so it passes on both.
// The behavior that must be identical on both (the Scan tab keeps working) is in existing-resilience.spec.ts.
import { test, expect } from "@playwright/test";
import { installMockApi } from "./helpers/mock-api";
import { buildCategories, categoryId } from "../helpers/fixtures";
import {
  CATEGORIES_LIST,
  ITEM,
  MEDICATIONS_LIST,
  TRANSACTIONS,
  expectedScanStats,
  inventoryFixture,
  itemByName,
  lookupManually,
  openHome,
  openInventoryTab,
  openScanTab,
  quantityBox,
  statValue,
  watchPage,
} from "./helpers/existing-behavior";

const DB_DOWN = "Can’t reach the database. Check the connection, and that the Supabase project isn’t paused.";

test.describe("Inventory tab: a failed load is an error with Retry, never an empty inventory", () => {
  test("the error names the cause and says the inventory is not empty; no list and no empty state; Retry loads the list", async ({
    page,
  }) => {
    // One failed load, on purpose (Chromium logs the 503).
    const watch = watchPage(page, { failedLoads: [MEDICATIONS_LIST] });
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    mock.failNext({ method: "GET", path: MEDICATIONS_LIST, status: 503, body: { error: DB_DOWN } });
    await openHome(page, mock);
    await openInventoryTab(page);

    const error = page.getByTestId("inventory-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute("role", "alert");
    await expect(error).toContainText("Couldn’t load the inventory");
    await expect(error).toContainText("This does not mean the inventory is empty.");
    await expect(error).toContainText("Can’t reach the database");
    await expect(page.getByText("No medications yet")).toHaveCount(0);
    await expect(page.getByTestId("inventory-empty")).toHaveCount(0);
    await expect(page.getByTestId("inventory-summary")).toHaveCount(0);
    await expect(page.locator('[data-testid^="item-card-"]')).toHaveCount(0);

    await error.getByRole("button", { name: "Retry" }).click();

    await expect(page.getByTestId("inventory-summary")).toHaveText(`Showing all ${mock.medications.length} items.`);
    await expect(page.getByTestId("inventory-error")).toHaveCount(0);
    await expect(page.getByTestId(`item-card-${itemByName(mock.medications, ITEM.ibuprofen).id}`)).toBeVisible();
    expect(mock.requestsTo("GET", MEDICATIONS_LIST)).toHaveLength(2);
    expect(watch.problems()).toEqual([]);
  });

  test("when the connection drops the message says the server could not be reached, and Retry works once it is back", async ({ page }) => {
    const watch = watchPage(page, { failedLoads: [MEDICATIONS_LIST] });
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    mock.failNext({ method: "GET", path: MEDICATIONS_LIST, networkError: true });
    await openHome(page, mock);
    await openInventoryTab(page);

    const error = page.getByTestId("inventory-error");
    await expect(error).toContainText("Could not reach the server while loading the inventory");
    await expect(page.getByText("No medications yet")).toHaveCount(0);

    await error.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("inventory-summary")).toHaveText(`Showing all ${mock.medications.length} items.`);
    expect(watch.problems()).toEqual([]);
  });

  test("a failed refresh after a successful load keeps the list on screen and warns that it may be out of date", async ({ page }) => {
    // The refresh after the dispense fails on purpose (Chromium logs the 503).
    const watch = watchPage(page, { failedLoads: [MEDICATIONS_LIST] });
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    await openHome(page, mock);
    const stats = expectedScanStats(mock.medications);
    await expect(statValue(page, "Total Items")).toHaveText(String(stats.total));
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    mock.failNext({ method: "GET", path: MEDICATIONS_LIST, status: 503, body: { error: DB_DOWN } });
    await lookupManually(page, ibuprofen.barcode);
    await quantityBox(page).fill("2");
    await page.getByRole("button", { name: "Dispense 2 units" }).click();
    await expect(page.getByText(`New stock: 16`)).toBeVisible();

    // The Scan tab keeps the last numbers it had (they are not blanked or zeroed by the failed refresh).
    await expect(statValue(page, "Total Items")).toHaveText(String(stats.total));

    await openInventoryTab(page);
    const warning = page.getByTestId("inventory-refresh-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Inventory could not be refreshed.");
    await expect(warning).toContainText("The list below is the last one that loaded");
    await expect(page.getByTestId("inventory-summary")).toHaveText(`Showing all ${stats.total} items.`);
    await expect(page.getByTestId("inventory-error")).toHaveCount(0);

    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("inventory-refresh-warning")).toHaveCount(0);
    // After the retry the list shows the stock after the dispense.
    await expect(page.getByTestId(`item-card-${ibuprofen.id}`)).toContainText("16");
    expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(1);
    expect(watch.problems()).toEqual([]);
  });
});

test.describe("Scan tab: a failed load shows dashes (never zero) and a notice with Retry, and scanning keeps working", () => {
  test("the stat cards show an em dash instead of 0, the notice names the cause, and Retry fills in the real numbers", async ({ page }) => {
    const watch = watchPage(page, { failedLoads: [MEDICATIONS_LIST] });
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    mock.failNext({ method: "GET", path: MEDICATIONS_LIST, status: 503, body: { error: DB_DOWN } });
    await openHome(page, mock);

    const notice = page.getByTestId("scan-inventory-error");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("role", "alert");
    await expect(notice).toContainText("Couldn’t load the inventory");
    await expect(notice).toContainText("This does not mean the inventory is empty.");
    await expect(notice).toContainText("Can’t reach the database");
    for (const label of ["Total Items", "In Stock", "Low Stock"]) {
      await expect(statValue(page, label)).toContainText("—");
      await expect(statValue(page, label)).not.toHaveText(/^0$/);
    }

    // Scanning is unaffected while the notice is shown.
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    await lookupManually(page, ibuprofen.barcode);
    await expect(page.getByText("Current stock:")).toHaveText("Current stock: 18 units");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await notice.getByRole("button", { name: "Retry" }).click();
    const stats = expectedScanStats(mock.medications);
    await expect(statValue(page, "Total Items")).toHaveText(String(stats.total));
    await expect(statValue(page, "In Stock")).toHaveText(String(stats.inStock));
    await expect(statValue(page, "Low Stock")).toHaveText(String(stats.low));
    await expect(page.getByTestId("scan-inventory-error")).toHaveCount(0);
    expect(watch.problems()).toEqual([]);
  });

  test("the notice is shown on the Scan tab only when the inventory is missing, not when everything loaded", async ({ page }) => {
    const watch = watchPage(page);
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    await openHome(page, mock);
    await expect(statValue(page, "Total Items")).toHaveText(String(mock.medications.length));

    await expect(page.getByTestId("scan-inventory-error")).toHaveCount(0);
    await openInventoryTab(page);
    await expect(page.getByTestId("inventory-error")).toHaveCount(0);
    await openScanTab(page);
    await expect(page.getByTestId("scan-inventory-error")).toHaveCount(0);
    expect(watch.problems()).toEqual([]);
  });
});

test.describe("Categories failing does not hide the inventory", () => {
  test("every item is still listed (under 'Category unavailable') with a warning and Retry; the Scan tab numbers stay correct; Retry restores the groups", async ({
    page,
  }) => {
    // One failed category load, on purpose (Chromium logs the 500).
    const watch = watchPage(page, { failedLoads: [CATEGORIES_LIST] });
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    mock.failNext({ method: "GET", path: CATEGORIES_LIST, status: 500, body: { error: "Unexpected database error." } });
    await openHome(page, mock);
    const stats = expectedScanStats(mock.medications);
    await expect(statValue(page, "Total Items")).toHaveText(String(stats.total));
    await expect(statValue(page, "Low Stock")).toHaveText(String(stats.low));

    await openInventoryTab(page);
    await expect(page.getByTestId("categories-error")).toBeVisible();
    await expect(page.getByTestId("categories-error")).toContainText("Categories could not be loaded");
    // Nothing is hidden: the summary counts every item, and categorized items sit under "Category unavailable".
    await expect(page.getByTestId("inventory-summary")).toHaveText(`Showing all ${stats.total} items.`);
    await expect(page.getByTestId("group-heading-unknown")).toBeVisible();
    await expect(page.getByTestId("inventory-error")).toHaveCount(0);

    await page.getByTestId("categories-error").getByRole("button", { name: "Retry" }).click();

    await expect(page.getByTestId("categories-error")).toHaveCount(0);
    await expect(page.getByTestId("group-heading-unknown")).toHaveCount(0);
    const antibiotics = buildCategories("uuid")[2];
    await expect(page.getByTestId(`group-heading-${categoryId(2, "uuid")}`)).toContainText(antibiotics.name);
    expect(watch.problems()).toEqual([]);
  });
});

// Existing behavior that must be PRESERVED: the physical (USB) barcode scanner and
// Quick mode. A USB scanner behaves like a keyboard: it types the code very fast and ends with Enter, with no
// field focused. The page listens for that anywhere, on either tab.
//
// The same locators work on the current app and on an older build of it (see tests/e2e/helpers/existing-behavior.ts).
import { test, expect, type Page } from "@playwright/test";
import type { Medication } from "@/lib/db";
import { installMockApi, type MockApi } from "./helpers/mock-api";
import {
  BARCODE_LOOKUP,
  ITEM,
  MEDICATIONS_LIST,
  TRANSACTIONS,
  asRecord,
  chooseMode,
  controlPageClock,
  createsIn,
  currentStock,
  expectedScanStats,
  holdAnswers,
  inventoryFixture,
  inventoryWith,
  itemByName,
  lookupManually,
  lookupsIn,
  manualBarcodeBox,
  noteBox,
  openHome,
  openInventoryTab,
  quantityBox,
  recordPageFetches,
  scanWithKeyboard,
  statValue,
  watchPage,
  type ExpectedNoise,
  type PageWatch,
} from "./helpers/existing-behavior";

async function boot(
  page: Page,
  expected: ExpectedNoise = {},
  items: Medication[] = inventoryFixture()
): Promise<{ mock: MockApi; watch: PageWatch }> {
  const watch = watchPage(page, expected);
  const mock = await installMockApi(page, { medications: items });
  await openHome(page, mock);
  await expect(statValue(page, "Total Items")).toHaveText(String(mock.medications.length));
  return { mock, watch };
}

/** The Quick-mode toast headline: "−1" (U+2212) after a dispense, "+1" after a receive. */
const MINUS_ONE = "−1";

test.describe("physical barcode scanner (Manual mode)", () => {
  test("a scan (digits typed fast, then Enter, nothing focused) looks the item up with its leading zero intact", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    expect(ibuprofen.barcode.startsWith("0")).toBe(true);

    await scanWithKeyboard(page, ibuprofen.barcode);

    await expect(currentStock(page)).toHaveText("Current stock: 18 units");
    await expect(page.getByText(ITEM.ibuprofen, { exact: true })).toBeVisible();
    expect(mock.requestsTo("GET", BARCODE_LOOKUP).map((r) => r.path)).toEqual([`/api/medications/barcode/${ibuprofen.barcode}`]);
    // The scanned code is also shown in the manual box, so staff can see what was read.
    await expect(manualBarcodeBox(page)).toHaveValue(ibuprofen.barcode);
    expect(watch.problems()).toEqual([]);
  });

  test("a scan of a letters-and-digits code (MED-1003) is looked up whole", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const aspirin = itemByName(mock.medications, ITEM.aspirin);
    expect(aspirin.barcode).toBe("MED-1003");

    await scanWithKeyboard(page, aspirin.barcode);

    await expect(currentStock(page)).toHaveText("Current stock: 60 units");
    await expect(page.getByText(ITEM.aspirin, { exact: true })).toBeVisible();
    expect(mock.requestsTo("GET", BARCODE_LOOKUP).map((r) => r.path)).toEqual(["/api/medications/barcode/MED-1003"]);
    expect(watch.problems()).toEqual([]);
  });

  test("a scanned code that contains a space is looked up whole", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const template = itemByName(mock.medications, ITEM.aspirin);
    mock.medications.push({ ...template, id: 9002, name: "Spaced barcode item", barcode: "AB 123", stock: 11, is_unnamed: false });

    await scanWithKeyboard(page, "AB 123");

    await expect(currentStock(page)).toHaveText("Current stock: 11 units");
    await expect(page.getByText("Spaced barcode item", { exact: true })).toBeVisible();
    expect(mock.requestsTo("GET", BARCODE_LOOKUP).map((r) => r.path)).toEqual(["/api/medications/barcode/AB%20123"]);
    expect(watch.problems()).toEqual([]);
  });

  test("a scan works from the Inventory tab too: the page jumps to the Scan tab with the item", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const aspirin = itemByName(mock.medications, ITEM.aspirin);

    await openInventoryTab(page);
    await expect(page.getByRole("button", { name: "Low", exact: true })).toBeVisible();
    await scanWithKeyboard(page, aspirin.barcode);

    await expect(currentStock(page)).toHaveText("Current stock: 60 units");
    await expect(statValue(page, "Total Items")).toHaveText(String(mock.medications.length));
    expect(watch.problems()).toEqual([]);
  });

  test("a scan still works from the Inventory tab while a filter button has keyboard focus (as after clicking it)", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const aspirin = itemByName(mock.medications, ITEM.aspirin);

    await openInventoryTab(page);
    // Clicking a filter leaves keyboard focus on the button, exactly as it is when staff reach for the scanner next.
    await page.getByRole("button", { name: "Low", exact: true }).click();
    await scanWithKeyboard(page, aspirin.barcode, { keepFocus: true });

    await expect(currentStock(page)).toHaveText("Current stock: 60 units");
    await expect(page.getByText(ITEM.aspirin, { exact: true })).toBeVisible();
    expect(mock.requestsTo("GET", BARCODE_LOOKUP)).toHaveLength(1);
    expect(watch.problems()).toEqual([]);
  });

  test("a scanner that types into the focused barcode box fills it and looks the item up once on Enter", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const acetaminophen = itemByName(mock.medications, ITEM.acetaminophen);

    await manualBarcodeBox(page).focus();
    await page.keyboard.type(acetaminophen.barcode);
    await expect(manualBarcodeBox(page)).toHaveValue(acetaminophen.barcode);
    await page.keyboard.press("Enter");

    await expect(currentStock(page)).toHaveText("Current stock: 120 units");
    expect(mock.requestsTo("GET", BARCODE_LOOKUP)).toHaveLength(1);
    expect(watch.problems()).toEqual([]);
  });

  test("a stray Enter with nothing typed does nothing, and the next real scan is looked up exactly once", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await page.keyboard.press("Enter");
    await scanWithKeyboard(page, ibuprofen.barcode);

    await expect(currentStock(page)).toHaveText("Current stock: 18 units");
    expect(mock.requestsTo("GET", BARCODE_LOOKUP)).toHaveLength(1);
    expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(0);
    expect(watch.problems()).toEqual([]);
  });

  test("an unknown scanned code is saved for staff review exactly like a typed one", async ({ page }) => {
    const code = "ZN-0001";
    // The unknown code's lookup answers 404 by design (that is how the page learns it is new); Chromium logs it.
    const { mock, watch } = await boot(page, { failedLoads: [/\/api\/medications\/barcode\/ZN-0001$/] });

    await scanWithKeyboard(page, code);

    await expect(page.getByText("New barcode — saved for staff review.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Complete in Admin" })).toHaveAttribute("href", "/admin");
    const posts = mock.requestsTo("POST", MEDICATIONS_LIST);
    expect(posts).toHaveLength(1);
    expect(asRecord(posts[0].body)).toEqual({ name: null, barcode: code, stock: 0, threshold: 10, unit: "units", is_unnamed: true });
    expect(mock.medications.find((m) => m.barcode === code)).toMatchObject({ is_unnamed: true, stock: 0 });
    expect(watch.problems()).toEqual([]);
  });

  test("a scanned item can be received straight away: scan, set the quantity, confirm", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await chooseMode(page, "receive");
    await scanWithKeyboard(page, ibuprofen.barcode);
    await expect(currentStock(page)).toHaveText("Current stock: 18 units");
    await page.getByRole("button", { name: "Receive 1 units" }).click();

    await expect(page.getByText(`Added 1 units of ${ITEM.ibuprofen}. New stock: 19`)).toBeVisible();
    expect(ibuprofen.stock).toBe(19);
    expect(watch.problems()).toEqual([]);
  });

  test("a scanned code with lowercase letters is looked up exactly as it was read", async ({ page }) => {
    const { mock, watch } = await boot(page, {}, inventoryWith([{ name: "Lowercase barcode item", barcode: "ab-77x", stock: 5 }]));

    await scanWithKeyboard(page, "ab-77x");

    await expect(currentStock(page)).toHaveText("Current stock: 5 units");
    await expect(page.getByText("Lowercase barcode item", { exact: true })).toBeVisible();
    // Not upper-cased on the way: "AB-77X" is a different, unknown code, and a junk item would be saved for it.
    expect(mock.requestsTo("GET", BARCODE_LOOKUP).map((r) => r.path)).toEqual(["/api/medications/barcode/ab-77x"]);
    expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(0);
    expect(watch.problems()).toEqual([]);
  });

  for (const field of [
    { name: "Quantity box", box: quantityBox },
    { name: "Note box", box: noteBox },
  ] as const) {
    test(`digits typed into the ${field.name} and Enter belong to that box: nothing is looked up or saved`, async ({ page }) => {
      const fetches = await recordPageFetches(page, /\/api\/medications/);
      const { mock, watch } = await boot(page);
      const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
      await lookupManually(page, ibuprofen.barcode);
      await expect(currentStock(page)).toHaveText("Current stock: 18 units");

      // Real key presses: fast digits and Enter look exactly like a scan of the code "12" to the page.
      await field.box(page).click();
      await page.keyboard.type("12");
      await page.keyboard.press("Enter");

      // They stay in the box. Read as a scan they would replace the card with a lookup of "12" and, since no such
      // item exists, save an unnamed junk item for it.
      await expect(field.box(page)).toHaveValue("12");
      await expect(currentStock(page)).toHaveText("Current stock: 18 units");
      const log = await fetches();
      expect(lookupsIn(log)).toEqual([`GET /api/medications/barcode/${ibuprofen.barcode}`]);
      expect(createsIn(log)).toEqual([]);
      expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(0);
      expect(watch.problems()).toEqual([]);
    });
  }

  test("a scan that arrives while a Dispense is on its way does not swap the card: the movement is recorded for the item on the card", async ({
    page,
  }) => {
    const fetches = await recordPageFetches(page, /\/api\/medications/);
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    const aspirin = itemByName(mock.medications, ITEM.aspirin);
    await lookupManually(page, ibuprofen.barcode);
    await quantityBox(page).fill("5");

    const gate = await holdAnswers(page, "**/api/transactions");
    try {
      await page.getByRole("button", { name: "Dispense 5 units" }).click();
      await expect(page.getByRole("button", { name: "Processing..." })).toBeVisible();
      await scanWithKeyboard(page, aspirin.barcode);
      // The scan was ignored on the spot: the page asked about the first item only.
      expect(lookupsIn(await fetches())).toEqual([`GET /api/medications/barcode/${ibuprofen.barcode}`]);
    } finally {
      gate.release();
    }

    await expect(page.getByText(`Dispensed 5 units of ${ITEM.ibuprofen}. New stock: 13`)).toBeVisible();
    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([
      { medication_id: ibuprofen.id, type: "dispense", quantity: 5 },
    ]);
    expect(ibuprofen.stock).toBe(13);
    expect(aspirin.stock).toBe(60);
    expect(watch.problems()).toEqual([]);
  });
});

test.describe("Quick mode: every scan is one stock movement of 1 unit", () => {
  test("in Dispense, a scan removes exactly 1 unit and shows a −1 toast with the item's name", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await page.getByRole("button", { name: "Quick", exact: true }).click();
    // No manual box and no confirmation step in Quick mode; the page says what a scan does.
    await expect(manualBarcodeBox(page)).toHaveCount(0);
    await expect(page.getByText("Each scan subtracts 1 unit instantly — no confirmation needed")).toBeVisible();

    await scanWithKeyboard(page, ibuprofen.barcode);

    await expect(page.getByText(MINUS_ONE, { exact: true })).toBeVisible();
    await expect(page.getByText(ITEM.ibuprofen, { exact: true })).toBeVisible();
    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([
      { medication_id: ibuprofen.id, type: "dispense", quantity: 1 },
    ]);
    expect(ibuprofen.stock).toBe(17);
    // No item card is opened.
    await expect(currentStock(page)).toHaveCount(0);
    expect(watch.problems()).toEqual([]);
  });

  test("in Receive, a scan adds exactly 1 unit and shows a +1 toast", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await page.getByRole("button", { name: "Quick", exact: true }).click();
    await chooseMode(page, "receive");
    await expect(page.getByText("Each scan adds 1 unit instantly — no confirmation needed")).toBeVisible();

    await scanWithKeyboard(page, ibuprofen.barcode);

    await expect(page.getByText("+1", { exact: true })).toBeVisible();
    await expect(page.getByText(ITEM.ibuprofen, { exact: true })).toBeVisible();
    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([
      { medication_id: ibuprofen.id, type: "receive", quantity: 1 },
    ]);
    expect(ibuprofen.stock).toBe(19);
    expect(watch.problems()).toEqual([]);
  });

  test("the same code read twice in a row (a double-fire) moves stock only once; after the toast clears, a new scan counts", async ({
    page,
  }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    await page.getByRole("button", { name: "Quick", exact: true }).click();

    // Both reads arrive within milliseconds of each other, as when a scanner reads one label twice.
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await page.keyboard.type(`${ibuprofen.barcode}\n${ibuprofen.barcode}\n`);

    await expect(page.getByText(MINUS_ONE, { exact: true })).toBeVisible();
    expect(ibuprofen.stock).toBe(17);
    expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(1);

    // The toast goes away by itself (the wait is on the toast, not on a timer of the test); then a fresh scan is a new movement.
    await expect(page.getByText(MINUS_ONE, { exact: true })).toHaveCount(0);
    await scanWithKeyboard(page, ibuprofen.barcode);
    await expect(page.getByText(MINUS_ONE, { exact: true })).toBeVisible();
    expect(ibuprofen.stock).toBe(16);
    expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(2);
    expect(watch.problems()).toEqual([]);
  });

  test("an unknown code only shows an 'Unknown barcode' toast: nothing is created and no stock moves", async ({ page }) => {
    // The unknown code's lookup answers 404 (Chromium logs it as a failed load).
    const { mock, watch } = await boot(page, { failedLoads: [/\/api\/medications\/barcode\/8880001112223$/] });
    const before = mock.medications.length;
    await page.getByRole("button", { name: "Quick", exact: true }).click();

    await scanWithKeyboard(page, "8880001112223");

    await expect(page.getByText("Unknown barcode", { exact: true })).toBeVisible();
    await expect(page.getByText("8880001112223", { exact: true })).toBeVisible();
    expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(0);
    expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(0);
    expect(mock.medications).toHaveLength(before);
    expect(watch.problems()).toEqual([]);
  });

  test("dispensing an item that is out of stock shows an 'Out of stock' toast and records nothing", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const empty = itemByName(mock.medications, ITEM.nitrofurantoin);
    expect(empty.stock).toBe(0);
    await page.getByRole("button", { name: "Quick", exact: true }).click();

    await scanWithKeyboard(page, empty.barcode);

    await expect(page.getByText("Out of stock", { exact: true })).toBeVisible();
    await expect(page.getByText(ITEM.nitrofurantoin, { exact: true })).toBeVisible();
    expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(0);
    expect(empty.stock).toBe(0);
    expect(watch.problems()).toEqual([]);
  });

  test("receiving into an item that is out of stock is allowed in Quick mode", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const empty = itemByName(mock.medications, ITEM.nitrofurantoin);
    await page.getByRole("button", { name: "Quick", exact: true }).click();
    await chooseMode(page, "receive");

    await scanWithKeyboard(page, empty.barcode);

    await expect(page.getByText("+1", { exact: true })).toBeVisible();
    expect(empty.stock).toBe(1);
    expect(watch.problems()).toEqual([]);
  });

  test("when the server refuses the movement, its message is the toast and the stock stays as it was", async ({ page }) => {
    // The refusal is the server's: Chromium logs the 400 answer of POST /api/transactions.
    const { mock, watch } = await boot(page, { failedLoads: [TRANSACTIONS] });
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    mock.failNext({ method: "POST", path: TRANSACTIONS, status: 400, body: { error: "Insufficient stock. Current stock: 18" } });
    await page.getByRole("button", { name: "Quick", exact: true }).click();

    await scanWithKeyboard(page, ibuprofen.barcode);

    await expect(page.getByText("Insufficient stock. Current stock: 18")).toBeVisible();
    await expect(page.getByText(MINUS_ONE, { exact: true })).toHaveCount(0);
    expect(ibuprofen.stock).toBe(18);
    expect(watch.problems()).toEqual([]);
  });

  test("when the server cannot be reached, the toast says 'Network error' and nothing is recorded", async ({ page }) => {
    const { mock, watch } = await boot(page, { failedLoads: [BARCODE_LOOKUP] });
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    mock.failNext({ method: "GET", path: BARCODE_LOOKUP, networkError: true });
    await page.getByRole("button", { name: "Quick", exact: true }).click();

    await scanWithKeyboard(page, ibuprofen.barcode);

    await expect(page.getByText("Network error")).toBeVisible();
    expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(0);
    expect(ibuprofen.stock).toBe(18);
    expect(watch.problems()).toEqual([]);
  });

  test("switching back to Manual brings the lookup box back and lookups work again", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await page.getByRole("button", { name: "Quick", exact: true }).click();
    await expect(manualBarcodeBox(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Manual", exact: true }).click();
    await expect(manualBarcodeBox(page)).toBeVisible();

    await scanWithKeyboard(page, ibuprofen.barcode);
    await expect(currentStock(page)).toHaveText("Current stock: 18 units");
    // A lookup is not a movement.
    expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(0);
    expect(watch.problems()).toEqual([]);
  });

  test("the same label read again 300 ms after a finished movement is a double-fire and moves nothing, while a read a second later counts", async ({
    page,
  }) => {
    // The page's Date.now() is under the test's control, so "300 ms later" is exact on any machine; and the repeated
    // read is checked inside the page, the instant the key is handled, so no waiting is needed to prove nothing happened.
    const clock = await controlPageClock(page);
    const fetches = await recordPageFetches(page, /\/api\/medications\/barcode\//);
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    await page.getByRole("button", { name: "Quick", exact: true }).click();

    const t0 = await clock.pin();
    await scanWithKeyboard(page, ibuprofen.barcode);
    await expect(page.getByText(MINUS_ONE, { exact: true })).toBeVisible(); // the first movement is complete
    expect(ibuprofen.stock).toBe(17);
    expect(await fetches()).toHaveLength(1);

    await clock.setTo(t0 + 300);
    await scanWithKeyboard(page, ibuprofen.barcode);
    expect(await fetches()).toHaveLength(1); // ignored: the server was not even asked
    expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(1);
    expect(ibuprofen.stock).toBe(17);

    // A second after the first read it is a deliberate new scan, so the protection is a short debounce, not a permanent block.
    await clock.setTo(t0 + 1000);
    await scanWithKeyboard(page, ibuprofen.barcode);
    await expect.poll(() => ibuprofen.stock, { message: "the read a second later is a second movement" }).toBe(16);
    expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(2);
    expect(watch.problems()).toEqual([]);
  });

  test("the same label read again while its first lookup is still waiting for the server is ignored (no second movement)", async ({ page }) => {
    // The clock is moved far past any debounce window, so only the "a movement is in progress" protection can stop the second read.
    const clock = await controlPageClock(page);
    const fetches = await recordPageFetches(page, /\/api\/medications\/barcode\//);
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    await page.getByRole("button", { name: "Quick", exact: true }).click();

    const gate = await holdAnswers(page, "**/api/medications/barcode/**");
    try {
      const t0 = await clock.pin();
      await scanWithKeyboard(page, ibuprofen.barcode); // its lookup is now in flight
      await expect.poll(() => gate.arrived(), { message: "the first lookup reached the server" }).toBe(1);

      await clock.setTo(t0 + 5000);
      await scanWithKeyboard(page, ibuprofen.barcode);
      expect(await fetches()).toHaveLength(1); // ignored: the server was not asked a second time
    } finally {
      gate.release();
    }

    await expect(page.getByText(MINUS_ONE, { exact: true })).toBeVisible();
    expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(1);
    expect(ibuprofen.stock).toBe(17);
    expect(watch.problems()).toEqual([]);
  });

  test("after a Quick-mode movement the Low Stock number follows the new stock: an item that reaches its threshold becomes low, without a reload", async ({
    page,
  }) => {
    const base = expectedScanStats(inventoryFixture());
    const items = inventoryWith([{ name: "One above its threshold", barcode: "EDGE-ONE-ABOVE", stock: 11, threshold: 10 }]);
    const { watch } = await boot(page, {}, items);
    await expect(statValue(page, "Low Stock")).toHaveText(String(base.low)); // 11 > 10: not low yet

    await page.getByRole("button", { name: "Quick", exact: true }).click();
    await scanWithKeyboard(page, "EDGE-ONE-ABOVE");
    await expect(page.getByText(MINUS_ONE, { exact: true })).toBeVisible();

    await expect(statValue(page, "Low Stock")).toHaveText(String(base.low + 1)); // 10 <= 10: low
    await expect(statValue(page, "In Stock")).toHaveText(String(base.inStock + 1));
    await expect(statValue(page, "Total Items")).toHaveText(String(base.total + 1));
    expect(watch.problems()).toEqual([]);
  });
});

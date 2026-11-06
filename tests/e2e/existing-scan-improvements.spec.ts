// NEW-UI-ONLY BY DESIGN: how the scanner, the item card and the camera behave. The behavior that must be identical on an
// older build is in existing-scan-flow.spec.ts and existing-scanner-and-quick-mode.spec.ts; this file holds the
// differences, so that the improvements cannot be lost unnoticed:
//   * a scan typed right after clicking a tab (the tab button still has keyboard focus) works: the scanner's Enter is
//     swallowed, so it cannot press that button again and undo the scan;
//   * a scan works while a checkbox has focus, and a Space inside a scanned code does not flip the focused checkbox
//     ("Add to order sheet" checkboxes);
//   * digits typed into the Inventory controls (search box, sort select) are typing, not a scan;
//   * scanning a second item while a card is open shows the second item, with a fresh quantity and an empty note;
//   * the Scan tab fits a 360 px phone even with a 128-character barcode, and the top bar does not push the Usage page
//     past the edge of a 360 px screen (an older build's "Kiosk Mode" link ended at x = 405);
//   * the camera is switched off when the Scan tab is left;
//   * an item that a scan created shows up in the Scan tab's numbers and in the Inventory tab without a reload;
//   * keyboard, screen reader and touch access of the Scan tab (focus after a failed retry, alert / status regions, names,
//     pressed states, 44 px targets).
//
// Expected results:
//   * against the current app: every test passes;
//   * against an older build of the app (point E2E_BASE_URL at it): every test fails, each on the first assertion that
//     looks for the new behavior (the checkbox, search box, sort select, alert and status regions do not exist there; the
//     scan after a tab click is undone; the second scan is ignored; the page overflows; the camera stays on; the list is
//     stale; the targets are small). That failure is the evidence that these tests detect what the older build lacks.
//
// Chromium's synthetic camera is switched on for the whole file (only the camera test uses it); see
// existing-camera-idle.spec.ts. What this file does NOT prove: that a real camera device works.
import { test, expect, type Locator, type Page } from "@playwright/test";
import type { Medication } from "@/lib/db";
import { installMockApi, type MockApi } from "./helpers/mock-api";
import {
  BARCODE_LOOKUP,
  ITEM,
  MEDICATIONS_LIST,
  TRANSACTIONS,
  asRecord,
  cameraTrackStates,
  createsIn,
  currentStock,
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
  openScanTab,
  quantityBox,
  recordPageFetches,
  scanWithKeyboard,
  statValue,
  trackCamera,
  watchPage,
  type ExpectedNoise,
  type PageWatch,
} from "./helpers/existing-behavior";

test.use({
  launchOptions: {
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  permissions: ["camera"],
});

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

const DB_DOWN = "Can’t reach the database. Check the connection, and that the Supabase project isn’t paused.";

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The checkbox of an item on the Inventory tab. */
const orderCheckbox = (page: Page, item: Medication): Locator => page.getByTestId(`order-checkbox-${item.id}`);

test.describe("scanner keystrokes and the control that has keyboard focus", () => {
  test("a scan typed right after clicking the Inventory tab (the tab button still has focus) shows the item: the scanner's Enter does not press that button again", async ({
    page,
  }) => {
    const { mock, watch } = await boot(page);
    const aspirin = itemByName(mock.medications, ITEM.aspirin);

    await openInventoryTab(page);
    // How a scanner is really used: staff click the tab, then reach for the scanner. Focus is still on the tab button.
    await expect(page.getByRole("button", { name: "Inventory", exact: true })).toBeFocused();
    await scanWithKeyboard(page, aspirin.barcode, { keepFocus: true });

    // The scanner's Enter would press the focused Inventory tab button, switch back to the Inventory tab and hide the result.
    await expect(currentStock(page)).toHaveText("Current stock: 60 units");
    await expect(page.getByRole("button", { name: "Scan", exact: true })).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("inventory-summary")).toHaveCount(0);
    expect(mock.requestsTo("GET", BARCODE_LOOKUP)).toHaveLength(1);
    expect(watch.problems()).toEqual([]);
  });

  test("a scan works while the 'Add to order sheet' checkbox has keyboard focus, and the ticked box stays ticked", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    const aspirin = itemByName(mock.medications, ITEM.aspirin);

    await openInventoryTab(page);
    await expect(orderCheckbox(page, ibuprofen)).toBeVisible();
    await orderCheckbox(page, ibuprofen).check();
    await expect(orderCheckbox(page, ibuprofen)).toBeFocused(); // ticking with the mouse leaves focus on the box
    await scanWithKeyboard(page, aspirin.barcode, { keepFocus: true });

    await expect(currentStock(page)).toHaveText("Current stock: 60 units");
    expect(mock.requestsTo("GET", BARCODE_LOOKUP)).toHaveLength(1);
    // The scan did not touch the order sheet selection: exactly the one item that was ticked is still ticked.
    await openInventoryTab(page);
    await expect(orderCheckbox(page, ibuprofen)).toBeChecked();
    await expect(page.locator('[data-testid^="order-checkbox-"]:checked')).toHaveCount(1);
    expect(watch.problems()).toEqual([]);
  });

  test("a Space inside a scanned code does not tick or untick the focused 'Add to order sheet' checkbox", async ({ page }) => {
    const items = inventoryWith([{ name: "Spaced barcode item", barcode: "AB 123", stock: 11 }]);
    const { mock, watch } = await boot(page, {}, items);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await openInventoryTab(page);
    await expect(orderCheckbox(page, ibuprofen)).toBeVisible();
    await orderCheckbox(page, ibuprofen).check();
    await expect(orderCheckbox(page, ibuprofen)).toBeFocused();
    // The Space inside the code, left alone, would press the focused checkbox and untick it.
    await scanWithKeyboard(page, "AB 123", { keepFocus: true });

    await expect(currentStock(page)).toHaveText("Current stock: 11 units");
    expect(mock.requestsTo("GET", BARCODE_LOOKUP).map((r) => r.path)).toEqual(["/api/medications/barcode/AB%20123"]);
    await openInventoryTab(page);
    await expect(orderCheckbox(page, ibuprofen)).toBeChecked();
    await expect(page.locator('[data-testid^="order-checkbox-"]:checked')).toHaveCount(1);
    expect(watch.problems()).toEqual([]);
  });

  test("digits typed into the Inventory search box and Enter belong to the box: nothing is looked up and the page stays on the Inventory tab", async ({
    page,
  }) => {
    const fetches = await recordPageFetches(page, /\/api\/medications/);
    const { mock, watch } = await boot(page);

    await openInventoryTab(page);
    await expect(page.getByTestId("search-input")).toBeVisible();
    await page.getByTestId("search-input").click();
    await page.keyboard.type("12");
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("search-input")).toHaveValue("12");
    await expect(page.getByTestId("inventory-summary")).toBeVisible();
    await expect(manualBarcodeBox(page)).toHaveCount(0);
    const log = await fetches();
    expect(lookupsIn(log)).toEqual([]);
    expect(createsIn(log)).toEqual([]);
    expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(0);
    expect(watch.problems()).toEqual([]);
  });

  test("a letter typed into the Sort select and Enter belong to the select: the sort changes, nothing is looked up or saved", async ({ page }) => {
    const fetches = await recordPageFetches(page, /\/api\/medications/);
    const { mock, watch } = await boot(page);

    await openInventoryTab(page);
    await expect(page.getByTestId("sort-select")).toBeVisible();
    await page.getByTestId("sort-select").focus();
    await page.keyboard.type("c"); // jumps to "Category" the way a select does
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("sort-select")).toHaveValue("category");
    await expect(page.getByTestId("inventory-summary")).toBeVisible();
    const log = await fetches();
    expect(lookupsIn(log)).toEqual([]);
    expect(createsIn(log)).toEqual([]);
    expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(0);
    expect(watch.problems()).toEqual([]);
  });
});

test.describe("a second scan while an item card is open", () => {
  test("shows the second item, and the quantity and note typed for the first item do not carry over to it", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen); // 18 units
    const aspirin = itemByName(mock.medications, ITEM.aspirin); // 60 units

    await lookupManually(page, ibuprofen.barcode);
    await expect(currentStock(page)).toHaveText("Current stock: 18 units");
    await quantityBox(page).fill("50");
    await noteBox(page).fill("patient 7");

    await scanWithKeyboard(page, aspirin.barcode); // focus is dropped first: nothing is focused when a scanner is used

    await expect(currentStock(page)).toHaveText("Current stock: 60 units");
    await expect(page.getByText(ITEM.aspirin, { exact: true })).toBeVisible();
    await expect(quantityBox(page)).toHaveValue("1");
    await expect(noteBox(page)).toHaveValue("");
    expect(mock.requestsTo("GET", BARCODE_LOOKUP).map((r) => r.path)).toEqual([
      `/api/medications/barcode/${ibuprofen.barcode}`,
      `/api/medications/barcode/${aspirin.barcode}`,
    ]);

    // Confirming now moves ONE unit of the second item, with no note: nothing typed for the first item is applied to it.
    await page.getByRole("button", { name: "Dispense 1 units" }).click();
    await expect(page.getByText(`Dispensed 1 units of ${ITEM.aspirin}. New stock: 59`)).toBeVisible();
    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([{ medication_id: aspirin.id, type: "dispense", quantity: 1 }]);
    expect(ibuprofen.stock).toBe(18);
    expect(aspirin.stock).toBe(59);
    expect(watch.problems()).toEqual([]);
  });
});

test.describe("phone width", () => {
  test("the Scan tab does not scroll sideways on a 360 px phone, even with a 128-character barcode with no place to wrap", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const longCode = "L".repeat(128);
    const { mock, watch } = await boot(page, {}, inventoryWith([{ name: "Long barcode item", barcode: longCode, stock: 3 }]));

    await lookupManually(page, longCode);

    await expect(currentStock(page)).toHaveText("Current stock: 3 units");
    expect(mock.requestsTo("GET", BARCODE_LOOKUP)).toHaveLength(1);
    // The whole code is shown (it wraps inside the card) and the page itself has nothing to scroll sideways.
    const code = page.getByText(longCode, { exact: true }).first();
    await expect(code).toBeVisible();
    const box = await code.boundingBox();
    if (!box) throw new Error("the barcode text has no box");
    expect(box.x + box.width, "the barcode text ends inside the 360 px screen").toBeLessThanOrEqual(360);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "horizontal overflow of the page in px").toBeLessThanOrEqual(0);
    expect(watch.problems()).toEqual([]);
  });
});

test.describe("phone width: the top bar", () => {
  test("the Usage page does not scroll sideways on a 360 px phone: the top bar fits and the wide table scrolls inside its own box", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const watch = watchPage(page);
    await installMockApi(page, { medications: inventoryFixture() });
    // One synthetic row in the shape of GET /api/analytics (see existing-usage.spec.ts for the full set).
    await page.route("**/api/analytics**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          medications: [
            { id: 1, name: "Ibuprofen 200 mg, tablets", barcode: "012345600014", unit: "units", current_stock: 18, threshold: 10, category_id: null,
              is_unnamed: false, total_dispensed: 140, total_received: 50, daily_rate: 4.67, days_until_threshold: 3, days_until_empty: 4,
              reorder_date: null, daily: [] },
          ],
          days: 30,
          date_range: [],
        }),
      })
    );
    await page.goto("/usage");
    await expect(page.locator("tbody tr")).toHaveCount(1);

    // The original UI's top bar pushed this page 45 px wider than the screen. (The page's own file is unchanged.)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "horizontal overflow of the page in px").toBeLessThanOrEqual(0);
    await expect(page.getByRole("columnheader", { name: "Received" })).toBeAttached();
    expect(watch.problems()).toEqual([]);
  });
});

test.describe("camera", () => {
  test("the camera is switched off when the Scan tab is left, and can be started again when staff come back", async ({ page }) => {
    await trackCamera(page);
    const { watch } = await boot(page);

    await page.getByRole("button", { name: "Start Camera" }).click();
    await expect(page.getByRole("button", { name: "Stop Camera" })).toBeVisible();
    expect(await cameraTrackStates(page)).toEqual(["live"]);

    await openInventoryTab(page);
    // The video element is gone with the tab, but the camera (and its light) must not stay on.
    await expect.poll(() => cameraTrackStates(page), { message: "the camera tracks end when the Scan tab is left" }).toEqual(["ended"]);

    await openScanTab(page);
    await expect(page.getByRole("button", { name: "Start Camera" })).toBeVisible();
    await page.getByRole("button", { name: "Start Camera" }).click();
    await expect(page.getByRole("button", { name: "Stop Camera" })).toBeVisible();
    expect(await cameraTrackStates(page)).toEqual(["ended", "live"]);
    expect(watch.problems()).toEqual([]);
  });
});

test.describe("lists follow what a scan created", () => {
  test("a barcode saved by a scan shows up in the Scan tab's Total Items and on the Inventory tab without reloading the page", async ({ page }) => {
    const code = "7771119992223";
    // The unknown code's lookup answers 404 by design (that is how the page learns it is new); Chromium logs it.
    const { mock, watch } = await boot(page, { failedLoads: [/\/api\/medications\/barcode\/7771119992223$/] });
    const before = mock.medications.length;

    await lookupManually(page, code);

    await expect(page.getByText("New barcode — saved for staff review.")).toBeVisible();
    expect(mock.medications).toHaveLength(before + 1);
    await expect(statValue(page, "Total Items")).toHaveText(String(before + 1));
    await openInventoryTab(page);
    await expect(page.getByTestId("inventory-summary")).toHaveText(`Showing all ${before + 1} items.`);
    expect(watch.problems()).toEqual([]);
  });
});

test.describe("keyboard, screen reader and touch access of the Scan tab", () => {
  test("a failed lookup is announced as an alert, and 'Try again' works from the keyboard", async ({ page }) => {
    const { mock, watch } = await boot(page, { failedLoads: [BARCODE_LOOKUP] });
    mock.failNext({ method: "GET", path: BARCODE_LOOKUP, status: 500, body: { error: "Unexpected database error." } });

    await lookupManually(page, "0123456789012");

    const alert = page.getByRole("alert").filter({ hasText: "Failed to lookup barcode" });
    await expect(alert).toBeVisible();
    await alert.getByRole("button", { name: "Try again" }).focus();
    await page.keyboard.press("Enter");
    await expect(alert).toHaveCount(0);
    await expect(manualBarcodeBox(page)).toHaveValue("");
    expect(watch.problems()).toEqual([]);
  });

  test("'Looking up barcode…' and the result of a Dispense are announced as status messages", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    const gate = await holdAnswers(page, "**/api/medications/barcode/**");
    try {
      await manualBarcodeBox(page).fill(ibuprofen.barcode);
      await page.getByRole("button", { name: "Lookup", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Looking up barcode" })).toBeVisible();
    } finally {
      gate.release();
    }

    await expect(currentStock(page)).toHaveText("Current stock: 18 units");
    await page.getByRole("button", { name: "Dispense 1 units" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Dispensed 1 units of ${ITEM.ibuprofen}. New stock: 17` })).toBeVisible();
    expect(watch.problems()).toEqual([]);
  });

  test("the Quick-mode toast lands in a polite live region that was already on the page, so a screen reader reads it out", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    await page.getByRole("button", { name: "Quick", exact: true }).click();

    const region = page.locator('[role="status"][aria-live="polite"][aria-atomic="true"]');
    await expect(region).toHaveCount(1);
    await expect(region).toHaveText(""); // empty and waiting
    const before = await region.elementHandle();
    if (!before) throw new Error("the live region is not on the page");

    await scanWithKeyboard(page, ibuprofen.barcode);

    // One assertion for both parts: the toast only stays for about two seconds.
    await expect(region).toHaveText(new RegExp(`^−1\\s*${escapeRegExp(ITEM.ibuprofen)}$`));
    // The very same element received the message (a region that appears together with its message is often not read out).
    expect(await before.evaluate((element) => element.isConnected)).toBe(true);
    expect(watch.problems()).toEqual([]);
  });

  test("when the inventory fails to load and Retry fails again, keyboard focus moves to the error notice; the next Retry loads the numbers", async ({
    page,
  }) => {
    const watch = watchPage(page, { failedLoads: [MEDICATIONS_LIST] });
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    mock.failNext({ method: "GET", path: MEDICATIONS_LIST, status: 503, body: { error: DB_DOWN }, times: 2 });
    await openHome(page, mock);

    const notice = page.getByTestId("scan-inventory-error");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("role", "alert");
    await notice.getByRole("button", { name: "Retry" }).focus();
    await page.keyboard.press("Enter");

    // The notice is replaced by the loading state while the retry runs, and takes the focused button with it. When the retry
    // fails too, focus must not be left at the top of the page: it goes to the notice.
    await expect.poll(() => mock.requestsTo("GET", MEDICATIONS_LIST).length).toBe(2);
    await expect(notice).toBeFocused();
    await expect(notice).toContainText("Can’t reach the database");

    await notice.getByRole("button", { name: "Retry" }).click();
    await expect(statValue(page, "Total Items")).toHaveText(String(mock.medications.length));
    await expect(page.getByTestId("scan-inventory-error")).toHaveCount(0);
    expect(watch.problems()).toEqual([]);
  });

  test("the Scan tab's controls have names, say which tab and which mode are selected, and have a heading to land on", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await expect(page.getByRole("heading", { level: 1, name: "Scan medications" })).toBeAttached();
    // The tab bar says which tab is showing, and keeps saying it after switching (aria-current).
    const scanTab = page.getByRole("button", { name: "Scan", exact: true });
    const inventoryTab = page.getByRole("button", { name: "Inventory", exact: true });
    await expect(scanTab).toHaveAttribute("aria-current", "true");
    await expect(inventoryTab).not.toHaveAttribute("aria-current", "true");
    await openInventoryTab(page);
    await expect(inventoryTab).toHaveAttribute("aria-current", "true");
    await expect(scanTab).not.toHaveAttribute("aria-current", "true");
    await openScanTab(page);
    await expect(scanTab).toHaveAttribute("aria-current", "true");
    await expect(inventoryTab).not.toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("button", { name: "Manual", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Quick", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "▼ Dispense" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "▲ Receive" })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Quick", exact: true }).click();
    await expect(page.getByRole("button", { name: "Quick", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Manual", exact: true })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Manual", exact: true }).click();

    await expect(page.getByRole("textbox", { name: "Barcode" })).toBeVisible();
    await lookupManually(page, ibuprofen.barcode);
    await expect(page.getByRole("textbox", { name: "Quantity" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: /^Note/ })).toBeVisible();
    expect(watch.problems()).toEqual([]);
  });

  test("on a phone, every button and box of the Scan tab is at least 40 px tall (the touch target size of SPEC 3.4)", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const { mock, watch } = await boot(page, { failedLoads: [BARCODE_LOOKUP] });
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    const tooSmall: string[] = [];
    const measure = async (label: string, target: Locator): Promise<void> => {
      await expect(target, `${label} is on the page`).toBeVisible();
      const box = await target.boundingBox();
      if (!box) throw new Error(`${label} has no box`);
      if (box.height < 40 || box.width < 40) tooSmall.push(`${label}: ${Math.round(box.width)} x ${Math.round(box.height)} px`);
    };

    await measure("Scan tab button", page.getByRole("button", { name: "Scan", exact: true }));
    await measure("Inventory tab button", page.getByRole("button", { name: "Inventory", exact: true }));
    await measure("Manual button", page.getByRole("button", { name: "Manual", exact: true }));
    await measure("Quick button", page.getByRole("button", { name: "Quick", exact: true }));
    await measure("Dispense button", page.getByRole("button", { name: "▼ Dispense" }));
    await measure("Receive button", page.getByRole("button", { name: "▲ Receive" }));
    await measure("Start Camera button", page.getByRole("button", { name: "Start Camera" }));
    await measure("barcode box", manualBarcodeBox(page));
    await measure("Lookup button", page.getByRole("button", { name: "Lookup", exact: true }));

    await lookupManually(page, ibuprofen.barcode);
    await expect(currentStock(page)).toHaveText("Current stock: 18 units");
    await measure("Quantity box", quantityBox(page));
    await measure("Note box", noteBox(page));
    await measure("Cancel button", page.getByRole("button", { name: "Cancel", exact: true }));
    await measure("Dispense confirm button", page.getByRole("button", { name: "Dispense 1 units" }));

    await page.getByRole("button", { name: "Dispense 1 units" }).click();
    await measure("Scan another button", page.getByRole("button", { name: "Scan another" }));
    await page.getByRole("button", { name: "Scan another" }).click();

    mock.failNext({ method: "GET", path: BARCODE_LOOKUP, status: 500, body: { error: "Unexpected database error." } });
    await lookupManually(page, "0123456789012");
    await measure("Try again button", page.getByRole("button", { name: "Try again" }));

    expect(tooSmall, "controls smaller than 40 x 40 px").toEqual([]);
    expect(asRecord(mock.requestsTo("POST", TRANSACTIONS)[0].body).quantity).toBe(1);
    expect(watch.problems()).toEqual([]);
  });
});

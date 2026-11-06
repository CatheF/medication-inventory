// Existing behavior that must be PRESERVED: the full-screen Kiosk page (/kiosk). A barcode that could not be saved never
// gets the "Saved for staff review" card (see the tests on failed saves below). What could break the page is everything
// around it (top bar, global styles, shared data helpers), so it is exercised end to end here with a handheld scanner
// (keystrokes) against the mocked API.
//
// Headless Chromium has no camera: without one the kiosk writes `console.error("Camera:", ...)` BY DESIGN each
// time it goes back to "Ready". That one line is whitelisted in the tests below (and only that line);
// existing-camera-idle.spec.ts runs the kiosk with a synthetic camera device and requires a completely clean console.
// What these tests do NOT prove: that a real camera reads a real barcode.
//
// The same locators work on the current app and on an older build of it (see tests/e2e/helpers/existing-behavior.ts).
import { test, expect, type Page } from "@playwright/test";
import { installMockApi, type MockApi } from "./helpers/mock-api";
import {
  BARCODE_LOOKUP,
  ITEM,
  MEDICATIONS_LIST,
  TRANSACTIONS,
  asRecord,
  inventoryFixture,
  itemByName,
  scanWithKeyboard,
  watchPage,
  type ExpectedNoise,
  type PageWatch,
} from "./helpers/existing-behavior";

/** The kiosk's own, deliberate console line when the browser has no camera (see the header comment). */
const NO_CAMERA_LOG: ExpectedNoise = { consoleErrors: [/^Camera:/] };

/**
 * Counts the kiosk's camera start attempts. The kiosk starts its camera in the same effect pass that attaches its
 * handheld-scanner key listener, so "the camera was asked for" means "the page is interactive": a scan typed from now on
 * is heard. (Works with or without a camera device: the wrapper only counts, then asks the real getUserMedia.)
 */
async function countCameraStarts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __cameraStarts: number };
    w.__cameraStarts = 0;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints?: MediaStreamConstraints) => {
      w.__cameraStarts += 1;
      return original(constraints);
    };
  });
}

async function waitUntilInteractive(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __cameraStarts: number }).__cameraStarts), {
      message: "the kiosk started its camera (so it is hydrated and listening for the scanner)",
    })
    .toBeGreaterThan(0);
}

async function bootKiosk(page: Page, expected: ExpectedNoise = NO_CAMERA_LOG): Promise<{ mock: MockApi; watch: PageWatch }> {
  const watch = watchPage(page, expected);
  await countCameraStarts(page);
  const mock = await installMockApi(page, { medications: inventoryFixture() });
  await page.goto("/kiosk");
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await waitUntilInteractive(page);
  return { mock, watch };
}

const dispenseToggle = (page: Page) => page.getByRole("button", { name: "▼ DISPENSE" });
const receiveToggle = (page: Page) => page.getByRole("button", { name: "▲ RECEIVE" });

test.describe("Kiosk page", () => {
  test("loads full screen with no top bar: Ready, both mode buttons and the way out", async ({ page }) => {
    const { watch } = await bootKiosk(page);

    // The app's own top bar (a direct child of <body>). Not `locator("nav")`: that also finds the <nav> inside the Next.js
    // dev overlay's shadow DOM, which a dev server shows ("1 Issue") because the kiosk logs its camera error on purpose.
    await expect(page.locator("body > nav")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "MedInventory" })).toHaveCount(0);
    await expect(page.getByText("Point camera at barcode or use handheld scanner")).toBeVisible();
    await expect(dispenseToggle(page)).toBeVisible();
    await expect(receiveToggle(page)).toBeVisible();
    await expect(page.getByRole("link", { name: /Exit Kiosk Mode/ })).toHaveAttribute("href", "/");
    expect(watch.problems()).toEqual([]);
  });

  test("on a 360 px phone the kiosk fits the screen: nothing scrolls sideways and both mode buttons and the way out are reachable", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const { watch } = await bootKiosk(page);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "horizontal overflow of the page in px").toBeLessThanOrEqual(0);
    for (const control of [dispenseToggle(page), receiveToggle(page), page.getByRole("link", { name: /Exit Kiosk Mode/ })]) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      if (!box) throw new Error("a kiosk control has no box");
      expect(box.x, "control starts inside the screen").toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, "control ends inside the screen").toBeLessThanOrEqual(360);
    }
    expect(watch.problems()).toEqual([]);
  });

  test("the way out leads back to the Scan page, which has its top bar again", async ({ page }) => {
    const { mock, watch } = await bootKiosk(page);

    await page.getByRole("link", { name: /Exit Kiosk Mode/ }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("body > nav")).toBeVisible();
    await expect(page.getByRole("button", { name: "Scan", exact: true })).toBeVisible();
    // The Scan page then loads the inventory as usual (wait for the request: it is made right after the page appears).
    await expect.poll(() => mock.requestsTo("GET", MEDICATIONS_LIST).length).toBeGreaterThan(0);
    expect(watch.problems()).toEqual([]);
  });

  test("Dispense: a scan opens the item with the stock before and after, + and − change the quantity, confirming shows the new stock and returns to Ready", async ({
    page,
  }) => {
    const { mock, watch } = await bootKiosk(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await scanWithKeyboard(page, ibuprofen.barcode);

    await expect(page.getByText(ITEM.ibuprofen, { exact: true })).toBeVisible();
    await expect(page.getByText(ibuprofen.barcode, { exact: true })).toBeVisible();
    await expect(page.getByText(/^Stock:\s*18\s*→\s*17/)).toBeVisible();

    await page.getByRole("button", { name: "+", exact: true }).click();
    await page.getByRole("button", { name: "+", exact: true }).click();
    await expect(page.getByText(/^Stock:\s*18\s*→\s*15/)).toBeVisible();
    await page.getByRole("button", { name: "−", exact: true }).click();
    await expect(page.getByText(/^Stock:\s*18\s*→\s*16/)).toBeVisible();
    await page.getByRole("button", { name: "−", exact: true }).click();
    await page.getByRole("button", { name: "−", exact: true }).click();
    // The quantity never goes below 1.
    await expect(page.getByText(/^Stock:\s*18\s*→\s*17/)).toBeVisible();

    await page.getByRole("button", { name: "+", exact: true }).click();
    await page.getByRole("button", { name: "+", exact: true }).click();
    await page.getByRole("button", { name: "DISPENSE 3" }).click();

    await expect(page.getByText("Dispensed 3", { exact: true })).toBeVisible();
    await expect(page.getByText("New stock:").locator("span")).toHaveText("15");
    await expect(page.getByText(ITEM.ibuprofen, { exact: true })).toBeVisible();
    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([
      { medication_id: ibuprofen.id, type: "dispense", quantity: 3 },
    ]);
    expect(ibuprofen.stock).toBe(15);

    // After a moment the kiosk is ready for the next person without anybody touching it.
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    await expect(page.getByText("Dispensed 3")).toHaveCount(0);
    expect(watch.problems()).toEqual([]);
  });

  test("Receive: the stock goes up, the confirmation says Received and the new stock", async ({ page }) => {
    const { mock, watch } = await bootKiosk(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await receiveToggle(page).click();
    await scanWithKeyboard(page, ibuprofen.barcode);
    await expect(page.getByText(/^Stock:\s*18\s*→\s*19/)).toBeVisible();
    await page.getByRole("button", { name: "RECEIVE 1" }).click();

    await expect(page.getByText("Received 1", { exact: true })).toBeVisible();
    await expect(page.getByText("New stock:").locator("span")).toHaveText("19");
    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([
      { medication_id: ibuprofen.id, type: "receive", quantity: 1 },
    ]);
    expect(ibuprofen.stock).toBe(19);
    expect(watch.problems()).toEqual([]);
  });

  test("Cancel returns to Ready without recording anything, and the same item can be scanned again at once", async ({ page }) => {
    const { mock, watch } = await bootKiosk(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await scanWithKeyboard(page, ibuprofen.barcode);
    await expect(page.getByText(ITEM.ibuprofen, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(0);

    await scanWithKeyboard(page, ibuprofen.barcode);
    await expect(page.getByText(ITEM.ibuprofen, { exact: true })).toBeVisible();
    expect(mock.requestsTo("GET", BARCODE_LOOKUP)).toHaveLength(2);
    expect(ibuprofen.stock).toBe(18);
    expect(watch.problems()).toEqual([]);
  });

  test("while one item is open for confirmation, a scan of another item does not replace it", async ({ page }) => {
    const { mock, watch } = await bootKiosk(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    const aspirin = itemByName(mock.medications, ITEM.aspirin);

    await scanWithKeyboard(page, ibuprofen.barcode);
    await expect(page.getByText(ITEM.ibuprofen, { exact: true })).toBeVisible();
    await scanWithKeyboard(page, aspirin.barcode);

    // Confirming still acts on the item the person was looking at.
    await page.getByRole("button", { name: "DISPENSE 1" }).click();
    await expect(page.getByText("Dispensed 1", { exact: true })).toBeVisible();
    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([
      { medication_id: ibuprofen.id, type: "dispense", quantity: 1 },
    ]);
    expect(mock.requestsTo("GET", BARCODE_LOOKUP).map((r) => r.path)).toEqual([`/api/medications/barcode/${ibuprofen.barcode}`]);
    expect(aspirin.stock).toBe(60);
    expect(watch.problems()).toEqual([]);
  });

  test("dispensing more than the stock shows the server's message with Try Again, and the stock is unchanged", async ({ page }) => {
    // The refusal is the server's: Chromium logs the 400 answer of POST /api/transactions.
    const { mock, watch } = await bootKiosk(page, { ...NO_CAMERA_LOG, failedLoads: [TRANSACTIONS] });
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await scanWithKeyboard(page, ibuprofen.barcode);
    await expect(page.getByText(ITEM.ibuprofen, { exact: true })).toBeVisible();
    for (let i = 0; i < 18; i += 1) await page.getByRole("button", { name: "+", exact: true }).click(); // quantity 19 > stock 18
    await page.getByRole("button", { name: "DISPENSE 19" }).click();

    await expect(page.getByText("Insufficient stock. Current stock: 18")).toBeVisible();
    await expect(page.getByText(/Dispensed/)).toHaveCount(0);
    expect(ibuprofen.stock).toBe(18);

    await page.getByRole("button", { name: "Try Again" }).click();
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    expect(watch.problems()).toEqual([]);
  });

  test("an unknown barcode is saved for staff review and opened for confirmation with a notice", async ({ page }) => {
    // The unknown code's lookup answers 404 by design (that is how the kiosk learns it is new); Chromium logs it.
    const { mock, watch } = await bootKiosk(page, { ...NO_CAMERA_LOG, failedLoads: [/\/api\/medications\/barcode\/5550001112223$/] });

    await scanWithKeyboard(page, "5550001112223");

    await expect(page.getByText("New barcode — saved for staff review in Admin")).toBeVisible();
    await expect(page.getByText("5550001112223", { exact: true }).first()).toBeVisible();
    const posts = mock.requestsTo("POST", MEDICATIONS_LIST);
    expect(posts).toHaveLength(1);
    expect(asRecord(posts[0].body)).toEqual({
      name: null,
      barcode: "5550001112223",
      stock: 0,
      threshold: 10,
      unit: "units",
      is_unnamed: true,
    });
    expect(mock.medications.find((m) => m.barcode === "5550001112223")).toMatchObject({ is_unnamed: true, stock: 0 });
    expect(watch.problems()).toEqual([]);
  });

  // The save of an unknown barcode can fail three ways: the server refuses it (400, for instance a barcode over the size
  // limit), the server fails (500), or the server cannot be reached. Nothing is saved in any of them. The kiosk must not
  // show "Unknown Barcode / Saved for staff review in Admin" in any of them: that would be false, and staff would wait for
  // an item that was never created.
  for (const failure of [
    {
      name: "the server refuses the barcode (400)",
      spec: { status: 400, body: { error: "Barcode is too long (maximum 1024 characters).", field: "barcode" } },
    },
    { name: "the server fails (500)", spec: { status: 500, body: { error: "Unexpected database error." } } },
    { name: "the server cannot be reached", spec: { networkError: true } },
  ] as const) {
    test(`when an unknown barcode cannot be saved because ${failure.name}, the kiosk says it could not save it (never that it was saved) and returns to Ready`, async ({
      page,
    }) => {
      const code = "6660001112223";
      const { mock, watch } = await bootKiosk(page, {
        ...NO_CAMERA_LOG,
        failedLoads: [/\/api\/medications\/barcode\/6660001112223$/, MEDICATIONS_LIST],
      });
      mock.failNext({ method: "POST", path: MEDICATIONS_LIST, ...failure.spec });

      await scanWithKeyboard(page, code);

      await expect(page.getByText(`Could not save barcode ${code}`, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Try Again" })).toBeVisible();
      await expect(page.getByText(/saved for staff review/i)).toHaveCount(0);
      await expect(page.getByText("Unknown Barcode")).toHaveCount(0);
      expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(1);
      expect(mock.medications.some((m) => m.barcode === code)).toBe(false);
      expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(0);

      await expect(page.getByText("Ready", { exact: true })).toBeVisible();
      await expect(page.getByText(/Could not save barcode/)).toHaveCount(0);
      expect(watch.problems()).toEqual([]);
    });
  }

  test("after a failed save the kiosk is ready again: scanning the same code saves it and opens it as a new barcode", async ({ page }) => {
    const code = "6660001112224";
    const { mock, watch } = await bootKiosk(page, {
      ...NO_CAMERA_LOG,
      failedLoads: [/\/api\/medications\/barcode\/6660001112224$/, MEDICATIONS_LIST],
    });
    mock.failNext({ method: "POST", path: MEDICATIONS_LIST, status: 500, body: { error: "Unexpected database error." } });

    await scanWithKeyboard(page, code);
    await expect(page.getByText(`Could not save barcode ${code}`, { exact: true })).toBeVisible();
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();

    await scanWithKeyboard(page, code);
    await expect(page.getByText("New barcode — saved for staff review in Admin")).toBeVisible();
    expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(2);
    expect(mock.medications.find((m) => m.barcode === code)).toMatchObject({ is_unnamed: true, stock: 0 });
    expect(watch.problems()).toEqual([]);
  });

  test("when another scan created the same unknown barcode first (409), the kiosk opens that item and claims nothing about saving", async ({
    page,
  }) => {
    // The first lookup answers 404 and the save answers 409 on purpose; the second lookup is the mock's real answer, and the
    // item exists, so the kiosk opens it exactly as for any known barcode.
    const { mock, watch } = await bootKiosk(page, { ...NO_CAMERA_LOG, failedLoads: [BARCODE_LOOKUP, MEDICATIONS_LIST] });
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    mock.failNext({ method: "GET", path: BARCODE_LOOKUP, status: 404, body: { error: "Medication not found" } });
    mock.failNext({ method: "POST", path: MEDICATIONS_LIST, status: 409, body: { error: "Barcode already exists" } });

    await scanWithKeyboard(page, ibuprofen.barcode);

    await expect(page.getByText(ITEM.ibuprofen, { exact: true })).toBeVisible();
    await expect(page.getByText(/^Stock:\s*18\s*→\s*17/)).toBeVisible();
    await expect(page.getByText(/saved for staff review/i)).toHaveCount(0);
    await expect(page.getByText(/Could not save/)).toHaveCount(0);
    expect(mock.requestsTo("GET", BARCODE_LOOKUP)).toHaveLength(2);
    expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(1);
    expect(watch.problems()).toEqual([]);
  });

  test("when the save says the barcode exists (409) but the item cannot be opened afterwards, the kiosk says it could not save it and returns to Ready", async ({
    page,
  }) => {
    const code = "6660001112225";
    const { mock, watch } = await bootKiosk(page, { ...NO_CAMERA_LOG, failedLoads: [BARCODE_LOOKUP, MEDICATIONS_LIST] });
    mock.failNext({ method: "GET", path: BARCODE_LOOKUP, status: 404, body: { error: "Medication not found" } });
    mock.failNext({ method: "POST", path: MEDICATIONS_LIST, status: 409, body: { error: "Barcode already exists" } });
    mock.failNext({ method: "GET", path: BARCODE_LOOKUP, status: 500, body: { error: "Unexpected database error." } });

    await scanWithKeyboard(page, code);

    await expect(page.getByText(`Could not save barcode ${code}`, { exact: true })).toBeVisible();
    await expect(page.getByText(/saved for staff review/i)).toHaveCount(0);
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    expect(mock.medications.some((m) => m.barcode === code)).toBe(false);
    expect(watch.problems()).toEqual([]);
  });

  for (const failure of [
    { name: "the server answers with an error", spec: { status: 500, body: { error: "x" } }, message: "Lookup failed — please try again" },
    { name: "the server cannot be reached", spec: { networkError: true }, message: "Network error" },
  ] as const) {
    test(`when the lookup fails because ${failure.name}, the kiosk says "${failure.message}" and returns to Ready`, async ({ page }) => {
      const { mock, watch } = await bootKiosk(page, { ...NO_CAMERA_LOG, failedLoads: [BARCODE_LOOKUP] });
      const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
      mock.failNext({ method: "GET", path: BARCODE_LOOKUP, ...failure.spec });
  
      await scanWithKeyboard(page, ibuprofen.barcode);

      await expect(page.getByText(failure.message)).toBeVisible();
      await expect(page.getByText("Ready", { exact: true })).toBeVisible();
      expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(0);
      expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(0);
      expect(watch.problems()).toEqual([]);
    });
  }

  test("without a camera the only console message is the kiosk's own camera line, and scanning still works", async ({ page }) => {
    // Strictest form of the whitelist: collect EVERYTHING the console reports and show that it is only that line.
    const lines: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") lines.push(message.text().split("\n")[0]);
    });
    const { mock } = await bootKiosk(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    await scanWithKeyboard(page, ibuprofen.barcode);
    await expect(page.getByText(ITEM.ibuprofen, { exact: true })).toBeVisible();

    await expect.poll(() => lines.length, { message: "the kiosk logged its camera line" }).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^Camera:/);
  });
});

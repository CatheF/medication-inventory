// What the Scan tab SAYS when something goes wrong or is recorded (TASK.md sections 6 and 8: the scanner must keep working, and
// a failed lookup must not look like "this item is not in the system"). Two messages were wrong and are fixed:
//   * Quick mode reported EVERY failed lookup as "Unknown barcode", also an HTTP 500 / 503 / 403 for a barcode that EXISTS, so
//     staff could conclude that an item is missing from the system. The barcode route answers 404 only when no item has the
//     barcode, so now only a 404 says "Unknown barcode". Any other failed answer says "Lookup failed", and a lookup that gets no
//     answer at all says "Network error"; both add "Check the connection and scan again." (a lookup is only a read: nothing
//     was recorded, so scanning again is safe). The toast stays red and goes away by itself.
//   * Manual mode's success message was built from the typed text, so with the quantity box emptied (which records 1 unit) it
//     read "Dispensed  units of X" with the number missing. It now states the quantity that was actually recorded.
//
// Same locators and helpers as the other existing-*.spec.ts files (visible text and roles, mock API in helpers/mock-api.ts).
//
// Expected results:
//   * against the current app (E2E_BASE_URL=http://127.0.0.1:3100): every test passes;
//   * against the ORIGINAL UI (http://127.0.0.1:3101): the tests about an HTTP error, a lookup that gets no answer, the recovery
//     after a failed lookup and the emptied or zero-padded quantity FAIL (it says "Unknown barcode" for a server error, has no
//     line under "Network error", and states the typed text instead of the recorded quantity); the tests for a real 404, for a
//     failure while the movement is sent and for a plainly typed quantity pass on both: that behavior must not change.
import { test, expect, type Locator, type Page } from "@playwright/test";
import type { Medication } from "@/lib/db";
import { installMockApi, type MockApi } from "./helpers/mock-api";
import {
  BARCODE_LOOKUP,
  ITEM,
  MEDICATIONS_LIST,
  TRANSACTIONS,
  chooseMode,
  currentStock,
  inventoryFixture,
  itemByName,
  lookupManually,
  manualBarcodeBox,
  openHome,
  quantityBox,
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

/** The line under "Lookup failed" and "Network error": what to do next. */
const HINT = "Check the connection and scan again.";
/** The Quick-mode toast headline after a dispense: "−1" (U+2212). */
const MINUS_ONE = "−1";
/** A red toast, whatever the shade (the current app uses red-700, the original red-500): failures stay red, never green. */
const RED_TOAST = /\bbg-red-\d{3}\b/;

async function chooseQuickMode(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Quick", exact: true }).click();
  await expect(manualBarcodeBox(page)).toHaveCount(0); // Quick mode has no manual box: the page is in the mode
}

/** The box of the Quick-mode toast whose headline is `headline` (the headline is the big text inside it). */
const toastBox = (page: Page, headline: string): Locator => page.getByText(headline, { exact: true }).locator("xpath=..");

// ── Quick mode ───────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("Quick mode: only a 404 means 'Unknown barcode'", () => {
  test("a barcode that no item has (the server answers 404) says 'Unknown barcode' with the code, in red, and records nothing", async ({ page }) => {
    const { mock, watch } = await boot(page, { failedLoads: [BARCODE_LOOKUP] }); // the 404 is logged by Chromium as a failed load
    const before = mock.medications.length;
    await chooseQuickMode(page);

    await scanWithKeyboard(page, "8880001112223");

    await expect(page.getByText("Unknown barcode", { exact: true })).toBeVisible();
    await expect(page.getByText("8880001112223", { exact: true })).toBeVisible();
    await expect(toastBox(page, "Unknown barcode")).toHaveClass(RED_TOAST);
    // Not the failure wording: this IS the answer "no such item".
    await expect(page.getByText("Lookup failed")).toHaveCount(0);
    await expect(page.getByText(HINT)).toHaveCount(0);
    expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(0); // Quick mode never saves an unknown barcode
    expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(0);
    expect(mock.medications).toHaveLength(before);
    await expect(page.getByText("Unknown barcode", { exact: true })).toHaveCount(0); // the toast goes away by itself
    expect(watch.problems()).toEqual([]);
  });

  const SERVER_FAILURES = [
    { status: 500, error: "Unexpected database error." },
    { status: 503, error: "Can’t reach the database. Check the connection, and that the Supabase project isn’t paused." },
    { status: 403, error: "The database refused this change (row-level security)." },
  ] as const;

  for (const failure of SERVER_FAILURES) {
    test(`when the lookup of an item that EXISTS fails with HTTP ${failure.status}, the toast says 'Lookup failed' and to check the connection and scan again, never 'Unknown barcode'`, async ({
      page,
    }) => {
      const { mock, watch } = await boot(page, { failedLoads: [BARCODE_LOOKUP] });
      const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
      const before = mock.medications.length;
      mock.failNext({ method: "GET", path: BARCODE_LOOKUP, status: failure.status, body: { error: failure.error } });
      await chooseQuickMode(page);

      await scanWithKeyboard(page, ibuprofen.barcode);

      await expect(page.getByText("Lookup failed", { exact: true })).toBeVisible();
      await expect(page.getByText(HINT, { exact: true })).toBeVisible();
      await expect(toastBox(page, "Lookup failed")).toHaveClass(RED_TOAST); // still the red toast
      // It is announced like every Quick-mode toast (the polite live region around it).
      await expect(page.getByRole("status").filter({ hasText: "Lookup failed" })).toBeVisible();
      // The item exists: nothing on the page may say that it does not.
      await expect(page.getByText("Unknown barcode")).toHaveCount(0);
      // A lookup is a read: nothing was recorded and nothing was created.
      expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(0);
      expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(0);
      expect(mock.medications).toHaveLength(before);
      expect(ibuprofen.stock).toBe(18);
      // The toast goes away by itself.
      await expect(page.getByText("Lookup failed", { exact: true })).toHaveCount(0);
      expect(watch.problems()).toEqual([]);
    });
  }

  test("a failure answer that is not JSON at all (a gateway's HTML error page, HTTP 502) is 'Lookup failed' too", async ({ page }) => {
    const { mock, watch } = await boot(page, { failedLoads: [BARCODE_LOOKUP] });
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    // Registered after the mock, so it answers first and the request ends there.
    await page.route("**/api/medications/barcode/**", (route) =>
      route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Bad gateway</h1>" })
    );
    await chooseQuickMode(page);

    await scanWithKeyboard(page, ibuprofen.barcode);

    await expect(page.getByText("Lookup failed", { exact: true })).toBeVisible();
    await expect(page.getByText(HINT, { exact: true })).toBeVisible();
    await expect(page.getByText("Unknown barcode")).toHaveCount(0);
    expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(0);
    expect(ibuprofen.stock).toBe(18);
    expect(watch.problems()).toEqual([]);
  });

  test("when the lookup gets no answer at all, the toast says 'Network error' with the same line, in red, and nothing is recorded", async ({
    page,
  }) => {
    const { mock, watch } = await boot(page, { failedLoads: [BARCODE_LOOKUP] });
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    mock.failNext({ method: "GET", path: BARCODE_LOOKUP, networkError: true });
    await chooseQuickMode(page);

    await scanWithKeyboard(page, ibuprofen.barcode);

    await expect(page.getByText("Network error", { exact: true })).toBeVisible();
    await expect(page.getByText(HINT, { exact: true })).toBeVisible();
    await expect(toastBox(page, "Network error")).toHaveClass(RED_TOAST);
    await expect(page.getByText("Unknown barcode")).toHaveCount(0);
    expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(0);
    expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(0);
    expect(ibuprofen.stock).toBe(18);
    await expect(page.getByText("Network error", { exact: true })).toHaveCount(0); // the toast goes away by itself
    expect(watch.problems()).toEqual([]);
  });

  test("after a failed lookup the scanner is not stuck: the next scan of the same item records its movement exactly once", async ({ page }) => {
    const { mock, watch } = await boot(page, { failedLoads: [BARCODE_LOOKUP] });
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    mock.failNext({ method: "GET", path: BARCODE_LOOKUP, status: 500, body: { error: "Unexpected database error." } });
    await chooseQuickMode(page);

    await scanWithKeyboard(page, ibuprofen.barcode);
    await expect(page.getByText("Lookup failed", { exact: true })).toBeVisible();
    expect(ibuprofen.stock).toBe(18);
    // Wait for the toast to clear (no timer in the test), then do what the toast says: scan again.
    await expect(page.getByText("Lookup failed", { exact: true })).toHaveCount(0);

    await scanWithKeyboard(page, ibuprofen.barcode);
    await expect(page.getByText(MINUS_ONE, { exact: true })).toBeVisible();
    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([{ medication_id: ibuprofen.id, type: "dispense", quantity: 1 }]);
    expect(ibuprofen.stock).toBe(17);
    expect(watch.problems()).toEqual([]);
  });

  test("when the connection drops while the movement itself is being sent, the toast says 'Network error' and does NOT tell staff to scan again (it is not known whether it was recorded)", async ({
    page,
  }) => {
    const { mock, watch } = await boot(page, { failedLoads: [TRANSACTIONS] });
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    mock.failNext({ method: "POST", path: TRANSACTIONS, networkError: true });
    await chooseQuickMode(page);

    await scanWithKeyboard(page, ibuprofen.barcode);

    await expect(page.getByText("Network error", { exact: true })).toBeVisible();
    await expect(toastBox(page, "Network error")).toHaveClass(RED_TOAST);
    // Unlike a failed lookup (a read), a movement that got no answer may have been recorded: advice to rescan could count it twice.
    await expect(page.getByText(HINT)).toHaveCount(0);
    await expect(page.getByText("Unknown barcode")).toHaveCount(0);
    expect(mock.requestsTo("GET", BARCODE_LOOKUP)).toHaveLength(1);
    expect(watch.problems()).toEqual([]);
  });
});

// ── Manual mode ──────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("Manual mode: the success message states the quantity that was recorded", () => {
  /** The button that records the movement: "Dispense 5 units" (the mode switch above it is "▼ Dispense"). */
  const dispenseButton = (page: Page): Locator => page.getByRole("button", { name: /^Dispense\b/ });
  const receiveButton = (page: Page): Locator => page.getByRole("button", { name: /^Receive\b/ });

  test("with the quantity box emptied, 1 unit is recorded and the message says 'Dispensed 1 units' (it left the number out)", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    await lookupManually(page, ibuprofen.barcode);
    await expect(currentStock(page)).toHaveText("Current stock: 18 units");

    await quantityBox(page).fill("");
    await expect(quantityBox(page)).toHaveValue("");
    await dispenseButton(page).click();

    const expected = `Dispensed 1 units of ${ITEM.ibuprofen}. New stock: 17`;
    const message = page.getByText(expected);
    await expect(message).toBeVisible();
    expect(await message.textContent(), "the exact text: the number is there and there is no double space").toBe(expected);
    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([{ medication_id: ibuprofen.id, type: "dispense", quantity: 1 }]);
    expect(ibuprofen.stock).toBe(17);
    expect(watch.problems()).toEqual([]);
  });

  test("the same in Receive: an emptied quantity records 1 unit and the message says 'Added 1 units'", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    await chooseMode(page, "receive");
    await lookupManually(page, ibuprofen.barcode);
    await expect(currentStock(page)).toHaveText("Current stock: 18 units");

    await quantityBox(page).fill("");
    await receiveButton(page).click();

    const expected = `Added 1 units of ${ITEM.ibuprofen}. New stock: 19`;
    const message = page.getByText(expected);
    await expect(message).toBeVisible();
    expect(await message.textContent()).toBe(expected);
    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([{ medication_id: ibuprofen.id, type: "receive", quantity: 1 }]);
    expect(ibuprofen.stock).toBe(19);
    expect(watch.problems()).toEqual([]);
  });

  test("a typed quantity is reported as typed: 5 records 5 and the message says 5", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    await lookupManually(page, ibuprofen.barcode);

    await quantityBox(page).fill("5");
    await dispenseButton(page).click();

    await expect(page.getByText(`Dispensed 5 units of ${ITEM.ibuprofen}. New stock: 13`)).toBeVisible();
    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([{ medication_id: ibuprofen.id, type: "dispense", quantity: 5 }]);
    expect(ibuprofen.stock).toBe(13);
    expect(watch.problems()).toEqual([]);
  });

  test("a quantity typed with leading zeros is reported as the number that was recorded: 007 records 7 and the message says 7", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    await lookupManually(page, ibuprofen.barcode);

    await quantityBox(page).fill("007");
    await dispenseButton(page).click();

    // The message states what the request sent (7), not what was typed (007).
    const expected = `Dispensed 7 units of ${ITEM.ibuprofen}. New stock: 11`;
    const message = page.getByText(expected);
    await expect(message).toBeVisible();
    expect(await message.textContent()).toBe(expected);
    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([{ medication_id: ibuprofen.id, type: "dispense", quantity: 7 }]);
    expect(ibuprofen.stock).toBe(11);
    expect(watch.problems()).toEqual([]);
  });
});

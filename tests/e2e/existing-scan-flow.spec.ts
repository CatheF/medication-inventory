// Existing behavior that must be PRESERVED: the Scan tab's manual barcode lookup, the
// Receive / Dispense flows, error handling and the stat cards / low-stock alert.
//
// Locators use visible text, roles and structure only: the same spec runs against the current app and against
// an older build of it (see tests/e2e/helpers/existing-behavior.ts). No database is involved: /api/* is answered by
// tests/e2e/helpers/mock-api.ts, which mirrors the real routes (including the transactions RPC's messages).
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
  // The stat cards show the real numbers only after the page has loaded the inventory.
  await expect(statValue(page, "Total Items")).toHaveText(String(mock.medications.length));
  return { mock, watch };
}

test.describe("Scan tab: page, stat cards and manual lookup", () => {
  test("the Scan tab loads with both tabs, the scan and stock modes, the camera panel and manual lookup, and no console errors", async ({
    page,
  }) => {
    const { watch } = await boot(page);

    await expect(page.getByRole("button", { name: "Scan", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Inventory", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Manual", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Quick", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "▼ Dispense" })).toBeVisible();
    await expect(page.getByRole("button", { name: "▲ Receive" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start Camera" })).toBeVisible();
    await expect(manualBarcodeBox(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Lookup", exact: true })).toBeVisible();
    await expect(page.getByText("Physical scanner works anywhere on this page — no need to click first")).toBeVisible();

    expect(watch.problems()).toEqual([]);
  });

  test("the stat cards show how many items there are, how many are in stock and how many are at or below their threshold", async ({
    page,
  }) => {
    // Four extra items sit exactly on the edges of the rules: AT its threshold (low: "at or below"), one above it (not low),
    // empty with a threshold of 0 (out of stock, and 0 <= 0, so low) and 1 in stock with a threshold of 0 (in stock, not low).
    const base = expectedScanStats(inventoryFixture());
    const { mock, watch } = await boot(
      page,
      {},
      inventoryWith([
        { name: "At its threshold", barcode: "EDGE-AT", stock: 10, threshold: 10 },
        { name: "One above its threshold", barcode: "EDGE-ABOVE", stock: 11, threshold: 10 },
        { name: "Empty, threshold zero", barcode: "EDGE-ZERO", stock: 0, threshold: 0 },
        { name: "One left, threshold zero", barcode: "EDGE-ONE", stock: 1, threshold: 0 },
      ])
    );
    const stats = expectedScanStats(mock.medications);

    // The numbers are derived from the inventory the API returned; make sure the fixture exercises all three.
    expect(base.low).toBeGreaterThan(0);
    expect(base.inStock).toBeLessThan(base.total);

    await expect(statValue(page, "Total Items")).toHaveText(String(stats.total));
    await expect(statValue(page, "In Stock")).toHaveText(String(stats.inStock));
    await expect(statValue(page, "Low Stock")).toHaveText(String(stats.low));
    // And the edges, spelled out: of the four extra items, 3 are in stock and 2 are low (AT the threshold counts).
    await expect(statValue(page, "Total Items")).toHaveText(String(base.total + 4));
    await expect(statValue(page, "In Stock")).toHaveText(String(base.inStock + 3));
    await expect(statValue(page, "Low Stock")).toHaveText(String(base.low + 2));
    expect(watch.problems()).toEqual([]);
  });

  test("looking up a known barcode shows the item's name, barcode, current stock and unit", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await lookupManually(page, ibuprofen.barcode);

    await expect(currentStock(page)).toHaveText("Current stock: 18 units");
    await expect(page.getByText(ITEM.ibuprofen, { exact: true })).toBeVisible();
    await expect(page.getByText(ibuprofen.barcode, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Dispense 1 units" })).toBeVisible();
    await expect(page.getByText("New barcode — saved for staff review.")).toHaveCount(0);

    // One lookup request for exactly this barcode, and looking up a KNOWN item must not create anything.
    expect(mock.requestsTo("GET", BARCODE_LOOKUP).map((r) => r.path)).toEqual([`/api/medications/barcode/${ibuprofen.barcode}`]);
    expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(0);
    expect(watch.problems()).toEqual([]);
  });

  test("pressing Enter inside the barcode box looks the item up, like the Lookup button", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const aspirin = itemByName(mock.medications, ITEM.aspirin);

    await manualBarcodeBox(page).fill(aspirin.barcode);
    await manualBarcodeBox(page).press("Enter");

    await expect(currentStock(page)).toHaveText("Current stock: 60 units");
    await expect(page.getByText(ITEM.aspirin, { exact: true })).toBeVisible();
    expect(mock.requestsTo("GET", BARCODE_LOOKUP)).toHaveLength(1);
    expect(watch.problems()).toEqual([]);
  });

  test("a barcode typed with spaces around it is looked up without them", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await manualBarcodeBox(page).fill(`  ${ibuprofen.barcode}  `);
    await page.getByRole("button", { name: "Lookup", exact: true }).click();

    await expect(currentStock(page)).toHaveText("Current stock: 18 units");
    // Untrimmed, the code would not match any item and a junk item would be saved for it.
    expect(mock.requestsTo("GET", BARCODE_LOOKUP).map((r) => r.path)).toEqual([`/api/medications/barcode/${ibuprofen.barcode}`]);
    expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(0);
    expect(watch.problems()).toEqual([]);
  });

  test("pressing Lookup (or Enter) with an empty or blank barcode box asks the server for nothing and creates nothing", async ({ page }) => {
    const fetches = await recordPageFetches(page, /\/api\/medications/);
    const { mock, watch } = await boot(page);

    await page.getByRole("button", { name: "Lookup", exact: true }).click();
    await manualBarcodeBox(page).fill("   ");
    await page.getByRole("button", { name: "Lookup", exact: true }).click();
    await manualBarcodeBox(page).press("Enter");

    // Checked inside the page, the instant each press was handled: a lookup of "" would already be on this list.
    const log = await fetches();
    expect(lookupsIn(log)).toEqual([]);
    expect(createsIn(log)).toEqual([]);
    await expect(page.getByText("Looking up barcode…")).toHaveCount(0);
    await expect(page.getByText("Could not save barcode")).toHaveCount(0);
    expect(mock.requestsTo("GET", BARCODE_LOOKUP)).toHaveLength(0);
    expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(0);
    expect(watch.problems()).toEqual([]);
  });

  test("barcodes with letters, slashes, spaces and symbols are sent safely and found", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const template = itemByName(mock.medications, ITEM.aspirin);
    const oddBarcode = "AB/12 #3?x%";
    mock.medications.push({ ...template, id: 9001, name: "Odd barcode item", barcode: oddBarcode, stock: 7, is_unnamed: false });

    await lookupManually(page, oddBarcode);

    await expect(currentStock(page)).toHaveText("Current stock: 7 units");
    await expect(page.getByText("Odd barcode item", { exact: true })).toBeVisible();
    // The code travels as ONE path segment: slash, space, hash, question mark and percent are all escaped.
    expect(mock.requestsTo("GET", BARCODE_LOOKUP).map((r) => r.path)).toEqual([
      "/api/medications/barcode/AB%2F12%20%233%3Fx%25",
    ]);
    expect(watch.problems()).toEqual([]);
  });

  test("an item whose name contains commas and quotes is shown exactly as saved", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const item = itemByName(mock.medications, ITEM.childrens);

    await lookupManually(page, item.barcode);

    await expect(page.getByText(ITEM.childrens, { exact: true })).toBeVisible();
    await expect(currentStock(page)).toHaveText("Current stock: 4 units");
    expect(watch.problems()).toEqual([]);
  });
});

test.describe("Scan tab: unknown barcodes and lookup failures", () => {
  test("an unknown barcode is saved as an unnamed item for staff review, with a clear message and a link to Admin", async ({
    page,
  }) => {
    const code = "9990001112223";
    // Looking up an unknown barcode answers 404 by design (that is how the page learns the code is new);
    // Chromium logs that answer as a failed load. Nothing else may be logged.
    const { mock, watch } = await boot(page, { failedLoads: [/\/api\/medications\/barcode\/9990001112223$/] });
    const before = mock.medications.length;

    await lookupManually(page, code);

    await expect(page.getByText("New barcode — saved for staff review.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Complete in Admin" })).toHaveAttribute("href", "/admin");
    await expect(currentStock(page)).toHaveText("Current stock: 0 units");
    // No name yet: the barcode stands in for it.
    await expect(page.getByText(code, { exact: true }).first()).toBeVisible();

    const posts = mock.requestsTo("POST", MEDICATIONS_LIST);
    expect(posts).toHaveLength(1);
    expect(asRecord(posts[0].body)).toEqual({ name: null, barcode: code, stock: 0, threshold: 10, unit: "units", is_unnamed: true });

    // What the database now holds: one more item, flagged for review, no category, nothing in stock.
    expect(mock.medications).toHaveLength(before + 1);
    const created = mock.medications.find((m) => m.barcode === code);
    expect(created).toMatchObject({ name: null, stock: 0, threshold: 10, unit: "units", is_unnamed: true, category_id: null });
    expect(watch.problems()).toEqual([]);
  });

  test("when an unknown barcode cannot be saved, the page says so and Try again returns to a clean lookup", async ({ page }) => {
    // Two failed loads are expected: the unknown code's lookup answers 404 by design, and the save is made to fail
    // on purpose (Chromium logs the 500 answer of POST /api/medications).
    const { mock, watch } = await boot(page, {
      failedLoads: [/\/api\/medications\/barcode\/7770001112223$/, /\/api\/medications$/],
    });
    mock.failNext({ method: "POST", path: MEDICATIONS_LIST, status: 500, body: { error: "Unexpected database error." } });

    await lookupManually(page, "7770001112223");

    await expect(page.getByText("Could not save barcode 7770001112223")).toBeVisible();
    await expect(page.getByText("New barcode — saved for staff review.")).toHaveCount(0);
    expect(mock.medications.some((m) => m.barcode === "7770001112223")).toBe(false);

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("Could not save barcode 7770001112223")).toHaveCount(0);
    await expect(manualBarcodeBox(page)).toHaveValue("");
    expect(watch.problems()).toEqual([]);
  });

  test("an unknown barcode that was saved by someone else a moment ago is shown as that existing item", async ({ page }) => {
    // Two failures are made on purpose: the first lookup answers 404 and the save answers 409 (barcode already exists).
    const { mock, watch } = await boot(page, { failedLoads: [BARCODE_LOOKUP, /\/api\/medications$/] });
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    mock.failNext({ method: "GET", path: BARCODE_LOOKUP, status: 404, body: { error: "Medication not found" } });
    mock.failNext({ method: "POST", path: MEDICATIONS_LIST, status: 409, body: { error: "Barcode already exists" } });

    await lookupManually(page, ibuprofen.barcode);

    await expect(currentStock(page)).toHaveText("Current stock: 18 units");
    await expect(page.getByText(ITEM.ibuprofen, { exact: true })).toBeVisible();
    // The item had a name, so it is not presented as "new".
    await expect(page.getByText("New barcode — saved for staff review.")).toHaveCount(0);
    expect(mock.requestsTo("GET", BARCODE_LOOKUP)).toHaveLength(2);
    expect(watch.problems()).toEqual([]);
  });

  for (const failure of [
    { name: "the server answers with an error", spec: { status: 500, body: { error: "Unexpected database error." } } },
    { name: "the server cannot be reached", spec: { networkError: true } },
  ] as const) {
    test(`when the lookup fails because ${failure.name}, the page shows "Failed to lookup barcode" and Try again recovers`, async ({
      page,
    }) => {
      // The failing request is made on purpose: Chromium logs a failed load for it.
      const { mock, watch } = await boot(page, { failedLoads: [BARCODE_LOOKUP] });
      mock.failNext({ method: "GET", path: BARCODE_LOOKUP, ...failure.spec });

      await lookupManually(page, "0123456789012");

      await expect(page.getByText("Failed to lookup barcode")).toBeVisible();
      await expect(currentStock(page)).toHaveCount(0);
      // A failed lookup must not invent an item.
      expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(0);

      await page.getByRole("button", { name: "Try again" }).click();
      await expect(page.getByText("Failed to lookup barcode")).toHaveCount(0);

      // And the next lookup works again.
      const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
      await lookupManually(page, ibuprofen.barcode);
      await expect(currentStock(page)).toHaveText("Current stock: 18 units");
      expect(watch.problems()).toEqual([]);
    });
  }
});

test.describe("Scan tab: Receive and Dispense", () => {
  test("Receive adds stock: the confirmation names the item and the new total, and the next lookup shows the new stock", async ({
    page,
  }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await chooseMode(page, "receive");
    await lookupManually(page, ibuprofen.barcode);
    await expect(currentStock(page)).toHaveText("Current stock: 18 units");

    await quantityBox(page).fill("10");
    await page.getByRole("button", { name: "Receive 10 units" }).click();

    await expect(page.getByText(`Added 10 units of ${ITEM.ibuprofen}. New stock: 28`)).toBeVisible();
    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([
      { medication_id: ibuprofen.id, type: "receive", quantity: 10 },
    ]);
    expect(ibuprofen.stock).toBe(28);

    await page.getByRole("button", { name: "Scan another" }).click();
    await expect(page.getByText("Added 10 units")).toHaveCount(0);
    await lookupManually(page, ibuprofen.barcode);
    await expect(currentStock(page)).toHaveText("Current stock: 28 units");
    expect(watch.problems()).toEqual([]);
  });

  test("Dispense removes stock: the confirmation names the item and the new total, and the note is sent with the request", async ({
    page,
  }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await lookupManually(page, ibuprofen.barcode);
    await quantityBox(page).fill("3");
    await noteBox(page).fill("Batch 42, patient visit");
    await page.getByRole("button", { name: "Dispense 3 units" }).click();

    await expect(page.getByText(`Dispensed 3 units of ${ITEM.ibuprofen}. New stock: 15`)).toBeVisible();
    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([
      { medication_id: ibuprofen.id, type: "dispense", quantity: 3, note: "Batch 42, patient visit" },
    ]);
    expect(ibuprofen.stock).toBe(15);

    await page.getByRole("button", { name: "Scan another" }).click();
    await lookupManually(page, ibuprofen.barcode);
    await expect(currentStock(page)).toHaveText("Current stock: 15 units");
    expect(watch.problems()).toEqual([]);
  });

  test("the stat cards follow stock operations: receiving above the threshold clears a low-stock item, dispensing everything makes an item out of stock", async ({
    page,
  }) => {
    const { mock, watch } = await boot(page);
    const before = expectedScanStats(mock.medications);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen); // stock 18, threshold 40
    const acetaminophen = itemByName(mock.medications, ITEM.acetaminophen); // stock 120, threshold 40

    // Receive 30: 18 -> 48, above the threshold of 40, so one item fewer is low.
    await chooseMode(page, "receive");
    await lookupManually(page, ibuprofen.barcode);
    await quantityBox(page).fill("30");
    await page.getByRole("button", { name: "Receive 30 units" }).click();
    await expect(page.getByText(`New stock: 48`)).toBeVisible();
    await expect(statValue(page, "Low Stock")).toHaveText(String(before.low - 1));
    await expect(statValue(page, "In Stock")).toHaveText(String(before.inStock));

    // Dispense all 120: the item is now out of stock (and below its threshold).
    await page.getByRole("button", { name: "Scan another" }).click();
    await chooseMode(page, "dispense");
    await lookupManually(page, acetaminophen.barcode);
    await quantityBox(page).fill("120");
    await page.getByRole("button", { name: "Dispense 120 units" }).click();
    await expect(page.getByText(`New stock: 0`)).toBeVisible();
    await expect(statValue(page, "In Stock")).toHaveText(String(before.inStock - 1));
    await expect(statValue(page, "Low Stock")).toHaveText(String(before.low));
    await expect(statValue(page, "Total Items")).toHaveText(String(before.total));
    expect(watch.problems()).toEqual([]);
  });

  for (const refusal of [
    { name: "more than the stock", item: ITEM.ibuprofen, stock: 18, quantity: "999" },
    { name: "from an item that is out of stock", item: ITEM.nitrofurantoin, stock: 0, quantity: "1" },
  ] as const) {
    test(`dispensing ${refusal.name} shows the server's error and leaves the stock unchanged`, async ({ page }) => {
      // The refusal is the server's: Chromium logs the 400 answer of POST /api/transactions.
      const { mock, watch } = await boot(page, { failedLoads: [TRANSACTIONS] });
      const item = itemByName(mock.medications, refusal.item);

      await lookupManually(page, item.barcode);
      await expect(currentStock(page)).toHaveText(`Current stock: ${refusal.stock} units`);
      await quantityBox(page).fill(refusal.quantity);
      await page.getByRole("button", { name: `Dispense ${refusal.quantity} units` }).click();

      await expect(page.getByText(`Insufficient stock. Current stock: ${refusal.stock}`)).toBeVisible();
      // Not presented as a success.
      await expect(page.getByText("Dispensed")).toHaveCount(0);
      expect(item.stock).toBe(refusal.stock);
      expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(1);

      await page.getByRole("button", { name: "Try again" }).click();
      await expect(page.getByText("Insufficient stock")).toHaveCount(0);
      expect(watch.problems()).toEqual([]);
    });
  }

  test("a network failure while recording shows an error, not a success, and records nothing", async ({ page }) => {
    const { mock, watch } = await boot(page, { failedLoads: [TRANSACTIONS] });
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    mock.failNext({ method: "POST", path: TRANSACTIONS, networkError: true });

    await lookupManually(page, ibuprofen.barcode);
    await page.getByRole("button", { name: "Dispense 1 units" }).click();

    await expect(page.getByText("Network error")).toBeVisible();
    await expect(page.getByText("Dispensed")).toHaveCount(0);
    expect(ibuprofen.stock).toBe(18);
    expect(watch.problems()).toEqual([]);
  });

  for (const op of [
    { mode: "dispense", verb: "Dispense", done: "Dispensed", newStock: 13 },
    { mode: "receive", verb: "Receive", done: "Added", newStock: 23 },
  ] as const) {
    test(`a double click on ${op.verb} records exactly one movement: the button is out of action while the request is on its way`, async ({
      page,
    }) => {
      const fetches = await recordPageFetches(page, /\/api\/transactions$/);
      const { mock, watch } = await boot(page);
      const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen); // 18 units
      if (op.mode === "receive") await chooseMode(page, "receive");
      await lookupManually(page, ibuprofen.barcode);
      await quantityBox(page).fill("5");

      // The answer is held back, so the request is certainly still on its way when the second click lands.
      const gate = await holdAnswers(page, "**/api/transactions");
      try {
        await page.getByRole("button", { name: `${op.verb} 5 units` }).dblclick();
        await expect(page.getByRole("button", { name: "Processing..." })).toBeDisabled();
        expect(await fetches()).toEqual(["POST /api/transactions"]); // two clicks, one request
      } finally {
        gate.release();
      }

      await expect(page.getByText(`${op.done} 5 units of ${ITEM.ibuprofen}. New stock: ${op.newStock}`)).toBeVisible();
      expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([
        { medication_id: ibuprofen.id, type: op.mode, quantity: 5 },
      ]);
      expect(ibuprofen.stock).toBe(op.newStock);
      expect(watch.problems()).toEqual([]);
    });
  }

  test("a whole Dispense can be done from the keyboard: type the barcode, Enter, tab to the quantity and note, tab to the button, press it", async ({
    page,
  }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await manualBarcodeBox(page).focus();
    await page.keyboard.type(ibuprofen.barcode);
    await page.keyboard.press("Enter");
    await expect(currentStock(page)).toHaveText("Current stock: 18 units");

    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Lookup", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(quantityBox(page)).toBeFocused();
    await page.keyboard.type("3"); // focusing the box selected its "1": typing replaces it
    await page.keyboard.press("Tab");
    await expect(noteBox(page)).toBeFocused();
    await page.keyboard.type("Batch 9");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Dispense 3 units" })).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page.getByText(`Dispensed 3 units of ${ITEM.ibuprofen}. New stock: 15`)).toBeVisible();
    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([
      { medication_id: ibuprofen.id, type: "dispense", quantity: 3, note: "Batch 9" },
    ]);
    expect(watch.problems()).toEqual([]);
  });

  test("Cancel closes the item card without recording anything", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await lookupManually(page, ibuprofen.barcode);
    await expect(currentStock(page)).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await expect(currentStock(page)).toHaveCount(0);
    await expect(manualBarcodeBox(page)).toHaveValue("");
    expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(0);
    expect(ibuprofen.stock).toBe(18);
    expect(watch.problems()).toEqual([]);
  });

  test("the quantity box accepts digits only, and an empty quantity records 1", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);

    await lookupManually(page, ibuprofen.barcode);
    await expect(quantityBox(page)).toHaveValue("1");
    await quantityBox(page).fill("1a2b");
    await expect(quantityBox(page)).toHaveValue("12");
    await page.getByRole("button", { name: "Dispense 12 units" }).click();
    await expect(page.getByText("New stock: 6")).toBeVisible();
    await page.getByRole("button", { name: "Scan another" }).click();

    await lookupManually(page, ibuprofen.barcode);
    await quantityBox(page).fill("");
    // An emptied quantity box means 1: the button, the request and the confirmation all say 1.
    await page.getByRole("button", { name: "Dispense 1 units" }).click();
    await expect(page.getByText("New stock: 5")).toBeVisible();

    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => asRecord(r.body).quantity)).toEqual([12, 1]);
    expect(ibuprofen.stock).toBe(5);
    expect(watch.problems()).toEqual([]);
  });

  test("an item with no name is shown and handled by its barcode", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const unnamed = mock.medications.find((m) => m.name === null);
    if (!unnamed) throw new Error("fixture has no unnamed item");

    await lookupManually(page, unnamed.barcode);
    await expect(page.getByText(unnamed.barcode, { exact: true }).first()).toBeVisible();
    await chooseMode(page, "receive");
    await quantityBox(page).fill("5");
    await page.getByRole("button", { name: "Receive 5 units" }).click();

    await expect(page.getByText(`Added 5 units of ${unnamed.barcode}. New stock: 5`)).toBeVisible();
    expect(unnamed.stock).toBe(5);
    expect(watch.problems()).toEqual([]);
  });
});

test.describe("Inventory tab: the low-stock alert still works", () => {
  test("the alert counts the items at or below their threshold, and 'Show only' limits the list to them", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const stats = expectedScanStats(mock.medications);
    const lowItem = ITEM.ibuprofen; // 18 <= 40
    const adequateItem = ITEM.acetaminophen; // 120 > 40

    await openInventoryTab(page);

    const alertText = stats.low === 1 ? "1 medication is at or below threshold." : `${stats.low} medications are at or below threshold.`;
    await expect(page.getByText(alertText)).toBeVisible();
    await expect(page.getByText(lowItem, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(adequateItem, { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: /^Show only/ }).click();
    await expect(page.getByText(adequateItem, { exact: true })).toHaveCount(0);
    await expect(page.getByText(lowItem, { exact: true }).first()).toBeVisible();

    // Back to everything with the "All" stock filter.
    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(page.getByText(adequateItem, { exact: true }).first()).toBeVisible();
    expect(watch.problems()).toEqual([]);
  });

  test("the unnamed-items alert points to Admin", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const unnamedCount = mock.medications.filter((m) => m.is_unnamed).length;
    expect(unnamedCount).toBeGreaterThan(0);

    await openInventoryTab(page);

    // The wording differs only in grammar for one item (an older build says "1 unnamed item need staff review.", the current app "... needs ..."):
    // the count and the sentence are the preserved behavior.
    await expect(page.getByText(new RegExp(`^${unnamedCount} unnamed items? needs? staff review\\.$`))).toBeVisible();
    await expect(page.getByRole("link", { name: "Review in Admin" })).toHaveAttribute("href", "/admin");
    expect(watch.problems()).toEqual([]);
  });
});


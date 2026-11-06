// The Scan tab's manual barcode box, and a handheld scanner used while that box still holds an earlier code.
//
// A handheld scanner types its digits like a keyboard and ends with Enter. When the manual box has keyboard focus and still shows
// the code that was looked up a moment ago, the scanner's digits were added to the END of that code, so the next lookup was for
// two barcodes glued together ("012345600014" + "MED-1003"): no item has that barcode, so the app saved it as a new unnamed item
// "for staff review", a junk record that then shows up in the inventory. The original app was protected only by accident (its
// scan lock stayed on while a result card was open, so such a lookup was silently ignored; the scan lock now covers the request
// only, so that a second scan shows the second item). The fix keeps the looked-up code visible in the box but selects it, so what
// is typed or scanned next replaces it, while editing it by hand still works.
//
// Expected results:
//   * against the current app (E2E_BASE_URL=http://127.0.0.1:3100): every test passes;
//   * against the ORIGINAL UI (http://127.0.0.1:3101): the "found" and "failed lookup" tests FAIL (the scan is ignored while the
//     card is open, or the glued code is looked up), but no item is created by the found-card case there either.
import { test, expect, type Page } from "@playwright/test";
import type { Medication } from "@/lib/db";
import { installMockApi, type MockApi } from "./helpers/mock-api";
import {
  BARCODE_LOOKUP,
  ITEM,
  MEDICATIONS_LIST,
  createsIn,
  currentStock,
  inventoryFixture,
  itemByName,
  lookupsIn,
  manualBarcodeBox,
  openHome,
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
  await expect(statValue(page, "Total Items")).toHaveText(String(mock.medications.length));
  return { mock, watch };
}

const lookupLine = (item: Medication): string => `GET /api/medications/barcode/${encodeURIComponent(item.barcode)}`;

test.describe("a scanner used while the manual box has focus and still shows the previous code", () => {
  test("after a found item: the new code replaces the old one, only the new code is looked up, and no junk item is saved", async ({ page }) => {
    const fetches = await recordPageFetches(page, /\/api\/medications/);
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen); // 18 units
    const aspirin = itemByName(mock.medications, ITEM.aspirin); // 60 units
    const before = mock.medications.length;
    const box = manualBarcodeBox(page);

    await box.fill(ibuprofen.barcode);
    await box.press("Enter"); // Enter inside the box, so keyboard focus stays in it
    await expect(currentStock(page)).toHaveText("Current stock: 18 units");
    await expect(box).toBeFocused();
    await expect(box, "the looked-up code stays visible in the box").toHaveValue(ibuprofen.barcode);

    // The scanner: its digits go to the focused box, then Enter.
    await page.keyboard.type(aspirin.barcode);
    await page.keyboard.press("Enter");

    await expect(currentStock(page)).toHaveText("Current stock: 60 units");
    await expect(page.getByText(ITEM.aspirin, { exact: true })).toBeVisible();
    await expect(box).toHaveValue(aspirin.barcode);
    const log = await fetches();
    expect(lookupsIn(log)).toEqual([lookupLine(ibuprofen), lookupLine(aspirin)]);
    expect(createsIn(log)).toEqual([]);
    expect(mock.requestsTo("POST", MEDICATIONS_LIST)).toHaveLength(0);
    expect(mock.medications).toHaveLength(before);
    await expect(statValue(page, "Total Items")).toHaveText(String(before));
    expect(watch.problems()).toEqual([]);
  });

  test("after a failed lookup, whose code also stays in the box: the next scan replaces it instead of being glued to it", async ({ page }) => {
    const fetches = await recordPageFetches(page, /\/api\/medications/);
    const { mock, watch } = await boot(page, { failedLoads: [BARCODE_LOOKUP] });
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    const aspirin = itemByName(mock.medications, ITEM.aspirin);
    const before = mock.medications.length;
    const box = manualBarcodeBox(page);

    mock.failNext({ method: "GET", path: BARCODE_LOOKUP, status: 500, body: { error: "Unexpected database error." } });
    await box.fill(ibuprofen.barcode);
    await box.press("Enter");
    await expect(page.getByText("Failed to lookup barcode")).toBeVisible();
    await expect(box).toHaveValue(ibuprofen.barcode);
    await expect(box).toBeFocused();

    await page.keyboard.type(aspirin.barcode);
    await page.keyboard.press("Enter");

    await expect(currentStock(page)).toHaveText("Current stock: 60 units");
    const log = await fetches();
    expect(lookupsIn(log)).toEqual([lookupLine(ibuprofen), lookupLine(aspirin)]);
    expect(createsIn(log)).toEqual([]);
    expect(mock.medications).toHaveLength(before);
    expect(watch.problems()).toEqual([]);
  });

  test("a code the staff member edits by hand is still edited, not replaced: clicking into the box and typing adds to it", async ({ page }) => {
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    const box = manualBarcodeBox(page);

    await box.fill(ibuprofen.barcode);
    await box.press("Enter");
    await expect(currentStock(page)).toHaveText("Current stock: 18 units");

    await box.click(); // a click puts the caret in the text (and ends the selection that a lookup leaves behind)
    await box.press("End");
    await page.keyboard.type("7");

    await expect(box).toHaveValue(`${ibuprofen.barcode}7`);
    expect(watch.problems()).toEqual([]);
  });

  test("pressing the Lookup button leaves the box as it was: a code typed there is looked up once and stays in the box", async ({ page }) => {
    const fetches = await recordPageFetches(page, /\/api\/medications/);
    const { mock, watch } = await boot(page);
    const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
    const box = manualBarcodeBox(page);

    await box.fill(ibuprofen.barcode);
    await page.getByRole("button", { name: "Lookup", exact: true }).click();

    await expect(currentStock(page)).toHaveText("Current stock: 18 units");
    await expect(box).toHaveValue(ibuprofen.barcode);
    expect(lookupsIn(await fetches())).toEqual([lookupLine(ibuprofen)]);
    expect(watch.problems()).toEqual([]);
  });
});

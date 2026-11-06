// Existing behavior that must have been PRESERVED (TASK.md section 8): the camera is optional. When the browser
// cannot give the page a camera (no device, permission refused, no camera API at all) the Scan tab says so in the
// camera panel and everything else, above all manual lookup, keeps working.
//
// What this file does NOT prove: that a real camera reads a real barcode. Headless Chromium has no camera, so the
// camera-decode path (getUserMedia + @zxing/browser) could not be tested here; only the "no camera" degradation can be.
//
// Same locators on the current app and on the original UI (see tests/e2e/helpers/existing-behavior.ts).
import { test, expect, type Locator, type Page } from "@playwright/test";
import { installMockApi, type MockApi } from "./helpers/mock-api";
import {
  ITEM,
  currentStock,
  inventoryFixture,
  itemByName,
  lookupManually,
  openHome,
  statValue,
  watchPage,
  type PageWatch,
} from "./helpers/existing-behavior";

/** The red message the camera panel shows under the "Start Camera" button. */
function cameraMessage(page: Page): Locator {
  return page.getByRole("button", { name: "Start Camera" }).locator("xpath=following-sibling::p");
}

async function boot(page: Page): Promise<{ mock: MockApi; watch: PageWatch }> {
  const watch = watchPage(page);
  const mock = await installMockApi(page, { medications: inventoryFixture() });
  await openHome(page, mock);
  await expect(statValue(page, "Total Items")).toHaveText(String(mock.medications.length));
  return { mock, watch };
}

/** After a camera failure the page must still be fully usable: look an item up and see its stock. */
async function expectManualLookupStillWorks(page: Page, mock: MockApi): Promise<void> {
  const ibuprofen = itemByName(mock.medications, ITEM.ibuprofen);
  await lookupManually(page, ibuprofen.barcode);
  await expect(currentStock(page)).toHaveText("Current stock: 18 units");
  await expect(page.getByText(ITEM.ibuprofen, { exact: true })).toBeVisible();
}

test.describe("Scan tab without a usable camera", () => {
  test("Start Camera on a computer with no camera (no permission granted) shows a message and the page stays usable", async ({
    page,
  }) => {
    // Headless Chromium has no camera device and this context grants no camera permission: getUserMedia is rejected.
    const { mock, watch } = await boot(page);

    await page.getByRole("button", { name: "Start Camera" }).click();

    // The browser's own wording differs between versions, so only "a message is shown" is asserted.
    await expect(cameraMessage(page)).toHaveText(/\S/);
    // The camera panel is not stuck: the button is still there to try again.
    await expect(page.getByRole("button", { name: "Start Camera" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop Camera" })).toHaveCount(0);

    await expectManualLookupStillWorks(page, mock);
    expect(watch.problems()).toEqual([]);
  });

  test("when the camera permission is refused, the message tells staff to use manual entry", async ({ page }) => {
    await page.addInitScript(() => {
      // What Chromium does when the person presses Block in the permission prompt.
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    });
    const { mock, watch } = await boot(page);

    await page.getByRole("button", { name: "Start Camera" }).click();

    await expect(cameraMessage(page)).toHaveText("Camera permission denied. Use manual entry below.");
    await expect(page.getByRole("button", { name: "Start Camera" })).toBeVisible();
    await expectManualLookupStillWorks(page, mock);
    expect(watch.problems()).toEqual([]);
  });

  test("a second press of Start Camera after a refusal does not stack messages or break the page", async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    });
    const { mock, watch } = await boot(page);

    await page.getByRole("button", { name: "Start Camera" }).click();
    await expect(cameraMessage(page)).toHaveText("Camera permission denied. Use manual entry below.");
    await page.getByRole("button", { name: "Start Camera" }).click();
    await expect(cameraMessage(page)).toHaveCount(1);
    await expect(cameraMessage(page)).toHaveText("Camera permission denied. Use manual entry below.");

    await expectManualLookupStillWorks(page, mock);
    expect(watch.problems()).toEqual([]);
  });

  test("a browser that offers no camera API at all (for example a page opened over plain http) shows a message instead of crashing", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    });
    const { mock, watch } = await boot(page);

    await page.getByRole("button", { name: "Start Camera" }).click();

    await expect(cameraMessage(page)).toHaveText(/\S/);
    await expect(page.getByRole("button", { name: "Start Camera" })).toBeVisible();
    await expectManualLookupStillWorks(page, mock);
    expect(watch.problems()).toEqual([]);
  });

  test("the camera panel is idle until Start Camera is pressed: nothing asks for the camera on page load", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __cameraRequests: number };
      w.__cameraRequests = 0;
      navigator.mediaDevices.getUserMedia = () => {
        w.__cameraRequests += 1;
        return Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
      };
    });
    const { watch } = await boot(page);

    expect(await page.evaluate(() => (window as unknown as { __cameraRequests: number }).__cameraRequests)).toBe(0);
    await page.getByRole("button", { name: "Start Camera" }).click();
    await expect(cameraMessage(page)).toHaveText(/\S/);
    expect(await page.evaluate(() => (window as unknown as { __cameraRequests: number }).__cameraRequests)).toBe(1);
    expect(watch.problems()).toEqual([]);
  });
});

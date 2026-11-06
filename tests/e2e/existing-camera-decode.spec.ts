// Existing behavior that must be PRESERVED: scanning with the camera.
//
// There is no camera hardware here, so this file uses Chromium's SYNTHETIC camera fed with a generated video of a
// valid EAN-13 barcode (tests/e2e/helpers/barcode-video.ts). The page itself is unmodified and unaware: it asks
// for the camera with getUserMedia, plays the stream in its <video> and decodes frames with @zxing/browser, exactly
// as with a real camera. What this does NOT prove: focus, lighting, motion blur, other barcode types or a real device.
//
// The same locators work on the current app and on an older build of it (see tests/e2e/helpers/existing-behavior.ts).
import { test, expect, type Page } from "@playwright/test";
import { installMockApi, type MockApi } from "./helpers/mock-api";
import { writeBarcodeVideo } from "./helpers/barcode-video";
import {
  BARCODE_LOOKUP,
  ITEM,
  TRANSACTIONS,
  currentStock,
  inventoryFixture,
  itemByName,
  openHome,
  statValue,
  watchPage,
  type PageWatch,
} from "./helpers/existing-behavior";

/** A valid EAN-13 (check digit 7). It is "printed" in the synthetic camera's video. */
const CAMERA_BARCODE = "5901234123457";
const videoFile = writeBarcodeVideo(CAMERA_BARCODE);

test.use({
  launchOptions: {
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${videoFile}`],
  },
  permissions: ["camera"],
});

/** Remembers every camera stream the page opens, so a test can see whether the camera was switched off again. */
async function trackCameraStreams(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __streams: MediaStream[]; __cameraStarts: number };
    w.__streams = [];
    w.__cameraStarts = 0;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      w.__cameraStarts += 1;
      const stream = await original(constraints);
      w.__streams.push(stream);
      return stream;
    };
  });
}

const trackStates = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks().map((t) => t.readyState)));

function addCameraItem(mock: MockApi): void {
  const template = itemByName(mock.medications, ITEM.aspirin);
  mock.medications.push({ ...template, id: 9100, name: "Camera test item", barcode: CAMERA_BARCODE, stock: 9, threshold: 3, is_unnamed: false });
}

test.describe("camera scanning with a synthetic camera showing a barcode", () => {
  test("Scan tab: Start Camera reads the barcode by itself, looks the item up, shows its stock and switches the camera off", async ({
    page,
  }) => {
    const watch: PageWatch = watchPage(page);
    await trackCameraStreams(page);
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    addCameraItem(mock);
    await openHome(page, mock);
    await expect(statValue(page, "Total Items")).toHaveText(String(mock.medications.length));

    await page.getByRole("button", { name: "Start Camera" }).click();

    // Decoding happens on its own (the camera is on only until the first successful read, a moment with a barcode in view);
    // the first frames can take a few seconds on a busy machine.
    await expect(currentStock(page)).toHaveText("Current stock: 9 units", { timeout: 30_000 });
    await expect(page.getByText("Camera test item", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __cameraStarts: number }).__cameraStarts)).toBe(1);
    expect(mock.requestsTo("GET", BARCODE_LOOKUP).map((r) => r.path)[0]).toBe(`/api/medications/barcode/${CAMERA_BARCODE}`);

    // A scan switches the camera off: every track has ended and the page offers Start Camera again.
    await expect.poll(() => trackStates(page), { message: "camera tracks end after a scan" }).toEqual(expect.arrayContaining(["ended"]));
    expect((await trackStates(page)).every((state) => state === "ended")).toBe(true);
    await expect(page.getByRole("button", { name: "Stop Camera" })).toHaveCount(0);

    // And the item can be handled as usual.
    await page.getByRole("button", { name: "Dispense 1 units" }).click();
    await expect(page.getByText("Dispensed 1 units of Camera test item. New stock: 8")).toBeVisible();
    expect(mock.requestsTo("POST", TRANSACTIONS)).toHaveLength(1);
    expect(watch.problems()).toEqual([]);
  });

  test("Kiosk: the camera starts by itself, reads the barcode, opens the item for confirmation and records the dispense, with a clean console", async ({
    page,
  }) => {
    // Nothing whitelisted: with a working camera the kiosk logs no error at all.
    const watch = watchPage(page);
    await trackCameraStreams(page);
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    addCameraItem(mock);
    await page.goto("/kiosk");
    await expect(page.getByText("Ready", { exact: true }).or(page.getByText("Camera test item", { exact: true }))).toBeVisible();

    // No keyboard involved: the card opens from what the camera saw.
    await expect(page.getByText("Camera test item", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Stock:\s*9\s*→\s*8/)).toBeVisible();
    await page.getByRole("button", { name: "DISPENSE 1" }).click();

    await expect(page.getByText("Dispensed 1", { exact: true })).toBeVisible();
    await expect(page.getByText("New stock:").locator("span")).toHaveText("8");
    expect(mock.requestsTo("POST", TRANSACTIONS).map((r) => r.body)).toEqual([{ medication_id: 9100, type: "dispense", quantity: 1 }]);
    expect(mock.medications.find((m) => m.id === 9100)?.stock).toBe(8);
    expect(watch.problems()).toEqual([]);
  });
});

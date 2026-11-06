// Existing behavior that must be PRESERVED: starting and stopping the camera, and the
// kiosk starting its camera by itself. Uses Chromium's SYNTHETIC camera (a test-pattern video with no barcode in it),
// so these tests are about the camera lifecycle, not about decoding (see existing-camera-decode.spec.ts for that).
// What this does NOT prove: that a real camera device works.
//
// The same locators work on the current app and on an older build of it (see tests/e2e/helpers/existing-behavior.ts).
import { test, expect } from "@playwright/test";
import { installMockApi } from "./helpers/mock-api";
import {
  cameraConstraints,
  cameraStartCount,
  cameraTrackStates,
  inventoryFixture,
  openHome,
  requestedFacingMode,
  statValue,
  trackCamera,
  watchPage,
} from "./helpers/existing-behavior";

test.use({
  launchOptions: {
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  permissions: ["camera"],
});

test.describe("Scan tab camera with a working (synthetic) camera", () => {
  test("Start Camera shows the live picture with a Stop Camera button, and Stop Camera switches the camera off", async ({ page }) => {
    const watch = watchPage(page);
    await trackCamera(page);
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    await openHome(page, mock);
    await expect(statValue(page, "Total Items")).toHaveText(String(mock.medications.length));

    await page.getByRole("button", { name: "Start Camera" }).click();

    await expect(page.getByRole("button", { name: "Stop Camera" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start Camera" })).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const video = document.querySelector("video");
          return video !== null && video.srcObject instanceof MediaStream && video.readyState >= 2 && !video.paused;
        })
      )
      .toBe(true);
    expect(await cameraTrackStates(page)).toEqual(["live"]);

    await page.getByRole("button", { name: "Stop Camera" }).click();

    await expect(page.getByRole("button", { name: "Start Camera" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop Camera" })).toHaveCount(0);
    // The camera itself is off (its light would go out), not just hidden.
    expect(await cameraTrackStates(page)).toEqual(["ended"]);
    expect(watch.problems()).toEqual([]);
  });

  test("the camera can be started again after it was stopped", async ({ page }) => {
    const watch = watchPage(page);
    await trackCamera(page);
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    await openHome(page, mock);

    await page.getByRole("button", { name: "Start Camera" }).click();
    await expect(page.getByRole("button", { name: "Stop Camera" })).toBeVisible();
    await page.getByRole("button", { name: "Stop Camera" }).click();
    await expect(page.getByRole("button", { name: "Start Camera" })).toBeVisible();
    await page.getByRole("button", { name: "Start Camera" }).click();

    await expect(page.getByRole("button", { name: "Stop Camera" })).toBeVisible();
    expect(await cameraStartCount(page)).toBe(2);
    expect(await cameraTrackStates(page)).toEqual(["ended", "live"]);
    expect(watch.problems()).toEqual([]);
  });

  test("Start Camera asks for the back camera, so a phone does not open its selfie camera", async ({ page }) => {
    const watch = watchPage(page);
    await trackCamera(page);
    const mock = await installMockApi(page, { medications: inventoryFixture() });
    await openHome(page, mock);
    expect(await cameraStartCount(page), "nothing asks for the camera before Start Camera is pressed").toBe(0);

    await page.getByRole("button", { name: "Start Camera" }).click();

    await expect(page.getByRole("button", { name: "Stop Camera" })).toBeVisible();
    const asked = await cameraConstraints(page);
    expect(asked).toHaveLength(1);
    expect(requestedFacingMode(asked[0])).toBe("environment");
    expect(watch.problems()).toEqual([]);
  });
});

test.describe("Kiosk with a working (synthetic) camera", () => {
  test("the camera starts by itself, shows live picture and the kiosk writes nothing to the console", async ({ page }) => {
    // Nothing whitelisted: with a camera the kiosk logs no error at all.
    const watch = watchPage(page);
    await trackCamera(page);
    await installMockApi(page, { medications: inventoryFixture() });
    await page.goto("/kiosk");
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();

    await expect
      .poll(() =>
        page.evaluate(() => {
          const video = document.querySelector("video");
          return video !== null && video.srcObject instanceof MediaStream && video.readyState >= 2 && !video.paused;
        })
      )
      .toBe(true);
    await expect(page.locator("body > nav")).toHaveCount(0); // the app's top bar (see existing-kiosk.spec.ts for why not `nav`)
    expect(watch.problems()).toEqual([]);
  });

  test("the kiosk asks for the back camera too, so a phone does not open its selfie camera", async ({ page }) => {
    const watch = watchPage(page);
    await trackCamera(page);
    await installMockApi(page, { medications: inventoryFixture() });
    await page.goto("/kiosk");
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();

    await expect.poll(() => cameraStartCount(page), { message: "the kiosk asked for its camera" }).toBeGreaterThan(0);
    const asked = await cameraConstraints(page);
    expect(requestedFacingMode(asked[0])).toBe("environment");
    expect(watch.problems()).toEqual([]);
  });
});

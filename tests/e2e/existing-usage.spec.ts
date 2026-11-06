// Existing behavior that must have been PRESERVED (TASK.md section 8): the Usage & Projections page (/usage)
// and the usage history / analytics it shows. Its own source file is unchanged; what could break is what
// surrounds it (top bar, global styles). It calls exactly one endpoint, GET /api/analytics?days=N, which is answered
// here with synthetic data in the real route's shape (app/api/analytics/route.ts).
//
// Same locators on the current app and on the original UI.
import { test, expect, type Page } from "@playwright/test";
import { installMockApi } from "./helpers/mock-api";
import { inventoryFixture, watchPage, type ExpectedNoise, type PageWatch } from "./helpers/existing-behavior";

type DayData = { date: string; dispensed: number; received: number };
type MedAnalytics = {
  id: number;
  name: string | null;
  barcode: string;
  unit: string;
  current_stock: number;
  threshold: number;
  category_id: string | null;
  is_unnamed: boolean;
  total_dispensed: number;
  total_received: number;
  daily_rate: number;
  days_until_threshold: number | null;
  days_until_empty: number | null;
  reorder_date: string | null;
  daily: DayData[];
};

const ANALYTICS = /\/api\/analytics(\?|$)/;

/** Synthetic rows in the order the real route returns them (most urgent first). */
function analyticsRows(days: number): MedAnalytics[] {
  const base = { category_id: null, daily: [] as DayData[], reorder_date: null };
  return [
    // 3 days until the threshold: "Urgent"
    { ...base, id: 1, name: "Ibuprofen 200 mg, tablets", barcode: "012345600014", unit: "units", current_stock: 18, threshold: 10, is_unnamed: false,
      total_dispensed: 140, total_received: 50, daily_rate: 4.67, days_until_threshold: 3, days_until_empty: 4 },
    // 12 days: "Soon"
    { ...base, id: 2, name: "Cetirizine 10 mg, tablets", barcode: "012345600035", unit: "units", current_stock: 75, threshold: 30, is_unnamed: false,
      total_dispensed: 110, total_received: 0, daily_rate: 3.67, days_until_threshold: 12, days_until_empty: 20 },
    // 40 days: no badge
    { ...base, id: 3, name: "Gauze pads 4\"x4\", sterile", barcode: "MED-1006", unit: "box", current_stock: 300, threshold: 100, is_unnamed: false,
      total_dispensed: 150, total_received: 600, daily_rate: 5, days_until_threshold: 40, days_until_empty: 60 },
    // never used: no projection, dashes in the table
    { ...base, id: 4, name: "Thermometer probe covers", barcode: "012345600098", unit: "units", current_stock: 200, threshold: 50, is_unnamed: false,
      total_dispensed: 0, total_received: 0, daily_rate: 0, days_until_threshold: null, days_until_empty: null },
    // no name yet: shown by barcode with an "unnamed" tag
    { ...base, id: 5, name: null, barcode: "0049000028911", unit: "units", current_stock: 0, threshold: 10, is_unnamed: true,
      total_dispensed: 0, total_received: 0, daily_rate: 0, days_until_threshold: null, days_until_empty: null },
  ].map((row) => ({ ...row, daily: Array.from({ length: days }, (_, i) => ({ date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`, dispensed: 0, received: 0 })) }));
}

/** One synthetic analytics row; every field can be overridden. */
function usageRow(fields: Partial<MedAnalytics> & Pick<MedAnalytics, "id" | "name">): MedAnalytics {
  return {
    barcode: `U-${fields.id}`,
    unit: "units",
    current_stock: 50,
    threshold: 10,
    category_id: null,
    is_unnamed: false,
    total_dispensed: 0,
    total_received: 0,
    daily_rate: 1,
    days_until_threshold: null,
    days_until_empty: null,
    reorder_date: null,
    daily: [],
    ...fields,
  };
}

type UsageSetup = { watch: PageWatch; asked: string[] };

/** Opens /usage with the API mock; analytics answers come from `answer` (default: the synthetic rows). */
async function openUsage(
  page: Page,
  options: {
    expected?: ExpectedNoise;
    answer?: (days: number) => { status: number; body: unknown } | "abort";
  } = {}
): Promise<UsageSetup> {
  const watch = watchPage(page, options.expected);
  await installMockApi(page, { medications: inventoryFixture() });
  const asked: string[] = [];
  const answer = options.answer ?? ((days: number) => ({ status: 200, body: { medications: analyticsRows(days), days, date_range: [] } }));
  // Registered after the shared mock, so it answers /api/analytics first.
  await page.route("**/api/analytics**", async (route) => {
    const url = new URL(route.request().url());
    asked.push(`${url.pathname}${url.search}`);
    const days = Number(url.searchParams.get("days") ?? 30);
    const result = answer(days);
    if (result === "abort") return route.abort("failed");
    return route.fulfill({ status: result.status, contentType: "application/json", body: JSON.stringify(result.body) });
  });
  await page.goto("/usage");
  await expect(page.getByRole("heading", { name: "Usage & Projections" })).toBeVisible();
  return { watch, asked };
}

test.describe("Usage page", () => {
  test("loads the 30-day view by default: heading, the five time windows and the top bar link", async ({ page }) => {
    const { watch, asked } = await openUsage(page);

    await expect(page.getByText("Usage rates, trends, and reorder estimates.")).toBeVisible();
    for (const label of ["7d", "14d", "30d", "90d", "180d"]) {
      await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    await expect(page.locator("body > nav").getByRole("link", { name: "Usage" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Medication Usage — Last 30 Days" })).toBeVisible();
    expect(asked).toEqual(["/api/analytics?days=30"]);
    expect(watch.problems()).toEqual([]);
  });

  test("the summary cards show the units dispensed, how many medications have usage, and the most urgent reorder", async ({ page }) => {
    const { watch } = await openUsage(page);
    const rows = analyticsRows(30);
    const totalDispensed = rows.reduce((sum, r) => sum + r.total_dispensed, 0);
    const active = rows.filter((r) => r.daily_rate > 0).length;

    await expect(page.getByText("Units dispensed (30d)")).toBeVisible();
    await expect(page.getByText("Units dispensed (30d)").locator("xpath=preceding-sibling::p[1]")).toHaveText(totalDispensed.toLocaleString());
    await expect(page.getByText("Active medications (have usage)").locator("xpath=preceding-sibling::p[1]")).toHaveText(String(active));
    // The first item with a projection is the most urgent one.
    await expect(page.getByText("Until reorder: Ibuprofen 200 mg, tablets")).toBeVisible();
    await expect(page.getByText("Until reorder: Ibuprofen 200 mg, tablets").locator("xpath=preceding-sibling::p[1]")).toHaveText("3d");
    expect(watch.problems()).toEqual([]);
  });

  test("the usage table has the columns Medication, Stock, Dispensed/Used and Received, in that order", async ({ page }) => {
    const { watch } = await openUsage(page);

    await expect(page.locator("thead th")).toHaveText(["Medication", "Stock", "Dispensed/Used", "Received"]);
    expect(watch.problems()).toEqual([]);
  });

  test("every number in the usage table sits in its own column (stock and unit, dispensed, received), with a dash where there is nothing", async ({ page }) => {
    const { watch } = await openUsage(page);
    // [name, stock + unit, dispensed, received]: the synthetic rows use different numbers in every column, so a value that
    // moved to another column (or to another row) shows up here.
    const expected: Array<[string, RegExp, string, string]> = [
      ["Ibuprofen 200 mg, tablets", /^18\s*units$/, "140", "50"],
      ["Cetirizine 10 mg, tablets", /^75\s*units$/, "110", "—"],
      ["Gauze pads", /^300\s*box$/, "150", "600"],
      ["Thermometer probe covers", /^200\s*units$/, "—", "—"],
      ["0049000028911", /^0\s*units$/, "—", "—"],
    ];
    await expect(page.locator("tbody tr")).toHaveCount(expected.length);

    for (const [index, [name, stock, dispensed, received]] of expected.entries()) {
      const cells = page.locator("tbody tr").nth(index).locator("td");
      await expect(cells, `row ${index + 1} (${name}) has four cells`).toHaveCount(4);
      await expect(cells.nth(0), `row ${index + 1}: medication cell`).toContainText(name);
      await expect(cells.nth(1), `row ${index + 1} (${name}): stock cell`).toHaveText(stock);
      await expect(cells.nth(2), `row ${index + 1} (${name}): dispensed cell`).toHaveText(dispensed);
      await expect(cells.nth(3), `row ${index + 1} (${name}): received cell`).toHaveText(received);
    }
    expect(watch.problems()).toEqual([]);
  });

  test("urgency badges and the unnamed tag sit on the right rows", async ({ page }) => {
    const { watch } = await openUsage(page);
    const row = (name: string) => page.locator("tbody tr").filter({ hasText: name });
    const badges = (name: string) => row(name).getByText(/^(Urgent|Soon)$/);

    await expect(badges("Ibuprofen 200 mg, tablets")).toHaveText(["Urgent"]); // 3 days until the threshold
    await expect(badges("Cetirizine 10 mg, tablets")).toHaveText(["Soon"]); // 12 days
    await expect(badges("Gauze pads")).toHaveCount(0); // 40 days
    await expect(badges("Thermometer probe covers")).toHaveCount(0); // never used: no projection
    // No name yet: the barcode stands in for it, marked "unnamed" (and only that row).
    await expect(row("0049000028911").getByText("unnamed", { exact: true })).toBeVisible();
    await expect(page.getByText("unnamed", { exact: true })).toHaveCount(1);
    expect(watch.problems()).toEqual([]);
  });

  test("the urgency boundaries: Urgent up to 7 days from the threshold, Soon from 8 to 14 days, no badge from 15 days or without a projection", async ({
    page,
  }) => {
    const rows: MedAnalytics[] = [
      usageRow({ id: 1, name: "Seven-day item", days_until_threshold: 7 }),
      usageRow({ id: 2, name: "Eight-day item", days_until_threshold: 8 }),
      usageRow({ id: 3, name: "Fourteen-day item", days_until_threshold: 14 }),
      usageRow({ id: 4, name: "Fifteen-day item", days_until_threshold: 15 }),
      usageRow({ id: 5, name: "Zero-day item", days_until_threshold: 0 }),
      usageRow({ id: 6, name: "No-projection item", days_until_threshold: null }),
    ];
    const { watch } = await openUsage(page, { answer: (days) => ({ status: 200, body: { medications: rows, days, date_range: [] } }) });
    const badges = (name: string) => page.locator("tbody tr").filter({ hasText: name }).getByText(/^(Urgent|Soon)$/);

    await expect(page.locator("tbody tr")).toHaveCount(rows.length);
    await expect(badges("Seven-day item")).toHaveText(["Urgent"]);
    await expect(badges("Eight-day item")).toHaveText(["Soon"]);
    await expect(badges("Fourteen-day item")).toHaveText(["Soon"]);
    await expect(badges("Fifteen-day item")).toHaveCount(0);
    await expect(badges("Zero-day item")).toHaveText(["Urgent"]);
    await expect(badges("No-projection item")).toHaveCount(0);
    expect(watch.problems()).toEqual([]);
  });

  test("choosing another window asks the server for that many days and relabels the page", async ({ page }) => {
    const { watch, asked } = await openUsage(page);

    await page.getByRole("button", { name: "90d", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Medication Usage — Last 90 Days" })).toBeVisible();
    await expect(page.getByText("Units dispensed (90d)")).toBeVisible();
    await page.getByRole("button", { name: "7d", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Medication Usage — Last 7 Days" })).toBeVisible();
    await expect(page.getByText("Units dispensed (7d)")).toBeVisible();
    expect(asked).toEqual(["/api/analytics?days=30", "/api/analytics?days=90", "/api/analytics?days=7"]);
    expect(watch.problems()).toEqual([]);
  });

  test("with no usage data the page says so instead of showing a blank table", async ({ page }) => {
    const { watch } = await openUsage(page, {
      answer: (days) => ({ status: 200, body: { medications: [], days, date_range: [] } }),
    });

    await expect(page.getByText("No medications in system yet.")).toBeVisible();
    await expect(page.getByText("No items with usage data yet")).toBeVisible();
    expect(watch.problems()).toEqual([]);
  });

  test("when the server answers with an error, its message is shown (not an empty table)", async ({ page }) => {
    // The failure is made on purpose: Chromium logs the 500 answer of GET /api/analytics.
    const { watch } = await openUsage(page, {
      expected: { failedLoads: [ANALYTICS] },
      answer: () => ({ status: 500, body: { error: "Failed to fetch analytics" } }),
    });

    await expect(page.getByText("Failed to fetch analytics")).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(0);
    expect(watch.problems()).toEqual([]);
  });

  test("when the server cannot be reached the page says 'Network error', and choosing a window again recovers", async ({ page }) => {
    // The failure is made on purpose: Chromium logs the aborted GET /api/analytics.
    let healthy = false;
    const { watch } = await openUsage(page, {
      expected: { failedLoads: [ANALYTICS] },
      answer: (days) => (healthy ? { status: 200, body: { medications: analyticsRows(days), days, date_range: [] } } : "abort"),
    });

    await expect(page.getByText("Network error")).toBeVisible();
    healthy = true;
    await page.getByRole("button", { name: "14d", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Medication Usage — Last 14 Days" })).toBeVisible();
    await expect(page.getByText("Network error")).toHaveCount(0);
    await expect(page.locator("tbody tr")).toHaveCount(5);
    expect(watch.problems()).toEqual([]);
  });
});

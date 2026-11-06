// Browser tests of the Inventory tab (/?tab=inventory): browsing by category, the filters and their results line, the
// distinct loading / error / empty states, the sticky order bar, phone width and keyboard use.
//
// Every /api/* call is answered by tests/e2e/helpers/mock-api.ts, so no database is involved. What the screen must show is
// computed in the test from the mock's own data by tests/e2e/helpers/inventory-oracle.ts, which does not import the app's
// view logic: a bug in lib/inventory-view.ts cannot hide behind the same bug in the check. Each test starts from fresh
// synthetic data (tests/helpers/fixtures.ts) and does not depend on any other test.
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Category, Medication } from "@/lib/db";
import { buildCategories, buildManyMedications, buildMedications, fakeUuid, type IdShape } from "../helpers/fixtures";
import {
  ABOVE_THRESHOLD_ITEM,
  AT_THRESHOLD_ITEM,
  BOXES_ITEM,
  BOXES_UNIT,
  DRAFT_KEY,
  MIXED_CASE_ITEM,
  MIXED_CASE_SUPPLIER,
  SLOW_MS,
  VIEW_KEY,
  applyView,
  browseMedications,
  categoryByName,
  chipOf,
  chooseCategory,
  chooseChip,
  expectNoHorizontalScroll,
  expectScreenMatches,
  focusedName,
  hasFocusIndicator,
  headingOf,
  inspectLongValues,
  manyCategories,
  openInventory,
  orderBarOf,
  readScreen,
  rowOf,
  rowsOf,
  searchBoxOf,
  seedByName,
  setGrouped,
  setSearch,
  setSort,
  setStock,
  smallTouchTargets,
  summaryOf,
  tabTo,
  targetSize,
  tickOf,
  watchRuntimeErrors,
  withoutUncategorized,
  gotoInventory,
} from "./helpers/inventory-browse-page";
import {
  ALL_ITEMS,
  bucketOf,
  expectedCounts,
  expectedStatus,
  expectedVisible,
  type OracleCategory,
  type OracleView,
} from "./helpers/inventory-oracle";
import type { MockApi } from "./helpers/mock-api";

test.describe.configure({ timeout: SLOW_MS * 2 });

const SHAPES: readonly IdShape[] = ["uuid", "bigint"];

// Seed items by name, so no test depends on how the fixtures are numbered.
const ACETAMINOPHEN = "Acetaminophen 500 mg"; // Pain & Fever, stock ok, supplier 00417-B
const IBUPROFEN = "Ibuprofen 200 mg"; // Pain & Fever, low, supplier 0092
const CETIRIZINE = "Cetirizine 10 mg"; // Allergy & Cold, ok
const AMOXICILLIN = "Amoxicillin 500 mg"; // Antibiotics, ok, supplier AMX-500
const AZITHROMYCIN = "Azithromycin 250 mg"; // Antibiotics, low, supplier 000250 (leading zeros)
const NITROFURANTOIN = "Nitrofurantoin 100 mg"; // Antibiotics, out of stock
const THERMOMETER_COVERS = "Thermometer probe covers"; // legacy item: no category, no supplier number

const ANTIBIOTICS = "Antibiotics";
const PAIN_AND_FEVER = "Pain & Fever";

const view = (patch: Partial<OracleView> = {}): OracleView => ({ ...ALL_ITEMS, ...patch });
const inCategory = (id: string): OracleCategory => ({ kind: "category", id });
const UNCATEGORIZED_FILTER: OracleCategory = { kind: "uncategorized" };
const UNKNOWN_FILTER: OracleCategory = { kind: "unknown" };

// A page that raises an uncaught error or a React error (a hydration mismatch, say) fails the test, whatever it was checking.
const runtimeProblems = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  runtimeProblems.set(page, watchRuntimeErrors(page));
});
test.afterEach(({ page }) => {
  expect(runtimeProblems.get(page) ?? [], "the page raised errors while the test ran").toEqual([]);
});

// ── small local helpers ──────────────────────────────────────────────────────────────────────────

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Holds back the requests whose path matches, until `release()`. `reached` resolves when the first one arrives. */
function holdRequests(page: Page, path: string | RegExp): { release: () => void; reached: Promise<void> } {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seen: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    seen = resolve;
  });
  void page.route(path, async (route) => {
    seen();
    await released;
    await route.fallback();
  });
  return { release, reached };
}

/** Lets the browser run one frame (React has had its chance to render whatever the last response changed). */
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

const idsOf = (medications: readonly Medication[], ...prefixes: string[]): number[] => prefixes.map((p) => seedByName(medications, p).id);

/** The sentence of the order bar: "3 items on the order sheet (2 hidden by current filters)". */
const barSentence = (page: Page): Locator => orderBarOf(page).locator("#order-bar-text");

function sheetSentence(count: number, hidden = 0, missing = 0): string {
  const parts: string[] = [];
  if (hidden > 0) parts.push(`${hidden} hidden by current filters`);
  if (missing > 0) parts.push(`${missing} no longer in the inventory`);
  return `${count} ${count === 1 ? "item" : "items"} on the order sheet${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

/** Number shown on a summary card of the tab ("Total", "Low Stock", "Adequate"). */
async function statValue(page: Page, label: string): Promise<string> {
  const card = page.getByTestId("inventory-tab").locator("p", { hasText: new RegExp(`^${escapeRegExp(label)}$`) });
  return ((await card.locator("xpath=preceding-sibling::p[1]").textContent()) ?? "").replace(/\s+/g, " ").trim();
}

const nonGetRequests = (api: MockApi) => api.requests.filter((r) => r.method !== "GET");

/** The standard data (10 categories) plus one Antibiotics item whose name, barcode and supplier order number are as long as the fields allow. */
function withLongItem(): { categories: Category[]; medications: Medication[]; long: Medication } {
  const { categories, medications } = manyCategories("uuid");
  const long: Medication = {
    ...medications[0],
    id: 950,
    name: "Supercalifragilisticexpialidocious".repeat(4).slice(0, 120),
    barcode: "9".repeat(100),
    supplier_order_number: "S".repeat(64),
    category_id: categoryByName(categories, "Antibiotics").id,
  };
  medications.push(long);
  return { categories, medications, long };
}

/**
 * The long item's name, barcode and supplier order number are drawn in full, inside their row. Not only "the page does not scroll
 * sideways": the lists clip what overflows them, so a value that may not wrap is cut off at the edge while the page stays as wide
 * as before. `mustWrap`: the value is wider than the row, so it has to run over several lines (true on a phone).
 */
async function expectLongValuesComplete(page: Page, long: Medication, where: string, mustWrap: boolean): Promise<void> {
  const values = await inspectLongValues(page, long.id);
  const wanted = { name: long.name ?? "", barcode: long.barcode, "supplier order number": long.supplier_order_number ?? "" };
  for (const [what, fit] of Object.entries(values)) {
    expect(fit, `${where}: the ${what} is on the screen`).not.toBeNull();
    expect(fit?.text, `${where}: the ${what} is shown in full`).toBe(wanted[what as keyof typeof wanted]);
    expect(fit?.fits, `${where}: the ${what} is cut off by its own box`).toBe(true);
    expect(fit?.inside, `${where}: the ${what} is drawn outside its row`).toBe(true);
    if (mustWrap) expect(fit?.lines ?? 0, `${where}: the ${what} wraps onto several lines`).toBeGreaterThanOrEqual(2);
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 1. Default grouped view
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("default grouped view", () => {
  for (const shape of SHAPES) {
    test(`groups the inventory by category, each heading with its item count, Uncategorized last (${shape} ids)`, async ({ page }) => {
      const api = await openInventory(page, { shape });
      await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "default view");

      const screen = await readScreen(page);
      // Literal anchors (counted by hand from tests/helpers/fixtures.ts), so the oracle itself is held to account.
      expect(screen.groups.map((g) => g.title)).toEqual(["Allergy & Cold", "Antibiotics", "First Aid", "IV & Fluids", "Pain & Fever", "PPE & Gloves", "Uncategorized"]);
      expect(screen.groups.map((g) => g.count)).toEqual([5, 3, 5, 3, 5, 3, 3]);
      expect(screen.groups.every((g) => g.expanded)).toBe(true);
      expect(screen.rows).toHaveLength(27);
      expect(screen.summary).toBe("Showing all 27 items.");
      expect(screen.footer).toBe("Showing all 27 items.");
      expect(screen.chips.find((c) => c.key === "all")?.pressed).toBe(true);
      await expect(page.getByTestId("group-toggle")).toBeChecked();
      await expect(chipOf(page, "unknown")).toHaveCount(0);
      await expect(page.getByTestId("group-heading-unknown")).toHaveCount(0);
      expect(screen.clearFilters).toBe(false);
      expect(screen.activeFilters).toEqual([]);
    });
  }

  test("the summary cards and alert agree with the data (nothing counted twice or dropped) and keep describing the whole inventory while a filter is on", async ({ page }) => {
    const api = await openInventory(page);
    const low = api.medications.filter((m) => m.stock <= m.threshold).length;
    const cards = async (): Promise<Record<string, string>> => ({
      Total: await statValue(page, "Total"),
      "Low Stock": await statValue(page, "Low Stock"),
      Adequate: await statValue(page, "Adequate"),
    });
    const whole = { Total: String(api.medications.length), "Low Stock": String(low), Adequate: String(api.medications.length - low) };
    expect(await cards()).toEqual(whole);
    await expect(page.getByTestId("inventory-tab")).toContainText(`${low} medications are at or below threshold.`);

    // The cards count the inventory, not the list: a search that matches nothing, the Low filter and a category leave them as they are.
    await setSearch(page, "zzzz");
    await expect(page.getByTestId("inventory-empty")).toBeVisible();
    expect(await cards(), "cards while a search matches nothing").toEqual(whole);
    await setSearch(page, "");
    await setStock(page, "low");
    await expectScreenMatches(page, api.medications, api.categories, view({ stock: "low" }), "Low filter");
    expect(await cards(), "cards while only low stock is listed").toEqual(whole);
    await chooseChip(page, UNCATEGORIZED_FILTER);
    await expectScreenMatches(page, api.medications, api.categories, view({ stock: "low", category: UNCATEGORIZED_FILTER }), "Low + Uncategorized");
    expect(await cards(), "cards while one category is listed").toEqual(whole);
  });

  for (const shape of SHAPES) {
    test(`every row shows its category, name, status pill with text, threshold, stock in its own unit and the barcode and supplier order number as two separate labelled values (${shape} ids)`, async ({
      page,
    }) => {
      const api = await openInventory(page, { shape });
      const screen = await readScreen(page);
      expect(screen.rows).toHaveLength(api.medications.length);
      for (const item of api.medications) {
        const row = screen.rows.find((r) => r.id === item.id);
        expect(row, `row for item ${item.id}`).toBeDefined();
        if (!row) continue;
        const bucket = bucketOf(item, api.categories);
        const categoryLabel = bucket.kind === "category" ? bucket.title : bucket.kind === "unknown" ? "Category unavailable" : "Uncategorized";
        const who = `item ${item.id} (${item.name ?? "unnamed"})`;
        expect(row.text, `${who}: category`).toContain(categoryLabel);
        expect(row.text, `${who}: name`).toContain(item.name?.trim() ?? "Unnamed item");
        expect(row.barcode, `${who}: barcode value`).toBe(item.barcode);
        // Exactly as stored: leading zeros, letters in the case they were typed, punctuation (0092, 00417-B, 000250, ab-12Cd ...); never the barcode.
        expect(row.supplier, `${who}: supplier order number`).toBe(item.supplier_order_number ?? "Not set");
        expect(row.text, `${who}: both identifiers are labelled`).toContain("Barcode");
        expect(row.text, `${who}: both identifiers are labelled`).toContain("Supplier order no.");
        expect(row.status, `${who}: status`).toBe(expectedStatus(item));
        expect(row.statusText, `${who}: status text`).toBe({ out: "Out", low: "Low", ok: "OK" }[expectedStatus(item)]);
        expect(row.text, `${who}: threshold`).toContain(`Threshold: ${item.threshold}`);
        expect(row.text, `${who}: stock and its own unit`).toContain(`${item.stock} ${item.unit}`);
        expect(row.text, `${who}: order sheet checkbox label`).toContain("Add to order sheet");
        // The flag is on exactly the rows of unnamed items, not on every row.
        expect(row.text.includes("Needs review"), `${who}: the Needs review flag is on this row exactly when the item is unnamed`).toBe(item.is_unnamed);
      }
      // Anchors from the fixture file: a supplier number with leading zeros is shown with its zeros, and is not the barcode.
      const azithromycin = screen.rows.find((r) => r.id === seedByName(api.medications, AZITHROMYCIN).id);
      expect(azithromycin?.supplier).toBe("000250");
      const ibuprofen = screen.rows.find((r) => r.id === seedByName(api.medications, IBUPROFEN).id);
      expect(ibuprofen?.supplier).toBe("0092");
      expect(ibuprofen?.barcode).not.toBe("0092");

      // The deliberate edge values of the standard data (tests/e2e/helpers/inventory-browse-page.ts), asserted by name so that a
      // display rule applied to EVERY row (upper-casing a code, writing "units", an off-by-one status) cannot hide.
      const rowOfItem = (prefix: string) => screen.rows.find((r) => r.id === seedByName(api.medications, prefix).id);
      expect(rowOfItem(MIXED_CASE_ITEM)?.supplier, "letters of a supplier order number keep the case they were typed in").toBe(MIXED_CASE_SUPPLIER);
      expect(rowOfItem(AT_THRESHOLD_ITEM)?.text, "stock equal to the threshold").toContain("20 units");
      expect(rowOfItem(AT_THRESHOLD_ITEM)?.text).toContain("Threshold: 20");
      expect([rowOfItem(AT_THRESHOLD_ITEM)?.status, rowOfItem(AT_THRESHOLD_ITEM)?.statusText], "stock 20, threshold 20 is Low").toEqual(["low", "Low"]);
      expect([rowOfItem(ABOVE_THRESHOLD_ITEM)?.status, rowOfItem(ABOVE_THRESHOLD_ITEM)?.statusText], "stock 26, threshold 25 is OK").toEqual(["ok", "OK"]);
      expect(rowOfItem(BOXES_ITEM)?.text, "an item counted in boxes says boxes").toContain(`24 ${BOXES_UNIT}`);
      expect(rowOfItem(BOXES_ITEM)?.text).not.toContain("24 units");
    });
  }

  test("the low-stock alert counts the items at or below their threshold, its button limits the list to them and back, and the unnamed-item alert links to Admin", async ({ page }) => {
    const api = await openInventory(page);
    const low = api.medications.filter((m) => m.stock <= m.threshold).length;
    const unnamed = api.medications.filter((m) => m.is_unnamed).length;
    const tab = page.getByTestId("inventory-tab");
    await expect(tab).toContainText(`${low} medications are at or below threshold.`);
    await expect(tab).toContainText(`${unnamed} unnamed item needs staff review.`);
    await expect(tab.getByRole("link", { name: "Review in Admin" })).toHaveAttribute("href", "/admin");

    const button = page.getByTestId("show-low-stock");
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expectScreenMatches(page, api.medications, api.categories, view({ stock: "low" }), "low-stock alert button");
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "low-stock alert button pressed again");
  });

  test("an item with a vendor web address keeps its Order from vendor link (safe, new tab); an unsafe address gives no link", async ({ page }) => {
    const medications = buildMedications();
    const safe = { ...medications[3], vendor_url: "https://shop.example.com/reorder?item=naproxen" };
    const unsafe = { ...medications[4], vendor_url: "javascript:alert(1)" };
    medications[3] = safe;
    medications[4] = unsafe;
    await openInventory(page, { medications });
    const link = rowOf(page, safe.id).getByRole("link", { name: /Order from vendor/ });
    await expect(link).toHaveAttribute("href", "https://shop.example.com/reorder?item=naproxen");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    await expect(link).toHaveAccessibleName(/Naproxen 220 mg/);
    await expect(rowOf(page, unsafe.id).getByRole("link", { name: /Order from vendor/ })).toHaveCount(0);
    await expect(rowOf(page, medications[0].id).getByRole("link", { name: /Order from vendor/ })).toHaveCount(0); // no address: no link
  });

  test("rows show a 48px picture when an item has one, and a neutral placeholder (never a broken image) when it has none or the picture fails to load", async ({
    page,
    baseURL,
  }) => {
    const photo =
      "data:image/svg+xml;utf8," +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#fde68a"/></svg>');
    const medications = buildMedications();
    medications[0] = { ...medications[0], photo_url: photo };
    medications[1] = { ...medications[1], photo_url: `${baseURL ?? "http://127.0.0.1:3100"}/e2e-missing-picture.png` };
    await openInventory(page, {
      medications,
      // The picture's address answers 404 at once, from the test, so the outcome never depends on the dev server's speed.
      beforeLoad: async () => {
        await page.route("**/e2e-missing-picture.png", (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "not found" }));
      },
    });

    const withPhoto = rowOf(page, medications[0].id).locator("img");
    await expect(withPhoto).toHaveCount(1);
    await expect.poll(() => withPhoto.evaluate((img) => (img instanceof HTMLImageElement ? img.naturalWidth : 0))).toBeGreaterThan(0);
    const frame = await withPhoto.locator("xpath=..").boundingBox(); // the thumbnail's square frame (its picture fills it inside a 1px border)
    expect([Math.round(frame?.width ?? 0), Math.round(frame?.height ?? 0)]).toEqual([48, 48]);

    // A picture that fails to load is replaced by the placeholder; no broken-image icon stays behind.
    // (Pictures below the fold load lazily, so bring the row into view first.)
    await rowOf(page, medications[1].id).scrollIntoViewIfNeeded();
    await expect(rowOf(page, medications[1].id).locator("img")).toHaveCount(0);
    await expect(rowOf(page, medications[2].id).locator("img")).toHaveCount(0); // no picture at all
    const broken = await page.evaluate(
      () => Array.from(document.images).filter((img) => img.complete && img.naturalWidth === 0).length
    );
    expect(broken).toBe(0);
  });

  test("items without a category stay visible in Uncategorized and can be ticked for the order sheet", async ({ page }) => {
    const api = await openInventory(page);
    const legacy = api.medications.filter((m) => m.category_id === null);
    expect(legacy.length).toBe(3);
    const screen = await readScreen(page);
    const group = screen.groups.find((g) => g.key === "uncategorized");
    expect(group?.title).toBe("Uncategorized");
    expect([...(group?.ids ?? [])].sort((a, b) => a - b)).toEqual(legacy.map((m) => m.id).sort((a, b) => a - b));
    for (const item of legacy) {
      await expect(rowOf(page, item.id)).toContainText("Uncategorized");
      await tickOf(page, item.id).check();
    }
    await expect(barSentence(page)).toHaveText(sheetSentence(3));
    // The barcode-only item is shown honestly, not as an empty line or the word null.
    const unnamed = legacy.find((m) => m.name === null);
    expect(unnamed).toBeDefined();
    if (unnamed) {
      await expect(rowOf(page, unnamed.id)).toContainText("Unnamed item");
      await expect(rowOf(page, unnamed.id)).toContainText(unnamed.barcode);
    }
    expect((await readScreen(page)).bodyText).not.toMatch(/\b(null|undefined|NaN)\b/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 1b. Boundaries, wording and order that the standard data cannot vary
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("boundaries, wording and order", () => {
  /** A hand-made item: only what the test is about differs from the shared seed. */
  const handMade = (patch: Partial<Medication> & Pick<Medication, "id" | "name">): Medication => ({
    ...buildMedications()[0],
    barcode: `0${String(70_000_000_000 + patch.id)}`,
    supplier_order_number: null,
    is_unnamed: false,
    category_id: buildCategories("uuid")[0].id, // Pain & Fever
    ...patch,
  });

  test("an item whose stock equals its threshold is Low everywhere (pill, Low filter, Low Stock card, alert); one unit above reads OK, one below reads Low", async ({
    page,
  }) => {
    const medications = [
      handMade({ id: 701, name: "At the threshold", stock: 20, threshold: 20 }),
      handMade({ id: 702, name: "One above the threshold", stock: 21, threshold: 20 }),
      handMade({ id: 703, name: "One below the threshold", stock: 19, threshold: 20 }),
    ];
    const api = await openInventory(page, { medications });
    const screen = await readScreen(page);
    const pill = (id: number): [string | null | undefined, string | undefined] => [
      screen.rows.find((r) => r.id === id)?.status,
      screen.rows.find((r) => r.id === id)?.statusText,
    ];
    expect(pill(701), "stock 20, threshold 20").toEqual(["low", "Low"]);
    expect(pill(702), "stock 21, threshold 20").toEqual(["ok", "OK"]);
    expect(pill(703), "stock 19, threshold 20").toEqual(["low", "Low"]);

    // The cards and the alert count the item at its threshold as low: two of the three.
    expect(await statValue(page, "Total")).toBe("3");
    expect(await statValue(page, "Low Stock")).toBe("2");
    expect(await statValue(page, "Adequate")).toBe("1");
    await expect(page.getByTestId("inventory-tab")).toContainText("2 medications are at or below threshold.");

    // The Low filter lists it, the Adequate filter does not.
    await setStock(page, "low");
    await expectScreenMatches(page, api.medications, api.categories, view({ stock: "low" }), "Low filter, stock equal to threshold");
    expect((await readScreen(page)).rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([701, 703]);
    await setStock(page, "ok");
    await expectScreenMatches(page, api.medications, api.categories, view({ stock: "ok" }), "Adequate filter, stock equal to threshold");
    expect((await readScreen(page)).rows.map((r) => r.id)).toEqual([702]);
  });

  test("an inventory of exactly one item says 'item', never '1 items': results line, footer, group heading, alert, Add all and Undo messages, and the no-match detail", async ({
    page,
  }) => {
    const only = seedByName(browseMedications("uuid"), IBUPROFEN); // Pain & Fever, stock 18 of 40: low
    const api = await openInventory(page, { medications: [only] });
    const pain = categoryByName(api.categories, PAIN_AND_FEVER);

    const plain = await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "one item");
    expect(plain.summary).toBe("Showing all 1 item.");
    expect(plain.footer).toBe("Showing all 1 item.");
    expect(plain.groups.map((g) => [g.title, g.count, g.countWord])).toEqual([["Pain & Fever", 1, "item"]]);
    await expect(page.getByTestId("inventory-tab")).toContainText("1 medication is at or below threshold.");

    await setSearch(page, "ibu");
    const filtered = await expectScreenMatches(page, api.medications, api.categories, view({ search: "ibu" }), "one item, filtered");
    expect(filtered.summary).toBe("Showing 1 of 1 item · Search “ibu”");
    expect(filtered.footer).toBe("Showing 1 of 1 item. 0 items are hidden by the filters above.");

    await setSearch(page, "zzzz");
    const none = await expectScreenMatches(page, api.medications, api.categories, view({ search: "zzzz" }), "one item, no match");
    expect(none.summary).toBe("Showing 0 of 1 item · Search “zzzz”");
    await expect(page.getByTestId("inventory-empty")).toContainText("Clear the filters to see all 1 item.");
    await setSearch(page, "");

    await expect(page.getByTestId(`group-add-all-${pain.id}`)).toHaveText("Add all 1");
    await page.getByTestId(`group-add-all-${pain.id}`).click();
    await expect(page.getByTestId("bulk-status")).toHaveText("Added 1 item from Pain & Fever to the order sheet.");
    await expect(barSentence(page)).toHaveText("1 item on the order sheet");
    await page.getByTestId("bulk-undo").click();
    await expect(page.getByTestId("bulk-status")).toHaveText("Undid adding 1 item.");
  });

  test("a filter that hides exactly one item says '1 item is hidden by the filters above'", async ({ page }) => {
    const medications = browseMedications("uuid").filter((m) => m.name?.startsWith("Ibuprofen") || m.name?.startsWith("Naproxen"));
    expect(medications).toHaveLength(2);
    const api = await openInventory(page, { medications });
    await setSearch(page, "ibu");
    const screen = await expectScreenMatches(page, api.medications, api.categories, view({ search: "ibu" }), "one of two shown");
    expect(screen.summary).toBe("Showing 1 of 2 items · Search “ibu”");
    expect(screen.footer).toBe("Showing 1 of 2 items. 1 item is hidden by the filters above.");
  });

  test("names with numbers are ordered by the number, not letter by letter: Vitamin B 1 mg, Vitamin B 2 mg, Vitamin B 10 mg (inside a group and in the flat list)", async ({
    page,
  }) => {
    const medications = browseMedications("uuid");
    // Three Pain & Fever items renamed so that only a number differs.
    ["Vitamin B 10 mg", "Vitamin B 2 mg", "Vitamin B 1 mg"].forEach((name, i) => {
      medications[i] = { ...medications[i], name };
    });
    const api = await openInventory(page, { medications });
    const pain = categoryByName(api.categories, PAIN_AND_FEVER);
    const vitaminsIn = (ids: readonly number[]): Array<string | null | undefined> =>
      ids.map((id) => api.medications.find((m) => m.id === id)?.name).filter((name) => name?.startsWith("Vitamin B"));

    const grouped = await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "numbers in names, grouped");
    expect(vitaminsIn(grouped.groups.find((g) => g.key === pain.id)?.ids ?? [])).toEqual(["Vitamin B 1 mg", "Vitamin B 2 mg", "Vitamin B 10 mg"]);

    await setGrouped(page, false);
    const flat = await expectScreenMatches(page, api.medications, api.categories, view({ grouped: false }), "numbers in names, flat");
    expect(vitaminsIn(flat.rows.map((r) => r.id))).toEqual(["Vitamin B 1 mg", "Vitamin B 2 mg", "Vitamin B 10 mg"]);
  });

  test("categories are ordered by the page itself, by number inside names (Shelf 1, Shelf 2, Shelf 10), whatever order the server lists them in", async ({ page }) => {
    const categories: Category[] = ["Shelf 10", "Shelf 2", "Shelf 1"].map((name, i) => ({ id: fakeUuid(80 + i), name, created_at: "2026-11-01T12:00:00+00:00" }));
    const template = browseMedications("uuid")[0];
    const medications: Medication[] = [
      ...categories.map((c, i) => ({ ...template, id: 800 + i, name: `Item on ${c.name}`, barcode: `00000000080${i}`, supplier_order_number: null, category_id: c.id })),
      { ...template, id: 810, name: "Loose item", barcode: "000000000810", supplier_order_number: null, category_id: null },
    ];
    // The server answers in an order that is neither alphabetical nor numeric: Shelf 2, Shelf 10, Shelf 1.
    const unsorted = [categories[1], categories[0], categories[2]];
    const api = await openInventory(page, {
      categories,
      medications,
      beforeLoad: async () => {
        await page.route("**/api/categories", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(unsorted) }));
      },
    });
    const screen = await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "categories listed out of order");
    expect(screen.chips.map((c) => c.label)).toEqual(["All", "Shelf 1", "Shelf 2", "Shelf 10", "Uncategorized"]);
    expect(screen.groups.map((g) => g.title)).toEqual(["Shelf 1", "Shelf 2", "Shelf 10", "Uncategorized"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Category chips
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("category chips", () => {
  for (const shape of SHAPES) {
    test(`every chip (All, each category, Uncategorized) shows exactly its items and a correct number (${shape} ids)`, async ({ page }) => {
      const api = await openInventory(page, { shape });
      const filters: OracleCategory[] = [
        ...api.categories.map((c) => inCategory(c.id)),
        UNCATEGORIZED_FILTER,
        { kind: "all" },
      ];
      for (const category of filters) {
        await chooseChip(page, category);
        const screen = await expectScreenMatches(page, api.medications, api.categories, view({ category }), "chip");
        // One choice at a time, and the choice is spoken (aria-pressed), not only coloured.
        expect(screen.chips.filter((c) => c.pressed)).toHaveLength(1);
        // A category view shows one heading (grouped) named like the chip.
        if (category.kind === "category") expect(screen.groups).toHaveLength(1);
      }
    });
  }

  test("choosing the chip that is already selected keeps it selected (a single choice, not a switch)", async ({ page }) => {
    const api = await openInventory(page);
    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    await chipOf(page, antibiotics.id).click();
    await chipOf(page, antibiotics.id).click();
    await expect(chipOf(page, antibiotics.id)).toHaveAttribute("aria-pressed", "true");
    await expectScreenMatches(page, api.medications, api.categories, view({ category: inCategory(antibiotics.id) }), "chip clicked twice");
  });

  test("chip numbers follow the search and the stock level, never the chosen category, and always add up to All", async ({ page }) => {
    const api = await openInventory(page);
    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    await chipOf(page, antibiotics.id).click();
    await setSearch(page, "tablets");
    await setStock(page, "low");
    const v = view({ search: "tablets", stock: "low", category: inCategory(antibiotics.id) });
    const screen = await expectScreenMatches(page, api.medications, api.categories, v, "counts");
    const counts = expectedCounts(api.medications, api.categories, v);
    expect(screen.chips.find((c) => c.key === "all")?.count).toBe(counts.all);
    // Selecting a different category must not change any chip number.
    const before = screen.chips.map((c) => `${c.key}:${c.count}`);
    await chipOf(page, categoryByName(api.categories, PAIN_AND_FEVER).id).click();
    await expect(summaryOf(page)).toContainText(`Category: ${PAIN_AND_FEVER}`);
    const after = (await readScreen(page)).chips.map((c) => `${c.key}:${c.count}`);
    expect(after).toEqual(before);
  });

  test("an item moves between the chip numbers when the stock filter changes, and no item is counted in two chips", async ({ page }) => {
    const api = await openInventory(page);
    for (const stock of ["low", "ok", "all"] as const) {
      await setStock(page, stock);
      const screen = await expectScreenMatches(page, api.medications, api.categories, view({ stock }), `stock ${stock}`);
      const sum = screen.chips.filter((c) => c.key !== "all").reduce((n, c) => n + c.count, 0);
      expect(sum).toBe(screen.chips.find((c) => c.key === "all")?.count);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 3. Flat view and sorting
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("flat view and sorting", () => {
  test("turning Group by category off shows one flat list without headings, each row still names its category; turning it on restores the headings", async ({
    page,
  }) => {
    const api = await openInventory(page);
    await setGrouped(page, false);
    const flat = await expectScreenMatches(page, api.medications, api.categories, view({ grouped: false }), "flat");
    expect(flat.groups).toEqual([]);
    expect(flat.flat).toBe(true);
    for (const row of flat.rows) {
      const item = api.medications.find((m) => m.id === row.id);
      const bucket = item ? bucketOf(item, api.categories) : { kind: "uncategorized" as const };
      expect(row.text).toContain(bucket.kind === "category" ? bucket.title : "Uncategorized");
    }
    await setGrouped(page, true);
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "grouped again");
  });

  for (const grouped of [false, true]) {
    test(`sorting by name, lowest stock and category orders the ${grouped ? "rows inside each group" : "flat list"} (checked against an independent sort)`, async ({
      page,
    }) => {
      const api = await openInventory(page);
      await setGrouped(page, grouped);
      for (const sort of ["stock-asc", "category", "name"] as const) {
        await setSort(page, sort);
        await expectScreenMatches(page, api.medications, api.categories, view({ sort, grouped }), `sort ${sort}`);
      }
    });
  }

  test("flat list order anchors: by name (unnamed item last), by lowest stock, by category (Uncategorized last)", async ({ page }) => {
    const api = await openInventory(page);
    await setGrouped(page, false);
    const names = async (): Promise<Array<string | null>> =>
      (await readScreen(page)).rows.map((r) => api.medications.find((m) => m.id === r.id)?.name ?? null);

    await setSort(page, "name");
    await expect(rowsOf(page).first()).toContainText("Acetaminophen 160 mg/5 mL");
    const byName = await names();
    expect(byName[1]).toBe("Acetaminophen 500 mg, tablets"); // 160 before 500 (the numeric order of names is held by its own test below)
    expect(byName.at(-2)).toBe("Thermometer probe covers");
    expect(byName.at(-1)).toBeNull(); // the barcode-only item goes last

    await setSort(page, "stock-asc");
    await expect(rowsOf(page).first()).toContainText("Instant cold pack");
    const byStock = await names();
    expect(byStock.slice(0, 3)).toEqual(["Instant cold pack", "Nitrofurantoin 100 mg, capsules", null]); // three items at 0
    expect(byStock[3]).toBe("Cough drops, honey-lemon"); // then stock 3

    await setSort(page, "category");
    const screen = await readScreen(page);
    const firstUncategorized = screen.rows.findIndex((r) => api.medications.find((m) => m.id === r.id)?.category_id === null);
    expect(firstUncategorized).toBe(24); // every categorized item comes before the first uncategorized one
    expect(screen.rows.slice(24).every((r) => api.medications.find((m) => m.id === r.id)?.category_id === null)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 4. Search + stock + category together
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("search, stock level and category together", () => {
  const SEARCHES = ["", "tablets", "amox", "0092", "gloves  nitrile", "zzzz"] as const;
  const STOCKS = ["all", "low", "ok"] as const;

  for (const shape of SHAPES) {
    test(`every combination of search x stock x category: the results line equals the rows shown and no item is lost or repeated (${shape} ids)`, async ({
      page,
    }) => {
      const api = await openInventory(page, { shape });
      const categoryFilters: OracleCategory[] = [{ kind: "all" }, UNCATEGORIZED_FILTER, ...api.categories.map((c) => inCategory(c.id))];
      let combos = 0;
      for (const search of SEARCHES) {
        await setSearch(page, search);
        for (const stock of STOCKS) {
          await setStock(page, stock);
          for (const category of categoryFilters) {
            await chooseChip(page, category);
            await expectScreenMatches(page, api.medications, api.categories, view({ search, stock, category }), "matrix");
            combos += 1;
          }
        }
      }
      expect(combos).toBe(SEARCHES.length * STOCKS.length * categoryFilters.length);
    });
  }

  test("the same holds in the flat list sorted by lowest stock and by category", async ({ page }) => {
    const api = await openInventory(page);
    await setGrouped(page, false);
    const categoryFilters: OracleCategory[] = [{ kind: "all" }, UNCATEGORIZED_FILTER, ...api.categories.map((c) => inCategory(c.id))];
    for (const sort of ["stock-asc", "category"] as const) {
      await setSort(page, sort);
      for (const search of ["", "tablets", "gloves  nitrile"]) {
        await setSearch(page, search);
        for (const stock of STOCKS) {
          await setStock(page, stock);
          for (const category of categoryFilters) {
            await chooseChip(page, category);
            await expectScreenMatches(page, api.medications, api.categories, view({ search, stock, category, sort, grouped: false }), "flat matrix");
          }
        }
      }
    }
  });

  test("the category views partition the inventory: for each search and stock level the chips' rows are disjoint and together are exactly All", async ({
    page,
  }) => {
    const api = await openInventory(page);
    const chipsToWalk: OracleCategory[] = [...api.categories.map((c) => inCategory(c.id)), UNCATEGORIZED_FILTER];
    for (const [search, stock] of [["", "all"], ["tablets", "all"], ["", "low"], ["a", "ok"]] as const) {
      await setSearch(page, search);
      await setStock(page, stock);
      await chooseChip(page, { kind: "all" });
      await expect(summaryOf(page)).toBeVisible();
      const everything = (await readScreen(page)).rows.map((r) => r.id).sort((a, b) => a - b);
      const seen: number[] = [];
      for (const category of chipsToWalk) {
        await chooseChip(page, category);
        await expectScreenMatches(page, api.medications, api.categories, view({ search, stock, category }), "partition");
        seen.push(...(await readScreen(page)).rows.map((r) => r.id));
      }
      expect(new Set(seen).size, `an item appears under two categories for "${search}"/${stock}`).toBe(seen.length);
      expect(seen.sort((a, b) => a - b), `the categories together are not All for "${search}"/${stock}`).toEqual(everything);
    }
  });

  test("search finds items by name, barcode or supplier order number, ignores case, needs every word", async ({ page }) => {
    const api = await openInventory(page);
    const ibuprofen = seedByName(api.medications, IBUPROFEN);
    const acetaminophen = seedByName(api.medications, ACETAMINOPHEN);

    await setSearch(page, "ibuprofen");
    await expectScreenMatches(page, api.medications, api.categories, view({ search: "ibuprofen" }), "name");
    expect((await readScreen(page)).rows.map((r) => r.id)).toEqual([ibuprofen.id]);

    await setSearch(page, "IBUPROFEN");
    expect((await readScreen(page)).rows.map((r) => r.id)).toEqual([ibuprofen.id]);

    await setSearch(page, ibuprofen.barcode);
    await expectScreenMatches(page, api.medications, api.categories, view({ search: ibuprofen.barcode }), "barcode");
    expect((await readScreen(page)).rows.map((r) => r.id)).toEqual([ibuprofen.id]);

    await setSearch(page, "00417-B");
    await expectScreenMatches(page, api.medications, api.categories, view({ search: "00417-B" }), "supplier order number");
    expect((await readScreen(page)).rows.map((r) => r.id)).toEqual([acetaminophen.id]);

    // Letters of a supplier order number are found whatever case is typed (the number itself is shown as stored: see the row test).
    const loratadine = seedByName(api.medications, MIXED_CASE_ITEM);
    for (const typed of ["AB-12CD", "ab-12cd", MIXED_CASE_SUPPLIER]) {
      await setSearch(page, typed);
      await expectScreenMatches(page, api.medications, api.categories, view({ search: typed }), `supplier order number typed as ${typed}`);
      expect((await readScreen(page)).rows.map((r) => r.id), `typed ${typed}`).toEqual([loratadine.id]);
    }

    await setSearch(page, "acetaminophen tablets");
    await expectScreenMatches(page, api.medications, api.categories, view({ search: "acetaminophen tablets" }), "two words");
    await setSearch(page, "acetaminophen capsules");
    await expectScreenMatches(page, api.medications, api.categories, view({ search: "acetaminophen capsules" }), "two words, no item has both");
    expect((await readScreen(page)).rows).toHaveLength(0);
  });

  test("search ignores accents: the unaccented word finds the accented item, whichever way the accent is typed", async ({ page }) => {
    const api = await openInventory(page);
    const creme = seedByName(api.medications, "Cr\u00e8me antiseptique 1 %, 30 g");
    for (const typed of ["creme", "CREME", "cr\u00e8me", "cre\u0300me"]) {
      await setSearch(page, typed);
      await expectScreenMatches(page, api.medications, api.categories, view({ search: typed }), `typed ${typed}`);
      expect((await readScreen(page)).rows.map((r) => r.id), `typed ${typed}`).toEqual([creme.id]);
    }
  });

  test("a search made only of blanks or invisible characters is no search, and invisible characters inside a word do not break a match", async ({
    page,
  }) => {
    const api = await openInventory(page);
    for (const blank of ["   ", "​​", " ​ ­ "]) {
      await setSearch(page, blank);
      const screen = await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, `blank search ${JSON.stringify(blank)}`);
      expect(screen.activeFilters).toEqual([]);
      expect(screen.clearFilters).toBe(false);
      expect(screen.empty).toBeNull();
    }
    const ibuprofen = seedByName(api.medications, IBUPROFEN);
    for (const pasted of ["ibu​profen", "ＩＢＵＰＲＯＦＥＮ"]) {
      await setSearch(page, pasted);
      await expect(summaryOf(page)).toContainText("Showing 1 of 27 items");
      expect((await readScreen(page)).rows.map((r) => r.id), `pasted ${JSON.stringify(pasted)}`).toEqual([ibuprofen.id]);
    }
  });

  test("Clear filters appears only while a filter is on and puts search, stock level and category back to everything", async ({ page }) => {
    const api = await openInventory(page);
    await expect(page.getByTestId("clear-filters")).toHaveCount(0);
    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    await chipOf(page, antibiotics.id).click();
    await setStock(page, "low");
    await setSearch(page, "azi");
    await expectScreenMatches(page, api.medications, api.categories, view({ search: "azi", stock: "low", category: inCategory(antibiotics.id) }), "three filters");
    await expect(page.getByTestId("clear-filters")).toBeVisible();

    await page.getByTestId("clear-filters").click();
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "after Clear filters");
    await expect(searchBoxOf(page)).toHaveValue("");
    await expect(page.getByTestId("stock-filter-all")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("clear-filters")).toHaveCount(0);
  });

  test("each filter that is on shows as a removable chip, and removing one takes off only that filter", async ({ page }) => {
    const api = await openInventory(page);
    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    await chipOf(page, antibiotics.id).click();
    await setStock(page, "low");
    await setSearch(page, "azi");
    const all = view({ search: "azi", stock: "low", category: inCategory(antibiotics.id) });
    const screen = await expectScreenMatches(page, api.medications, api.categories, all, "all three on");
    expect(screen.activeFilters).toEqual(["Category: Antibiotics", "Stock: Low", "Search: “azi”"]);

    await page.getByTestId("active-filter-remove-stock").click();
    await expectScreenMatches(page, api.medications, api.categories, { ...all, stock: "all" }, "stock removed");
    await expect(searchBoxOf(page)).toHaveValue("azi");

    await page.getByTestId("active-filter-remove-category").click();
    await expectScreenMatches(page, api.medications, api.categories, view({ search: "azi" }), "category removed");

    await page.getByTestId("active-filter-remove-search").click();
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "search removed");
    await expect(searchBoxOf(page)).toHaveValue("");
  });

  for (const shape of SHAPES) {
    test(`more items than a server page holds (1,050) are all listed: no page cap, correct counts, filters still exact (${shape} ids)`, async ({
      page,
    }) => {
      const medications = buildManyMedications(1050, shape);
      const api = await openInventory(page, { shape, medications });
      const screen = await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "1,050 items");
      expect(screen.rows).toHaveLength(1050);
      expect(screen.groups.reduce((n, g) => n + g.count, 0)).toBe(1050);
      expect(screen.summary).toBe("Showing all 1050 items.");
      expect(await statValue(page, "Total")).toBe("1050");
      await setStock(page, "low");
      await expectScreenMatches(page, api.medications, api.categories, view({ stock: "low" }), "1,050 items, low stock");
      await setSearch(page, "0999");
      await expectScreenMatches(page, api.medications, api.categories, view({ stock: "low", search: "0999" }), "1,050 items, low stock + search");
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 5. Category unavailable
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("items whose category could not be read", () => {
  for (const shape of SHAPES) {
    test(`when the categories are blocked, categorized items are listed under Category unavailable (counted, selectable) and true Uncategorized stays apart (${shape} ids)`, async ({
      page,
    }) => {
      const api = await openInventory(page, { shape, categoriesBlocked: true });
      // The page was handed an empty category list (HTTP 200 with []), exactly like the live row-level-security defect.
      const screen = await expectScreenMatches(page, api.medications, [], ALL_ITEMS, "blocked categories");
      const categorized = api.medications.filter((m) => m.category_id !== null).length;
      const legacy = api.medications.filter((m) => m.category_id === null).length;
      expect(screen.rows).toHaveLength(api.medications.length); // nothing hidden
      expect(screen.groups.map((g) => g.key)).toEqual(["unknown", "uncategorized"]);
      expect(screen.groups.map((g) => g.count)).toEqual([categorized, legacy]);
      expect(screen.chips.find((c) => c.key === "unknown")?.label).toBe("Category unavailable");
      expect(screen.chips.find((c) => c.key === "unknown")?.count).toBe(categorized);
      expect(screen.chips.find((c) => c.key === "uncategorized")?.count).toBe(legacy);

      await chooseChip(page, UNKNOWN_FILTER);
      const selected = await expectScreenMatches(page, api.medications, [], view({ category: UNKNOWN_FILTER }), "Category unavailable chosen");
      expect(selected.chips.find((c) => c.key === "unknown")?.pressed).toBe(true);
      expect(selected.rows).toHaveLength(categorized);
      for (const row of selected.rows) {
        expect(row.text).toContain("Category unavailable");
        expect(row.text).not.toContain("Uncategorized");
      }
      await expect(page.getByTestId("group-unknown")).toContainText("not in the category list"); // the group says why

      await chooseChip(page, UNCATEGORIZED_FILTER);
      const uncategorized = await expectScreenMatches(page, api.medications, [], view({ category: UNCATEGORIZED_FILTER }), "Uncategorized chosen");
      expect(uncategorized.rows).toHaveLength(legacy);
    });
  }

  test("with the categories blocked, search and stock level still combine exactly with the Category unavailable and Uncategorized views", async ({ page }) => {
    const api = await openInventory(page, { categoriesBlocked: true });
    const filters: OracleCategory[] = [{ kind: "all" }, UNKNOWN_FILTER, UNCATEGORIZED_FILTER];
    for (const search of ["", "tablets", "gloves  nitrile", "zzzz"]) {
      await setSearch(page, search);
      for (const stock of ["all", "low", "ok"] as const) {
        await setStock(page, stock);
        const unavailable = expectedCounts(api.medications, [], view({ search, stock })).unknown;
        for (const category of filters) {
          // With nothing unavailable under this search and stock level there is no such chip to choose (it only stays while selected).
          if (category.kind === "unknown" && unavailable === 0) continue;
          await chooseChip(page, category);
          await expectScreenMatches(page, api.medications, [], view({ search, stock, category }), "blocked matrix");
        }
      }
    }
  });

  test("an item that points to a category missing from a loaded category list is Category unavailable, not Uncategorized", async ({ page }) => {
    const medications = buildMedications();
    medications[0] = { ...medications[0], category_id: "00000000-0000-4000-8000-0000000000aa" };
    medications[1] = { ...medications[1], category_id: "00000000-0000-4000-8000-0000000000bb" };
    const api = await openInventory(page, { medications });
    const screen = await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "orphan category ids");
    expect(screen.chips.find((c) => c.key === "unknown")?.count).toBe(2);
    expect(screen.groups.find((g) => g.key === "unknown")?.ids.sort()).toEqual([medications[0].id, medications[1].id].sort());
    expect(screen.chips.find((c) => c.key === "uncategorized")?.count).toBe(3); // unchanged
  });

  test("a selected Category unavailable chip stays on screen with (0) when the search leaves none, and comes back to its number when the search is cleared", async ({
    page,
  }) => {
    const api = await openInventory(page, { categoriesBlocked: true });
    await chooseChip(page, UNKNOWN_FILTER);
    await setSearch(page, "zzzz");
    const empty = await expectScreenMatches(page, api.medications, [], view({ category: UNKNOWN_FILTER, search: "zzzz" }), "unavailable + no match");
    expect(empty.chips.find((c) => c.key === "unknown")?.count).toBe(0);
    expect(empty.chips.find((c) => c.key === "unknown")?.pressed).toBe(true);
    expect(empty.clearFilters).toBe(true);
    await setSearch(page, "");
    const back = await expectScreenMatches(page, api.medications, [], view({ category: UNKNOWN_FILTER }), "search cleared");
    expect(back.chips.find((c) => c.key === "unknown")?.count).toBe(api.medications.filter((m) => m.category_id !== null).length);
  });

  test("when the category list fails to load (server error) the items are still listed, a warning with Retry appears, and Retry restores the names", async ({
    page,
  }) => {
    const api = await openInventory(page, {
      beforeLoad: (mock) => mock.failNext({ method: "GET", path: /^\/api\/categories$/, status: 500, body: { error: "Unexpected database error.", code: "XX000" } }),
    });
    const notice = page.getByTestId("categories-error");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Categories could not be loaded");
    await expect(notice).toContainText("Unexpected database error.");
    await expect(page.getByTestId("inventory-error")).toHaveCount(0); // the inventory itself loaded: this is not an inventory failure
    const degraded = await expectScreenMatches(page, api.medications, [], ALL_ITEMS, "categories failed");
    expect(degraded.rows).toHaveLength(api.medications.length); // every item still listed

    await notice.getByRole("button", { name: "Retry" }).click();
    await expect(notice).toHaveCount(0);
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "categories recovered");
    expect(api.requestsTo("GET", /^\/api\/categories$/)).toHaveLength(2);
    // The Retry button went away with the warning: focus is on the results line, not left at the start of the page.
    await expect.poll(() => focusedName(page), { message: "where keyboard focus is after the categories Retry" }).toBe("inventory-summary");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 6. Three distinct empty states
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("empty states", () => {
  test("an inventory with no items at all says so and offers to add one or scan one", async ({ page }) => {
    const api = await openInventory(page, { medications: [] });
    const empty = page.getByTestId("inventory-empty");
    await expect(empty).toHaveAttribute("data-empty-kind", "no-items");
    await expect(empty).toContainText("No items in the inventory yet.");
    await expect(empty.getByRole("link", { name: "Add an item" })).toHaveAttribute("href", "/admin");
    await expect(rowsOf(page)).toHaveCount(0);
    await expect(page.getByTestId("inventory-error")).toHaveCount(0);
    await expect(page.getByTestId("inventory-loading")).toHaveCount(0);
    const screen = await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "no items");
    expect(screen.groups).toEqual([]);

    await empty.getByRole("button", { name: "Scan a barcode" }).click();
    await expect(page.getByRole("heading", { name: "Scan medications" })).toBeAttached();
    await expect(page.getByTestId("inventory-tab")).toHaveCount(0);
  });

  test("a category that holds no items says so and offers Show all items", async ({ page }) => {
    const { categories, medications } = manyCategories("uuid");
    const api = await openInventory(page, { categories, medications });
    const emptyShelf = categoryByName(api.categories, "Empty shelf");
    await chipOf(page, emptyShelf.id).click();
    const screen = await expectScreenMatches(page, api.medications, api.categories, view({ category: inCategory(emptyShelf.id) }), "empty category");
    expect(screen.empty?.kind).toBe("category-empty");
    expect(screen.empty?.title).toBe("No items in Empty shelf yet.");
    await expect(page.getByTestId("inventory-empty")).toContainText("Assign items to this category from the Admin page.");
    await expect(page.getByTestId("inventory-empty-admin")).toHaveText("Assign items in Admin");
    await expect(page.getByTestId("inventory-empty-admin")).toHaveAttribute("href", "/admin");
    await page.getByTestId("inventory-empty-show-all").click();
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "after Show all items");
  });

  test("Uncategorized with nothing in it says every item has a category", async ({ page }) => {
    const { categories, medications } = withoutUncategorized("uuid");
    const api = await openInventory(page, { categories, medications });
    await chipOf(page, "uncategorized").click();
    const screen = await expectScreenMatches(page, api.medications, api.categories, view({ category: UNCATEGORIZED_FILTER }), "empty Uncategorized");
    expect(screen.empty?.kind).toBe("category-empty");
    expect(screen.empty?.title).toBe("No items in Uncategorized yet.");
    await expect(page.getByTestId("inventory-empty")).toContainText("Every item has a category.");
  });

  test("a search or filter that matches nothing names the filters, never shows empty quotes, and Clear filters brings everything back", async ({ page }) => {
    const api = await openInventory(page);
    await setSearch(page, "zzzz");
    const noMatch = await expectScreenMatches(page, api.medications, api.categories, view({ search: "zzzz" }), "no match");
    expect(noMatch.empty?.kind).toBe("no-match");
    expect(noMatch.empty?.title).toBe("No items match Search “zzzz”.");
    await expect(page.getByTestId("inventory-empty")).toContainText("Check the spelling");
    await expect(page.getByTestId("inventory-empty")).toContainText("Clear the filters to see all 27 items.");
    expect(noMatch.bodyText).not.toContain("“”");

    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    await chipOf(page, antibiotics.id).click();
    await setSearch(page, "gloves");
    const combined = await expectScreenMatches(
      page,
      api.medications,
      api.categories,
      view({ search: "gloves", category: inCategory(antibiotics.id) }),
      "category + search, no match"
    );
    expect(combined.empty?.title).toBe("No items match Category: Antibiotics · Search “gloves”.");

    await page.getByTestId("inventory-empty-clear").click();
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "after Clear filters");
  });

  test("the three empty states use different wording, different icons-of-intent (kind) and different actions", async ({ page }) => {
    const { categories, medications } = manyCategories("uuid");
    const api = await openInventory(page, { categories, medications });
    const capture = async () => {
      const empty = page.getByTestId("inventory-empty");
      await expect(empty).toBeVisible();
      return {
        kind: await empty.getAttribute("data-empty-kind"),
        title: ((await empty.locator("h3").textContent()) ?? "").trim(),
        text: ((await empty.textContent()) ?? "").replace(/\s+/g, " ").trim(),
        actions: (await empty.locator("a, button").allTextContents()).map((t) => t.trim()),
      };
    };
    await chipOf(page, categoryByName(api.categories, "Empty shelf").id).click();
    const categoryEmpty = await capture();
    await page.getByTestId("inventory-empty-show-all").click();
    await setSearch(page, "zzzz");
    const noMatch = await capture();
    await setSearch(page, "");
    api.medications.length = 0; // the mock "database" is emptied; a reload shows an inventory with no items at all
    await gotoInventory(page);
    const noItems = await capture();

    expect([noItems.kind, categoryEmpty.kind, noMatch.kind]).toEqual(["no-items", "category-empty", "no-match"]);
    expect(new Set([noItems.title, categoryEmpty.title, noMatch.title]).size).toBe(3);
    expect(new Set([noItems.text, categoryEmpty.text, noMatch.text]).size).toBe(3);
    expect(new Set([noItems.actions.join("|"), categoryEmpty.actions.join("|"), noMatch.actions.join("|")]).size).toBe(3);
    // Each one speaks only about its own situation.
    expect(noItems.text).not.toMatch(/match/i);
    expect(categoryEmpty.text).not.toMatch(/match|inventory yet/i);
    expect(noMatch.text).not.toMatch(/ yet\./);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 7. Loading failures are never an empty inventory
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("errors with Retry", () => {
  const MEDS = /^\/api\/medications$/;
  const CATS = /^\/api\/categories$/;

  /** What must hold whenever the inventory could not be loaded: an error with Retry, and nothing that reads as "empty". */
  async function expectErrorNotEmpty(page: Page): Promise<void> {
    const error = page.getByTestId("inventory-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute("role", "alert");
    await expect(error).toContainText("Couldn’t load the inventory");
    await expect(error).toContainText("This does not mean the inventory is empty.");
    await expect(error.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByTestId("inventory-empty")).toHaveCount(0);
    await expect(rowsOf(page)).toHaveCount(0);
    await expect(summaryOf(page)).toHaveCount(0);
    await expect(page.getByTestId("inventory-loading")).toHaveCount(0);
    const text = (await readScreen(page)).bodyText;
    expect(text).not.toMatch(/Showing all 0 items/);
    expect(text).not.toMatch(/No items in the inventory yet/);
    // The summary cards show a dash (not available), never a 0 that would read as "empty".
    await expect(page.getByTestId("inventory-tab")).not.toContainText(/0\s*Total/);
    expect(await statValue(page, "Total")).not.toBe("0");
  }

  test("a server error on the inventory request shows the server's message with Retry, not an empty inventory", async ({ page }) => {
    const api = await openInventory(page, {
      until: "error",
      beforeLoad: (mock) => mock.failNext({ method: "GET", path: MEDS, status: 500, body: { error: "Unexpected database error.", code: "XX000" } }),
    });
    await expectErrorNotEmpty(page);
    await expect(page.getByTestId("inventory-error")).toContainText("Unexpected database error.");
    expect(api.requestsTo("GET", MEDS)).toHaveLength(1);
  });

  test("Retry asks again and, when the server answers, replaces the error with the full list", async ({ page }) => {
    const api = await openInventory(page, {
      until: "error",
      beforeLoad: (mock) => mock.failNext({ method: "GET", path: MEDS, status: 503, body: { error: "Can’t reach the database. Check the connection, and that the Supabase project isn’t paused." } }),
    });
    await expectErrorNotEmpty(page);
    await expect(page.getByTestId("inventory-error")).toContainText("Can’t reach the database");
    await page.getByTestId("inventory-error").getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("inventory-error")).toHaveCount(0);
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "after Retry");
    expect(api.requestsTo("GET", MEDS)).toHaveLength(2);
  });

  test("Retry pressed with the keyboard on the error screen leaves keyboard focus on the results line, not at the start of the page", async ({ page }) => {
    const api = await openInventory(page, {
      until: "error",
      beforeLoad: (mock) => mock.failNext({ method: "GET", path: MEDS, status: 500, body: { error: "Unexpected database error." } }),
    });
    const retry = page.getByTestId("inventory-error").getByRole("button", { name: "Retry" });
    await retry.focus();
    await page.keyboard.press("Enter");
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "after Retry by keyboard");
    await expect.poll(() => focusedName(page), { message: "where keyboard focus is after Retry" }).toBe("inventory-summary");
  });

  test("a Retry that fails again keeps the error on screen (still not an empty inventory) and a later Retry recovers", async ({ page }) => {
    const api = await openInventory(page, {
      until: "error",
      beforeLoad: (mock) => mock.failNext({ method: "GET", path: MEDS, status: 500, times: 2, body: { error: "Unexpected database error." } }),
    });
    await page.getByTestId("inventory-error").getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => api.requestsTo("GET", MEDS).length).toBe(2);
    await expectErrorNotEmpty(page);
    await page.getByTestId("inventory-error").getByRole("button", { name: "Retry" }).click();
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "second Retry");
  });

  test("a dropped connection on the inventory request is also an error with Retry", async ({ page }) => {
    const api = await openInventory(page, {
      until: "error",
      beforeLoad: (mock) => mock.failNext({ method: "GET", path: MEDS, networkError: true }),
    });
    await expectErrorNotEmpty(page);
    await expect(page.getByTestId("inventory-error")).toContainText("Could not reach the server");
    await page.getByTestId("inventory-error").getByRole("button", { name: "Retry" }).click();
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "after Retry");
  });

  for (const [label, body] of [
    ["an object instead of a list", {}],
    ["an error object with HTTP 200", { error: "boom" }],
    ["a text page", "<!doctype html><title>Bad gateway</title>"],
    ["null", null],
  ] as const) {
    test(`an answer that is not a list (${label}) is an error, never an empty inventory`, async ({ page }) => {
      await openInventory(page, {
        until: "error",
        beforeLoad: (mock) => mock.failNext({ method: "GET", path: MEDS, status: 200, body }),
      });
      await expectErrorNotEmpty(page);
      await expect(page.getByTestId("inventory-error")).toContainText("unexpected answer");
    });
  }

  test("when only the category request fails, the inventory is not an error: items are listed, with a Retry for the categories (see also: items whose category could not be read)", async ({
    page,
  }) => {
    const api = await openInventory(page, {
      beforeLoad: (mock) => mock.failNext({ method: "GET", path: CATS, networkError: true }),
    });
    await expect(page.getByTestId("inventory-error")).toHaveCount(0);
    await expect(page.getByTestId("categories-error")).toBeVisible();
    await expect(page.getByTestId("categories-error")).toContainText("Could not reach the server");
    await expect(rowsOf(page)).toHaveCount(api.medications.length);
  });

  test("when both requests fail the page shows the inventory error; one Retry asks for both again and the list returns grouped by name", async ({ page }) => {
    const api = await openInventory(page, {
      until: "error",
      beforeLoad: (mock) => {
        mock.failNext({ method: "GET", path: MEDS, status: 500, body: { error: "Unexpected database error." } });
        mock.failNext({ method: "GET", path: CATS, status: 500, body: { error: "Unexpected database error." } });
      },
    });
    await expectErrorNotEmpty(page);
    await page.getByTestId("inventory-error").getByRole("button", { name: "Retry" }).click();
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "after Retry");
    await expect(page.getByTestId("categories-error")).toHaveCount(0);
    expect(api.requestsTo("GET", MEDS)).toHaveLength(2);
    expect(api.requestsTo("GET", CATS)).toHaveLength(2);
  });

  test("if a refresh fails after the list has loaded, the old list stays on screen with a warning; it is not replaced by an empty or error page", async ({ page }) => {
    const api = await openInventory(page, {
      beforeLoad: (mock) => mock.failNext({ method: "GET", path: CATS, status: 500, body: { error: "Unexpected database error." } }),
    });
    await expect(page.getByTestId("categories-error")).toBeVisible();
    // The Retry of the categories warning reloads both lists. Make the inventory request fail this time.
    api.failNext({ method: "GET", path: MEDS, status: 500, body: { error: "Unexpected database error." } });
    await page.getByTestId("categories-error").getByRole("button", { name: "Retry" }).click();
    const warning = page.getByTestId("inventory-refresh-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("could not be refreshed");
    await expect(warning).toContainText("last one that loaded");
    await expect(page.getByTestId("inventory-error")).toHaveCount(0);
    await expect(rowsOf(page)).toHaveCount(api.medications.length); // still all items
    await expect(page.getByTestId("inventory-empty")).toHaveCount(0);

    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(warning).toHaveCount(0);
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "refresh recovered");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 8. Loading state
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("loading state", () => {
  test("while the inventory loads there is a skeleton and nothing that reads as empty, error or a list; it then turns into the list", async ({ page }) => {
    const api = await openInventory(page, { latencyMs: 2500, until: "loading" });
    const loading = page.getByTestId("inventory-loading");
    await expect(loading).toHaveAttribute("role", "status");
    await expect(loading).toContainText("Loading inventory");
    await expect(rowsOf(page)).toHaveCount(0);
    await expect(page.getByTestId("inventory-empty")).toHaveCount(0);
    await expect(page.getByTestId("inventory-error")).toHaveCount(0);
    await expect(summaryOf(page)).toHaveCount(0);
    await expect(page.getByTestId("inventory-tab")).not.toContainText(/0\s*Total/);
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "after loading");
    await expect(loading).toHaveCount(0);
  });

  test("items that arrive before the categories do not flash as Category unavailable: the skeleton stays until both have answered", async ({ page }) => {
    let gate: ReturnType<typeof holdRequests> | undefined;
    let itemsAnswered: Promise<unknown> = Promise.resolve();
    const api = await openInventory(page, {
      until: "loading",
      beforeLoad: () => {
        gate = holdRequests(page, "**/api/categories");
        // Registered BEFORE the page loads: it resolves when the items have really reached the browser.
        itemsAnswered = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/medications");
      },
    });
    await gate?.reached;
    await itemsAnswered;
    await nextFrames(page);
    await expect(page.getByTestId("inventory-loading")).toBeVisible();
    await expect(rowsOf(page)).toHaveCount(0);
    expect((await readScreen(page)).bodyText).not.toContain("Category unavailable");
    gate?.release();
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "both answered");
  });

  test("categories that arrive before the items show no empty inventory while the items are pending", async ({ page }) => {
    let gate: ReturnType<typeof holdRequests> | undefined;
    let categoriesAnswered: Promise<unknown> = Promise.resolve();
    const api = await openInventory(page, {
      until: "loading",
      beforeLoad: () => {
        gate = holdRequests(page, "**/api/medications");
        categoriesAnswered = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/categories");
      },
    });
    await gate?.reached;
    await categoriesAnswered;
    await nextFrames(page);
    await expect(page.getByTestId("inventory-loading")).toBeVisible();
    await expect(page.getByTestId("inventory-empty")).toHaveCount(0);
    await expect(summaryOf(page)).toHaveCount(0);
    gate?.release();
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "both answered");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 9. Sticky order bar and ticks
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("order bar and ticks", () => {
  test("ticking Add to order sheet shows the bar with the count, survives a reload, and unticking removes it; nothing is written to the inventory", async ({
    page,
  }) => {
    const api = await openInventory(page);
    const ibuprofen = seedByName(api.medications, IBUPROFEN);
    await expect(orderBarOf(page)).toHaveCount(0);

    await tickOf(page, ibuprofen.id).check();
    await expect(barSentence(page)).toHaveText(sheetSentence(1));
    await expect(rowOf(page, ibuprofen.id)).toHaveAttribute("data-on-sheet", "true");
    await expect(page.getByRole("navigation").getByRole("link", { name: /Order sheet/ })).toHaveAccessibleName(/Order sheet.*1 item/);

    await page.reload();
    await expect(summaryOf(page)).toBeVisible();
    await expect(tickOf(page, ibuprofen.id)).toBeChecked();
    await expect(barSentence(page)).toHaveText(sheetSentence(1));

    await tickOf(page, ibuprofen.id).uncheck();
    await expect(orderBarOf(page)).toHaveCount(0);
    await expect(tickOf(page, ibuprofen.id)).not.toBeChecked();
    expect(nonGetRequests(api), "ticking must never change the inventory").toEqual([]);
  });

  test("the bar counts ticked items that the current filters hide, and says nothing about hidden items when none are hidden", async ({ page }) => {
    const api = await openInventory(page);
    const picks = idsOf(api.medications, ACETAMINOPHEN, CETIRIZINE, AMOXICILLIN); // Pain & Fever, Allergy & Cold, Antibiotics: all adequate stock
    for (const id of picks) await tickOf(page, id).check();
    await expect(barSentence(page)).toHaveText(sheetSentence(3));

    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    const cases: Array<{ label: string; v: OracleView; hidden: number }> = [
      { label: "Antibiotics chip", v: view({ category: inCategory(antibiotics.id) }), hidden: 2 },
      { label: "Low stock", v: view({ stock: "low" }), hidden: 3 },
      { label: "search amox", v: view({ search: "amox" }), hidden: 2 },
      { label: "Uncategorized chip", v: view({ category: UNCATEGORIZED_FILTER }), hidden: 3 },
      { label: "search that matches nothing", v: view({ search: "zzzz" }), hidden: 3 },
      { label: "Adequate stock", v: view({ stock: "ok" }), hidden: 0 },
    ];
    for (const { label, v, hidden } of cases) {
      await applyView(page, v);
      await expectScreenMatches(page, api.medications, api.categories, v, label);
      const visibleIds = new Set(expectedVisible(api.medications, api.categories, v).map((m) => m.id));
      const expectedHidden = picks.filter((id) => !visibleIds.has(id)).length;
      expect(expectedHidden, `${label}: the oracle agrees with the hand count`).toBe(hidden);
      await expect(barSentence(page), label).toHaveText(sheetSentence(3, expectedHidden));
    }
    await applyView(page, ALL_ITEMS);
    await expect(barSentence(page)).toHaveText(sheetSentence(3));
  });

  test("the order bar stays in view while the long list is scrolled (it is sticky), and does not cover the end of the list", async ({ page }) => {
    const api = await openInventory(page);
    await tickOf(page, seedByName(api.medications, IBUPROFEN).id).check();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(orderBarOf(page)).toBeInViewport({ ratio: 1 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await expect(orderBarOf(page)).toBeInViewport({ ratio: 1 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(orderBarOf(page)).toBeInViewport({ ratio: 1 });
    // At the very end the footer line is still readable above the bar.
    await expect(page.getByTestId("inventory-footer")).toBeInViewport({ ratio: 1 });
    const overlap = await page.evaluate(() => {
      const footer = document.querySelector('[data-testid="inventory-footer"]')?.getBoundingClientRect();
      const bar = document.querySelector('[data-testid="order-bar"]')?.getBoundingClientRect();
      return footer && bar ? Math.min(footer.bottom, bar.bottom) - Math.max(footer.top, bar.top) : Number.NaN;
    });
    expect(overlap).toBeLessThanOrEqual(1);
  });

  test("ticks are kept when filters change, and a ticked item that is hidden is still ticked when it comes back", async ({ page }) => {
    const api = await openInventory(page);
    const amoxicillin = seedByName(api.medications, AMOXICILLIN);
    await tickOf(page, amoxicillin.id).check();
    await setSearch(page, "ibuprofen");
    await expect(rowOf(page, amoxicillin.id)).toHaveCount(0);
    await expect(barSentence(page)).toHaveText(sheetSentence(1, 1));
    await setSearch(page, "");
    await expect(tickOf(page, amoxicillin.id)).toBeChecked();
    await expect(barSentence(page)).toHaveText(sheetSentence(1));
  });

  test("sheet items that are no longer in the inventory are counted separately from items hidden by filters", async ({ page }) => {
    const medications = buildMedications();
    const [ibuprofen, amoxicillin] = idsOf(medications, IBUPROFEN, AMOXICILLIN);
    const api = await openInventory(page, { medications, sheetIds: [ibuprofen, amoxicillin, 999_999] });
    await expect(barSentence(page)).toHaveText(sheetSentence(3, 0, 1));
    await setSearch(page, "ibuprofen");
    await expect(barSentence(page)).toHaveText(sheetSentence(3, 1, 1));
    expect(nonGetRequests(api)).toEqual([]);
  });

  test("Review order sheet opens the order sheet with exactly the ticked items", async ({ page }) => {
    const api = await openInventory(page);
    const picks = idsOf(api.medications, IBUPROFEN, AMOXICILLIN, THERMOMETER_COVERS);
    for (const id of picks) await tickOf(page, id).check();
    await orderBarOf(page).getByRole("link", { name: "Review order sheet" }).click();
    await expect(page).toHaveURL(/\/order-sheet$/);
    for (const id of picks) await expect(page.getByTestId(`sheet-row-${id}`)).toBeVisible();
    await expect(page.locator('[data-testid^="sheet-row-"]')).toHaveCount(picks.length);
    expect(nonGetRequests(api), "opening the order sheet must not change the inventory").toEqual([]);
  });

  test("Clear needs a second step: Keep items keeps the sheet, Yes clears it and unticks every box", async ({ page }) => {
    const api = await openInventory(page);
    const picks = idsOf(api.medications, IBUPROFEN, AMOXICILLIN);
    for (const id of picks) await tickOf(page, id).check();

    await page.getByTestId("order-bar-clear").click();
    await expect(orderBarOf(page)).toContainText("Remove all 2 items from the order sheet?");
    await page.getByTestId("order-bar-clear-cancel").click();
    await expect(barSentence(page)).toHaveText(sheetSentence(2));
    for (const id of picks) await expect(tickOf(page, id)).toBeChecked();

    await page.getByTestId("order-bar-clear").click();
    await page.getByTestId("order-bar-clear-confirm").click();
    await expect(orderBarOf(page)).toHaveCount(0);
    for (const id of picks) await expect(tickOf(page, id)).not.toBeChecked();
    expect((await readScreen(page)).rows.every((r) => !r.onSheet && !r.ticked)).toBe(true);
    expect(nonGetRequests(api)).toEqual([]);
  });

  test("a group heading says how many of its items are on the order sheet, and drops the badge when none is", async ({ page }) => {
    const api = await openInventory(page);
    const pain = categoryByName(api.categories, PAIN_AND_FEVER);
    const badge = page.getByTestId(`group-on-sheet-${pain.id}`);
    const [acetaminophen, ibuprofen] = idsOf(api.medications, ACETAMINOPHEN, IBUPROFEN);
    await expect(badge).toHaveCount(0);
    await tickOf(page, acetaminophen).check();
    await expect(badge).toHaveText("1 on order sheet");
    await tickOf(page, ibuprofen).check();
    await expect(badge).toHaveText("2 on order sheet");
    await expect(page.getByTestId(`group-on-sheet-${categoryByName(api.categories, ANTIBIOTICS).id}`), "another group is not affected").toHaveCount(0);
    await tickOf(page, acetaminophen).uncheck();
    await expect(badge).toHaveText("1 on order sheet");
    await tickOf(page, ibuprofen).uncheck();
    await expect(badge).toHaveCount(0);
  });

  test("the Clear question opens with focus on the safe choice (Keep items); Escape closes it, returns focus to Clear and keeps the sheet", async ({ page }) => {
    const api = await openInventory(page);
    const picks = idsOf(api.medications, IBUPROFEN, AMOXICILLIN);
    for (const id of picks) await tickOf(page, id).check();
    await page.getByTestId("order-bar-clear").click();
    await expect(page.getByTestId("order-bar-clear-cancel")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("order-bar-clear-cancel")).toHaveCount(0);
    await expect(page.getByTestId("order-bar-clear")).toBeFocused();
    await expect(barSentence(page)).toHaveText(sheetSentence(2));
    for (const id of picks) await expect(tickOf(page, id)).toBeChecked();
  });

  test("the Added message is a polite live region; Dismiss removes it and puts focus on Review order sheet; Undo by keyboard leaves focus on Dismiss", async ({ page }) => {
    const api = await openInventory(page);
    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    const allergy = categoryByName(api.categories, "Allergy & Cold");

    await page.getByTestId(`group-add-all-${antibiotics.id}`).click();
    const status = page.getByTestId("bulk-status");
    await expect(status).toHaveText("Added 3 items from Antibiotics to the order sheet.");
    await expect(status, "a screen reader announces the message").toHaveAttribute("role", "status");
    await expect(status).toHaveAttribute("aria-live", "polite");
    await page.getByTestId("bulk-dismiss").click();
    await expect(page.getByTestId("bulk-status"), "Dismiss removes the message").toHaveCount(0);
    await expect(barSentence(page), "Dismiss keeps the sheet").toHaveText(sheetSentence(3));
    await expect(page.getByTestId("order-bar-review"), "the bar stays, so focus goes to its first control").toBeFocused();

    // Undo from the keyboard: the Undo button goes away, so focus must land on a button that stays (Dismiss), not on the page start.
    await page.getByTestId(`group-add-all-${allergy.id}`).click();
    await expect(page.getByTestId("bulk-status")).toHaveText("Added 5 items from Allergy & Cold to the order sheet.");
    await page.getByTestId("bulk-undo").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("bulk-status")).toHaveText("Undid adding 5 items.");
    await expect(page.getByTestId("bulk-dismiss")).toBeFocused();
    await expect(barSentence(page)).toHaveText(sheetSentence(3));
  });

  test("a key held down presses a group heading once: the repeats of Enter do not fold it open and shut again", async ({ page }) => {
    const api = await openInventory(page);
    const button = headingOf(page, categoryByName(api.categories, ANTIBIOTICS).id).getByRole("button");
    await button.focus();
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter"); // the same key again with no key-up in between: the browser's auto-repeat
    await page.keyboard.up("Enter");
    await expect(button).toHaveAttribute("aria-expanded", "false"); // folded once, not folded and unfolded again
  });

  test("browsing (chips, search, stock, sort, grouping, ticks, bulk add) only reads: not one write request is sent", async ({ page }) => {
    const api = await openInventory(page);
    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    await chipOf(page, antibiotics.id).click();
    await setSearch(page, "a");
    await setStock(page, "low");
    await setSort(page, "stock-asc");
    await setGrouped(page, false);
    await setGrouped(page, true);
    await page.getByTestId(`group-add-all-${antibiotics.id}`).click();
    await page.getByTestId("bulk-undo").click();
    await tickOf(page, seedByName(api.medications, AZITHROMYCIN).id).check();
    await page.reload();
    await expect(summaryOf(page)).toBeVisible();
    expect(api.requests.length).toBeGreaterThan(0);
    expect(nonGetRequests(api), `write requests: ${JSON.stringify(nonGetRequests(api))}`).toEqual([]);
  });

  for (const shape of SHAPES) {
  test(`Add all in a category adds only the items of that category that are not on the sheet yet; Undo takes off only those (${shape} ids)`, async ({ page }) => {
    const api = await openInventory(page, { shape });
    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    const [amoxicillin, azithromycin, nitrofurantoin] = idsOf(api.medications, AMOXICILLIN, AZITHROMYCIN, NITROFURANTOIN);
    await tickOf(page, azithromycin).check(); // already on the sheet by hand
    const addAll = page.getByTestId(`group-add-all-${antibiotics.id}`);
    await expect(addAll).toHaveText("Add all 2");
    await addAll.click();
    await expect(page.getByTestId("bulk-status")).toHaveText("Added 2 items from Antibiotics to the order sheet.");
    for (const id of [amoxicillin, azithromycin, nitrofurantoin]) await expect(tickOf(page, id)).toBeChecked();
    await expect(barSentence(page)).toHaveText(sheetSentence(3));
    // Everything of the group is on the sheet now: the button turns into a status and does nothing.
    await expect(page.getByTestId(`group-all-on-sheet-${antibiotics.id}`)).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId(`group-all-on-sheet-${antibiotics.id}`)).toHaveText("All 3 on the order sheet");
    await expect(page.getByTestId(`group-add-all-${antibiotics.id}`)).toHaveCount(0);

    await page.getByTestId("bulk-undo").click();
    await expect(page.getByTestId("bulk-status")).toHaveText("Undid adding 2 items.");
    await expect(tickOf(page, azithromycin)).toBeChecked(); // ticked by hand before: stays
    await expect(tickOf(page, amoxicillin)).not.toBeChecked();
    await expect(tickOf(page, nitrofurantoin)).not.toBeChecked();
    await expect(barSentence(page)).toHaveText(sheetSentence(1));
  });
  }

  test("Add all adds only what the current filters show, in a group and in the flat list", async ({ page }) => {
    const api = await openInventory(page);
    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    const [amoxicillin, azithromycin, nitrofurantoin] = idsOf(api.medications, AMOXICILLIN, AZITHROMYCIN, NITROFURANTOIN);
    await setStock(page, "low");
    await page.getByTestId(`group-add-all-${antibiotics.id}`).click();
    await expect(tickOf(page, azithromycin)).toBeChecked();
    await expect(tickOf(page, nitrofurantoin)).toBeChecked();
    await setStock(page, "all");
    await expect(tickOf(page, amoxicillin)).not.toBeChecked(); // adequate stock: was not shown, so was not added
    await expect(barSentence(page)).toHaveText(sheetSentence(2));

    await setGrouped(page, false);
    await setSearch(page, "gloves");
    const gloves = expectedVisible(api.medications, api.categories, view({ search: "gloves", grouped: false }));
    await expect(page.getByTestId("flat-add-all")).toHaveText(`Add all ${gloves.length} shown`);
    await page.getByTestId("flat-add-all").click();
    await expect(page.getByTestId("bulk-status")).toHaveText(`Added ${gloves.length} items to the order sheet.`);
    await expect(barSentence(page)).toHaveText(sheetSentence(2 + gloves.length, 2));
    // Everything the flat list shows is on the sheet: the button turns into a status and offers nothing more.
    await expect(page.getByTestId("flat-all-on-sheet")).toHaveText(`All ${gloves.length} on the order sheet`);
    await expect(page.getByTestId("flat-add-all")).toHaveCount(0);
  });

  test("when the order sheet already holds 500 items, ticking another says the sheet is full and does not add it", async ({ page }) => {
    const filler = Array.from({ length: 500 }, (_, i) => 400_001 + i); // not in the inventory: they only fill the sheet
    const api = await openInventory(page, { sheetIds: filler });
    await expect(barSentence(page)).toHaveText(sheetSentence(500, 0, 500));
    // "Add all" is not offered any more, it would add nothing: every group (and the flat list) says the sheet is full instead.
    const groups = (await readScreen(page)).groups;
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      await expect(page.getByTestId(`group-sheet-full-${group.key}`), `group ${group.title}`).toHaveText("Sheet full (500 items)");
      await expect(page.getByTestId(`group-sheet-full-${group.key}`)).toHaveAttribute("aria-disabled", "true");
    }
    await expect(page.locator('[data-testid^="group-add-all-"]')).toHaveCount(0);
    await setGrouped(page, false);
    await expect(page.getByTestId("flat-sheet-full")).toHaveText("Sheet full (500 items)");
    await expect(page.getByTestId("flat-add-all")).toHaveCount(0);
    await setGrouped(page, true);
    const ibuprofen = seedByName(api.medications, IBUPROFEN);
    await tickOf(page, ibuprofen.id).click(); // (click, not check(): the box is expected to stay unticked)
    const full = page.getByTestId("order-bar-full");
    await expect(full).toBeVisible();
    await expect(full).toHaveAttribute("role", "alert");
    await expect(full).toHaveText("The sheet is full (500 items). Remove an item before adding another.");
    await expect(tickOf(page, ibuprofen.id)).not.toBeChecked();
    await expect(barSentence(page)).toHaveText(sheetSentence(500, 0, 500)); // nothing was added
    expect(nonGetRequests(api)).toEqual([]);
  });

  test("Add all stops at the 500-item limit, says how many were added, and Undo takes off only those", async ({ page }) => {
    const filler = Array.from({ length: 498 }, (_, i) => 400_001 + i);
    const api = await openInventory(page, { sheetIds: filler });
    const painAndFever = categoryByName(api.categories, PAIN_AND_FEVER); // five items in the group
    await page.getByTestId(`group-add-all-${painAndFever.id}`).click();
    await expect(page.getByTestId("bulk-status")).toHaveText("Added 2 of 5. The sheet is full (500 items).");
    await expect(barSentence(page)).toHaveText(sheetSentence(500, 0, 498));
    const added = (await readScreen(page)).groups.find((g) => g.key === painAndFever.id)?.ids ?? [];
    expect(added).toHaveLength(5);
    for (const [index, id] of added.entries()) {
      if (index < 2) await expect(tickOf(page, id)).toBeChecked();
      else await expect(tickOf(page, id)).not.toBeChecked();
    }
    await page.getByTestId("bulk-undo").click();
    await expect(page.getByTestId("bulk-status")).toHaveText("Undid adding 2 items.");
    await expect(barSentence(page)).toHaveText(sheetSentence(498, 0, 498));
    for (const id of added) await expect(tickOf(page, id)).not.toBeChecked();
  });

  test("when the browser cannot save the sheet the bar warns that it will be lost", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw new DOMException("The operation is insecure.", "SecurityError");
        },
      });
    });
    const api = await openInventory(page);
    await tickOf(page, seedByName(api.medications, IBUPROFEN).id).check();
    await expect(barSentence(page)).toHaveText(sheetSentence(1)); // it still works for this page view
    const warning = page.getByTestId("order-bar-storage-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("This browser is not saving your order sheet");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 10. Phone width
// ══════════════════════════════════════════════════════════════════════════════════════════════════
for (const width of [360, 390]) {
  test.describe(`phone width (${width}px)`, () => {
    test.use({ viewport: { width, height: 740 } });

    test("a 120-letter name, a 100-digit barcode and a 64-letter supplier code are shown in full: they wrap onto several lines inside their row, and no state scrolls sideways", async ({
      page,
    }) => {
      const { categories, medications, long } = withLongItem();
      const api = await openInventory(page, { categories, medications });
      await expectNoHorizontalScroll(page, "default grouped view");
      await expectLongValuesComplete(page, long, `grouped list at ${width}px`, true);

      await setGrouped(page, false);
      await expectNoHorizontalScroll(page, "flat view");
      await expectLongValuesComplete(page, long, `flat list at ${width}px`, true);
      await setGrouped(page, true);

      await setStock(page, "low");
      await expectNoHorizontalScroll(page, "low stock only");
      await setSearch(page, "zzzz");
      await expectNoHorizontalScroll(page, "no match");
      await setSearch(page, "");
      await setStock(page, "all");

      for (const id of [long.id, seedByName(api.medications, IBUPROFEN).id, seedByName(api.medications, AMOXICILLIN).id]) await tickOf(page, id).check();
      await page.getByTestId(`group-add-all-${categoryByName(categories, PAIN_AND_FEVER).id}`).click();
      await expect(page.getByTestId("bulk-status")).toBeVisible();
      await expectNoHorizontalScroll(page, "order bar with an Add all message");
      await page.getByTestId("order-bar-clear").click();
      await expectNoHorizontalScroll(page, "order bar asking to clear");
      await page.getByTestId("order-bar-clear-cancel").click();

      await chooseChip(page, inCategory(categoryByName(categories, ANTIBIOTICS).id));
      await expectNoHorizontalScroll(page, "one category chosen (with a filter chip)");
      await expectLongValuesComplete(page, long, `Antibiotics only at ${width}px`, true);
    });

    test("an error, the loading skeleton and the no-items state fit the screen too", async ({ page }) => {
      await openInventory(page, {
        until: "error",
        beforeLoad: (mock) =>
          mock.failNext({
            method: "GET",
            path: /^\/api\/medications$/,
            status: 500,
            body: { error: `Unexpected database error. ${"x".repeat(160)}`, code: "XX000" },
          }),
      });
      await expectNoHorizontalScroll(page, "inventory error with a long message");

      const empty = await page.context().newPage();
      await openInventory(empty, { medications: [] });
      await expectNoHorizontalScroll(empty, "no items");
      await empty.close();

      const slow = await page.context().newPage();
      await openInventory(slow, { latencyMs: 2500, until: "loading" });
      await expectNoHorizontalScroll(slow, "loading skeleton");
      await slow.close();
    });

    test("with many categories the chips sit behind one button that opens them, choosing one filters, closes the panel and returns focus to the button", async ({
      page,
    }) => {
      const { categories, medications } = manyCategories("uuid");
      const api = await openInventory(page, { categories, medications });
      const toggle = page.getByTestId("category-filter-toggle");
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(chipOf(page, "all")).toBeHidden();
      await expect(toggle).toContainText("Category: All");
      await expect(toggle).toContainText(`(${medications.length})`);

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      for (const key of ["all", "uncategorized", ...categories.map((c) => c.id)]) await expect(chipOf(page, key)).toBeVisible();

      const antibiotics = categoryByName(categories, ANTIBIOTICS);
      await chipOf(page, antibiotics.id).click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(chipOf(page, "all")).toBeHidden();
      await expect(toggle).toBeFocused();
      await expect(toggle).toContainText("Category: Antibiotics");
      await expect(toggle).toContainText("(3)");
      await expectScreenMatches(page, api.medications, api.categories, view({ category: inCategory(antibiotics.id) }), "chosen on a phone");
      await expect(page.getByTestId("active-filter-category")).toContainText("Category: Antibiotics");

      // Escape closes an open panel and returns focus to the button.
      await toggle.click();
      await expect(chipOf(page, "all")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(chipOf(page, "all")).toBeHidden();
      await expect(toggle).toBeFocused();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");

      // Back to a wide window: the button is gone and the chips are simply there.
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(toggle).toBeHidden();
      await expect(chipOf(page, "all")).toBeVisible();
    });

    test("the main controls named here (chips, stock buttons, sort, search, switch, Add all, row checkbox, order bar buttons) are at least 40px tall and wide", async ({ page }) => {
      const api = await openInventory(page);
      const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
      await tickOf(page, seedByName(api.medications, IBUPROFEN).id).check();
      await chipOf(page, antibiotics.id).click();
      await setSearch(page, "a");
      const controls: Array<[string, Locator]> = [
        ["All chip", chipOf(page, "all")],
        ["category chip", chipOf(page, antibiotics.id)],
        ["Uncategorized chip", chipOf(page, "uncategorized")],
        ["stock: All", page.getByTestId("stock-filter-all")],
        ["stock: Low", page.getByTestId("stock-filter-low")],
        ["sort", page.getByTestId("sort-select")],
        ["search", searchBoxOf(page)],
        ["group switch", page.getByTestId("group-toggle").locator("xpath=ancestor::label")],
        ["+ Add", page.getByRole("link", { name: "+ Add" })],
        ["Clear filters", page.getByTestId("clear-filters")],
        ["remove filter chip", page.getByTestId("active-filter-remove-category")],
        ["Collapse all", page.getByTestId("collapse-all")],
        ["group heading button", headingOf(page, antibiotics.id).getByRole("button")],
        ["Add all", page.getByTestId(`group-add-all-${antibiotics.id}`)],
        ["row checkbox", tickOf(page, seedByName(api.medications, AMOXICILLIN).id).locator("xpath=ancestor::label")],
        ["bar: Review order sheet", page.getByTestId("order-bar-review")],
        ["bar: Clear", page.getByTestId("order-bar-clear")],
      ];
      for (const [name, locator] of controls) {
        const size = await targetSize(locator);
        expect(size.height, `${name} is ${Math.round(size.height)}px tall`).toBeGreaterThanOrEqual(39.5);
        expect(size.width, `${name} is ${Math.round(size.width)}px wide`).toBeGreaterThanOrEqual(39.5);
      }
    });

    test("every visible button, link, field and switch of the Inventory tab is at least 40px, in each state: browsing, ticked, Add all message, Clear question, filters on, open category panel, empty states, errors", async ({
      page,
    }) => {
      const { categories, medications } = manyCategories("uuid");
      const withVendor = medications.findIndex((m) => m.name?.startsWith("Naproxen"));
      medications[withVendor] = { ...medications[withVendor], vendor_url: "https://shop.example.com/reorder?item=naproxen" };
      const api = await openInventory(page, { categories, medications });
      const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
      const sweep = async (where: string, on: Page = page): Promise<void> => {
        expect(await smallTouchTargets(on), `${where}: controls smaller than 40px`).toEqual([]);
      };

      await sweep("browsing, nothing chosen");
      await page.getByTestId("category-filter-toggle").click();
      await expect(chipOf(page, "all")).toBeVisible();
      await sweep("category panel open");
      await page.keyboard.press("Escape");

      await tickOf(page, seedByName(api.medications, "Naproxen").id).check();
      await sweep("one item ticked (order bar, vendor link)");
      await page.getByTestId(`group-add-all-${antibiotics.id}`).click();
      await expect(page.getByTestId("bulk-undo")).toBeVisible();
      await sweep("Added message with Undo and Dismiss");
      await page.getByTestId("bulk-dismiss").click();
      await page.getByTestId("order-bar-clear").click();
      await expect(page.getByTestId("order-bar-clear-confirm")).toBeVisible();
      await sweep("Clear question (Yes / Keep items)");
      await page.getByTestId("order-bar-clear-cancel").click();

      await chooseChip(page, inCategory(antibiotics.id));
      await setStock(page, "low");
      await setSearch(page, "a");
      await expect(page.getByTestId("active-filter-remove-category")).toBeVisible();
      await sweep("category, stock and search filters on (filter chips, Clear filters)");
      await setGrouped(page, false);
      await sweep("flat list (flat Add all)");
      await setGrouped(page, true);

      await setSearch(page, "zzzz");
      await expect(page.getByTestId("inventory-empty")).toHaveAttribute("data-empty-kind", "no-match");
      await sweep("empty state: nothing matches");
      await setSearch(page, "");
      await setStock(page, "all"); // an empty category is only called empty while no search and no stock level is on
      await chooseChip(page, inCategory(categoryByName(api.categories, "Empty shelf").id));
      await expect(page.getByTestId("inventory-empty")).toHaveAttribute("data-empty-kind", "category-empty");
      await sweep("empty state: an empty category");

      const noItems = await page.context().newPage();
      await openInventory(noItems, { medications: [] });
      await expect(noItems.getByTestId("inventory-empty")).toHaveAttribute("data-empty-kind", "no-items");
      await sweep("empty state: no items at all", noItems);
      await noItems.close();

      const failing = await page.context().newPage();
      await openInventory(failing, {
        until: "error",
        beforeLoad: (mock) => mock.failNext({ method: "GET", path: /^\/api\/medications$/, status: 500, body: { error: "Unexpected database error." } }),
      });
      await sweep("the inventory could not be loaded (Retry)", failing);
      await failing.close();

      const noCategories = await page.context().newPage();
      await openInventory(noCategories, {
        beforeLoad: (mock) => mock.failNext({ method: "GET", path: /^\/api\/categories$/, status: 500, body: { error: "Unexpected database error." } }),
      });
      await expect(noCategories.getByTestId("categories-error")).toBeVisible();
      await sweep("the categories could not be loaded (warning with Retry)", noCategories);
      await noCategories.close();
    });

    test("a focused checkbox near the end of the list is not hidden behind the sticky order bar", async ({ page }) => {
      const api = await openInventory(page);
      await tickOf(page, seedByName(api.medications, IBUPROFEN).id).check();
      const last = tickOf(page, seedByName(api.medications, THERMOMETER_COVERS).id);
      await tabTo(page, last, { max: 200 });
      await expect(last).toBeFocused();
      const covered = await page.evaluate(() => {
        const input = document.activeElement;
        const bar = document.querySelector('[data-testid="order-bar"]');
        if (!input || !bar) return "missing";
        const a = (input.closest("label") ?? input).getBoundingClientRect();
        const b = bar.getBoundingClientRect();
        const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        return overlap > 1 ? `overlaps by ${Math.round(overlap)}px` : "clear";
      });
      expect(covered).toBe("clear");
    });
  });
}

// Between a phone and a desktop the row changes its layout twice (480px and 720px of list width). The long values must stay
// complete there too.
for (const width of [480, 600, 768, 1024]) {
  test(`at ${width}px wide a 120-letter name, a 100-digit barcode and a 64-letter supplier code are shown in full inside their row, and the page does not scroll sideways`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { categories, medications, long } = withLongItem();
    await openInventory(page, { categories, medications });
    await expectNoHorizontalScroll(page, `${width}px grouped`);
    await expectLongValuesComplete(page, long, `grouped list at ${width}px`, false);
    await setGrouped(page, false);
    await expectNoHorizontalScroll(page, `${width}px flat`);
    await expectLongValuesComplete(page, long, `flat list at ${width}px`, false);
  });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 11. Keyboard and screen-reader basics
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("keyboard", () => {
  test("a category chip is reached with Tab and chosen with Enter or Space; the choice is spoken (aria-pressed) and focus stays on the chip", async ({ page }) => {
    const api = await openInventory(page);
    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    const target = chipOf(page, antibiotics.id);
    await tabTo(page, target);
    await expect(target).toBeFocused();
    expect(await hasFocusIndicator(target)).toBe(true);
    await page.keyboard.press("Enter");
    await expect(target).toHaveAttribute("aria-pressed", "true");
    await expect(chipOf(page, "all")).toHaveAttribute("aria-pressed", "false");
    await expectScreenMatches(page, api.medications, api.categories, view({ category: inCategory(antibiotics.id) }), "chosen with Enter");
    await expect(target).toBeFocused();

    await page.keyboard.press("Shift+Tab"); // the chip before it (chips are in name order: Allergy & Cold)
    const allergy = categoryByName(api.categories, "Allergy & Cold");
    await expect(chipOf(page, allergy.id)).toBeFocused();
    await page.keyboard.press("Space");
    await expect(chipOf(page, allergy.id)).toHaveAttribute("aria-pressed", "true");
    await expectScreenMatches(page, api.medications, api.categories, view({ category: inCategory(allergy.id) }), "chosen with Space");
    await expect(chipOf(page, allergy.id)).toBeFocused();
  });

  test("the stock level buttons and Clear filters work from the keyboard, and Clear filters does not drop focus to the page start", async ({ page }) => {
    const api = await openInventory(page);
    const low = page.getByTestId("stock-filter-low");
    await tabTo(page, low);
    expect(await hasFocusIndicator(low)).toBe(true);
    await page.keyboard.press("Enter");
    await expect(low).toHaveAttribute("aria-pressed", "true");
    await expectScreenMatches(page, api.medications, api.categories, view({ stock: "low" }), "low via keyboard");

    await tabTo(page, page.getByTestId("clear-filters"));
    await page.keyboard.press("Enter");
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "cleared via keyboard");
    expect(await focusedName(page), "focus must not fall to the page start").not.toBe("body");
  });

  test("the Group by category switch is reached with Tab and flipped with Space; focus stays on it", async ({ page }) => {
    const api = await openInventory(page);
    const toggle = page.getByTestId("group-toggle");
    await tabTo(page, toggle);
    await expect(toggle).toHaveAttribute("role", "switch");
    await page.keyboard.press("Space");
    await expect(toggle).not.toBeChecked();
    await expectScreenMatches(page, api.medications, api.categories, view({ grouped: false }), "switched off");
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "switched on");
    await expect(toggle).toBeFocused();
  });

  test("a group is folded and unfolded with Enter or Space on its heading; the count stays, the rows go and return, and Collapse all / Expand all work", async ({ page }) => {
    const api = await openInventory(page);
    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    const button = headingOf(page, antibiotics.id).getByRole("button");
    await tabTo(page, button);
    expect(await hasFocusIndicator(button)).toBe(true);
    await expect(button).toHaveAttribute("aria-expanded", "true");

    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    let screen = await readScreen(page);
    const group = screen.groups.find((g) => g.key === antibiotics.id);
    expect(group?.expanded).toBe(false);
    expect(group?.count).toBe(3); // the heading still says how many are inside
    expect(screen.rows.filter((r) => group?.ids.includes(r.id)).every((r) => !r.visible)).toBe(true);
    expect(screen.summary).toBe("Showing all 27 items."); // folding changes what is drawn, not what matched
    await expect(button).toBeFocused();

    await page.keyboard.press("Space");
    await expect(button).toHaveAttribute("aria-expanded", "true");
    screen = await readScreen(page);
    expect(screen.rows.filter((r) => group?.ids.includes(r.id)).every((r) => r.visible)).toBe(true);

    await page.getByTestId("collapse-all").click();
    screen = await readScreen(page);
    expect(screen.groups.every((g) => !g.expanded)).toBe(true);
    expect(screen.rows.every((r) => !r.visible)).toBe(true);
    await page.getByTestId("expand-all").click();
    screen = await readScreen(page);
    expect(screen.groups.every((g) => g.expanded)).toBe(true);
    expect(screen.rows.every((r) => r.visible)).toBe(true);
  });

  test("a new search opens folded groups again, so a match is never counted in the results line yet hidden", async ({ page }) => {
    const api = await openInventory(page);
    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    await page.getByTestId("collapse-all").click();
    await setSearch(page, "amox");
    await expectScreenMatches(page, api.medications, api.categories, view({ search: "amox" }), "search after folding");
    const screen = await readScreen(page);
    expect(screen.groups.find((g) => g.key === antibiotics.id)?.expanded).toBe(true);
    const shownRows = screen.rows.filter((r) => r.visible).length;
    expect(shownRows).toBe(screen.rows.length);
    expect(shownRows).toBe(1);
  });

  test("groups a person folded stay folded while they change the sort order", async ({ page }) => {
    const api = await openInventory(page);
    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    await headingOf(page, antibiotics.id).getByRole("button").click();
    await setSort(page, "stock-asc");
    await expectScreenMatches(page, api.medications, api.categories, view({ sort: "stock-asc" }), "sorted while folded");
    const screen = await readScreen(page);
    expect(screen.groups.find((g) => g.key === antibiotics.id)?.expanded).toBe(false);
    expect(screen.groups.filter((g) => g.key !== antibiotics.id).every((g) => g.expanded)).toBe(true);
  });

  test("Add to order sheet is a labelled checkbox with a name that includes the item, reached with Tab and ticked with Space", async ({ page }) => {
    const api = await openInventory(page);
    const ibuprofen = seedByName(api.medications, IBUPROFEN);
    const box = tickOf(page, ibuprofen.id);
    await tabTo(page, box, { max: 200 });
    await expect(box).toBeFocused();
    expect(await hasFocusIndicator(box.locator("xpath=ancestor::label"))).toBe(true); // the visible ring is on its label
    await expect(box).toHaveAccessibleName(new RegExp(`^Add to order sheet ${escapeRegExp(ibuprofen.name?.trim() ?? "")}`));
    await page.keyboard.press("Space");
    await expect(box).toBeChecked();
    await expect(barSentence(page)).toHaveText(sheetSentence(1));
    await page.keyboard.press("Space");
    await expect(box).not.toBeChecked();
    await expect(orderBarOf(page)).toHaveCount(0);
    // Every row has its own checkbox with its own name.
    await expect(page.getByRole("checkbox")).toHaveCount(api.medications.length);
  });

  test("the search box has a visible label, the results line is a polite live region, and the error notice is an alert", async ({ page }) => {
    await openInventory(page);
    await expect(page.getByLabel("Search")).toBeVisible();
    await expect(page.getByLabel("Search")).toHaveAttribute("type", "search");
    await expect(summaryOf(page)).toHaveAttribute("aria-live", "polite");
    await expect(page.getByRole("group", { name: "Category" })).toBeVisible(); // the chips are a named group
    await expect(page.getByRole("combobox", { name: "Sort by" })).toBeVisible();

    const failing = await page.context().newPage();
    await openInventory(failing, {
      until: "error",
      beforeLoad: (mock) => mock.failNext({ method: "GET", path: /^\/api\/medications$/, status: 500, body: { error: "Unexpected database error." } }),
    });
    await expect(failing.getByRole("alert").filter({ hasText: "Couldn’t load the inventory" })).toBeVisible();
    await failing.close();
  });

  test("removing the last filter chip from the keyboard leaves focus on the search box, not the page start", async ({ page }) => {
    const api = await openInventory(page);
    await setSearch(page, "azi");
    const remove = page.getByTestId("active-filter-remove-search");
    await tabTo(page, remove);
    await page.keyboard.press("Enter");
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "search chip removed");
    expect(await focusedName(page)).toBe("search-input");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 12. A saved change shows up; existing actions stay
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("saved changes and existing actions", () => {
  test("after a category is changed in Admin and saved, the Inventory tab lists the item in the new group and the counts move", async ({ page }) => {
    const api = await openInventory(page);
    const ibuprofen = seedByName(api.medications, IBUPROFEN);
    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    const before = await readScreen(page);
    expect(before.groups.find((g) => g.key === antibiotics.id)?.count).toBe(3);

    await page.getByRole("navigation").getByRole("link", { name: "Admin", exact: true }).click();
    await expect(page.getByTestId("admin-summary")).toBeVisible({ timeout: SLOW_MS });
    await page.getByTestId(`admin-edit-${ibuprofen.id}`).click();
    await chooseCategory(page, ANTIBIOTICS);
    await page.getByTestId("save-button").click();
    await expect(page.getByTestId("admin-success")).toBeVisible();
    expect(api.medications.find((m) => m.id === ibuprofen.id)?.category_id).toBe(antibiotics.id);

    await page.getByRole("navigation").getByRole("link", { name: "Scan", exact: true }).click();
    await page.getByRole("button", { name: "Inventory", exact: true }).click();
    await expect(summaryOf(page)).toBeVisible({ timeout: SLOW_MS });
    const after = await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "after the Admin save");
    expect(after.groups.find((g) => g.key === antibiotics.id)?.ids).toContain(ibuprofen.id);
    expect(after.groups.find((g) => g.key === antibiotics.id)?.count).toBe(4);
    const painAndFever = categoryByName(api.categories, PAIN_AND_FEVER);
    expect(after.groups.find((g) => g.key === painAndFever.id)?.count).toBe(4);
    expect(after.groups.find((g) => g.key === painAndFever.id)?.ids).not.toContain(ibuprofen.id);
    // The saved edit changed only the category.
    const saved = api.medications.find((m) => m.id === ibuprofen.id);
    expect(saved?.stock).toBe(ibuprofen.stock);
    expect(saved?.supplier_order_number).toBe(ibuprofen.supplier_order_number);
  });

  test("the + Add link opens Admin, the Scan tab is one click away, and the Inventory view is kept when coming back", async ({ page }) => {
    const api = await openInventory(page);
    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    await chipOf(page, antibiotics.id).click();
    await setSearch(page, "azi");

    await page.getByRole("link", { name: "+ Add" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId("admin-summary")).toBeVisible({ timeout: SLOW_MS });
    await page.goBack();
    await expect(page).toHaveURL(/tab=inventory/);
    await expectScreenMatches(page, api.medications, api.categories, view({ search: "azi", category: inCategory(antibiotics.id) }), "after Back from Admin");
    await expect(searchBoxOf(page)).toHaveValue("azi");

    await page.getByRole("button", { name: "Scan", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Scan medications" })).toBeAttached();
    await expect(page.getByTestId("inventory-tab")).toHaveCount(0);
    await page.getByRole("button", { name: "Inventory", exact: true }).click();
    await expectScreenMatches(page, api.medications, api.categories, view({ search: "azi", category: inCategory(antibiotics.id) }), "after Scan and back");
  });

  test("leaving for the order sheet and coming back with Back keeps the search, stock level, category, sort and grouping", async ({ page }) => {
    const api = await openInventory(page);
    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    const v = view({ search: "a", stock: "low", category: inCategory(antibiotics.id), sort: "stock-asc", grouped: false });
    await applyView(page, v);
    await expectScreenMatches(page, api.medications, api.categories, v, "before leaving");
    await tickOf(page, seedByName(api.medications, AZITHROMYCIN).id).check();

    await page.getByTestId("order-bar-review").click();
    await expect(page).toHaveURL(/\/order-sheet$/);
    await page.goBack();
    await expect(summaryOf(page)).toBeVisible({ timeout: SLOW_MS });
    await expectScreenMatches(page, api.medications, api.categories, v, "after Back");
    await expect(tickOf(page, seedByName(api.medications, AZITHROMYCIN).id)).toBeChecked();
  });

  test("with ten categories (bigint ids) every chip is in the page exactly once, in name order, and each one filters correctly", async ({ page }) => {
    const { categories, medications } = manyCategories("bigint");
    const api = await openInventory(page, { shape: "bigint", categories, medications });
    const screen = await readScreen(page);
    // One set of chips serves the wide row and the phone panel: no key appears twice.
    expect(screen.chips.map((c) => c.label)).toEqual([
      "All",
      "Allergy & Cold",
      "Antibiotics",
      "Dental",
      "Empty shelf",
      "Eye & Ear Care",
      "First Aid",
      "IV & Fluids",
      "Lab Supplies",
      "Pain & Fever",
      "PPE & Gloves",
      "Uncategorized",
    ]);
    expect(new Set(screen.chips.map((c) => c.key)).size).toBe(screen.chips.length);
    for (const category of api.categories) {
      await chooseChip(page, inCategory(category.id));
      await expectScreenMatches(page, api.medications, api.categories, view({ category: inCategory(category.id) }), `chip ${category.name}`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 13. Robustness: remembered state, odd data, request audit
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test.describe("robustness", () => {
  /** Puts text in sessionStorage / localStorage before the page loads (only the first load, so a reload keeps later changes). */
  async function seedStorage(page: Page, entries: { session?: Record<string, string>; local?: Record<string, string> }): Promise<void> {
    await page.addInitScript((seed) => {
      try {
        if (window.sessionStorage.getItem("__e2e_seeded") !== null) return;
        window.sessionStorage.setItem("__e2e_seeded", "1");
        for (const [key, value] of Object.entries(seed.session ?? {})) window.sessionStorage.setItem(key, value);
        for (const [key, value] of Object.entries(seed.local ?? {})) window.localStorage.setItem(key, value);
      } catch {
        /* storage unavailable: the test fails on its own assertions */
      }
    }, entries);
  }

  test("a remembered view is applied on load, but a remembered category that no longer exists is dropped so it cannot hide the whole inventory", async ({ page }) => {
    const antibiotics = categoryByName(buildCategories("uuid"), ANTIBIOTICS);
    await seedStorage(page, {
      session: { [VIEW_KEY]: JSON.stringify({ search: "azi", stock: "low", category: { kind: "category", id: antibiotics.id }, sort: "stock-asc", grouped: false }) },
    });
    const api = await openInventory(page);
    await expectScreenMatches(
      page,
      api.medications,
      api.categories,
      view({ search: "azi", stock: "low", category: inCategory(antibiotics.id), sort: "stock-asc", grouped: false }),
      "remembered view"
    );

    const gone = await page.context().newPage();
    await seedStorage(gone, {
      session: { [VIEW_KEY]: JSON.stringify({ search: "", stock: "all", category: { kind: "category", id: "00000000-0000-4000-8000-0000000000dd" }, sort: "name", grouped: true }) },
    });
    const goneApi = await openInventory(gone);
    await expectScreenMatches(gone, goneApi.medications, goneApi.categories, ALL_ITEMS, "remembered category that was deleted");
    const stored = await gone.evaluate((key) => window.sessionStorage.getItem(key), VIEW_KEY);
    expect(JSON.parse(stored ?? "{}").category).toEqual({ kind: "all" });
    await gone.close();
  });

  test("a damaged remembered view and a damaged order sheet draft are ignored: the tab opens on the default view with every item", async ({ page }) => {
    await seedStorage(page, { session: { [VIEW_KEY]: "{not json" }, local: { [DRAFT_KEY]: "{broken" } });
    const api = await openInventory(page);
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "damaged text");
    await expect(orderBarOf(page)).toHaveCount(0);
    await tickOf(page, seedByName(api.medications, IBUPROFEN).id).check(); // the sheet works again from here
    await expect(barSentence(page)).toHaveText(sheetSentence(1));
  });

  test("a remembered view with wrong value types falls back field by field, never to NaN or an empty list", async ({ page }) => {
    await seedStorage(page, {
      session: { [VIEW_KEY]: JSON.stringify({ search: 7, stock: "banana", category: { kind: "category", id: "NaN" }, sort: 42, grouped: "yes" }) },
      local: { [DRAFT_KEY]: JSON.stringify({ version: 1, rows: "not a list", title: 5 }) },
    });
    const api = await openInventory(page);
    await expectScreenMatches(page, api.medications, api.categories, ALL_ITEMS, "wrong value types");
    await expect(orderBarOf(page)).toHaveCount(0);
  });

  test("blanks around a supplier order number are trimmed, a blank one reads Not set, and a name of only spaces reads as an unnamed item", async ({ page }) => {
    const medications = buildMedications();
    medications[0] = { ...medications[0], supplier_order_number: "  00417-B  " };
    medications[1] = { ...medications[1], supplier_order_number: "   " };
    medications[2] = { ...medications[2], name: "   " };
    await openInventory(page, { medications });
    const screen = await readScreen(page);
    const row = (index: number) => screen.rows.find((r) => r.id === medications[index].id);
    expect(row(0)?.supplier).toBe("00417-B");
    expect(row(1)?.supplier).toBe("Not set");
    expect(row(2)?.text).toContain("Unnamed item");
    expect(screen.bodyText).not.toMatch(/\b(NaN|undefined|null)\b/);
  });

  test("searching for the words null or undefined finds nothing: a missing name or supplier number never counts as text", async ({ page }) => {
    const api = await openInventory(page);
    for (const word of ["null", "undefined", "NaN"]) {
      await setSearch(page, word);
      const screen = await expectScreenMatches(page, api.medications, api.categories, view({ search: word }), `search ${word}`);
      expect(screen.rows, `"${word}" must not match items that merely lack a name or a supplier number`).toHaveLength(0);
    }
  });

  test("the page asks the server for the complete inventory and category list once, and every filter then works on that complete list", async ({ page }) => {
    const api = await openInventory(page);
    const antibiotics = categoryByName(api.categories, ANTIBIOTICS);
    await chipOf(page, antibiotics.id).click();
    await setStock(page, "low");
    await setSearch(page, "a");
    await setSort(page, "stock-asc");
    await setGrouped(page, false);
    await page.getByTestId("clear-filters").click();
    await expectScreenMatches(page, api.medications, api.categories, view({ sort: "stock-asc", grouped: false }), "after browsing");
    // One request each, with no filter in the address: no partial page can be mistaken for the whole category.
    expect(api.requests.map((r) => `${r.method} ${r.path}${r.search}`).sort()).toEqual(["GET /api/categories", "GET /api/medications"]);
  });
});

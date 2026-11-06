// REPRODUCTION PROOF of the owner's main bug: "categories appear available, but assignments don't persist".
//
// Root cause (SPEC.md section 1): the original Admin page turned the chosen category into a number with
// Number(select.value). The live database uses UUID category ids, Number("<uuid>") is NaN, JSON.stringify writes NaN as
// null, so the page sent `category_id: null` on every save and still said "Medication updated.".
//
// This file is a proof, so it only uses locators that exist on BOTH the original page and the current one: visible text,
// roles and structure, never data-testid. The same file can therefore be run against either build:
//   current UI : E2E_BASE_URL=http://127.0.0.1:3100 CHROMIUM_PATH=... npx playwright test tests/e2e/category-assignment-regression.spec.ts --reporter=list
//   original UI: E2E_BASE_URL=http://127.0.0.1:3101 CHROMIUM_PATH=... npx playwright test tests/e2e/category-assignment-regression.spec.ts --reporter=list
//
// Verified result of the two runs (20 tests):
//   current UI  : 20 passed.
//   original UI : 9 failed, 11 passed. Failing: the five uuid tests that assign, change or create a category, keep the pick on
//                 screen, or use the long searchable list (`category_id: null` in the request, `null` in the database and no
//                 category after a reload; the dropdown snaps back to "no category" and the page prints "NaN"); the stale stock
//                 overwrite; and the three failed-save tests (the original puts its messages in a plain div without role="alert",
//                 its dropdown forgets the pick, and for a save that stored nothing it closes the form and says "Medication
//                 updated."). Passing on the original: the three uuid controls (a stock-only edit passes the untouched uuid string
//                 straight through, so it never hits Number(); choosing "no category" really clears it) and all eight bigint twins
//                 (also with the filled-in fixture rows below), because Number("3") is 3. That split is what pins the bug on the id type.
//
// How a failure is made trustworthy: everything the test needs in order to *reach* the behavior (the page loaded, the item is
// listed, the edit form opened, the form started on the item's real category, the save request was answered) is a hard
// assertion, so a broken harness or a changed layout fails loudly as "could not get there". The outcomes the owner cares
// about (what the save request carried, what the database holds, what the page shows after a reload) are SOFT assertions
// with messages in plain words, so one failing run lists every symptom instead of stopping at the first. Assertions that
// say something did NOT happen are only made after a settled state was observed, so they cannot pass before the page reacts
// (and, where the page could act later on a timer, after the page's clock was moved forward: see the accepted-but-not-stored test).
//
// Two more things that keep it honest. (1) The rows the tests edit have EVERY optional field filled in (notes, vendor URL, a unit
// other than "units", a photo, a supplier number) and the whole row is compared after each save: on a plain fixture row, wiping
// those fields is invisible. (2) When the page never shows the list because the app server itself is broken (the Next.js
// development overlay, its "This page couldn't load" page), the test fails at once and says so, instead of reporting a missing row.
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Category, Medication } from "@/lib/db";
import { installMockApi, type MockApi } from "./helpers/mock-api";
import { buildCategories, buildMedications, categoryId, type IdShape } from "../helpers/fixtures";

const SHAPES: readonly IdShape[] = ["uuid", "bigint"];

// Items from tests/helpers/fixtures.ts (synthetic): one that already has a category, one legacy row without any.
const PAIN_ITEM = "Ibuprofen 200 mg, tablets"; // category "Pain & Fever", stock 18, threshold 40
const LEGACY_ITEM = "Thermometer probe covers"; // no category, stock 200, threshold 50
const NEW_ITEM = "Sterile eye wash, 118 mL";
const NEW_ITEM_BARCODE = "0049000012345";

const SAVE_PUT = /\/api\/medications\/\d+$/;
const SAVE_POST = /\/api\/medications$/;

/** What a page must not say after a save that did not succeed: the current build's "Saved. Category: ..." or the original's "Medication updated." */
const SUCCESS_WORDING = /(^|\s)Saved\.|Medication (updated|added)\./;

const PHOTO = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#94a3b8"/></svg>')}`;

/**
 * The fixture items with EVERY optional field filled in: notes, vendor URL, a unit other than the default "units", a photo (and
 * the supplier order number the fixtures already give the first one). A save that is about the category or the stock must leave
 * all of them alone, and that can only be seen when they hold something: on a row where they are null or default, wiping them
 * changes nothing a comparison could notice.
 */
const PAIN_ITEM_EXTRAS = {
  notes: "Store in the locked cabinet",
  vendor_url: "https://supplier.example.invalid/ibuprofen-200",
  unit: "tablets",
  photo_url: PHOTO,
} as const;
const LEGACY_ITEM_EXTRAS = {
  notes: "Single-use covers for the oral thermometer",
  vendor_url: "https://supplier.example.invalid/probe-covers",
  unit: "boxes",
  photo_url: PHOTO,
} as const;

function richMedications(shape: IdShape): Medication[] {
  return buildMedications({ shape }).map((m): Medication => {
    if (m.name === PAIN_ITEM) return { ...m, ...PAIN_ITEM_EXTRAS };
    if (m.name === LEGACY_ITEM) return { ...m, ...LEGACY_ITEM_EXTRAS };
    return m;
  });
}

/** The mock database for a test: rich rows for the two items the tests edit. */
function installRichMockApi(page: Page, shape: IdShape, extra: { categories?: Category[] } = {}): Promise<MockApi> {
  return installMockApi(page, { shape, medications: richMedications(shape), ...extra });
}

/** Failed expectations are recorded and the test carries on, so a failing run reports every symptom. */
const soft = expect.configure({ soft: true });

/** How long a state that should already be settled may take to show (it only covers the async category fetch). */
const SETTLED = { timeout: 5_000 } as const;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Mock database access ───────────────────────────────────────────────────────────────────────────────────────────

/** The live row held by the mock database (it is mutated in place as the page saves). */
function dbRow(mock: MockApi, name: string): Medication {
  const row = mock.medications.find((m) => m.name === name);
  if (!row) throw new Error(`Fixture item "${name}" is not in the mock database`);
  return row;
}

function categoryNamed(mock: MockApi, name: string): Category {
  const category = mock.categories.find((c) => c.name === name);
  if (!category) throw new Error(`Fixture category "${name}" is not in the mock database`);
  return category;
}

/** The JSON body of the single save request of this test. */
function savedBody(mock: MockApi, method: "PUT" | "POST"): Dict {
  const requests = mock.requestsTo(method, method === "PUT" ? SAVE_PUT : SAVE_POST);
  expect(requests, `exactly one ${method} save request was sent`).toHaveLength(1);
  const body = requests[0].body;
  if (!isDict(body)) throw new Error(`The ${method} body was not a JSON object: ${JSON.stringify(body)}`);
  return body;
}

/**
 * `category_id` as it travelled over the wire. A uuid id must arrive as that very string. A bigint id may be the digit string
 * or the equal number (the original page sends a number there, which is fine). A missing key stays `undefined`, and the
 * `null` that JSON.stringify writes for NaN stays `null`.
 */
function sentCategory(body: Dict, shape: IdShape): unknown {
  const value = body.category_id;
  return shape === "bigint" && typeof value === "number" ? String(value) : value;
}

/** A save that is about something else may leave the category out, but it must never send a different one or clear it. */
function expectCategoryNotClearedByRequest(body: Dict, shape: IdShape, expected: string | null, label: string): void {
  if (!("category_id" in body)) return;
  soft(sentCategory(body, shape), `${label}: the request must not carry a different category, null or NaN`).toBe(expected);
}

// ── Locators that exist on the original page AND the current one ───────────────────────────────────────────────────

/** The list row of an item: the innermost element that holds both the item's exact name and its "Edit" button. */
function itemRow(page: Page, name: string): Locator {
  return page
    .locator("li, div, tr")
    .filter({ has: page.getByText(name, { exact: true }) })
    .filter({ has: page.getByRole("button", { name: "Edit", exact: true }) })
    .last();
}

/** The item form: the only <form> on the page, on both pages. */
function itemForm(page: Page): Locator {
  return page.locator("form");
}

/**
 * The Category field. A native <select> has the ARIA role "combobox", and so has the searchable input the current page uses
 * once there are 11 or more categories, so one locator covers both.
 */
function categoryField(page: Page): Locator {
  return itemForm(page).getByRole("combobox");
}

/** The control that follows a field label. Works whether or not the label is wired to its control with `for`. */
function controlAfterLabel(page: Page, label: RegExp, tag: "input" | "textarea"): Locator {
  return itemForm(page).locator("label").filter({ hasText: label }).locator(`xpath=following::${tag}[1]`);
}

async function isNativeSelect(field: Locator): Promise<boolean> {
  return field.evaluate((el) => el instanceof HTMLSelectElement, undefined, SETTLED);
}

const NONE = "(no category)";

/** What the Category field shows right now. The "nothing chosen" entry is called differently on the two pages. */
async function shownCategory(field: Locator): Promise<string> {
  const text = await field.evaluate(
    (el) => {
      if (el instanceof HTMLSelectElement) return el.selectedOptions[0]?.textContent ?? "";
      if (el instanceof HTMLInputElement) return el.value;
      return "";
    },
    undefined,
    SETTLED
  );
  const label = text.trim();
  return /^—\s*(No category|Uncategorized)\s*—$/.test(label) ? NONE : label;
}

/** Records which kind of control the Category field was in the report (visible with --reporter=json), so it is evidence, not an assumption. */
function recordControlKind(native: boolean): void {
  test.info().annotations.push({ type: "category control", description: native ? "native select" : "searchable input (combobox)" });
}

/** The Category field of the open form, whichever kind of control it is: pick `name` from it. */
async function chooseCategory(page: Page, name: string): Promise<void> {
  const field = categoryField(page);
  await expect(field).toBeVisible();
  const native = await isNativeSelect(field);
  recordControlKind(native);
  if (native) {
    await field.selectOption({ label: name });
    return;
  }
  await field.click();
  await field.fill(name);
  await page.getByRole("option", { name, exact: true }).click();
}

/**
 * With 11 or more categories the current page offers a searchable list (a text input with options) instead of a plain dropdown
 * (SPEC.md section 2.10). The long-list test is only worth anything if it really drives that control, and chooseCategory would
 * quietly fall back to a plain dropdown if the page stopped switching, so this is asserted, not just recorded. Soft, so a failing
 * run still lists every other symptom.
 */
async function expectSearchableCategoryList(page: Page, categoryCount: number): Promise<void> {
  const native = await isNativeSelect(categoryField(page));
  soft(native, `with ${categoryCount} categories the Category field must be the searchable list (a text input with options), not a plain dropdown`).toBe(false);
}

/** Pick the "no category" entry ("— No category —" on the original page, "— Uncategorized —" on the current one). */
async function chooseNoCategory(page: Page): Promise<void> {
  const field = categoryField(page);
  await expect(field).toBeVisible();
  const native = await isNativeSelect(field);
  recordControlKind(native);
  if (native) {
    await field.selectOption({ value: "" });
    return;
  }
  await field.click();
  await page.getByRole("option", { name: /^—\s*(No category|Uncategorized)\s*—$/ }).click();
}

// ── Page flows ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Why the page cannot work, when it shows the app server's own failure instead of the app: the Next.js development overlay
 * ("Build Error", "Runtime Error": somebody saved a file that does not compile) or the "This page couldn't load" crash page.
 * Null when the page looks normal. Telling this apart from "the row never showed up" keeps a broken development server from
 * being read as a category regression, and fails in a moment instead of after the 30 s wait.
 */
async function serverFailureOnPage(page: Page): Promise<string | null> {
  try {
    const overlay = page.locator("nextjs-portal").getByRole("dialog", { name: /error/i });
    if ((await overlay.count()) > 0) {
      const text = (await overlay.first().innerText()).replace(/\s+/g, " ").trim();
      return `the Next.js error overlay is showing: ${text.slice(0, 300)}`;
    }
    const crash = page.getByRole("heading", { name: /This page couldn.t load|Application error/i });
    if ((await crash.count()) > 0) return `the app's crash page is showing: "${(await crash.first().innerText()).trim()}"`;
  } catch {
    // The page is navigating or closing: nothing can be said about it right now.
  }
  return null;
}

/**
 * Waits until the item's row is on the page. This is a polled condition (no sleep), and it gives up at once, with the reason,
 * when the page turns out to be the app server's own failure page. The generous timeout covers a cold compile of /admin on the
 * dev server.
 */
async function waitForRow(page: Page, itemName: string): Promise<void> {
  const row = itemRow(page, itemName);
  let observed = "the row is not there yet";
  await expect
    .poll(
      async () => {
        try {
          if (await row.isVisible()) return (observed = "ready");
        } catch {
          // The page is navigating: look again.
        }
        const failure = await serverFailureOnPage(page);
        return (observed = failure === null ? "the row is not there yet" : `server failure: ${failure}`);
      },
      { timeout: 30_000, intervals: [100, 250, 500], message: `the list row of "${itemName}" should show up on the page` }
    )
    .not.toBe("the row is not there yet");
  if (observed !== "ready") {
    throw new Error(`The page never reached the item list, and the cause is the app server, not the category feature (${observed})`);
  }
}

/**
 * Waits for the item's row and checks that the locator found ONE row (one Edit button). Row-text assertions below are only
 * meaningful when the locator did not resolve to a bigger container that happens to hold other items' text too.
 */
async function expectOneRowFor(page: Page, itemName: string): Promise<void> {
  await waitForRow(page, itemName);
  await expect(
    itemRow(page, itemName).getByRole("button", { name: "Edit", exact: true }),
    `the row locator for "${itemName}" must resolve to a single list row, not to a container of several rows`
  ).toHaveCount(1);
}

async function openAdmin(page: Page, itemName: string): Promise<void> {
  await page.goto("/admin");
  // The list is filled by a client-side fetch, so a visible row also means the page has hydrated.
  await expectOneRowFor(page, itemName);
}

async function reloadAdmin(page: Page, itemName: string): Promise<void> {
  await page.reload();
  await expectOneRowFor(page, itemName);
}

/** Opens the edit form of an item and waits until the form (and its Category field) is there. */
async function openEdit(page: Page, itemName: string): Promise<void> {
  await itemRow(page, itemName).getByRole("button", { name: "Edit", exact: true }).click();
  await expect(categoryField(page)).toBeVisible();
}

/** Hard precondition: the open form starts on this category (so the test really starts from the state it describes). */
async function expectFormStartsOn(page: Page, expected: string): Promise<void> {
  await expect
    .poll(() => shownCategory(categoryField(page)), {
      message: `precondition: the edit form should start on "${expected}" (the item's stored category)`,
    })
    .toBe(expected);
}

/** Presses the form's submit button and returns the HTTP status of the answer to the save request. */
async function pressSave(page: Page, method: "PUT" | "POST"): Promise<number> {
  const pathPattern = method === "PUT" ? SAVE_PUT : SAVE_POST;
  const answered = page.waitForResponse((r) => r.request().method() === method && pathPattern.test(new URL(r.url()).pathname));
  await itemForm(page).locator('button[type="submit"]').click();
  return (await answered).status();
}

/**
 * Presses the form's submit button and waits until the save request was answered (it must be accepted: hard) and the form
 * closed (soft: nothing after a save depends on it, and when the page keeps the form open because it noticed that the
 * category was not stored, the outcome assertions that follow should still say what was sent and what the database holds).
 */
async function save(page: Page, method: "PUT" | "POST"): Promise<void> {
  const status = await pressSave(page, method);
  expect(status, `the ${method} save request should be accepted by the (mock) API`).toBeLessThan(300);
  await soft(itemForm(page), "the form should close after a save that the API accepted and stored").toBeHidden();
}

/**
 * Waits until the page has finished reacting to the answer of a save: the "Saving…" label of the submit button is gone.
 * Needed before asserting that something did NOT happen (for example that the form did not close): without it such an
 * assertion could pass in the instant before the page reacts. The click handler has already set the saving state when
 * click() returns, so this cannot pass before the save started.
 */
async function waitUntilSaveSettled(page: Page): Promise<void> {
  await expect(page.locator("body")).not.toContainText(/Saving/, { useInnerText: true });
  // Two animation frames: whatever the page queued while handling the answer has been rendered.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/**
 * Every field of the row except the ones the test changed on purpose. Compared as a whole row so that a field nobody looked at
 * (notes, vendor URL, unit, photo, supplier order number, threshold, barcode, name) cannot be wiped or rewritten unnoticed.
 */
function expectOnlyTheseChanged(mock: MockApi, itemName: string, before: Medication, changed: ReadonlyArray<keyof Medication>, label: string): void {
  const restored = Object.fromEntries(changed.map((key) => [key, before[key]]));
  // `updated_at` moves with every save, so it is never part of the comparison.
  const expected: Medication = { ...dbRow(mock, itemName), ...restored, updated_at: before.updated_at };
  soft(expected, `database: ${label}: nothing but ${changed.join(" and ")} changed (name, barcode, unit, threshold, notes, vendor URL, photo, supplier number, ...)`).toEqual(before);
}

/** The things the owner cares about after a category was saved: the request, the database, the page right away and after a reload. */
async function expectCategorySaved(args: {
  page: Page;
  mock: MockApi;
  shape: IdShape;
  method: "PUT" | "POST";
  itemName: string;
  categoryName: string;
}): Promise<void> {
  const { page, mock, shape, method, itemName, categoryName } = args;
  const category = categoryNamed(mock, categoryName);

  // (1) what the page sent
  soft(
    sentCategory(savedBody(mock, method), shape),
    `${method} body: category_id must be the id of "${categoryName}" (${category.id}), not null or NaN`
  ).toBe(category.id);

  // (2) what the database holds
  soft(dbRow(mock, itemName).category_id, `database: "${itemName}" must hold the category "${categoryName}" after saving`).toBe(category.id);

  // (3) what the page shows right after saving, before any reload (the list must not wait for a refresh to show the new category)
  await soft(itemRow(page, itemName), `right after saving (no reload) the list row of "${itemName}" shows the category "${categoryName}"`).toContainText(
    categoryName,
    SETTLED
  );

  // (4) what the page shows after a reload, in the list and when the item is opened again
  await reloadAdmin(page, itemName);
  await soft(itemRow(page, itemName), `after a reload the list row of "${itemName}" shows the category "${categoryName}"`).toContainText(
    categoryName,
    SETTLED
  );
  await openEdit(page, itemName);
  await soft
    .poll(() => shownCategory(categoryField(page)), {
      message: `after a reload, opening "${itemName}" again selects the category "${categoryName}"`,
      ...SETTLED,
    })
    .toBe(categoryName);
}

// ── The proof ──────────────────────────────────────────────────────────────────────────────────────────────────────

for (const shape of SHAPES) {
  // uuid: the live schema (the shape of the bug). bigint: supabase/schema.sql, where the original page worked, which is
  // what makes the uuid failures specific to the id type and not a flaw of the test.
  test.describe(`category assignment with ${shape} category ids`, () => {
    test("picking a category for an item that has none sends the category id, stores it, and still shows it after a reload", async ({ page }) => {
      const mock = await installRichMockApi(page, shape);
      const before = { ...dbRow(mock, LEGACY_ITEM) };
      await openAdmin(page, LEGACY_ITEM);
      await openEdit(page, LEGACY_ITEM);
      await expectFormStartsOn(page, NONE);

      await chooseCategory(page, "First Aid");
      await save(page, "PUT");

      expectOnlyTheseChanged(mock, LEGACY_ITEM, before, ["category_id"], "picking a category");
      await expectCategorySaved({ page, mock, shape, method: "PUT", itemName: LEGACY_ITEM, categoryName: "First Aid" });
    });

    test("changing the category of a categorized item replaces it and does not leave the item without one", async ({ page }) => {
      const mock = await installRichMockApi(page, shape);
      const before = { ...dbRow(mock, PAIN_ITEM) };
      await openAdmin(page, PAIN_ITEM);
      await openEdit(page, PAIN_ITEM);
      await expectFormStartsOn(page, "Pain & Fever");

      await chooseCategory(page, "Antibiotics");
      await save(page, "PUT");

      expectOnlyTheseChanged(mock, PAIN_ITEM, before, ["category_id"], "changing the category");
      await expectCategorySaved({ page, mock, shape, method: "PUT", itemName: PAIN_ITEM, categoryName: "Antibiotics" });
      await soft(itemRow(page, PAIN_ITEM), "the item no longer shows its old category").not.toContainText("Pain & Fever", SETTLED);
    });

    test("editing only the stock of an item that already has a category keeps the category and every other field", async ({ page }) => {
      // The item has notes, a vendor URL, a unit, a photo and a supplier number, so losing any of them shows in the comparison below.
      const mock = await installRichMockApi(page, shape);
      const before = { ...dbRow(mock, PAIN_ITEM) };
      expect(
        [before.notes, before.vendor_url, before.photo_url, before.supplier_order_number, before.unit],
        "scenario check: the item starts with every optional field filled in"
      ).toEqual([PAIN_ITEM_EXTRAS.notes, PAIN_ITEM_EXTRAS.vendor_url, PAIN_ITEM_EXTRAS.photo_url, "0092", PAIN_ITEM_EXTRAS.unit]);
      const painCategory = categoryNamed(mock, "Pain & Fever");
      await openAdmin(page, PAIN_ITEM);
      await openEdit(page, PAIN_ITEM);
      await expectFormStartsOn(page, "Pain & Fever");

      await controlAfterLabel(page, /^Current Stock/, "input").fill("77");
      await save(page, "PUT");

      expectCategoryNotClearedByRequest(savedBody(mock, "PUT"), shape, painCategory.id, "stock-only edit");
      const after = dbRow(mock, PAIN_ITEM);
      soft(after.stock, "database: the new stock was saved").toBe(77);
      soft(after.category_id, "database: the category survived a stock-only edit").toBe(painCategory.id);
      expectOnlyTheseChanged(mock, PAIN_ITEM, before, ["stock"], "a stock-only edit");

      await reloadAdmin(page, PAIN_ITEM);
      await soft(itemRow(page, PAIN_ITEM), "after a reload the list row still shows the category").toContainText("Pain & Fever", SETTLED);
      await openEdit(page, PAIN_ITEM);
      await soft
        .poll(() => shownCategory(categoryField(page)), { message: "after a reload the form still selects the category", ...SETTLED })
        .toBe("Pain & Fever");
    });

    test("editing only the stock of a legacy item without a category saves it, keeps it uncategorized, and it stays editable", async ({ page }) => {
      const mock = await installRichMockApi(page, shape);
      const before = { ...dbRow(mock, LEGACY_ITEM) };
      await openAdmin(page, LEGACY_ITEM);
      await openEdit(page, LEGACY_ITEM);
      await expectFormStartsOn(page, NONE);

      await controlAfterLabel(page, /^Current Stock/, "input").fill("150");
      await save(page, "PUT");

      expectCategoryNotClearedByRequest(savedBody(mock, "PUT"), shape, null, "stock-only edit of a legacy item");
      const after = dbRow(mock, LEGACY_ITEM);
      soft(after.stock, "database: the new stock was saved").toBe(150);
      soft(after.category_id, "database: the legacy item is still uncategorized (null), not a broken value").toBeNull();
      expectOnlyTheseChanged(mock, LEGACY_ITEM, before, ["stock"], "a stock-only edit of a legacy item");

      await reloadAdmin(page, LEGACY_ITEM);
      await openEdit(page, LEGACY_ITEM);
      await soft
        .poll(() => shownCategory(categoryField(page)), { message: "the legacy item opens again and shows no category", ...SETTLED })
        .toBe(NONE);
    });

    test("choosing the empty category entry clears the category, and only the category (the control that proves the test is not blind)", async ({
      page,
    }) => {
      const mock = await installRichMockApi(page, shape);
      const before = { ...dbRow(mock, PAIN_ITEM) };
      await openAdmin(page, PAIN_ITEM);
      await openEdit(page, PAIN_ITEM);
      await expectFormStartsOn(page, "Pain & Fever");

      await chooseNoCategory(page);
      await save(page, "PUT");

      const after = dbRow(mock, PAIN_ITEM);
      soft(after.category_id, "database: the user asked for no category, so the item holds none").toBeNull();
      expectOnlyTheseChanged(mock, PAIN_ITEM, before, ["category_id"], "clearing the category");

      await reloadAdmin(page, PAIN_ITEM);
      await openEdit(page, PAIN_ITEM);
      await soft
        .poll(() => shownCategory(categoryField(page)), { message: "after a reload the item shows no category", ...SETTLED })
        .toBe(NONE);
    });

    test("creating a new item with a category sends the category id, stores it, and still shows it after a reload", async ({ page }) => {
      const mock = await installMockApi(page, { shape });
      await openAdmin(page, LEGACY_ITEM);
      await page.getByRole("button", { name: "+ Add Medication", exact: true }).click();
      await expect(categoryField(page)).toBeVisible();

      const form = itemForm(page);
      await form.getByPlaceholder("e.g. Ibuprofen 200mg", { exact: true }).fill(NEW_ITEM);
      await form.getByPlaceholder("e.g. 012345678901", { exact: true }).fill(NEW_ITEM_BARCODE);
      await chooseCategory(page, "First Aid");
      await save(page, "POST");

      await expectCategorySaved({ page, mock, shape, method: "POST", itemName: NEW_ITEM, categoryName: "First Aid" });
    });

    test("after picking a category the form keeps showing the pick and prints no stray NaN", async ({ page }) => {
      await installMockApi(page, { shape });
      await openAdmin(page, LEGACY_ITEM);
      await openEdit(page, LEGACY_ITEM);
      await expectFormStartsOn(page, NONE);

      await chooseCategory(page, "First Aid");

      await soft
        .poll(() => shownCategory(categoryField(page)), {
          message: 'the Category field keeps showing "First Aid" after the pick (it must not snap back to "no category")',
          ...SETTLED,
        })
        .toBe("First Aid");
      // Read after the settled state above, so this cannot pass merely because the page had not re-rendered yet. innerText, not
      // textContent: textContent glues a bare "NaN" to the next label ("NaNVendor URL"), where a word-boundary match fails.
      await soft(page.locator("body"), 'no stray "NaN" is rendered anywhere on the page after picking a category').not.toContainText(/NaN/, {
        ...SETTLED,
        useInnerText: true,
      });
    });

    test("with many categories (a long list) picking one still sends its id, stores it, and shows it after a reload", async ({ page }) => {
      const categories = manyCategories(shape);
      expect(categories.length, "the long-list scenario needs 11 or more categories").toBeGreaterThanOrEqual(11);
      const mock = await installRichMockApi(page, shape, { categories });
      const before = { ...dbRow(mock, LEGACY_ITEM) };
      await openAdmin(page, LEGACY_ITEM);
      await openEdit(page, LEGACY_ITEM);
      await expectFormStartsOn(page, NONE);
      // The control follows from the NUMBER of categories, not from the id shape: the uuid run asserts it, and the bigint twin stays a
      // clean control for the original page (which has no searchable list and still saves a bigint id correctly).
      if (shape === "uuid") await expectSearchableCategoryList(page, categories.length);

      await chooseCategory(page, "Respiratory");
      await save(page, "PUT");

      expectOnlyTheseChanged(mock, LEGACY_ITEM, before, ["category_id"], "picking a category from the long list");
      await expectCategorySaved({ page, mock, shape, method: "PUT", itemName: LEGACY_ITEM, categoryName: "Respiratory" });
    });
  });
}

test.describe("editing one field does not overwrite the others", () => {
  test("saving a note does not put back a stock count that changed while the form was open", async ({ page }) => {
    const mock = await installRichMockApi(page, "uuid");
    const before = { ...dbRow(mock, PAIN_ITEM) };
    const painCategory = categoryNamed(mock, "Pain & Fever");
    await openAdmin(page, PAIN_ITEM);
    await openEdit(page, PAIN_ITEM);
    await expectFormStartsOn(page, "Pain & Fever");

    // Meanwhile somebody dispenses from the Scan tab: the database now says 10, while the open form still says 18.
    dbRow(mock, PAIN_ITEM).stock = 10;
    await controlAfterLabel(page, /^Notes/, "textarea").fill("Keep below 25 C");
    await save(page, "PUT");

    const after = dbRow(mock, PAIN_ITEM);
    soft(after.notes, "database: the note was saved").toBe("Keep below 25 C");
    soft(after.stock, "database: the stock must stay at 10, the number set in the meantime, not go back to the 18 the open form was holding").toBe(10);
    soft(after.category_id, "database: the category survived a notes-only edit").toBe(painCategory.id);
    soft(
      after,
      "database: the row is the old one with the new note and the stock set in the meantime, nothing else (vendor URL, unit, photo, supplier number, ...)"
    ).toEqual({ ...before, notes: "Keep below 25 C", stock: 10, updated_at: after.updated_at });
  });
});

// What the owner lost trust over: a save that did not work looked as if it had. Three ways a save can fail to store the work, and
// in all three the page must (a) say so where it can be heard, (b) keep the form open with what the user chose and typed, (c) not
// use the words of a successful save. These are read only after the page finished reacting to the answer (waitUntilSaveSettled).
test.describe("a save that did not succeed", () => {
  const SERVER_ERROR = "Unexpected database error.";
  const TYPED_NOTE = "Replace the box when it is half empty";

  /** The user's work after a failed save: the form is still open with the pick and the note, and nothing says "Saved". */
  async function expectWorkKept(page: Page): Promise<void> {
    await soft(itemForm(page), "the form stays open: the save did not succeed, so the user's work must not be thrown away").toBeVisible(SETTLED);
    await soft
      .poll(() => shownCategory(categoryField(page)), { message: 'the form still shows the category the user picked ("First Aid")', ...SETTLED })
      .toBe("First Aid");
    await soft(controlAfterLabel(page, /^Notes/, "textarea"), "the form still holds the note the user typed").toHaveValue(TYPED_NOTE, SETTLED);
    await soft(page.locator("body"), "the page must not use the words of a successful save").not.toContainText(SUCCESS_WORDING, {
      ...SETTLED,
      useInnerText: true,
    });
  }

  /** Opens the legacy item, picks a category and types a note: the work that a failed save must not lose. */
  async function startEditing(page: Page, mock: MockApi): Promise<Medication> {
    const before = { ...dbRow(mock, LEGACY_ITEM) };
    await openAdmin(page, LEGACY_ITEM);
    await openEdit(page, LEGACY_ITEM);
    await expectFormStartsOn(page, NONE);
    await chooseCategory(page, "First Aid");
    await controlAfterLabel(page, /^Notes/, "textarea").fill(TYPED_NOTE);
    return before;
  }

  test("a save the server rejects (HTTP 500) shows its message as an alert, keeps the form open with the user's work, and stores nothing", async ({ page }) => {
    const mock = await installRichMockApi(page, "uuid");
    mock.failNext({ method: "PUT", path: SAVE_PUT, status: 500, body: { error: SERVER_ERROR } });
    const before = await startEditing(page, mock);

    expect(await pressSave(page, "PUT"), "scenario check: the server answered the save with HTTP 500").toBe(500);
    await waitUntilSaveSettled(page);

    await soft(page.locator("body"), `the server's message "${SERVER_ERROR}" is shown on the page`).toContainText(SERVER_ERROR, { ...SETTLED, useInnerText: true });
    await soft(
      page.getByRole("alert").filter({ hasText: SERVER_ERROR }),
      `the server's message is exposed as an alert (role="alert"), so it is announced and not only printed`
    ).toBeVisible(SETTLED);
    await expectWorkKept(page);
    soft(dbRow(mock, LEGACY_ITEM), "database: a failed save changed nothing").toEqual(before);
  });

  test("a save that cannot reach the server shows an alert that says so, keeps the form open with the user's work, and stores nothing", async ({ page }) => {
    const mock = await installRichMockApi(page, "uuid");
    mock.failNext({ method: "PUT", path: SAVE_PUT, networkError: true });
    const before = await startEditing(page, mock);

    // A network failure has no HTTP answer to wait for: wait for the request to fail instead.
    const failed = page.waitForEvent("requestfailed", (r) => r.method() === "PUT" && SAVE_PUT.test(new URL(r.url()).pathname));
    await itemForm(page).locator('button[type="submit"]').click();
    await failed;
    await waitUntilSaveSettled(page);

    await soft(
      page.getByRole("alert").filter({ hasText: /network|connect|reach|offline|internet/i }),
      'an alert says that the server could not be reached (role="alert", mentioning the connection)'
    ).toBeVisible(SETTLED);
    await expectWorkKept(page);
    soft(dbRow(mock, LEGACY_ITEM), "database: a save that never arrived changed nothing").toEqual(before);
  });

  // The original page answered a save that was accepted but did not store the category with "Medication updated." and closed the
  // form, which is why the owner lost trust: everything looked fine and the category was gone. Here the server answers 200 with
  // the row exactly as it still is.
  test("a save the server accepted (HTTP 200) without storing the category warns about it, keeps the form open with the user's work, and does not say it saved", async ({ page }) => {
    // A page could also close the form a moment AFTER it warned (a timer), and a check made at one instant cannot see that. The page's
    // clock is therefore installed (time still flows normally) and moved forward below, which fires every timer the page set while
    // it was handling the answer, without waiting for real time.
    await page.clock.install();
    const mock = await installRichMockApi(page, "uuid");
    await page.route(SAVE_PUT, async (route) => {
      if (route.request().method() !== "PUT") {
        await route.fallback();
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dbRow(mock, LEGACY_ITEM)) });
    });
    const before = await startEditing(page, mock);

    expect(await pressSave(page, "PUT"), "scenario check: the server accepts the save (HTTP 200) without storing the category").toBe(200);
    await waitUntilSaveSettled(page);

    soft(dbRow(mock, LEGACY_ITEM), "scenario check: the database really changed nothing").toEqual(before);
    // Positive evidence first: an alert that is about the category is on the page. It cannot be there "too early" the way an
    // absent form or an absent success message can.
    await soft(
      page.getByRole("alert").filter({ hasText: /category/i }),
      'an alert (role="alert") tells the user that the category was not stored'
    ).toBeVisible(SETTLED);
    await page.clock.runFor(5_000);
    await expectWorkKept(page);
    await soft(
      page.getByRole("alert").filter({ hasText: /category/i }),
      "the warning is still there after the page's timers have run (it must not clear itself or hand over to a success message)"
    ).toBeVisible(SETTLED);
  });
});

/** Six more categories on top of the six in the fixtures: 12 in all, which is a "long list" for the current page. */
function manyCategories(shape: IdShape): Category[] {
  const base = buildCategories(shape);
  const extraNames = ["Vaccines", "Eye Care", "Dental", "Diabetes Care", "Respiratory", "Women’s Health"];
  const extra = extraNames.map(
    (name, i): Category => ({ id: categoryId(base.length + i, shape), name, created_at: "2026-11-01T12:00:00+00:00" })
  );
  return [...base, ...extra];
}

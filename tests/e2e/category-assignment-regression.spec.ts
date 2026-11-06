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
// Verified result of the two runs (18 tests):
//   current UI  : 18 passed.
//   original UI : 7 failed, 11 passed. Failing: the five uuid tests that pick, change or create a category (or open the long
//                 list), which all show `category_id: null` in the request, `null` in the database and no category after a
//                 reload; the "pick" check (the dropdown snaps back to "no category" and the page prints "NaN"); the stale
//                 stock overwrite; and the accepted-but-not-stored save, which the original answers by closing the form and
//                 saying "Medication updated.". Passing on the original: the three uuid controls (a stock-only edit passes the
//                 untouched uuid string straight through, so it never hits Number(); choosing "no category" really clears it)
//                 and all eight bigint twins, because Number("3") is 3. That split is what pins the bug on the id type.
//
// How a failure is made trustworthy: everything the test needs in order to *reach* the behavior (the page loaded, the item is
// listed, the edit form opened, the form started on the item's real category, the save request was answered) is a hard
// assertion, so a broken harness or a changed layout fails loudly as "could not get there". The outcomes the owner cares
// about (what the save request carried, what the database holds, what the page shows after a reload) are SOFT assertions
// with messages in plain words, so one failing run lists every symptom instead of stopping at the first. Assertions that
// say something did NOT happen are only made after a settled state was observed, so they cannot pass before the page reacts.
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Category, Medication } from "@/lib/db";
import { installMockApi, type MockApi } from "./helpers/mock-api";
import { buildCategories, categoryId, type IdShape } from "../helpers/fixtures";

const SHAPES: readonly IdShape[] = ["uuid", "bigint"];

// Items from tests/helpers/fixtures.ts (synthetic): one that already has a category, one legacy row without any.
const PAIN_ITEM = "Ibuprofen 200 mg, tablets"; // category "Pain & Fever", stock 18, threshold 40
const LEGACY_ITEM = "Thermometer probe covers"; // no category, stock 200, threshold 50
const NEW_ITEM = "Sterile eye wash, 118 mL";
const NEW_ITEM_BARCODE = "0049000012345";

const SAVE_PUT = /\/api\/medications\/\d+$/;
const SAVE_POST = /\/api\/medications$/;

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
 * Waits for the item's row and checks that the locator found ONE row (one Edit button). Row-text assertions below are only
 * meaningful when the locator did not resolve to a bigger container that happens to hold other items' text too.
 */
async function expectOneRowFor(page: Page, itemName: string): Promise<void> {
  // The generous timeout covers a cold compile of /admin on the dev server.
  await expect(itemRow(page, itemName)).toBeVisible({ timeout: 30_000 });
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

/** The three things the owner cares about after a category was saved: the request, the database, the page after a reload. */
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

  // (3) what the page shows after a reload, in the list and when the item is opened again
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
      const mock = await installMockApi(page, { shape });
      await openAdmin(page, LEGACY_ITEM);
      await openEdit(page, LEGACY_ITEM);
      await expectFormStartsOn(page, NONE);

      await chooseCategory(page, "First Aid");
      await save(page, "PUT");

      await expectCategorySaved({ page, mock, shape, method: "PUT", itemName: LEGACY_ITEM, categoryName: "First Aid" });
    });

    test("changing the category of a categorized item replaces it and does not leave the item without one", async ({ page }) => {
      const mock = await installMockApi(page, { shape });
      await openAdmin(page, PAIN_ITEM);
      await openEdit(page, PAIN_ITEM);
      await expectFormStartsOn(page, "Pain & Fever");

      await chooseCategory(page, "Antibiotics");
      await save(page, "PUT");

      await expectCategorySaved({ page, mock, shape, method: "PUT", itemName: PAIN_ITEM, categoryName: "Antibiotics" });
      await soft(itemRow(page, PAIN_ITEM), "the item no longer shows its old category").not.toContainText("Pain & Fever", SETTLED);
    });

    test("editing only the stock of an item that already has a category keeps the category and every other field", async ({ page }) => {
      const mock = await installMockApi(page, { shape });
      const before = { ...dbRow(mock, PAIN_ITEM) };
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
      soft(
        { ...after, stock: before.stock, updated_at: before.updated_at },
        "database: nothing except the stock changed (name, barcode, unit, threshold, notes, supplier number, category)"
      ).toEqual(before);

      await reloadAdmin(page, PAIN_ITEM);
      await soft(itemRow(page, PAIN_ITEM), "after a reload the list row still shows the category").toContainText("Pain & Fever", SETTLED);
      await openEdit(page, PAIN_ITEM);
      await soft
        .poll(() => shownCategory(categoryField(page)), { message: "after a reload the form still selects the category", ...SETTLED })
        .toBe("Pain & Fever");
    });

    test("editing only the stock of a legacy item without a category saves it, keeps it uncategorized, and it stays editable", async ({ page }) => {
      const mock = await installMockApi(page, { shape });
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
      soft({ ...after, stock: before.stock, updated_at: before.updated_at }, "database: nothing except the stock changed").toEqual(before);

      await reloadAdmin(page, LEGACY_ITEM);
      await openEdit(page, LEGACY_ITEM);
      await soft
        .poll(() => shownCategory(categoryField(page)), { message: "the legacy item opens again and shows no category", ...SETTLED })
        .toBe(NONE);
    });

    test("choosing the empty category entry clears the category, and only the category (the control that proves the test is not blind)", async ({
      page,
    }) => {
      const mock = await installMockApi(page, { shape });
      const before = { ...dbRow(mock, PAIN_ITEM) };
      await openAdmin(page, PAIN_ITEM);
      await openEdit(page, PAIN_ITEM);
      await expectFormStartsOn(page, "Pain & Fever");

      await chooseNoCategory(page);
      await save(page, "PUT");

      const after = dbRow(mock, PAIN_ITEM);
      soft(after.category_id, "database: the user asked for no category, so the item holds none").toBeNull();
      soft({ ...after, category_id: before.category_id, updated_at: before.updated_at }, "database: nothing except the category changed").toEqual(
        before
      );

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
      const mock = await installMockApi(page, { shape, categories });
      await openAdmin(page, LEGACY_ITEM);
      await openEdit(page, LEGACY_ITEM);
      await expectFormStartsOn(page, NONE);

      await chooseCategory(page, "Respiratory");
      await save(page, "PUT");

      await expectCategorySaved({ page, mock, shape, method: "PUT", itemName: LEGACY_ITEM, categoryName: "Respiratory" });
    });
  });
}

test.describe("editing one field does not overwrite the others", () => {
  test("saving a note does not put back a stock count that changed while the form was open", async ({ page }) => {
    const mock = await installMockApi(page, { shape: "uuid" });
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
  });
});

test.describe("a save the server accepted but did not store", () => {
  // The original page answered such a save with "Medication updated." and closed the form, which is why the owner lost trust:
  // everything looked fine and the category was gone. Here the server answers 200 with the row exactly as it still is.
  test("the page does not treat the save as finished: the form stays open with the user's changes", async ({ page }) => {
    const mock = await installMockApi(page, { shape: "uuid" });
    await page.route(SAVE_PUT, async (route) => {
      if (route.request().method() !== "PUT") {
        await route.fallback();
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dbRow(mock, LEGACY_ITEM)) });
    });

    await openAdmin(page, LEGACY_ITEM);
    await openEdit(page, LEGACY_ITEM);
    await expectFormStartsOn(page, NONE);
    await chooseCategory(page, "First Aid");

    expect(await pressSave(page, "PUT"), "the server accepts the save (HTTP 200) without storing the category").toBe(200);
    await waitUntilSaveSettled(page);

    expect(dbRow(mock, LEGACY_ITEM).category_id, "scenario check: the database really holds no category").toBeNull();
    await soft(
      itemForm(page),
      "the form stays open: the category the user picked was not stored, so the page must not act as if the save was complete"
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

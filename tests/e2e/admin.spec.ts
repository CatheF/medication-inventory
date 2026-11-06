// Browser tests of the Admin page (/admin): adding and editing items, categories, the supplier order number, honest
// error handling, the list and its filters, keyboard use and the phone layout.
//
// Every /api/* call is answered by tests/e2e/helpers/mock-api.ts, so no database is involved; the mock keeps the "database"
// in memory and the tests read it back (api.medications / api.categories) to prove what was really stored. Each test
// starts from fresh synthetic data (tests/helpers/fixtures.ts) and does not depend on any other test.
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Category, Medication } from "@/lib/db";
import {
  CATEGORY_NAMES,
  TRICKY_SUPPLIER_NUMBERS,
  buildCategories,
  buildManyMedications,
  buildMedications,
  categoryId,
  fakeUuid,
  type IdShape,
} from "../helpers/fixtures";
import { installMockApi } from "./helpers/mock-api";
import {
  POST_ITEM,
  PUT_ITEM,
  SLOW_MS,
  adminRowIdsInOrder,
  categoryChoices,
  chooseCategory,
  chosenAdminFilter,
  chosenCategory,
  dispenseFromAnotherScreen,
  expectNoHorizontalScroll,
  expectOrderSheetUntouched,
  expectReadableInFull,
  fillItemForm,
  filterAdminByCategory,
  gotoAdmin,
  focusedElement,
  hasVisibleFocusIndicator,
  lastBody,
  openAdmin,
  openEditForm,
  openNewItemForm,
  parseCounts,
  pasteInto,
  saveItem,
  serverIgnoresFields,
  stored,
  storedByBarcode,
  visibleItemIds,
  watchRuntimeErrors,
  writes,
} from "./helpers/admin-page";

test.describe.configure({ timeout: SLOW_MS * 2 });

const SHAPES: readonly IdShape[] = ["uuid", "bigint"];

const PAIN_AND_FEVER = CATEGORY_NAMES[0];
const ANTIBIOTICS = CATEGORY_NAMES[2];
const UNCATEGORIZED = "— Uncategorized —";
const CREATE_NEW = "+ Create new category…";

// Seed items by name, so no test depends on how the fixtures are numbered.
const ACETAMINOPHEN = "Acetaminophen 500 mg"; // Pain & Fever, supplier 00417-B
const IBUPROFEN = "Ibuprofen 200 mg"; // Pain & Fever, supplier 0092, stock 18
const ASPIRIN = "Aspirin 81 mg"; // Pain & Fever, no supplier order number
const AMOXICILLIN = "Amoxicillin 500 mg"; // Antibiotics, supplier AMX-500
const THERMOMETER_COVERS = "Thermometer probe covers"; // legacy item: no category, no supplier number

/** Tiny inline pictures (data URLs load without a network): one for an item's photo, one that "another screen" replaces it with. */
const svgPhoto = (fill: string): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${fill}"/></svg>`)}`;
const PHOTO_ORIGINAL = svgPhoto("#94a3b8");
const PHOTO_ELSEWHERE = svgPhoto("#0ea5e9");

function seedItem(namePrefix: string, shape: IdShape = "uuid"): Medication {
  const found = buildMedications({ shape }).find((m) => m.name?.startsWith(namePrefix));
  if (!found) throw new Error(`No seed item starts with "${namePrefix}".`);
  return found;
}

/** Adds an item through the form and waits for the "Saved" message. Returns nothing: read the mock database for the result. */
async function createItem(page: Page, fields: Parameters<typeof fillItemForm>[1]): Promise<void> {
  await openNewItemForm(page);
  await fillItemForm(page, fields);
  await saveItem(page);
  await expect(page.getByTestId("admin-success")).toBeVisible();
}

/** Reloads the page (the mock database survives) and waits for the list. */
async function reloadAdmin(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("admin-summary")).toBeVisible({ timeout: SLOW_MS });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 1. The category survives create and edit
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe("Admin: the category survives create and edit", () => {
  for (const shape of SHAPES) {
    test(`creating an item with a category and supplier order number 00417-B stores both and lists them (${shape} ids)`, async ({ page }) => {
      const problems = watchRuntimeErrors(page);
      const api = await openAdmin(page, { shape });

      await createItem(page, {
        name: "Test syrup, 100 mL",
        barcode: "0099001122",
        supplier: "00417-B",
        category: ANTIBIOTICS,
        unit: "bottles",
        stock: "7",
        threshold: "3",
        vendorUrl: "https://supplier.example/syrup",
        notes: "Shake well before use",
      });

      // What the person is told
      const success = page.getByTestId("admin-success");
      await expect(success).toHaveAttribute("role", "status");
      await expect(success).toContainText("Test syrup, 100 mL");
      await expect(success).toContainText("Saved. Category: Antibiotics · Supplier order no.: 00417-B");

      // What was sent: the id as text (never a number, never null) and the codes exactly as typed
      const body = lastBody(api, "POST", POST_ITEM);
      expect(body.category_id).toBe(categoryId(2, shape));
      expect(typeof body.category_id).toBe("string");
      expect(body.supplier_order_number).toBe("00417-B");
      expect(body.barcode).toBe("0099001122");

      // What was stored: exactly what was typed. Not a different stock (a stray stock movement would change it), nothing dropped.
      const created = storedByBarcode(api, "0099001122");
      expect(created).toMatchObject({
        name: "Test syrup, 100 mL",
        barcode: "0099001122",
        supplier_order_number: "00417-B",
        category_id: categoryId(2, shape),
        unit: "bottles",
        stock: 7,
        threshold: 3,
        vendor_url: "https://supplier.example/syrup",
        notes: "Shake well before use",
        photo_url: null,
        is_unnamed: false,
      });

      // Creating an item is ONE write: no stock movement, no upload, no export, and nothing lands on the order sheet by itself
      expect(writes(api)).toEqual(["POST /api/medications"]);
      await expectOrderSheetUntouched(page, "after creating an item");

      // What the list shows
      await expect(page.getByTestId(`admin-row-${created.id}`)).toContainText("Test syrup, 100 mL");
      await expect(page.getByTestId(`admin-category-${created.id}`)).toContainText("Antibiotics");
      await expect(page.getByTestId(`admin-supplier-${created.id}`)).toContainText("00417-B");
      await expect(page.getByTestId(`admin-barcode-${created.id}`)).toContainText("0099001122");
      await expect(page.locator("body")).not.toContainText("NaN");
      expect(problems).toEqual([]);
    });

    test(`a category picked when creating an item is still selected after a reload and after reopening the item (${shape} ids)`, async ({ page }) => {
      const api = await openAdmin(page, { shape });
      await createItem(page, { name: "Reload check item", barcode: "0099001123", supplier: "00417-B", category: ANTIBIOTICS, stock: "5", threshold: "2" });
      const created = storedByBarcode(api, "0099001123");
      expect(created).toMatchObject({ name: "Reload check item", supplier_order_number: "00417-B", category_id: categoryId(2, shape), stock: 5, threshold: 2 });
      expect(writes(api)).toEqual(["POST /api/medications"]);

      await reloadAdmin(page);
      await expect(page.getByTestId(`admin-category-${created.id}`)).toContainText("Antibiotics");

      await openEditForm(page, created.id);
      expect(await chosenCategory(page)).toBe("Antibiotics");
      await expect(page.getByTestId("supplier-order-number-input")).toHaveValue("00417-B");
      await expect(page.getByTestId("barcode-input")).toHaveValue("0099001123");
    });

    test(`changing the category while editing persists in the database, in the list and after a reload (${shape} ids)`, async ({ page }) => {
      const item = seedItem(ACETAMINOPHEN, shape);
      const api = await openAdmin(page, { shape });
      expect(item.category_id).toBe(categoryId(0, shape));

      await openEditForm(page, item.id);
      expect(await chosenCategory(page)).toBe(PAIN_AND_FEVER); // the form starts from the saved category
      await chooseCategory(page, ANTIBIOTICS);
      await saveItem(page);

      await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Antibiotics · Supplier order no.: 00417-B");
      const body = lastBody(api, "PUT", PUT_ITEM(item.id));
      expect(body.category_id).toBe(categoryId(2, shape));
      expect(typeof body.category_id).toBe("string");
      expect(stored(api, item.id).category_id).toBe(categoryId(2, shape));
      await expect(page.getByTestId(`admin-category-${item.id}`)).toContainText("Antibiotics");
      await expect(page.getByTestId(`admin-category-${item.id}`)).not.toContainText(PAIN_AND_FEVER);
      expect(writes(api)).toEqual([`PUT /api/medications/${item.id}`]);
      await expectOrderSheetUntouched(page, "after changing a category");

      await reloadAdmin(page);
      await openEditForm(page, item.id);
      expect(await chosenCategory(page)).toBe("Antibiotics");
    });
  }

  test("editing only the name keeps the category, the supplier order number and every other field of the item", async ({ page }) => {
    const item = seedItem(IBUPROFEN);
    const api = await openAdmin(page, {
      medications: buildMedications().map((m) =>
        m.id === item.id
          ? { ...m, notes: "Keep in the blue cabinet", vendor_url: "https://supplier.example/ibuprofen", unit: "bottles", photo_url: PHOTO_ORIGINAL }
          : m
      ),
    });
    const before = { ...stored(api, item.id) };
    expect(before.photo_url).toBe(PHOTO_ORIGINAL);

    await openEditForm(page, item.id);
    await fillItemForm(page, { name: "Ibuprofen 200 mg, tablets (store brand)" });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Pain & Fever · Supplier order no.: 0092");

    const after = stored(api, item.id);
    expect(after.name).toBe("Ibuprofen 200 mg, tablets (store brand)");
    expect({ ...after, name: before.name, updated_at: before.updated_at, is_unnamed: before.is_unnamed }).toEqual(before);
    expect(after.category_id).toBe(categoryId(0));
    expect(after.supplier_order_number).toBe("0092");

    // An untouched supplier field is not sent at all: that is what keeps saving possible before the database migration.
    expect("supplier_order_number" in lastBody(api, "PUT", PUT_ITEM(item.id))).toBe(false);
    // The save changed this one item and nothing else: no stock movement, no export, no upload.
    expect(writes(api)).toEqual([`PUT /api/medications/${item.id}`]);
    await expectOrderSheetUntouched(page, "after an edit");
  });

  test("values that changed on another screen while the form was open are not overwritten by an unrelated edit", async ({ page }) => {
    const item = seedItem(IBUPROFEN);
    expect(item.stock).toBe(18);
    const api = await openAdmin(page);

    await openEditForm(page, item.id); // the form now holds stock 18 and supplier 0092
    expect(await dispenseFromAnotherScreen(page, item.id, 7)).toBe(201); // someone scans a dispense: stock is 11
    stored(api, item.id).supplier_order_number = "ZZ-7"; // and someone else corrects the supplier number
    expect(stored(api, item.id).stock).toBe(11);

    await fillItemForm(page, { notes: "Checked on the shelf" });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toBeVisible();

    const after = stored(api, item.id);
    expect(after.notes).toBe("Checked on the shelf");
    expect(after.stock).toBe(11); // not rolled back to the stale 18
    expect(after.supplier_order_number).toBe("ZZ-7"); // not rolled back to the stale 0092
    expect(after.category_id).toBe(categoryId(0));
  });

  // Requirement: editing one field must not overwrite the item's other data. Each field is edited ALONE on a form that was opened
  // BEFORE another screen changed every other field: only the edited field may differ from what the database held at that moment.
  // (The category has its own twin tests in category-assignment-regression.spec.ts: it is sent only when the person changed it.)
  const CHANGED_ELSEWHERE = {
    name: "Ibuprofen 200 mg (renamed on another screen)",
    barcode: "0066778899",
    unit: "strips",
    threshold: 33,
    vendor_url: "https://supplier.example/changed-elsewhere",
    notes: "Written on another screen",
    supplier_order_number: "ZZ-7",
    photo_url: PHOTO_ELSEWHERE,
  } satisfies Partial<Medication>;

  const SINGLE_FIELD_EDITS: ReadonlyArray<{ title: string; typed: Parameters<typeof fillItemForm>[1]; changes: Partial<Medication> }> = [
    { title: "name", typed: { name: "Typed name" }, changes: { name: "Typed name" } },
    { title: "barcode", typed: { barcode: "0044556677" }, changes: { barcode: "0044556677" } },
    { title: "unit", typed: { unit: "boxes" }, changes: { unit: "boxes" } },
    { title: "low-stock threshold", typed: { threshold: "45" }, changes: { threshold: 45 } },
    { title: "vendor URL", typed: { vendorUrl: "https://supplier.example/typed" }, changes: { vendor_url: "https://supplier.example/typed" } },
    { title: "notes", typed: { notes: "Typed note" }, changes: { notes: "Typed note" } },
    { title: "supplier order number", typed: { supplier: "TYPED-1" }, changes: { supplier_order_number: "TYPED-1" } },
    { title: "stock", typed: { stock: "77" }, changes: { stock: 77 } },
    { title: "category", typed: { category: ANTIBIOTICS }, changes: { category_id: categoryId(2) } },
  ];

  for (const edit of SINGLE_FIELD_EDITS) {
    test(`editing only the ${edit.title} keeps every other field as it is now, including what another screen changed while the form was open`, async ({ page }) => {
      const item = seedItem(IBUPROFEN);
      const api = await openAdmin(page, {
        medications: buildMedications().map((m) =>
          m.id === item.id
            ? { ...m, photo_url: PHOTO_ORIGINAL, vendor_url: "https://supplier.example/ibuprofen", notes: "Keep in the blue cabinet", unit: "bottles" }
            : m
        ),
      });
      await openEditForm(page, item.id); // the form now holds the original values

      // Another screen changes everything except what the person is about to edit (stock through a real dispense)
      const edited = Object.keys(edit.changes);
      for (const [key, value] of Object.entries(CHANGED_ELSEWHERE)) {
        if (!edited.includes(key)) Object.assign(stored(api, item.id), { [key]: value });
      }
      const dispensedElsewhere = !edited.includes("stock");
      if (dispensedElsewhere) expect(await dispenseFromAnotherScreen(page, item.id, 7)).toBe(201);
      const elsewhere = { ...stored(api, item.id) };
      expect(elsewhere.stock).toBe(dispensedElsewhere ? 11 : 18);

      await fillItemForm(page, edit.typed);
      await saveItem(page);
      await expect(page.getByTestId("admin-success")).toBeVisible();

      // The database holds what another screen left there, plus the one thing that was edited. Nothing else moved.
      expect({ ...stored(api, item.id), updated_at: "" }).toEqual({ ...elsewhere, ...edit.changes, is_unnamed: false, updated_at: "" });
      expect(writes(api)).toEqual([...(dispensedElsewhere ? ["POST /api/transactions"] : []), `PUT /api/medications/${item.id}`]);
      await expectOrderSheetUntouched(page, `after editing only the ${edit.title}`);
    });
  }

  test("a new item saved without choosing a category is stored without one: the form starts on Uncategorized and remembers nothing from earlier items", async ({ page }) => {
    const api = await openAdmin(page);
    await openNewItemForm(page);
    expect(await chosenCategory(page), "nothing is pre-selected on the very first open").toBe(UNCATEGORIZED);

    await fillItemForm(page, { name: "Plain gauze roll", barcode: "0099001140" });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Uncategorized · Supplier order no.: Not set");
    expect(lastBody(api, "POST", POST_ITEM).category_id).toBeNull(); // an explicit "no category", not a guess
    const plain = storedByBarcode(api, "0099001140");
    expect(plain.category_id).toBeNull();
    await expect(page.getByTestId(`admin-category-${plain.id}`)).toContainText("Uncategorized");

    // An item that DOES get a category does not make the next new-item form pick that category as well
    await createItem(page, { name: "Plain syrup", barcode: "0099001141", category: ANTIBIOTICS });
    expect(storedByBarcode(api, "0099001141").category_id).toBe(categoryId(2));
    await openNewItemForm(page);
    expect(await chosenCategory(page)).toBe(UNCATEGORIZED);
    await fillItemForm(page, { name: "Plain tape", barcode: "0099001142" });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Uncategorized");
    expect(storedByBarcode(api, "0099001142").category_id).toBeNull();
  });

  test("an item without a category (legacy) is listed, opens as Uncategorized and can be edited without gaining or losing a category", async ({ page }) => {
    const item = seedItem(THERMOMETER_COVERS);
    expect(item.category_id).toBeNull();
    const api = await openAdmin(page);

    await expect(page.getByTestId(`admin-row-${item.id}`)).toBeVisible();
    await expect(page.getByTestId(`admin-category-${item.id}`)).toContainText("Uncategorized");

    await openEditForm(page, item.id);
    expect(await chosenCategory(page)).toBe(UNCATEGORIZED);
    await fillItemForm(page, { notes: "Fits the standard probe." });
    await saveItem(page);

    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Uncategorized · Supplier order no.: Not set");
    expect(lastBody(api, "PUT", PUT_ITEM(item.id))).toEqual({ notes: "Fits the standard probe." }); // the category was not touched, so it is not sent
    expect(stored(api, item.id).category_id).toBeNull();
    expect(stored(api, item.id).notes).toBe("Fits the standard probe.");
    await expect(page.getByTestId(`admin-category-${item.id}`)).toContainText("Uncategorized");
    await expect(page.locator("body")).not.toContainText("NaN");
    expect(writes(api)).toEqual([`PUT /api/medications/${item.id}`]);
  });

  test("choosing Uncategorized saves an explicit 'no category' that survives a reload", async ({ page }) => {
    const item = seedItem(ASPIRIN);
    const api = await openAdmin(page);

    await openEditForm(page, item.id);
    expect(await chosenCategory(page)).toBe(PAIN_AND_FEVER);
    await chooseCategory(page, UNCATEGORIZED);
    await saveItem(page);

    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Uncategorized");
    expect(lastBody(api, "PUT", PUT_ITEM(item.id)).category_id).toBeNull();
    expect(stored(api, item.id).category_id).toBeNull();
    expect(writes(api)).toEqual([`PUT /api/medications/${item.id}`]);

    await reloadAdmin(page);
    await expect(page.getByTestId(`admin-category-${item.id}`)).toContainText("Uncategorized");
    await openEditForm(page, item.id);
    expect(await chosenCategory(page)).toBe(UNCATEGORIZED);
  });

  test("the category field offers Uncategorized first, then every category by name, then the create command last", async ({ page }) => {
    await openAdmin(page);
    await openNewItemForm(page);
    const choices = await categoryChoices(page);

    expect(choices[0]).toBe(UNCATEGORIZED);
    expect(choices.at(-1)).toBe(CREATE_NEW);
    expect(choices.slice(1, -1)).toEqual([...CATEGORY_NAMES].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })));
    expect(choices.join(" ")).not.toContain("NaN");
    await expect(page.getByTestId("admin-form")).toContainText("Used to group this item on the Inventory tab.");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 1b. A save sends only what the person changed ("Editing another field does not clear the category or overwrite unrelated
//     item data"). Sending the category with every save would put back the category a form was opened with, whatever
//     another person had set in the meantime.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe("Admin: a save sends only what the person changed", () => {
  for (const shape of SHAPES) {
    test(`editing only the notes sends only the notes: a category that another person set while the form was open stays (${shape} ids)`, async ({ page }) => {
      const item = seedItem(IBUPROFEN, shape); // Pain & Fever, supplier 0092, stock 18
      const api = await openAdmin(page, { shape });
      await openEditForm(page, item.id); // the form now holds Pain & Fever and stock 18
      expect(await chosenCategory(page)).toBe(PAIN_AND_FEVER);

      // Someone else files the item under Antibiotics, and a dispense on the Scan tab takes the stock down to 7
      stored(api, item.id).category_id = categoryId(2, shape);
      expect(await dispenseFromAnotherScreen(page, item.id, 11)).toBe(201);
      expect(stored(api, item.id)).toMatchObject({ category_id: categoryId(2, shape), stock: 7 });

      await fillItemForm(page, { notes: "Checked on the shelf" });
      await saveItem(page);

      // The page reports the item as it is stored now: Antibiotics, not the category the form was opened with
      const success = page.getByTestId("admin-success");
      await expect(success).toContainText("Saved. Category: Antibiotics · Supplier order no.: 0092");
      await expect(page.getByTestId("admin-error")).toHaveCount(0);
      expect(lastBody(api, "PUT", PUT_ITEM(item.id))).toEqual({ notes: "Checked on the shelf" });
      expect(stored(api, item.id)).toMatchObject({ notes: "Checked on the shelf", category_id: categoryId(2, shape), stock: 7, supplier_order_number: "0092" });
      await expect(page.getByTestId(`admin-category-${item.id}`)).toContainText("Antibiotics");
      await expect(page.getByTestId(`admin-category-${item.id}`)).not.toContainText(PAIN_AND_FEVER);
      expect(writes(api)).toEqual(["POST /api/transactions", `PUT /api/medications/${item.id}`]);

      await reloadAdmin(page);
      await openEditForm(page, item.id);
      expect(await chosenCategory(page)).toBe(ANTIBIOTICS);
    });

    test(`the category is sent when the person changes it, as the id text, and the other fields are left out (${shape} ids)`, async ({ page }) => {
      const item = seedItem(ACETAMINOPHEN, shape);
      const api = await openAdmin(page, { shape });
      await openEditForm(page, item.id);
      await chooseCategory(page, ANTIBIOTICS);
      await saveItem(page);

      await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Antibiotics");
      expect(lastBody(api, "PUT", PUT_ITEM(item.id))).toEqual({ category_id: categoryId(2, shape) });
      expect(stored(api, item.id).category_id).toBe(categoryId(2, shape));
    });

    test(`choosing Uncategorized sends an explicit null that clears the category, and sends nothing else (${shape} ids)`, async ({ page }) => {
      const item = seedItem(ACETAMINOPHEN, shape);
      const api = await openAdmin(page, { shape });
      await openEditForm(page, item.id);
      await chooseCategory(page, UNCATEGORIZED);
      await saveItem(page);

      await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Uncategorized · Supplier order no.: 00417-B");
      expect(lastBody(api, "PUT", PUT_ITEM(item.id))).toEqual({ category_id: null });
      expect(stored(api, item.id).category_id).toBeNull();

      await reloadAdmin(page);
      await expect(page.getByTestId(`admin-category-${item.id}`)).toContainText("Uncategorized");
    });
  }

  test("an item that has no category stays without one when another field is edited: the save carries no category at all", async ({ page }) => {
    const item = seedItem(THERMOMETER_COVERS);
    expect(item.category_id).toBeNull();
    const api = await openAdmin(page);
    await openEditForm(page, item.id);
    await fillItemForm(page, { notes: "Fits the standard probe." });
    await saveItem(page);

    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Uncategorized");
    expect(lastBody(api, "PUT", PUT_ITEM(item.id))).toEqual({ notes: "Fits the standard probe." });
    expect(stored(api, item.id).category_id).toBeNull();
  });

  test("a save that changes nothing sends nothing: it says 'No changes to save.', keeps the form open and puts the keyboard focus on the message", async ({ page }) => {
    const item = seedItem(IBUPROFEN);
    const api = await openAdmin(page);
    const before = { ...stored(api, item.id) };
    await openEditForm(page, item.id);
    await saveItem(page);

    const info = page.getByTestId("admin-info");
    await expect(info).toContainText("No changes to save.");
    await expect(info).toHaveAttribute("role", "status");
    await expect(info).toBeFocused();
    await expect(page.getByTestId("admin-success")).toHaveCount(0);
    await expect(page.getByTestId("admin-error")).toHaveCount(0);
    await expect(page.getByTestId(`admin-saved-${item.id}`)).toHaveCount(0);
    await expect(page.getByTestId("admin-form")).toBeVisible();
    expect(writes(api)).toEqual([]); // not even a request that repeats what is already stored
    expect(stored(api, item.id)).toEqual(before);

    // The message belongs to the form as it was: the moment something is typed it goes, and the save then works normally
    await fillItemForm(page, { notes: "Now there is something to save" });
    await expect(info).toHaveCount(0);
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Pain & Fever");
    expect(lastBody(api, "PUT", PUT_ITEM(item.id))).toEqual({ notes: "Now there is something to save" });
    expect(writes(api)).toEqual([`PUT /api/medications/${item.id}`]);
  });

  test("typing the same values again, or the same values with spaces around them, counts as no change", async ({ page }) => {
    const item = seedItem(IBUPROFEN);
    expect(item).toMatchObject({ supplier_order_number: "0092", threshold: 40, unit: "units" });
    const api = await openAdmin(page);
    await openEditForm(page, item.id);
    await fillItemForm(page, { name: `  ${item.name}  `, supplier: " 0092 ", threshold: "40", unit: " units ", stock: String(item.stock) });
    await saveItem(page);

    await expect(page.getByTestId("admin-info")).toContainText("No changes to save.");
    expect(writes(api)).toEqual([]);
    expect(stored(api, item.id).name).toBe(item.name);
  });

  test("an unnamed item can be completed with nothing else changed: the save carries only its empty name, marks it reviewed and changes nothing else", async ({ page }) => {
    const unnamed = buildMedications().find((m) => m.is_unnamed);
    if (!unnamed) throw new Error("the fixtures have no unnamed item");
    const api = await openAdmin(page);
    const before = { ...stored(api, unnamed.id) };
    expect(before).toMatchObject({ name: null, is_unnamed: true, category_id: null, stock: 0 });

    await page.getByTestId(`admin-complete-${unnamed.id}`).click();
    await expect(page.getByRole("heading", { name: `Complete unnamed item: ${unnamed.barcode}` })).toBeFocused();
    await saveItem(page);

    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Uncategorized · Supplier order no.: Not set");
    await expect(page.getByTestId("admin-info")).toHaveCount(0); // it is a save, not "no changes"
    expect(lastBody(api, "PUT", PUT_ITEM(unnamed.id))).toEqual({ name: null });
    const after = stored(api, unnamed.id);
    expect(after.is_unnamed).toBe(false); // the save is the review
    expect({ ...after, is_unnamed: before.is_unnamed, updated_at: before.updated_at }).toEqual(before);
    await expect(page.getByTestId("admin-unnamed-section")).toHaveCount(0);
    await expect(page.getByTestId(`admin-row-${unnamed.id}`)).not.toContainText("Needs review");
    expect(writes(api)).toEqual([`PUT /api/medications/${unnamed.id}`]);
  });

  test("an unnamed item that only gets a category is saved with just that category", async ({ page }) => {
    const unnamed = buildMedications().find((m) => m.is_unnamed);
    if (!unnamed) throw new Error("the fixtures have no unnamed item");
    const api = await openAdmin(page);
    await page.getByTestId(`admin-complete-${unnamed.id}`).click();
    await chooseCategory(page, ANTIBIOTICS);
    await saveItem(page);

    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Antibiotics");
    expect(lastBody(api, "PUT", PUT_ITEM(unnamed.id))).toEqual({ category_id: categoryId(2) });
    expect(stored(api, unnamed.id)).toMatchObject({ name: null, is_unnamed: false, category_id: categoryId(2) });
  });

  test("'No changes to save.' goes away as soon as the form changes: by choosing another category, and by creating one", async ({ page }) => {
    const item = seedItem(IBUPROFEN);
    const api = await openAdmin(page);
    await openEditForm(page, item.id);
    const info = page.getByTestId("admin-info");

    await saveItem(page);
    await expect(info).toContainText("No changes to save.");
    await chooseCategory(page, ANTIBIOTICS);
    await expect(info).toHaveCount(0); // the message described the form as it was

    // Back on the category the item holds, the form is "as stored" again: saving says so again
    await chooseCategory(page, PAIN_AND_FEVER);
    await saveItem(page);
    await expect(info).toContainText("No changes to save.");
    expect(writes(api)).toEqual([]);

    // Creating a category inline changes the form as well (it selects the new category)
    await chooseCategory(page, CREATE_NEW);
    await page.getByTestId("new-category-input").fill("Vaccines");
    await page.getByTestId("new-category-save").click();
    await expect(page.getByTestId("category-note")).toContainText("was created and selected");
    await expect(info).toHaveCount(0);
    expect(writes(api)).toEqual(["POST /api/categories"]); // the category exists now; the item itself has not been saved

    await saveItem(page);
    const vaccines = api.categories.find((c) => c.name === "Vaccines");
    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Vaccines");
    expect(lastBody(api, "PUT", PUT_ITEM(item.id))).toEqual({ category_id: vaccines?.id });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 2. The supplier order number
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe("Admin: the supplier order number", () => {
  for (const code of ["00417-B", "0092", "AX-1182/4", "Ab-12c/9"]) {
    test(`the supplier order number ${code} comes back exactly as typed after saving and reloading`, async ({ page }) => {
      const item = seedItem(ASPIRIN); // starts without a supplier order number
      expect(item.supplier_order_number).toBeNull();
      const api = await openAdmin(page);

      await openEditForm(page, item.id);
      await fillItemForm(page, { supplier: code });
      await saveItem(page);
      await expect(page.getByTestId("admin-success")).toContainText(`Supplier order no.: ${code}`);

      const sent = lastBody(api, "PUT", PUT_ITEM(item.id)).supplier_order_number;
      expect(sent).toBe(code);
      expect(typeof sent).toBe("string");
      expect(stored(api, item.id).supplier_order_number).toBe(code);
      await expect(page.getByTestId(`admin-supplier-${item.id}`).locator("dd")).toHaveText(code);

      await reloadAdmin(page);
      await expect(page.getByTestId(`admin-supplier-${item.id}`).locator("dd")).toHaveText(code);
      await openEditForm(page, item.id);
      await expect(page.getByTestId("supplier-order-number-input")).toHaveValue(code);
    });
  }

  test("codes that spreadsheets and text tools mangle (zeros, 1E5, dates, formulas, 20 digits, mixed case, 64 characters) are kept exactly", async ({ page }) => {
    const longest = `MVI-${"0".repeat(60)}`; // exactly 64 characters, the largest code the field takes
    expect(longest).toHaveLength(64);
    const mixedCase = ["Ab-12c/9", "sku-Ab-7x"]; // lower and upper case letters side by side: case-folding either way changes them
    const codes = [...TRICKY_SUPPLIER_NUMBERS, ...mixedCase, longest];
    // Items that hold none of these codes yet, so every code really changes the supplier number (typing the
    // value an item already had would send nothing and prove nothing).
    const items = buildMedications().filter((m) => !codes.includes(m.supplier_order_number ?? ""));
    expect(items.length).toBeGreaterThanOrEqual(codes.length);
    const api = await openAdmin(page);

    for (const [index, code] of codes.entries()) {
      await openEditForm(page, items[index].id);
      await fillItemForm(page, { supplier: code });
      await saveItem(page);
      await expect(page.getByTestId("admin-success")).toBeVisible();
      expect(lastBody(api, "PUT", PUT_ITEM(items[index].id)).supplier_order_number, `sent code for "${code}"`).toBe(code);
      expect(stored(api, items[index].id).supplier_order_number, `stored code for "${code}"`).toBe(code);
    }

    await reloadAdmin(page);
    for (const [index, code] of codes.entries()) {
      await expect(page.getByTestId(`admin-supplier-${items[index].id}`).locator("dd"), `listed code for "${code}"`).toHaveText(code);
    }
  });

  test("the supplier field allows at most 64 characters but never cuts what was typed, and keeps surrounding spaces out of the stored code", async ({ page }) => {
    const item = seedItem(ASPIRIN);
    const api = await openAdmin(page);
    await openEditForm(page, item.id);

    const field = page.getByTestId("supplier-order-number-input");
    await field.fill("X".repeat(80));
    await expect(field).toHaveValue("X".repeat(80)); // all of it is still there: the limit is a message, not a clipped box
    await expect(page.getByTestId("problem-supplier-order-number")).toContainText("maximum 64 characters");

    await field.fill("  AB  12 ");
    await expect(page.getByTestId("problem-supplier-order-number")).toHaveCount(0);
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toBeVisible();
    expect(stored(api, item.id).supplier_order_number).toBe("AB  12"); // ends trimmed, inner characters untouched
  });

  test("a supplier order number can be changed and cleared; a cleared one reads Not set", async ({ page }) => {
    const item = seedItem(ACETAMINOPHEN);
    const api = await openAdmin(page);
    await expect(page.getByTestId(`admin-supplier-${item.id}`)).toContainText("00417-B");

    await openEditForm(page, item.id);
    await fillItemForm(page, { supplier: "00417-C" });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toContainText("Supplier order no.: 00417-C");
    expect(lastBody(api, "PUT", PUT_ITEM(item.id)).supplier_order_number).toBe("00417-C");
    expect(stored(api, item.id).supplier_order_number).toBe("00417-C");

    await openEditForm(page, item.id);
    await fillItemForm(page, { supplier: "" });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toContainText("Supplier order no.: Not set");
    expect(lastBody(api, "PUT", PUT_ITEM(item.id)).supplier_order_number).toBeNull();
    expect(stored(api, item.id).supplier_order_number).toBeNull();
    await expect(page.getByTestId(`admin-supplier-${item.id}`)).toContainText("Not set");

    await reloadAdmin(page);
    await expect(page.getByTestId(`admin-supplier-${item.id}`)).toContainText("Not set");
  });

  test("a missing supplier order number reads Not set and is never guessed from the barcode or the name", async ({ page }) => {
    const aspirin = seedItem(ASPIRIN);
    const api = await openAdmin(page);
    const cell = page.getByTestId(`admin-supplier-${aspirin.id}`);
    await expect(cell).toContainText("Supplier order no.");
    await expect(cell.locator("dd")).toHaveText("Not set");

    // A new item whose name and barcode look like codes, saved without a supplier number
    await createItem(page, { name: "Nitrile gloves XL [GLV-XL-99]", barcode: "0098765432" });
    const created = storedByBarcode(api, "0098765432");
    expect(created.supplier_order_number).toBeNull();
    expect(created.category_id).toBeNull(); // no category was chosen and none was invented
    expect(created.name).toBe("Nitrile gloves XL [GLV-XL-99]");
    expect("supplier_order_number" in lastBody(api, "POST", POST_ITEM)).toBe(false);
    expect(writes(api)).toEqual(["POST /api/medications"]);
    await expect(page.getByTestId(`admin-supplier-${created.id}`).locator("dd")).toHaveText("Not set");
    await expect(page.getByTestId("admin-success")).toContainText("Supplier order no.: Not set");

    // Editing an item whose name carries a code leaves the name and the supplier number alone
    await openEditForm(page, created.id);
    await fillItemForm(page, { notes: "Back-ordered" });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toBeVisible();
    expect(stored(api, created.id).name).toBe("Nitrile gloves XL [GLV-XL-99]");
    expect(stored(api, created.id).supplier_order_number).toBeNull();
    expect(writes(api)).toEqual(["POST /api/medications", `PUT /api/medications/${created.id}`]);
    await expectOrderSheetUntouched(page, "after creating and editing an item");
  });

  test("barcode and supplier order number are two labelled fields with their own help text, and their values never mix", async ({ page }) => {
    const item = seedItem(AMOXICILLIN);
    const api = await openAdmin(page);
    await openEditForm(page, item.id);

    const barcode = page.getByTestId("barcode-input");
    const supplier = page.getByTestId("supplier-order-number-input");
    await expect(page.getByLabel("Barcode", { exact: false })).toHaveCount(1);
    await expect(page.getByLabel("Supplier order number")).toHaveCount(1);
    await expect(barcode).toHaveAccessibleName(/Barcode/);
    await expect(supplier).toHaveAccessibleName(/Supplier order number/);
    await expect(supplier).not.toHaveAccessibleName(/Barcode/);

    const barcodeHelp = "The number printed under the barcode (what the scanner reads).";
    const supplierHelp =
      "The number your supplier uses when ordering this item. This is not the barcode. Letters, dashes and leading zeros are kept exactly as typed.";
    await expect(page.getByText(barcodeHelp, { exact: true })).toBeVisible();
    await expect(page.getByText(supplierHelp, { exact: true })).toBeVisible();
    await expect(barcode).toHaveAccessibleDescription(barcodeHelp);
    await expect(supplier).toHaveAccessibleDescription(supplierHelp);

    // The two labels do not look alike: a different colour on top of the different words
    const labelColor = (control: Locator): Promise<string> =>
      control.evaluate((el) => (el instanceof HTMLInputElement && el.labels?.[0] ? getComputedStyle(el.labels[0]).color : ""));
    expect(await labelColor(supplier)).not.toBe("");
    expect(await labelColor(supplier), "the Supplier label must not look like the Barcode label").not.toBe(await labelColor(barcode));

    // The supplier field sits between Barcode and Unit
    const order = await page.getByTestId("admin-form").locator("input, select, textarea").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
    expect(order.indexOf("supplier-order-number-input")).toBe(order.indexOf("barcode-input") + 1);
    expect(order.indexOf("unit-input")).toBeGreaterThan(order.indexOf("supplier-order-number-input"));

    // Two different values stay two different values
    await fillItemForm(page, { barcode: "0011223344", supplier: "SUP-0011223344-X" });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toBeVisible();
    const row = stored(api, item.id);
    expect(row.barcode).toBe("0011223344");
    expect(row.supplier_order_number).toBe("SUP-0011223344-X");
    await expect(page.getByTestId(`admin-barcode-${item.id}`)).toContainText("Barcode");
    await expect(page.getByTestId(`admin-barcode-${item.id}`).locator("dd")).toHaveText("0011223344");
    await expect(page.getByTestId(`admin-supplier-${item.id}`)).toContainText("Supplier order no.");
    await expect(page.getByTestId(`admin-supplier-${item.id}`).locator("dd")).toHaveText("SUP-0011223344-X");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 2b. Text that is too long is never cut short silently (nothing may look saved that is not exactly what was typed).
//     The limits of the supplier order number, the unit and the new category's name are not an input's `maxlength`: that
//     would clip a pasted 70-character code to its first 64 characters and report "Saved". The limits are enforced, the
//     person is told, next to the field, and nothing is saved until the text fits.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe("Admin: text that is too long is never cut short silently", () => {
  test("a 70-character supplier order number pasted into the field is kept whole, flagged next to the field, and is not saved", async ({ page }) => {
    const item = seedItem(ASPIRIN);
    const api = await openAdmin(page);
    await openEditForm(page, item.id);
    const field = page.getByTestId("supplier-order-number-input");
    const problem = page.getByTestId("problem-supplier-order-number");
    const pasted = "0123456789".repeat(7);
    expect(pasted).toHaveLength(70);

    await pasteInto(page, "supplier-order-number-input", pasted);
    await expect(field).toHaveValue(pasted); // every character is still there: nothing was cut off
    expect(await field.getAttribute("maxlength")).toBeNull();
    await expect(problem).toBeVisible();
    await expect(problem).toContainText("too long (maximum 64 characters)");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toHaveAccessibleDescription(/maximum 64 characters/);

    // Pressing Save does not send it, and takes the person to the field with the message
    await saveItem(page);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(pasted);
    await expect(problem).toBeVisible();
    await expect(page.getByTestId("admin-success")).toHaveCount(0);
    await expect(page.getByTestId("admin-form")).toBeVisible();
    expect(writes(api)).toEqual([]);
    expect(stored(api, item.id).supplier_order_number).toBeNull();

    // Shortening it by hand to 64 characters clears the message, and then it saves as exactly those characters
    const shortened = pasted.slice(0, 64);
    await field.fill(shortened);
    await expect(problem).toHaveCount(0);
    await expect(field).not.toHaveAttribute("aria-invalid", "true");
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toContainText(`Supplier order no.: ${shortened}`);
    expect(lastBody(api, "PUT", PUT_ITEM(item.id)).supplier_order_number).toBe(shortened);
    expect(stored(api, item.id).supplier_order_number).toBe(shortened);
  });

  // The limit is on characters as a person counts them (the server counts code points), and on the text without the spaces around it.
  const SUPPLIER_LENGTHS: ReadonlyArray<{ title: string; text: string; fits: boolean }> = [
    { title: "exactly 64 characters", text: `X-${"7".repeat(62)}`, fits: true },
    { title: "64 characters with spaces around them", text: ` X-${"7".repeat(62)}  `, fits: true },
    { title: "65 characters", text: `X-${"7".repeat(63)}`, fits: false },
    { title: "64 emoji (128 UTF-16 units, but 64 characters)", text: "💊".repeat(64), fits: true },
    { title: "65 emoji", text: "💊".repeat(65), fits: false },
  ];

  for (const length of SUPPLIER_LENGTHS) {
    test(`a supplier order number of ${length.title} is ${length.fits ? "accepted and saved exactly" : "flagged and not saved"}`, async ({ page }) => {
      const item = seedItem(ASPIRIN);
      const api = await openAdmin(page);
      await openEditForm(page, item.id);
      await pasteInto(page, "supplier-order-number-input", length.text);
      await expect(page.getByTestId("supplier-order-number-input")).toHaveValue(length.text); // never clipped on its way in

      await saveItem(page);
      if (length.fits) {
        await expect(page.getByTestId("admin-success")).toBeVisible();
        await expect(page.getByTestId("problem-supplier-order-number")).toHaveCount(0);
        expect(stored(api, item.id).supplier_order_number).toBe(length.text.trim());
      } else {
        await expect(page.getByTestId("problem-supplier-order-number")).toContainText("maximum 64 characters");
        await expect(page.getByTestId("admin-success")).toHaveCount(0);
        expect(writes(api)).toEqual([]);
        expect(stored(api, item.id).supplier_order_number).toBeNull();
      }
    });
  }

  test("a 61-character name pasted into the new-category box is kept whole, flagged next to the box, and no category is created", async ({ page }) => {
    const item = seedItem(ASPIRIN);
    const api = await openAdmin(page);
    await openEditForm(page, item.id);
    await chooseCategory(page, CREATE_NEW);
    const input = page.getByTestId("new-category-input");
    const problem = page.getByTestId("problem-new-category");
    const pasted = "Vaccines and other things that need the cold chain".padEnd(61, "!");
    expect(pasted).toHaveLength(61);
    const categoriesBefore = api.categories.length;

    await pasteInto(page, "new-category-input", pasted);
    await expect(input).toHaveValue(pasted);
    expect(await input.getAttribute("maxlength")).toBeNull();
    await expect(problem).toBeVisible();
    await expect(problem).toContainText("too long (maximum 60 characters)");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAccessibleDescription(/maximum 60 characters/);

    // Neither the button nor the Enter key creates anything, and the typed text stays where it is
    await page.getByTestId("new-category-save").click();
    await expect(input).toBeFocused();
    await input.press("Enter");
    await expect(input).toHaveValue(pasted);
    await expect(problem).toBeVisible();
    expect(api.requestsTo("POST", /\/api\/categories$/)).toHaveLength(0);
    expect(api.categories).toHaveLength(categoriesBefore);
    await expect(page.getByTestId("category-note")).toHaveCount(0);

    // At 60 characters the message goes and the category is created under exactly that name
    const fits = pasted.slice(0, 60);
    await input.fill(fits);
    await expect(problem).toHaveCount(0);
    await page.getByTestId("new-category-save").click();
    await expect(page.getByTestId("category-note")).toContainText("was created and selected");
    expect(api.categories.some((c) => c.name === fits)).toBe(true);
    expect(api.requestsTo("POST", /\/api\/categories$/)).toHaveLength(1);
  });

  test("a 41-character unit pasted into a new item is kept whole, flagged next to the field, and the item is not created", async ({ page }) => {
    const api = await openAdmin(page);
    const before = api.medications.length;
    await openNewItemForm(page);
    await fillItemForm(page, { name: "Unit too long item", barcode: "0099001150" });
    const field = page.getByTestId("unit-input");
    const problem = page.getByTestId("problem-unit");
    const pasted = "u".repeat(41);

    await pasteInto(page, "unit-input", pasted);
    await expect(field).toHaveValue(pasted);
    expect(await field.getAttribute("maxlength")).toBeNull();
    await expect(problem).toContainText("too long (maximum 40 characters)");
    await expect(field).toHaveAttribute("aria-invalid", "true");

    await saveItem(page);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(pasted);
    await expect(page.getByTestId("admin-success")).toHaveCount(0);
    expect(writes(api)).toEqual([]);
    expect(api.medications).toHaveLength(before);

    const fits = pasted.slice(0, 40);
    await field.fill(fits);
    await expect(problem).toHaveCount(0);
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toBeVisible();
    expect(storedByBarcode(api, "0099001150").unit).toBe(fits);
  });

  test("a stored unit that is longer than 40 characters does not stop the item from being edited: the unit is not the person's change", async ({ page }) => {
    const item = seedItem(ASPIRIN);
    const longUnit = "W".repeat(45);
    const api = await openAdmin(page, { medications: buildMedications().map((m) => (m.id === item.id ? { ...m, unit: longUnit } : m)) });
    await openEditForm(page, item.id);
    await expect(page.getByTestId("unit-input")).toHaveValue(longUnit);
    await expect(page.getByTestId("problem-unit")).toHaveCount(0); // nobody asked to change it

    await fillItemForm(page, { notes: "Edited next to a long unit" });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toBeVisible();
    expect(lastBody(api, "PUT", PUT_ITEM(item.id))).toEqual({ notes: "Edited next to a long unit" });
    expect(stored(api, item.id).unit).toBe(longUnit);
  });

  test("the barcode field sets no length limit of its own: a 200-character barcode is kept whole and sent whole", async ({ page }) => {
    const api = await openAdmin(page);
    await openNewItemForm(page);
    const barcode = "7".repeat(200);

    await fillItemForm(page, { name: "Very long barcode item" });
    await pasteInto(page, "barcode-input", barcode);
    const field = page.getByTestId("barcode-input");
    await expect(field).toHaveValue(barcode);
    expect(await field.getAttribute("maxlength")).toBeNull();
    await expect(field).not.toHaveAttribute("aria-invalid", "true");

    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toBeVisible();
    expect(lastBody(api, "POST", POST_ITEM).barcode).toBe(barcode);
    expect(storedByBarcode(api, barcode).name).toBe("Very long barcode item");
  });

  test("when two fields are too long, Save takes the keyboard to the first one on the page, then to the next once that one fits", async ({ page }) => {
    const item = seedItem(ASPIRIN);
    const api = await openAdmin(page);
    await openEditForm(page, item.id);
    await pasteInto(page, "unit-input", "u".repeat(41));
    await pasteInto(page, "supplier-order-number-input", "S".repeat(65));
    await expect(page.getByTestId("problem-unit")).toBeVisible(); // both messages are there before anything is pressed
    await expect(page.getByTestId("problem-supplier-order-number")).toBeVisible();

    await saveItem(page);
    await expect(page.getByTestId("supplier-order-number-input")).toBeFocused(); // higher up the form than the unit

    await page.getByTestId("supplier-order-number-input").fill("S".repeat(64));
    await expect(page.getByTestId("problem-supplier-order-number")).toHaveCount(0);
    await expect(page.getByTestId("problem-unit")).toBeVisible();
    await saveItem(page);
    await expect(page.getByTestId("unit-input")).toBeFocused();
    expect(writes(api)).toEqual([]); // nothing was sent while a field was too long

    await page.getByTestId("unit-input").fill("u".repeat(40));
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toBeVisible();
    expect(lastBody(api, "PUT", PUT_ITEM(item.id))).toEqual({ unit: "u".repeat(40), supplier_order_number: "S".repeat(64) });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 2c. Typing in the item form does not re-render the list. Every keystroke changes the page's form state, and rows below
//     the form that rendered again each time would cost, with 1,500 items, about half a second per key. The rows are
//     memoized. This test counts renders instead of milliseconds, so it cannot be flaky: it asks React itself which rows did work.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

type RowRenderCounter = { counting: boolean; commits: number; rowRenders: number };

/**
 * Puts a minimal React DevTools hook on the page before it loads. React calls it after every commit, and a component that
 * really rendered (instead of being skipped) carries the PerformedWork flag: that is how the profiler counts renders. A list
 * row is recognised by the props only it has (med, onEdit, onDelete), so no class name or markup is involved.
 */
async function installRowRenderCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Fiber = { flags: number; memoizedProps: unknown; child: Fiber | null; sibling: Fiber | null };
    const counter: RowRenderCounter = { counting: false, commits: 0, rowRenders: 0 };
    (window as unknown as { __rowRenderCounter: RowRenderCounter }).__rowRenderCounter = counter;
    const isRow = (props: unknown): boolean =>
      typeof props === "object" && props !== null && "med" in props && "onEdit" in props && "onDelete" in props;
    let nextRendererId = 1;
    const hook = {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map<number, unknown>(),
      inject(renderer: unknown): number {
        const id = nextRendererId++;
        hook.renderers.set(id, renderer);
        return id;
      },
      onCommitFiberRoot(_rendererId: number, root: { current: Fiber }): void {
        if (!counter.counting) return;
        counter.commits += 1;
        const pending: Fiber[] = [root.current];
        for (let fiber = pending.pop(); fiber !== undefined; fiber = pending.pop()) {
          if ((fiber.flags & 1) !== 0 && isRow(fiber.memoizedProps)) counter.rowRenders += 1; // 1 = PerformedWork
          if (fiber.sibling) pending.push(fiber.sibling);
          if (fiber.child) pending.push(fiber.child);
        }
      },
      onCommitFiberUnmount(): void {},
      onPostCommitFiberRoot(): void {},
      onScheduleFiberRoot(): void {},
      checkDCE(): void {},
    };
    Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { value: hook, configurable: true, writable: true });
  });
}

/** Runs `action` while counting, then returns how many commits happened and how many list rows rendered during it. */
async function countRowRenders(page: Page, action: () => Promise<void>): Promise<{ commits: number; rowRenders: number }> {
  await page.evaluate(() => {
    const counter = (window as unknown as { __rowRenderCounter: RowRenderCounter }).__rowRenderCounter;
    counter.commits = 0;
    counter.rowRenders = 0;
    counter.counting = true;
  });
  await action();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return page.evaluate(() => {
    const counter = (window as unknown as { __rowRenderCounter: RowRenderCounter }).__rowRenderCounter;
    counter.counting = false;
    return { commits: counter.commits, rowRenders: counter.rowRenders };
  });
}

test.describe("Admin: typing in the form does not re-render the list", () => {
  test("24 keystrokes in the Name box render no list row, while saving (which brings in a fresh list) renders every row", async ({ page }) => {
    const rows = 120;
    await installRowRenderCounter(page);
    const api = await openAdmin(page, { medications: buildManyMedications(rows), categories: buildCategories() });
    const [firstId] = await visibleItemIds(page, "admin-row-");
    await openEditForm(page, firstId);
    const typed = "abcdefghijklmnopqrstuvwx";
    expect(typed).toHaveLength(24);

    const whileTyping = await countRowRenders(page, async () => {
      await page.getByTestId("name-input").click();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type(typed, { delay: 0 });
    });
    await expect(page.getByTestId("name-input")).toHaveValue(typed);
    expect(whileTyping.commits, "the page did re-render for the keystrokes (the counter is watching)").toBeGreaterThanOrEqual(typed.length);
    expect(whileTyping.rowRenders, `rows rendered while typing, out of ${rows} on the page`).toBe(0);

    // The control: the same counter DOES see rows render when they have to. A save replaces the list with the server's answer.
    const whileSaving = await countRowRenders(page, async () => {
      await saveItem(page);
      await expect(page.getByTestId("admin-success")).toBeVisible();
    });
    expect(lastBody(api, "PUT", PUT_ITEM(firstId))).toEqual({ name: typed });
    expect(whileSaving.rowRenders, "rows rendered after a save brought in a fresh list").toBeGreaterThanOrEqual(rows);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 3. Honest feedback when a save does not work (failed saves show a useful error and never look successful)
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe("Admin: an item whose stored vendor link has no https://", () => {
  // Staff can type "shop.example.com/reorder" there, every screen shows it as an https link, and the API accepts it. The
  // vendor box must therefore not be a browser-validated URL field: the browser would itself refuse to submit the form
  // (a tooltip, no request) for ANY edit of such an item, including a note or a category.
  const BARE = "shop.example.com/reorder";

  test("editing something else saves: the browser does not block the form, and only the changed field is sent", async ({ page }) => {
    const item = seedItem(IBUPROFEN);
    const api = await openAdmin(page, {
      medications: buildMedications().map((m) => (m.id === item.id ? { ...m, vendor_url: BARE } : m)),
    });
    await openEditForm(page, item.id);
    await expect(page.getByTestId("vendor-url-input")).toHaveValue(BARE);
    await fillItemForm(page, { notes: "Moved to the top shelf" });
    await saveItem(page);

    await expect(page.getByTestId("admin-success")).toBeVisible();
    expect(lastBody(api, "PUT", PUT_ITEM(item.id))).toEqual({ notes: "Moved to the top shelf" });
    expect(stored(api, item.id).vendor_url).toBe(BARE);
    expect(stored(api, item.id).notes).toBe("Moved to the top shelf");
  });

  test("a bare address can be typed into the box and is sent as typed", async ({ page }) => {
    const item = seedItem(IBUPROFEN);
    const api = await openAdmin(page);
    await openEditForm(page, item.id);
    await fillItemForm(page, { vendorUrl: BARE });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toBeVisible();
    expect(lastBody(api, "PUT", PUT_ITEM(item.id))).toEqual({ vendor_url: BARE });
  });
});

test.describe("Admin: honest feedback when a save does not work", () => {
  test("a refused save shows the server's message in an alert, keeps the form open with what was typed, and focuses the alert", async ({ page }) => {
    const item = seedItem(ACETAMINOPHEN);
    const api = await openAdmin(page);
    api.failNext({
      method: "PUT",
      path: PUT_ITEM(item.id),
      status: 403,
      body: { error: "The database refused this change (row-level security).", code: "42501", detail: "new row violates row-level security policy" },
    });

    await openEditForm(page, item.id);
    await fillItemForm(page, { supplier: "00417-C", category: ANTIBIOTICS, notes: "typed note that must survive" });
    await saveItem(page);

    const alert = page.getByTestId("admin-error");
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(alert).toContainText("The database refused this change (row-level security).");
    await expect(alert).toContainText("42501");
    await expect(alert).toBeFocused();
    await expect(page.getByTestId("admin-success")).toHaveCount(0);
    await expect(page.getByTestId(`admin-saved-${item.id}`)).toHaveCount(0);

    // The alert is part of the open form, so a person looking at the form sees it; the form still holds every typed value.
    await expect(page.locator("section", { has: page.getByTestId("admin-form") }).getByTestId("admin-error")).toBeVisible();
    await expect(page.getByTestId("supplier-order-number-input")).toHaveValue("00417-C");
    await expect(page.getByTestId("notes-input")).toHaveValue("typed note that must survive");
    expect(await chosenCategory(page)).toBe(ANTIBIOTICS);

    // Nothing was stored
    const row = stored(api, item.id);
    expect(row.category_id).toBe(categoryId(0));
    expect(row.supplier_order_number).toBe("00417-B");
    expect(row.notes).toBeNull();

    // The failure was one-shot: saving again goes through with the same values
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Antibiotics · Supplier order no.: 00417-C");
    await expect(page.getByTestId("admin-error")).toHaveCount(0);
    expect(stored(api, item.id).category_id).toBe(categoryId(2));
    expect(stored(api, item.id).notes).toBe("typed note that must survive");
  });

  test("a refused create shows the error and adds no item; saving again adds exactly one", async ({ page }) => {
    const api = await openAdmin(page);
    const before = api.medications.length;
    api.failNext({ method: "POST", path: POST_ITEM, status: 500, body: { error: "Unexpected database error.", code: "XX000" } });

    await openNewItemForm(page);
    await fillItemForm(page, { name: "Create retry item", barcode: "0099001125", supplier: "00417-B", category: ANTIBIOTICS });
    await saveItem(page);

    const alert = page.getByTestId("admin-error");
    await expect(alert).toContainText("Unexpected database error.");
    await expect(alert).toBeFocused();
    await expect(page.getByTestId("admin-success")).toHaveCount(0);
    await expect(page.getByText("Create retry item", { exact: true })).toHaveCount(0); // not in the list
    expect(api.medications).toHaveLength(before);
    await expect(page.getByTestId("barcode-input")).toHaveValue("0099001125");
    await expect(page.getByTestId("name-input")).toHaveValue("Create retry item");

    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Antibiotics · Supplier order no.: 00417-B");
    expect(api.medications.filter((m) => m.barcode === "0099001125")).toHaveLength(1);
    expect(api.medications).toHaveLength(before + 1);
    // Nothing was typed in the number fields, so the stock stays 0: a stray stock movement would show up here.
    expect(storedByBarcode(api, "0099001125")).toMatchObject({ name: "Create retry item", supplier_order_number: "00417-B", category_id: categoryId(2), stock: 0 });
    expect(writes(api)).toEqual(["POST /api/medications", "POST /api/medications"]); // the refused try and the one that worked: nothing else
    await expectOrderSheetUntouched(page, "after a create that was refused once");
  });

  test("a save that cannot reach the server says so, keeps what was typed and never shows Saved", async ({ page }) => {
    const item = seedItem(IBUPROFEN);
    const api = await openAdmin(page);
    api.failNext({ method: "PUT", path: PUT_ITEM(item.id), networkError: true });

    await openEditForm(page, item.id);
    await fillItemForm(page, { notes: "typed while offline" });
    await saveItem(page);

    const alert = page.getByTestId("admin-error");
    await expect(alert).toContainText("Could not reach the server");
    await expect(alert).toBeFocused();
    await expect(page.getByTestId("admin-success")).toHaveCount(0);
    await expect(page.getByTestId("notes-input")).toHaveValue("typed while offline");
    expect(stored(api, item.id).notes).toBeNull();

    await saveItem(page); // back online
    await expect(page.getByTestId("admin-success")).toBeVisible();
    expect(stored(api, item.id).notes).toBe("typed while offline");
  });

  test("the live defect: when categories cannot be read or created, creating one explains why and never claims success", async ({ page }) => {
    const api = await openAdmin(page, { categoriesBlocked: true });
    const categoriesBefore = api.categories.length;

    await openNewItemForm(page);
    await expect(page.getByText("No categories are available yet.")).toBeVisible();
    expect(await categoryChoices(page)).toEqual([UNCATEGORIZED, CREATE_NEW]);

    await chooseCategory(page, CREATE_NEW);
    await expect(page.getByTestId("new-category-input")).toBeFocused();
    await page.getByTestId("new-category-input").fill("Vaccines");
    await page.getByTestId("new-category-save").click();

    const error = page.getByTestId("category-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute("role", "alert");
    await expect(error).toContainText("Categories cannot be saved yet"); // what went wrong
    await expect(error).toContainText("whoever looks after this app"); // what to do about it
    // The sentence staff read has no database words; the database's own words are in the small line under it, for whoever looks after the app.
    await expect(error.locator("p").first()).not.toContainText("row-level security");
    await expect(error.locator("p").first()).not.toContainText("42501");
    await expect(error).toContainText("Technical details:");
    await expect(error).toContainText("row-level security");
    await expect(page.getByTestId("category-note")).toHaveCount(0); // never "created and selected"
    await expect(page.getByTestId("admin-success")).toHaveCount(0);
    await expect(page.getByTestId("new-category-input")).toHaveValue("Vaccines"); // the typed name is kept
    expect(api.categories).toHaveLength(categoriesBefore);
    expect(api.categories.some((c) => c.name === "Vaccines")).toBe(false);
    expect(api.requestsTo("POST", /\/api\/categories$/)).toHaveLength(1);

    // The help under the field now says the item can still be saved without a category (the server's message says it too,
    // which is why this looks at the help text itself). Prove that claim.
    await expect(page.locator("#admin-category-help")).toContainText("You can still save the item without a category");
    await page.getByTestId("new-category-cancel").click();
    await fillItemForm(page, { name: "Saved without a category", barcode: "0099001126" });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Uncategorized · Supplier order no.: Not set");
    expect(storedByBarcode(api, "0099001126").category_id).toBeNull();
    expect(writes(api)).toEqual(["POST /api/categories", "POST /api/medications"]); // the refused category, then the item
  });

  test("while the category list cannot be read, editing another field keeps the item's category", async ({ page }) => {
    const item = seedItem(ACETAMINOPHEN);
    const api = await openAdmin(page, { categoriesBlocked: true });
    await expect(page.getByTestId(`admin-category-${item.id}`)).toContainText("Category unavailable");

    await openEditForm(page, item.id);
    expect(await chosenCategory(page)).toBe("Current category (name unavailable)"); // labelled honestly, still selected
    await fillItemForm(page, { name: "Acetaminophen 500 mg, tablets (renamed)" });
    await saveItem(page);

    await expect(page.getByTestId("admin-success")).toBeVisible();
    // The category could not even be shown by name, and it is not the person's change: it is not sent at all
    expect(lastBody(api, "PUT", PUT_ITEM(item.id))).toEqual({ name: "Acetaminophen 500 mg, tablets (renamed)" });
    expect(stored(api, item.id).category_id).toBe(item.category_id);
    expect(stored(api, item.id).name).toBe("Acetaminophen 500 mg, tablets (renamed)");
  });

  const NOT_STORED_CASES = [
    {
      title: "the category",
      ignore: { category: true },
      edit: { category: ANTIBIOTICS },
      message: "The item was saved, but the category was not stored. Nothing else changed.",
    },
    {
      title: "the supplier order number",
      ignore: { supplier: true },
      edit: { supplier: "NEW-0042" },
      message: "The item was saved, but the supplier order number was not stored. Nothing else changed.",
    },
    {
      title: "both the category and the supplier order number",
      ignore: { category: true, supplier: true },
      edit: { category: ANTIBIOTICS, supplier: "NEW-0042" },
      message: "The item was saved, but the category and supplier order number were not stored. Nothing else changed.",
    },
  ] as const;

  for (const scenario of NOT_STORED_CASES) {
    test(`a server that answers OK but did not store ${scenario.title} says so explicitly instead of showing success`, async ({ page }) => {
      const item = seedItem(ACETAMINOPHEN);
      const api = await openAdmin(page);
      const sent = await serverIgnoresFields(page, api, scenario.ignore);

      await openEditForm(page, item.id);
      await fillItemForm(page, scenario.edit);
      await saveItem(page);

      const alert = page.getByTestId("admin-error");
      await expect(alert).toContainText(scenario.message);
      await expect(alert).toHaveAttribute("role", "alert");
      await expect(alert).toBeFocused();
      await expect(page.getByTestId("admin-success")).toHaveCount(0);
      await expect(page.getByTestId(`admin-saved-${item.id}`)).toHaveCount(0);
      await expect(page.getByTestId("admin-form")).toBeVisible();

      // The page did send what the person chose; the "server" kept the old values, and the list shows the truth.
      const body = sent.at(-1);
      if ("category" in scenario.edit) {
        expect(body?.category_id).toBe(categoryId(2));
        expect(stored(api, item.id).category_id).toBe(categoryId(0));
        expect(await chosenCategory(page)).toBe(ANTIBIOTICS);
        await expect(page.getByTestId(`admin-category-${item.id}`)).toContainText(PAIN_AND_FEVER);
      }
      if ("supplier" in scenario.edit) {
        expect(body?.supplier_order_number).toBe("NEW-0042");
        expect(stored(api, item.id).supplier_order_number).toBe("00417-B");
        await expect(page.getByTestId("supplier-order-number-input")).toHaveValue("NEW-0042");
        await expect(page.getByTestId(`admin-supplier-${item.id}`)).toContainText("00417-B");
      }
    });
  }

  test("after 'saved, but not stored', saving again does not put back what another person changed while the form was open", async ({ page }) => {
    const item = seedItem(ACETAMINOPHEN); // Pain & Fever, supplier 00417-B, stock 120
    const api = await openAdmin(page);
    const sent = await serverIgnoresFields(page, api, { supplier: true });
    await openEditForm(page, item.id); // the form now holds stock 120 and Pain & Fever

    // Meanwhile a dispense takes the stock down and another person files the item under Antibiotics
    expect(await dispenseFromAnotherScreen(page, item.id, 20)).toBe(201);
    stored(api, item.id).category_id = categoryId(2);

    // The person types a supplier order number; the server answers OK but does not store it
    await fillItemForm(page, { supplier: "NEW-0042" });
    await saveItem(page);
    await expect(page.getByTestId("admin-error")).toContainText("The item was saved, but the supplier order number was not stored.");
    expect(sent).toEqual([{ supplier_order_number: "NEW-0042" }]);

    // Saving again sends the supplier order number and nothing else: the stock and the category the form was opened with are stale
    await saveItem(page);
    await expect(page.getByTestId("admin-error")).toContainText("the supplier order number was not stored");
    expect(sent.at(-1)).toEqual({ supplier_order_number: "NEW-0042" });
    expect(stored(api, item.id)).toMatchObject({ stock: 100, category_id: categoryId(2), supplier_order_number: "00417-B" });
  });

  test("the same check protects a new item: a dropped category is reported, and saving again updates that item instead of adding a second", async ({ page }) => {
    const api = await openAdmin(page);
    await serverIgnoresFields(page, api, { category: true });

    await openNewItemForm(page);
    await fillItemForm(page, { name: "Dropped category item", barcode: "0099001127", category: ANTIBIOTICS });
    await saveItem(page);
    await expect(page.getByTestId("admin-error")).toContainText("The item was saved, but the category was not stored.");
    await expect(page.getByTestId("admin-success")).toHaveCount(0);
    expect(api.medications.filter((m) => m.barcode === "0099001127")).toHaveLength(1);

    await saveItem(page); // the item exists now: this must be an update, never a second create
    await expect(page.getByTestId("admin-error")).toContainText("The item was saved, but the category was not stored.");
    expect(api.requestsTo("POST", POST_ITEM)).toHaveLength(1);
    expect(api.medications.filter((m) => m.barcode === "0099001127")).toHaveLength(1);
    expect(writes(api)).toEqual(["POST /api/medications", `PUT /api/medications/${storedByBarcode(api, "0099001127").id}`]);
  });

  test("before the database migration, saving without touching the supplier field works and entering one shows the migration message", async ({ page }) => {
    const item = seedItem(ASPIRIN);
    const api = await openAdmin(page, { supplierColumnMissing: true });

    // 1. An edit that leaves the supplier field alone is saved normally.
    await openEditForm(page, item.id);
    await fillItemForm(page, { notes: "Saved before the migration", category: ANTIBIOTICS });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Antibiotics");
    expect(stored(api, item.id).notes).toBe("Saved before the migration");
    expect(stored(api, item.id).category_id).toBe(categoryId(2));

    // 2. Entering a supplier number shows the migration message, keeps the form and changes nothing.
    await openEditForm(page, item.id);
    await fillItemForm(page, { notes: "Second edit", supplier: "00417-B" });
    await saveItem(page);
    const alert = page.getByTestId("admin-error");
    await expect(alert).toContainText("Supplier order numbers cannot be saved yet");
    await expect(alert).toContainText("Nothing was changed on this item");
    await expect(alert).toBeFocused();
    await expect(page.getByTestId("admin-success")).toHaveCount(0);
    await expect(page.getByTestId("supplier-order-number-input")).toHaveValue("00417-B");
    await expect(page.getByTestId("supplier-order-number-input")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("notes-input")).toHaveValue("Second edit");
    expect(stored(api, item.id).notes).toBe("Saved before the migration");
    expect(stored(api, item.id).supplier_order_number).toBeNull();

    // 3. The way out the message gives: clear that one field and the other changes save.
    await expect(alert).toContainText("clear the Supplier order number field");
    await fillItemForm(page, { supplier: "" });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toBeVisible();
    expect(stored(api, item.id).notes).toBe("Second edit");
  });

  test("before the database migration, creating an item without a supplier number works and with one shows the message and adds nothing", async ({ page }) => {
    const api = await openAdmin(page, { supplierColumnMissing: true });
    const before = api.medications.length;

    await createItem(page, { name: "Pre-migration item", barcode: "0077001", category: PAIN_AND_FEVER });
    expect("supplier_order_number" in lastBody(api, "POST", POST_ITEM)).toBe(false);
    expect(api.medications).toHaveLength(before + 1);

    await openNewItemForm(page);
    await fillItemForm(page, { name: "Needs the column", barcode: "0077002", supplier: "X-1" });
    await saveItem(page);
    await expect(page.getByTestId("admin-error")).toContainText("The item was not created");
    await expect(page.getByTestId("admin-success")).toHaveCount(0);
    expect(api.medications.some((m) => m.barcode === "0077002")).toBe(false);
    expect(api.medications).toHaveLength(before + 1);
    expect(storedByBarcode(api, "0077001")).toMatchObject({ name: "Pre-migration item", category_id: categoryId(0), supplier_order_number: null });
    expect(writes(api)).toEqual(["POST /api/medications", "POST /api/medications"]); // the one that worked and the one the database refused
  });

  test("an empty barcode is stopped in the form before anything is sent", async ({ page }) => {
    const api = await openAdmin(page);
    await openNewItemForm(page);
    await fillItemForm(page, { name: "No barcode yet", supplier: "00417-B" });
    await saveItem(page);

    const barcode = page.getByTestId("barcode-input");
    await expect(barcode).toBeFocused(); // the cursor is put in the field that needs filling
    expect(await barcode.evaluate((el) => el instanceof HTMLInputElement && el.validity.valueMissing)).toBe(true);
    expect(api.requestsTo("POST", POST_ITEM)).toHaveLength(0);
    await expect(page.getByTestId("admin-success")).toHaveCount(0);
    await expect(page.getByTestId("name-input")).toHaveValue("No barcode yet");
  });

  test("a barcode of only spaces is refused by the server and the barcode field is marked", async ({ page }) => {
    const api = await openAdmin(page);
    const before = api.medications.length;
    await openNewItemForm(page);
    await fillItemForm(page, { name: "Blank barcode item", barcode: "   " });
    await saveItem(page);

    const alert = page.getByTestId("admin-error");
    await expect(alert).toContainText("Barcode is required");
    await expect(alert).toBeFocused();
    await expect(page.getByTestId("barcode-input")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("name-input")).toHaveValue("Blank barcode item");
    expect(api.medications).toHaveLength(before);

    await fillItemForm(page, { barcode: "0099001128" }); // typing in the field clears its error mark
    await expect(page.getByTestId("barcode-input")).not.toHaveAttribute("aria-invalid", "true");
  });

  test("a barcode already used by another item is reported and nothing is saved", async ({ page }) => {
    const other = seedItem(AMOXICILLIN);
    const api = await openAdmin(page);
    const before = api.medications.length;
    await openNewItemForm(page);
    await fillItemForm(page, { name: "Duplicate barcode item", barcode: other.barcode });
    await saveItem(page);

    await expect(page.getByTestId("admin-error")).toContainText("Barcode already exists");
    await expect(page.getByTestId("admin-error")).toBeFocused();
    await expect(page.getByTestId("barcode-input")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("admin-success")).toHaveCount(0);
    expect(api.medications).toHaveLength(before);
  });

  test("a supplier order number with a hidden character is refused with a clear message and a hint, and nothing is saved", async ({ page }) => {
    const api = await openAdmin(page);
    const before = api.medications.length;
    await openNewItemForm(page);
    await fillItemForm(page, { name: "Pasted code item", barcode: "0099001129", supplier: "AB​12" }); // a zero-width space
    await saveItem(page);

    const alert = page.getByTestId("admin-error");
    await expect(alert).toContainText("invisible");
    await expect(alert).toBeFocused();
    await expect(page.getByTestId("supplier-order-number-hint")).toContainText("If you pasted this code, delete it and type it by hand.");
    await expect(page.getByTestId("supplier-order-number-input")).toHaveAttribute("aria-invalid", "true");
    expect(api.medications).toHaveLength(before);

    await fillItemForm(page, { supplier: "AB12" });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toContainText("Supplier order no.: AB12");
    expect(storedByBarcode(api, "0099001129").supplier_order_number).toBe("AB12");
  });

  test("a list that cannot be loaded is an error with Retry, never 'No medications yet'", async ({ page }) => {
    const api = await installMockApi(page);
    api.failNext({ method: "GET", path: /\/api\/medications$/, status: 503, body: { error: "Can’t reach the database. Check the connection, and that the Supabase project isn’t paused." } });
    await page.goto("/admin", { waitUntil: "domcontentloaded", timeout: 120_000 });

    const error = page.getByTestId("admin-load-error");
    await expect(error).toBeVisible({ timeout: SLOW_MS });
    await expect(error).toContainText("This does not mean the inventory is empty.");
    await expect(error).toContainText("Can’t reach the database.");
    await expect(page.getByText("No medications yet.")).toHaveCount(0);
    await expect(page.getByTestId("admin-empty")).toHaveCount(0);

    await error.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("admin-load-error")).toHaveCount(0);
    await expect(page.getByTestId("admin-summary")).toContainText(`Showing all ${api.medications.length} items.`);
  });

  test("deleting asks first, reports a failed delete and keeps the item, and removes the item when it works", async ({ page }) => {
    const item = seedItem(IBUPROFEN);
    const api = await openAdmin(page);

    // Declining the confirmation does nothing
    page.once("dialog", (dialog) => void dialog.dismiss());
    await page.getByTestId(`admin-delete-${item.id}`).click();
    expect(api.requestsTo("DELETE", PUT_ITEM(item.id))).toHaveLength(0);
    await expect(page.getByTestId(`admin-row-${item.id}`)).toBeVisible();

    // A refused delete says so, keeps the item in the list and in the database
    api.failNext({ method: "DELETE", path: PUT_ITEM(item.id), status: 500, body: { error: "Unexpected database error.", code: "XX000" } });
    let question = "";
    page.once("dialog", (dialog) => {
      question = dialog.message();
      void dialog.accept();
    });
    await page.getByTestId(`admin-delete-${item.id}`).click();
    const alert = page.getByTestId("admin-error");
    await expect(alert).toContainText("Unexpected database error.");
    await expect(alert).toContainText("was not deleted");
    await expect(alert).toBeFocused();
    expect(question).toContain("Ibuprofen 200 mg");
    expect(question).toContain("transaction history");
    await expect(page.getByTestId(`admin-row-${item.id}`)).toBeVisible();
    expect(api.medications.some((m) => m.id === item.id)).toBe(true);

    // A delete that works removes the item and says so
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTestId(`admin-delete-${item.id}`).click();
    await expect(page.getByTestId("admin-success")).toContainText("Deleted");
    await expect(page.getByTestId(`admin-row-${item.id}`)).toHaveCount(0);
    await expect(page.getByTestId("admin-error")).toHaveCount(0);
    expect(api.medications.some((m) => m.id === item.id)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 4. The Admin list agrees with the Inventory tab, and says why a list is empty
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/** Ground truth for the list tests, computed from the fixtures (not from either screen). */
function expectedIds(items: readonly Medication[], filter: { categoryId?: string | "uncategorized"; search?: string }): number[] {
  const terms = (filter.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return items
    .filter((m) => {
      if (filter.categoryId === "uncategorized" && m.category_id !== null) return false;
      if (filter.categoryId !== undefined && filter.categoryId !== "uncategorized" && m.category_id !== filter.categoryId) return false;
      const haystack = `${m.name ?? ""} ${m.barcode} ${m.supplier_order_number ?? ""}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .map((m) => m.id)
    .sort((a, b) => a - b);
}

type ListScenario = { label: string; category?: string; search?: string };

const LIST_SCENARIOS: readonly ListScenario[] = [
  // Every category the fixtures have (six) and Uncategorized, each filtered on both screens and compared with the oracle
  ...CATEGORY_NAMES.map((name): ListScenario => ({ label: `the category ${name}`, category: name })),
  { label: "Uncategorized", category: "Uncategorized" },
  { label: "a search by name", search: "amox" },
  { label: "a search by supplier order number", search: "00417" },
  { label: "a search by barcode", search: "0049000028911" },
  { label: "a category and a search together", category: PAIN_AND_FEVER, search: "tablets" },
  { label: "a category and a search that match nothing", category: "First Aid", search: "zzz-no-match" },
];

test.describe("Admin: the list and the Inventory tab", () => {
  test("the Admin filters and the Inventory tab show exactly the same items for the same category and search", async ({ page }) => {
    const items = buildMedications();
    await openAdmin(page);
    const total = items.length;
    const categoryIdByName = new Map<string, string>(CATEGORY_NAMES.map((name, index) => [name, categoryId(index)]));
    const oracle = (scenario: ListScenario): number[] =>
      expectedIds(items, {
        categoryId: scenario.category === undefined ? undefined : scenario.category === "Uncategorized" ? "uncategorized" : categoryIdByName.get(scenario.category),
        search: scenario.search,
      });

    // The Admin list
    const admin = new Map<string, { ids: number[]; shown: number }>();
    for (const scenario of LIST_SCENARIOS) {
      await filterAdminByCategory(page, scenario.category ?? "All categories");
      await page.getByTestId("admin-search").fill(scenario.search ?? "");
      const expected = oracle(scenario);
      const summary = page.getByTestId("admin-summary");
      await expect(summary, scenario.label).toContainText(`Showing ${expected.length} of ${total} items`);
      const ids = await visibleItemIds(page, "admin-row-");
      expect(ids, `Admin list for ${scenario.label}`).toEqual(expected);
      admin.set(scenario.label, { ids, shown: parseCounts(await summary.innerText()).shown });
    }

    // The Inventory tab, same data (the mock database stays in place when the page navigates)
    await page.goto("/?tab=inventory", { waitUntil: "domcontentloaded", timeout: 120_000 });
    await expect(page.getByTestId("inventory-summary")).toBeVisible({ timeout: SLOW_MS });
    for (const scenario of LIST_SCENARIOS) {
      const chip =
        scenario.category === undefined
          ? page.getByTestId("category-chip-all")
          : scenario.category === "Uncategorized"
            ? page.getByTestId("category-chip-uncategorized")
            : page.getByTestId(`category-chip-${categoryIdByName.get(scenario.category)}`);
      await chip.click();
      await expect(chip).toHaveAttribute("aria-pressed", "true");
      await page.getByTestId("search-input").fill(scenario.search ?? "");
      const adminResult = admin.get(scenario.label);
      if (!adminResult) throw new Error(`no Admin result recorded for ${scenario.label}`);
      await expect(page.getByTestId("inventory-summary"), scenario.label).toContainText(`Showing ${adminResult.shown} of ${total} items`);
      expect(await visibleItemIds(page, "item-card-"), `Inventory tab for ${scenario.label}`).toEqual(adminResult.ids);
    }
  });

  test("an item saved with a new category in Admin appears under that category on the Inventory tab", async ({ page }) => {
    const item = seedItem(THERMOMETER_COVERS);
    const api = await openAdmin(page);
    await openEditForm(page, item.id);
    await chooseCategory(page, "First Aid");
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: First Aid");
    await expectOrderSheetUntouched(page, "after saving an item in Admin");

    await page.goto("/?tab=inventory", { waitUntil: "domcontentloaded", timeout: 120_000 });
    await expect(page.getByTestId("inventory-summary")).toBeVisible({ timeout: SLOW_MS });
    const firstAid = page.getByTestId(`group-${categoryId(3)}`);
    await expect(firstAid.getByTestId(`item-card-${item.id}`)).toBeVisible();
    await expect(page.getByTestId("group-uncategorized").getByTestId(`item-card-${item.id}`)).toHaveCount(0);
    await expect(page.getByTestId("order-bar")).toHaveCount(0); // saving in Admin put nothing on the order sheet
    await expect(page.getByTestId(`order-checkbox-${item.id}`)).not.toBeChecked();
    expect(writes(api)).toEqual([`PUT /api/medications/${item.id}`]);
  });

  test("the category filter lists every category with the number of items it holds", async ({ page }) => {
    const items = buildMedications();
    await openAdmin(page);
    const labels = (await page.getByTestId("admin-category-filter").locator("option").allTextContents()).map((l) => l.replace(/\s+/g, " ").trim());
    expect(labels[0]).toBe(`All categories (${items.length})`);
    for (const [index, name] of CATEGORY_NAMES.entries()) {
      const count = items.filter((m) => m.category_id === categoryId(index)).length;
      expect(labels, `choice for ${name}`).toContain(`${name} (${count})`);
    }
    expect(labels).toContain(`Uncategorized (${items.filter((m) => m.category_id === null).length})`);
  });

  test("each row shows its category, its barcode and its supplier order number under separate labels", async ({ page }) => {
    const item = seedItem(ACETAMINOPHEN);
    const legacy = seedItem(THERMOMETER_COVERS);
    await openAdmin(page);

    await expect(page.getByTestId(`admin-category-${item.id}`)).toContainText(PAIN_AND_FEVER);
    const barcode = page.getByTestId(`admin-barcode-${item.id}`);
    const supplier = page.getByTestId(`admin-supplier-${item.id}`);
    await expect(barcode.locator("dt")).toHaveText("Barcode");
    await expect(barcode.locator("dd")).toHaveText(item.barcode);
    await expect(supplier.locator("dt")).toHaveText("Supplier order no.");
    await expect(supplier.locator("dd")).toHaveText("00417-B");
    const colorOf = (label: Locator): Promise<string> => label.evaluate((el) => getComputedStyle(el).color);
    expect(await colorOf(supplier.locator("dt")), "the Supplier order no. label must not look like the Barcode label").not.toBe(await colorOf(barcode.locator("dt")));

    await expect(page.getByTestId(`admin-category-${legacy.id}`)).toContainText("Uncategorized");
    await expect(page.getByTestId(`admin-supplier-${legacy.id}`).locator("dd")).toHaveText("Not set");
  });

  test("the search box names the supplier order number the way every label does, and finds an item by it", async ({ page }) => {
    const item = seedItem(ACETAMINOPHEN);
    await openAdmin(page);
    const search = page.getByTestId("admin-search");
    await expect(search).toHaveAttribute("placeholder", "Name, barcode or supplier order no.");

    await search.fill("00417-B");
    await expect(page.getByTestId(`admin-row-${item.id}`)).toBeVisible();
    expect(await visibleItemIds(page, "admin-row-")).toEqual([item.id]);
  });

  test("each applied filter shows as a removable chip: its x removes only that filter, Clear filters removes them all, and the filter controls follow", async ({ page }) => {
    const items = buildMedications();
    const total = items.length;
    await openAdmin(page);
    const summary = page.getByTestId("admin-summary");
    const search = page.getByTestId("admin-search");
    const chips = page.getByTestId("active-filters");

    // Ground truth from the fixtures: the category alone, the search alone and both together are three different lists
    const both = expectedIds(items, { categoryId: categoryId(0), search: "tablets" });
    const searchOnly = expectedIds(items, { search: "tablets" });
    const categoryOnly = expectedIds(items, { categoryId: categoryId(0) });
    expect(new Set([both.length, searchOnly.length, categoryOnly.length]).size, "the three lists must differ, or a stuck filter would go unnoticed").toBe(3);
    const applyBoth = async (): Promise<void> => {
      await filterAdminByCategory(page, PAIN_AND_FEVER);
      await search.fill("tablets");
      await expect(summary).toContainText(`Showing ${both.length} of ${total} items`);
    };

    // Nothing filtered: no chips, no Clear filters link, every item
    await expect(chips).toHaveCount(0);
    await expect(page.getByTestId("admin-clear-filters")).toHaveCount(0);
    expect(await visibleItemIds(page, "admin-row-")).toHaveLength(total);

    // Both on: one chip for each, saying what it is, in the order the summary names them
    await applyBoth();
    await expect(page.getByTestId("active-filter-category")).toHaveText("Category: Pain & Fever");
    await expect(page.getByTestId("active-filter-search")).toHaveText("Search: “tablets”");
    await expect(summary).toHaveText(`Showing ${both.length} of ${total} items · Category: Pain & Fever · Search “tablets”`);
    await expect(page.getByTestId("active-filter-remove-category")).toHaveAccessibleName("Remove filter Category: Pain & Fever");
    await expect(page.getByTestId("active-filter-remove-search")).toHaveAccessibleName("Remove filter Search: “tablets”");
    expect(await visibleItemIds(page, "admin-row-")).toEqual(both);

    // The x on the Category chip takes off the category only: the list grows to the search's results
    await page.getByTestId("active-filter-remove-category").click();
    await expect(page.getByTestId("active-filter-category")).toHaveCount(0);
    await expect(page.getByTestId("active-filter-search")).toHaveText("Search: “tablets”");
    await expect(summary).toHaveText(`Showing ${searchOnly.length} of ${total} items · Search “tablets”`);
    expect(await visibleItemIds(page, "admin-row-")).toEqual(searchOnly);
    expect(await chosenAdminFilter(page), "the category control agrees with the chips").toMatch(/^All categories/);
    await expect(search).toHaveValue("tablets");

    // The x on the Search chip takes off the rest: the whole inventory is back
    await page.getByTestId("active-filter-remove-search").click();
    await expect(chips).toHaveCount(0);
    await expect(search).toHaveValue("");
    await expect(summary).toHaveText(`Showing all ${total} items.`);
    expect(await visibleItemIds(page, "admin-row-")).toHaveLength(total);

    // The other way round: the x on the Search chip first leaves the category's whole list
    await applyBoth();
    await page.getByTestId("active-filter-remove-search").click();
    await expect(page.getByTestId("active-filter-search")).toHaveCount(0);
    await expect(summary).toHaveText(`Showing ${categoryOnly.length} of ${total} items · Category: Pain & Fever`);
    expect(await visibleItemIds(page, "admin-row-")).toEqual(categoryOnly);
    await expect(search).toHaveValue("");
    expect(await chosenAdminFilter(page)).toMatch(/^Pain & Fever/);

    // Clear filters takes off everything at once and puts the cursor in the search box
    await applyBoth();
    await page.getByTestId("admin-clear-filters").click();
    await expect(summary).toHaveText(`Showing all ${total} items.`);
    await expect(chips).toHaveCount(0);
    await expect(search).toHaveValue("");
    expect(await chosenAdminFilter(page)).toMatch(/^All categories/);
    expect(await visibleItemIds(page, "admin-row-")).toHaveLength(total);
    await expect(page.getByTestId("admin-clear-filters")).toHaveCount(0);
    await expect(search).toBeFocused();
  });

  test("a filter chip can be removed with the keyboard: focus moves to the next chip, then to the search box after the last one", async ({ page }) => {
    const total = buildMedications().length;
    await openAdmin(page);
    await filterAdminByCategory(page, PAIN_AND_FEVER);
    await page.getByTestId("admin-search").fill("tablets");
    await expect(page.getByTestId("active-filter-search")).toBeVisible();

    await page.getByTestId("active-filter-remove-category").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("active-filter-category")).toHaveCount(0);
    await expect(page.getByTestId("active-filter-remove-search")).toBeFocused(); // the neighbouring chip, not the top of the page

    await page.keyboard.press("Enter");
    await expect(page.getByTestId("active-filters")).toHaveCount(0);
    await expect(page.getByTestId("admin-search")).toBeFocused();
    await expect(page.getByTestId("admin-summary")).toHaveText(`Showing all ${total} items.`);
  });

  test("with the searchable category filter (11 or more categories) the chip's x and Clear filters reset the filter control as well", async ({ page }) => {
    const extra: Category[] = ["Vaccines", "Dental", "Eye care", "Lab supplies", "Skin care", "Sutures"].map((name, index) => ({
      id: fakeUuid(400 + index),
      name,
      created_at: null,
    }));
    const total = buildMedications().length;
    await openAdmin(page, { categories: [...buildCategories(), ...extra] });
    await expect(page.getByTestId("admin-category-filter")).toHaveAttribute("role", "combobox");
    const summary = page.getByTestId("admin-summary");

    await filterAdminByCategory(page, ANTIBIOTICS);
    await expect(page.getByTestId("active-filter-category")).toHaveText("Category: Antibiotics");
    expect(await chosenAdminFilter(page)).toMatch(/^Antibiotics/);
    await page.getByTestId("active-filter-remove-category").click();
    await expect(page.getByTestId("active-filters")).toHaveCount(0);
    expect(await chosenAdminFilter(page), "the searchable control shows All categories again").toMatch(/^All categories/);
    await expect(summary).toHaveText(`Showing all ${total} items.`);

    await filterAdminByCategory(page, PAIN_AND_FEVER);
    await expect(page.getByTestId("active-filter-category")).toHaveText("Category: Pain & Fever");
    await page.getByTestId("admin-clear-filters").click();
    await expect(page.getByTestId("active-filters")).toHaveCount(0);
    expect(await chosenAdminFilter(page)).toMatch(/^All categories/);
    await expect(summary).toHaveText(`Showing all ${total} items.`);
  });

  test("a realistic inventory of 150 items is listed completely and in name order, never cut short or reversed", async ({ page }) => {
    const items = [...buildMedications(), ...buildManyMedications(123)]; // 27 + 123 = 150 (the live inventory has 128)
    await openAdmin(page, { medications: items });

    await expect(page.getByTestId("admin-summary")).toHaveText("Showing all 150 items.");
    await expect(page.getByRole("heading", { name: /^All Medications/ })).toContainText("(150)");
    expect(await visibleItemIds(page, "admin-row-")).toHaveLength(150);

    // Named items in natural name order (Item 2 before Item 10), items without a name last, ordered by barcode: computed here, not read from the page
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const expectedOrder = [...items]
      .sort((a, b) => {
        if (a.name === null) return b.name === null ? collator.compare(a.barcode, b.barcode) : 1;
        if (b.name === null) return -1;
        return collator.compare(a.name, b.name);
      })
      .map((m) => m.id);
    expect(await adminRowIdsInOrder(page)).toEqual(expectedOrder);
  });

  test("a photo that cannot be loaded falls back to the item's initials instead of a broken image, and a photo that loads is shown", async ({ page }) => {
    const aspirin = seedItem(ASPIRIN); // "Aspirin 81 mg, chewable": initials A8
    const ibuprofen = seedItem(IBUPROFEN);
    await page.route("https://photos.invalid/**", (route) => route.abort("failed")); // an address that never answers
    await openAdmin(page, {
      medications: buildMedications().map((m) =>
        m.id === aspirin.id ? { ...m, photo_url: "https://photos.invalid/aspirin.png" } : m.id === ibuprofen.id ? { ...m, photo_url: PHOTO_ORIGINAL } : m
      ),
    });

    const broken = page.getByTestId(`admin-row-${aspirin.id}`);
    await expect(broken).toBeVisible();
    await expect(broken.locator("img"), "no broken picture is left in the row").toHaveCount(0);
    await expect(broken.locator('[aria-hidden="true"]').filter({ hasText: /^A8$/ }), "the initials stand in for the picture").toHaveCount(1);
    await expect(broken).toContainText("Aspirin 81 mg, chewable"); // the name is there either way

    await expect(page.getByTestId(`admin-row-${ibuprofen.id}`).locator("img")).toHaveCount(1);
  });

  test("a category with no items, a search with no match and an empty inventory each say what is going on and offer a way out", async ({ page }) => {
    const categories: Category[] = [...buildCategories(), { id: fakeUuid(50), name: "Vaccines", created_at: null }];
    const api = await openAdmin(page, { categories });
    const total = api.medications.length;
    const empty = page.getByTestId("admin-empty");

    await filterAdminByCategory(page, "Vaccines");
    await expect(empty).toHaveAttribute("data-empty-kind", "category-empty");
    await expect(empty).toContainText("No items in Vaccines yet.");

    await filterAdminByCategory(page, "All categories");
    await page.getByTestId("admin-search").fill("zzz-no-such-item");
    await expect(empty).toHaveAttribute("data-empty-kind", "no-match");
    await expect(empty).toContainText("No items match");
    await expect(empty).not.toContainText("No medications yet");
    await expect(page.getByTestId("admin-summary")).toContainText(`Showing 0 of ${total} items`);

    await page.getByTestId("admin-empty-clear-filters").click();
    await expect(page.getByTestId("admin-summary")).toHaveText(`Showing all ${total} items.`);
    await expect(page.getByTestId("admin-search")).toHaveValue("");
    await expect(empty).toHaveCount(0);
  });

  test("an empty inventory says so and offers to add the first item", async ({ page }) => {
    await openAdmin(page, { medications: [] });
    const empty = page.getByTestId("admin-empty");
    await expect(empty).toHaveAttribute("data-empty-kind", "no-items");
    await expect(empty).toContainText("No medications yet.");
    await empty.getByRole("button", { name: "Add medication" }).click();
    await expect(page.getByTestId("admin-form")).toBeVisible();
    await expect(page.getByRole("heading", { name: "New Medication" })).toBeFocused();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 5. Unnamed items, new categories, photos
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe("Admin: unnamed items, new categories and photos", () => {
  test("an unnamed (barcode-only) item can be completed with a name, category and supplier number, and leaves the review section", async ({ page }) => {
    const unnamed = buildMedications().find((m) => m.is_unnamed);
    if (!unnamed) throw new Error("the fixtures have no unnamed item");
    const api = await openAdmin(page);
    const review = page.getByTestId("admin-unnamed-section");
    await expect(review).toContainText("1 unnamed item needs review");
    await expect(review).toContainText(unnamed.barcode);
    await expect(page.getByTestId(`admin-row-${unnamed.id}`)).toContainText("Needs review");

    await page.getByTestId(`admin-complete-${unnamed.id}`).click();
    await expect(page.getByRole("heading", { name: `Complete unnamed item: ${unnamed.barcode}` })).toBeFocused();
    await expect(page.getByText("This barcode was auto-created from a scan.")).toBeVisible();
    await expect(page.getByTestId("barcode-input")).toHaveValue(unnamed.barcode);
    await expect(page.getByTestId("name-input")).toHaveValue("");
    await expect(page.getByTestId("supplier-order-number-input")).toHaveValue("");
    expect(await chosenCategory(page)).toBe(UNCATEGORIZED);

    await fillItemForm(page, { name: "Ondansetron 4 mg, ODT", category: ANTIBIOTICS, supplier: "0092" });
    await saveItem(page);

    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Antibiotics · Supplier order no.: 0092");
    await expect(review).toHaveCount(0);
    const row = stored(api, unnamed.id);
    expect(row.is_unnamed).toBe(false);
    expect(row.name).toBe("Ondansetron 4 mg, ODT");
    expect(row.category_id).toBe(categoryId(2));
    expect(row.supplier_order_number).toBe("0092");
    expect(row.barcode).toBe(unnamed.barcode);
    expect(writes(api)).toEqual([`PUT /api/medications/${unnamed.id}`]);
    await expectOrderSheetUntouched(page, "after completing an unnamed item");
    await expect(page.getByTestId(`admin-row-${unnamed.id}`)).not.toContainText("Needs review");
    await expect(page.getByTestId(`admin-category-${unnamed.id}`)).toContainText("Antibiotics");
    // The Complete button is gone, so keyboard focus goes to the item's Edit button instead of being lost
    await expect(page.getByTestId(`admin-edit-${unnamed.id}`)).toBeFocused();
  });

  for (const shape of SHAPES) {
    test(`a new category can be created inline: it is listed in order, selected and saved with the item; a duplicate name selects the existing one (${shape} ids)`, async ({ page }) => {
      const aspirin = seedItem(ASPIRIN, shape);
      const ibuprofen = seedItem(IBUPROFEN, shape);
      const api = await openAdmin(page, { shape });

      await openEditForm(page, aspirin.id);
      await chooseCategory(page, CREATE_NEW);
      await expect(page.getByTestId("new-category-input")).toBeFocused();
      await expect(page.getByTestId("new-category-save")).toBeDisabled(); // nothing typed yet
      await page.getByTestId("new-category-input").fill("Vaccines");
      await page.getByTestId("new-category-save").click();

      await expect(page.getByTestId("category-note")).toContainText("Vaccines");
      expect(await chosenCategory(page)).toBe("Vaccines");
      const created = api.categories.find((c) => c.name === "Vaccines");
      expect(created).toBeDefined();
      expect(typeof created?.id).toBe("string");
      const names = (await categoryChoices(page)).slice(1, -1);
      expect(names).toContain("Vaccines");
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })));
      await saveItem(page);
      await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Vaccines");
      expect(lastBody(api, "PUT", PUT_ITEM(aspirin.id)).category_id).toBe(created?.id);
      expect(stored(api, aspirin.id).category_id).toBe(created?.id);

      // The same name in another letter case does not make a second category: the existing one is selected
      await openEditForm(page, ibuprofen.id);
      await chooseCategory(page, CREATE_NEW);
      await page.getByTestId("new-category-input").fill("antibiotics");
      await page.getByTestId("new-category-input").press("Enter");
      await expect(page.getByTestId("category-note")).toContainText("already exists");
      expect(await chosenCategory(page)).toBe(ANTIBIOTICS);
      expect(api.categories.filter((c) => c.name.toLowerCase() === "antibiotics")).toHaveLength(1);
    });
  }

  test("a half-typed new category is never silently dropped by saving the item, and cancelling restores the previous category", async ({ page }) => {
    const item = seedItem(ACETAMINOPHEN);
    const api = await openAdmin(page);
    await openEditForm(page, item.id);

    await chooseCategory(page, CREATE_NEW);
    await page.getByTestId("new-category-input").fill("Half typed");
    await saveItem(page);
    await expect(page.getByTestId("category-error")).toContainText("Save the new category first");
    expect(api.requestsTo("PUT", PUT_ITEM(item.id))).toHaveLength(0);
    expect(api.categories.some((c) => c.name === "Half typed")).toBe(false);

    await page.getByTestId("new-category-cancel").click();
    await expect(page.getByTestId("new-category-input")).toHaveCount(0);
    expect(await chosenCategory(page)).toBe(PAIN_AND_FEVER); // the item's own category is back, not cleared

    // Nothing else was changed, so there is nothing to save: no request, and the message says so
    await saveItem(page);
    await expect(page.getByTestId("admin-info")).toContainText("No changes to save.");
    expect(api.requestsTo("PUT", PUT_ITEM(item.id))).toHaveLength(0);

    // With another field changed the save goes through, and the category it did not touch stays exactly as it was
    await fillItemForm(page, { notes: "Saved after cancelling the new category" });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Pain & Fever");
    expect(lastBody(api, "PUT", PUT_ITEM(item.id))).toEqual({ notes: "Saved after cancelling the new category" });
    expect(stored(api, item.id).category_id).toBe(categoryId(0));
  });

  test("with 11 or more categories the category field becomes a searchable list that works with the mouse and the keyboard", async ({ page }) => {
    const extra: Category[] = ["Vaccines", "Dental", "Eye care", "Lab supplies", "Skin care", "Sutures"].map((name, index) => ({
      id: fakeUuid(200 + index),
      name,
      created_at: null,
    }));
    const categories = [...buildCategories(), ...extra];
    expect(categories.length).toBeGreaterThanOrEqual(11);
    const item = seedItem(ACETAMINOPHEN);
    const api = await openAdmin(page, { categories });

    await openEditForm(page, item.id);
    const control = page.getByTestId("category-select");
    await expect(control).toHaveAttribute("role", "combobox");
    expect(await chosenCategory(page)).toBe(PAIN_AND_FEVER);

    await chooseCategory(page, "Dental"); // by mouse
    expect(await chosenCategory(page)).toBe("Dental");

    await control.click(); // by typing and keys
    await control.fill("sut");
    await expect(page.getByTestId("category-select-listbox").getByRole("option")).toHaveText(["Sutures", CREATE_NEW]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect(await chosenCategory(page)).toBe("Sutures");
    expect(api.requestsTo("PUT", PUT_ITEM(item.id))).toHaveLength(0); // Enter in the list never submits the form

    await control.click();
    await control.fill("zzzz");
    await expect(page.getByTestId("category-select-empty")).toContainText("No categories match");
    await control.press("Escape");
    expect(await chosenCategory(page)).toBe("Sutures"); // leaving the search keeps the choice

    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Sutures");
    expect(lastBody(api, "PUT", PUT_ITEM(item.id)).category_id).toBe(fakeUuid(205));
    expect(stored(api, item.id).category_id).toBe(fakeUuid(205));

    // The list's own category filter is searchable as well
    await filterAdminByCategory(page, "Vaccines");
    await expect(page.getByTestId("admin-empty")).toContainText("No items in Vaccines yet.");
  });

  test("a photo can be attached and shows as a thumbnail; an upload error is reported and the upload can be retried", async ({ page }) => {
    const item = seedItem(ASPIRIN);
    const api = await openAdmin(page);
    await openEditForm(page, item.id);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    api.failNext({ method: "POST", path: /\/api\/upload$/, status: 413, body: { error: "The photo is too large (limit 5 MB)." } });

    await page.getByTestId("photo-input").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: png });
    await expect(page.getByTestId("admin-photo-error")).toContainText("The photo is too large");
    await page.getByTestId("photo-input").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: png }); // the same file again
    await expect(page.getByTestId("admin-photo-error")).toHaveCount(0);
    await expect(page.getByText("Photo attached.")).toBeVisible();

    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toBeVisible();
    expect(String(lastBody(api, "PUT", PUT_ITEM(item.id)).photo_url)).toMatch(/^data:image\/svg\+xml/);
    expect(stored(api, item.id).photo_url).toMatch(/^data:image\/svg\+xml/);
    await expect(page.getByTestId(`admin-row-${item.id}`).locator("img")).toHaveCount(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 6. Keyboard use, focus and accessible names
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/** Moves a native select to a choice using only the arrow keys. */
async function chooseCategoryWithArrowKeys(page: Page, name: string): Promise<void> {
  for (let presses = 0; presses < 20; presses += 1) {
    if ((await chosenCategory(page)) === name) return;
    await page.keyboard.press("ArrowDown");
  }
  throw new Error(`The category "${name}" could not be reached with the arrow keys.`);
}

const FORM_TAB_ORDER = [
  "name-input",
  "barcode-input",
  "supplier-order-number-input",
  "category-select",
  "unit-input",
  "stock-input",
  "threshold-input",
  "vendor-url-input",
  "notes-input",
  "photo-input",
  "cancel-button",
  "save-button",
] as const;

test.describe("Admin: keyboard use and focus", () => {
  test("the whole new-item form can be completed and saved with the keyboard alone, and a scanner's Enter does not save early", async ({ page }) => {
    const problems = watchRuntimeErrors(page);
    const api = await openAdmin(page);

    await page.getByTestId("admin-add-button").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "New Medication" })).toBeFocused(); // focus moves into the form

    const stops: string[] = [];
    const tab = async (): Promise<void> => {
      await page.keyboard.press("Tab");
      stops.push(await focusedElement(page));
    };

    await tab();
    await page.keyboard.type("Keyboard test item");
    await tab();
    await page.keyboard.type("0055001122");
    await page.keyboard.press("Enter"); // what a barcode scanner sends after the digits
    await expect(page.getByTestId("admin-form")).toBeVisible();
    expect(api.requestsTo("POST", POST_ITEM)).toHaveLength(0);
    await tab();
    await page.keyboard.type("AX-1182/4");
    await tab();
    await chooseCategoryWithArrowKeys(page, ANTIBIOTICS);
    await tab();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("boxes");
    await tab();
    await page.keyboard.type("12");
    await tab();
    await page.keyboard.type("5");
    for (let skipped = 0; skipped < 5; skipped += 1) await tab(); // vendor URL, notes, photo, Cancel, Save
    expect(stops).toEqual([...FORM_TAB_ORDER]);

    await page.keyboard.press("Enter"); // Enter on the focused Save button saves
    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Antibiotics · Supplier order no.: AX-1182/4");
    const body = lastBody(api, "POST", POST_ITEM);
    expect(body).toMatchObject({
      name: "Keyboard test item",
      barcode: "0055001122",
      supplier_order_number: "AX-1182/4",
      category_id: categoryId(2),
      unit: "boxes",
      stock: 12,
      threshold: 5,
    });
    expect(api.requestsTo("POST", POST_ITEM)).toHaveLength(1);
    expect(storedByBarcode(api, "0055001122")).toMatchObject({
      name: "Keyboard test item",
      supplier_order_number: "AX-1182/4",
      category_id: categoryId(2),
      unit: "boxes",
      stock: 12,
      threshold: 5,
    });
    expect(writes(api)).toEqual(["POST /api/medications"]);
    await expectOrderSheetUntouched(page, "after saving with the keyboard");
    expect(await focusedElement(page)).toBe("admin-add-button"); // focus is not lost when the form closes
    expect(problems).toEqual([]);
  });

  test("keyboard focus lands on the form when it opens and returns to the item's Edit button after Cancel and after Save", async ({ page }) => {
    const item = seedItem(IBUPROFEN);
    const api = await openAdmin(page);
    const edit = page.getByTestId(`admin-edit-${item.id}`);

    await edit.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: /^Edit: Ibuprofen/ })).toBeFocused();

    await page.getByTestId("cancel-button").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("admin-form")).toHaveCount(0);
    await expect(edit).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: /^Edit: Ibuprofen/ })).toBeFocused();
    await fillItemForm(page, { supplier: "0093" });
    await page.getByTestId("save-button").focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("admin-success")).toContainText("Supplier order no.: 0093");
    await expect(edit).toBeFocused();
    await expect(page.getByTestId(`admin-saved-${item.id}`)).toBeVisible(); // the row repeats "Saved" where the focus is
    expect(stored(api, item.id).supplier_order_number).toBe("0093");
  });

  test("every form control shows a visible focus indicator when reached with the Tab key", async ({ page }) => {
    await openAdmin(page);
    await page.getByTestId("admin-add-button").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "New Medication" })).toBeFocused();

    const withoutIndicator: string[] = [];
    for (const expected of FORM_TAB_ORDER) {
      await page.keyboard.press("Tab");
      expect(await focusedElement(page)).toBe(expected);
      if (!(await hasVisibleFocusIndicator(page.locator(":focus")))) withoutIndicator.push(expected);
    }
    expect(withoutIndicator, "controls that show nothing when focused").toEqual([]);
  });

  test("every control of the form and of the list has an accessible name that says what it is", async ({ page }) => {
    const item = seedItem(ACETAMINOPHEN);
    await openAdmin(page);

    await expect(page.getByTestId("admin-search")).toHaveAccessibleName(/Search/);
    await expect(page.getByTestId("admin-category-filter")).toHaveAccessibleName(/Filter by category/);
    await expect(page.getByTestId(`admin-edit-${item.id}`)).toHaveAccessibleName("Edit");
    await expect(page.getByTestId(`admin-edit-${item.id}`)).toHaveAccessibleDescription(/Acetaminophen 500 mg/);
    await expect(page.getByTestId(`admin-delete-${item.id}`)).toHaveAccessibleDescription(/Acetaminophen 500 mg/);

    await openEditForm(page, item.id);
    const names: ReadonlyArray<readonly [string, RegExp]> = [
      ["name-input", /^Name/],
      ["barcode-input", /Barcode/],
      ["supplier-order-number-input", /Supplier order number/],
      ["category-select", /^Category/],
      ["unit-input", /^Unit/],
      ["stock-input", /Current Stock/],
      ["threshold-input", /Low-Stock Threshold/],
      ["vendor-url-input", /Vendor URL/],
      ["notes-input", /^Notes/],
      ["photo-input", /^Photo/],
    ];
    for (const [testId, name] of names) {
      await expect(page.getByTestId(testId), testId).toHaveAccessibleName(name);
    }
    await expect(page.getByRole("button", { name: "Save Changes" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 7. Phone width (usable on the supported screen sizes)
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe("Admin: phone width", () => {
  for (const width of [390, 360]) {
    test(`at ${width}px wide the list, the open form, an error and a saved message never scroll sideways`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const item = seedItem(ACETAMINOPHEN);
      const api = await openAdmin(page);
      await expectNoHorizontalScroll(page, "the list");

      await openEditForm(page, item.id);
      await expectNoHorizontalScroll(page, "the edit form");

      api.failNext({
        method: "PUT",
        path: PUT_ITEM(item.id),
        status: 403,
        body: { error: "The database refused this change (row-level security). Apply the categories access migration, then try again.", code: "42501", detail: "new row violates row-level security policy for table medications" },
      });
      await fillItemForm(page, { supplier: "00417-C" });
      await saveItem(page);
      await expect(page.getByTestId("admin-error")).toBeFocused();
      await expect(page.getByTestId("admin-error")).toBeInViewport(); // the person is looking at the message, not somewhere above it
      await expectNoHorizontalScroll(page, "the form with an error");

      await saveItem(page);
      await expect(page.getByTestId("admin-success")).toBeVisible();
      await expectNoHorizontalScroll(page, "after saving");
      await openNewItemForm(page);
      await expectNoHorizontalScroll(page, "the new-item form");
    });
  }

  test("very long names, codes, categories and units wrap instead of widening the page on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const longCategory: Category = { id: fakeUuid(77), name: "C".repeat(60), created_at: null };
    const [first, ...rest] = buildMedications();
    const extreme: Medication = {
      ...first,
      name: "N".repeat(113),
      barcode: "9".repeat(128),
      supplier_order_number: "S".repeat(64),
      unit: "W".repeat(40),
      category_id: longCategory.id,
      notes: "x".repeat(300),
      vendor_url: `https://supplier.example/${"p".repeat(120)}`,
    };
    const api = await openAdmin(page, { medications: [extreme, ...rest], categories: [longCategory, ...buildCategories()] });
    await expectNoHorizontalScroll(page, "the list with unbroken long values"); // no sideways scroll AND nothing cut off by a box

    // Every long value is intact in the page AND readable in full on screen: inside the window, inside every box around it, and
    // spread over several lines. None of these fits on one 390px line, so a single line would mean it was NOT wrapped.
    const row = page.getByTestId(`admin-row-${extreme.id}`);
    const supplierCode = page.getByTestId(`admin-supplier-${extreme.id}`).locator("dd");
    await expect(supplierCode).toHaveText("S".repeat(64));
    await expectReadableInFull(supplierCode, "the 64-character supplier order number", { minLines: 2 });
    await expectReadableInFull(page.locator(`#admin-name-${extreme.id}`), "the 113-character name", { minLines: 2 });
    await expectReadableInFull(page.getByTestId(`admin-barcode-${extreme.id}`).locator("dd"), "the 128-character barcode", { minLines: 2 });
    await expectReadableInFull(page.getByTestId(`admin-category-${extreme.id}`), "the 60-character category tag", { minLines: 2 });
    await expectReadableInFull(row.locator("p", { hasText: "W".repeat(40) }), "the 40-character unit", { minLines: 2 });

    await openEditForm(page, extreme.id);
    await expectNoHorizontalScroll(page, "the edit form with unbroken long values");

    api.failNext({ method: "PUT", path: PUT_ITEM(extreme.id), status: 500, body: { error: `Unexpected database error ${"E".repeat(150)}`, code: "XX000", detail: "D".repeat(150) } });
    await fillItemForm(page, { notes: "changed" });
    await saveItem(page);
    await expect(page.getByTestId("admin-error")).toBeVisible();
    await expectNoHorizontalScroll(page, "an error that quotes a very long unbroken message");
    await expectReadableInFull(page.getByTestId("admin-error"), "the error that quotes a 150-character unbroken message", { minLines: 2 });

    await saveItem(page); // the retry works: the saved message names the 113-character item and its 60-character category
    await expect(page.getByTestId("admin-success")).toBeVisible();
    await expectNoHorizontalScroll(page, "the saved message with a very long name and category");
    await expectReadableInFull(page.getByTestId("admin-success"), "the saved message with a 113-character name", { minLines: 2 });
  });

  test("the length messages fit a 360px-wide phone: nothing scrolls sideways and each message can be read in full", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 844 });
    const item = seedItem(ASPIRIN);
    await openAdmin(page);
    await openEditForm(page, item.id);

    await pasteInto(page, "supplier-order-number-input", "0123456789".repeat(7));
    await pasteInto(page, "unit-input", "u".repeat(41));
    await expectNoHorizontalScroll(page, "the form with two length messages");
    await expectReadableInFull(page.getByTestId("problem-supplier-order-number"), "the supplier order number message");
    await expectReadableInFull(page.getByTestId("problem-unit"), "the unit message");

    await chooseCategory(page, CREATE_NEW);
    await pasteInto(page, "new-category-input", "C".repeat(61));
    await expectNoHorizontalScroll(page, "the new-category box with a length message");
    await expectReadableInFull(page.getByTestId("problem-new-category"), "the category name message");
  });

  test("buttons and fields are at least 40px tall on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const item = seedItem(ACETAMINOPHEN);
    await openAdmin(page);

    const small: string[] = [];
    const measure = async (label: string, testId: string): Promise<void> => {
      const box = await page.getByTestId(testId).boundingBox();
      if (!box || box.height < 40) small.push(`${label}: ${box ? Math.round(box.height) : "not on screen"}px`);
    };
    for (const testId of ["admin-add-button", "admin-search", "admin-category-filter", `admin-edit-${item.id}`, `admin-delete-${item.id}`]) {
      await measure(testId, testId);
    }
    await openEditForm(page, item.id);
    for (const testId of ["name-input", "barcode-input", "supplier-order-number-input", "category-select", "unit-input", "stock-input", "threshold-input", "vendor-url-input", "cancel-button", "save-button"]) {
      await measure(testId, testId);
    }
    expect(small, "controls shorter than 40px").toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 8. The category defect, with locators that work on ANY build of the page (roles, labels, visible text only)
//    On an older page that turns the category into a number these fail: the chosen category is saved as null while the
//    page says "Medication updated."
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe("Regression for the original defect (build-independent locators)", () => {
  async function openEditByVisibleName(page: Page, name: string): Promise<void> {
    const row = page
      .locator("li, div")
      .filter({ has: page.getByText(name, { exact: true }) })
      .filter({ has: page.getByRole("button", { name: "Edit", exact: true }) })
      .last();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.getByRole("button", { name: "Edit", exact: true }).click();
  }

  test("the category chosen in the edit form is the category that is sent, stored and listed", async ({ page }) => {
    const aspirin = seedItem(ASPIRIN);
    const api = await installMockApi(page);
    await page.goto("/admin", { waitUntil: "domcontentloaded", timeout: 120_000 });

    await openEditByVisibleName(page, "Aspirin 81 mg, chewable");
    await page.locator("form select").selectOption({ label: ANTIBIOTICS });
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect.poll(() => api.requestsTo("PUT", PUT_ITEM(aspirin.id)).length, { timeout: 15_000 }).toBe(1);

    const sent = lastBody(api, "PUT", PUT_ITEM(aspirin.id));
    expect(sent.category_id, "the category id the page sent").toBe(categoryId(2));
    expect(stored(api, aspirin.id).category_id, "the category stored").toBe(categoryId(2));
    await expect(page.getByText(ANTIBIOTICS, { exact: true }).first()).toBeVisible(); // listed under its category
  });

  test("choosing a category never makes the page print NaN", async ({ page }) => {
    await installMockApi(page);
    await page.goto("/admin", { waitUntil: "domcontentloaded", timeout: 120_000 });
    await openEditByVisibleName(page, "Aspirin 81 mg, chewable");
    await page.locator("form select").selectOption({ label: ANTIBIOTICS });
    await expect(page.locator("body")).not.toContainText("NaN");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 9. Loading, partial failures and double clicks
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe("Admin: loading, partial failures and double clicks", () => {
  test("while the list is loading the page says so and never claims there are no medications", async ({ page }) => {
    await installMockApi(page, { latencyMs: 1500 });
    await page.goto("/admin", { waitUntil: "domcontentloaded", timeout: 120_000 });

    const loading = page.getByTestId("admin-loading");
    await expect(loading).toBeVisible({ timeout: SLOW_MS });
    await expect(loading).toContainText("Loading medications");
    await expect(page.getByText("No medications yet.")).toHaveCount(0);
    await expect(page.getByTestId("admin-empty")).toHaveCount(0);

    await expect(page.getByTestId("admin-summary")).toBeVisible({ timeout: SLOW_MS });
    await expect(loading).toHaveCount(0);
  });

  test("when the category list fails to load, a warning with Retry explains it, items keep their category, and Retry brings the names back", async ({ page }) => {
    const item = seedItem(ACETAMINOPHEN);
    const api = await openAdmin(page, {
      beforeLoad: (mock) =>
        mock.failNext({ method: "GET", path: /\/api\/categories$/, status: 503, body: { error: "Can’t reach the database. Check the connection, and that the Supabase project isn’t paused." } }),
    });
    const warning = page.getByTestId("admin-categories-error");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Categories could not be loaded");
    await expect(warning).toContainText("Can’t reach the database.");
    await expect(page.getByTestId("admin-summary")).toHaveText(`Showing all ${api.medications.length} items.`); // nothing is hidden
    await expect(page.getByTestId(`admin-category-${item.id}`)).toContainText("Category unavailable");

    await openEditForm(page, item.id);
    expect(await chosenCategory(page)).toBe("Current category (name unavailable)");
    await fillItemForm(page, { notes: "edited while the category names were unavailable" });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toBeVisible();
    expect(lastBody(api, "PUT", PUT_ITEM(item.id))).toEqual({ notes: "edited while the category names were unavailable" });
    expect(stored(api, item.id).category_id).toBe(item.category_id);

    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(warning).toHaveCount(0);
    await expect(page.getByTestId(`admin-category-${item.id}`)).toContainText(PAIN_AND_FEVER);
  });

  test("while categories are unreadable every item is still listed, labelled Category unavailable, and can be filtered", async ({ page }) => {
    const items = buildMedications();
    const categorized = items.filter((m) => m.category_id !== null).length;
    const uncategorized = items.length - categorized;
    await openAdmin(page, { categoriesBlocked: true });

    await expect(page.getByTestId("admin-summary")).toHaveText(`Showing all ${items.length} items.`);
    expect(await visibleItemIds(page, "admin-row-")).toHaveLength(items.length);
    await expect(page.getByTestId(`admin-category-${seedItem(ACETAMINOPHEN).id}`)).toContainText("Category unavailable");

    await filterAdminByCategory(page, "Category unavailable");
    await expect(page.getByTestId("admin-summary")).toContainText(`Showing ${categorized} of ${items.length} items`);
    expect(await visibleItemIds(page, "admin-row-")).toHaveLength(categorized);

    await filterAdminByCategory(page, "Uncategorized");
    await expect(page.getByTestId("admin-summary")).toContainText(`Showing ${uncategorized} of ${items.length} items`);
    expect(await visibleItemIds(page, "admin-row-")).toHaveLength(uncategorized);
  });

  test("saving an item that was deleted in the meantime says so, keeps what was typed and refreshes the list", async ({ page }) => {
    const item = seedItem(IBUPROFEN);
    const api = await openAdmin(page);
    await openEditForm(page, item.id);
    api.medications.splice(api.medications.findIndex((m) => m.id === item.id), 1); // someone else deletes it

    await fillItemForm(page, { notes: "too late" });
    await saveItem(page);

    const alert = page.getByTestId("admin-error");
    await expect(alert).toContainText("Item not found");
    await expect(alert).toBeFocused();
    await expect(page.getByTestId("admin-success")).toHaveCount(0);
    await expect(page.getByTestId("notes-input")).toHaveValue("too late");
    await expect(page.getByTestId(`admin-row-${item.id}`)).toHaveCount(0); // the list behind the form was refreshed
  });

  test("a list refresh that fails right after a successful save keeps every item on screen, says the list may be out of date, and Retry clears the warning", async ({ page }) => {
    const item = seedItem(IBUPROFEN);
    const api = await openAdmin(page);
    const total = api.medications.length;
    const message = "Can’t reach the database. Check the connection, and that the Supabase project isn’t paused.";
    // The save itself works; the list that is read back right after it does not.
    api.failNext({ method: "GET", path: /\/api\/medications$/, status: 503, body: { error: message } });

    await openEditForm(page, item.id);
    await fillItemForm(page, { notes: "Saved while the list refresh fails" });
    await saveItem(page);

    // The save is confirmed, and it really is in the database
    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Pain & Fever · Supplier order no.: 0092");
    expect(stored(api, item.id).notes).toBe("Saved while the list refresh fails");

    // The failed refresh is reported, and the inventory does not look gone
    const warning = page.getByTestId("admin-refresh-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("The list could not be refreshed");
    await expect(warning).toContainText(message);
    await expect(warning).toContainText("The list below may be out of date.");
    await expect(warning.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByTestId("admin-empty")).toHaveCount(0);
    await expect(page.getByText("No medications yet.")).toHaveCount(0);
    await expect(page.getByTestId("admin-load-error")).toHaveCount(0);
    await expect(page.getByTestId("admin-summary")).toHaveText(`Showing all ${total} items.`);
    expect(await visibleItemIds(page, "admin-row-")).toHaveLength(total);
    await expect(page.getByTestId(`admin-row-${item.id}`)).toBeVisible();

    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(warning).toHaveCount(0);
    await expect(page.getByTestId("admin-summary")).toHaveText(`Showing all ${total} items.`);
    expect(await visibleItemIds(page, "admin-row-")).toHaveLength(total);
  });

  test("pressing Save twice quickly saves the item once", async ({ page }) => {
    const api = await installMockApi(page, { latencyMs: 600 });
    await gotoAdmin(page);
    await openNewItemForm(page);
    await fillItemForm(page, { name: "Double click item", barcode: "0099001130", category: ANTIBIOTICS });

    await page.getByTestId("save-button").dblclick();
    await expect(page.getByTestId("admin-success")).toBeVisible();
    await expect(page.getByTestId("admin-error")).toHaveCount(0);
    expect(api.requestsTo("POST", POST_ITEM)).toHaveLength(1);
    expect(api.medications.filter((m) => m.barcode === "0099001130")).toHaveLength(1);
    expect(writes(api)).toEqual(["POST /api/medications"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 10. Forms never leak into each other; a filtered list follows a category change
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe("Admin: one form at a time, and a filtered list that follows a change", () => {
  test("opening another item while a form is open shows that item's own values and saves nothing into the other item", async ({ page }) => {
    const first = seedItem(IBUPROFEN);
    const second = seedItem(AMOXICILLIN);
    const api = await openAdmin(page);

    await openEditForm(page, first.id);
    await fillItemForm(page, { notes: "typed for ibuprofen only", supplier: "IBU-TYPED", category: ANTIBIOTICS });

    await page.getByTestId(`admin-edit-${second.id}`).click(); // without saving or cancelling the first one
    await expect(page.getByRole("heading", { name: /^Edit: Amoxicillin/ })).toBeVisible();
    await expect(page.getByTestId("barcode-input")).toHaveValue(second.barcode);
    await expect(page.getByTestId("supplier-order-number-input")).toHaveValue("AMX-500");
    await expect(page.getByTestId("notes-input")).toHaveValue("");
    expect(await chosenCategory(page)).toBe(ANTIBIOTICS);

    await fillItemForm(page, { notes: "typed for amoxicillin" });
    await saveItem(page);
    await expect(page.getByTestId("admin-success")).toBeVisible();
    expect(stored(api, second.id).notes).toBe("typed for amoxicillin");
    expect(stored(api, second.id).supplier_order_number).toBe("AMX-500");
    const untouched = stored(api, first.id);
    expect(untouched.notes).toBeNull();
    expect(untouched.supplier_order_number).toBe("0092");
    expect(untouched.category_id).toBe(categoryId(0));
    expect(writes(api)).toEqual([`PUT /api/medications/${second.id}`]);
  });

  test("a cancelled new-item form leaves nothing behind in the next one", async ({ page }) => {
    const api = await openAdmin(page);
    const before = api.medications.length;

    await openNewItemForm(page);
    await fillItemForm(page, { name: "Abandoned draft", barcode: "0099001131", supplier: "DRAFT-1", category: ANTIBIOTICS, notes: "never saved" });
    await page.getByTestId("cancel-button").click();
    await expect(page.getByTestId("admin-form")).toHaveCount(0);

    await openNewItemForm(page);
    await expect(page.getByTestId("name-input")).toHaveValue("");
    await expect(page.getByTestId("barcode-input")).toHaveValue("");
    await expect(page.getByTestId("supplier-order-number-input")).toHaveValue("");
    await expect(page.getByTestId("notes-input")).toHaveValue("");
    expect(await chosenCategory(page)).toBe(UNCATEGORIZED);
    expect(api.medications).toHaveLength(before);
    expect(writes(api)).toEqual([]);
  });

  test("giving an item a category while the list is filtered to Uncategorized moves it out of the list, updates the count and keeps keyboard focus on the page", async ({ page }) => {
    const items = buildMedications();
    const legacy = seedItem(THERMOMETER_COVERS);
    const uncategorized = items.filter((m) => m.category_id === null).length;
    const api = await openAdmin(page);

    await filterAdminByCategory(page, "Uncategorized");
    await expect(page.getByTestId("admin-summary")).toHaveText(`Showing ${uncategorized} of ${items.length} items · Category: Uncategorized`);
    await expect(page.getByTestId(`admin-row-${legacy.id}`)).toBeVisible();

    await openEditForm(page, legacy.id);
    await chooseCategory(page, "First Aid");
    await saveItem(page);

    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: First Aid");
    await expect(page.getByTestId(`admin-row-${legacy.id}`)).toHaveCount(0); // it no longer belongs in this list
    await expect(page.getByTestId("admin-summary")).toHaveText(`Showing ${uncategorized - 1} of ${items.length} items · Category: Uncategorized`);
    expect(stored(api, legacy.id).category_id).toBe(categoryId(3));
    expect(await focusedElement(page)).not.toBe("body"); // focus did not fall off the page when the edited row left the list
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 11. The searchable category list, keyboard only
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe("Admin: the searchable category list with the keyboard", () => {
  test("a category can be found by typing and picked with the keyboard alone, and focus moves on instead of being trapped", async ({ page }) => {
    const extra: Category[] = ["Vaccines", "Dental", "Eye care", "Lab supplies", "Skin care", "Sutures"].map((name, index) => ({
      id: fakeUuid(300 + index),
      name,
      created_at: null,
    }));
    const item = seedItem(ACETAMINOPHEN);
    const api = await openAdmin(page, { categories: [...buildCategories(), ...extra] });

    await openEditForm(page, item.id);
    await page.getByTestId("barcode-input").focus();
    await page.keyboard.press("Tab"); // Supplier order number
    await page.keyboard.press("Tab"); // Category
    expect(await focusedElement(page)).toBe("category-select");
    await expect(page.getByTestId("category-select")).toHaveAttribute("role", "combobox");

    await page.keyboard.type("sut"); // typing replaces the shown name, opens the list and narrows it
    await expect(page.getByTestId("category-select-listbox").getByRole("option")).toHaveText(["Sutures", CREATE_NEW]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect(await chosenCategory(page)).toBe("Sutures");
    expect(api.requestsTo("PUT", PUT_ITEM(item.id))).toHaveLength(0); // Enter in the list never saves the form

    await page.keyboard.press("Tab");
    expect(await focusedElement(page)).toBe("unit-input"); // Tab leaves the list
    await page.keyboard.press("Shift+Tab");
    expect(await focusedElement(page)).toBe("category-select");

    await page.keyboard.press("ArrowDown"); // opens the list again
    await expect(page.getByTestId("category-select-listbox")).toBeVisible();
    await page.keyboard.press("Escape"); // closes it and keeps the choice
    await expect(page.getByTestId("category-select-listbox")).toBeHidden();
    expect(await chosenCategory(page)).toBe("Sutures");

    await page.getByTestId("save-button").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("admin-success")).toContainText("Saved. Category: Sutures");
    expect(stored(api, item.id).category_id).toBe(fakeUuid(305));
  });
});

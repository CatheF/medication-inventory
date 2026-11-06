// Holds the browser tests' mock API (tests/e2e/helpers/mock-api.ts) to the wording of the real routes. The mock answers the
// pages in the Playwright specs without a database, and the Admin and Inventory screens print the `error` text it sends. If
// the real text changes and the mock does not, those specs would keep passing while testing words nobody will ever see.
import { describe, expect, it } from "vitest";
import { ITEM_NOT_FOUND_MESSAGE, mapSupabaseError } from "@/lib/api-errors";
import { MOCK_ERROR_BODIES, MOCK_ERROR_TEXT } from "../e2e/helpers/mock-api";

describe("the browser tests' mock API says what the real routes say", () => {
  it("a category that cannot be created before the migration (error text and technical field)", () => {
    const real = mapSupabaseError(
      { code: "42501", message: 'new row violates row-level security policy for table "categories"', details: "", hint: "" },
      "categories.create"
    ).body;
    expect(MOCK_ERROR_TEXT.categoriesBlocked).toBe(real.error);
    expect(MOCK_ERROR_TEXT.categoriesBlockedTechnical).toBe(real.technical);
    // The WHOLE answer, field by field: what the Admin page prints under the plain sentence is `detail` and `code`.
    expect(MOCK_ERROR_BODIES.categoriesBlocked).toEqual(real);
  });

  it("a supplier order number before the migration: an edit and a create each say what really happened", () => {
    const missing = { code: "PGRST204", message: "Could not find the 'supplier_order_number' column of 'medications' in the schema cache", details: "", hint: "" };
    const update = mapSupabaseError(missing, "medications.update").body;
    const create = mapSupabaseError(missing, "medications.create").body;
    expect(MOCK_ERROR_TEXT.supplierMissingOnUpdate).toBe(update.error);
    expect(MOCK_ERROR_TEXT.supplierMissingOnCreate).toBe(create.error);
    expect(MOCK_ERROR_TEXT.supplierMissingTechnical).toBe(update.technical);
    expect(MOCK_ERROR_BODIES.supplierMissingOnUpdate).toEqual({ ...update, field: "supplier_order_number" });
    expect(MOCK_ERROR_BODIES.supplierMissingOnCreate).toEqual({ ...create, field: "supplier_order_number" });
  });

  it("a category that no longer exists, an item that is gone, and a barcode that is taken", () => {
    expect(MOCK_ERROR_TEXT.noCategory).toBe(mapSupabaseError({ code: "23503", message: "violates foreign key constraint" }, "medications.update").body.error);
    expect(MOCK_ERROR_TEXT.itemNotFound).toBe(ITEM_NOT_FOUND_MESSAGE);
    expect(MOCK_ERROR_TEXT.itemNotFound).toBe(mapSupabaseError({ code: "PGRST116", message: "0 rows" }, "medications.update").body.error);
    expect(MOCK_ERROR_TEXT.duplicateBarcode).toBe(mapSupabaseError({ code: "23505", message: "duplicate key value" }, "medications.create").body.error);
  });
});

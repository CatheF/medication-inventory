import { describe, expect, it } from "vitest";
import { mapSupabaseError, type ErrorContext } from "@/lib/api-errors";

const ALL_CONTEXTS: ErrorContext[] = [
  "categories.read",
  "categories.create",
  "medications.read",
  "medications.create",
  "medications.update",
  "medications.delete",
  "barcode.lookup",
  "order-sheet.read",
];

// User-facing text from SPEC 2.5. These strings are also what the UI and the E2E mock expect, so they are pinned exactly.
const RLS_CREATE_CATEGORY =
  "Couldn’t create the category: the database refused the change (row-level security). " +
  "The categories access migration hasn’t been applied yet — see supabase/migrations/.";
const RLS_OTHER = "The database refused this change (row-level security).";
const SUPPLIER_COLUMN_MISSING =
  "Supplier order numbers aren’t available yet: the database is missing the supplier_order_number column. Apply the latest migration.";
const NOT_FOUND = "Item not found. It may have been deleted.";
const UNREACHABLE = "Can’t reach the database. Check the connection, and that the Supabase project isn’t paused.";
const BAD_API_KEY = "The database rejected the app’s API key.";
const NO_SUCH_CATEGORY = "That category no longer exists. Reload and choose another.";
const INVALID_FORMAT = "One of the values has an invalid format.";
const UNEXPECTED = "Unexpected database error.";

/** What postgrest-js hands back: details/hint are null (not strings) when PostgREST has nothing to add. */
function pgError(code: string, message: string, details: string | null = null, hint: string | null = null) {
  return { code, message, details, hint };
}

describe("mapSupabaseError", () => {
  describe("row-level security / permissions -> 403", () => {
    it("explains the missing categories migration when creating a category (the live defect)", () => {
      const r = mapSupabaseError(
        pgError("42501", 'new row violates row-level security policy for table "categories"'),
        "categories.create"
      );
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(RLS_CREATE_CATEGORY);
      expect(r.body.code).toBe("42501");
    });

    it.each(ALL_CONTEXTS.filter((c) => c !== "categories.create"))("uses the short message in %s", (ctx) => {
      const r = mapSupabaseError(pgError("42501", "new row violates row-level security policy"), ctx);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(RLS_OTHER);
    });

    it("detects row-level security from the message alone (no code)", () => {
      const r = mapSupabaseError({ message: 'new row violates row-level security policy for table "medications"' }, "medications.create");
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(RLS_OTHER);
    });

    it("detects 'permission denied' from the message alone", () => {
      const r = mapSupabaseError({ message: "permission denied for table categories" }, "categories.read");
      expect(r.status).toBe(403);
    });

    it("detects row-level security that is only mentioned in details", () => {
      const r = mapSupabaseError({ message: "Bad Request", details: "violates row-level security policy" }, "medications.update");
      expect(r.status).toBe(403);
    });

    it("is case-insensitive about the wording", () => {
      expect(mapSupabaseError({ message: "ROW-LEVEL SECURITY" }, "medications.update").status).toBe(403);
      expect(mapSupabaseError({ message: "Permission Denied" }, "medications.update").status).toBe(403);
    });
  });

  describe("a missing table privilege is not reported as a missing policy -> 403 with its own message", () => {
    it("tells the operator that the categories migration will not fix a missing privilege on categories", () => {
      const r = mapSupabaseError(pgError("42501", "permission denied for table categories"), "categories.create");
      expect(r.status).toBe(403);
      expect(r.body.error).toContain("isn’t allowed to write to the categories table");
      expect(r.body.error).toContain("will not fix this");
      expect(r.body.error).toContain("BEFORE YOU APPLY");
      expect(r.body.error).not.toBe(RLS_CREATE_CATEGORY);
      expect(r.body.error).not.toMatch(/hasn’t been applied yet/);
      expect(r.body.code).toBe("42501");
      expect(r.body.detail).toBe("permission denied for table categories"); // the original text stays available for diagnosis
    });

    it("covers the id sequence of a bigint-id database too", () => {
      const r = mapSupabaseError(pgError("42501", "permission denied for sequence categories_id_seq"), "categories.create");
      expect(r.status).toBe(403);
      expect(r.body.error).toContain("will not fix this");
      expect(r.body.detail).toBe("permission denied for sequence categories_id_seq");
    });

    it.each(["categories.read", "medications.read", "barcode.lookup", "order-sheet.read"] as const)("says 'read' in %s", (ctx) => {
      const r = mapSupabaseError(pgError("42501", "permission denied for table medications"), ctx);
      expect(r.status).toBe(403);
      expect(r.body.error).toContain("isn’t allowed to read this data");
      expect(r.body.error).not.toMatch(/row-level security/i);
    });

    it.each(["medications.create", "medications.update", "medications.delete"] as const)("says 'change' in %s", (ctx) => {
      const r = mapSupabaseError(pgError("42501", "permission denied for table medications"), ctx);
      expect(r.status).toBe(403);
      expect(r.body.error).toContain("isn’t allowed to change this data");
    });

    it("recognises the privilege wording without a code", () => {
      const r = mapSupabaseError({ message: "permission denied for table categories" }, "categories.read");
      expect(r.status).toBe(403);
      expect(r.body.error).toContain("isn’t allowed to read this data");
    });

    it("still reports a row-level-security violation as a missing policy, even when 'permission denied' is also mentioned", () => {
      const r = mapSupabaseError(
        pgError("42501", 'new row violates row-level security policy for table "categories"', "permission denied for table categories"),
        "categories.create"
      );
      expect(r.body.error).toBe(RLS_CREATE_CATEGORY);
    });

    it("keeps the row-level-security message for a bare 42501 and for 'permission denied' without a named object", () => {
      expect(mapSupabaseError(pgError("42501", "rls"), "medications.update").body.error).toBe(RLS_OTHER);
      expect(mapSupabaseError({ message: "Permission Denied" }, "medications.update").body.error).toBe(RLS_OTHER);
    });
  });

  describe("unique violation -> 409", () => {
    it.each(["medications.create", "medications.update"] as const)("%s says the barcode exists", (ctx) => {
      const r = mapSupabaseError(
        pgError("23505", 'duplicate key value violates unique constraint "medications_barcode_key"', "Key (barcode)=(0123) already exists."),
        ctx
      );
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("Barcode already exists");
    });

    it("says the category name exists when creating a category", () => {
      const r = mapSupabaseError(pgError("23505", 'duplicate key value violates unique constraint "categories_name_key"'), "categories.create");
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/already exists/i);
      expect(r.body.error).not.toMatch(/barcode/i);
    });
  });

  describe("constraint and format errors -> 400", () => {
    it.each(ALL_CONTEXTS)("23503 (foreign key) says the category is gone in %s", (ctx) => {
      const r = mapSupabaseError(pgError("23503", 'insert or update on table "medications" violates foreign key constraint'), ctx);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(NO_SUCH_CATEGORY);
      expect(r.body.field).toBe("category_id");
    });

    it("22P02 (invalid text representation) -> invalid format", () => {
      const r = mapSupabaseError(pgError("22P02", 'invalid input syntax for type uuid: "NaN"'), "medications.update");
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(INVALID_FORMAT);
    });

    it("23502 (not null) -> a required field is missing", () => {
      const r = mapSupabaseError(pgError("23502", 'null value in column "barcode" violates not-null constraint'), "medications.create");
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/required field/i);
    });
  });

  describe("PGRST116 (single() matched no row) -> 404", () => {
    it.each(ALL_CONTEXTS)("in %s", (ctx) => {
      const r = mapSupabaseError(
        pgError("PGRST116", "JSON object requested, multiple (or no) rows returned", "The result contains 0 rows"),
        ctx
      );
      expect(r.status).toBe(404);
      expect(r.body.error).toBe(NOT_FOUND);
    });
  });

  describe("missing supplier_order_number column (migration not applied) -> 409", () => {
    it("PGRST204 from PostgREST's schema cache", () => {
      const r = mapSupabaseError(
        pgError("PGRST204", "Could not find the 'supplier_order_number' column of 'medications' in the schema cache"),
        "medications.update"
      );
      expect(r.status).toBe(409);
      expect(r.body.error).toBe(SUPPLIER_COLUMN_MISSING);
      expect(r.body.field).toBe("supplier_order_number");
    });

    it("42703 from Postgres", () => {
      const r = mapSupabaseError(
        pgError("42703", 'column "supplier_order_number" of relation "medications" does not exist'),
        "medications.create"
      );
      expect(r.status).toBe(409);
      expect(r.body.error).toBe(SUPPLIER_COLUMN_MISSING);
    });

    it("a column error without a code but naming the column", () => {
      const r = mapSupabaseError({ message: "column medications.supplier_order_number does not exist" }, "medications.read");
      expect(r.status).toBe(409);
    });

    it.each(ALL_CONTEXTS)("is recognised in %s", (ctx) => {
      expect(mapSupabaseError(pgError("PGRST204", "Could not find the 'supplier_order_number' column"), ctx).status).toBe(409);
    });

    it("does NOT claim the supplier column is missing when another column is", () => {
      const r = mapSupabaseError(pgError("PGRST204", "Could not find the 'shelf_location' column of 'medications' in the schema cache"), "medications.update");
      expect(r.status).toBe(500);
      expect(r.body.error).toBe(UNEXPECTED);
      expect(r.body.error).not.toMatch(/supplier/i);
    });

    it("does NOT claim a missing column for an unrelated error that merely mentions the field", () => {
      const r = mapSupabaseError(pgError("22001", "value too long for type character varying(64) (supplier_order_number)"), "medications.update");
      expect(r.body.error).not.toBe(SUPPLIER_COLUMN_MISSING);
    });
  });

  describe("network problems -> 503", () => {
    it.each([
      ["fetch failed (postgrest-js error object)", { message: "TypeError: fetch failed", details: "TypeError: fetch failed\n\nCaused by: Error: getaddrinfo ENOTFOUND abcd.supabase.co (ENOTFOUND)", hint: "", code: "" }],
      ["a thrown fetch TypeError", new TypeError("fetch failed")],
      ["a bare string", "fetch failed"],
      ["ENOTFOUND", { message: "getaddrinfo ENOTFOUND abcd.supabase.co" }],
      ["ECONNREFUSED", { message: "connect ECONNREFUSED 127.0.0.1:54321" }],
      ["ETIMEDOUT", { message: "connect ETIMEDOUT 10.0.0.1:443" }],
      ["ECONNRESET", { message: "read ECONNRESET" }],
      ["EAI_AGAIN", { message: "getaddrinfo EAI_AGAIN abcd.supabase.co" }],
      ["Network request failed", { message: "Network request failed" }],
      ["code only in details", { message: "TypeError: terminated", details: "Caused by: Error: read ECONNRESET" }],
    ])("%s", (_label, err) => {
      const r = mapSupabaseError(err, "medications.read");
      expect(r.status).toBe(503);
      expect(r.body.error).toBe(UNREACHABLE);
    });

    it.each(ALL_CONTEXTS)("maps a network failure the same way in %s", (ctx) => {
      expect(mapSupabaseError(new TypeError("fetch failed"), ctx).status).toBe(503);
    });
  });

  describe("API key / JWT problems -> 500", () => {
    it.each([
      ["PGRST301", pgError("PGRST301", "JWSError JWSInvalidSignature")],
      ["PGRST302", pgError("PGRST302", "Anonymous access is disabled")],
      ["PGRST303", pgError("PGRST303", "JWT claim expected")],
      ["JWT in the message", { message: "JWT expired" }],
      ["Invalid API key", { message: "Invalid API key", hint: "Double check your Supabase `anon` or `service_role` API key." }],
    ])("%s", (_label, err) => {
      const r = mapSupabaseError(err, "medications.read");
      expect(r.status).toBe(500);
      expect(r.body.error).toBe(BAD_API_KEY);
    });
  });

  describe("everything else -> 500 with the code kept", () => {
    it("keeps the code", () => {
      const r = mapSupabaseError(pgError("XX000", "internal error"), "medications.read");
      expect(r.status).toBe(500);
      expect(r.body.error).toBe(UNEXPECTED);
      expect(r.body.code).toBe("XX000");
    });

    it("has no code key at all when there is no code", () => {
      const r = mapSupabaseError({ message: "something odd" }, "medications.read");
      expect(r.status).toBe(500);
      expect("code" in r.body).toBe(false);
    });

    it.each([
      ["null", null],
      ["undefined", undefined],
      ["a number", 42],
      ["a boolean", false],
      ["an empty object", {}],
      ["an array", []],
      ["an empty string", ""],
      ["a plain string", "boom"],
      ["an object with wrong field types", { code: 42501, message: 7, details: {} }],
      ["a null-prototype object", Object.assign(Object.create(null) as object, { code: "XX000", message: "x" })],
    ])("does not throw for %s", (_label, err) => {
      const run = () => mapSupabaseError(err, "medications.read");
      expect(run).not.toThrow();
      const r = run();
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(typeof r.body.error).toBe("string");
      expect(r.body.error.length).toBeGreaterThan(0);
    });
  });

  describe("detail", () => {
    it("is the original message, kept short", () => {
      const r = mapSupabaseError(pgError("XX000", "x".repeat(1000)), "medications.read");
      expect(r.body.detail).toBeDefined();
      expect(r.body.detail!.length).toBe(300);
      expect(r.body.detail!.endsWith("…")).toBe(true);
    });

    it("is not truncated at exactly 300 characters, and is at 301", () => {
      expect(mapSupabaseError({ message: "y".repeat(300) }, "medications.read").body.detail).toBe("y".repeat(300));
      expect(mapSupabaseError({ message: "y".repeat(301) }, "medications.read").body.detail!.length).toBe(300);
    });

    it("falls back to details when there is no message", () => {
      const r = mapSupabaseError({ code: "23505", message: "", details: "Key (barcode)=(123) already exists." }, "medications.create");
      expect(r.body.detail).toBe("Key (barcode)=(123) already exists.");
    });

    it("is omitted entirely when there is nothing to say", () => {
      const r = mapSupabaseError({ code: "XX000" }, "medications.read");
      expect("detail" in r.body).toBe(false);
    });

    it("uses only the message, so stack traces and hostnames in `details` never reach the client", () => {
      const r = mapSupabaseError(
        {
          message: "TypeError: fetch failed",
          details: "TypeError: fetch failed\n\nCaused by: Error: getaddrinfo ENOTFOUND abcd.supabase.co\n    at /srv/app/node_modules/x.js:1:1",
          hint: "",
          code: "",
        },
        "medications.read"
      );
      expect(r.body.detail).toBe("TypeError: fetch failed");
      expect(JSON.stringify(r.body)).not.toContain("abcd.supabase.co");
      expect(JSON.stringify(r.body)).not.toContain("node_modules");
    });

    it("trims surrounding whitespace", () => {
      expect(mapSupabaseError({ message: "  spaced  " }, "medications.read").body.detail).toBe("spaced");
    });
  });

  describe("the user-facing message", () => {
    it("never echoes the raw database message (it goes in `detail` only)", () => {
      const hostile = "<script>alert(1)</script> ENOTFOUND";
      const r = mapSupabaseError({ message: hostile }, "medications.read");
      expect(r.status).toBe(503);
      expect(r.body.error).not.toContain("<script>");
      expect(r.body.detail).toBe(hostile);
    });

    it("is always a non-empty sentence without placeholders, whatever the input", () => {
      const inputs: unknown[] = [
        null, undefined, "", "boom", 42, {}, [],
        pgError("42501", "rls"), pgError("23505", "dup"), pgError("23503", "fk"), pgError("22P02", "fmt"),
        pgError("23502", "nn"), pgError("PGRST116", "single"), pgError("PGRST204", "supplier_order_number column"),
        pgError("PGRST301", "jwt"), new TypeError("fetch failed"), pgError("XX000", "other"),
      ];
      for (const input of inputs) {
        for (const ctx of ALL_CONTEXTS) {
          const r = mapSupabaseError(input, ctx);
          expect([400, 403, 404, 409, 500, 503]).toContain(r.status);
          expect(r.body.error.length).toBeGreaterThan(10);
          expect(r.body.error).not.toMatch(/undefined|NaN|\[object|null/);
          if (r.body.code !== undefined) expect(typeof r.body.code).toBe("string");
          if (r.body.field !== undefined) expect(typeof r.body.field).toBe("string");
        }
      }
    });
  });

  describe("precedence", () => {
    it("treats a row-level security error as 403 even if it also mentions the supplier column", () => {
      const r = mapSupabaseError(pgError("42501", "new row violates row-level security policy (supplier_order_number column)"), "medications.update");
      expect(r.status).toBe(403);
    });

    it("maps by Postgres code before guessing from the message text", () => {
      // A unique violation whose text happens to contain 'fetch failed' is still a conflict, not a network error.
      const r = mapSupabaseError(pgError("23505", "duplicate key (fetch failed)"), "medications.create");
      expect(r.status).toBe(409);
    });
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const a = mapSupabaseError(pgError("23505", "dup"), "medications.create");
    a.body.error = "changed";
    const b = mapSupabaseError(pgError("23505", "dup"), "medications.create");
    expect(b.body.error).toBe("Barcode already exists");
  });
});

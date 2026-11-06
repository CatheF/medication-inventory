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

// What staff read, pinned exactly (the E2E mock mirrors the first two and the Admin and Inventory screens show them as they are).
// Plain words: what happened, what it means for the person, what to do. The technical facts are in `technical`, `code` and
// `detail`, never in `error` (see "the staff-facing text is plain language" below).
const ASK = "whoever looks after this app";
const RLS_CREATE_CATEGORY =
  "Categories cannot be saved yet. This needs a one-time database update by whoever looks after this app. You can still save the item without a category.";
const RLS_WRITE =
  "The database did not allow this change, so nothing was saved. This is a database setting, not something you typed. Ask whoever looks after this app to check it.";
const RLS_READ =
  "The database did not allow the app to read this. This is a database setting, not something you did. Ask whoever looks after this app to check it.";
const SUPPLIER_UPDATE =
  "Supplier order numbers cannot be saved yet. This needs a one-time database update by whoever looks after this app. Nothing was changed on this item.";
const SUPPLIER_CREATE =
  "Supplier order numbers cannot be saved yet. This needs a one-time database update by whoever looks after this app. The item was not created.";
const SUPPLIER_OTHER = "Supplier order numbers cannot be saved yet. This needs a one-time database update by whoever looks after this app.";
const NOT_FOUND = "Item not found. It may have been deleted by someone else. Reload the list to see what is there.";
const UNREACHABLE_READ =
  "Can’t reach the database. Check the internet connection and try again in a minute. If this keeps happening, ask whoever looks after this app: the database may be paused.";
const UNREACHABLE_WRITE =
  "Can’t reach the database. Check the internet connection, then look at the list to see whether your change was saved before you try again. If this keeps happening, ask whoever looks after this app: the database may be paused.";
const BAD_API_KEY_READ =
  "The app’s connection to the database was refused, so the app cannot read anything right now. This needs a fix by whoever looks after this app.";
const BAD_API_KEY_WRITE =
  "The app’s connection to the database was refused, so the app cannot save anything right now. This needs a fix by whoever looks after this app.";
const NO_SUCH_CATEGORY = "That category no longer exists, so nothing was saved. Reload the page and choose another category.";
const INVALID_FORMAT = "One of the values is not in a format the database accepts, so nothing was saved. Check what you typed and try again.";
const REQUIRED_FIELD = "A required field is empty, so nothing was saved. Fill it in and try again.";
const DUPLICATE_BARCODE = "Barcode already exists: another item uses it, so nothing was saved. Search for that item, or use a different barcode.";
const DUPLICATE_CATEGORY = "A category with that name already exists. Choose it from the list instead.";
const UNEXPECTED_READ = "Something went wrong while reading from the database. Try again. If this keeps happening, ask whoever looks after this app.";
const UNEXPECTED_WRITE =
  "Something went wrong in the database. Your change may not have been saved: look at the list before you try again. If this keeps happening, ask whoever looks after this app.";

const READ_CONTEXTS: ErrorContext[] = ["categories.read", "medications.read", "barcode.lookup", "order-sheet.read"];
const WRITE_CONTEXTS: ErrorContext[] = ["categories.create", "medications.create", "medications.update", "medications.delete"];

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

    it("keeps the technical facts out of that message and in `technical`, `code` and `detail` instead", () => {
      const r = mapSupabaseError(
        pgError("42501", 'new row violates row-level security policy for table "categories"'),
        "categories.create"
      );
      expect(r.body.technical).toBe(
        "Row-level security refused the insert into the categories table (code 42501). " +
          "The categories access migration has not been applied to this database: see supabase/migrations/."
      );
      expect(r.body.code).toBe("42501");
      expect(r.body.detail).toBe('new row violates row-level security policy for table "categories"');
      expect(r.body.error).not.toMatch(/row-level|migration|42501|supabase/i);
    });

    it.each(WRITE_CONTEXTS.filter((c) => c !== "categories.create"))("uses the plain write message in %s", (ctx) => {
      const r = mapSupabaseError(pgError("42501", "new row violates row-level security policy"), ctx);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(RLS_WRITE);
      expect(r.body.technical).toBe("Row-level security refused the request (code 42501).");
    });

    it.each(READ_CONTEXTS)("uses the plain read message in %s", (ctx) => {
      const r = mapSupabaseError(pgError("42501", "new row violates row-level security policy"), ctx);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(RLS_READ);
    });

    it("detects row-level security from the message alone (no code)", () => {
      const r = mapSupabaseError({ message: 'new row violates row-level security policy for table "medications"' }, "medications.create");
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(RLS_WRITE);
      expect(r.body.technical).toBe("Row-level security refused the request.");
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
      expect(r.body.error).toBe(
        `Categories cannot be saved right now. The app does not have permission to add to the category list. This needs a fix by ${ASK}. You can still save the item without a category.`
      );
      expect(r.body.error).not.toBe(RLS_CREATE_CATEGORY); // the cure is different: a one-time update would not help
      expect(r.body.error).not.toMatch(/one-time database update/);
      // The person fixing it is told, in the technical field, that the migration will not help.
      expect(r.body.technical).toContain("lacks the privilege");
      expect(r.body.technical).toContain("will not fix this");
      expect(r.body.technical).toContain("BEFORE YOU APPLY");
      expect(r.body.technical).toContain("supabase/migrations/");
      expect(r.body.code).toBe("42501");
      expect(r.body.detail).toBe("permission denied for table categories"); // the original text stays available for diagnosis
    });

    it("covers the id sequence of a bigint-id database too", () => {
      const r = mapSupabaseError(pgError("42501", "permission denied for sequence categories_id_seq"), "categories.create");
      expect(r.status).toBe(403);
      expect(r.body.technical).toContain("will not fix this");
      expect(r.body.detail).toBe("permission denied for sequence categories_id_seq");
    });

    it.each(["categories.read", "medications.read", "barcode.lookup", "order-sheet.read"] as const)("says 'read' in %s", (ctx) => {
      const r = mapSupabaseError(pgError("42501", "permission denied for table medications"), ctx);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(
        `The app does not have permission to read this data. This is a database setting, not something you did. Ask ${ASK} to check it.`
      );
      expect(r.body.error).not.toMatch(/row-level security/i);
    });

    it.each(["medications.create", "medications.update", "medications.delete"] as const)("says 'change' in %s", (ctx) => {
      const r = mapSupabaseError(pgError("42501", "permission denied for table medications"), ctx);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(
        `The app does not have permission to change this data, so nothing was saved. This is a database setting, not something you typed. Ask ${ASK} to check it.`
      );
      expect(r.body.technical).toContain("lacks the table privilege");
    });

    it("recognises the privilege wording without a code", () => {
      const r = mapSupabaseError({ message: "permission denied for table categories" }, "categories.read");
      expect(r.status).toBe(403);
      expect(r.body.error).toContain("does not have permission to read this data");
    });

    it("still reports a row-level-security violation as a missing policy, even when 'permission denied' is also mentioned", () => {
      const r = mapSupabaseError(
        pgError("42501", 'new row violates row-level security policy for table "categories"', "permission denied for table categories"),
        "categories.create"
      );
      expect(r.body.error).toBe(RLS_CREATE_CATEGORY);
    });

    it("keeps the row-level-security message for a bare 42501 and for 'permission denied' without a named object", () => {
      expect(mapSupabaseError(pgError("42501", "rls"), "medications.update").body.error).toBe(RLS_WRITE);
      expect(mapSupabaseError({ message: "Permission Denied" }, "medications.update").body.error).toBe(RLS_WRITE);
    });
  });

  describe("unique violation -> 409", () => {
    it.each(["medications.create", "medications.update"] as const)("%s says the barcode exists", (ctx) => {
      const r = mapSupabaseError(
        pgError("23505", 'duplicate key value violates unique constraint "medications_barcode_key"', "Key (barcode)=(0123) already exists."),
        ctx
      );
      expect(r.status).toBe(409);
      expect(r.body.error).toBe(DUPLICATE_BARCODE);
      expect(r.body.error).toMatch(/barcode/i); // the Admin form puts the focus on the Barcode field when the message names it
    });

    it("says the category name exists when creating a category", () => {
      const r = mapSupabaseError(pgError("23505", 'duplicate key value violates unique constraint "categories_name_key"'), "categories.create");
      expect(r.status).toBe(409);
      expect(r.body.error).toBe(DUPLICATE_CATEGORY);
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
      expect(r.body.error).toBe(REQUIRED_FIELD);
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
      expect(r.body.error).toBe(SUPPLIER_UPDATE);
      expect(r.body.field).toBe("supplier_order_number");
      expect(r.body.code).toBe("PGRST204");
      expect(r.body.technical).toBe(
        "The medications table has no supplier_order_number column (code PGRST204). Apply the latest migration in supabase/migrations/."
      );
      expect(r.body.error).not.toMatch(/column|migration|PGRST|supplier_order_number/i);
    });

    it("42703 from Postgres", () => {
      const r = mapSupabaseError(
        pgError("42703", 'column "supplier_order_number" of relation "medications" does not exist'),
        "medications.create"
      );
      expect(r.status).toBe(409);
      expect(r.body.error).toBe(SUPPLIER_CREATE);
      expect(r.body.technical).toContain("code 42703");
    });

    it("only claims that 'nothing was changed' where that is true: an update is one statement the database refuses as a whole", () => {
      const err = pgError("PGRST204", "Could not find the 'supplier_order_number' column of 'medications' in the schema cache");
      expect(mapSupabaseError(err, "medications.update").body.error).toBe(SUPPLIER_UPDATE);
      expect(mapSupabaseError(err, "medications.create").body.error).toBe(SUPPLIER_CREATE);
      for (const ctx of ["medications.read", "medications.delete", "barcode.lookup", "order-sheet.read", "categories.read", "categories.create"] as const) {
        expect(mapSupabaseError(err, ctx).body.error, ctx).toBe(SUPPLIER_OTHER);
      }
    });

    it("a column error without a code but naming the column", () => {
      const r = mapSupabaseError({ message: "column medications.supplier_order_number does not exist" }, "medications.read");
      expect(r.status).toBe(409);
      expect(r.body.error).toBe(SUPPLIER_OTHER);
      expect(r.body.technical).toBe("The medications table has no supplier_order_number column. Apply the latest migration in supabase/migrations/.");
    });

    it.each(ALL_CONTEXTS)("is recognised in %s", (ctx) => {
      expect(mapSupabaseError(pgError("PGRST204", "Could not find the 'supplier_order_number' column"), ctx).status).toBe(409);
    });

    it("does NOT claim the supplier column is missing when another column is", () => {
      const r = mapSupabaseError(pgError("PGRST204", "Could not find the 'shelf_location' column of 'medications' in the schema cache"), "medications.update");
      expect(r.status).toBe(500);
      expect(r.body.error).toBe(UNEXPECTED_WRITE);
      expect(r.body.error).not.toMatch(/supplier/i);
    });

    it("does NOT claim a missing column for an unrelated error that merely mentions the field", () => {
      const r = mapSupabaseError(pgError("22001", "value too long for type character varying(64) (supplier_order_number)"), "medications.update");
      expect(r.body.error).not.toBe(SUPPLIER_UPDATE);
      expect(r.body.error).not.toMatch(/Supplier order numbers cannot be saved yet/);
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
      expect(r.body.error).toBe(UNREACHABLE_READ);
      expect(r.body.technical).toMatch(/^Network error reaching the database \((ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|Network request failed)\)\. Check NEXT_PUBLIC_SUPABASE_URL and that the Supabase project is not paused\.$/i);
    });

    it.each(ALL_CONTEXTS)("maps a network failure the same way in %s", (ctx) => {
      expect(mapSupabaseError(new TypeError("fetch failed"), ctx).status).toBe(503);
    });

    it.each(WRITE_CONTEXTS)("does not claim a lost connection saved nothing in %s: the change may have gone through", (ctx) => {
      const r = mapSupabaseError(new TypeError("fetch failed"), ctx);
      expect(r.body.error).toBe(UNREACHABLE_WRITE);
      expect(r.body.error).not.toMatch(/nothing was saved/i);
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
      expect(r.body.error).toBe(BAD_API_KEY_READ);
      expect(r.body.technical).toContain("The database rejected the API key");
      expect(r.body.technical).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
      expect(r.body.error).not.toMatch(/API key|JWT/i);
    });

    it("says 'save' instead of 'read' when the request was a write", () => {
      expect(mapSupabaseError(pgError("PGRST301", "JWT expired"), "medications.update").body.error).toBe(BAD_API_KEY_WRITE);
    });
  });

  describe("everything else -> 500 with the code kept", () => {
    it("keeps the code", () => {
      const r = mapSupabaseError(pgError("XX000", "internal error"), "medications.read");
      expect(r.status).toBe(500);
      expect(r.body.error).toBe(UNEXPECTED_READ);
      expect(r.body.code).toBe("XX000");
    });

    it("says the change may not have been saved when the request was a write", () => {
      const r = mapSupabaseError(pgError("XX000", "internal error"), "medications.update");
      expect(r.body.error).toBe(UNEXPECTED_WRITE);
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
    expect(b.body.error).toBe(DUPLICATE_BARCODE);
  });
});

describe("the staff-facing text is plain language", () => {
  // Every answer the mapping can give, in every context. `error` is what staff read in a red box: no database words, no
  // codes, no file paths, short, and it says who to ask when only the person who looks after the app can fix it.
  const ERRORS: Array<[string, unknown]> = [
    ["row-level security", pgError("42501", 'new row violates row-level security policy for table "categories"')],
    ["a missing table privilege", pgError("42501", "permission denied for table categories")],
    ["a missing sequence privilege", pgError("42501", "permission denied for sequence categories_id_seq")],
    ["a missing supplier column", pgError("PGRST204", "Could not find the 'supplier_order_number' column of 'medications' in the schema cache")],
    ["a duplicate", pgError("23505", 'duplicate key value violates unique constraint "medications_barcode_key"')],
    ["a missing category", pgError("23503", 'violates foreign key constraint "medications_category_id_fkey"')],
    ["an invalid format", pgError("22P02", 'invalid input syntax for type uuid: "NaN"')],
    ["a missing required value", pgError("23502", 'null value in column "barcode" violates not-null constraint')],
    ["no row", pgError("PGRST116", "JSON object requested, multiple (or no) rows returned")],
    ["a network failure", new TypeError("fetch failed")],
    ["a rejected key", pgError("PGRST301", "JWSError JWSInvalidSignature")],
    ["anything else", pgError("XX000", "internal error")],
    ["nothing at all", null],
  ];
  // Words that belong in `technical` or in the log, not in a red box.
  const JARGON =
    /row-level|\bRLS\b|polic(?:y|ies)|migration|supabase|SQLSTATE|PGRST|\b[0-9A-Z]{5}\b(?=\))|\b4[0-9]{4}\b|\b2[0-9]{4}\b|JWT|API key|schema cache|\bcolumn\b|\btable\b|constraint|foreign key|ENOTFOUND|ECONN|ETIMEDOUT|fetch failed|supplier_order_number|category_id|\.sql|supabase\/|NEXT_PUBLIC|undefined|\[object/i;

  it.each(ERRORS)("%s: no database jargon, short, and at most four sentences, in every context", (_label, err) => {
    for (const ctx of ALL_CONTEXTS) {
      const { error } = mapSupabaseError(err, ctx).body;
      expect(error, `${ctx}: ${error}`).not.toMatch(JARGON);
      expect(error.length, `${ctx}: ${error}`).toBeLessThanOrEqual(260);
      expect(error.split(/(?<=[.!?:])\s+/).length, `${ctx}: ${error}`).toBeLessThanOrEqual(4);
      expect(error.endsWith("."), `${ctx}: ${error}`).toBe(true);
    }
  });

  it.each([
    ["row-level security", pgError("42501", "new row violates row-level security policy")],
    ["a missing table privilege", pgError("42501", "permission denied for table medications")],
    ["a missing supplier column", pgError("PGRST204", "Could not find the 'supplier_order_number' column")],
    ["a rejected key", pgError("PGRST301", "JWT expired")],
    ["a network failure", new TypeError("fetch failed")],
    ["an unexpected error", pgError("XX000", "internal error")],
  ])("%s: names the person who can fix it", (_label, err) => {
    for (const ctx of ALL_CONTEXTS) {
      const { error } = mapSupabaseError(err, ctx).body;
      expect(error, `${ctx}: ${error}`).toMatch(/whoever looks after this app/);
    }
  });

  it("keeps the technical facts of every setup problem in `technical`, not in `error`", () => {
    const setupProblems: Array<[unknown, ErrorContext, RegExp[]]> = [
      [pgError("42501", "new row violates row-level security policy"), "categories.create", [/row-level security/i, /supabase\/migrations\//, /42501/]],
      [pgError("42501", "permission denied for table categories"), "categories.create", [/privilege/, /will not fix this/, /42501/]],
      [pgError("PGRST204", "Could not find the 'supplier_order_number' column"), "medications.update", [/supplier_order_number/, /supabase\/migrations\//, /PGRST204/]],
      [pgError("PGRST301", "JWT expired"), "medications.read", [/API key/, /NEXT_PUBLIC_SUPABASE_ANON_KEY/, /PGRST301/]],
      [new TypeError("fetch failed"), "medications.read", [/fetch failed/, /NEXT_PUBLIC_SUPABASE_URL/]],
    ];
    for (const [err, ctx, needles] of setupProblems) {
      const { body } = mapSupabaseError(err, ctx);
      expect(body.technical).toBeDefined();
      for (const needle of needles) expect(body.technical, String(needle)).toMatch(needle);
      expect(body.error).not.toContain(body.technical);
    }
  });

  it("does not give `technical` to answers that are about what the person typed", () => {
    for (const code of ["23505", "23503", "22P02", "23502", "PGRST116"]) {
      expect("technical" in mapSupabaseError(pgError(code, "x"), "medications.update").body).toBe(false);
    }
  });

  it("never lets the answer say that nothing was saved when only a read was asked for", () => {
    for (const err of [pgError("42501", "permission denied for table medications"), pgError("XX000", "x"), pgError("PGRST301", "JWT expired")]) {
      for (const ctx of READ_CONTEXTS) expect(mapSupabaseError(err, ctx).body.error, ctx).not.toMatch(/saved/i);
    }
  });
});

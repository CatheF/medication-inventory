// Maps Supabase/PostgREST/Postgres errors to HTTP responses.
//
// `error` is what STAFF read, in the red box on the screen. It is plain words: what happened, what it means for the person
// (was anything saved?), and what to do (try again, or ask whoever looks after the app). It never contains database jargon:
// no "row-level security", no SQLSTATE codes, no file paths.
//
// The technical facts go in separate fields, for the person who looks after the app, and in the server log:
//   code       the database error code (SQLSTATE or PGRST...)
//   detail     the database's own message, truncated to 300 characters, never a secret
//   technical  one sentence for the person fixing it: the cause in database terms and where the cure is
//   field      the form field the message is about, when there is one
// A message claims "nothing was saved" only when the database refused the request outright (a refused write, a duplicate, a
// bad value). A lost connection or an unknown failure could have happened after the database committed, so those say the
// change may not have been saved and tell the person to look at the list first.

export type ApiErrorBody = { error: string; code?: string; detail?: string; technical?: string; field?: string };
export type MappedError = { status: number; body: ApiErrorBody };

export type ErrorContext =
  | "categories.read"
  | "categories.create"
  | "medications.read"
  | "medications.create"
  | "medications.update"
  | "medications.delete"
  | "barcode.lookup"
  | "order-sheet.read";

type ErrorLike = { code: string; message: string; details: string };

function toErrorLike(err: unknown): ErrorLike {
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    return {
      code: typeof o.code === "string" ? o.code : "",
      message: typeof o.message === "string" ? o.message : "",
      details: typeof o.details === "string" ? o.details : "",
    };
  }
  return { code: "", message: typeof err === "string" ? err : "", details: "" };
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const NETWORK_RE = /(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|network request failed)/i;

const RLS_RE = /row-level security/i;
// A missing table/sequence PRIVILEGE. It has the same SQLSTATE (42501) as a missing row-level-security policy but a
// different cause and a different cure, so it must not be reported as one.
const PRIVILEGE_RE = /permission denied for (?:table|sequence|schema|relation|view|function)\b/i;
const READ_CONTEXTS: ReadonlySet<ErrorContext> = new Set<ErrorContext>([
  "categories.read",
  "medications.read",
  "barcode.lookup",
  "order-sheet.read",
]);

/** Who can fix a problem that is in the database set-up rather than in what the person did. */
const ASK = "whoever looks after this app";

/** The message for a missing item, shared by the mapping below and by the routes that answer 404 themselves. */
export const ITEM_NOT_FOUND_MESSAGE = "Item not found. It may have been deleted by someone else. Reload the list to see what is there.";

export function mapSupabaseError(err: unknown, ctx: ErrorContext): MappedError {
  const e = toErrorLike(err);
  const text = `${e.message} ${e.details}`;
  const detail = truncate((e.message || e.details).trim()) || undefined;
  const reading = READ_CONTEXTS.has(ctx);
  const withCode = (error: string, status: number, extra: { field?: string; technical?: string } = {}): MappedError => ({
    status,
    body: {
      error,
      ...(e.code ? { code: e.code } : {}),
      ...(detail ? { detail } : {}),
      ...(extra.technical ? { technical: extra.technical } : {}),
      ...(extra.field ? { field: extra.field } : {}),
    },
  });
  const codeNote = e.code ? ` (code ${e.code})` : "";

  // Row-level security / permissions
  if (e.code === "42501" || RLS_RE.test(text) || /permission denied/i.test(text)) {
    // "permission denied for table categories": the database user lacks the plain privilege. Applying the categories
    // migration (which only adds row-level-security policies) would not help, so the technical note says so.
    if (!RLS_RE.test(text) && PRIVILEGE_RE.test(text)) {
      if (ctx === "categories.create") {
        return withCode(
          `Categories cannot be saved right now. The app does not have permission to add to the category list. This needs a fix by ${ASK}. ` +
            "You can still save the item without a category.",
          403,
          {
            technical:
              `Permission denied for the categories table${codeNote}: the database user the app connects with lacks the privilege. ` +
              "The categories access migration only adds row-level security policies and will not fix this: see BEFORE YOU APPLY in supabase/migrations/.",
          }
        );
      }
      return withCode(
        reading
          ? `The app does not have permission to read this data. This is a database setting, not something you did. Ask ${ASK} to check it.`
          : `The app does not have permission to change this data, so nothing was saved. This is a database setting, not something you typed. Ask ${ASK} to check it.`,
        403,
        {
          technical:
            `Permission denied${codeNote}: the database user the app connects with lacks the table privilege. ` +
            "This is not a row-level security policy, so applying the categories access migration will not fix it.",
        }
      );
    }
    if (ctx === "categories.create") {
      return withCode(
        `Categories cannot be saved yet. This needs a one-time database update by ${ASK}. You can still save the item without a category.`,
        403,
        {
          technical:
            `Row-level security refused the insert into the categories table${codeNote}. ` +
            "The categories access migration has not been applied to this database: see supabase/migrations/.",
        }
      );
    }
    return withCode(
      reading
        ? `The database did not allow the app to read this. This is a database setting, not something you did. Ask ${ASK} to check it.`
        : `The database did not allow this change, so nothing was saved. This is a database setting, not something you typed. Ask ${ASK} to check it.`,
      403,
      { technical: `Row-level security refused the request${codeNote}.` }
    );
  }

  // A column the app tried to use isn't in the database yet (migration not applied). The database checks the columns before it
  // runs a statement, so a refused write changed nothing: neither the supplier number nor any other field in the same request.
  if (/supplier_order_number/.test(text) && (e.code === "PGRST204" || e.code === "42703" || /column/i.test(text))) {
    const consequence =
      ctx === "medications.update"
        ? " Nothing was changed on this item."
        : ctx === "medications.create"
          ? " The item was not created."
          : "";
    return withCode(
      `Supplier order numbers cannot be saved yet. This needs a one-time database update by ${ASK}.${consequence}`,
      409,
      {
        field: "supplier_order_number",
        technical:
          `The medications table has no supplier_order_number column${codeNote}. ` +
          "Apply the latest migration in supabase/migrations/.",
      }
    );
  }

  switch (e.code) {
    case "23505":
      return withCode(
        ctx === "categories.create"
          ? "A category with that name already exists. Choose it from the list instead."
          : "Barcode already exists: another item uses it, so nothing was saved. Search for that item, or use a different barcode.",
        409
      );
    case "23503":
      return withCode(
        "That category no longer exists, so nothing was saved. Reload the page and choose another category.",
        400,
        { field: "category_id" }
      );
    case "22P02":
      return withCode("One of the values is not in a format the database accepts, so nothing was saved. Check what you typed and try again.", 400);
    case "23502":
      return withCode("A required field is empty, so nothing was saved. Fill it in and try again.", 400);
    case "PGRST116":
      return withCode(ITEM_NOT_FOUND_MESSAGE, 404);
    default:
      break;
  }

  const network = NETWORK_RE.exec(text);
  if (network) {
    return withCode(
      reading
        ? `Can’t reach the database. Check the internet connection and try again in a minute. If this keeps happening, ask ${ASK}: the database may be paused.`
        : `Can’t reach the database. Check the internet connection, then look at the list to see whether your change was saved before you try again. If this keeps happening, ask ${ASK}: the database may be paused.`,
      503,
      {
        technical:
          `Network error reaching the database (${network[1]}). ` +
          "Check NEXT_PUBLIC_SUPABASE_URL and that the Supabase project is not paused.",
      }
    );
  }

  if (/^PGRST30\d$/.test(e.code) || /\bJWT\b|invalid api key/i.test(text)) {
    return withCode(
      `The app’s connection to the database was refused, so the app cannot ${reading ? "read" : "save"} anything right now. This needs a fix by ${ASK}.`,
      500,
      {
        technical:
          `The database rejected the API key${codeNote}. ` +
          "Check NEXT_PUBLIC_SUPABASE_ANON_KEY (or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) in the hosting settings.",
      }
    );
  }

  return withCode(
    reading
      ? `Something went wrong while reading from the database. Try again. If this keeps happening, ask ${ASK}.`
      : `Something went wrong in the database. Your change may not have been saved: look at the list before you try again. If this keeps happening, ask ${ASK}.`,
    500
  );
}

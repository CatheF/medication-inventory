// Maps Supabase/PostgREST/Postgres errors to HTTP responses with messages staff can act on.
// Messages are plain, name the cause, and never include secrets. `detail` carries the original message (truncated).

export type ApiErrorBody = { error: string; code?: string; detail?: string; field?: string };
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

export function mapSupabaseError(err: unknown, ctx: ErrorContext): MappedError {
  const e = toErrorLike(err);
  const text = `${e.message} ${e.details}`;
  const detail = truncate((e.message || e.details).trim()) || undefined;
  const withCode = (error: string, status: number, field?: string): MappedError => ({
    status,
    body: { error, ...(e.code ? { code: e.code } : {}), ...(detail ? { detail } : {}), ...(field ? { field } : {}) },
  });

  // Row-level security / permissions
  if (e.code === "42501" || RLS_RE.test(text) || /permission denied/i.test(text)) {
    // "permission denied for table categories": the database user lacks the plain privilege. Applying the categories
    // migration (which only adds row-level-security policies) would not help, so say so instead of pointing at it.
    if (!RLS_RE.test(text) && PRIVILEGE_RE.test(text)) {
      return withCode(
        ctx === "categories.create"
          ? "Couldn’t create the category: the database user the app connects with isn’t allowed to write to the categories table (permission denied). " +
              "Applying the categories migration will not fix this — see “BEFORE YOU APPLY” in supabase/migrations/."
          : `The database user the app connects with isn’t allowed to ${READ_CONTEXTS.has(ctx) ? "read" : "change"} this data (permission denied). ` +
              "That is a database permissions setting, not a problem with what you entered.",
        403
      );
    }
    return withCode(
      ctx === "categories.create"
        ? "Couldn’t create the category: the database refused the change (row-level security). " +
            "The categories access migration hasn’t been applied yet — see supabase/migrations/."
        : "The database refused this change (row-level security).",
      403
    );
  }

  // A column the app tried to use isn't in the database yet (migration not applied)
  if (/supplier_order_number/.test(text) && (e.code === "PGRST204" || e.code === "42703" || /column/i.test(text))) {
    return withCode(
      "Supplier order numbers aren’t available yet: the database is missing the supplier_order_number column. " +
        "Apply the latest migration.",
      409,
      "supplier_order_number"
    );
  }

  switch (e.code) {
    case "23505":
      return withCode(ctx === "categories.create" ? "A category with that name already exists." : "Barcode already exists", 409);
    case "23503":
      return withCode("That category no longer exists. Reload and choose another.", 400, "category_id");
    case "22P02":
      return withCode("One of the values has an invalid format.", 400);
    case "23502":
      return withCode("A required field is missing.", 400);
    case "PGRST116":
      return withCode("Item not found. It may have been deleted.", 404);
    default:
      break;
  }

  if (NETWORK_RE.test(text)) {
    return withCode("Can’t reach the database. Check the connection, and that the Supabase project isn’t paused.", 503);
  }

  if (/^PGRST30\d$/.test(e.code) || /\bJWT\b|invalid api key/i.test(text)) {
    return withCode("The database rejected the app’s API key.", 500);
  }

  return withCode("Unexpected database error.", 500);
}

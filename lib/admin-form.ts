// The pure logic of the Admin item form: what is sent to the API when an item is saved, how the answer is checked, and the
// category choices. It lives here, not in app/admin/page.tsx, so the rules that decide what reaches the database (the
// heart of the category and supplier order number fix) can be tested without a browser: tests/unit/admin-form.test.ts and
// tests/api/admin-payload-roundtrip.test.ts. The page keeps the hooks, the focus handling and the JSX.
//
// Category ids are OPAQUE strings (uuid in the live database, digit strings for the bigint schema). They are compared
// with sameId() and never go through Number(): Number("<uuid>") is NaN, JSON.stringify turns NaN into null, and that
// is how a chosen category used to be dropped while the page still said "Medication updated."
import type { ComboboxOption } from "./combobox";
import type { Category, Medication } from "./db";
import { sameId } from "./ids";
import {
  UNKNOWN_CATEGORY_FILTER,
  UNKNOWN_CATEGORY_ID,
  isLowStock,
  naturalCompare,
  type CategoryCounts,
  type CategoryFilter,
} from "./inventory-view";
import { CATEGORY_NAME_MAX_LENGTH, UNIT_MAX_LENGTH } from "./limits";
import { normalizeCategory, normalizeMedication } from "./normalize";
import {
  SUPPLIER_ORDER_NUMBER_INVISIBLE_REASON,
  SUPPLIER_ORDER_NUMBER_MAX_LENGTH,
  parseSupplierOrderNumber,
} from "./supplier-order-number";

// ── The form ────────────────────────────────────────────────────────────────────────────────────

export type FormState = {
  name: string;
  barcode: string;
  /** Free text. Always a string here: leading zeros are significant. */
  supplier_order_number: string;
  photo_url: string | null;
  stock: string;
  threshold: string;
  unit: string;
  vendor_url: string;
  notes: string;
  /** Opaque id string (uuid or digits); null = uncategorized. */
  category_id: string | null;
};

export const EMPTY_FORM: FormState = {
  name: "",
  barcode: "",
  supplier_order_number: "",
  photo_url: null,
  stock: "",
  threshold: "",
  unit: "units",
  vendor_url: "",
  notes: "",
  category_id: null,
};

// The API names a bad field with these keys, which are exactly the form's keys.
export const FORM_KEYS = [
  "name",
  "barcode",
  "supplier_order_number",
  "photo_url",
  "stock",
  "threshold",
  "unit",
  "vendor_url",
  "notes",
  "category_id",
] as const;
export type FormKey = (typeof FORM_KEYS)[number];

export function isFormKey(value: string): value is FormKey {
  return (FORM_KEYS as readonly string[]).includes(value);
}

/** The form as it is when an item is opened for editing: every field holds what the item holds. */
export function formFromMedication(med: Medication): FormState {
  return {
    name: med.name ?? "",
    barcode: med.barcode,
    supplier_order_number: med.supplier_order_number ?? "",
    photo_url: med.photo_url,
    stock: String(med.stock),
    threshold: String(med.threshold),
    unit: med.unit,
    vendor_url: med.vendor_url ?? "",
    notes: med.notes ?? "",
    category_id: med.category_id,
  };
}

/**
 * After a save whose answer did not carry everything that was sent, the server's row becomes the baseline the next save is
 * compared with. The fields the person never touched must follow that row. They still hold the values from when the form
 * was opened, and someone else may have changed them since (a dispense takes the stock down, another person files the item
 * under a different category): left as they are, the next save would read the difference as the person's own change and put
 * the old values back. A field the person changed keeps their text.
 */
export function rebaseForm(form: FormState, loaded: Medication | null, saved: Medication): FormState {
  const was = loaded === null ? EMPTY_FORM : formFromMedication(loaded);
  const now = formFromMedication(saved);
  const follow = <K extends FormKey>(key: K): FormState[K] => (form[key] === was[key] ? now[key] : form[key]);
  return {
    name: follow("name"),
    barcode: follow("barcode"),
    supplier_order_number: follow("supplier_order_number"),
    photo_url: follow("photo_url"),
    stock: follow("stock"),
    threshold: follow("threshold"),
    unit: follow("unit"),
    vendor_url: follow("vendor_url"),
    notes: follow("notes"),
    category_id: follow("category_id"),
  };
}

// ── Reading what the server sends ───────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toMedication(body: unknown): Medication | null {
  if (!isRecord(body)) return null;
  const med = normalizeMedication(body);
  return Number.isSafeInteger(med.id) && med.id > 0 ? med : null;
}

export function toCategory(body: unknown): Category | null {
  if (!isRecord(body)) return null;
  const cat = normalizeCategory(body);
  return cat.id !== "" && cat.name.trim() !== "" ? cat : null;
}

// ── Saving: what is sent, and how the answer is checked ───────────────────────────────────────────

/** The JSON body of a save: only the keys that are present are written by the server. */
export type SavePayload = {
  name?: string | null;
  barcode?: string;
  photo_url?: string | null;
  unit?: string;
  stock?: number;
  threshold?: number;
  vendor_url?: string | null;
  notes?: string | null;
  category_id?: string | null;
  supplier_order_number?: string | null;
};

/** True when nothing would be sent. (A key whose value is null or 0 is still a key: clearing a field is a change.) */
export function isEmptyPayload(payload: SavePayload): boolean {
  return Object.keys(payload).length === 0;
}

export type SupplierPlan = {
  /** The supplier order number is only sent when it changed (or is non-empty on create). */
  send: boolean;
  /** Trimmed text, or null to clear. Exactly what the row must hold afterwards. */
  value: string | null;
};

/**
 * Sending the supplier order number only when it changed keeps saves working on a database that has not been
 * migrated yet: an item can still be edited as long as that field is left alone.
 */
export function planSupplier(form: FormState, editing: Medication | null): SupplierPlan {
  const typed = form.supplier_order_number.trim();
  const loaded = (editing?.supplier_order_number ?? "").trim();
  return { send: editing ? typed !== loaded : typed !== "", value: typed === "" ? null : typed };
}

// What the server stores for each field once it has validated it (app/api/medications/_shared.ts). Two values that
// normalize to the same thing are "unchanged": a field nobody touched must never be sent back.

/** Name, photo and vendor URL are trimmed by the server; a blank one means "none". */
export function trimmedOrNull(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? null : text;
}

/** Notes keep their own spacing and line breaks; only an all-blank value means "no notes". */
export function notesOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A blank unit becomes "units". */
export function unitOrDefault(value: string): string {
  return value.trim() || "units";
}

export function countOf(text: string): number {
  return text === "" ? 0 : Number(text);
}

/**
 * Creating sends every field. Editing sends only the fields that differ from the row as it was loaded into the form,
 * the category included.
 *
 * Why: stock changes all day from the Scan tab and the kiosk, and another person can file the item under a different
 * category while this form is open. A form that stays open for a minute holds the values from when it was opened, and
 * sending them all back would silently undo everything done since. A field the person did not change is not theirs to
 * overwrite, and that includes the category. A category that was changed is sent as its id text, and "no category" as an
 * explicit null (that is how a category is cleared).
 *
 * The result can be empty (nothing was changed): the caller then makes no request and says "No changes to save.", because
 * the server refuses an empty body.
 */
export function buildPayload(form: FormState, supplier: SupplierPlan, loaded: Medication | null): SavePayload {
  const body: SavePayload = {};
  if (loaded === null || trimmedOrNull(form.name) !== trimmedOrNull(loaded.name)) body.name = form.name;
  if (loaded === null || form.barcode.trim() !== loaded.barcode.trim()) body.barcode = form.barcode;
  if (loaded === null || trimmedOrNull(form.photo_url) !== trimmedOrNull(loaded.photo_url)) body.photo_url = form.photo_url;
  if (loaded === null || unitOrDefault(form.unit) !== unitOrDefault(loaded.unit)) body.unit = form.unit;
  if (loaded === null || countOf(form.stock) !== loaded.stock) body.stock = countOf(form.stock);
  if (loaded === null || countOf(form.threshold) !== loaded.threshold) body.threshold = countOf(form.threshold);
  if (loaded === null || trimmedOrNull(form.vendor_url) !== trimmedOrNull(loaded.vendor_url)) {
    body.vendor_url = form.vendor_url === "" ? null : form.vendor_url;
  }
  if (loaded === null || notesOrNull(form.notes) !== notesOrNull(loaded.notes)) {
    body.notes = form.notes === "" ? null : form.notes;
  }
  if (loaded === null || !sameId(form.category_id, loaded.category_id)) body.category_id = form.category_id;
  if (supplier.send) body.supplier_order_number = supplier.value;

  // An item that a scan created ("needs review") has to be completable with nothing else changed: the server clears that
  // flag on every successful save, so saving is how it is reviewed, and it refuses an empty body. The name is the one field
  // that can go as it is without changing anything: a scan leaves it empty, and null is what the server stores for that.
  if (loaded !== null && loaded.is_unnamed && isEmptyPayload(body)) body.name = trimmedOrNull(form.name);
  return body;
}

/**
 * Read-after-write: names the values the server accepted but did not actually store. Only a value that was SENT can be
 * missing: a category or supplier order number that was left out is whatever someone else left in the row, not a failure.
 */
export function findNotStored(saved: Medication, sent: SavePayload): string[] {
  const missing: string[] = [];
  if (sent.category_id !== undefined && !sameId(saved.category_id, sent.category_id)) missing.push("category");
  if (sent.supplier_order_number !== undefined && saved.supplier_order_number !== sent.supplier_order_number) {
    missing.push("supplier order number");
  }
  return missing;
}

// ── Text that is too long ───────────────────────────────────────────────────────────────────────
// These limits used to be an input's maxLength, which cuts pasted text off without a word: a 70-character code was saved as
// its first 64 characters and reported as "Saved". Now the text stays whole, the person is told next to the field, and
// nothing is saved until it fits. Lengths are counted the way the server counts them: characters (code points) of the text
// without the spaces around it, so an emoji is one character, not two.

// The numbers are the server's (lib/limits.ts); they are re-exported here because the form and its tests speak of them.
export { CATEGORY_NAME_MAX_LENGTH, UNIT_MAX_LENGTH };

export type FieldProblem = {
  /** Plain words for the person, shown next to the field. */
  message: string;
  /** How many characters the text has. */
  length: number;
  /** How many it may have. */
  max: number;
};

export type FormProblems = Partial<Record<"supplier_order_number" | "unit", FieldProblem>>;
export type ProblemField = keyof FormProblems;

/** The fields of the form in the order they appear on the page: the first problem is the one nearest the top. */
const PROBLEM_FIELD_ORDER: readonly ProblemField[] = ["supplier_order_number", "unit"];

function characterCount(text: string): number {
  return [...text].length;
}

function supplierProblem(sent: string | null | undefined): FieldProblem | null {
  if (typeof sent !== "string") return null;
  const length = characterCount(sent);
  if (length <= SUPPLIER_ORDER_NUMBER_MAX_LENGTH) return null;
  // The shared parser words the refusal, so the page and the server can never say different things. Invisible characters
  // are refused first, with their own message and hint: that is explained after the save, as it always was.
  const parsed = parseSupplierOrderNumber(sent);
  if (parsed.ok || parsed.reason === SUPPLIER_ORDER_NUMBER_INVISIBLE_REASON) return null;
  return { message: parsed.reason, length, max: SUPPLIER_ORDER_NUMBER_MAX_LENGTH };
}

function unitProblem(sent: string | undefined): FieldProblem | null {
  if (typeof sent !== "string") return null;
  const length = characterCount(sent.trim());
  if (length <= UNIT_MAX_LENGTH) return null;
  return { message: `Unit is too long (maximum ${UNIT_MAX_LENGTH} characters).`, length, max: UNIT_MAX_LENGTH };
}

/**
 * What is wrong with the form's text right now. Only what a save would SEND is checked: a unit or supplier order number
 * that is already stored and that nobody touched is not the person's change, so it never stops them editing something else.
 */
export function formProblems(form: FormState, loaded: Medication | null): FormProblems {
  const sent = buildPayload(form, planSupplier(form, loaded), loaded);
  const problems: FormProblems = {};
  const supplier = supplierProblem(sent.supplier_order_number);
  if (supplier) problems.supplier_order_number = supplier;
  const unit = unitProblem(sent.unit);
  if (unit) problems.unit = unit;
  return problems;
}

/** The field to take the keyboard to when a save is refused: the first one on the page that has a problem. */
export function firstProblemField(problems: FormProblems): ProblemField | null {
  return PROBLEM_FIELD_ORDER.find((field) => problems[field] !== undefined) ?? null;
}

/** The new-category box: the same limit and the same words as POST /api/categories. */
export function categoryNameProblem(name: string): FieldProblem | null {
  const length = characterCount(name.trim());
  if (length <= CATEGORY_NAME_MAX_LENGTH) return null;
  return {
    message: `Category name is too long (maximum ${CATEGORY_NAME_MAX_LENGTH} characters).`,
    length,
    max: CATEGORY_NAME_MAX_LENGTH,
  };
}

// ── Display helpers ─────────────────────────────────────────────────────────────────────────────

export function displayName(med: Pick<Medication, "name">): string | null {
  const name = typeof med.name === "string" ? med.name.trim() : "";
  return name === "" ? null : name;
}

export function supplierOf(med: Pick<Medication, "supplier_order_number">): string | null {
  const value = typeof med.supplier_order_number === "string" ? med.supplier_order_number.trim() : "";
  return value === "" ? null : value;
}

export type StockStatus = "out" | "low" | "ok";

/** The same rule as the Inventory tab: 0 is Out, at or below the threshold is Low, everything else is OK. */
export function stockStatus(med: Pick<Medication, "stock" | "threshold">): StockStatus {
  if (med.stock === 0) return "out";
  return isLowStock(med) ? "low" : "ok";
}

// ── Category choices ────────────────────────────────────────────────────────────────────────────
// One list of choices feeds both ways of picking: the native <select> (a short list, best on phones) and the searchable
// <Combobox> (a long list). They render exactly the same options, so they can never offer different things.

/** Value of the select option that opens the inline "new category" box. Cannot collide with an id (uuid or digits). */
export const NEW_CATEGORY_VALUE = "__new__";

export const UNCATEGORIZED_LABEL = "— Uncategorized —";

export type CategoryLabel = { kind: "category" | "unknown" | "uncategorized"; title: string };

export function categoryLabel(categoryId: string | null, categories: readonly Category[]): CategoryLabel {
  if (categoryId === null || categoryId.trim() === "") return { kind: "uncategorized", title: "Uncategorized" };
  const found = categories.find((c) => sameId(c.id, categoryId));
  if (!found) return { kind: "unknown", title: "Category unavailable" };
  const name = found.name.trim();
  return { kind: "category", title: name === "" ? "Unnamed category" : name };
}

/** Loaded categories plus the ones created on this page, without repeats, in the order the Inventory tab uses. */
export function mergeCategories(loaded: readonly Category[], created: readonly Category[]): Category[] {
  const merged: Category[] = [];
  for (const category of [...loaded, ...created]) {
    if (category.id === "" || merged.some((m) => sameId(m.id, category.id))) continue;
    merged.push(category);
  }
  return merged.sort((a, b) => naturalCompare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function filterToValue(filter: CategoryFilter): string {
  if (filter.kind === "all") return "all";
  if (filter.kind === "uncategorized") return "uncategorized";
  return filter.id;
}

export function valueToFilter(value: string): CategoryFilter {
  if (value === "all") return { kind: "all" };
  if (value === "uncategorized") return { kind: "uncategorized" };
  if (value === UNKNOWN_CATEGORY_ID) return UNKNOWN_CATEGORY_FILTER;
  return { kind: "category", id: value };
}

/** `aria-describedby` from the ids that apply: falsy entries are skipped; no ids at all means no attribute. */
export function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const list = ids.filter((id): id is string => typeof id === "string" && id !== "");
  return list.length > 0 ? list.join(" ") : undefined;
}

/** A category's name as people read it: a blank name shows as "Unnamed category", never as an empty row. */
export function categoryName(category: Category): string {
  return category.name.trim() === "" ? "Unnamed category" : category.name;
}

/**
 * The choices of the item form's Category field, in this order: Uncategorized; the item's current category when it is not
 * in the list (it stays selected, labelled honestly, so saving another field never clears it); every category; and the
 * "+ Create new category…" command. Values are category id strings and are never turned into numbers.
 */
export function formCategoryOptions(categories: readonly Category[], missingId: string | null, loading: boolean): ComboboxOption[] {
  const options: ComboboxOption[] = [{ value: "", label: UNCATEGORIZED_LABEL }];
  if (missingId !== null) {
    options.push({ value: missingId, label: loading ? "Current category (loading…)" : "Current category (name unavailable)" });
  }
  for (const category of categories) options.push({ value: category.id, label: categoryName(category) });
  options.push({ value: NEW_CATEGORY_VALUE, label: "+ Create new category…", kind: "action" });
  return options;
}

/** The choices of the list's category filter, each with the number of items it would show. */
export function listFilterOptions(categories: readonly Category[], counts: CategoryCounts, showUnavailable: boolean): ComboboxOption[] {
  const options: ComboboxOption[] = [{ value: "all", label: `All categories (${counts.all})` }];
  for (const category of categories) {
    options.push({ value: category.id, label: `${categoryName(category)} (${counts.byId[category.id] ?? 0})` });
  }
  options.push({ value: "uncategorized", label: `Uncategorized (${counts.uncategorized})` });
  if (showUnavailable) options.push({ value: UNKNOWN_CATEGORY_ID, label: `Category unavailable (${counts.unknown})` });
  return options;
}

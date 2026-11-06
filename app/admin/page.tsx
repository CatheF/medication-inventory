"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent, MouseEvent, ReactNode } from "react";
import {
  EMPTY_FORM,
  NEW_CATEGORY_VALUE,
  buildPayload,
  categoryLabel,
  categoryNameProblem,
  describedBy,
  displayName,
  filterToValue,
  findNotStored,
  firstProblemField,
  formCategoryOptions,
  formFromMedication,
  formProblems,
  isEmptyPayload,
  isFormKey,
  isRecord,
  listFilterOptions,
  mergeCategories,
  planSupplier,
  rebaseForm,
  stockStatus,
  supplierOf,
  toCategory,
  toMedication,
  valueToFilter,
  type CategoryLabel,
  type FieldProblem,
  type FormKey,
  type FormState,
  type ProblemField,
  type StockStatus,
  type SupplierPlan,
} from "@/lib/admin-form";
import { shouldUseCombobox, type ComboboxOption } from "@/lib/combobox";
import type { Category, Medication } from "@/lib/db";
import { categoryTitleByKey, describeActiveFilters, type ActiveFilterKey } from "@/lib/filter-chips";
import { sameId } from "@/lib/ids";
import {
  DEFAULT_VIEW,
  describeEmpty,
  isUnknownCategoryFilter,
  selectView,
  sortItems,
  type CategoryFilter,
  type EmptyKind,
  type ViewState,
} from "@/lib/inventory-view";
import { normalizeCategory, normalizeMedication } from "@/lib/normalize";
import { SUPPLIER_ORDER_NUMBER_INVISIBLE_REASON } from "@/lib/supplier-order-number";
import { ActiveFilterChips, type ActiveFilter } from "../components/ActiveFilterChips";
import { Combobox } from "../components/Combobox";
import { EmptyStateCard, type EmptyAction, type EmptyIcon } from "../components/EmptyStateCard";
import { ItemThumb } from "../components/ItemThumb";
import { Notice } from "../components/Notice";

// Admin: add, edit and delete medications; assign categories; enter supplier order numbers.
//
// Category ids are OPAQUE strings (uuid in the live database, digit strings for the bigint schema). They are compared
// with sameId() and never go through Number(): Number("<uuid>") is NaN, JSON.stringify turns NaN into null, and that
// is how a chosen category used to be dropped while the page still said "Medication updated."
//
// Nothing here claims success without proof: a save counts as saved only when the server answers 2xx AND the row it
// sends back carries the category (and supplier order number) that was sent. A failed load is an error with a Retry
// button, never an empty list.
//
// Shared patterns (app/components): the list's filters show as removable chips (ActiveFilterChips); an empty list is an
// EmptyStateCard with the action that fits (add the first medication / clear the filters); and once there are
// COMBOBOX_MIN_OPTIONS categories (lib/combobox.ts shouldUseCombobox) the form's Category field and the list's category
// filter become a searchable Combobox instead of a native <select>. Both render the same option list.

// ── Types ───────────────────────────────────────────────────────────────────────────────────────

type MedsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: Medication[]; refreshError: string | null };

type CatsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: Category[] };

/** The one message the page shows about an action. `scope` decides where: inside the open form, or at the page top. */
type NoticeState = {
  tone: "error" | "success" | "info";
  scope: "form" | "page";
  /** A fixed phrase ("Not saved"). Text that comes from the data (an item name, a barcode) goes in `subject`. */
  title?: string;
  /** What the message is about: an item's name or barcode. Free text, so it wraps however long it is. */
  subject?: string;
  message: string;
  hint?: string;
  detail?: string | null;
  /** The item this success message is about; its row repeats "Saved" next to its buttons. */
  savedId?: number;
};

type FocusTarget =
  | "notice"
  | "form-heading"
  | "new-category-input"
  | "category-select"
  | "supplier-input"
  | "unit-input"
  | "opener"
  | "saved-row"
  | "list-heading";

/** What a Retry button is retrying. Each kind runs at most once at a time. */
type RetryKind = "medications" | "categories";

const NO_MEDICATIONS: Medication[] = [];

/** Where the keyboard goes when a save is refused because of a field's text: the field itself, where the message is. */
const PROBLEM_FOCUS: Record<ProblemField, FocusTarget> = { supplier_order_number: "supplier-input", unit: "unit-input" };

/** Test ids of the three kinds of message an action can end in. */
const NOTICE_TEST_ID: Record<NoticeState["tone"], string> = { success: "admin-success", error: "admin-error", info: "admin-info" };

// ── Requests ────────────────────────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const JSON_HEADERS = { "Content-Type": "application/json" };

type ApiFailure = {
  kind: "failed";
  /** null: no HTTP answer at all (offline, DNS, timeout). */
  status: number | null;
  timedOut: boolean;
  message: string;
  /** True when the answer was the app's own JSON error ({ error }), not a bare HTTP error page from something else. */
  fromApi: boolean;
  /** The server's technical detail and error code, when it sent them. */
  detail: string | null;
  /** The form field the server blames, when it names one. */
  field: string | null;
};
type ApiSuccess = { kind: "ok"; status: number; body: unknown };
type ApiResult = ApiSuccess | ApiFailure;

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
}

function readFailure(status: number, body: unknown): ApiFailure {
  const record = isRecord(body) ? body : null;
  const error = record && typeof record.error === "string" ? record.error.trim() : "";
  const detail = record && typeof record.detail === "string" ? record.detail.trim() : "";
  const code = record && typeof record.code === "string" ? record.code.trim() : "";
  const field = record && typeof record.field === "string" && record.field !== "" ? record.field : null;
  const technical = [detail, code ? `code ${code}` : ""].filter((part) => part !== "").join(" · ");
  return {
    kind: "failed",
    status,
    timedOut: false,
    message: error !== "" ? error : `The server answered with an error (HTTP ${status}).`,
    fromApi: error !== "",
    detail: technical !== "" ? technical : null,
    field,
  };
}

/** One fetch with a time limit. Never throws: every outcome is a value the caller has to look at. */
async function callApi(url: string, init: RequestInit = {}): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init, signal: timeoutSignal() });
  } catch (err) {
    const timedOut = err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      kind: "failed",
      status: null,
      timedOut,
      message: timedOut
        ? "The server took too long to answer."
        : "Could not reach the server. Check the internet connection.",
      fromApi: false,
      detail: null,
      field: null,
    };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null; // not JSON; the caller decides what that means
  }
  if (!res.ok) return readFailure(res.status, body);
  return { kind: "ok", status: res.status, body };
}

type LoadResult<T> = { ok: true; items: T[] } | { ok: false; message: string };

async function loadList<T>(
  url: string,
  noun: string,
  convert: (row: Record<string, unknown>) => T,
  isValid: (item: T) => boolean
): Promise<LoadResult<T>> {
  const unexpected: LoadResult<T> = { ok: false, message: `The server sent an unexpected answer for the ${noun}.` };
  const result = await callApi(url);
  if (result.kind === "failed") {
    if (result.status !== null) return { ok: false, message: result.message };
    return {
      ok: false,
      message: result.timedOut
        ? `The server took too long to answer while loading the ${noun}.`
        : `Could not reach the server while loading the ${noun}. Check the internet connection.`,
    };
  }
  const body = result.body;
  if (!Array.isArray(body) || !body.every(isRecord)) return unexpected;
  try {
    const items = body.map(convert);
    return items.every(isValid) ? { ok: true, items } : unexpected;
  } catch {
    return unexpected; // a load must always end in a value, or the page would stay on "Loading…" forever
  }
}

// The noun is "inventory", as on the Inventory tab, so a failed load is worded the same on every screen.
const loadMedications = () =>
  loadList("/api/medications", "inventory", normalizeMedication, (m) => Number.isSafeInteger(m.id) && m.id > 0);
const loadCategories = () => loadList("/api/categories", "category list", normalizeCategory, (c) => c.id !== "");

/** The words staff see wherever the inventory could not be loaded: the same title and reassurance on every screen. */
const LOAD_ERROR_TITLE = "Couldn’t load the inventory";
const LOAD_ERROR_REASSURANCE = "This does not mean the inventory is empty.";

// ── Category choices ────────────────────────────────────────────────────────────────────────────
// The choices (formCategoryOptions, listFilterOptions in lib/admin-form.ts) feed both ways of picking: the native <select> (a
// short list, best on phones) and the searchable <Combobox> (a long list). They render the same options, so they can never
// offer different things.

/** The options of a native <select>, from the same list the searchable picker gets. */
function NativeOptions({ options }: { options: readonly ComboboxOption[] }) {
  return (
    <>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </>
  );
}

// ── Active filters and empty states ─────────────────────────────────────────────────────────────
// The words on the filter chips ("Category: Antibiotics", "Search: “ibuprofen”") come from lib/filter-chips.ts, the one
// implementation the Inventory tab uses as well, so the two screens cannot word the same filter differently. Whether a search
// counts as one (blank text, whitespace and text made only of invisible characters do not) is decided there too, by the same
// rule the "Showing X of Y" line uses (tests/unit/filter-chips.test.ts compares the two).

const EMPTY_ICON: Record<EmptyKind, EmptyIcon> = { "no-items": "box", "category-empty": "folder", "no-match": "search" };

// ── Look ────────────────────────────────────────────────────────────────────────────────────────

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700";
const LABEL_BASE = "mb-1.5 flex flex-wrap items-center gap-x-1.5 text-base font-semibold";
const LABEL = `${LABEL_BASE} text-gray-900`;
const HELP = "mt-1.5 text-sm text-gray-600";
const CONTROL =
  "min-h-11 w-full rounded-[10px] border border-gray-400 bg-white px-3 py-2 text-base text-gray-900 placeholder:text-gray-500! focus-visible:border-blue-700 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-700 aria-invalid:border-red-600 aria-invalid:bg-red-50 disabled:opacity-60";
const BTN = `inline-flex min-h-11 items-center justify-center rounded-[10px] px-4 text-base font-semibold ${FOCUS}`;
const BTN_PRIMARY = `${BTN} bg-blue-700 text-white hover:bg-blue-800 disabled:opacity-60`;
const BTN_SECONDARY = `${BTN} border border-gray-400 bg-white text-gray-800 hover:bg-gray-50`;
const BTN_DANGER = `${BTN} border border-red-300 bg-white text-red-700 hover:bg-red-50`;
// max-w-full + overflow-wrap: a category name is free text and may be one long unbroken string; it wraps inside the card
// instead of running out of it.
const TAG = "inline-flex max-w-full items-center gap-1 rounded-md border px-2 text-[13px] leading-5 [overflow-wrap:anywhere]";
// Codes (barcodes, supplier order numbers) are compared character by character, so they get an explicit monospace
// stack: 0 and O, 1 and l must look different.
const MONO = "[font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace]";

const PILL: Record<StockStatus, { label: string; className: string }> = {
  out: { label: "Out", className: "border-red-200 bg-red-100 text-red-800" },
  low: { label: "Low", className: "border-amber-200 bg-amber-100 text-amber-800" },
  ok: { label: "OK", className: "border-green-200 bg-green-100 text-green-800" },
};

// Decorative icons (the words next to them carry the meaning).
function Icon({ className = "h-4 w-4", children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      className={`shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function TagIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </Icon>
  );
}

function WarnIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </Icon>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <polyline points="20 6 9 17 4 12" />
    </Icon>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <polyline points="6 9 12 15 18 9" />
    </Icon>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </Icon>
  );
}

function BarcodeGlyph() {
  return (
    <svg className="h-3 w-[17px] shrink-0" viewBox="0 0 18 12" fill="currentColor" aria-hidden="true" focusable="false">
      <rect x="0" width="2" height="12" />
      <rect x="3" width="1" height="12" />
      <rect x="5" width="3" height="12" />
      <rect x="9" width="1" height="12" />
      <rect x="11" width="2" height="12" />
      <rect x="14" width="1" height="12" />
      <rect x="16" width="2" height="12" />
    </svg>
  );
}

// ── Small components ────────────────────────────────────────────────────────────────────────────

/**
 * "Retry" under a notice's message: 44px tall (the shared Notice's own button is smaller).
 *
 * While a retry is running the button stays in place, says so, and ignores clicks. It is aria-disabled instead of
 * disabled on purpose: a disabled button drops keyboard focus, and the person who pressed Enter on it would have to
 * tab from the top of the page again.
 */
function RetryButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      data-retry-button=""
      onClick={busy ? undefined : onClick}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      className={`mt-2.5 inline-flex min-h-11 items-center rounded-lg border border-current px-4 text-sm font-semibold hover:bg-white/60 ${FOCUS} ${busy ? "cursor-progress opacity-80" : ""}`}
    >
      {busy ? "Retrying…" : "Retry"}
    </button>
  );
}

type FieldProps = {
  id: string;
  label: ReactNode;
  /** "optional" / "required" text after the label (real words, not just a star). */
  note?: string;
  /** Rendered as the field's help text; the control points at it with aria-describedby={`${id}-help`}. */
  help?: ReactNode;
  className?: string;
  labelClassName?: string;
  children: ReactNode;
};

function Field({ id, label, note, help, className = "", labelClassName = "text-gray-900", children }: FieldProps) {
  return (
    <div className={className}>
      <label htmlFor={id} className={`${LABEL_BASE} ${labelClassName}`}>
        {label}
        {note && <span className="font-normal text-gray-700">({note})</span>}
      </label>
      {children}
      {help && (
        <p id={`${id}-help`} className={HELP}>
          {help}
        </p>
      )}
    </div>
  );
}

/**
 * What is wrong with a field's text, right under the field: an icon and words, never colour alone. The message is the
 * live region and never changes while the text keeps being too long, so a screen reader says it once, not on every
 * keystroke; how many characters were typed is plain text beside it. The field points at the message with
 * aria-describedby, so it is read out when the keyboard lands there.
 */
function FieldProblemMessage({ id, testId, problem }: { id: string; testId: string; problem: FieldProblem }) {
  return (
    <div className="mt-1.5 flex items-start gap-1.5 text-sm text-red-700">
      <WarnIcon className="mt-0.5 h-4 w-4" />
      <div className="min-w-0">
        <p id={id} data-testid={testId} role="alert" className="font-semibold [overflow-wrap:anywhere]">
          {problem.message}
        </p>
        <p className="mt-0.5">You typed {problem.length} characters.</p>
      </div>
    </div>
  );
}

function CategoryTag({ label }: { label: CategoryLabel }) {
  if (label.kind === "category") {
    return (
      <>
        <span className="sr-only">Category: </span>
        <span className={`${TAG} border-blue-200 bg-blue-50 font-semibold text-blue-800`}>{label.title}</span>
      </>
    );
  }
  if (label.kind === "unknown") {
    return (
      <span className={`${TAG} border-dashed border-amber-500 bg-amber-50 font-semibold text-amber-900`}>
        <WarnIcon className="h-3 w-3" />
        {label.title}
      </span>
    );
  }
  return <span className={`${TAG} border-dashed border-gray-400 font-medium italic text-gray-700`}>{label.title}</span>;
}

function StatusPill({ status }: { status: StockStatus }) {
  const { label, className } = PILL[status];
  return (
    <span
      data-status={status}
      className={`inline-flex items-center rounded-full border px-2.5 py-px text-[13px] leading-5 font-bold whitespace-nowrap ${className}`}
    >
      <span className="sr-only">Stock status: </span>
      {label}
    </span>
  );
}

function ListSkeleton() {
  const bar = "animate-pulse rounded bg-gray-200 motion-reduce:animate-none";
  return (
    <div data-testid="admin-loading" className="p-4 sm:p-5">
      <p role="status" className="mb-4 text-base text-gray-700">
        Loading medications…
      </p>
      <ul aria-hidden="true" className="space-y-4">
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex items-center gap-3">
            <div className={`h-10 w-10 shrink-0 rounded-lg ${bar}`} />
            <div className="flex-1 space-y-2">
              <div className={`h-4 w-2/3 ${bar}`} />
              <div className={`h-3 w-1/3 ${bar}`} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

type RowProps = {
  med: Medication;
  categories: readonly Category[];
  /** This row was just saved: it says so, because the keyboard focus returns to this row after a save. */
  saved: boolean;
  /** A delete request for this row is in flight. */
  deleting: boolean;
  onEdit: (med: Medication, trigger: HTMLElement) => void;
  onDelete: (med: Medication) => void;
};

// 80%, not less: "Deleting…" is information, and the text must stay readable (4.5:1) while the button is inactive.
const BUSY = "aria-disabled:cursor-progress aria-disabled:opacity-80";

// Memoized: every keystroke in the item form re-renders the page, and the list below it must not follow (a long list took
// hundreds of milliseconds per key). A row re-renders only when its own item, the categories, its "Saved" mark, its
// "Deleting…" state or its handlers change, so the page hands it handlers that keep one identity (see editRow / deleteRow).
const MedicationRow = memo(function MedicationRow({ med, categories, saved, deleting, onEdit, onDelete }: RowProps) {
  const name = displayName(med);
  const supplier = supplierOf(med);
  const status = stockStatus(med);
  const category = categoryLabel(med.category_id, categories);
  const nameId = `admin-name-${med.id}`;

  return (
    <li
      data-testid={`admin-row-${med.id}`}
      aria-busy={deleting || undefined}
      className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-3 gap-y-3 p-4 hover:bg-gray-50 md:grid-cols-[40px_minmax(0,1fr)_auto_auto] md:items-start"
    >
      <ItemThumb name={med.name} photoUrl={med.photo_url} size={40} />

      <div className="min-w-0">
        <p id={nameId} className="text-base leading-snug font-semibold text-gray-900 [overflow-wrap:anywhere]">
          {name ?? <span className="font-medium italic text-gray-700">Unnamed item</span>}
        </p>
        <p className="mt-1.5 flex flex-wrap gap-1.5" data-testid={`admin-category-${med.id}`}>
          <CategoryTag label={category} />
          {med.is_unnamed && <span className={`${TAG} border-amber-200 bg-amber-100 font-semibold text-amber-800`}>Needs review</span>}
        </p>
        {/* The page-level "Saved." message is at the top of the page; on a long list that is far from this row. The
            keyboard focus comes back to this row, so the confirmation is repeated here, where the person is looking.
            It is plain text, not a live region: the page-level message is what screen readers announce. */}
        {saved && (
          <p
            data-testid={`admin-saved-${med.id}`}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-green-300 bg-green-50 px-2 text-sm leading-6 font-semibold text-green-800"
          >
            <CheckIcon className="h-3.5 w-3.5" />
            Saved
          </p>
        )}
        <dl className="mt-2.5 flex flex-wrap gap-x-7 gap-y-2.5">
          <div className="min-w-0" data-testid={`admin-barcode-${med.id}`}>
            <dt className="flex items-center gap-1.5 text-[13px] leading-snug font-bold text-gray-700">
              <BarcodeGlyph />
              Barcode
            </dt>
            <dd className={`mt-0.5 ${MONO} text-[15px] leading-snug break-all text-gray-900`}>{med.barcode}</dd>
          </div>
          <div className="min-w-0" data-testid={`admin-supplier-${med.id}`}>
            <dt className="flex items-center gap-1.5 text-[13px] leading-snug font-bold text-teal-700">
              <TagIcon className="h-[15px] w-[15px]" />
              Supplier order no.
            </dt>
            <dd className="mt-0.5 leading-snug">
              {supplier !== null ? (
                <span className={`inline-block max-w-full rounded-md border border-teal-200 bg-teal-50 px-2 ${MONO} text-[15px] break-all text-gray-900`}>
                  {supplier}
                </span>
              ) : (
                <span className="text-[15px] italic text-gray-700">Not set</span>
              )}
            </dd>
          </div>
        </dl>
      </div>

      {/* The unit is free text and can be one long unbroken string: it wraps, and the column cannot grow past 14rem. */}
      <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 md:col-start-auto md:block md:max-w-56 md:text-right">
        <p className="text-[15px] text-gray-700 [overflow-wrap:anywhere]">
          <span className="sr-only">Stock: </span>
          <strong className="text-xl font-bold text-gray-900 tabular-nums">{med.stock}</strong> {med.unit}
        </p>
        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 md:mt-1 md:justify-end">
          <StatusPill status={status} />
          <span className="text-[13px] text-gray-700">Threshold: {med.threshold}</span>
        </p>
      </div>

      {/* While a delete is in flight the row's buttons are aria-disabled (not disabled: that would drop keyboard focus). */}
      <div className="col-start-2 flex flex-wrap gap-2 md:col-start-auto">
        <button
          type="button"
          id={`admin-edit-${med.id}`}
          data-testid={`admin-edit-${med.id}`}
          aria-describedby={nameId}
          aria-disabled={deleting || undefined}
          onClick={(event: MouseEvent<HTMLButtonElement>) => {
            if (!deleting) onEdit(med, event.currentTarget);
          }}
          className={`${BTN_SECONDARY} ${BUSY}`}
        >
          Edit
        </button>
        <button
          type="button"
          data-testid={`admin-delete-${med.id}`}
          aria-describedby={nameId}
          aria-disabled={deleting || undefined}
          onClick={() => {
            if (!deleting) onDelete(med);
          }}
          className={`${BTN_DANGER} ${BUSY}`}
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
    </li>
  );
});

// ── Page ────────────────────────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  // Data. "loading" until the request settles; a failed request is "error", never an empty list.
  const [meds, setMeds] = useState<MedsState>({ status: "loading" });
  const [cats, setCats] = useState<CatsState>({ status: "loading" });
  // Categories created on this page: shown even if the next category list the server sends does not include them yet.
  const [createdCategories, setCreatedCategories] = useState<Category[]>([]);
  const latestMedsRequest = useRef(0);
  const latestCatsRequest = useRef(0);

  // Form
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Medication | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [fieldError, setFieldError] = useState<FormKey | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  // Every time the form opens, closes or switches to another item, the "form session" changes. A photo upload or a
  // category creation remembers the session it started in and drops its answer if the session is no longer the same:
  // a late answer must not land in the form of a different item.
  const formSession = useRef(0);
  const photoRequest = useRef(0);
  // Part of the file input's key: a file chosen for one form must not still be shown as chosen in the next one.
  const [formKey, setFormKey] = useState(0);

  // Rows whose delete request is in flight. The ref answers "already deleting this?" at the very moment of a click,
  // before React has re-rendered; the state is what the rows render from.
  const deletingRef = useRef<Set<number>>(new Set());
  const [deleting, setDeleting] = useState<ReadonlySet<number>>(new Set());

  // Retry buttons: which retries are running, and a polite message for screen readers.
  const retryingRef = useRef<Record<RetryKind, boolean>>({ medications: false, categories: false });
  const [retrying, setRetrying] = useState<Record<RetryKind, boolean>>({ medications: false, categories: false });
  const [announcement, setAnnouncement] = useState("");

  // Inline category creation
  const [creatingNew, setCreatingNew] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [creatingCat, setCreatingCat] = useState(false);
  const [catError, setCatError] = useState<{ message: string; detail: string | null } | null>(null);
  const [catNote, setCatNote] = useState<string | null>(null);
  // The last attempt to create a category was refused with a permission error (HTTP 403). That is about the database, not
  // about one form: the help line under the select keeps saying so after the red error is gone, and on the next form,
  // instead of inviting the same action again. Any later answer (a success, another kind of failure) replaces it.
  const [categoryCreateDenied, setCategoryCreateDenied] = useState(false);

  // List filters
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>({ kind: "all" });

  // Keyboard focus: where it goes after the page changes under the user (form opens, save fails, row is deleted...).
  const noticeRef = useRef<HTMLDivElement>(null);
  const formHeadingRef = useRef<HTMLHeadingElement>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  // The form's Category field is a native <select> for a short list and the searchable <Combobox> (its text input) for a
  // long one; only one of the two is on the page at a time, so "focus the category field" asks both.
  const categorySelectRef = useRef<HTMLSelectElement>(null);
  const categoryComboRef = useRef<HTMLInputElement>(null);
  const newCatInputRef = useRef<HTMLInputElement>(null);
  const supplierInputRef = useRef<HTMLInputElement>(null);
  const unitInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // The control that opened the form, so Cancel and Save can hand the focus back to it. `testId` finds it again when React
  // made a new element for it while the form was open: the empty list's "Add medication" is taken off the page then.
  const openerRef = useRef<{ element: HTMLElement; medicationId: number | null; testId: string | null } | null>(null);
  const focusSeq = useRef(0);
  const [focusRequest, setFocusRequest] = useState<{ target: FocusTarget; seq: number } | null>(null);

  const requestFocus = useCallback((target: FocusTarget) => {
    focusSeq.current += 1;
    setFocusRequest({ target, seq: focusSeq.current });
  }, []);

  // The request is made together with the state change that puts the target on screen, so the element exists when
  // this effect runs after the commit. It only moves focus; it never sets state.
  useEffect(() => {
    if (!focusRequest) return;
    let element: HTMLElement | null = null;
    switch (focusRequest.target) {
      case "notice":
        element = noticeRef.current;
        break;
      case "form-heading":
        element = formHeadingRef.current;
        break;
      case "new-category-input":
        element = newCatInputRef.current;
        break;
      case "category-select":
        element = categorySelectRef.current ?? categoryComboRef.current;
        break;
      case "supplier-input":
        element = supplierInputRef.current;
        break;
      case "unit-input":
        element = unitInputRef.current;
        break;
      case "list-heading":
        element = listHeadingRef.current;
        break;
      case "opener":
      case "saved-row": {
        // Back to the control that opened the form; if that is gone (the "Complete" button of an item that is no
        // longer unnamed), to the item's Edit button, or to the new copy of a button that was re-created while the form
        // was open. Past that the two differ: after Cancel the list is the next best place; after a save there is
        // nothing to go back to when the item left the filtered list (it was moved to another category) or the empty
        // card is gone, so the "Saved" message itself is the place to land.
        const opener = openerRef.current;
        if (opener?.element.isConnected) element = opener.element;
        else if (opener?.medicationId != null) element = document.getElementById(`admin-edit-${opener.medicationId}`);
        else if (opener?.testId) element = document.querySelector<HTMLElement>(`[data-testid="${opener.testId}"]`);
        if (focusRequest.target === "saved-row") element ??= noticeRef.current;
        element ??= listHeadingRef.current ?? document.getElementById("admin-add-button");
        break;
      }
    }
    element?.focus();
  }, [focusRequest]);

  // ── Loading ──
  // The lint rule against setState in effects is satisfied the same way app/page.tsx does it: the effect only starts
  // module-level requests, and state is set in the .then() callbacks.
  const applyMedications = useCallback((requestId: number, result: LoadResult<Medication>) => {
    if (requestId !== latestMedsRequest.current) return; // a newer request replaced this one
    setMeds((prev) => {
      if (result.ok) return { status: "ready", items: result.items, refreshError: null };
      // A refresh that fails after a good load keeps the list on screen and says so.
      if (prev.status === "ready") return { ...prev, refreshError: result.message };
      return { status: "error", message: result.message };
    });
  }, []);

  const applyCategories = useCallback((requestId: number, result: LoadResult<Category>) => {
    if (requestId !== latestCatsRequest.current) return;
    setCats((prev) => {
      if (result.ok) return { status: "ready", items: result.items };
      if (prev.status === "ready") return prev; // keep the names already known
      return { status: "error", message: result.message };
    });
  }, []);

  const reloadMedications = useCallback(
    (showLoading: boolean) => {
      const requestId = ++latestMedsRequest.current;
      if (showLoading) setMeds({ status: "loading" });
      loadMedications().then((result) => applyMedications(requestId, result));
    },
    [applyMedications]
  );

  useEffect(() => {
    const medsRequest = ++latestMedsRequest.current;
    const catsRequest = ++latestCatsRequest.current;
    loadMedications().then((result) => applyMedications(medsRequest, result));
    loadCategories().then((result) => applyCategories(catsRequest, result));
  }, [applyMedications, applyCategories]);

  const upsertMedication = (saved: Medication) =>
    setMeds((prev) => {
      if (prev.status !== "ready") return prev;
      const exists = prev.items.some((m) => m.id === saved.id);
      return { ...prev, items: exists ? prev.items.map((m) => (m.id === saved.id ? saved : m)) : [...prev.items, saved] };
    });

  const removeMedication = (id: number) =>
    setMeds((prev) => (prev.status === "ready" ? { ...prev, items: prev.items.filter((m) => m.id !== id) } : prev));

  // ── Derived ──
  const categories = useMemo(
    () => mergeCategories(cats.status === "ready" ? cats.items : [], createdCategories),
    [cats, createdCategories]
  );
  const items = meds.status === "ready" ? meds.items : NO_MEDICATIONS;
  const viewState: ViewState = useMemo(
    () => ({ ...DEFAULT_VIEW, search, category: categoryFilter, grouped: false }),
    [search, categoryFilter]
  );
  const view = useMemo(() => selectView(items, categories, viewState), [items, categories, viewState]);
  const unnamed = useMemo(() => sortItems(items.filter((m) => m.is_unnamed), "name", categories), [items, categories]);
  // The list is shown only after BOTH requests settled: until the categories are known every categorized item would
  // read "Category unavailable".
  const listReady = meds.status === "ready" && cats.status !== "loading";
  const unknownSelected = isUnknownCategoryFilter(categoryFilter);

  const selectedCategory = form.category_id === null ? null : (categories.find((c) => sameId(c.id, form.category_id)) ?? null);
  // The item's category is not in the list (categories failed to load, or it is gone). It stays selected, labelled
  // honestly, so saving another field never clears it.
  const currentCategoryMissing = form.category_id !== null && selectedCategory === null;
  const categorySelectValue = creatingNew ? NEW_CATEGORY_VALUE : (selectedCategory?.id ?? form.category_id ?? "");

  // A long list of categories is picked with the searchable Combobox, a short one with the native <select> (best on
  // phones). The form's Category field and the list's filter switch at the same number of categories.
  const searchableCategories = shouldUseCombobox(categories.length);
  const missingCategoryId = currentCategoryMissing ? form.category_id : null;
  const categoriesLoading = cats.status === "loading";
  const categoryOptions = useMemo(
    () => formCategoryOptions(categories, missingCategoryId, categoriesLoading),
    [categories, missingCategoryId, categoriesLoading]
  );
  const filterChoices = useMemo(
    () => listFilterOptions(categories, view.counts, view.counts.unknown > 0 || unknownSelected),
    [categories, view.counts, unknownSelected]
  );

  // The line under the category field. An empty list is not proof that no category exists (a table hidden by a database
  // permission also reads as empty), so it is described neutrally, never as an invitation to create one. A creation the
  // database refused (HTTP 403) is said plainly instead: the person can still save the item, without a category.
  const categoryHelp =
    cats.status === "error"
      ? "Categories could not be loaded. The item keeps its current category unless you change it."
      : categoryCreateDenied
        ? "Categories can’t be created until the database permission is fixed. You can still save the item without a category."
        : cats.status === "ready" && categories.length === 0
          ? "No categories are available yet."
          : "Used to group this item on the Inventory tab.";

  // The server refused the supplier order number for invisible characters: the hint under the field says what to do about
  // it (the notice shows the server's own text). The refusal is recognised by that exact text, the shared constant the
  // server sends it from, so rewording it in lib/supplier-order-number.ts can never silently drop the hint. The hint goes
  // with the field's red state and clears when the field is edited.
  const supplierPasteHint =
    fieldError === "supplier_order_number" &&
    notice?.scope === "form" &&
    notice.tone === "error" &&
    notice.message === SUPPLIER_ORDER_NUMBER_INVISIBLE_REASON;

  // Text that is too long, flagged next to its field as soon as it is there (a paste can bring it in one go). The inputs set
  // no maxLength: that would cut pasted text off without a word. Only what a save would send is checked (lib/admin-form.ts).
  const problems = showForm ? formProblems(form, editing) : {};
  const newCategoryProblem = creatingNew ? categoryNameProblem(newCatName) : null;

  // ── Retry ──
  // A Retry button does not make its own message vanish while it works. The failed list or warning stays where it is,
  // the button says "Retrying…" (and ignores clicks), and the result is announced. If the retry fails, the button is
  // still there and keyboard focus has not moved. If it succeeds, the message and the button go away, so focus moves to
  // the list heading, unless the person has already gone somewhere else.
  const setRetry = (kind: RetryKind, running: boolean) => {
    retryingRef.current[kind] = running;
    setRetrying((prev) => ({ ...prev, [kind]: running }));
  };

  const focusIsOnRetryOrLost = () => {
    const active = document.activeElement;
    return active === null || active === document.body || (active instanceof HTMLElement && active.hasAttribute("data-retry-button"));
  };

  const retryMedications = () => {
    if (retryingRef.current.medications) return;
    setRetry("medications", true);
    setAnnouncement("Retrying…");
    const requestId = ++latestMedsRequest.current;
    void loadMedications().then((result) => {
      const restoreFocus = result.ok && focusIsOnRetryOrLost();
      applyMedications(requestId, result);
      setRetry("medications", false);
      setAnnouncement(result.ok ? "Inventory loaded." : "The inventory still could not be loaded.");
      if (restoreFocus && requestId === latestMedsRequest.current) requestFocus("list-heading");
    });
  };

  const retryCategories = () => {
    if (retryingRef.current.categories) return;
    setRetry("categories", true);
    setAnnouncement("Retrying…");
    const requestId = ++latestCatsRequest.current;
    void loadCategories().then((result) => {
      const restoreFocus = result.ok && focusIsOnRetryOrLost();
      applyCategories(requestId, result);
      setRetry("categories", false);
      setAnnouncement(result.ok ? "Categories loaded." : "The categories still could not be loaded.");
      if (restoreFocus && requestId === latestCatsRequest.current) requestFocus("list-heading");
    });
  };

  // ── Form handlers ──
  // Closing, opening or switching the form ends the current "form session" and clears everything that belonged to it.
  const resetTransient = () => {
    formSession.current += 1; // a photo upload or category creation still on its way belongs to the form that just went away
    setFormKey((k) => k + 1);
    setNotice(null);
    setFieldError(null);
    setCreatingNew(false);
    setNewCatName("");
    setCatError(null);
    setCatNote(null);
    setPhotoError(null);
    setPhotoUploading(false);
    setCreatingCat(false);
  };

  const openNew = (trigger: HTMLElement) => {
    if (saving) return; // a save is in flight: its answer belongs to the form that is open now
    openerRef.current = { element: trigger, medicationId: null, testId: trigger.getAttribute("data-testid") };
    setEditing(null);
    setForm(EMPTY_FORM);
    resetTransient();
    setShowForm(true);
    requestFocus("form-heading");
  };

  const openEdit = (med: Medication, trigger: HTMLElement) => {
    if (saving) return; // a save is in flight: its answer belongs to the form that is open now
    openerRef.current = { element: trigger, medicationId: med.id, testId: null };
    setEditing(med);
    setForm(formFromMedication(med));
    resetTransient();
    setShowForm(true);
    requestFocus("form-heading");
  };

  const closeForm = () => {
    if (saving) return; // a save is in flight: its answer belongs to the form that is open now
    setShowForm(false);
    setEditing(null);
    resetTransient();
    requestFocus("opener");
  };

  // "No changes to save." describes the form as it was when Save was pressed: as soon as the form changes it is out of date.
  const dismissInfoNotice = () => setNotice((current) => (current?.tone === "info" ? null : current));

  const setFormValue = <K extends FormKey>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (fieldError === key) setFieldError(null);
    dismissInfoNotice();
  };

  // A barcode scanner types the number and then presses Enter: Enter in a text box must not submit the form.
  // Enter on a button, a select or the file picker keeps its normal meaning, so the form can be finished from the
  // keyboard alone.
  const handleFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Enter") return;
    const target = event.target;
    if (target instanceof HTMLInputElement && ["text", "url", "search", "email", "tel", "number", "password"].includes(target.type)) {
      event.preventDefault();
    }
  };

  const showSaveFailure = (failure: ApiFailure, supplier: SupplierPlan) => {
    let message = failure.message;
    if (failure.status === null) {
      message = failure.timedOut
        ? "The server took too long to answer. The item may or may not have been saved: check the list before saving again."
        : "Could not reach the server. Check the internet connection and try again.";
    }
    const named = failure.field !== null && isFormKey(failure.field) ? failure.field : null;
    const field: FormKey | null = named ?? (failure.status === 409 && /barcode/i.test(failure.message) ? "barcode" : null);
    const supplierColumnMissing = failure.status === 409 && failure.field === "supplier_order_number" && supplier.send;
    setNotice({
      tone: "error",
      scope: "form",
      title: failure.timedOut ? "Not confirmed" : "Not saved",
      message,
      detail: failure.detail,
      hint: supplierColumnMissing
        ? "Your other changes are still in the form. To save them now, clear the Supplier order number field."
        : "Your changes are still in the form.",
    });
    setFieldError(field);
    requestFocus("notice");
    if (failure.status === 404) reloadMedications(meds.status !== "ready"); // the item is gone: refresh the list behind the form
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || photoUploading) return;

    // A half-finished "new category" must not be silently dropped by saving the item.
    if (creatingNew && newCatName.trim() !== "") {
      setCatError({ message: "Save the new category first, or choose Cancel, then save the item.", detail: null });
      requestFocus("new-category-input");
      return;
    }

    // Text that is too long is never cut short and never saved. The message is already next to the field (it appears as soon
    // as the text is too long); pressing Save takes the keyboard there, to the first such field on the page.
    const wasEditing = editing;
    const problemField = firstProblemField(formProblems(form, wasEditing));
    if (problemField !== null) {
      requestFocus(PROBLEM_FOCUS[problemField]);
      return;
    }

    // Only what the person changed is sent, so a field someone else changed meanwhile (the stock, the category) is not put back.
    const supplier = planSupplier(form, wasEditing);
    const payload = buildPayload(form, supplier, wasEditing);
    setNotice(null);
    setFieldError(null);
    if (isEmptyPayload(payload)) {
      // The server refuses an empty save, and a request that repeats what is stored would only bump "updated" and say "Saved".
      setNotice({
        tone: "info",
        scope: "form",
        message: "No changes to save.",
        hint: "Change a field first, or choose Cancel to close the form.",
      });
      requestFocus("notice");
      return;
    }

    setSaving(true);
    const result = await callApi(wasEditing ? `/api/medications/${wasEditing.id}` : "/api/medications", {
      method: wasEditing ? "PUT" : "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });
    setSaving(false);

    if (result.kind === "failed") {
      showSaveFailure(result, supplier);
      return;
    }

    const saved = toMedication(result.body);
    if (saved === null) {
      setNotice({
        tone: "error",
        scope: "form",
        title: "Not confirmed",
        message: "The server’s answer could not be read, so it is not certain that the item was saved.",
        hint: "Reload the list to check before saving again. Your changes are still in the form.",
      });
      requestFocus("notice");
      reloadMedications(meds.status !== "ready");
      return;
    }

    upsertMedication(saved);
    reloadMedications(meds.status !== "ready");

    const notStored = findNotStored(saved, payload);
    if (notStored.length > 0) {
      setEditing(saved); // the item exists now, so the next save updates it instead of adding a second one
      // The row the server sent is the baseline of the next save, so the fields the person did not touch follow it too: their
      // values from when the form was opened may be stale, and the next save must not read that as the person's change.
      setForm((current) => rebaseForm(current, wasEditing, saved));
      setNotice({
        tone: "error",
        scope: "form",
        title: "Saved, but a value was not stored",
        message: `The item was saved, but the ${notStored.join(" and ")} ${notStored.length === 1 ? "was" : "were"} not stored. Nothing else changed.`,
        hint: "Your changes are still in the form. Try saving again.",
      });
      requestFocus("notice");
      return;
    }

    const label = displayName(saved) ?? saved.barcode;
    setShowForm(false);
    setEditing(null);
    resetTransient();
    setNotice({
      tone: "success",
      scope: "page",
      // The item's name or barcode is free text: it goes in `subject`, which wraps, never in the fixed `title`.
      subject: label,
      message: `Saved. Category: ${categoryLabel(saved.category_id, categories).title} · Supplier order no.: ${supplierOf(saved) ?? "Not set"}`,
      savedId: saved.id,
    });
    // Back to the row that was edited (it says "Saved"), or to the message when that row is no longer in the list.
    requestFocus("saved-row");
  };

  const handleDelete = async (med: Medication) => {
    // A second click before the first answer arrives (the row's button is already marked busy): ignore it, and do not
    // ask the confirmation again.
    if (deletingRef.current.has(med.id)) return;
    const label = displayName(med) ?? med.barcode;
    if (!window.confirm(`Delete "${label}"? This also deletes all its transaction history.`)) return;

    deletingRef.current.add(med.id);
    setDeleting(new Set(deletingRef.current));
    setAnnouncement(`Deleting “${label}”…`);
    const result = await callApi(`/api/medications/${med.id}`, { method: "DELETE" });
    deletingRef.current.delete(med.id);
    setDeleting(new Set(deletingRef.current));
    setAnnouncement(""); // the notice below announces the result itself

    // The item is not in the database any more, however that came about: stop showing it.
    const itemIsGone = (message: string) => {
      if (editing?.id === med.id) {
        setShowForm(false);
        setEditing(null);
        resetTransient();
      }
      removeMedication(med.id);
      reloadMedications(meds.status !== "ready");
      setNotice({ tone: "success", scope: "page", message });
      requestFocus("list-heading");
    };

    if (result.kind === "failed") {
      // The app's own "item not found" answer: someone else (another tab, another person) deleted it first. What the
      // person asked for has happened, so "Not deleted" would be wrong. A bare 404 from something that is not the app's
      // API says nothing about the item and stays an error.
      if (result.status === 404 && result.fromApi) {
        itemIsGone(`“${label}” was already deleted. The list was refreshed.`);
        return;
      }
      setNotice({
        tone: "error",
        scope: "page",
        title: "Not deleted",
        message:
          result.status === null
            ? result.timedOut
              ? "The server took too long to answer."
              : "Could not reach the server. Check the internet connection."
            : result.message,
        detail: result.detail,
        hint:
          result.status === null
            ? `Reload the list to check whether “${label}” was deleted.`
            : result.status === 404
              ? "The list was refreshed."
              : `“${label}” was not deleted.`,
      });
      requestFocus("notice");
      if (result.status === 404) reloadMedications(meds.status !== "ready"); // not the API's answer: look again
      return;
    }
    itemIsGone(`Deleted “${label}”.`);
  };

  // ── Row handlers ──
  // The list rows are memoized, so the handlers they receive must keep one identity or every row would still re-render with
  // the page. The latest versions are read through refs, the way app/components/inventory/InventoryTab.tsx does it.
  const openEditRef = useRef(openEdit);
  const deleteRef = useRef(handleDelete);
  useEffect(() => {
    openEditRef.current = openEdit;
    deleteRef.current = handleDelete;
  });
  const editRow = useCallback((med: Medication, trigger: HTMLElement) => openEditRef.current(med, trigger), []);
  const deleteRow = useCallback((med: Medication) => void deleteRef.current(med), []);

  // ── Inline category creation ──
  // What picking a choice in the Category field does, for the native select and the searchable picker alike. "+ Create new
  // category…" opens the inline box and keeps the item's current category: it comes back if the new one is cancelled.
  const handleCategoryChange = (value: string) => {
    setCatNote(null);
    if (value === NEW_CATEGORY_VALUE) {
      setCreatingNew(true);
      setCatError(null);
      requestFocus("new-category-input");
      return;
    }
    setCreatingNew(false);
    setNewCatName("");
    setCatError(null);
    setFormValue("category_id", value === "" ? null : value);
  };

  const cancelNewCategory = () => {
    setCreatingNew(false);
    setNewCatName("");
    setCatError(null);
    requestFocus("category-select");
  };

  const handleCreateCategory = async () => {
    const name = newCatName.trim();
    if (name === "" || creatingCat) return;
    // A name that is too long is never cut short and never created. The message is already under the box; the keyboard goes back to it.
    if (categoryNameProblem(name) !== null) {
      requestFocus("new-category-input");
      return;
    }
    const session = formSession.current;
    setCreatingCat(true);
    setCatError(null);
    setCatNote(null);
    const result = await callApi("/api/categories", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name }),
    });
    // The form this name was typed into may be gone by now (Cancel, then another item). Then nothing below may touch the
    // form that is open: its category, notes and messages are not this request's. A category that was created still
    // exists on the server, so it is added to the page's lists either way.
    const sameForm = session === formSession.current;
    if (sameForm) setCreatingCat(false);
    // What this answer says about the database holds whichever form it was asked from.
    setCategoryCreateDenied(result.kind === "failed" && result.status === 403);

    if (result.kind === "failed") {
      if (!sameForm) return;
      setCatError({
        message:
          result.status === null
            ? result.timedOut
              ? "The server took too long to answer. The category may or may not have been created."
              : "Could not reach the server. Check the internet connection and try again."
            : result.message,
        detail: result.detail,
      });
      return;
    }
    const created = toCategory(result.body);
    if (created === null) {
      if (!sameForm) return;
      setCatError({ message: "The server’s answer could not be read. Reload the page to check whether the category was created.", detail: null });
      return;
    }
    setCreatedCategories((prev) => [...prev.filter((c) => !sameId(c.id, created.id)), created]);
    if (!sameForm) return;
    setForm((f) => ({ ...f, category_id: created.id }));
    dismissInfoNotice();
    setCreatingNew(false);
    setNewCatName("");
    setCatNote(
      result.status === 201
        ? `Category “${created.name}” was created and selected.`
        : `Category “${created.name}” already exists. It is selected.`
    );
    requestFocus("category-select");
  };

  // ── Photo ──
  const handlePhotoUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const session = formSession.current;
    const request = ++photoRequest.current;
    setPhotoUploading(true);
    setPhotoError(null);
    const data = new FormData();
    data.append("file", file);
    const result = await callApi("/api/upload", { method: "POST", body: data });
    // The photo belongs to the form it was chosen in. If that form is gone (Cancel, then another item) or a newer photo
    // was chosen since, the answer is dropped: it must not be attached to a different item.
    if (session !== formSession.current || request !== photoRequest.current) return;
    setPhotoUploading(false);
    input.value = ""; // choosing the same file again (after an error) must still count as a change
    if (result.kind === "failed") {
      setPhotoError(`Photo upload failed: ${result.message}`);
      return;
    }
    const url = isRecord(result.body) && typeof result.body.url === "string" && result.body.url !== "" ? result.body.url : null;
    if (url === null) {
      setPhotoError("Photo upload failed: the server did not send back the photo’s address.");
      return;
    }
    setFormValue("photo_url", url);
  };

  // ── List actions ──
  const clearFilters = () => {
    setSearch("");
    setCategoryFilter({ kind: "all" });
    searchRef.current?.focus();
  };

  // The chips under the filter row: one for each filter that is on. Taking one off resets only that filter.
  const filterSpecs = describeActiveFilters(viewState, categoryTitleByKey(categories));

  const removeFilter = (key: ActiveFilterKey, isLast: boolean) => {
    // This list has no stock filter, so there is never a "stock" chip to remove here.
    if (key === "category") setCategoryFilter({ kind: "all" });
    else if (key === "search") setSearch("");
    // While another chip is left, ActiveFilterChips hands the keyboard focus to its neighbour. The last chip takes the
    // whole row with it, so then the focus goes to the search box (always there), never to <body>.
    if (isLast) searchRef.current?.focus();
  };

  const activeFilters: ActiveFilter[] = filterSpecs.map((spec) => ({
    key: spec.key,
    label: spec.label,
    value: spec.value,
    onRemove: () => removeFilter(spec.key, filterSpecs.length === 1),
  }));

  // "Add medication" in the empty list opens the same form as "+ Add Medication" at the top of the page. The card's own
  // button is the control the focus returns to when the form is cancelled (it is found again by its test id, see openerRef).
  const addFromEmptyState = () => {
    const trigger =
      document.querySelector<HTMLElement>('[data-testid="admin-empty-add"]') ?? document.getElementById("admin-add-button");
    if (trigger) openNew(trigger);
  };

  // ── Render ──
  const formTitle = editing
    ? editing.is_unnamed
      ? `Complete unnamed item: ${editing.barcode}`
      : `Edit: ${editing.name || editing.barcode}`
    : "New Medication";

  // Everything that can carry text from the data (an item name, a barcode) wraps: the shared Notice does not wrap its
  // `title`, so such text is never passed as one.
  const renderNotice = (n: NoticeState) => (
    <Notice ref={noticeRef} tone={n.tone} title={n.title} data-testid={NOTICE_TEST_ID[n.tone]}>
      {n.subject && <p className="font-semibold [overflow-wrap:anywhere]">{n.subject}</p>}
      <p className={`[overflow-wrap:anywhere] ${n.subject ? "mt-0.5" : ""}`}>{n.message}</p>
      {n.hint && <p className="mt-1 [overflow-wrap:anywhere]">{n.hint}</p>}
      {n.detail && <p className={`mt-1.5 ${MONO} text-xs break-words opacity-90`}>Details: {n.detail}</p>}
    </Notice>
  );

  // Why the list is empty, in this page's words: nothing has been added yet, a chosen category holds nothing, or the
  // filters match nothing. A list that could not be loaded never gets here: that is an error notice with Retry.
  const emptyState = (() => {
    if (!listReady || view.visible.length > 0) return null;
    const empty = describeEmpty(items.length, viewState, categories);
    if (empty.kind === "no-items") {
      return {
        kind: empty.kind,
        title: "No medications yet.",
        detail: "Add the first medication to start tracking its stock, category and supplier order number.",
      };
    }
    // A category that exists but holds nothing. The inventory view tells people to use the Admin page; this IS the Admin page.
    const chosenCategoryExists =
      categoryFilter.kind === "category" && !unknownSelected && categories.some((c) => sameId(c.id, categoryFilter.id));
    if (empty.kind === "category-empty" && chosenCategoryExists) {
      return { kind: empty.kind, title: empty.title, detail: "Use Edit on an item to put it in this category." };
    }
    return empty;
  })();

  // The card's button. "Add medication" is offered only while no form is open: next to an add form that is already on the
  // page it would be a second control with the form's own name, and pressing it would start the form over and wipe what
  // was typed. When the filters (not the inventory) are what is empty, the button clears them; that never touches the form.
  const emptyAction = ((): EmptyAction | undefined => {
    if (emptyState === null) return undefined;
    if (emptyState.kind === "no-items") {
      return showForm ? undefined : { label: "Add medication", onClick: addFromEmptyState, testId: "admin-empty-add" };
    }
    return view.summary.filtersActive ? { label: "Clear filters", onClick: clearFilters, testId: "admin-empty-clear-filters" } : undefined;
  })();

  return (
    <div>
      {/* Spoken, not shown: what a Retry or a Delete is doing, and how a Retry ended. Always in the page, so the text
          that appears in it is announced. */}
      <div role="status" aria-live="polite" aria-atomic="true" data-testid="admin-live" className="sr-only">
        {announcement}
      </div>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Admin</h1>
          <p className="mt-0.5 text-base text-gray-600">Add and edit medications, their categories and supplier order numbers.</p>
        </div>
        <button
          type="button"
          id="admin-add-button"
          data-testid="admin-add-button"
          onClick={(event) => openNew(event.currentTarget)}
          className={BTN_PRIMARY}
        >
          + Add Medication
        </button>
      </div>

      {/* The result of the last action (saved, deleted, delete failed) */}
      {notice?.scope === "page" && <div className="mb-5">{renderNotice(notice)}</div>}

      {cats.status === "error" && (
        <Notice tone="warning" title="Categories could not be loaded" data-testid="admin-categories-error" className="mb-5">
          <p>
            Category names and choices are missing, so categorized items show “Category unavailable”. You can still edit items:
            an item keeps its current category unless you change it.
          </p>
          <p className="mt-1 [overflow-wrap:anywhere]">{cats.message}</p>
          <RetryButton onClick={retryCategories} busy={retrying.categories} />
        </Notice>
      )}

      {/* Unnamed items review section */}
      {unnamed.length > 0 && (
        <section
          aria-labelledby="admin-unnamed-heading"
          data-testid="admin-unnamed-section"
          className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4"
        >
          <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
            <WarnIcon className="h-5 w-5 text-amber-700" />
            <h2 id="admin-unnamed-heading" className="text-base font-semibold text-amber-900">
              {unnamed.length} unnamed {unnamed.length === 1 ? "item needs" : "items need"} review
            </h2>
            <span className="text-sm text-amber-900">— scanned barcodes not yet in the system</span>
          </div>
          <ul className="space-y-2">
            {unnamed.map((med) => (
              <li
                key={med.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-amber-200 bg-white px-3 py-2"
              >
                <div className="min-w-0">
                  <p id={`admin-unnamed-barcode-${med.id}`} className={`${MONO} text-sm break-all text-gray-800`}>
                    <span className="sr-only">Barcode: </span>
                    {med.barcode}
                  </p>
                  <p className="text-sm text-gray-700 [overflow-wrap:anywhere]">
                    {displayName(med) ?? <span className="italic">no name</span>}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-700 [overflow-wrap:anywhere]">
                    {med.stock} {med.unit}
                  </span>
                  <button
                    type="button"
                    data-testid={`admin-complete-${med.id}`}
                    aria-describedby={`admin-unnamed-barcode-${med.id}`}
                    aria-disabled={deleting.has(med.id) || undefined}
                    onClick={(event) => {
                      if (!deleting.has(med.id)) openEdit(med, event.currentTarget);
                    }}
                    className={`${BTN} bg-amber-700 text-white hover:bg-amber-800 ${BUSY}`}
                  >
                    Complete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Form */}
      {showForm && (
        <section className="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
          <h2
            id="admin-form-heading"
            ref={formHeadingRef}
            tabIndex={-1}
            className={`text-xl font-semibold text-gray-900 [overflow-wrap:anywhere] ${FOCUS}`}
          >
            {formTitle}
          </h2>
          {editing?.is_unnamed && (
            <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              This barcode was auto-created from a scan. Fill in the details below to complete the record.
            </p>
          )}
          {notice?.scope === "form" && (
            <div id="admin-notice-anchor" className="mt-4">
              {renderNotice(notice)}
            </div>
          )}

          <form
            data-testid="admin-form"
            aria-labelledby="admin-form-heading"
            onSubmit={handleSave}
            onKeyDown={handleFormKeyDown}
            className="mt-5 grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-2"
          >
            <Field id="admin-name" label="Name" help="Shown in the inventory and on order sheets." className="sm:col-span-2">
              <input
                id="admin-name"
                data-testid="name-input"
                type="text"
                value={form.name}
                onChange={(e) => setFormValue("name", e.target.value)}
                aria-describedby={describedBy("admin-name-help", fieldError === "name" && "admin-notice-anchor")}
                aria-invalid={fieldError === "name" ? true : undefined}
                autoComplete="off"
                className={CONTROL}
                placeholder="e.g. Ibuprofen 200mg"
              />
            </Field>

            <Field
              id="admin-barcode"
              label={
                <>
                  <BarcodeGlyph />
                  Barcode
                </>
              }
              note="required"
              help="The number printed under the barcode (what the scanner reads)."
            >
              <input
                id="admin-barcode"
                data-testid="barcode-input"
                required
                aria-required="true"
                type="text"
                value={form.barcode}
                onChange={(e) => setFormValue("barcode", e.target.value)}
                aria-describedby={describedBy("admin-barcode-help", fieldError === "barcode" && "admin-notice-anchor")}
                aria-invalid={fieldError === "barcode" ? true : undefined}
                autoComplete="off"
                spellCheck={false}
                className={`${CONTROL} ${MONO}`}
                placeholder="e.g. 012345678901"
              />
            </Field>

            <Field
              id="supplier-order-number"
              label={
                <>
                  <TagIcon className="h-[15px] w-[15px]" />
                  Supplier order number
                </>
              }
              labelClassName="text-teal-800"
              note="optional"
              help="The number your supplier uses when ordering this item. This is not the barcode. Letters, dashes and leading zeros are kept exactly as typed."
            >
              <input
                id="supplier-order-number"
                data-testid="supplier-order-number-input"
                ref={supplierInputRef}
                type="text"
                value={form.supplier_order_number}
                onChange={(e) => setFormValue("supplier_order_number", e.target.value)}
                aria-describedby={describedBy(
                  problems.supplier_order_number && "supplier-order-number-problem",
                  supplierPasteHint && "supplier-order-number-hint",
                  "supplier-order-number-help",
                  fieldError === "supplier_order_number" && "admin-notice-anchor"
                )}
                aria-invalid={problems.supplier_order_number || fieldError === "supplier_order_number" ? true : undefined}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className={`${CONTROL} ${MONO}`}
                placeholder="e.g. 00417-B"
              />
              {problems.supplier_order_number && (
                <FieldProblemMessage
                  id="supplier-order-number-problem"
                  testId="problem-supplier-order-number"
                  problem={problems.supplier_order_number}
                />
              )}
              {/* Under the field, above its general help. The notice above the form carries the server's own text and
                  has the focus; this says what to do. An icon and words, not colour alone. */}
              {supplierPasteHint && (
                <p
                  id="supplier-order-number-hint"
                  data-testid="supplier-order-number-hint"
                  className="mt-1.5 flex items-start gap-1.5 text-sm font-semibold text-red-700"
                >
                  <WarnIcon className="mt-0.5 h-4 w-4" />
                  <span>If you pasted this code, delete it and type it by hand.</span>
                </p>
              )}
            </Field>

            {/* Category picker */}
            <div className="sm:col-span-2">
              <label htmlFor="admin-category" className={LABEL}>
                Category
              </label>
              {searchableCategories ? (
                // Many categories: a searchable list. Enter in it never submits the form; its popup is drawn above everything.
                <Combobox
                  id="admin-category"
                  testId="category-select"
                  ref={categoryComboRef}
                  value={categorySelectValue}
                  options={categoryOptions}
                  onChange={handleCategoryChange}
                  placeholder="Type to search categories"
                  emptyText="No categories match"
                  aria-describedby={describedBy("admin-category-help", fieldError === "category_id" && "admin-notice-anchor")}
                  aria-invalid={fieldError === "category_id"}
                  className="sm:max-w-md"
                />
              ) : (
                <div className="relative sm:max-w-md">
                  <select
                    id="admin-category"
                    data-testid="category-select"
                    ref={categorySelectRef}
                    value={categorySelectValue}
                    onChange={(e) => handleCategoryChange(e.target.value)}
                    aria-describedby={describedBy("admin-category-help", fieldError === "category_id" && "admin-notice-anchor")}
                    aria-invalid={fieldError === "category_id" ? true : undefined}
                    className={`${CONTROL} appearance-none pr-10`}
                  >
                    <NativeOptions options={categoryOptions} />
                  </select>
                  <ChevronIcon className="pointer-events-none absolute top-1/2 right-3 h-[18px] w-[18px] -translate-y-1/2 text-gray-600" />
                </div>
              )}

              {creatingNew && (
                <div className="mt-3 rounded-lg border border-gray-300 bg-gray-50 p-3 sm:max-w-md">
                  <label htmlFor="admin-new-category" className={LABEL}>
                    New category name
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <input
                      id="admin-new-category"
                      data-testid="new-category-input"
                      ref={newCatInputRef}
                      type="text"
                      value={newCatName}
                      onChange={(e) => {
                        setNewCatName(e.target.value);
                        if (catError) setCatError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleCreateCategory();
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          cancelNewCategory();
                        }
                      }}
                      aria-describedby={describedBy(newCategoryProblem && "admin-new-category-problem", catError && "admin-category-error-box")}
                      aria-invalid={newCategoryProblem || catError ? true : undefined}
                      autoComplete="off"
                      placeholder="e.g. Vaccines"
                      className={`${CONTROL} min-w-0 flex-1 basis-40`}
                    />
                    <button
                      type="button"
                      data-testid="new-category-save"
                      onClick={() => void handleCreateCategory()}
                      disabled={creatingCat || newCatName.trim() === ""}
                      className={BTN_PRIMARY}
                    >
                      {creatingCat ? "Saving…" : "Save category"}
                    </button>
                    <button
                      type="button"
                      data-testid="new-category-cancel"
                      aria-label="Cancel new category"
                      onClick={cancelNewCategory}
                      className={BTN_SECONDARY}
                    >
                      Cancel
                    </button>
                  </div>
                  {newCategoryProblem && (
                    <FieldProblemMessage id="admin-new-category-problem" testId="problem-new-category" problem={newCategoryProblem} />
                  )}
                  {catError && (
                    <div id="admin-category-error-box" className="mt-3">
                      <Notice tone="error" data-testid="category-error">
                        <p className="[overflow-wrap:anywhere]">{catError.message}</p>
                        {catError.detail && <p className={`mt-1.5 ${MONO} text-xs break-words opacity-90`}>Details: {catError.detail}</p>}
                      </Notice>
                    </div>
                  )}
                </div>
              )}

              {catNote && (
                <p role="status" data-testid="category-note" className="mt-2 text-sm font-semibold text-green-800">
                  {catNote}
                </p>
              )}
              <p id="admin-category-help" className={HELP}>
                {categoryHelp}
                {searchableCategories && " Type to search categories."}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-x-5 gap-y-5 sm:col-span-2 sm:grid-cols-3">
              <Field id="admin-unit" label="Unit" help="What you count this item in.">
                <input
                  id="admin-unit"
                  data-testid="unit-input"
                  ref={unitInputRef}
                  type="text"
                  value={form.unit}
                  onChange={(e) => setFormValue("unit", e.target.value)}
                  aria-describedby={describedBy(
                    problems.unit && "admin-unit-problem",
                    "admin-unit-help",
                    fieldError === "unit" && "admin-notice-anchor"
                  )}
                  aria-invalid={problems.unit || fieldError === "unit" ? true : undefined}
                  autoComplete="off"
                  className={CONTROL}
                  placeholder="e.g. tablets, mL, doses"
                />
                {problems.unit && <FieldProblemMessage id="admin-unit-problem" testId="problem-unit" problem={problems.unit} />}
              </Field>
              <Field id="admin-stock" label="Current Stock" help="How many are on hand now.">
                <input
                  id="admin-stock"
                  data-testid="stock-input"
                  type="text"
                  inputMode="numeric"
                  value={form.stock}
                  placeholder="0"
                  maxLength={10}
                  autoComplete="off"
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setFormValue("stock", e.target.value.replace(/[^0-9]/g, ""))}
                  aria-describedby={describedBy("admin-stock-help", fieldError === "stock" && "admin-notice-anchor")}
                  aria-invalid={fieldError === "stock" ? true : undefined}
                  className={CONTROL}
                />
              </Field>
              <Field id="admin-threshold" label="Low-Stock Threshold" help="Shown as Low at or below this number.">
                <input
                  id="admin-threshold"
                  data-testid="threshold-input"
                  type="text"
                  inputMode="numeric"
                  value={form.threshold}
                  placeholder="0"
                  maxLength={10}
                  autoComplete="off"
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setFormValue("threshold", e.target.value.replace(/[^0-9]/g, ""))}
                  aria-describedby={describedBy("admin-threshold-help", fieldError === "threshold" && "admin-notice-anchor")}
                  aria-invalid={fieldError === "threshold" ? true : undefined}
                  className={CONTROL}
                />
              </Field>
            </div>

            <Field
              id="admin-vendor-url"
              label="Vendor URL"
              note="optional"
              help="A web page where this item can be reordered."
              className="sm:col-span-2"
            >
              <input
                id="admin-vendor-url"
                data-testid="vendor-url-input"
                type="url"
                inputMode="url"
                value={form.vendor_url}
                onChange={(e) => setFormValue("vendor_url", e.target.value)}
                aria-describedby={describedBy("admin-vendor-url-help", fieldError === "vendor_url" && "admin-notice-anchor")}
                aria-invalid={fieldError === "vendor_url" ? true : undefined}
                autoComplete="off"
                className={CONTROL}
                placeholder="https://vendor.com/product/..."
              />
            </Field>

            <Field id="admin-notes" label="Notes" note="optional" className="sm:col-span-2">
              <textarea
                id="admin-notes"
                data-testid="notes-input"
                value={form.notes}
                onChange={(e) => setFormValue("notes", e.target.value)}
                aria-describedby={describedBy(fieldError === "notes" && "admin-notice-anchor")}
                aria-invalid={fieldError === "notes" ? true : undefined}
                className={CONTROL}
                rows={3}
                placeholder="Storage instructions, warnings, etc."
              />
            </Field>

            <Field
              id="admin-photo"
              label="Photo"
              note="optional"
              help="An item can always be saved without a photo."
              className="sm:col-span-2"
            >
              <div className="flex items-start gap-3">
                {form.photo_url && <ItemThumb name={form.name} photoUrl={form.photo_url} size={56} />}
                <div className="min-w-0 flex-1">
                  <input
                    key={formKey}
                    id="admin-photo"
                    data-testid="photo-input"
                    type="file"
                    accept="image/*"
                    onChange={handlePhotoUpload}
                    aria-describedby={describedBy("admin-photo-help", photoError && "admin-photo-error")}
                    className={`block w-full text-base text-gray-700 file:mr-3 file:min-h-10 file:cursor-pointer file:rounded-lg file:border-0 file:bg-blue-50 file:px-4 file:text-base file:font-semibold file:text-blue-800 hover:file:bg-blue-100 ${FOCUS}`}
                  />
                  {photoUploading && (
                    <p role="status" className="mt-1.5 text-sm text-gray-700">
                      Uploading…
                    </p>
                  )}
                  {form.photo_url && !photoUploading && !photoError && (
                    <p className="mt-1.5 text-sm text-gray-700">Photo attached. It is kept with the item when you save.</p>
                  )}
                  {photoError && (
                    <p id="admin-photo-error" role="alert" data-testid="admin-photo-error" className="mt-1.5 flex items-start gap-1.5 text-sm font-semibold text-red-700">
                      <WarnIcon className="mt-0.5 h-4 w-4" />
                      <span>{photoError}</span>
                    </p>
                  )}
                </div>
              </div>
            </Field>

            <div className="flex flex-col gap-3 sm:col-span-2 sm:flex-row sm:justify-end">
              <button type="button" data-testid="cancel-button" onClick={closeForm} disabled={saving} className={`${BTN_SECONDARY} disabled:opacity-60`}>
                Cancel
              </button>
              <button type="submit" data-testid="save-button" disabled={saving || photoUploading} className={`${BTN_PRIMARY} sm:min-w-44`}>
                {saving ? "Saving…" : editing ? "Save Changes" : "Add Medication"}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Medication list */}
      <section aria-labelledby="admin-list-heading" className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-200 p-4 sm:p-5">
          <h2
            id="admin-list-heading"
            ref={listHeadingRef}
            tabIndex={-1}
            className={`text-lg font-semibold text-gray-900 ${FOCUS}`}
          >
            All Medications
            {meds.status === "ready" && <span className="font-normal text-gray-600"> ({meds.items.length})</span>}
          </h2>

          {listReady && (
            <>
              <div className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-4">
                <div className="min-w-[220px] flex-1 basis-64">
                  <label htmlFor="admin-search" className={LABEL}>
                    Search
                  </label>
                  <div className="relative">
                    <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-[18px] w-[18px] -translate-y-1/2 text-gray-500" />
                    <input
                      id="admin-search"
                      data-testid="admin-search"
                      ref={searchRef}
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Name, barcode or supplier order no."
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={200}
                      className={`${CONTROL} pr-3 pl-10`}
                    />
                  </div>
                </div>
                <div className="min-w-[220px] flex-1 basis-56 sm:max-w-xs">
                  <label htmlFor="admin-category-filter" className={LABEL}>
                    Filter by category
                  </label>
                  {searchableCategories ? (
                    <Combobox
                      id="admin-category-filter"
                      testId="admin-category-filter"
                      value={filterToValue(categoryFilter)}
                      options={filterChoices}
                      onChange={(value) => setCategoryFilter(valueToFilter(value))}
                      placeholder="Type to search categories"
                      emptyText="No categories match"
                    />
                  ) : (
                    <div className="relative">
                      <select
                        id="admin-category-filter"
                        data-testid="admin-category-filter"
                        value={filterToValue(categoryFilter)}
                        onChange={(e) => setCategoryFilter(valueToFilter(e.target.value))}
                        className={`${CONTROL} appearance-none pr-10`}
                      >
                        <NativeOptions options={filterChoices} />
                      </select>
                      <ChevronIcon className="pointer-events-none absolute top-1/2 right-3 h-[18px] w-[18px] -translate-y-1/2 text-gray-600" />
                    </div>
                  )}
                </div>
              </div>

              {/* The filters that are on, each with an x that takes off only that one. Not a live region: the "Showing X of Y"
                  line below is what screen readers hear. */}
              <ActiveFilterChips filters={activeFilters} className="mt-3" />

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <p data-testid="admin-summary" aria-live="polite" className="text-[15px] font-medium text-gray-800 [overflow-wrap:anywhere]">
                  {view.summary.text}
                </p>
                {view.summary.filtersActive && (
                  <button
                    type="button"
                    data-testid="admin-clear-filters"
                    onClick={clearFilters}
                    className={`inline-flex min-h-10 items-center rounded-lg px-2 text-[15px] font-semibold text-blue-700 underline underline-offset-2 hover:text-blue-900 ${FOCUS}`}
                  >
                    Clear filters
                  </button>
                )}
              </div>

              {meds.status === "ready" && meds.refreshError && (
                <Notice tone="warning" title="The list could not be refreshed" data-testid="admin-refresh-warning" className="mt-3">
                  <p className="[overflow-wrap:anywhere]">{meds.refreshError}</p>
                  <p className="mt-1">The list below may be out of date.</p>
                  <RetryButton onClick={retryMedications} busy={retrying.medications} />
                </Notice>
              )}
            </>
          )}
        </div>

        {meds.status === "error" ? (
          <div className="p-4 sm:p-5">
            <Notice tone="error" title={LOAD_ERROR_TITLE} data-testid="admin-load-error">
              <p>{LOAD_ERROR_REASSURANCE}</p>
              <p className="mt-1 [overflow-wrap:anywhere]">{meds.message}</p>
              <RetryButton onClick={retryMedications} busy={retrying.medications} />
            </Notice>
          </div>
        ) : !listReady ? (
          <ListSkeleton />
        ) : emptyState ? (
          // The card is static (not a live region): the "Showing X of Y" line above announces that the results ran out.
          <div data-testid="admin-empty" data-empty-kind={emptyState.kind} className="p-4 sm:p-5">
            <EmptyStateCard
              icon={EMPTY_ICON[emptyState.kind]}
              title={emptyState.title}
              description={emptyState.detail}
              primaryAction={emptyAction}
            />
          </div>
        ) : (
          <ul className="divide-y divide-gray-200">
            {view.visible.map((med) => (
              <MedicationRow
                key={med.id}
                med={med}
                categories={categories}
                saved={notice?.savedId === med.id}
                deleting={deleting.has(med.id)}
                onEdit={editRow}
                onDelete={deleteRow}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

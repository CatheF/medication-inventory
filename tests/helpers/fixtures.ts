// Synthetic fixtures shared by unit, API-route and E2E tests. No production data.
//
// Shapes mirror what was observed (read-only) on the live database:
//   * "uuid"   — categories.id / medications.category_id are UUID strings (the live Health Center schema)
//   * "bigint" — categories.id / medications.category_id are integers (supabase/schema.sql); PostgREST returns numbers,
//                the API normalizes them to strings, so fixtures use digit strings for the already-normalized form.
import type { Category, Medication } from "@/lib/db";

export type IdShape = "uuid" | "bigint";

export const CATEGORY_NAMES = [
  "Pain & Fever",
  "Allergy & Cold",
  "Antibiotics",
  "First Aid",
  "PPE & Gloves",
  "IV & Fluids",
] as const;

/** Deterministic, valid-looking v4 UUID for index n (1-based). */
export function fakeUuid(n: number): string {
  const h = ((n * 2654435761) >>> 0).toString(16).padStart(8, "0");
  return `${h}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Id of the category at zero-based `index` for the given shape. */
export function categoryId(index: number, shape: IdShape = "uuid"): string {
  return shape === "uuid" ? fakeUuid(index + 1) : String(index + 1);
}

export function buildCategories(shape: IdShape = "uuid"): Category[] {
  return CATEGORY_NAMES.map((name, i) => ({
    id: categoryId(i, shape),
    name,
    created_at: "2026-11-01T12:00:00+00:00",
  }));
}

export type SeedItem = {
  name: string | null;
  /** index into CATEGORY_NAMES, or null for uncategorized */
  category: number | null;
  stock: number;
  threshold: number;
  supplier: string | null;
};

// Names intentionally mirror live-data traits: many commas/quotes, one very long name, one non-ASCII name,
// one barcode-only (unnamed) item, zero-stock and low-stock items.
export const SEED_ITEMS: readonly SeedItem[] = [
  { name: "Acetaminophen 500 mg, tablets", category: 0, stock: 120, threshold: 40, supplier: "00417-B" },
  { name: "Ibuprofen 200 mg, tablets", category: 0, stock: 18, threshold: 40, supplier: "0092" },
  { name: "Aspirin 81 mg, chewable", category: 0, stock: 60, threshold: 20, supplier: null },
  { name: "Naproxen 220 mg, tablets", category: 0, stock: 9, threshold: 20, supplier: "NX-220/100" },
  { name: 'Acetaminophen 160 mg/5 mL, "children\'s" suspension', category: 0, stock: 4, threshold: 10, supplier: "0007" },
  { name: "Cetirizine 10 mg, tablets", category: 1, stock: 75, threshold: 30, supplier: "CT-10" },
  { name: "Loratadine 10 mg, tablets", category: 1, stock: 12, threshold: 30, supplier: null },
  { name: "Diphenhydramine 25 mg, capsules", category: 1, stock: 44, threshold: 25, supplier: null },
  { name: "Guaifenesin 400 mg, tablets", category: 1, stock: 8, threshold: 15, supplier: "GF400" },
  { name: "Cough drops, honey-lemon", category: 1, stock: 3, threshold: 10, supplier: null },
  { name: "Amoxicillin 500 mg, capsules", category: 2, stock: 90, threshold: 30, supplier: "AMX-500" },
  { name: "Azithromycin 250 mg, tablets", category: 2, stock: 6, threshold: 12, supplier: "000250" },
  { name: "Nitrofurantoin 100 mg, capsules", category: 2, stock: 0, threshold: 10, supplier: null },
  { name: "Adhesive bandages, assorted", category: 3, stock: 300, threshold: 100, supplier: "BND-ASST" },
  { name: 'Gauze pads 4"x4", sterile', category: 3, stock: 14, threshold: 50, supplier: "GZ-44/200" },
  { name: "Alcohol prep pads", category: 3, stock: 520, threshold: 200, supplier: null },
  { name: "Instant cold pack", category: 3, stock: 0, threshold: 12, supplier: null },
  { name: "Crème antiseptique 1 %, 30 g", category: 3, stock: 15, threshold: 6, supplier: "00-1.50" },
  { name: "Nitrile gloves, M (box of 100)", category: 4, stock: 24, threshold: 10, supplier: "GLV-M" },
  { name: "Nitrile gloves, L (box of 100)", category: 4, stock: 6, threshold: 10, supplier: "GLV-L" },
  { name: "Surgical masks, ear-loop", category: 4, stock: 80, threshold: 25, supplier: null },
  { name: "Normal saline 0.9%, 500 mL bag", category: 5, stock: 40, threshold: 10, supplier: "NS500" },
  { name: "IV start kit", category: 5, stock: 9, threshold: 12, supplier: null },
  { name: "Syringe 3 mL, luer-lock", category: 5, stock: 150, threshold: 60, supplier: "SYR-3" },
  // Legacy / uncategorized rows
  {
    name: "Multi-vitamin with minerals and iron, adult daily formula, chewable tablets, assorted fruit flavor, 120 count bottle",
    category: null,
    stock: 12,
    threshold: 6,
    supplier: "MVI-120-FRUIT-ASSORTED-LONG-CODE-0001",
  },
  { name: "Thermometer probe covers", category: null, stock: 200, threshold: 50, supplier: null },
  { name: null, category: null, stock: 0, threshold: 10, supplier: null }, // barcode-only item that needs review
] as const;

export function barcodeFor(i: number): string {
  // mix of numeric UPC-like codes with leading zeros and alphanumeric codes
  return i % 3 === 0 ? `MED-${1000 + i}` : `0${String(12345600000 + i * 7).slice(0, 11)}`;
}

export type BuildMedicationsOptions = {
  shape?: IdShape;
  /** assign the seed categories (default true) */
  withCategories?: boolean;
  /** include seed supplier order numbers (default true) */
  withSupplierNumbers?: boolean;
};

export function buildMedications(opts: BuildMedicationsOptions = {}): Medication[] {
  const { shape = "uuid", withCategories = true, withSupplierNumbers = true } = opts;
  return SEED_ITEMS.map((s, i): Medication => ({
    id: 100 + i,
    name: s.name,
    barcode: s.name === null ? "0049000028911" : barcodeFor(i + 1),
    photo_url: null,
    stock: s.stock,
    threshold: s.threshold,
    vendor_url: null,
    unit: "units",
    notes: null,
    category_id: withCategories && s.category !== null ? categoryId(s.category, shape) : null,
    supplier_order_number: withSupplierNumbers ? s.supplier : null,
    is_unnamed: s.name === null,
    created_at: "2026-08-11T16:00:00+00:00",
    updated_at: "2026-10-28T16:02:00+00:00",
  }));
}

/** Bulk synthetic rows (ids start at 10_000) for paging / multi-page print tests. */
export function buildManyMedications(count: number, shape: IdShape = "uuid"): Medication[] {
  return Array.from({ length: count }, (_, i): Medication => {
    const n = i + 1;
    return {
      id: 10_000 + n,
      name: `Bulk item ${String(n).padStart(4, "0")}, ${n % 2 ? "tablets" : '"capsules"'} with a reasonably long descriptive name`,
      barcode: String(n).padStart(12, "0"),
      photo_url: null,
      stock: n % 17,
      threshold: 8,
      vendor_url: null,
      unit: "units",
      notes: null,
      category_id: n % 5 === 0 ? null : categoryId(n % CATEGORY_NAMES.length, shape),
      supplier_order_number: n % 4 === 0 ? null : String(n).padStart(5, "0"),
      is_unnamed: false,
      created_at: "2026-08-11T16:00:00+00:00",
      updated_at: "2026-10-28T16:02:00+00:00",
    };
  });
}

// ── Hostile / unusual text for export and rendering tests ────────────────────────────────────
export const FORMULA_NAMES = [
  '=HYPERLINK("http://example.invalid","click")',
  "+1+1",
  "-2+3",
  "@SUM(A1:A2)",
  "\t=1+1",
  "\r=1+1",
  '=cmd|" /C calc"!A0',
] as const;

export const UNUSUAL_NAMES = [
  'Comma, "quote" and \'apostrophe\'',
  "Line one\nLine two",
  "Tab\there",
  "Émulsion à l’huile — 5 % (naïve café)",
  "日本語の薬品名 500mg",
  "دواء تجريبي ٥٠٠ ملغ",
  "Emoji 💊 tablet",
  "  leading and trailing spaces  ",
  "Ünïcödé + combining é (é)",
  `<script>alert("x")</script> & <b>bold</b>`,
  "A".repeat(113),
] as const;

/** Supplier order numbers that spreadsheets love to mangle. */
export const TRICKY_SUPPLIER_NUMBERS = [
  "00417-B",
  "0092",
  "AX-1182/4",
  "000000",
  "1E5", // looks like scientific notation
  "12345678901234567890", // beyond Excel's 15-digit precision
  "00-1.50",
  "2026-11-05", // looks like a date
  "=1+1", // looks like a formula
  "NÅ-00ß",
] as const;

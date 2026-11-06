import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
// The Supabase dashboard / Vercel integration may expose the key under either name; accept both.
// (Both are referenced literally so Next.js can inline them at build time.)
const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or a Supabase key (NEXT_PUBLIC_SUPABASE_ANON_KEY or " +
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY). Set them in .env.local or in the hosting environment."
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Category ids are opaque strings everywhere in the app. The live database uses UUIDs while
 * supabase/schema.sql declares bigint; the API normalizes both to strings, and the code never
 * does arithmetic on them (no Number()).
 */
export type Category = {
  id: string;
  name: string;
  created_at: string | null;
};

export type Medication = {
  id: number;
  name: string | null;
  barcode: string;
  photo_url: string | null;
  stock: number;
  threshold: number;
  vendor_url: string | null;
  unit: string;
  notes: string | null;
  /** uuid or digit string; null = uncategorized */
  category_id: string | null;
  /** Supplier ordering number, entered manually (text). null when unset or the column is not migrated yet. */
  supplier_order_number: string | null;
  is_unnamed: boolean;
  created_at: string;
  updated_at: string;
};

export type Transaction = {
  id: number;
  medication_id: number;
  type: "receive" | "dispense";
  quantity: number;
  note: string | null;
  created_at: string;
};

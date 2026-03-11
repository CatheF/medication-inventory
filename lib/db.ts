import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local");
}

export const supabase = createClient(supabaseUrl, supabaseKey);

export type Medication = {
  id: number;
  name: string;
  barcode: string;
  photo_url: string | null;
  stock: number;
  threshold: number;
  vendor_url: string | null;
  unit: string;
  notes: string | null;
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

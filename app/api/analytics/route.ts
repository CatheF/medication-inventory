import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Math.min(180, Math.max(7, Number(searchParams.get("days") ?? 30)));

    const { data: meds, error: medsErr } = await supabase
      .from("medications")
      .select("id, name, barcode, unit, stock, threshold, category_id, is_unnamed")
      .order("name");
    if (medsErr) throw medsErr;

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data: txns, error: txnsErr } = await supabase
      .from("transactions")
      .select("medication_id, type, quantity, created_at")
      .gte("created_at", since)
      .order("created_at");
    if (txnsErr) throw txnsErr;

    type DayData = { dispensed: number; received: number };
    const dailyMap: Record<number, Record<string, DayData>> = {};

    for (const txn of txns ?? []) {
      const date = txn.created_at.slice(0, 10);
      if (!dailyMap[txn.medication_id]) dailyMap[txn.medication_id] = {};
      if (!dailyMap[txn.medication_id][date]) {
        dailyMap[txn.medication_id][date] = { dispensed: 0, received: 0 };
      }
      if (txn.type === "dispense") {
        dailyMap[txn.medication_id][date].dispensed += txn.quantity;
      } else {
        dailyMap[txn.medication_id][date].received += txn.quantity;
      }
    }

    // Build date range array (oldest → newest)
    const dateRange: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      dateRange.push(d.toISOString().slice(0, 10));
    }

    const medications = (meds ?? []).map((med) => {
      const medDaily = dailyMap[med.id] ?? {};
      const daily = dateRange.map((date) => ({
        date,
        dispensed: medDaily[date]?.dispensed ?? 0,
        received: medDaily[date]?.received ?? 0,
      }));

      const total_dispensed = daily.reduce((s, d) => s + d.dispensed, 0);
      const total_received = daily.reduce((s, d) => s + d.received, 0);
      const daily_rate = total_dispensed / days;

      let days_until_threshold: number | null = null;
      let days_until_empty: number | null = null;
      let reorder_date: string | null = null;

      if (daily_rate > 0) {
        days_until_threshold = Math.max(0, (med.stock - med.threshold) / daily_rate);
        days_until_empty = Math.max(0, med.stock / daily_rate);
        const ms = Date.now() + days_until_threshold * 24 * 60 * 60 * 1000;
        reorder_date = new Date(ms).toISOString().slice(0, 10);
      }

      return {
        id: med.id,
        name: med.name,
        barcode: med.barcode,
        unit: med.unit,
        current_stock: med.stock,
        threshold: med.threshold,
        category_id: med.category_id,
        is_unnamed: med.is_unnamed,
        total_dispensed,
        total_received,
        daily_rate: Math.round(daily_rate * 100) / 100,
        days_until_threshold: days_until_threshold !== null ? Math.round(days_until_threshold) : null,
        days_until_empty: days_until_empty !== null ? Math.round(days_until_empty) : null,
        reorder_date,
        daily,
      };
    });

    // Sort by urgency: items with a rate + lowest days-until-threshold first
    medications.sort((a, b) => {
      if (a.days_until_threshold !== null && b.days_until_threshold !== null) {
        return a.days_until_threshold - b.days_until_threshold;
      }
      if (a.days_until_threshold !== null) return -1;
      if (b.days_until_threshold !== null) return 1;
      return (a.name || a.barcode).localeCompare(b.name || b.barcode);
    });

    return NextResponse.json({ medications, days, date_range: dateRange });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to fetch analytics" }, { status: 500 });
  }
}

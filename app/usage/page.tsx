"use client";

import { useEffect, useState, useCallback } from "react";

type DayData = { date: string; dispensed: number; received: number };

type MedAnalytics = {
  id: number;
  name: string | null;
  barcode: string;
  unit: string;
  current_stock: number;
  threshold: number;
  is_unnamed: boolean;
  total_dispensed: number;
  total_received: number;
  daily_rate: number;
  days_until_threshold: number | null;
  days_until_empty: number | null;
  reorder_date: string | null;
  daily: DayData[];
};

type AnalyticsData = {
  medications: MedAnalytics[];
  days: number;
  date_range: string[];
};

const WINDOWS = [7, 14, 30, 90, 180] as const;
type Window = (typeof WINDOWS)[number];

export default function UsagePage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [window, setWindow] = useState<Window>(30);

  const load = useCallback(async (days: Window) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/analytics?days=${days}`);
      const json = await res.json();
      if (!res.ok) { setError(json.error || "Failed to load"); return; }
      setData(json);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(window); }, [load, window]);

  const urgencyBadge = (days: number | null) => {
    if (days === null) return null;
    if (days <= 7) return <span className="inline-block px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700 font-semibold ml-2">Urgent</span>;
    if (days <= 14) return <span className="inline-block px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-700 font-semibold ml-2">Soon</span>;
    return null;
  };

  const meds = data?.medications ?? [];
  const totalDispensed = meds.reduce((s, m) => s + m.total_dispensed, 0);
  const mostUrgent = meds.find((m) => m.days_until_threshold !== null);
  const active = meds.filter((m) => m.daily_rate > 0).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Usage & Projections</h1>
          <p className="text-sm text-gray-500">Usage rates, trends, and reorder estimates.</p>
        </div>
        <div className="flex rounded-lg border border-gray-300 overflow-hidden">
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`px-4 py-1.5 text-sm font-medium transition-colors ${
                window === w ? "bg-blue-700 text-white" : "bg-white text-gray-700 hover:bg-gray-50"
              }`}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="bg-white rounded-xl border border-gray-200 p-4 animate-pulse h-20" />
            ))}
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4 animate-pulse h-64" />
        </div>
      ) : data && (
        <div className="space-y-5">
          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
              <p className="text-2xl font-bold text-blue-800">{totalDispensed.toLocaleString()}</p>
              <p className="text-sm text-blue-700 mt-0.5">Units dispensed ({window}d)</p>
            </div>
            <div className="bg-purple-50 border border-purple-200 rounded-xl p-4">
              <p className="text-2xl font-bold text-purple-800">{active}</p>
              <p className="text-sm text-purple-700 mt-0.5">Active medications (have usage)</p>
            </div>
            <div className={mostUrgent ? "bg-red-50 border border-red-200 rounded-xl p-4" : "bg-green-50 border border-green-200 rounded-xl p-4"}>
              {mostUrgent ? (
                <>
                  <p className="text-2xl font-bold text-red-700">{mostUrgent.days_until_threshold}d</p>
                  <p className="text-sm text-red-600 mt-0.5 truncate">
                    Until reorder: {mostUrgent.name || mostUrgent.barcode}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-2xl font-bold text-green-700">—</p>
                  <p className="text-sm text-green-600 mt-0.5">No items with usage data yet</p>
                </>
              )}
            </div>
          </div>

          {/* Usage table */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">Medication Usage — Last {window} Days</h2>
              <p className="text-xs text-gray-400 mt-0.5">Sorted by reorder urgency. Sparkline shows daily dispensed units.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-4 py-2.5 text-xs text-gray-500 font-medium">Medication</th>
                    <th className="text-right px-3 py-2.5 text-xs text-gray-500 font-medium">Stock</th>
                    <th className="text-right px-3 py-2.5 text-xs text-gray-500 font-medium">Dispensed/Used</th>
                    <th className="text-right px-3 py-2.5 text-xs text-gray-500 font-medium">Received</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {meds.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-gray-400 text-sm">No medications in system yet.</td>
                    </tr>
                  ) : (
                    meds.map((med) => (
                      <tr key={med.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <span className={`font-medium ${med.name ? "text-gray-900" : "text-gray-400 font-mono"}`}>
                            {med.name || med.barcode}
                          </span>
                          {med.is_unnamed && (
                            <span className="ml-2 text-xs text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">unnamed</span>
                          )}
                          {urgencyBadge(med.days_until_threshold)}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <span className={med.current_stock <= med.threshold ? "text-amber-600 font-semibold" : "text-gray-700"}>
                            {med.current_stock}
                          </span>
                          <span className="text-gray-400 text-xs ml-1">{med.unit}</span>
                        </td>
                        <td className="px-3 py-3 text-right text-gray-700">
                          {med.total_dispensed > 0 ? med.total_dispensed : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-3 text-right text-gray-700">
                          {med.total_received > 0 ? med.total_received : <span className="text-gray-300">—</span>}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}



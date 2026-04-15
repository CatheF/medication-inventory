"use client";

import { useEffect, useState, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";

type Medication = {
  id: number;
  name: string;
  barcode: string;
  photo_url: string | null;
  stock: number;
  threshold: number;
  unit: string;
  vendor_url: string | null;
  notes: string | null;
};

export default function Dashboard() {
  const [medications, setMedications] = useState<Medication[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "low" | "ok">("all");
  const [loading, setLoading] = useState(true);

  const fetchMedications = useCallback(async () => {
    setLoading(true);
    try {
      const url =
        filter === "low"
          ? "/api/medications?lowStock=true"
          : "/api/medications";
      const res = await fetch(url);
      const data = await res.json();
      setMedications(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchMedications();
  }, [fetchMedications]);

  const displayed = medications.filter((m) =>
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.barcode.includes(search)
  );

  const lowCount = medications.filter((m) => m.stock <= m.threshold).length;

  const stockColor = (m: Medication) => {
    if (m.stock === 0) return "bg-red-100 text-red-800 border-red-200";
    if (m.stock <= m.threshold) return "bg-amber-100 text-amber-800 border-amber-200";
    return "bg-green-100 text-green-800 border-green-200";
  };

  const stockLabel = (m: Medication) => {
    if (m.stock === 0) return "Out of stock";
    if (m.stock <= m.threshold) return "Low stock";
    return "In stock";
  };

  return (
    <div>
      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard label="Total Medications" value={medications.length} color="blue" />
        <StatCard label="Low Stock Alerts" value={lowCount} color={lowCount > 0 ? "amber" : "green"} />
        <StatCard
          label="In Stock"
          value={medications.filter((m) => m.stock > m.threshold).length}
          color="green"
        />
      </div>

      {/* Alert banner */}
      {lowCount > 0 && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-300 rounded-lg flex items-center justify-between">
          <p className="text-amber-800 text-sm font-medium">
            {lowCount} medication{lowCount !== 1 ? "s are" : " is"} at or below threshold and may need reordering.
          </p>
          <button
            onClick={() => setFilter("low")}
            className="text-xs text-amber-700 underline"
          >
            Show only low stock
          </button>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <input
          type="text"
          placeholder="Search by name or barcode..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
        <div className="flex gap-2">
          {(["all", "low", "ok"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-2 rounded-lg text-sm font-medium capitalize transition-colors ${
                filter === f
                  ? "bg-blue-700 text-white"
                  : "bg-white border border-gray-300 text-gray-700 hover:bg-gray-50"
              }`}
            >
              {f === "ok" ? "Adequate" : f === "low" ? "Low Stock" : "All"}
            </button>
          ))}
        </div>
        <Link
          href="/admin"
          className="px-4 py-2 bg-blue-700 text-white rounded-lg text-sm font-medium hover:bg-blue-800 transition-colors"
        >
          + Add Medication
        </Link>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 p-4 animate-pulse">
              <div className="bg-gray-200 h-32 rounded-lg mb-3" />
              <div className="bg-gray-200 h-4 rounded w-3/4 mb-2" />
              <div className="bg-gray-200 h-3 rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : displayed.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          {medications.length === 0 ? (
            <>
              <p className="text-lg font-medium mb-2">No medications yet</p>
              <p className="text-sm mb-4">Add medications via Admin or import a CSV file.</p>
              <Link href="/admin" className="text-blue-600 underline text-sm">
                Go to Admin
              </Link>
            </>
          ) : (
            <p className="text-lg">No results for &quot;{search}&quot;</p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {displayed.map((med) => (
            <div
              key={med.id}
              className="bg-white rounded-xl border border-gray-200 overflow-hidden hover:shadow-md transition-shadow"
            >
              <div className="relative h-36 bg-gray-100">
                {med.photo_url ? (
                  <Image
                    src={med.photo_url}
                    alt={med.name}
                    fill
                    className="object-cover"
                    unoptimized
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-gray-400">
                    <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
                    </svg>
                  </div>
                )}
              </div>
              <div className="p-3">
                <p className="font-semibold text-sm text-gray-900 leading-tight mb-1 line-clamp-2">
                  {med.name}
                </p>
                <p className="text-xs text-gray-500 mb-2 font-mono">{med.barcode}</p>
                <div className="flex items-center justify-between">
                  <span className="text-lg font-bold text-gray-900">
                    {med.stock}
                    <span className="text-xs font-normal text-gray-500 ml-1">{med.unit}</span>
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${stockColor(med)}`}>
                    {stockLabel(med)}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-1">Threshold: {med.threshold} {med.unit}</p>
                {med.vendor_url && (
                  <a
                    href={med.vendor_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:underline mt-1 block truncate"
                  >
                    Order from vendor
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: "blue" | "amber" | "green";
}) {
  const colors = {
    blue: "bg-blue-50 border-blue-200 text-blue-800",
    amber: "bg-amber-50 border-amber-200 text-amber-800",
    green: "bg-green-50 border-green-200 text-green-800",
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color]}`}>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-sm mt-0.5 opacity-80">{label}</p>
    </div>
  );
}

"use client";

import { useState } from "react";

type ReportItem = {
  name: string;
  current_stock: number;
  threshold: number;
  unit: string;
  dispensed_last_30_days: number;
  days_of_supply: number | null;
  vendor_url: string | null;
};

type Report = {
  generated_at: string;
  ai_analysis: string | null;
  data: ReportItem[];
  error?: string;
};

export default function ReportPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateReport = async () => {
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const res = await fetch("/api/report");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to generate report");
        return;
      }
      setReport(data);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  const daysColor = (days: number | null) => {
    if (days === null) return "text-gray-400";
    if (days <= 3) return "text-red-600 font-semibold";
    if (days <= 7) return "text-amber-600 font-semibold";
    return "text-green-700";
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Daily Reorder Report</h1>
          <p className="text-sm text-gray-500">
            AI-powered analysis of current stock and 30-day usage trends.
          </p>
        </div>
        <button
          onClick={generateReport}
          disabled={loading}
          className="px-5 py-2 bg-blue-700 text-white rounded-lg text-sm font-semibold hover:bg-blue-800 disabled:opacity-60"
        >
          {loading ? "Generating..." : "Generate Report"}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {!report && !loading && (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <svg className="w-12 h-12 text-gray-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <p className="text-gray-500 text-sm">Click &quot;Generate Report&quot; to analyze inventory and get reorder suggestions.</p>
        </div>
      )}

      {loading && (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <div className="inline-block w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-gray-500 text-sm">Analyzing inventory data...</p>
        </div>
      )}

      {report && (
        <div className="space-y-5">
          <p className="text-xs text-gray-400">
            Generated: {new Date(report.generated_at).toLocaleString()}
          </p>

          {report.error && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
              {report.error}
            </div>
          )}

          {/* AI Analysis */}
          {report.ai_analysis && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-6 h-6 bg-blue-600 rounded flex items-center justify-center flex-shrink-0">
                  <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <h2 className="font-semibold text-blue-900 text-base">AI Analysis</h2>
              </div>
              <div className="prose prose-sm max-w-none text-blue-900">
                <FormattedMarkdown text={report.ai_analysis} />
              </div>
            </div>
          )}

          {/* Data table */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">Inventory Data (Last 30 Days)</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-4 py-2 text-xs text-gray-500 font-medium">Medication</th>
                    <th className="text-right px-4 py-2 text-xs text-gray-500 font-medium">Stock</th>
                    <th className="text-right px-4 py-2 text-xs text-gray-500 font-medium">Threshold</th>
                    <th className="text-right px-4 py-2 text-xs text-gray-500 font-medium">Dispensed (30d)</th>
                    <th className="text-right px-4 py-2 text-xs text-gray-500 font-medium">Days of Supply</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {report.data.map((item) => (
                    <tr key={item.name} className="hover:bg-gray-50">
                      <td className="px-4 py-2.5 font-medium text-gray-900">{item.name}</td>
                      <td className={`px-4 py-2.5 text-right ${item.current_stock <= item.threshold ? "text-amber-600 font-semibold" : "text-gray-700"}`}>
                        {item.current_stock} {item.unit}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-500">
                        {item.threshold}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-700">
                        {item.dispensed_last_30_days}
                      </td>
                      <td className={`px-4 py-2.5 text-right ${daysColor(item.days_of_supply)}`}>
                        {item.days_of_supply !== null ? `${item.days_of_supply}d` : "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        {item.vendor_url && (
                          <a
                            href={item.vendor_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-600 hover:underline whitespace-nowrap"
                          >
                            Order
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FormattedMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        if (line.startsWith("## ") || line.startsWith("**") && line.endsWith("**")) {
          const content = line.replace(/^#+\s*/, "").replace(/\*\*/g, "");
          return <h3 key={i} className="font-bold text-blue-900 mt-3 mb-1">{content}</h3>;
        }
        if (line.startsWith("- ") || line.startsWith("* ")) {
          return (
            <p key={i} className="pl-4 text-sm">
              &bull; {formatInline(line.slice(2))}
            </p>
          );
        }
        if (line.trim() === "") return <br key={i} />;
        return <p key={i} className="text-sm">{formatInline(line)}</p>;
      })}
    </div>
  );
}

function formatInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      part
    )
  );
}

"use client";

import { useEffect, useState, useCallback } from "react";
import Image from "next/image";

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

type FormData = Omit<Medication, "id">;

const EMPTY_FORM: FormData = {
  name: "",
  barcode: "",
  photo_url: null,
  stock: 0,
  threshold: 10,
  unit: "units",
  vendor_url: "",
  notes: "",
};

export default function AdminPage() {
  const [medications, setMedications] = useState<Medication[]>([]);
  const [editing, setEditing] = useState<Medication | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [csvStatus, setCsvStatus] = useState<string | null>(null);
  const [csvUploading, setCsvUploading] = useState(false);
  const [search, setSearch] = useState("");

  const loadMedications = useCallback(async () => {
    try {
      const res = await fetch("/api/medications");
      setMedications(await res.json());
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    loadMedications();
  }, [loadMedications]);

  const openNew = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
    setStatus(null);
  };

  const openEdit = (med: Medication) => {
    setEditing(med);
    setForm({
      name: med.name,
      barcode: med.barcode,
      photo_url: med.photo_url,
      stock: med.stock,
      threshold: med.threshold,
      unit: med.unit,
      vendor_url: med.vendor_url || "",
      notes: med.notes || "",
    });
    setShowForm(true);
    setStatus(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (!res.ok) throw new Error("Upload failed");
      const { url } = await res.json();
      setForm((f) => ({ ...f, photo_url: url }));
    } catch {
      setStatus({ type: "error", text: "Photo upload failed" });
    } finally {
      setPhotoUploading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatus(null);
    try {
      const url = editing ? `/api/medications/${editing.id}` : "/api/medications";
      const method = editing ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          vendor_url: form.vendor_url || null,
          notes: form.notes || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus({ type: "error", text: data.error || "Save failed" });
        return;
      }
      setStatus({ type: "success", text: editing ? "Medication updated." : "Medication added." });
      setShowForm(false);
      setEditing(null);
      loadMedications();
    } catch {
      setStatus({ type: "error", text: "Network error" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (med: Medication) => {
    if (!confirm(`Delete "${med.name}"? This also deletes all its transaction history.`)) return;
    try {
      await fetch(`/api/medications/${med.id}`, { method: "DELETE" });
      loadMedications();
      if (editing?.id === med.id) {
        setShowForm(false);
        setEditing(null);
      }
    } catch {
      setStatus({ type: "error", text: "Delete failed" });
    }
  };

  const handleCsvImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvUploading(true);
    setCsvStatus(null);
    try {
      const text = await file.text();
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: text,
      });
      const data = await res.json();
      if (!res.ok) {
        setCsvStatus(`Error: ${data.error}`);
        return;
      }
      setCsvStatus(
        `Import complete: ${data.inserted} added, ${data.updated} updated, ${data.skipped} skipped.`
      );
      loadMedications();
    } catch {
      setCsvStatus("Import failed");
    } finally {
      setCsvUploading(false);
      e.target.value = "";
    }
  };

  const displayed = medications.filter(
    (m) =>
      m.name.toLowerCase().includes(search.toLowerCase()) ||
      m.barcode.includes(search)
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Admin</h1>
          <p className="text-sm text-gray-500">Manage medications and bulk import data.</p>
        </div>
        <button
          onClick={openNew}
          className="px-4 py-2 bg-blue-700 text-white rounded-lg text-sm font-medium hover:bg-blue-800"
        >
          + Add Medication
        </button>
      </div>

      {/* Status */}
      {status && (
        <div
          className={`mb-4 p-3 rounded-lg text-sm border ${
            status.type === "success"
              ? "bg-green-50 text-green-800 border-green-200"
              : "bg-red-50 text-red-800 border-red-200"
          }`}
        >
          {status.text}
        </div>
      )}

      {/* Form */}
      {showForm && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6 shadow-sm">
          <h2 className="text-lg font-semibold mb-4">
            {editing ? `Edit: ${editing.name}` : "New Medication"}
          </h2>
          <form onSubmit={handleSave} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="label">Name *</label>
              <input
                required
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="input"
                placeholder="e.g. Ibuprofen 200mg"
              />
            </div>

            <div>
              <label className="label">Barcode *</label>
              <input
                required
                type="text"
                value={form.barcode}
                onChange={(e) => setForm((f) => ({ ...f, barcode: e.target.value }))}
                className="input font-mono"
                placeholder="e.g. 012345678901"
              />
            </div>

            <div>
              <label className="label">Unit</label>
              <input
                type="text"
                value={form.unit}
                onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
                className="input"
                placeholder="e.g. tablets, mL, doses"
              />
            </div>

            <div>
              <label className="label">Current Stock</label>
              <input
                type="number"
                min={0}
                value={form.stock}
                onChange={(e) => setForm((f) => ({ ...f, stock: Number(e.target.value) }))}
                className="input"
              />
            </div>

            <div>
              <label className="label">Low-Stock Threshold</label>
              <input
                type="number"
                min={0}
                value={form.threshold}
                onChange={(e) => setForm((f) => ({ ...f, threshold: Number(e.target.value) }))}
                className="input"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="label">Vendor URL</label>
              <input
                type="url"
                value={form.vendor_url || ""}
                onChange={(e) => setForm((f) => ({ ...f, vendor_url: e.target.value }))}
                className="input"
                placeholder="https://vendor.com/product/..."
              />
            </div>

            <div className="sm:col-span-2">
              <label className="label">Notes</label>
              <textarea
                value={form.notes || ""}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                className="input"
                rows={2}
                placeholder="Storage instructions, warnings, etc."
              />
            </div>

            <div className="sm:col-span-2">
              <label className="label">Photo</label>
              <div className="flex items-start gap-3">
                {form.photo_url && (
                  <div className="relative w-20 h-20 rounded-lg overflow-hidden border border-gray-200 flex-shrink-0">
                    <Image src={form.photo_url} alt="Medication" fill className="object-cover" unoptimized />
                  </div>
                )}
                <div className="flex-1">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handlePhotoUpload}
                    className="block w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                  />
                  {photoUploading && <p className="text-xs text-gray-500 mt-1">Uploading...</p>}
                </div>
              </div>
            </div>

            <div className="sm:col-span-2 flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => { setShowForm(false); setEditing(null); }}
                className="flex-1 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || photoUploading}
                className="flex-1 py-2 bg-blue-700 text-white rounded-lg text-sm font-semibold hover:bg-blue-800 disabled:opacity-60"
              >
                {saving ? "Saving..." : editing ? "Save Changes" : "Add Medication"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* CSV Import */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
        <h2 className="text-base font-semibold mb-1">Bulk CSV Import</h2>
        <p className="text-sm text-gray-500 mb-3">
          Upload a CSV with columns: <code className="bg-gray-100 px-1 rounded text-xs">name, barcode, stock, threshold, unit, vendor_url, notes</code>. Existing barcodes will be updated.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={handleCsvImport}
            disabled={csvUploading}
            className="block text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 disabled:opacity-50"
          />
          {csvUploading && <span className="text-sm text-gray-500">Importing...</span>}
        </div>
        {csvStatus && (
          <p className={`mt-2 text-sm ${csvStatus.startsWith("Error") ? "text-red-600" : "text-green-700"}`}>
            {csvStatus}
          </p>
        )}
        <a
          href="/sample.csv"
          download
          className="inline-block mt-2 text-xs text-blue-600 hover:underline"
        >
          Download sample CSV template
        </a>
      </div>

      {/* Medication list */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">
            All Medications ({medications.length})
          </h2>
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm w-48 focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>

        {displayed.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            {medications.length === 0 ? "No medications yet." : "No results."}
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {displayed.map((med) => (
              <div key={med.id} className="flex items-center gap-3 p-4 hover:bg-gray-50">
                <div className="relative w-10 h-10 rounded-lg overflow-hidden border border-gray-200 flex-shrink-0 bg-gray-50">
                  {med.photo_url ? (
                    <Image src={med.photo_url} alt={med.name} fill className="object-cover" unoptimized />
                  ) : (
                    <span className="flex items-center justify-center h-full text-xs text-gray-400">Rx</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm text-gray-900 truncate">{med.name}</p>
                  <p className="text-xs text-gray-400 font-mono">{med.barcode}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className={`text-sm font-semibold ${med.stock <= med.threshold ? "text-amber-600" : "text-gray-900"}`}>
                    {med.stock} {med.unit}
                  </p>
                  <p className="text-xs text-gray-400">threshold: {med.threshold}</p>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  <button
                    onClick={() => openEdit(med)}
                    className="px-2.5 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(med)}
                    className="px-2.5 py-1 text-xs bg-red-50 text-red-600 rounded hover:bg-red-100"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <style jsx>{`
        .label {
          display: block;
          font-size: 0.875rem;
          font-weight: 500;
          color: #374151;
          margin-bottom: 0.25rem;
        }
        .input {
          width: 100%;
          padding: 0.5rem 0.75rem;
          border: 1px solid #d1d5db;
          border-radius: 0.5rem;
          font-size: 0.875rem;
          outline: none;
        }
        .input:focus {
          ring: 2px solid #3b82f6;
          border-color: #3b82f6;
        }
      `}</style>
    </div>
  );
}

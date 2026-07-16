"use client";

import { useEffect, useState, useCallback } from "react";
import Image from "next/image";

type Category = { id: number; name: string };

type Medication = {
  id: number;
  name: string | null;
  barcode: string;
  photo_url: string | null;
  stock: number;
  threshold: number;
  unit: string;
  vendor_url: string | null;
  notes: string | null;
  category_id: number | null;
  is_unnamed: boolean;
};

type FormData = {
  name: string;
  barcode: string;
  photo_url: string | null;
  stock: string;
  threshold: string;
  unit: string;
  vendor_url: string;
  notes: string;
  category_id: number | null;
};

const EMPTY_FORM: FormData = {
  name: "",
  barcode: "",
  photo_url: null,
  stock: "",
  threshold: "",
  unit: "units",
  vendor_url: "",
  notes: "",
  category_id: null,
};

export default function AdminPage() {
  const [medications, setMedications] = useState<Medication[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editing, setEditing] = useState<Medication | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [search, setSearch] = useState("");
  // New category creation inline
  const [showNewCatInput, setShowNewCatInput] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [creatingCat, setCreatingCat] = useState(false);

  const loadMedications = useCallback(async () => {
    try {
      const res = await fetch("/api/medications");
      const data = await res.json();
      setMedications(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
    }
  }, []);

  const loadCategories = useCallback(async () => {
    try {
      const res = await fetch("/api/categories");
      const data = await res.json();
      setCategories(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    loadMedications();
    loadCategories();
  }, [loadMedications, loadCategories]);

  const unnamedMeds = medications.filter((m) => m.is_unnamed);

  const openNew = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
    setStatus(null);
    setShowNewCatInput(false);
    setNewCatName("");
  };

  const openEdit = (med: Medication) => {
    setEditing(med);
    setForm({
      name: med.name ?? "",
      barcode: med.barcode,
      photo_url: med.photo_url,
      stock: String(med.stock),
      threshold: String(med.threshold),
      unit: med.unit,
      vendor_url: med.vendor_url || "",
      notes: med.notes || "",
      category_id: med.category_id,
    });
    setShowForm(true);
    setStatus(null);
    setShowNewCatInput(false);
    setNewCatName("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleCreateCategory = async () => {
    if (!newCatName.trim()) return;
    setCreatingCat(true);
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCatName.trim() }),
      });
      const cat = await res.json();
      if (!res.ok && res.status !== 200) {
        setStatus({ type: "error", text: "Failed to create category" });
        return;
      }
      await loadCategories();
      setForm((f) => ({ ...f, category_id: cat.id }));
      setShowNewCatInput(false);
      setNewCatName("");
    } catch {
      setStatus({ type: "error", text: "Failed to create category" });
    } finally {
      setCreatingCat(false);
    }
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setForm((f) => ({ ...f, photo_url: data.url }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Photo upload failed";
      setStatus({ type: "error", text: `Photo upload failed: ${msg}` });
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
          stock: form.stock === "" ? 0 : Number(form.stock),
          threshold: form.threshold === "" ? 0 : Number(form.threshold),
          vendor_url: form.vendor_url || null,
          notes: form.notes || null,
          category_id: form.category_id,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const detail = data.detail ? ` — ${data.detail}` : data.code ? ` (${data.code})` : "";
        setStatus({ type: "error", text: (data.error || "Save failed") + detail });
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
    if (!confirm(`Delete "${med.name || med.barcode}"? This also deletes all its transaction history.`)) return;
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

  const displayed = medications.filter(
    (m) =>
      (m.name ?? "").toLowerCase().includes(search.toLowerCase()) ||
      m.barcode.includes(search)
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Admin</h1>
          <p className="text-sm text-gray-500">Manage medications.</p>
        </div>
        <button
          onClick={openNew}
          className="px-4 py-2 bg-blue-700 text-white rounded-lg text-sm font-medium hover:bg-blue-800"
        >
          + Add Medication
        </button>
      </div>

      {/* Unnamed items review section */}
      {unnamedMeds.length > 0 && (
        <div className="mb-5 bg-amber-50 border border-amber-300 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-amber-600 text-lg">⚠</span>
            <h2 className="font-semibold text-amber-800">
              {unnamedMeds.length} unnamed item{unnamedMeds.length !== 1 ? "s" : ""} need review
            </h2>
            <span className="text-xs text-amber-600">
              — scanned barcodes not yet in the system
            </span>
          </div>
          <div className="space-y-2">
            {unnamedMeds.map((med) => (
              <div
                key={med.id}
                className="flex items-center justify-between bg-white rounded-lg border border-amber-200 px-3 py-2"
              >
                <div>
                  <p className="text-xs text-gray-500 font-mono">{med.barcode}</p>
                  <p className="text-sm text-gray-700">{med.name || <span className="text-gray-400 italic">no name</span>}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400">{med.stock} {med.unit}</span>
                  <button
                    onClick={() => openEdit(med)}
                    className="px-3 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700"
                  >
                    Complete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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
            {editing
              ? editing.is_unnamed
                ? `Complete unnamed item: ${editing.barcode}`
                : `Edit: ${editing.name || editing.barcode}`
              : "New Medication"}
          </h2>
          {editing?.is_unnamed && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
              This barcode was auto-created from a scan. Fill in the details below to complete the record.
            </div>
          )}
          <form
            onSubmit={handleSave}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA") {
                e.preventDefault();
              }
            }}
            className="grid grid-cols-1 sm:grid-cols-2 gap-4"
          >
            <div className="sm:col-span-2">
              <label className="label">Name</label>
              <input
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
                type="text"
                inputMode="numeric"
                value={form.stock}
                placeholder="0"
                onFocus={(e) => e.target.select()}
                onChange={(e) => setForm((f) => ({ ...f, stock: e.target.value.replace(/[^0-9]/g, "") }))}
                className="input"
              />
            </div>

            <div>
              <label className="label">Low-Stock Threshold</label>
              <input
                type="text"
                inputMode="numeric"
                value={form.threshold}
                placeholder="0"
                onFocus={(e) => e.target.select()}
                onChange={(e) => setForm((f) => ({ ...f, threshold: e.target.value.replace(/[^0-9]/g, "") }))}
                className="input"
              />
            </div>

            {/* Category picker */}
            <div className="sm:col-span-2">
              <label className="label">Category</label>
              {!showNewCatInput ? (
                <div className="flex gap-2">
                  <select
                    value={form.category_id ?? ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === "__new__") {
                        setShowNewCatInput(true);
                        setForm((f) => ({ ...f, category_id: null }));
                      } else {
                        setForm((f) => ({ ...f, category_id: val === "" ? null : Number(val) }));
                      }
                    }}
                    className="input flex-1"
                  >
                    <option value="">— No category —</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                    <option value="__new__">+ Create new category…</option>
                  </select>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input
                    autoFocus
                    type="text"
                    value={newCatName}
                    onChange={(e) => setNewCatName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); handleCreateCategory(); }
                      if (e.key === "Escape") { setShowNewCatInput(false); setNewCatName(""); }
                    }}
                    placeholder="New category name…"
                    className="input flex-1"
                  />
                  <button
                    type="button"
                    onClick={handleCreateCategory}
                    disabled={creatingCat || !newCatName.trim()}
                    className="px-4 py-2 bg-blue-700 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50"
                  >
                    {creatingCat ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowNewCatInput(false); setNewCatName(""); }}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
              )}
              {form.category_id && (
                <p className="text-xs text-gray-500 mt-1">
                  Category: {categories.find((c) => c.id === form.category_id)?.name}
                </p>
              )}
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
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm w-48 focus:outline-none focus:ring-2 focus:ring-blue-400 text-gray-900"
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
                    <Image src={med.photo_url} alt={med.name ?? med.barcode} fill className="object-cover" unoptimized />
                  ) : (
                    <span className="flex items-center justify-center h-full text-xs text-gray-400">Rx</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-sm text-gray-900 truncate">{med.name || med.barcode}</p>
                    {med.is_unnamed && (
                      <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded shrink-0">
                        needs review
                      </span>
                    )}
                    {med.category_id && (
                      <span className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded shrink-0">
                        {categories.find((c) => c.id === med.category_id)?.name}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 font-mono">{med.barcode}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p
                    className={`text-sm font-semibold ${
                      med.stock <= med.threshold ? "text-amber-600" : "text-gray-900"
                    }`}
                  >
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
          color: #111827;
        }
        .input:focus {
          ring: 2px solid #3b82f6;
          border-color: #3b82f6;
        }
      `}</style>
    </div>
  );
}

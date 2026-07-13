"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";

type MedScan = {
  id: number;
  name: string | null;
  barcode: string;
  photo_url: string | null;
  stock: number;
  threshold: number;
  unit: string;
  is_unnamed: boolean;
};

type MedFull = MedScan & {
  vendor_url: string | null;
  notes: string | null;
  category_id: number | null;
};

type Category = { id: number; name: string };
type Mode = "dispense" | "receive";
type ScanMode = "manual" | "quick";
type Tab = "scan" | "inventory";
type Toast = { color: "green" | "red"; headline: string; sub?: string };

type ScanPhase =
  | { kind: "idle" }
  | { kind: "looking" }
  | { kind: "found"; medication: MedScan; isNew?: boolean }
  | { kind: "error"; message: string }
  | { kind: "success"; message: string };

export default function MainPage() {
  const [tab, setTab] = useState<Tab>("scan");

  // ── Scan state ──────────────────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanLockRef = useRef(false);
  const lastScanRef = useRef<{ barcode: string; time: number } | null>(null);
  const processBarcodeRef = useRef<(code: string) => void>(() => {});

  const [phase, setPhase] = useState<ScanPhase>({ kind: "idle" });
  const [mode, setMode] = useState<Mode>("dispense");
  const [scanMode, setScanMode] = useState<ScanMode>("manual");
  const [quantity, setQuantity] = useState("1");
  const [note, setNote] = useState("");
  const [manualBarcode, setManualBarcode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const manualInputRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Inventory state ─────────────────────────────────────────────
  const [medications, setMedications] = useState<MedFull[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState("");
  const [stockFilter, setStockFilter] = useState<"all" | "low" | "ok">("all");
  const [categoryFilter, setCategoryFilter] = useState<number | "none" | null>(null);
  const [invLoading, setInvLoading] = useState(true);

  const fetchMedications = useCallback(async () => {
    try {
      const [medsRes, catsRes] = await Promise.all([
        fetch("/api/medications"),
        fetch("/api/categories"),
      ]);
      const meds = await medsRes.json();
      const cats = await catsRes.json();
      setMedications(Array.isArray(meds) ? meds : []);
      setCategories(Array.isArray(cats) ? cats : []);
    } catch (err) {
      console.error(err);
    } finally {
      setInvLoading(false);
    }
  }, []);

  useEffect(() => { fetchMedications(); }, [fetchMedications]);

  // ── Camera ──────────────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((t) => t.stop());
      videoRef.current.srcObject = null;
    }
    setScanning(false);
  }, []);

  const resetScan = useCallback(() => {
    scanLockRef.current = false;
    lastScanRef.current = null;
    setPhase({ kind: "idle" });
    setNote("");
    setQuantity("1");
    setManualBarcode("");
  }, []);

  const showToast = useCallback((t: Toast) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(t);
    toastTimerRef.current = setTimeout(() => setToast(null), 1800);
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    resetScan();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setScanning(true);
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const reader = new BrowserMultiFormatReader();
      try {
        await reader.decodeFromVideoElement(videoRef.current, (result) => {
          if (result) processBarcodeRef.current(result.getText());
        });
      } catch { /* expected when stream stops */ }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setCameraError(msg.includes("Permission") ? "Camera permission denied. Use manual entry below." : msg);
    }
  }, [resetScan]);

  useEffect(() => { if (tab !== "scan") stopCamera(); }, [tab, stopCamera]);
  useEffect(() => () => {
    stopCamera();
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, [stopCamera]);

  // ── Barcode lookup ──────────────────────────────────────────────
  const lookupBarcode = useCallback(async (barcode: string) => {
    const trimmed = barcode.trim();
    if (!trimmed) return;

    const now = Date.now();
    if (lastScanRef.current?.barcode === trimmed && now - lastScanRef.current.time < 1500) return;
    if (scanLockRef.current) return;

    scanLockRef.current = true;
    lastScanRef.current = { barcode: trimmed, time: now };
    stopCamera();
    setTab("scan");
    setPhase({ kind: "looking" });

    try {
      const res = await fetch(`/api/medications/barcode/${encodeURIComponent(trimmed)}`);

      if (res.ok) {
        const med: MedScan = await res.json();
        setPhase({ kind: "found", medication: med });
        return;
      }

      if (res.status === 404) {
        const createRes = await fetch("/api/medications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: null, barcode: trimmed, stock: 0, threshold: 10, unit: "units", is_unnamed: true }),
        });
        if (createRes.ok) {
          const med: MedScan = await createRes.json();
          setPhase({ kind: "found", medication: med, isNew: true });
        } else if (createRes.status === 409) {
          const refetchRes = await fetch(`/api/medications/barcode/${encodeURIComponent(trimmed)}`);
          if (refetchRes.ok) {
            const med: MedScan = await refetchRes.json();
            setPhase({ kind: "found", medication: med, isNew: med.is_unnamed ?? false });
          } else {
            scanLockRef.current = false;
            setPhase({ kind: "error", message: `Barcode ${trimmed} saved for staff review` });
          }
        } else {
          scanLockRef.current = false;
          setPhase({ kind: "error", message: `Could not save barcode ${trimmed}` });
        }
        return;
      }

      scanLockRef.current = false;
      setPhase({ kind: "error", message: "Failed to lookup barcode" });
    } catch {
      scanLockRef.current = false;
      setPhase({ kind: "error", message: "Failed to lookup barcode" });
    }
  }, [stopCamera]);

  // ── Quick scan ──────────────────────────────────────────────────
  const quickScanBarcode = useCallback(async (barcode: string) => {
    const trimmed = barcode.trim();
    if (!trimmed) return;

    const now = Date.now();
    // Short debounce — same barcode within 600ms is a double-fire, not a second scan
    if (lastScanRef.current?.barcode === trimmed && now - lastScanRef.current.time < 600) return;
    if (scanLockRef.current) return;

    scanLockRef.current = true;
    lastScanRef.current = { barcode: trimmed, time: now };

    try {
      const res = await fetch(`/api/medications/barcode/${encodeURIComponent(trimmed)}`);

      if (!res.ok) {
        showToast({ color: "red", headline: "Unknown barcode", sub: trimmed });
        return;
      }

      const med: MedScan = await res.json();

      if (mode === "dispense" && med.stock <= 0) {
        showToast({ color: "red", headline: "Out of stock", sub: med.name || med.barcode });
        return;
      }

      const txnRes = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ medication_id: med.id, type: mode, quantity: 1 }),
      });

      if (!txnRes.ok) {
        const data = await txnRes.json().catch(() => ({}));
        showToast({ color: "red", headline: data.error || "Transaction failed" });
        return;
      }

      showToast({
        color: mode === "receive" ? "green" : "red",
        headline: mode === "receive" ? "+1" : "−1",
        sub: med.name || med.barcode,
      });
      fetchMedications();
    } catch {
      showToast({ color: "red", headline: "Network error" });
    } finally {
      scanLockRef.current = false;
    }
  }, [mode, showToast, fetchMedications]);

  // Keep ref in sync every render — switches between manual and quick based on current mode
  useEffect(() => {
    processBarcodeRef.current = scanMode === "quick" ? quickScanBarcode : lookupBarcode;
  });

  // Physical scanner: global keydown, always active regardless of tab
  useEffect(() => {
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "Enter") {
        if (timer) { clearTimeout(timer); timer = null; }
        if (buffer.length > 0) {
          const code = buffer;
          buffer = "";
          processBarcodeRef.current(code);
          setManualBarcode(code);
        }
        return;
      }
      if (e.key.length === 1) {
        buffer += e.key;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { buffer = ""; timer = null; }, 500);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (timer) clearTimeout(timer);
    };
  }, []); // stable — always uses ref

  const handleManualLookup = (e: React.FormEvent) => {
    e.preventDefault();
    lookupBarcode(manualInputRef.current?.value ?? manualBarcode);
  };

  const handleTransaction = async () => {
    if (phase.kind !== "found") return;
    const med = phase.medication;
    setProcessing(true);
    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ medication_id: med.id, type: mode, quantity: quantity === "" ? 1 : Number(quantity), note: note || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        scanLockRef.current = false;
        setPhase({ kind: "error", message: data.error || "Transaction failed" });
        return;
      }
      const verb = mode === "receive" ? "Added" : "Dispensed";
      const label = med.name || med.barcode;
      scanLockRef.current = false;
      setPhase({ kind: "success", message: `${verb} ${quantity} ${med.unit} of ${label}. New stock: ${data.stock}` });
      setNote("");
      setQuantity("1");
      setManualBarcode("");
      fetchMedications();
    } catch {
      scanLockRef.current = false;
      setPhase({ kind: "error", message: "Network error" });
    } finally {
      setProcessing(false);
    }
  };

  // ── Inventory filtering ─────────────────────────────────────────
  let displayed = medications.filter(
    (m) => (m.name ?? "").toLowerCase().includes(search.toLowerCase()) || m.barcode.includes(search)
  );
  if (stockFilter === "low") displayed = displayed.filter((m) => m.stock <= m.threshold);
  if (stockFilter === "ok") displayed = displayed.filter((m) => m.stock > m.threshold);
  if (categoryFilter === "none") displayed = displayed.filter((m) => m.category_id === null);
  else if (categoryFilter !== null) displayed = displayed.filter((m) => m.category_id === categoryFilter);

  const lowCount = medications.filter((m) => m.stock <= m.threshold).length;
  const inStockCount = medications.filter((m) => m.stock > 0).length;
  const unnamedCount = medications.filter((m) => m.is_unnamed).length;

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200 mb-5">
        {(["scan", "inventory"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2.5 text-sm font-medium transition-colors rounded-t-lg -mb-px ${
              tab === t
                ? "bg-white border border-b-white border-gray-200 text-blue-700"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t === "scan" ? "Scan" : "Inventory"}
          </button>
        ))}
      </div>

      {/* ── SCAN TAB ── */}
      {tab === "scan" && (
        <div className="max-w-lg mx-auto">
          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-4 mb-4">
            <StatCard label="Total Items" value={medications.length} color="blue" />
            <StatCard label="In Stock" value={inStockCount} color="green" />
            <StatCard label="Low Stock" value={lowCount} color={lowCount > 0 ? "amber" : "green"} />
          </div>

          {/* Scan mode toggle */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-gray-500">Scan mode</span>
            <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
              <button
                onClick={() => { setScanMode("manual"); resetScan(); }}
                className={`px-4 py-1.5 font-medium transition-colors ${
                  scanMode === "manual" ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                Manual
              </button>
              <button
                onClick={() => { setScanMode("quick"); resetScan(); }}
                className={`px-4 py-1.5 font-medium transition-colors ${
                  scanMode === "quick" ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                Quick
              </button>
            </div>
          </div>

          {/* Dispense / Receive toggle */}
          <div className="flex rounded-lg border border-gray-300 overflow-hidden mb-4">
            {(["dispense", "receive"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 py-2.5 text-sm font-semibold transition-colors ${
                  mode === m
                    ? m === "dispense" ? "bg-red-600 text-white" : "bg-green-600 text-white"
                    : "bg-white text-gray-700 hover:bg-gray-50"
                }`}
              >
                {m === "dispense" ? "▼  Dispense" : "▲  Receive"}
              </button>
            ))}
          </div>

          {/* Quick mode toast */}
          {toast && (
            <div className={`rounded-xl px-4 py-3 mb-4 flex items-center gap-3 ${
              toast.color === "green" ? "bg-green-500 text-white" : "bg-red-500 text-white"
            }`}>
              <span className="text-3xl font-bold tabular-nums leading-none">{toast.headline}</span>
              {toast.sub && <span className="text-sm opacity-90 truncate">{toast.sub}</span>}
            </div>
          )}

          {/* Camera */}
          <div className="bg-black rounded-xl overflow-hidden mb-4 relative" style={{ aspectRatio: "4/3" }}>
            <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
            {!scanning && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gray-900">
                <svg className="w-10 h-10 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <button onClick={startCamera} className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
                  Start Camera
                </button>
                {cameraError && <p className="text-red-400 text-xs text-center px-4">{cameraError}</p>}
              </div>
            )}
            {scanning && (
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="border-2 border-blue-400 w-64 h-24 rounded opacity-70" />
              </div>
            )}
          </div>

          {scanning && (
            <button onClick={stopCamera} className="w-full mb-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">
              Stop Camera
            </button>
          )}

          {scanMode === "manual" && (
            <>
              {/* Manual entry */}
              <form onSubmit={handleManualLookup} className="flex gap-2 mb-5">
                <input
                  ref={manualInputRef}
                  type="text"
                  value={manualBarcode}
                  onChange={(e) => setManualBarcode(e.target.value)}
                  placeholder="Enter barcode manually..."
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 text-gray-900"
                />
                <button type="submit" className="px-4 py-2 bg-gray-700 text-white rounded-lg text-sm font-medium hover:bg-gray-800">
                  Lookup
                </button>
              </form>

              {/* Phase-driven UI */}
              {phase.kind === "looking" && (
                <div className="mb-4 p-3 rounded-lg text-sm bg-blue-50 text-blue-800 border border-blue-200 flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                  Looking up barcode…
                </div>
              )}

              {phase.kind === "error" && (
                <div className="mb-4 p-3 rounded-lg text-sm bg-red-50 text-red-800 border border-red-200 flex items-center justify-between">
                  <span>{phase.message}</span>
                  <button onClick={resetScan} className="ml-3 text-xs underline flex-shrink-0">Try again</button>
                </div>
              )}

              {phase.kind === "success" && (
                <div className="mb-4 p-3 rounded-lg text-sm bg-green-50 text-green-800 border border-green-200 flex items-center justify-between">
                  <span>{phase.message}</span>
                  <button onClick={resetScan} className="ml-3 text-xs underline flex-shrink-0">Scan another</button>
                </div>
              )}

              {phase.kind === "found" && (
                <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
                  {phase.isNew && (
                    <div className="mb-3 p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700 flex items-center gap-2">
                      <span>⚠</span>
                      <span>
                        New barcode — saved for staff review.{" "}
                        <Link href="/admin" className="underline font-medium">Complete in Admin</Link>
                      </span>
                    </div>
                  )}
                  <div className="flex items-start gap-3 mb-4">
                    {phase.medication.photo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={phase.medication.photo_url}
                        alt={phase.medication.name || phase.medication.barcode}
                        className="w-16 h-16 object-cover rounded-lg border"
                      />
                    ) : (
                      <div className="w-16 h-16 bg-gray-100 rounded-lg border flex items-center justify-center text-gray-400 text-xl">Rx</div>
                    )}
                    <div>
                      <p className="font-bold text-gray-900">{phase.medication.name || phase.medication.barcode}</p>
                      <p className="text-xs text-gray-500 font-mono">{phase.medication.barcode}</p>
                      <p className="text-sm text-gray-600 mt-1">
                        Current stock:{" "}
                        <span className={`font-semibold ${phase.medication.stock <= phase.medication.threshold ? "text-amber-600" : "text-green-700"}`}>
                          {phase.medication.stock} {phase.medication.unit}
                        </span>
                      </p>
                    </div>
                  </div>

                  <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={quantity}
                    placeholder="1"
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setQuantity(e.target.value.replace(/[^0-9]/g, ""))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-400 text-gray-900"
                  />

                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Note <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. Patient ID, batch number..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-blue-400 text-gray-900"
                  />

                  <div className="flex gap-2">
                    <button onClick={resetScan} className="flex-1 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">
                      Cancel
                    </button>
                    <button
                      onClick={handleTransaction}
                      disabled={processing}
                      className={`flex-1 py-2 rounded-lg text-sm font-semibold text-white transition-colors disabled:opacity-60 ${
                        mode === "dispense" ? "bg-red-600 hover:bg-red-700" : "bg-green-600 hover:bg-green-700"
                      }`}
                    >
                      {processing
                        ? "Processing..."
                        : mode === "dispense"
                        ? `Dispense ${quantity} ${phase.medication.unit}`
                        : `Receive ${quantity} ${phase.medication.unit}`}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {scanMode === "quick" && (
            <p className="text-center text-xs text-gray-400 mt-2 mb-1">
              Each scan {mode === "dispense" ? "subtracts" : "adds"} 1 unit instantly — no confirmation needed
            </p>
          )}

          <p className="text-center text-xs text-gray-400 mt-5">
            Physical scanner works anywhere on this page — no need to click first
          </p>
        </div>
      )}

      {/* ── INVENTORY TAB ── */}
      {tab === "inventory" && (
        <div>
          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 mb-4">
            <StatCard label="Total" value={medications.length} color="blue" />
            <StatCard label="Low Stock" value={lowCount} color={lowCount > 0 ? "amber" : "green"} />
            <StatCard label="In Stock" value={medications.filter((m) => m.stock > m.threshold).length} color="green" />
          </div>

          {/* Alerts */}
          {lowCount > 0 && (
            <div className="mb-3 p-3 bg-amber-50 border border-amber-300 rounded-lg flex items-center justify-between">
              <p className="text-amber-800 text-sm font-medium">
                {lowCount} medication{lowCount !== 1 ? "s are" : " is"} at or below threshold.
              </p>
              <button onClick={() => setStockFilter("low")} className="text-xs text-amber-700 underline">
                Show only
              </button>
            </div>
          )}
          {unnamedCount > 0 && (
            <div className="mb-3 p-3 bg-amber-50 border border-amber-300 rounded-lg flex items-center justify-between">
              <p className="text-amber-800 text-sm font-medium">
                {unnamedCount} unnamed item{unnamedCount !== 1 ? "s" : ""} need staff review.
              </p>
              <Link href="/admin" className="text-xs text-amber-700 underline">Review in Admin</Link>
            </div>
          )}

          {/* Category chips */}
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              <button
                onClick={() => setCategoryFilter(null)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  categoryFilter === null ? "bg-blue-700 text-white" : "bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"
                }`}
              >
                All categories
              </button>
              {categories.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setCategoryFilter(c.id === categoryFilter ? null : c.id)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    categoryFilter === c.id ? "bg-blue-700 text-white" : "bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {c.name}
                </button>
              ))}
              <button
                onClick={() => setCategoryFilter(categoryFilter === "none" ? null : "none")}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  categoryFilter === "none" ? "bg-gray-700 text-white" : "bg-white border border-gray-300 text-gray-400 hover:bg-gray-50"
                }`}
              >
                Uncategorized
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
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 text-gray-900"
            />
            <div className="flex gap-2">
              {(["all", "low", "ok"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setStockFilter(f)}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    stockFilter === f ? "bg-blue-700 text-white" : "bg-white border border-gray-300 text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {f === "ok" ? "Adequate" : f === "low" ? "Low" : "All"}
                </button>
              ))}
            </div>
            <Link href="/admin" className="px-4 py-2 bg-blue-700 text-white rounded-lg text-sm font-medium hover:bg-blue-800 text-center">
              + Add
            </Link>
          </div>

          {/* Grid */}
          {invLoading ? (
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
                  <Link href="/admin" className="text-blue-600 underline text-sm">Go to Admin</Link>
                </>
              ) : (
                <p className="text-lg">No results for &ldquo;{search}&rdquo;</p>
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
                      <Image src={med.photo_url} alt={med.name ?? med.barcode} fill className="object-cover" unoptimized />
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
                      {med.name || <span className="text-gray-400 font-mono font-normal">{med.barcode}</span>}
                    </p>
                    {med.is_unnamed && (
                      <span className="inline-block text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded mb-1">needs review</span>
                    )}
                    {med.category_id && (
                      <span className="inline-block text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded mb-1 ml-1">
                        {categories.find((c) => c.id === med.category_id)?.name}
                      </span>
                    )}
                    <p className="text-xs text-gray-500 mb-2 font-mono">{med.barcode}</p>
                    <div className="flex items-center justify-between">
                      <span className="text-lg font-bold text-gray-900">
                        {med.stock}
                        <span className="text-xs font-normal text-gray-500 ml-1">{med.unit}</span>
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${
                        med.stock === 0 ? "bg-red-100 text-red-800 border-red-200" :
                        med.stock <= med.threshold ? "bg-amber-100 text-amber-800 border-amber-200" :
                        "bg-green-100 text-green-800 border-green-200"
                      }`}>
                        {med.stock === 0 ? "Out" : med.stock <= med.threshold ? "Low" : "OK"}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mt-1">Threshold: {med.threshold} {med.unit}</p>
                    {med.vendor_url && (
                      <a href={med.vendor_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline mt-1 block truncate">
                        Order from vendor
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: "blue" | "amber" | "green" }) {
  const colors = { blue: "bg-blue-50 border-blue-200 text-blue-800", amber: "bg-amber-50 border-amber-200 text-amber-800", green: "bg-green-50 border-green-200 text-green-800" };
  return (
    <div className={`rounded-xl border p-4 ${colors[color]}`}>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-sm mt-0.5 opacity-80">{label}</p>
    </div>
  );
}

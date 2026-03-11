"use client";

import { useEffect, useRef, useState, useCallback } from "react";

type Medication = {
  id: number;
  name: string;
  barcode: string;
  photo_url: string | null;
  stock: number;
  threshold: number;
  unit: string;
};

type Mode = "receive" | "dispense";

// Discriminated union — makes status message and result card mutually exclusive
type ScanPhase =
  | { kind: "idle" }
  | { kind: "looking" }
  | { kind: "found"; medication: Medication }
  | { kind: "error"; message: string }
  | { kind: "success"; message: string };

export default function ScannerPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Stays true from first detection until user explicitly resets.
  // Unlike a boolean that resets in finally, this prevents ALL re-triggers.
  const scanLockRef = useRef(false);
  // Debounce: ignore the same barcode if re-seen within 1500ms
  const lastScanRef = useRef<{ barcode: string; time: number } | null>(null);

  const [phase, setPhase] = useState<ScanPhase>({ kind: "idle" });
  const [mode, setMode] = useState<Mode>("dispense");
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");
  const [manualBarcode, setManualBarcode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const stopCamera = useCallback(() => {
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((t) => t.stop());
      videoRef.current.srcObject = null;
    }
    setScanning(false);
  }, []);

  // Full reset — call this when the user wants to scan again
  const reset = useCallback(() => {
    scanLockRef.current = false;
    lastScanRef.current = null;
    setPhase({ kind: "idle" });
    setNote("");
    setQuantity(1);
    setManualBarcode("");
  }, []);

  const lookupBarcode = useCallback(async (barcode: string) => {
    const trimmed = barcode.trim();
    if (!trimmed) return;

    // Debounce: same barcode within 1500ms → ignore
    const now = Date.now();
    if (
      lastScanRef.current &&
      lastScanRef.current.barcode === trimmed &&
      now - lastScanRef.current.time < 1500
    ) return;

    // Lock: if already looking or found, ignore all subsequent ZXing callbacks
    if (scanLockRef.current) return;
    scanLockRef.current = true;
    lastScanRef.current = { barcode: trimmed, time: now };

    // Stop the camera immediately — before the fetch — so ZXing stops firing
    stopCamera();
    setPhase({ kind: "looking" });

    try {
      const res = await fetch(`/api/medications/barcode/${encodeURIComponent(trimmed)}`);
      if (!res.ok) {
        // On error, release the lock so the user can retry
        scanLockRef.current = false;
        setPhase({ kind: "error", message: `No medication found for barcode: ${trimmed}` });
        return;
      }
      const med: Medication = await res.json();
      // SUCCESS: lock stays true until user cancels or completes transaction
      setPhase({ kind: "found", medication: med });
    } catch {
      scanLockRef.current = false;
      setPhase({ kind: "error", message: "Failed to lookup barcode" });
    }
  }, [stopCamera]);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    reset();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setScanning(true);

      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const reader = new BrowserMultiFormatReader();
      try {
        await reader.decodeFromVideoElement(videoRef.current, (result) => {
          if (result) lookupBarcode(result.getText());
        });
      } catch {
        // Expected when stream is stopped
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setCameraError(
        msg.includes("Permission")
          ? "Camera permission denied. Use manual entry below."
          : msg
      );
    }
  }, [lookupBarcode, reset]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const handleManualLookup = (e: React.FormEvent) => {
    e.preventDefault();
    lookupBarcode(manualBarcode);
  };

  const handleTransaction = async () => {
    if (phase.kind !== "found") return;
    const med = phase.medication;
    setProcessing(true);
    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          medication_id: med.id,
          type: mode,
          quantity,
          note: note || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        scanLockRef.current = false;
        setPhase({ kind: "error", message: data.error || "Transaction failed" });
        return;
      }
      const verb = mode === "receive" ? "Added" : "Dispensed";
      // Release lock — user will need to scan a new barcode
      scanLockRef.current = false;
      setPhase({
        kind: "success",
        message: `${verb} ${quantity} ${med.unit} of ${med.name}. New stock: ${data.stock}`,
      });
      setNote("");
      setQuantity(1);
      setManualBarcode("");
    } catch {
      scanLockRef.current = false;
      setPhase({ kind: "error", message: "Network error" });
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Barcode Scanner</h1>
      <p className="text-gray-500 text-sm mb-5">
        Scan a medication barcode to receive or dispense stock.
      </p>

      {/* Mode selector */}
      <div className="flex rounded-lg border border-gray-300 overflow-hidden mb-5">
        {(["dispense", "receive"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 py-2.5 text-sm font-semibold capitalize transition-colors ${
              mode === m
                ? m === "dispense"
                  ? "bg-red-600 text-white"
                  : "bg-green-600 text-white"
                : "bg-white text-gray-700 hover:bg-gray-50"
            }`}
          >
            {m === "dispense" ? "Dispense (Remove)" : "Receive (Add)"}
          </button>
        ))}
      </div>

      {/* Camera */}
      <div className="bg-black rounded-xl overflow-hidden mb-4 relative" style={{ aspectRatio: "4/3" }}>
        <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
        {!scanning && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gray-900">
            <svg className="w-12 h-12 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <button
              onClick={startCamera}
              className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
            >
              Start Camera
            </button>
            {cameraError && (
              <p className="text-red-400 text-xs text-center px-4">{cameraError}</p>
            )}
          </div>
        )}
        {scanning && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className="border-2 border-blue-400 w-64 h-24 rounded opacity-70" />
          </div>
        )}
      </div>

      {scanning && (
        <button
          onClick={stopCamera}
          className="w-full mb-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
        >
          Stop Camera
        </button>
      )}

      {/* Manual entry */}
      <form onSubmit={handleManualLookup} className="flex gap-2 mb-5">
        <input
          type="text"
          value={manualBarcode}
          onChange={(e) => setManualBarcode(e.target.value)}
          placeholder="Enter barcode manually..."
          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
        <button
          type="submit"
          className="px-4 py-2 bg-gray-700 text-white rounded-lg text-sm font-medium hover:bg-gray-800"
        >
          Lookup
        </button>
      </form>

      {/* Phase-driven UI — only one of these renders at a time */}

      {phase.kind === "looking" && (
        <div className="mb-4 p-3 rounded-lg text-sm bg-blue-50 text-blue-800 border border-blue-200 flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
          Looking up barcode…
        </div>
      )}

      {phase.kind === "error" && (
        <div className="mb-4 p-3 rounded-lg text-sm bg-red-50 text-red-800 border border-red-200 flex items-center justify-between">
          <span>{phase.message}</span>
          <button onClick={reset} className="ml-3 text-xs underline flex-shrink-0">
            Try again
          </button>
        </div>
      )}

      {phase.kind === "success" && (
        <div className="mb-4 p-3 rounded-lg text-sm bg-green-50 text-green-800 border border-green-200 flex items-center justify-between">
          <span>{phase.message}</span>
          <button onClick={reset} className="ml-3 text-xs underline flex-shrink-0">
            Scan another
          </button>
        </div>
      )}

      {phase.kind === "found" && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-start gap-3 mb-4">
            {phase.medication.photo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={phase.medication.photo_url}
                alt={phase.medication.name}
                className="w-16 h-16 object-cover rounded-lg border"
              />
            ) : (
              <div className="w-16 h-16 bg-gray-100 rounded-lg border flex items-center justify-center text-gray-400 text-2xl">
                Rx
              </div>
            )}
            <div>
              <p className="font-bold text-gray-900">{phase.medication.name}</p>
              <p className="text-xs text-gray-500 font-mono">{phase.medication.barcode}</p>
              <p className="text-sm text-gray-600 mt-1">
                Current stock:{" "}
                <span
                  className={`font-semibold ${
                    phase.medication.stock <= phase.medication.threshold
                      ? "text-amber-600"
                      : "text-green-700"
                  }`}
                >
                  {phase.medication.stock} {phase.medication.unit}
                </span>
              </p>
            </div>
          </div>

          <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
          <input
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-400"
          />

          <label className="block text-sm font-medium text-gray-700 mb-1">
            Note <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Patient ID, batch number..."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-blue-400"
          />

          <div className="flex gap-2">
            <button
              onClick={reset}
              className="flex-1 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleTransaction}
              disabled={processing}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold text-white transition-colors disabled:opacity-60 ${
                mode === "dispense"
                  ? "bg-red-600 hover:bg-red-700"
                  : "bg-green-600 hover:bg-green-700"
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
    </div>
  );
}

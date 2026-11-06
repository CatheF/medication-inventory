"use client";

import { useEffect, useRef, useState, useCallback } from "react";

type Mode = "dispense" | "receive";

type MedResult = {
  id: number;
  name: string | null;
  barcode: string;
  stock: number;
  threshold: number;
  unit: string;
  is_unnamed: boolean;
};

type Phase =
  | { kind: "scanning" }
  | { kind: "looking" }
  | { kind: "confirm"; medication: MedResult; isUnnamed: boolean }
  | { kind: "processing" }
  | { kind: "success"; medName: string | null; medBarcode: string; quantity: number; newStock: number; mode: Mode }
  | { kind: "error"; message: string };

export default function KioskPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanLockRef = useRef(false);
  const lastScanRef = useRef<{ barcode: string; time: number } | null>(null);
  const autoResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processBarcodeRef = useRef<(code: string) => void>(() => {});

  const [phase, setPhase] = useState<Phase>({ kind: "scanning" });
  const [mode, setMode] = useState<Mode>("dispense");
  const [quantity, setQuantity] = useState(1);

  const scheduleReset = useCallback(() => {
    if (autoResetRef.current) clearTimeout(autoResetRef.current);
    autoResetRef.current = setTimeout(() => {
      scanLockRef.current = false;
      lastScanRef.current = null;
      setPhase({ kind: "scanning" });
      setQuantity(1);
    }, 2500);
  }, []);

  const processBarcode = useCallback(
    async (barcode: string) => {
      const trimmed = barcode.trim();
      if (!trimmed) return;

      const now = Date.now();
      if (lastScanRef.current?.barcode === trimmed && now - lastScanRef.current.time < 2000) return;
      if (scanLockRef.current) return;

      scanLockRef.current = true;
      lastScanRef.current = { barcode: trimmed, time: now };
      setPhase({ kind: "looking" });

      try {
        const res = await fetch(`/api/medications/barcode/${encodeURIComponent(trimmed)}`);

        if (res.ok) {
          const med: MedResult = await res.json();
          setPhase({ kind: "confirm", medication: med, isUnnamed: med.is_unnamed ?? false });
          return;
        }

        if (res.status === 404) {
          // The kiosk may only say a barcode was "saved for staff review" when it really was: the create succeeded, or the
          // create said it already exists (409) and the item can be opened. Every other outcome is a failure to save and is
          // shown as one, the same way a failed lookup is.
          const couldNotSave = () => {
            scanLockRef.current = false;
            setPhase({ kind: "error", message: `Could not save barcode ${trimmed}` });
            scheduleReset();
          };

          let createRes: Response | null = null;
          try {
            createRes = await fetch("/api/medications", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: null,
                barcode: trimmed,
                stock: 0,
                threshold: 10,
                unit: "units",
                is_unnamed: true,
              }),
            });
          } catch {
            // The server could not be reached: nothing was saved, which is handled with the other failed saves below.
          }

          if (createRes?.ok) {
            const newMed: MedResult = await createRes.json();
            setPhase({ kind: "confirm", medication: newMed, isUnnamed: true });
          } else if (createRes?.status === 409) {
            // Race: was just created by another scan — fetch it
            const fetchRes = await fetch(`/api/medications/barcode/${encodeURIComponent(trimmed)}`);
            if (fetchRes.ok) {
              const med: MedResult = await fetchRes.json();
              setPhase({ kind: "confirm", medication: med, isUnnamed: med.is_unnamed ?? false });
            } else {
              couldNotSave();
            }
          } else {
            couldNotSave();
          }
          return;
        }

        scanLockRef.current = false;
        setPhase({ kind: "error", message: "Lookup failed — please try again" });
        scheduleReset();
      } catch {
        scanLockRef.current = false;
        setPhase({ kind: "error", message: "Network error" });
        scheduleReset();
      }
    },
    [scheduleReset]
  );

  // Keep ref in sync with latest processBarcode (runs every render, no dep array needed)
  useEffect(() => {
    processBarcodeRef.current = processBarcode;
  });

  // Auto-start camera whenever phase is "scanning"
  useEffect(() => {
    if (phase.kind !== "scanning") return;
    let cancelled = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();

        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        try {
          await reader.decodeFromVideoElement(videoRef.current, (result) => {
            if (result && !cancelled) processBarcodeRef.current(result.getText());
          });
        } catch {
          // Expected when stream is stopped
        }
      } catch (err) {
        console.error("Camera:", err);
      }
    })();

    return () => {
      cancelled = true;
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach((t) => t.stop());
        // eslint-disable-next-line react-hooks/exhaustive-deps
        videoRef.current.srcObject = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind]);

  // Global keydown listener for physical scanner
  useEffect(() => {
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    const handle = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "Enter") {
        if (timer) { clearTimeout(timer); timer = null; }
        if (buffer.length > 0) {
          const code = buffer;
          buffer = "";
          processBarcodeRef.current(code);
        }
        return;
      }
      if (e.key.length === 1) {
        buffer += e.key;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { buffer = ""; timer = null; }, 500);
      }
    };

    document.addEventListener("keydown", handle);
    return () => {
      document.removeEventListener("keydown", handle);
      if (timer) clearTimeout(timer);
    };
  }, []); // stable — uses ref

  useEffect(
    () => () => {
      if (autoResetRef.current) clearTimeout(autoResetRef.current);
    },
    []
  );

  const handleConfirm = async () => {
    if (phase.kind !== "confirm") return;
    const med = phase.medication;
    setPhase({ kind: "processing" });

    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ medication_id: med.id, type: mode, quantity }),
      });
      const data = await res.json();
      if (!res.ok) {
        scanLockRef.current = false;
        setPhase({ kind: "error", message: data.error || "Transaction failed" });
        scheduleReset();
        return;
      }
      scanLockRef.current = false;
      setPhase({ kind: "success", medName: med.name, medBarcode: med.barcode, quantity, newStock: data.stock, mode });
      setQuantity(1);
      scheduleReset();
    } catch {
      scanLockRef.current = false;
      setPhase({ kind: "error", message: "Network error" });
      scheduleReset();
    }
  };

  const handleCancel = () => {
    if (autoResetRef.current) clearTimeout(autoResetRef.current);
    scanLockRef.current = false;
    lastScanRef.current = null;
    setPhase({ kind: "scanning" });
    setQuantity(1);
  };

  return (
    <div className="fixed inset-0 z-50 bg-gray-950 text-white flex flex-col overflow-hidden select-none">
      {/* Mode toggle */}
      <div className="flex gap-3 px-4 pt-5 pb-2 shrink-0">
        {(["dispense", "receive"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 py-4 rounded-2xl text-xl font-bold tracking-wide transition-all ${
              mode === m
                ? m === "dispense"
                  ? "bg-red-600 shadow-lg shadow-red-900/50"
                  : "bg-green-600 shadow-lg shadow-green-900/50"
                : "bg-gray-800 text-gray-500"
            }`}
          >
            {m === "dispense" ? "▼  DISPENSE" : "▲  RECEIVE"}
          </button>
        ))}
      </div>

      {/* Camera */}
      <div className="mx-4 rounded-3xl overflow-hidden bg-black relative shrink-0" style={{ height: "42vh" }}>
        <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          {phase.kind === "scanning" ? (
            <>
              <div className="border-2 border-blue-400 rounded-xl w-72 h-24 opacity-70" />
              <p className="absolute bottom-4 text-blue-300 text-xs tracking-widest uppercase opacity-60">
                Scan barcode
              </p>
            </>
          ) : (
            <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
              {(phase.kind === "looking" || phase.kind === "processing") && (
                <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Status area */}
      <div className="flex-1 px-4 py-3 flex flex-col justify-center min-h-0">
        {phase.kind === "scanning" && (
          <div className="text-center text-gray-600">
            <p className="text-4xl font-thin mb-2">Ready</p>
            <p className="text-sm">Point camera at barcode or use handheld scanner</p>
          </div>
        )}

        {phase.kind === "looking" && (
          <div className="text-center text-blue-400">
            <p className="text-2xl">Looking up barcode…</p>
          </div>
        )}

        {phase.kind === "confirm" && (
          <div className="space-y-3">
            {phase.isUnnamed && (
              <div className="bg-amber-950/80 border border-amber-600 rounded-xl p-3 text-amber-300 text-sm text-center">
                New barcode — saved for staff review in Admin
              </div>
            )}
            <div className="bg-gray-800 rounded-2xl p-4">
              <p className="text-2xl font-bold truncate">{phase.medication.name || phase.medication.barcode}</p>
              <p className="text-gray-500 text-xs font-mono mt-0.5">{phase.medication.barcode}</p>
              <p className="text-gray-300 mt-2 text-sm">
                Stock:{" "}
                <span className="text-white font-semibold">{phase.medication.stock}</span>
                {" → "}
                <span
                  className={
                    mode === "dispense"
                      ? "text-red-400 font-semibold"
                      : "text-green-400 font-semibold"
                  }
                >
                  {mode === "dispense"
                    ? phase.medication.stock - quantity
                    : phase.medication.stock + quantity}
                </span>
                <span className="text-gray-500 ml-1">{phase.medication.unit}</span>
              </p>
              <div className="flex items-center gap-3 mt-3">
                <span className="text-gray-400 text-sm">Qty:</span>
                <button
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  className="w-9 h-9 rounded-full bg-gray-700 hover:bg-gray-600 font-bold text-xl leading-none"
                >
                  −
                </button>
                <span className="text-2xl font-bold w-10 text-center tabular-nums">{quantity}</span>
                <button
                  onClick={() => setQuantity((q) => q + 1)}
                  className="w-9 h-9 rounded-full bg-gray-700 hover:bg-gray-600 font-bold text-xl leading-none"
                >
                  +
                </button>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleCancel}
                className="px-6 py-4 rounded-2xl bg-gray-800 text-gray-300 font-semibold text-lg hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                className={`flex-1 py-4 rounded-2xl font-bold text-xl transition-colors ${
                  mode === "dispense"
                    ? "bg-red-600 hover:bg-red-500"
                    : "bg-green-600 hover:bg-green-500"
                }`}
              >
                {mode === "dispense" ? `DISPENSE ${quantity}` : `RECEIVE ${quantity}`}
              </button>
            </div>
          </div>
        )}

        {phase.kind === "processing" && (
          <div className="text-center">
            <div className="w-10 h-10 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="text-xl text-gray-300">Processing…</p>
          </div>
        )}

        {phase.kind === "success" && (
          <div
            className={`rounded-2xl p-6 text-center border ${
              phase.mode === "dispense"
                ? "bg-red-950/60 border-red-700"
                : "bg-green-950/60 border-green-700"
            }`}
          >
            <p className="text-5xl mb-3">{phase.mode === "dispense" ? "↓" : "↑"}</p>
            <p className="text-2xl font-bold">{phase.medName || phase.medBarcode}</p>
            <p
              className={`text-lg mt-1 ${
                phase.mode === "dispense" ? "text-red-300" : "text-green-300"
              }`}
            >
              {phase.mode === "dispense" ? "Dispensed" : "Received"} {phase.quantity}
            </p>
            <p className="text-gray-400 mt-1 text-sm">
              New stock:{" "}
              <span className="text-white font-semibold">{phase.newStock}</span>
            </p>
            <div className="mt-4 h-1 bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${
                  phase.mode === "dispense" ? "bg-red-500" : "bg-green-500"
                }`}
                style={{ animation: "kiosk-shrink 2.5s linear forwards" }}
              />
            </div>
          </div>
        )}

        {phase.kind === "error" && (
          <div className="bg-gray-800 border border-red-700 rounded-2xl p-6 text-center">
            <p className="text-red-400 text-xl mb-4">{phase.message}</p>
            <button
              onClick={handleCancel}
              className="px-6 py-3 bg-gray-700 hover:bg-gray-600 rounded-xl font-medium"
            >
              Try Again
            </button>
          </div>
        )}
      </div>

      <div className="text-center pb-4 shrink-0">
        <a href="/" className="text-gray-800 text-xs hover:text-gray-600 transition-colors">
          ← Exit Kiosk Mode
        </a>
      </div>
    </div>
  );
}

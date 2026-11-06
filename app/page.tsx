"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import type { IScannerControls } from "@zxing/browser";
import type { Category, Medication } from "@/lib/db";
import { normalizeCategory, normalizeMedication } from "@/lib/normalize";
import { InventoryTab, type InventoryStatus } from "./components/inventory/InventoryTab";
import { WarnIcon } from "./components/inventory/Icons";
import { LoadErrorNotice } from "./components/inventory/LoadErrorNotice";
import { StatCard } from "./components/inventory/StatCard";
import { TabUrlSync, useTabInUrl, type Tab } from "./components/inventory/tab-url";
import { useInventoryView } from "./components/inventory/useInventoryView";

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

type Mode = "dispense" | "receive";
type ScanMode = "manual" | "quick";
type Toast = { color: "green" | "red"; headline: string; sub?: string };

// Quick mode: the line under "Lookup failed" / "Network error". A failed lookup is only a read, so nothing was recorded and
// scanning again is always safe.
const LOOKUP_FAILED_HINT = "Check the connection and scan again.";

// The quantity of one Receive / Dispense. An emptied quantity box means 1 (the request, the button label and the
// confirmation message all use this one value, so they can never disagree).
function unitsToRecord(quantity: string): number {
  return quantity === "" ? 1 : Number(quantity);
}

type ScanPhase =
  | { kind: "idle" }
  | { kind: "looking" }
  | { kind: "found"; medication: MedScan; isNew?: boolean }
  | { kind: "error"; message: string }
  | { kind: "success"; message: string };

// ── Inventory data loading ──────────────────────────────────────────────────────────────────────
// A failed request is never turned into an empty list: it becomes a message the Inventory tab shows next to a
// Retry button. (The API answers { error, code? } with a non-2xx status when the database is unreachable or refuses.)
type ListResult<T> = { ok: true; data: T[] } | { ok: false; message: string };
type InventoryResult = { meds: ListResult<Medication>; cats: ListResult<Category> };

const REQUEST_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serverMessage(body: unknown, status: number, fallback: string): string {
  if (isRecord(body) && typeof body.error === "string" && body.error.trim() !== "") {
    const code = typeof body.code === "string" && body.code !== "" ? ` (code ${body.code})` : "";
    return `${body.error.trim()}${code}`;
  }
  return `${fallback} (the server answered ${status}).`;
}

async function loadList<T>(
  url: string,
  noun: string,
  convert: (row: Record<string, unknown>) => T,
  isValid: (item: T) => boolean = () => true
): Promise<ListResult<T>> {
  let res: Response;
  try {
    const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
    res = await fetch(url, { signal, cache: "no-store" }); // never a cached list: stale data looks like lost data
  } catch (err) {
    const timedOut = err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      ok: false,
      message: timedOut
        ? `The server took too long to answer while loading the ${noun}.`
        : `Could not reach the server while loading the ${noun}. Check the internet connection.`,
    };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null; // not JSON: handled below
  }
  if (!res.ok) return { ok: false, message: serverMessage(body, res.status, `The ${noun} could not be loaded`) };
  if (!Array.isArray(body) || !body.every(isRecord)) {
    return { ok: false, message: `The server sent an unexpected answer for the ${noun}.` };
  }
  const data = body.map(convert);
  if (!data.every(isValid)) return { ok: false, message: `The server sent an unexpected answer for the ${noun}.` };
  return { ok: true, data };
}

async function loadInventory(): Promise<InventoryResult> {
  const [meds, cats] = await Promise.all([
    loadList("/api/medications", "inventory", normalizeMedication, (item) => Number.isFinite(item.id)),
    loadList("/api/categories", "category list", normalizeCategory),
  ]);
  return { meds, cats };
}

// ── Physical scanner: which focused element keeps the keystrokes ───────────────────────────────
// A scanner "types" the barcode and Enter like a keyboard. While focus is in a field where typing means something
// else (a text box, a <select> that jumps between its options by typed letters, a text area, an editable element)
// the keys belong to that field and are not a scan. Anything else is no text entry: a checkbox the mouse just ticked
// (focus stays on it), a radio button, a slider, a button... ignore digits, so a scan sent while one of them has focus
// is still a scan.
const TEXT_ENTRY_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "search",
  "number",
  "email",
  "url",
  "tel",
  "password",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
]);

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  // input.type is the normalized type: an unknown or missing type reads as "text"
  return target instanceof HTMLInputElement && TEXT_ENTRY_INPUT_TYPES.has(target.type);
}

export default function MainPage() {
  // The tab lives in the address (/?tab=inventory), the Inventory view (search, filters, sort, grouping) in
  // sessionStorage: see tab-url.tsx and useInventoryView.ts. Both give the server render and the first client render
  // the same answer (Scan tab, default view) and apply the real values right after, so there is no hydration mismatch.
  const [tab, setTab] = useTabInUrl();

  // ── Scan state ──────────────────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement>(null);
  // The stream getUserMedia handed out. The <video> element (and its srcObject) is gone as soon as the Scan tab is left,
  // so the tracks that keep the camera (and its LED) on can only be reached through this ref.
  const streamRef = useRef<MediaStream | null>(null);
  // The decode loop of @zxing/browser. It is a timer loop of its own (it copies the <video> into a canvas twice a second) and
  // goes on after the stream has ended, for as long as the page lives, until stop() is called on the controls it handed back.
  const decoderRef = useRef<IScannerControls | null>(null);
  // Which Start Camera press is the current one. Everything that ends the camera moves it on, so a start that was overtaken (the
  // tab was left, or a scan came in, while it still waited for the permission, the video or the decoder) can tell, and cleans up
  // after itself instead of starting a decode loop that nothing would ever stop.
  const cameraRunRef = useRef(0);
  const tabButtonRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  // True only while a request for a scan or a transaction is in flight: a second scan then waits for the first.
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
  // A click that is about to focus the manual box (set on mouse down, which runs before focus), and whether the focus it caused
  // selected the text. Used only to keep that selection through the mouse-up of the same click.
  const manualMouseDownRef = useRef(false);
  const manualKeepSelectionRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Inventory state ─────────────────────────────────────────────
  const [medications, setMedications] = useState<Medication[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [view, setView] = useInventoryView();
  // "loading" until BOTH requests have settled; "error" only when the items could not be loaded and there is
  // nothing to show; otherwise "ready". A refresh that fails after a successful load keeps the old list and sets
  // refreshError instead (the Inventory tab shows it as a warning with Retry).
  const [loadStatus, setLoadStatus] = useState<InventoryStatus>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true); // the first load starts on mount
  const hasDataRef = useRef(false);
  const latestRequestRef = useRef(0);
  const initialLoadRef = useRef<Promise<InventoryResult> | null>(null);

  const applyInventory = useCallback((requestId: number, result: InventoryResult) => {
    if (requestId !== latestRequestRef.current) return; // a newer request replaced this one
    if (result.meds.ok) {
      hasDataRef.current = true;
      setMedications(result.meds.data);
      setLoadStatus("ready");
      setLoadError(null);
      setRefreshError(null);
    } else if (hasDataRef.current) {
      setRefreshError(result.meds.message);
    } else {
      setLoadStatus("error");
      setLoadError(result.meds.message);
    }
    if (result.cats.ok) {
      setCategories(result.cats.data);
      setCategoriesError(null);
    } else {
      setCategoriesError(result.cats.message);
    }
    setRefreshing(false);
  }, []);

  const reloadInventory = useCallback(
    (showLoading: boolean) => {
      const requestId = ++latestRequestRef.current;
      setRefreshing(true);
      if (showLoading) {
        setLoadStatus("loading");
        setLoadError(null);
      }
      loadInventory().then((result) => applyInventory(requestId, result));
    },
    [applyInventory]
  );

  // Quiet reload (after a transaction): keeps whatever is on screen while it runs.
  const fetchMedications = useCallback(() => reloadInventory(false), [reloadInventory]);
  // "Retry" button: shows the loading state again only when there is no list yet.
  const retryInventory = useCallback(() => reloadInventory(!hasDataRef.current), [reloadInventory]);

  // Scan tab: the load-error notice (see below) is replaced by the loading state while a retry runs, and takes the
  // focused Retry button with it. If the retry fails again the notice comes back; put keyboard focus on it then, like
  // the Inventory tab does, instead of leaving it at the top of the page.
  const scanErrorRef = useRef<HTMLDivElement>(null);
  const scanRetryPendingRef = useRef(false);
  const handleScanRetry = () => {
    scanRetryPendingRef.current = true;
    retryInventory();
  };
  useEffect(() => {
    if (!scanRetryPendingRef.current || loadStatus === "loading") return;
    scanRetryPendingRef.current = false;
    const focus = document.activeElement;
    if (loadStatus === "error" && (focus === null || focus === document.body)) scanErrorRef.current?.focus();
  }, [loadStatus, loadError]);

  useEffect(() => {
    // React Strict Mode (development) runs effects twice; both runs share one request.
    const request = (initialLoadRef.current ??= loadInventory());
    const requestId = ++latestRequestRef.current;
    request.then((result) => applyInventory(requestId, result));
  }, [applyInventory]);

  // ── Camera ──────────────────────────────────────────────────────
  // Ends the camera itself: the decode loop, then every track of the stream we started (kept in streamRef) and of whatever
  // the <video> still shows. It touches no state, so it is safe to call from an effect or a cleanup.
  const releaseStream = useCallback(() => {
    cameraRunRef.current += 1; // retires any Start Camera that is still on its way (see startCamera)
    decoderRef.current?.stop();
    decoderRef.current = null;
    const video = videoRef.current;
    const streams = new Set<MediaStream>();
    if (streamRef.current) streams.add(streamRef.current);
    if (video?.srcObject instanceof MediaStream) streams.add(video.srcObject);
    streamRef.current = null;
    streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    if (video) video.srcObject = null;
  }, []);

  const stopCamera = useCallback(() => {
    releaseStream();
    setScanning(false);
  }, [releaseStream]);

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
    // This press's number, taken once the stream has arrived (-1 until then). From then on `run !== cameraRunRef.current` means
    // the camera was ended or started again meanwhile, and whatever is left of this start must go.
    let run = -1;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      if (!videoRef.current) {
        // The Scan tab was left while the browser was still asking for the camera: nobody will look at this stream.
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      // A second Start Camera pressed while the first request was pending: the older stream and decode loop must not keep running.
      releaseStream();
      run = cameraRunRef.current;
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      if (run !== cameraRunRef.current) return; // ended while the video was starting: its stream is released already
      setScanning(true);
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const video = videoRef.current;
      if (run !== cameraRunRef.current || !video) return;
      const reader = new BrowserMultiFormatReader();
      try {
        const controls = await reader.decodeFromVideoElement(video, (result) => {
          if (result && run === cameraRunRef.current) processBarcodeRef.current(result.getText());
        });
        if (run === cameraRunRef.current) decoderRef.current = controls;
        else controls.stop(); // ended while the decoder was starting: this loop has no owner any more
      } catch { /* expected when stream stops */ }
    } catch (err: unknown) {
      // Once the stream had arrived, an error of a start that was overtaken (its play() aborted by the release, say) is a
      // consequence of that, not news. Before that (permission denied, no camera) the error is always shown.
      if (run !== -1 && run !== cameraRunRef.current) return;
      const msg = err instanceof Error ? err.message : "Unknown error";
      setCameraError(msg.includes("Permission") ? "Camera permission denied. Use manual entry below." : msg);
    }
  }, [resetScan, releaseStream]);

  // Leaving the Scan tab ends the camera state. This was an effect calling stopCamera(); by the time that effect ran
  // the <video> element was already unmounted with the tab, so all it did was setScanning(false). Doing the same
  // reset while rendering gives the identical result without the extra render pass (and the lint error).
  if (tab !== "scan" && scanning) setScanning(false);
  // The <video> element is gone with the tab, but the camera is not: end the stream itself (the LED stays on otherwise).
  // releaseStream sets no state, which is why this one can be an effect.
  useEffect(() => {
    if (tab !== "scan") releaseStream();
  }, [tab, releaseStream]);
  // Leaving the page (a link to another route) ends the camera too.
  useEffect(() => () => {
    releaseStream();
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, [releaseStream]);

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
    // A new scan is a new item: the quantity and note typed for the card that was open must not carry over to this one.
    setNote("");
    setQuantity("1");
    setPhase({ kind: "looking" });

    // The lock covers the request only. It is released on every way out (found, new barcode, not saved, network error),
    // so a card that stays open, or one that is no longer on screen, can never leave later scans doing nothing.
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
          // The new item is not in the loaded list yet: load it again so the Scan tab's numbers and the Inventory tab
          // include it without a page reload.
          fetchMedications();
        } else if (createRes.status === 409) {
          const refetchRes = await fetch(`/api/medications/barcode/${encodeURIComponent(trimmed)}`);
          if (refetchRes.ok) {
            const med: MedScan = await refetchRes.json();
            setPhase({ kind: "found", medication: med, isNew: med.is_unnamed ?? false });
            fetchMedications(); // somebody else just created it: the loaded list may lack it too
          } else {
            setPhase({ kind: "error", message: `Barcode ${trimmed} saved for staff review` });
          }
        } else {
          setPhase({ kind: "error", message: `Could not save barcode ${trimmed}` });
        }
        return;
      }

      setPhase({ kind: "error", message: "Failed to lookup barcode" });
    } catch {
      setPhase({ kind: "error", message: "Failed to lookup barcode" });
    } finally {
      scanLockRef.current = false;
    }
  }, [stopCamera, setTab, fetchMedications]);

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

    // False until the item has been read. A failure before that is a failed LOOKUP (a read: nothing was recorded, so "scan
    // again" is safe). Once the stock movement is on its way a failure leaves it open whether it was recorded, so that toast
    // keeps its short message and does not tell staff to scan again.
    let lookupDone = false;
    try {
      const res = await fetch(`/api/medications/barcode/${encodeURIComponent(trimmed)}`);

      // The barcode route answers 404 ONLY when no item has this barcode. Any other failure (a server or database error, a
      // refused request) says nothing about the item, which may well exist, so it must not be reported as an unknown barcode.
      if (res.status === 404) {
        showToast({ color: "red", headline: "Unknown barcode", sub: trimmed });
        return;
      }
      if (!res.ok) {
        showToast({ color: "red", headline: "Lookup failed", sub: LOOKUP_FAILED_HINT });
        return;
      }

      const med: MedScan = await res.json();
      lookupDone = true;

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
      showToast(
        lookupDone
          ? { color: "red", headline: "Network error" }
          : { color: "red", headline: "Network error", sub: LOOKUP_FAILED_HINT }
      );
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
    // True from a Space that was held back as part of a scan (below) until its key-up.
    let spaceHeldBack = false;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Text boxes, text areas, editable elements and the <select> of the Inventory tab's Sort control (it uses typed
      // letters to jump between its options, so a letter and Enter there would be read as a one-character "scan" and
      // save a junk item) keep their keystrokes. Checkboxes, radio buttons, buttons and the like do not.
      if (isTextEntryTarget(e.target)) return;

      if (e.key === "Enter") {
        if (timer) { clearTimeout(timer); timer = null; }
        if (buffer.length > 0) {
          const code = buffer;
          buffer = "";
          // The scanner's Enter belongs to the scan. Left alone it would also press whatever has keyboard focus: the tab
          // button that was clicked a moment ago (which re-selects the tab the scan has just left), or a link. An Enter
          // with nothing buffered is an ordinary key press and is left alone.
          if (code.trim() !== "") e.preventDefault();
          processBarcodeRef.current(code);
          setManualBarcode(code);
        }
        return;
      }
      if (e.key.length === 1) {
        // A space INSIDE a barcode ("AB 123") belongs to the scan too. Left alone it would press whatever has keyboard focus:
        // a checkbox the mouse ticked gets unticked, "Add all" adds a whole group, and with nothing focused the page scrolls.
        // Buttons and checkboxes press on the key-UP of a Space (Firefox even when the key-down was cancelled), so that is held
        // back as well (handleKeyUp). Only once something other than spaces is buffered, i.e. while a scan is under way: a
        // person's own Space (tick a checkbox, press a button) arrives with nothing buffered and works as usual, also twice in a row.
        if (e.key === " " && /\S/.test(buffer)) {
          e.preventDefault();
          spaceHeldBack = true;
        }
        buffer += e.key;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { buffer = ""; spaceHeldBack = false; timer = null; }, 500);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " || !spaceHeldBack) return;
      spaceHeldBack = false;
      e.preventDefault();
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      if (timer) clearTimeout(timer);
    };
  }, []); // stable — always uses ref

  const handleManualLookup = (e: React.FormEvent) => {
    e.preventDefault();
    const input = manualInputRef.current;
    lookupBarcode(input?.value ?? manualBarcode);
    // The looked-up code stays visible in the box, but selected: whatever is typed or scanned next replaces it. A handheld
    // scanner types into the focused box like a keyboard, so without this its digits were added to the END of the previous
    // code, and the lookup was for the two barcodes glued together, which no item has: it was saved as a junk "unknown" item.
    input?.select();
  };

  const handleTransaction = async () => {
    if (phase.kind !== "found") return;
    const med = phase.medication;
    // The quantity that is recorded: an emptied box means 1. The request and the success message below both use THIS number
    // (not the typed text), so the message always states what was actually recorded.
    const units = unitsToRecord(quantity);
    // A scan that arrives while the transaction is on its way must not swap the card under it.
    scanLockRef.current = true;
    setProcessing(true);
    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ medication_id: med.id, type: mode, quantity: units, note: note || undefined }),
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
      setPhase({ kind: "success", message: `${verb} ${units} ${med.unit} of ${label}. New stock: ${data.stock}` });
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

  // ── Scan tab stats ──────────────────────────────────────────────
  // Em dash (never 0) until the inventory has loaded: a zero would read as "the inventory is empty".
  const statsReady = loadStatus === "ready";
  const lowCount = medications.filter((m) => m.stock <= m.threshold).length;
  const inStockCount = medications.filter((m) => m.stock > 0).length;

  // "Scan a barcode" in the Inventory tab's empty state: show the Scan tab and leave keyboard focus on its (always present)
  // tab button, because the button that was pressed goes away with the Inventory tab. A physical scanner works from there.
  const goToScan = () => {
    setTab("scan");
    tabButtonRefs.current.scan?.focus();
  };

  return (
    <div>
      <TabUrlSync />

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200 mb-5">
        {(["scan", "inventory"] as Tab[]).map((t) => (
          <button
            key={t}
            ref={(element) => {
              tabButtonRefs.current[t] = element;
            }}
            onClick={() => setTab(t)}
            aria-current={tab === t ? "true" : undefined}
            className={`min-h-11 px-5 py-2.5 text-sm font-medium transition-colors rounded-t-lg -mb-px ${
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
          <h1 className="sr-only">Scan medications</h1>
          {/* The inventory could not be loaded: say why (same words as the Inventory tab) and offer Retry. The stat
              cards below keep their dashes: a dash is "not known", never 0. */}
          {loadStatus === "error" && (
            <LoadErrorNotice
              ref={scanErrorRef}
              data-testid="scan-inventory-error"
              message={loadError}
              onRetry={handleScanRetry}
              className="mb-4"
            />
          )}

          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-4 mb-4">
            <StatCard label="Total Items" value={statsReady ? medications.length : null} color="blue" />
            <StatCard label="In Stock" value={statsReady ? inStockCount : null} color={statsReady ? "green" : "blue"} />
            <StatCard label="Low Stock" value={statsReady ? lowCount : null} color={!statsReady ? "blue" : lowCount > 0 ? "amber" : "green"} />
          </div>

          {/* Scan mode toggle (every button of the Scan tab is at least 44px tall; the pressed state is also spoken) */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-gray-500">Scan mode</span>
            <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
              <button
                onClick={() => { setScanMode("manual"); resetScan(); }}
                aria-pressed={scanMode === "manual"}
                className={`min-h-11 px-4 py-1.5 font-medium transition-colors ${
                  scanMode === "manual" ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                Manual
              </button>
              <button
                onClick={() => { setScanMode("quick"); resetScan(); }}
                aria-pressed={scanMode === "quick"}
                className={`min-h-11 px-4 py-1.5 font-medium transition-colors ${
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
                aria-pressed={mode === m}
                className={`flex-1 min-h-11 py-2.5 text-sm font-semibold transition-colors ${
                  mode === m
                    ? m === "dispense" ? "bg-red-600 text-white" : "bg-green-700 text-white"
                    : "bg-white text-gray-700 hover:bg-gray-50"
                }`}
              >
                {m === "dispense" ? "▼  Dispense" : "▲  Receive"}
              </button>
            ))}
          </div>

          {/* Quick mode toast. The wrapper is always there (empty, so it takes no room): a message put into a live region
              that already exists is read out, one that arrives together with its region often is not. */}
          <div role="status" aria-live="polite" aria-atomic="true">
            {toast && (
              // The "Lookup failed" hint may wrap below its headline on a narrow screen instead of squeezing the headline into two
              // lines and cutting the hint off ("Check the connection …"). Every other toast keeps its single-line layout.
              <div className={`rounded-xl px-4 py-3 mb-4 flex items-center ${
                toast.sub === LOOKUP_FAILED_HINT ? "flex-wrap gap-x-3 gap-y-1" : "gap-3"
              } ${toast.color === "green" ? "bg-green-700 text-white" : "bg-red-700 text-white"}`}>
                <span className="text-3xl font-bold tabular-nums leading-none">{toast.headline}</span>
                {toast.sub && <span className="text-sm truncate">{toast.sub}</span>}
              </div>
            )}
          </div>

          {/* Camera */}
          <div className="bg-black rounded-xl overflow-hidden mb-4 relative" style={{ aspectRatio: "4/3" }}>
            <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
            {!scanning && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gray-900">
                <svg className="w-10 h-10 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <button onClick={startCamera} className="min-h-11 px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
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
            <button onClick={stopCamera} className="w-full min-h-11 mb-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">
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
                  // Entering the box selects what is in it, so a code typed or scanned next replaces it. The box can still hold an
                  // earlier code (a lookup leaves it there, and a scan made elsewhere on the page puts its code there), and a
                  // handheld scanner types like a keyboard: without this its digits were added to the END of the old code, and
                  // the lookup was for two barcodes glued together, which no item has, so it was saved as a junk "unknown" item.
                  onMouseDown={() => {
                    manualMouseDownRef.current = true;
                  }}
                  onFocus={(e) => {
                    e.currentTarget.select();
                    manualKeepSelectionRef.current = manualMouseDownRef.current;
                  }}
                  onMouseUp={(e) => {
                    // Some browsers drop the selection again when the click that focused the box is released.
                    if (manualKeepSelectionRef.current) e.preventDefault();
                    manualMouseDownRef.current = false;
                    manualKeepSelectionRef.current = false;
                  }}
                  placeholder="Enter barcode manually..."
                  aria-label="Barcode"
                  className="flex-1 min-w-0 min-h-11 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 text-gray-900"
                />
                <button type="submit" className="min-h-11 px-4 py-2 bg-gray-700 text-white rounded-lg text-sm font-medium hover:bg-gray-800">
                  Lookup
                </button>
              </form>

              {/* Phase-driven UI. The two small buttons keep the 44px height of the boxes: they are 44px tall themselves and
                  reach 12px into the padding above and below (-my-3), so the boxes do not grow. */}
              {phase.kind === "looking" && (
                <div role="status" className="mb-4 p-3 rounded-lg text-sm bg-blue-50 text-blue-800 border border-blue-200 flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                  Looking up barcode…
                </div>
              )}

              {phase.kind === "error" && (
                <div role="alert" className="mb-4 p-3 rounded-lg text-sm bg-red-50 text-red-800 border border-red-200 flex items-center justify-between">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{phase.message}</span>
                  <button onClick={resetScan} className="ml-3 -my-3 inline-flex min-h-11 flex-shrink-0 items-center px-2 text-sm font-medium underline">Try again</button>
                </div>
              )}

              {phase.kind === "success" && (
                <div role="status" className="mb-4 p-3 rounded-lg text-sm bg-green-50 text-green-800 border border-green-200 flex items-center justify-between">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{phase.message}</span>
                  <button onClick={resetScan} className="ml-3 -my-3 inline-flex min-h-11 flex-shrink-0 items-center px-2 text-sm font-medium underline">Scan another</button>
                </div>
              )}

              {phase.kind === "found" && (
                <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
                  {phase.isNew && (
                    <div className="mb-3 p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700 flex items-center gap-2">
                      <WarnIcon className="h-4 w-4" />
                      <span>
                        New barcode — saved for staff review.{" "}
                        <Link href="/admin" className="underline font-medium">Complete in Admin</Link>
                      </span>
                    </div>
                  )}
                  {/* min-w-0 on the text column and break-all on the barcode: a long barcode (up to 1024 characters) has no spaces
                      to wrap at, and would otherwise push the card (and the page) sideways. */}
                  <div className="flex items-start gap-3 mb-4">
                    {phase.medication.photo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={phase.medication.photo_url}
                        alt={phase.medication.name || phase.medication.barcode}
                        className="w-16 h-16 shrink-0 object-cover rounded-lg border"
                      />
                    ) : (
                      <div className="w-16 h-16 shrink-0 bg-gray-100 rounded-lg border flex items-center justify-center text-gray-600 text-xl">Rx</div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-gray-900 [overflow-wrap:anywhere]">{phase.medication.name || phase.medication.barcode}</p>
                      <p className="text-xs text-gray-500 font-mono break-all">{phase.medication.barcode}</p>
                      <p className="text-sm text-gray-600 mt-1 [overflow-wrap:anywhere]">
                        Current stock:{" "}
                        <span className={`font-semibold ${phase.medication.stock <= phase.medication.threshold ? "text-amber-700" : "text-green-700"}`}>
                          {phase.medication.stock} {phase.medication.unit}
                        </span>
                      </p>
                    </div>
                  </div>

                  <label htmlFor="scan-quantity" className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
                  <input
                    id="scan-quantity"
                    type="text"
                    inputMode="numeric"
                    value={quantity}
                    placeholder="1"
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setQuantity(e.target.value.replace(/[^0-9]/g, ""))}
                    className="w-full min-h-11 px-3 py-2 border border-gray-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-600 text-gray-900"
                  />

                  <label htmlFor="scan-note" className="block text-sm font-medium text-gray-700 mb-1">
                    Note <span className="text-gray-600 font-normal">(optional)</span>
                  </label>
                  <input
                    id="scan-note"
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. Patient ID, batch number..."
                    className="w-full min-h-11 px-3 py-2 border border-gray-300 rounded-lg text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-blue-600 text-gray-900"
                  />

                  <div className="flex gap-2">
                    <button onClick={resetScan} className="flex-1 min-h-11 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">
                      Cancel
                    </button>
                    <button
                      onClick={handleTransaction}
                      disabled={processing}
                      className={`flex-1 min-h-11 py-2 px-2 rounded-lg text-sm font-semibold text-white transition-colors disabled:opacity-60 [overflow-wrap:anywhere] ${
                        mode === "dispense" ? "bg-red-600 hover:bg-red-700" : "bg-green-700 hover:bg-green-800"
                      }`}
                    >
                      {processing
                        ? "Processing..."
                        : mode === "dispense"
                        ? `Dispense ${unitsToRecord(quantity)} ${phase.medication.unit}`
                        : `Receive ${unitsToRecord(quantity)} ${phase.medication.unit}`}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {scanMode === "quick" && (
            <p className="text-center text-xs text-gray-600 mt-2 mb-1">
              Each scan {mode === "dispense" ? "subtracts" : "adds"} 1 unit instantly — no confirmation needed
            </p>
          )}

          <p className="text-center text-xs text-gray-600 mt-5">
            Physical scanner works anywhere on this page — no need to click first
          </p>
        </div>
      )}

      {/* ── INVENTORY TAB ── */}
      {tab === "inventory" && (
        <InventoryTab
          status={loadStatus}
          errorMessage={loadError}
          medications={medications}
          categories={categories}
          categoriesError={categoriesError}
          refreshError={refreshError}
          refreshing={refreshing}
          view={view}
          onViewChange={setView}
          onRetry={retryInventory}
          onScan={goToScan}
        />
      )}
    </div>
  );
}

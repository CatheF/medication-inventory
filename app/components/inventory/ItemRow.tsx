"use client";

import { memo } from "react";
import type { Medication } from "@/lib/db";
import { ItemThumb } from "../ItemThumb";
import { BarcodeGlyph, CheckIcon, CircleXIcon, ExternalLinkIcon, TagIcon, WarnIcon } from "./Icons";
import { displayName, safeHttpUrl, stockStatus, type CategoryKind, type StockStatus } from "./helpers";

type ItemRowProps = {
  item: Medication;
  categoryKind: CategoryKind;
  categoryTitle: string;
  /** True when the item is on the order sheet. */
  checked: boolean;
  onToggle: (id: number) => void;
};

const PILL: Record<StockStatus, { label: string; className: string }> = {
  out: { label: "Out", className: "border-red-200 bg-red-100 text-red-800" },
  low: { label: "Low", className: "border-amber-200 bg-amber-100 text-amber-800" },
  ok: { label: "OK", className: "border-green-200 bg-green-100 text-green-800" },
};

// Names and units are free text: a long unbroken word must wrap inside its box, not push the row wider.
const TAG = "inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border px-2 text-[13px] leading-5 [overflow-wrap:anywhere]";

// The app loads only the proportional font (Geist), so Tailwind's `font-mono` has nothing to resolve to. Barcodes and
// supplier order numbers are read character by character (0 vs O, 1 vs l), so they get a real system monospace stack.
const MONO = "[font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation_Mono',monospace]";

function StatusPill({ status, id }: { status: StockStatus; id: number }) {
  const { label, className } = PILL[status];
  return (
    <span
      data-testid={`stock-status-${id}`}
      data-status={status}
      className={`inline-flex items-center gap-1 rounded-full border py-px pl-2 pr-2.5 text-[13px] font-bold leading-5 whitespace-nowrap ${className}`}
    >
      {status === "out" ? <CircleXIcon className="h-3.5 w-3.5" /> : status === "low" ? <WarnIcon className="h-3.5 w-3.5" /> : <CheckIcon className="h-3.5 w-3.5" />}
      {label}
    </span>
  );
}

function CategoryTag({ kind, title }: { kind: CategoryKind; title: string }) {
  if (kind === "category") {
    // The sr-only label is a sibling (not inside the tag) so the tag's own text stays exactly the category name.
    return (
      <>
        <span className="sr-only">Category: </span>
        <span className={`${TAG} border-blue-200 bg-blue-50 font-semibold text-blue-800`}>{title}</span>
      </>
    );
  }
  if (kind === "unknown") {
    return (
      <span className={`${TAG} border-dashed border-amber-500 bg-amber-50 font-semibold text-amber-900`}>
        <WarnIcon className="h-3 w-3" />
        {title}
      </span>
    );
  }
  return <span className={`${TAG} border-dashed border-gray-400 font-medium italic text-gray-600`}>{title}</span>;
}

/**
 * One inventory item as a compact row: picture, name, category, the two identifiers (barcode and supplier order
 * number, labelled and styled differently), stock with a status pill, and the "Add to order sheet" checkbox.
 * The layout follows the width of the list (container queries), not the screen: stacked when narrow.
 */
function ItemRowImpl({ item, categoryKind, categoryTitle, checked, onToggle }: ItemRowProps) {
  const name = displayName(item);
  const status = stockStatus(item);
  const supplier = typeof item.supplier_order_number === "string" && item.supplier_order_number.trim() !== "" ? item.supplier_order_number.trim() : null;
  const vendorHref = safeHttpUrl(item.vendor_url);
  const nameId = `item-name-${item.id}`;
  const checkLabelId = `item-order-label-${item.id}`;

  return (
    <li
      data-testid={`item-card-${item.id}`}
      data-on-sheet={checked ? "true" : "false"}
      className={`relative grid grid-cols-[48px_minmax(0,1fr)] gap-x-3 gap-y-2.5 border-t border-gray-200 p-4 first:border-t-0 @min-[480px]:grid-cols-[48px_minmax(0,1fr)_fit-content(240px)] @min-[720px]:grid-cols-[48px_minmax(0,1fr)_260px] ${checked ? "bg-blue-50" : "bg-white"}`}
    >
      <div className="col-start-1 row-span-2 row-start-1 @min-[480px]:row-span-1 @min-[720px]:row-span-2">
        <ItemThumb name={item.name} photoUrl={item.photo_url} size={48} />
      </div>

      <div className="col-start-2 row-start-1 min-w-0">
        <p id={nameId} className="text-base leading-snug font-semibold text-gray-900 [overflow-wrap:anywhere]">
          {name ?? <span className="font-medium italic text-gray-600">Unnamed item</span>}
          {name === null && <span className="sr-only"> (barcode {item.barcode})</span>}
        </p>
        <p className="mt-1.5 flex flex-wrap gap-1.5">
          <CategoryTag kind={categoryKind} title={categoryTitle} />
          {item.is_unnamed && (
            <span className={`${TAG} border-amber-200 bg-amber-100 font-semibold text-amber-800`}>Needs review</span>
          )}
        </p>
      </div>

      <div className="col-start-2 row-start-2 flex flex-wrap items-center gap-x-3 gap-y-1 @min-[480px]:col-start-3 @min-[480px]:row-start-1 @min-[480px]:grid @min-[480px]:justify-items-end @min-[480px]:gap-y-1 @min-[480px]:text-right">
        <p className="min-w-0 text-[15px] text-gray-600 [overflow-wrap:anywhere]">
          <span className="sr-only">Stock: </span>
          <strong className="text-xl font-bold text-gray-900 tabular-nums">{item.stock}</strong> {item.unit}
        </p>
        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 @min-[480px]:justify-end">
          <StatusPill status={status} id={item.id} />
          <span className="text-[13px] text-gray-600">Threshold: {item.threshold}</span>
        </p>
      </div>

      <dl className="col-start-1 col-span-2 row-start-3 flex min-w-0 flex-wrap gap-x-7 gap-y-2.5 @min-[480px]:col-span-3 @min-[480px]:row-start-2 @min-[720px]:col-span-1 @min-[720px]:col-start-2">
        <div className="min-w-0" data-testid={`item-barcode-${item.id}`}>
          <dt className="flex items-center gap-1.5 text-[13px] leading-snug font-bold text-gray-600">
            <BarcodeGlyph />
            Barcode
          </dt>
          <dd className={`mt-0.5 ${MONO} text-[15px] leading-snug break-all text-gray-900`}>{item.barcode}</dd>
        </div>
        <div className="min-w-0" data-testid={`item-supplier-${item.id}`}>
          <dt className="flex items-center gap-1.5 text-[13px] leading-snug font-bold text-teal-700">
            <TagIcon className="h-[15px] w-[15px]" />
            Supplier order no.
          </dt>
          <dd className="mt-0.5 leading-snug">
            {supplier !== null ? (
              <span className={`inline-block max-w-full rounded-md border border-teal-200 bg-teal-50 px-2 ${MONO} text-[15px] break-all text-gray-900`}>
                {supplier}
              </span>
            ) : (
              <span className="text-[15px] italic text-gray-600">Not set</span>
            )}
          </dd>
        </div>
      </dl>

      <div className="col-start-1 col-span-2 row-start-4 flex flex-wrap items-center gap-x-4 gap-y-1 @min-[480px]:col-span-3 @min-[480px]:row-start-3 @min-[720px]:col-span-1 @min-[720px]:col-start-3 @min-[720px]:row-start-2 @min-[720px]:justify-end">
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2.5 rounded-[10px] border border-gray-400 bg-white py-1 pr-4 pl-3 text-[15px] font-semibold text-gray-800 hover:bg-gray-50 has-checked:border-blue-700 has-checked:bg-blue-50 has-checked:text-blue-800 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-blue-700">
          <input
            type="checkbox"
            data-testid={`order-checkbox-${item.id}`}
            checked={checked}
            onChange={() => onToggle(item.id)}
            aria-labelledby={`${checkLabelId} ${nameId}`}
            className="h-5 w-5 shrink-0 cursor-pointer accent-blue-700 focus:outline-none"
          />
          <span id={checkLabelId}>Add to order sheet</span>
        </label>
        {vendorHref !== null && (
          <a
            href={vendorHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Order from vendor for ${name ?? `unnamed item ${item.barcode}`} (opens in a new tab)`}
            className="inline-flex min-h-10 items-center gap-1 rounded px-1 text-sm font-medium text-blue-700 underline underline-offset-2 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
          >
            Order from vendor
            <ExternalLinkIcon className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </li>
  );
}

export const ItemRow = memo(ItemRowImpl);

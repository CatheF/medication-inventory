import { memo } from "react";
import type { Ref } from "react";
import type { SheetRow, SheetRowInput } from "@/lib/order-sheet/types";
import { ORDER_SHEET_LIMITS } from "@/lib/order-sheet/types";
import { qtyProblem } from "./format";
import { TrashIcon, WarnIcon } from "./icons";
import { LimitNote, atLimit } from "./LimitNote";
import { BTN_DANGER, INPUT, INPUT_INVALID } from "./ui";

// The builder: one row per item on the sheet, in the order they were added. Staff type the order quantity and the
// order unit; both start EMPTY and are never prefilled or calculated. The on-hand stock is a separate, read-only
// value. Below 1024px each row is a card; from 1024px up the rows line up as a table under one header row.

// The quantity column (3rd) is 7.5rem: the largest valid quantity has 9 digits, and at text-base they need about 109px
// inside the box (digits + 12px padding on each side + border). 6.5rem cut the last digit off.
const GRID = "lg:grid-cols-[minmax(0,1fr)_9rem_7.5rem_8.5rem_7rem_6.5rem]";

type SheetRowsProps = {
  /** What is in the draft, in order (includes items that no longer exist; each may carry the item's last known name) */
  rows: readonly SheetRowInput[];
  /** The joined rows, by item id (items that no longer exist are not in here) */
  details: ReadonlyMap<number, SheetRow>;
  showBarcode: boolean;
  /** The row to highlight for a moment (an item that was added again) */
  flashId: number | null;
  listRef: Ref<HTMLUListElement>;
  onQty: (id: number, value: string) => void;
  onUnit: (id: number, value: string) => void;
  onRemove: (id: number, name: string) => void;
};

const ROW_BASE =
  "rounded-lg border p-3 outline-none focus:ring-2 focus:ring-blue-600 " +
  "grid grid-cols-2 gap-x-3 gap-y-3 lg:items-start";

const MISSING_ROW =
  "flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 outline-none " +
  "focus:ring-2 focus:ring-blue-600 sm:flex-row sm:items-center sm:justify-between";

export function SheetRows({ rows, details, showBarcode, flashId, listRef, onQty, onUnit, onRemove }: SheetRowsProps) {
  return (
    <div>
      <div
        aria-hidden="true"
        className={`hidden gap-3 px-[13px] pb-2 text-sm font-semibold text-gray-700 lg:grid ${GRID}`}
      >
        <span>Item</span>
        <span>Supplier order no.</span>
        <span>Order quantity</span>
        <span>Order unit</span>
        <span>On hand now</span>
        <span />
      </div>
      <ul role="list" ref={listRef} className="space-y-3">
        {rows.map((row) => {
          const info = details.get(row.id);
          if (!info) return <MissingRow key={row.id} id={row.id} name={row.name} onRemove={onRemove} />;
          return (
            <RowEditor
              key={row.id}
              id={row.id}
              qty={row.qty}
              unit={row.unit}
              name={info.name}
              nameIsFallback={info.nameIsFallback}
              supplier={info.supplierOrderNumber}
              barcode={info.barcode}
              onHand={`${info.onHand} ${info.stockUnit}`.trim()}
              showBarcode={showBarcode}
              flash={flashId === row.id}
              onQty={onQty}
              onUnit={onUnit}
              onRemove={onRemove}
            />
          );
        })}
      </ul>
    </div>
  );
}

/**
 * A row whose item is no longer in the inventory. It says WHICH item it was when the draft remembers the name ("Cetirizine
 * 10 mg, tablets - no longer in inventory"); without a remembered name (the item was ticked on the Inventory tab and deleted
 * before this page ever read it) it falls back to the item number. Either way it is not in the preview, the print-out or the
 * Excel file, and it can be removed. The name is plain text (React escapes it) and is never sent anywhere.
 */
const MissingRow = memo(function MissingRow({
  id,
  name,
  onRemove,
}: {
  id: number;
  name: string | undefined;
  onRemove: (id: number, name: string) => void;
}) {
  const knownName = typeof name === "string" && name.trim() !== "" ? name : null;
  return (
    <li tabIndex={-1} data-testid={`sheet-row-${id}`} data-row-id={id} className={MISSING_ROW}>
      <div className="flex min-w-0 items-start gap-2 text-sm text-amber-900">
        <WarnIcon className="mt-0.5 h-4 w-4 shrink-0" />
        {knownName !== null ? (
          <p className="min-w-0">
            <span className="font-semibold wrap-anywhere">{knownName} - no longer in inventory.</span> It is not in the preview,
            the print-out or the Excel file.
          </p>
        ) : (
          <p className="min-w-0">
            <span className="font-semibold">No longer in inventory.</span> Item no. {id} is not in the preview, the print-out or
            the Excel file.
          </p>
        )}
      </div>
      <div className="flex justify-end">
        <RemoveButton id={id} name={knownName ?? `missing item ${id}`} onRemove={onRemove} />
      </div>
    </li>
  );
});

type RowEditorProps = {
  id: number;
  /** What was typed (never normalized here) */
  qty: string;
  unit: string;
  name: string;
  nameIsFallback: boolean;
  supplier: string | null;
  barcode: string;
  /** "18 units": the read-only current stock, kept apart from the typed quantity and unit */
  onHand: string;
  showBarcode: boolean;
  flash: boolean;
  onQty: (id: number, value: string) => void;
  onUnit: (id: number, value: string) => void;
  onRemove: (id: number, name: string) => void;
};

// Props are primitives and stable callbacks, so React skips every row except the one being typed in.
const RowEditor = memo(function RowEditor({
  id,
  qty,
  unit,
  name,
  nameIsFallback,
  supplier,
  barcode,
  onHand,
  showBarcode,
  flash,
  onQty,
  onUnit,
  onRemove,
}: RowEditorProps) {
  const problem = qtyProblem(qty);
  const errorId = `qty-error-${id}`;
  const unitNoteId = `unit-limit-note-${id}`;
  const tone = flash ? "border-amber-400 bg-amber-50 ring-2 ring-amber-300" : "border-gray-200 bg-white";
  return (
    <li tabIndex={-1} data-testid={`sheet-row-${id}`} data-row-id={id} className={`${ROW_BASE} ${GRID} ${tone}`}>
      <div className="order-1 col-span-2 min-w-0 lg:order-none lg:col-span-1 lg:py-2.5">
        <p className={`font-medium wrap-anywhere ${nameIsFallback ? "text-gray-700 italic" : "text-gray-900"}`}>{name}</p>
        {showBarcode ? (
          <p className="mt-0.5 text-xs text-gray-600 wrap-anywhere">
            Barcode <span className="sheet-mono">{barcode}</span>
          </p>
        ) : null}
      </div>

      <div className="order-2 min-w-0 lg:order-none lg:py-2.5">
        <p className="text-xs font-medium text-gray-600 lg:sr-only">Supplier order no.</p>
        {supplier === null ? (
          <p className="inline-flex items-center gap-1 text-sm font-medium text-amber-800">
            <WarnIcon className="h-4 w-4" />
            Not set
          </p>
        ) : (
          <p className="sheet-mono text-sm text-gray-900 wrap-anywhere">{supplier}</p>
        )}
      </div>

      <div className="order-4 min-w-0 lg:order-none">
        <label htmlFor={`qty-${id}`} className="mb-1 block text-xs font-medium text-gray-700 lg:sr-only">
          Order quantity
        </label>
        <input
          id={`qty-${id}`}
          data-testid={`qty-input-${id}`}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          // No maxLength: a box that silently drops the digits after the ninth would turn a pasted 12-digit number into a
          // different, valid-looking quantity. The box keeps what was typed and the message under it names the limit.
          value={qty}
          onChange={(event) => onQty(id, event.target.value)}
          aria-label={`Order quantity for ${name}`}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? errorId : undefined}
          className={problem ? INPUT_INVALID : INPUT}
        />
        {/* role="alert": the message appears while the person types, so it is announced without moving focus. */}
        {problem ? (
          <p id={errorId} role="alert" className="mt-1 flex items-start gap-1 text-xs font-medium text-red-700">
            <WarnIcon className="mt-px h-3.5 w-3.5" />
            <span>{problem}</span>
          </p>
        ) : null}
      </div>

      <div className="order-5 min-w-0 lg:order-none">
        <label htmlFor={`unit-${id}`} className="mb-1 block text-xs font-medium text-gray-700 lg:sr-only">
          Order unit
        </label>
        <input
          id={`unit-${id}`}
          data-testid={`unit-input-${id}`}
          type="text"
          autoComplete="off"
          maxLength={ORDER_SHEET_LIMITS.unit}
          placeholder="e.g. box, case"
          value={unit}
          onChange={(event) => onUnit(id, event.target.value)}
          aria-label={`Order unit for ${name}`}
          aria-describedby={atLimit(unit, ORDER_SHEET_LIMITS.unit) ? unitNoteId : undefined}
          className={INPUT}
        />
        <LimitNote id={unitNoteId} testId={`unit-limit-${id}`} value={unit} limit={ORDER_SHEET_LIMITS.unit} compact />
      </div>

      <div className="order-3 min-w-0 self-center text-sm text-gray-600 lg:order-none lg:self-start lg:py-2.5">
        <span className="lg:sr-only">On hand now: </span>
        <span className="inline-block max-w-full wrap-anywhere">{onHand}</span>
      </div>

      <div className="order-6 col-span-2 flex justify-end lg:order-none lg:col-span-1">
        <RemoveButton id={id} name={name} onRemove={onRemove} />
      </div>
    </li>
  );
});

function RemoveButton({ id, name, onRemove }: { id: number; name: string; onRemove: (id: number, name: string) => void }) {
  return (
    <button
      type="button"
      data-remove=""
      data-testid={`remove-row-${id}`}
      aria-label={`Remove ${name} from the order sheet`}
      onClick={() => onRemove(id, name)}
      className={BTN_DANGER}
    >
      <TrashIcon className="h-4 w-4" />
      Remove
    </button>
  );
}

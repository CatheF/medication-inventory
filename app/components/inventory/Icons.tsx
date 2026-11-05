// Small inline icons for the Inventory tab. Decorative only: every one is aria-hidden, the words next to it carry
// the meaning. (No icon library: the app has none and this keeps the bundle unchanged.)

import type { ReactNode } from "react";

type IconProps = { className?: string };

function Svg({ className = "h-4 w-4", children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={`shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <polyline points="20 6 9 17 4 12" />
    </Svg>
  );
}

export function ChevronIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <polyline points="6 9 12 15 18 9" />
    </Svg>
  );
}

export function SearchIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </Svg>
  );
}

export function WarnIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </Svg>
  );
}

export function CircleXIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </Svg>
  );
}

export function InfoIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </Svg>
  );
}

export function InboxIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </Svg>
  );
}

/** Price-tag shape: the "Supplier order no." marker (a different shape and colour from the barcode glyph). */
export function TagIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </Svg>
  );
}

export function ExternalLinkIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </Svg>
  );
}

/** Barcode glyph: the "Barcode" marker (vertical bars, filled, so it cannot be mistaken for the tag). */
export function BarcodeGlyph({ className = "h-3 w-[17px]" }: IconProps) {
  return (
    <svg
      className={`shrink-0 ${className}`}
      viewBox="0 0 18 12"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="0" width="2" height="12" />
      <rect x="3" width="1" height="12" />
      <rect x="5" width="3" height="12" />
      <rect x="9" width="1" height="12" />
      <rect x="11" width="2" height="12" />
      <rect x="14" width="1" height="12" />
      <rect x="16" width="2" height="12" />
    </svg>
  );
}

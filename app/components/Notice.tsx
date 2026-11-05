"use client";

import type { ReactNode, Ref } from "react";

export type NoticeTone = "error" | "success" | "info" | "warning";

type NoticeProps = {
  tone: NoticeTone;
  title?: string;
  children?: ReactNode;
  /** Shows a "Try again" button. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Shows a "Dismiss" button. */
  onDismiss?: () => void;
  /** Override the live-region role. Defaults: error → "alert", everything else → "status". */
  role?: "alert" | "status";
  className?: string;
  "data-testid"?: string;
  /** Forward a ref so callers can move keyboard focus to the message after a failed action. */
  ref?: Ref<HTMLDivElement>;
};

const TONES: Record<NoticeTone, { box: string; icon: string; label: string }> = {
  error: { box: "bg-red-50 text-red-800 border-red-200", icon: "text-red-600", label: "Error" },
  success: { box: "bg-green-50 text-green-800 border-green-200", icon: "text-green-600", label: "Success" },
  info: { box: "bg-blue-50 text-blue-800 border-blue-200", icon: "text-blue-600", label: "Note" },
  warning: { box: "bg-amber-50 text-amber-900 border-amber-300", icon: "text-amber-600", label: "Warning" },
};

function ToneIcon({ tone }: { tone: NoticeTone }) {
  const common = { className: "h-5 w-5 shrink-0", fill: "none", stroke: "currentColor", strokeWidth: 2, viewBox: "0 0 24 24", "aria-hidden": true } as const;
  if (tone === "success") {
    return (
      <svg {...common}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (tone === "info") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path strokeLinecap="round" d="M12 11v5M12 8h.01" />
      </svg>
    );
  }
  // error + warning share a triangle so the meaning never depends on color alone
  return (
    <svg {...common}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4l9 16H3L12 4z" />
      <path strokeLinecap="round" d="M12 10v4M12 17h.01" />
    </svg>
  );
}

/**
 * Inline message used for errors, confirmations and hints. Errors are announced immediately (role="alert");
 * the others are polite live regions. The container is focusable programmatically (tabIndex -1) so a failed
 * save can move focus here.
 *
 * Layout: [icon + message] and the buttons. The message never gets squeezed by the buttons: when the box is narrower
 * than the message's preferred width plus the buttons (a phone), the buttons wrap onto their own row under the message
 * text. The icon and the message are one flex item, so in a very narrow box the message stays beside its icon (it just
 * gets narrower) and only the buttons ever wrap. Keep that order: callers reach the first <div> child (icon + message)
 * through `className`.
 */
export function Notice({
  tone,
  title,
  children,
  onRetry,
  retryLabel = "Try again",
  onDismiss,
  role,
  className = "",
  ref,
  ...rest
}: NoticeProps) {
  const t = TONES[tone];
  return (
    <div
      ref={ref}
      role={role ?? (tone === "error" ? "alert" : "status")}
      tabIndex={-1}
      data-testid={rest["data-testid"]}
      className={`flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${t.box} ${className}`}
    >
      {/* basis-64 = icon (20px) + gap (12px) + a 14rem message: when the box is narrower than that plus the buttons, the buttons
          wrap under the message. The group itself can still shrink (min-w-0), so a very narrow box just gets a narrower message. */}
      <div className="flex min-w-0 grow basis-64 items-start gap-3">
        <span className={`shrink-0 ${t.icon}`}>
          <ToneIcon tone={tone} />
          <span className="sr-only">{t.label}: </span>
        </span>
        {/* Titles and messages can carry free text (item names, barcodes, server errors): an unbroken word wraps inside the
            box instead of pushing the page wider. */}
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {title && <p className="font-semibold [overflow-wrap:anywhere]">{title}</p>}
          {children && <div className={title ? "mt-0.5" : undefined}>{children}</div>}
        </div>
      </div>
      {(onRetry || onDismiss) && (
        // ml-8 = icon (20px) + gap (12px): on its own row the buttons line up under the message text, not under the icon.
        <div className="ml-8 flex shrink-0 flex-wrap gap-2 self-center">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="min-h-11 rounded-md border border-current px-4 text-sm font-semibold hover:bg-white/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              {retryLabel}
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="min-h-11 rounded-md px-3 text-sm font-medium underline hover:bg-white/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}

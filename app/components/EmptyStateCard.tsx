import type { ReactNode } from "react";
import Link from "next/link";

/** One button of the card. With `href` it is a link (next/link), otherwise a button that calls `onClick`. */
export type EmptyAction = { label: string; href?: string; onClick?: () => void; ariaLabel?: string; testId?: string };

export type EmptyIcon = "box" | "search" | "folder" | "list" | "cart";

type EmptyStateCardProps = {
  icon: EmptyIcon;
  title: string;
  /** Plain text becomes a paragraph; anything richer (a list, several paragraphs) is placed in a block. */
  description?: ReactNode;
  primaryAction?: EmptyAction;
  secondaryAction?: EmptyAction;
  /** Level of the title heading (default 3). Pick the one that keeps the page's headings in order. */
  headingLevel?: 2 | 3 | 4;
  testId?: string;
  className?: string;
  /** Extra content between the description and the buttons. */
  children?: ReactNode;
};

// Simple outline icons on a 24px grid, drawn for this card (no icon library). Decorative: the heading says it all.
function IconShape({ icon }: { icon: EmptyIcon }) {
  switch (icon) {
    case "box": // a closed cardboard box (inventory)
      return (
        <>
          <path d="M12 2.8l8.2 4.6v9.2L12 21.2l-8.2-4.6V7.4L12 2.8z" />
          <path d="M3.8 7.4L12 12l8.2-4.6" />
          <path d="M12 12v9.2" />
        </>
      );
    case "search": // a magnifier
      return (
        <>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.4 15.4L21 21" />
        </>
      );
    case "folder": // a category folder
      return <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.1a1.5 1.5 0 0 1 1.1.5L11.2 7h8.3A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11z" />;
    case "list": // a clipboard with lines
      return (
        <>
          <rect x="5" y="4.2" width="14" height="16.8" rx="2" />
          <rect x="8.6" y="2.4" width="6.8" height="3.8" rx="1.2" />
          <path d="M8.8 11h.01M11.8 11h3.6M8.8 15h.01M11.8 15h3.6" />
        </>
      );
    case "cart": // a shopping cart (the order sheet)
      return (
        <>
          <path d="M2.5 3.5h2.4l2.3 11h10.5l2-7.8H5.6" />
          <circle cx="9.6" cy="19.2" r="1.4" />
          <circle cx="16.8" cy="19.2" r="1.4" />
        </>
      );
  }
}

const BUTTON =
  "inline-flex min-h-11 w-full items-center justify-center rounded-[10px] px-5 py-2 text-center text-base font-semibold [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 min-[400px]:w-auto";
const PRIMARY = `${BUTTON} bg-blue-700 text-white hover:bg-blue-800`;
const SECONDARY = `${BUTTON} border border-gray-400 bg-white text-gray-800 hover:bg-gray-50`;

function ActionButton({ action, className }: { action: EmptyAction; className: string }) {
  if (action.href !== undefined) {
    return (
      <Link href={action.href} onClick={action.onClick} aria-label={action.ariaLabel} data-testid={action.testId} className={className}>
        {action.label}
      </Link>
    );
  }
  return (
    <button type="button" onClick={action.onClick} aria-label={action.ariaLabel} data-testid={action.testId} className={className}>
      {action.label}
    </button>
  );
}

/**
 * The "nothing here" card: a soft gray circle with a decorative icon, a heading, an optional explanation, and up to
 * two buttons (a filled primary one and a white secondary one) that say what to do next.
 *
 * It is static content. It is not a live region and not an alert: a screen that wants a result announced (for example
 * "No items match") does that itself, once, in its own status line.
 *
 * Text never overflows: long titles, descriptions and button labels wrap (overflow-wrap:anywhere). Below 400px the buttons
 * stack at full width; from 400px they sit side by side (primary first) and wrap again if they do not fit.
 * An action with `href` is a Next.js Link, anything else is a <button type="button">. (No "use client" here: a Server
 * Component may render the card with `href` actions; an `onClick` can only be given from a Client Component.)
 */
export function EmptyStateCard({
  icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  headingLevel = 3,
  testId,
  className = "",
  children,
}: EmptyStateCardProps) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const hasDescription = description !== undefined && description !== null && description !== false && description !== "";
  const descriptionClass = "mx-auto mt-1.5 max-w-[52ch] text-base text-gray-600 [overflow-wrap:anywhere]";
  const plainText = typeof description === "string" || typeof description === "number";

  return (
    <div
      data-testid={testId}
      className={`rounded-xl border border-dashed border-gray-300 bg-white px-4 py-10 text-center sm:px-8 ${className}`}
    >
      <div aria-hidden="true" className="mx-auto mb-4 grid h-[72px] w-[72px] place-items-center rounded-full bg-gray-100 text-gray-500">
        <svg
          viewBox="0 0 24 24"
          className="h-10 w-10"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          focusable="false"
        >
          <IconShape icon={icon} />
        </svg>
      </div>
      <Heading className="text-lg leading-snug font-bold text-gray-900 [overflow-wrap:anywhere]">{title}</Heading>
      {hasDescription && (plainText ? <p className={descriptionClass}>{description}</p> : <div className={descriptionClass}>{description}</div>)}
      {children}
      {(primaryAction || secondaryAction) && (
        <div className="mt-6 flex flex-col gap-3 min-[400px]:flex-row min-[400px]:flex-wrap min-[400px]:items-center min-[400px]:justify-center">
          {primaryAction && <ActionButton action={primaryAction} className={PRIMARY} />}
          {secondaryAction && <ActionButton action={secondaryAction} className={SECONDARY} />}
        </div>
      )}
    </div>
  );
}

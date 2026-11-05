"use client";

import type { EmptyKind } from "@/lib/inventory-view";
import { EmptyStateCard, type EmptyAction, type EmptyIcon } from "../EmptyStateCard";

type EmptyStateProps = {
  kind: EmptyKind;
  title: string;
  detail: string;
  /** no-match: puts search, stock level and category back to "everything" (sort and grouping stay). */
  onClearFilters: () => void;
  /** category-empty: drops the category filter (and only that: nothing else is on). */
  onShowAll: () => void;
  /** no-items: switches to the Scan tab. */
  onScan: () => void;
};

type Plan = { icon: EmptyIcon; primary: EmptyAction; secondary?: EmptyAction };

/**
 * The three different "nothing to show" cases, kept visibly apart, each with a picture and the next step:
 *   no-items        the inventory itself is empty            -> "Add an item" (Admin), "Scan a barcode" (Scan tab)
 *   category-empty  the chosen category holds no items       -> "Show all items", "Add items in Admin"
 *   no-match        the search / stock / category filters match nothing -> "Clear filters"
 * The words come from describeEmpty() in lib/inventory-view.ts. The card is static: the summary line above the list is
 * the live region that announces that nothing matched. data-testid and data-empty-kind sit on a wrapper around the card.
 */
export function EmptyState({ kind, title, detail, onClearFilters, onShowAll, onScan }: EmptyStateProps) {
  const plan: Plan =
    kind === "no-items"
      ? {
          icon: "box",
          primary: { label: "Add an item", href: "/admin", testId: "inventory-empty-add" },
          secondary: { label: "Scan a barcode", onClick: onScan, testId: "inventory-empty-scan" },
        }
      : kind === "category-empty"
        ? {
            icon: "folder",
            primary: { label: "Show all items", onClick: onShowAll, testId: "inventory-empty-show-all" },
            secondary: { label: "Add items in Admin", href: "/admin", testId: "inventory-empty-admin" },
          }
        : {
            icon: "search",
            primary: { label: "Clear filters", onClick: onClearFilters, testId: "inventory-empty-clear" },
          };

  return (
    <div data-testid="inventory-empty" data-empty-kind={kind}>
      <EmptyStateCard
        icon={plan.icon}
        title={title}
        description={detail}
        primaryAction={plan.primary}
        secondaryAction={plan.secondary}
        headingLevel={3}
      />
    </div>
  );
}

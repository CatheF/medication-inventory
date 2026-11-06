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
 *   category-empty  the chosen category holds no items       -> "Show all items", "Assign items in Admin"
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
            // Named like the sentence above it ("Assign items to this category from the Admin page."): the Admin page is where
            // an existing item is put into a category, so "Add items" would promise something else.
            secondary: { label: "Assign items in Admin", href: "/admin", testId: "inventory-empty-admin" },
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
      >
        {kind === "no-items" ? (
          // An empty answer can also mean the app is looking at the wrong database or that the database is hiding the rows,
          // so do not only say "create the first item".
          <p className="mt-2 text-sm text-gray-600">
            Expecting items here? Make sure the app is connected to the right database before you add anything new.
          </p>
        ) : null}
      </EmptyStateCard>
    </div>
  );
}

// Markup-level test of the Inventory "nothing to show" card, rendered on the server (no browser needed).
// The card has three different cases. Only the first one (the inventory itself is empty) adds the sentence that points at the
// database connection: an empty answer can also mean the app is looking at the wrong project, or that the database is hiding
// the rows, and staff should not start re-creating items before they have ruled that out. The other two cases are explained
// completely by the filters, so the sentence would only confuse there.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState } from "@/app/components/inventory/EmptyState";
import { DEFAULT_VIEW, describeEmpty, type EmptyKind } from "@/lib/inventory-view";

const HINT = "Make sure the app is connected to the right database before you add anything new.";

function render(kind: EmptyKind): string {
  const noop = () => undefined;
  const empty =
    kind === "no-items"
      ? describeEmpty(0, DEFAULT_VIEW, [])
      : kind === "category-empty"
        ? { kind, title: "No items in Empty shelf yet.", detail: "Assign items to this category from the Admin page." }
        : { kind, title: "No items match your search.", detail: "Try a different word, or clear the filters." };
  return renderToStaticMarkup(createElement(EmptyState, { kind, title: empty.title, detail: empty.detail, onClearFilters: noop, onShowAll: noop, onScan: noop }));
}

describe("Inventory empty state: the database-connection hint", () => {
  it("is shown when the inventory has no items at all, together with both ways to add one", () => {
    const html = render("no-items");
    expect(html).toContain(HINT);
    expect(html).toContain("Expecting items here?");
    expect(html).toContain("Add an item");
    expect(html).toContain("Scan a barcode");
  });

  it("sits between the explanation and the buttons, so it is read before someone adds a duplicate", () => {
    const html = render("no-items");
    const hint = html.indexOf(HINT);
    expect(html.indexOf("Use ")).toBeGreaterThan(-1);
    expect(hint).toBeGreaterThan(html.indexOf("to create the first item"));
    expect(hint).toBeLessThan(html.indexOf("Add an item"));
  });

  it.each<EmptyKind>(["category-empty", "no-match"])("is not shown for %s, which the filters explain completely", (kind) => {
    const html = render(kind);
    expect(html).not.toContain("right database");
    expect(html).not.toContain("Expecting items here?");
  });
});

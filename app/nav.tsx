"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useOrderDraft } from "@/lib/order-sheet/use-order-draft";

// Every link and button in the bar is at least 40px tall (the bar itself stays one 56px row on wide screens: min-h-14 below,
// with the 40px links centred in it).
const TARGET = "inline-flex min-h-10 items-center whitespace-nowrap";

export function NavBar() {
  const pathname = usePathname();
  // Number of items on the order sheet draft (kept in this browser). Read before the early return: hooks must always run.
  const { count } = useOrderDraft();
  if (pathname?.startsWith("/kiosk")) return null;

  return (
    <nav className="bg-blue-800 text-white shadow-md print:hidden">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* One wrapping flex row. Wide screens: a single row, the name on the left and the links pushed to the right (sm:mr-auto on
            the name). Phones: the name and the first links share the first row, the rest wrap onto a second one, so 40px tall
            links do not make a three-row bar and nothing runs off the screen. */}
        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 min-h-14 py-1 sm:py-0">
          <Link href="/" className={`${TARGET} mr-3 sm:mr-auto font-bold text-lg tracking-tight`}>
            MedInventory
          </Link>
          {/* No highlight for "/": the home page holds both the Scan and the Inventory tab and the nav cannot tell which one is
              showing (the tab control right below it does), so marking "Scan" as the current page would be wrong half the time. */}
          <NavLink href="/">Scan</NavLink>
          <NavLink href="/admin" current={pathname === "/admin"}>
            Admin
          </NavLink>
          <NavLink href="/usage" current={pathname === "/usage"}>
            Usage
          </NavLink>
          <NavLink href="/order-sheet" current={pathname === "/order-sheet"}>
            Order sheet
            {count > 0 && (
              <>
                <span
                  aria-hidden="true"
                  className="ml-1.5 inline-block min-w-5 rounded-full bg-white px-1.5 text-center text-xs font-semibold leading-5 text-blue-800"
                >
                  {count}
                </span>
                <span className="sr-only"> ({count} {count === 1 ? "item" : "items"})</span>
              </>
            )}
          </NavLink>
          <a
            href="/kiosk"
            className={`${TARGET} ml-2 px-3 rounded text-sm font-medium bg-blue-600 hover:bg-blue-500 transition-colors border border-blue-500`}
          >
            Kiosk Mode
          </a>
        </div>
      </div>
    </nav>
  );
}

function NavLink({
  href,
  current,
  children,
}: {
  href: string;
  /** True for the link of the page being shown: marks it for screen readers (aria-current) and gives it the highlight color. */
  current?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={`${TARGET} px-3 rounded text-sm font-medium hover:bg-blue-700 transition-colors${current ? " bg-blue-700" : ""}`}
    >
      {children}
    </Link>
  );
}

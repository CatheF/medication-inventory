"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";

export function NavBar() {
  const pathname = usePathname();
  if (pathname?.startsWith("/kiosk")) return null;

  return (
    <nav className="bg-blue-800 text-white shadow-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-14">
          <Link href="/" className="font-bold text-lg tracking-tight">
            MedInventory
          </Link>
          <div className="flex items-center gap-1">
            <NavLink href="/">Scan</NavLink>
            <NavLink href="/admin">Admin</NavLink>
            <NavLink href="/usage">Usage</NavLink>
            <a
              href="/kiosk"
              className="ml-2 px-3 py-1.5 rounded text-sm font-medium bg-blue-600 hover:bg-blue-500 transition-colors border border-blue-500"
            >
              Kiosk Mode
            </a>
          </div>
        </div>
      </div>
    </nav>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="px-3 py-1.5 rounded text-sm font-medium hover:bg-blue-700 transition-colors"
    >
      {children}
    </Link>
  );
}

import type { Metadata } from "next";
import { Geist } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geist = Geist({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "MedInventory — University Health",
  description: "Medication inventory tracking for university health department",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${geist.className} bg-gray-50 min-h-screen`}>
        <nav className="bg-blue-800 text-white shadow-md">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-14">
              <Link href="/" className="font-bold text-lg tracking-tight">
                MedInventory
              </Link>
              <div className="flex gap-1">
                <NavLink href="/">Dashboard</NavLink>
                <NavLink href="/scanner">Scanner</NavLink>
                <NavLink href="/admin">Admin</NavLink>
                <NavLink href="/report">Daily Report</NavLink>
              </div>
            </div>
          </div>
        </nav>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">{children}</main>
      </body>
    </html>
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

import type { Metadata } from "next";

// The page itself is a client component (it reads the browser-side draft), so its tab title is set here.
export const metadata: Metadata = {
  title: "Order sheet — MedInventory",
};

export default function OrderSheetLayout({ children }: { children: React.ReactNode }) {
  return children;
}

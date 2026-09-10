import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Nav } from "@/components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "PolyAlpha",
  description: "Read-only Polymarket smart-money intelligence",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-bg font-sans text-fg antialiased">
        <Nav />
        <main className="mx-auto w-full max-w-terminal px-3 py-5 sm:px-5 lg:px-6">{children}</main>
      </body>
    </html>
  );
}

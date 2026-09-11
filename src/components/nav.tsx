"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui/primitives";

const LINKS = [
  { href: "/", label: "OPPORTUNITIES" },
  { href: "/cash-soon", label: "CASH SOON" },
  { href: "/sports", label: "SPORTS" },
  { href: "/bets", label: "MY BETS" },
  { href: "/alerts", label: "ALERTS" },
  { href: "/plan", label: "PLAN" },
  { href: "/smart-money", label: "SMART MONEY" },
  { href: "/traders", label: "TRADERS" },
  { href: "/activity", label: "ACTIVITY" },
  { href: "/backtest", label: "BACKTEST" },
  { href: "/settings", label: "SETTINGS" },
] as const;

const READ_ONLY_TITLE = "Analysis only. This app never places trades.";

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({ pathname, className }: { pathname: string; className?: string }) {
  return (
    <div className={cn("no-scrollbar flex items-stretch overflow-x-auto", className)}>
      {LINKS.map((link) => {
        const active = isActive(pathname, link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex shrink-0 items-center px-3 text-2xs font-medium uppercase tracking-caps transition-colors",
              "after:absolute after:inset-x-2 after:bottom-0 after:h-px after:transition-colors",
              active
                ? "text-fg after:bg-accent"
                : "text-muted after:bg-transparent hover:text-fg hover:after:bg-line",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </div>
  );
}

export function Nav() {
  const pathname = usePathname() ?? "/";

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/80">
      <div className="mx-auto w-full max-w-terminal px-3 sm:px-5 lg:px-6">
        <div className="flex h-11 items-center gap-4">
          <Link href="/" className="shrink-0 text-sm font-semibold tracking-tight text-fg">
            Poly<span className="text-accent">Alpha</span>
          </Link>

          <NavLinks pathname={pathname} className="hidden h-11 flex-1 md:flex" />

          <span
            title={READ_ONLY_TITLE}
            className="ml-auto shrink-0 cursor-help rounded border border-line bg-elevated px-2 py-0.5 text-2xs font-medium uppercase tracking-caps text-muted md:ml-0"
          >
            READ ONLY
          </span>
        </div>
      </div>

      {/* Mobile: the same links as a horizontally scrollable second row, no hamburger. */}
      <div className="border-t border-line md:hidden">
        <div className="mx-auto w-full max-w-terminal px-1">
          <NavLinks pathname={pathname} className="h-10" />
        </div>
      </div>
    </header>
  );
}

"use client";

/**
 * Keeps a server-rendered page current without a manual reload.
 *
 * `router.refresh()` re-runs the server components and swaps in new markup, so scroll position,
 * open `<details>` panels and focus all survive — unlike `location.reload()`, which would throw
 * away the page every interval and make the app unusable while reading.
 *
 * Two behaviours worth knowing about:
 *
 *   - Refreshing is skipped while the tab is hidden, and runs once immediately on return. There is
 *     no point querying a hundred thousand activity rows for a tab nobody is looking at.
 *   - The choice is remembered in localStorage, because someone who turns this off is usually
 *     mid-way through reading something and would not want it back on the next navigation.
 *
 * This only re-reads the database. It does not trigger a sync and never contacts Polymarket — see
 * `scripts/auto-sync.ts` for the process that actually refreshes the data.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/primitives";

const STORAGE_KEY = "polyalpha.autorefresh";

function secondsSince(from: number): number {
  return Math.max(0, Math.round((Date.now() - from) / 1000));
}

function describeAge(seconds: number): string {
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function AutoRefresh({ intervalSeconds = 60 }: { intervalSeconds?: number }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState(() => Date.now());
  const [age, setAge] = useState(0);
  const [busy, setBusy] = useState(false);
  const refreshedAtRef = useRef(refreshedAt);
  refreshedAtRef.current = refreshedAt;

  useEffect(() => {
    // Read the stored preference after mount: reading localStorage during render would make the
    // server and client markup disagree.
    if (typeof window === "undefined") return;
    setEnabled(window.localStorage.getItem(STORAGE_KEY) !== "off");
  }, []);

  const refresh = useCallback(() => {
    setBusy(true);
    router.refresh();
    setRefreshedAt(Date.now());
    // router.refresh() resolves when the new tree is applied; this is only the spinner window.
    window.setTimeout(() => setBusy(false), 600);
  }, [router]);

  // Tick the "updated Xs ago" label independently of the refresh interval.
  useEffect(() => {
    const timer = window.setInterval(() => setAge(secondsSince(refreshedAtRef.current)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, intervalSeconds * 1000);

    const onVisible = () => {
      // Coming back to a stale tab should show current data straight away.
      if (
        document.visibilityState === "visible" &&
        secondsSince(refreshedAtRef.current) >= intervalSeconds
      ) {
        refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, intervalSeconds, refresh]);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
    if (next) refresh();
  };

  return (
    <span className="inline-flex items-center gap-2 text-2xs text-dim">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full transition-colors",
          busy ? "animate-pulse bg-accent" : enabled ? "bg-positive/70" : "bg-line",
        )}
      />
      <span suppressHydrationWarning>
        {enabled ? `Auto-updating · read ${describeAge(age)}` : "Auto-update off"}
      </span>
      <button
        type="button"
        onClick={toggle}
        className="underline-offset-2 hover:text-accent hover:underline"
      >
        {enabled ? "pause" : "resume"}
      </button>
      <button
        type="button"
        onClick={refresh}
        className="underline-offset-2 hover:text-accent hover:underline"
      >
        refresh now
      </button>
    </span>
  );
}

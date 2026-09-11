"use client";

/**
 * Filters for the sports slate.
 *
 * The two toggles both default to OFF for the same reason: turning either on floods the page. The
 * placeholder-book toggle exists so the gate is inspectable rather than a black box, and the
 * in-play toggle exists because hiding a market outright would be dishonest — it is still trading,
 * we simply cannot analyse it without a live score feed.
 */
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";
import { cn } from "@/components/ui/primitives";
// Window options live in `../filter-params`, NOT here — see the note in cash-soon/filters.tsx.
import { DEFAULT_SPORTS_WINDOW, SPORTS_WINDOWS } from "../filter-params";

export function SportsFilterBar({
  window,
  includeUntradeable,
  includeInPlay,
  resultCount,
}: {
  window: string;
  includeUntradeable: boolean;
  includeInPlay: boolean;
  resultCount: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const push = useCallback(
    (next: URLSearchParams) => {
      const query = next.toString();
      startTransition(() => router.push(query ? `/sports?${query}` : "/sports", { scroll: false }));
    },
    [router],
  );

  const setParam = (key: string, value: string | null, defaultValue?: string) => {
    const next = new URLSearchParams(params.toString());
    if (value === null || value === defaultValue) next.delete(key);
    else next.set(key, value);
    push(next);
  };

  const active = window !== DEFAULT_SPORTS_WINDOW || includeUntradeable || includeInPlay;

  return (
    <div
      className={cn("space-y-2.5 rounded border border-line bg-panel/40 p-3", pending && "opacity-60")}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-2xs uppercase tracking-caps text-dim">Kicks off within</span>
        {SPORTS_WINDOWS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setParam("window", option.value, DEFAULT_SPORTS_WINDOW)}
            aria-pressed={window === option.value}
            className={cn(
              "rounded border px-2 py-0.5 text-2xs transition-colors",
              window === option.value
                ? "border-accent/50 bg-accent/10 text-accent"
                : "border-line text-muted hover:border-accent/30 hover:text-fg",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-2.5">
        <button
          type="button"
          onClick={() => setParam("props", includeUntradeable ? null : "1")}
          aria-pressed={includeUntradeable}
          className={cn(
            "rounded border px-2 py-0.5 text-2xs transition-colors",
            includeUntradeable
              ? "border-warning/50 bg-warning/10 text-warning"
              : "border-line text-muted hover:border-accent/30 hover:text-fg",
          )}
        >
          Include unquoted prop books
        </button>

        <button
          type="button"
          onClick={() => setParam("live", includeInPlay ? null : "1")}
          aria-pressed={includeInPlay}
          className={cn(
            "rounded border px-2 py-0.5 text-2xs transition-colors",
            includeInPlay
              ? "border-warning/50 bg-warning/10 text-warning"
              : "border-line text-muted hover:border-accent/30 hover:text-fg",
          )}
        >
          Include games already underway
        </button>

        {active ? (
          <button
            type="button"
            onClick={() => push(new URLSearchParams())}
            className="ml-auto text-2xs text-muted underline-offset-2 hover:text-accent hover:underline"
          >
            Clear ({resultCount} shown)
          </button>
        ) : null}
      </div>

      {includeUntradeable ? (
        <p className="text-2xs leading-4 text-warning">
          Unquoted books are now included. Most carry a spread near 96¢ against a couple of dollars
          of depth — they are auto-generated placeholders, not markets anyone can trade.
        </p>
      ) : null}
    </div>
  );
}

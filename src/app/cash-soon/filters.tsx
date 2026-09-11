"use client";

/**
 * Filters for the Cash Soon board.
 *
 * The window here is a SETTLEMENT window, not a market-close window. For sports that difference is
 * real: `endDate` on a game market is kickoff, and capital is not free until the game finishes and
 * the market settles, so this filters on the estimated settlement time instead.
 *
 * State lives in the URL for the same reasons as the Opportunities filters — bookmarkable, back
 * button works, and these are per-look choices rather than standing preferences.
 */
import type { Category } from "@prisma/client";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";
import { cn } from "@/components/ui/primitives";
// Window options live in `../filter-params`, NOT here. That module carries a header explaining
// why: the server page reads `searchParams` and needs the same list this client component renders,
// and a helper exported from a "use client" file cannot be called from the server. Defining them
// here threw "Attempted to call settlementHours() from the server" at request time.
import {
  CATEGORY_LABELS,
  DEFAULT_SETTLEMENT_WINDOW,
  SETTLEMENT_WINDOWS,
} from "../filter-params";
import { FILTERABLE_CATEGORIES } from "@/lib/polymarket/categories";

export function CashSoonFilterBar({
  categories,
  window,
  showNegativeEdge,
  resultCount,
}: {
  categories: Category[];
  window: string;
  showNegativeEdge: boolean;
  resultCount: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const push = useCallback(
    (next: URLSearchParams) => {
      const query = next.toString();
      startTransition(() =>
        router.push(query ? `/cash-soon?${query}` : "/cash-soon", { scroll: false }),
      );
    },
    [router],
  );

  const toggleCategory = (category: Category) => {
    const next = new URLSearchParams(params.toString());
    const selected = new Set(categories);
    if (selected.has(category)) selected.delete(category);
    else selected.add(category);

    if (selected.size === 0) next.delete("category");
    else next.set("category", [...selected].join(","));
    push(next);
  };

  const setWindow = (value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value === DEFAULT_SETTLEMENT_WINDOW) next.delete("window");
    else next.set("window", value);
    push(next);
  };

  const toggleNegativeEdge = () => {
    const next = new URLSearchParams(params.toString());
    if (showNegativeEdge) next.delete("all");
    else next.set("all", "1");
    push(next);
  };

  const active =
    categories.length > 0 || window !== DEFAULT_SETTLEMENT_WINDOW || showNegativeEdge;

  return (
    <div
      className={cn("space-y-2.5 rounded border border-line bg-panel/40 p-3", pending && "opacity-60")}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-2xs uppercase tracking-caps text-dim">Settles within</span>
        {SETTLEMENT_WINDOWS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setWindow(option.value)}
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
        <span className="text-2xs uppercase tracking-caps text-dim">Category</span>
        {FILTERABLE_CATEGORIES.map((category) => {
          const on = categories.includes(category);
          return (
            <button
              key={category}
              type="button"
              onClick={() => toggleCategory(category)}
              aria-pressed={on}
              className={cn(
                "rounded border px-2 py-0.5 text-2xs transition-colors",
                on
                  ? "border-accent/50 bg-accent/10 text-accent"
                  : "border-line text-muted hover:border-accent/30 hover:text-fg",
              )}
            >
              {CATEGORY_LABELS[category]}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-2.5">
        <button
          type="button"
          onClick={toggleNegativeEdge}
          aria-pressed={showNegativeEdge}
          className={cn(
            "rounded border px-2 py-0.5 text-2xs transition-colors",
            showNegativeEdge
              ? "border-warning/50 bg-warning/10 text-warning"
              : "border-line text-muted hover:border-accent/30 hover:text-fg",
          )}
        >
          Include sides the spread has already eaten
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

      <p className="text-2xs leading-4 text-dim">
        Filtered on estimated settlement, not on the market&apos;s close date. For a game market
        those differ: Polymarket&apos;s end date is kickoff, and capital is not free until the game
        has finished and the market settles.
      </p>
    </div>
  );
}

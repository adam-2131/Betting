"use client";

/**
 * Category and resolution-window filters for the Opportunities list.
 *
 * State lives in the URL rather than in React state or in `AppSettings`. Three reasons: a filtered
 * view can be bookmarked and reloaded, the back button behaves the way people expect, and these
 * are per-look choices ("what's resolving today?") rather than standing preferences, so writing
 * them to the settings row would be wrong. The thresholds in Settings remain the baseline; these
 * narrow whatever that baseline returns.
 */
import type { Category } from "@prisma/client";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";
import { cn } from "@/components/ui/primitives";
import { CATEGORY_LABELS, RESOLUTION_WINDOWS } from "./filter-params";

export function OpportunityFilterBar({
  categories,
  window,
  availableCategories,
  resultCount,
}: {
  categories: Category[];
  window: string;
  availableCategories: Array<{ category: Category; count: number }>;
  resultCount: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const push = useCallback(
    (next: URLSearchParams) => {
      const query = next.toString();
      startTransition(() => router.push(query ? `/?${query}` : "/", { scroll: false }));
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
    if (value === "any") next.delete("window");
    else next.set("window", value);
    push(next);
  };

  const active = categories.length > 0 || window !== "any";

  return (
    <div
      className={cn(
        "space-y-2.5 rounded border border-line bg-panel/40 p-3",
        pending && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-2xs uppercase tracking-caps text-dim">Category</span>
        {availableCategories.length === 0 ? (
          <span className="text-2xs text-dim">Unavailable</span>
        ) : (
          availableCategories.map(({ category, count }) => {
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
                <span className="ml-1 text-dim">{count}</span>
              </button>
            );
          })
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-2.5">
        <span className="text-2xs uppercase tracking-caps text-dim">Resolves within</span>
        {RESOLUTION_WINDOWS.map((option) => (
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

      {window !== "any" ? (
        <p className="text-2xs leading-4 text-dim">
          Filtered on the market&apos;s scheduled close, which is not the same as its resolution
          time — a market can settle earlier, or report late.
        </p>
      ) : null}
    </div>
  );
}

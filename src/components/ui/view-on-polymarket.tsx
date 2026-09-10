import { polymarketMarketUrl } from "@/lib/polymarket/normalize";
import { cn } from "./primitives";

/**
 * The only action affordance in PolyAlpha: it sends you to Polymarket. Nothing in this app
 * places, sizes or simulates an order.
 */
export function ViewOnPolymarket({
  slug,
  eventSlug,
  className,
}: {
  slug?: string | null;
  eventSlug?: string | null;
  className?: string;
}) {
  return (
    <a
      href={polymarketMarketUrl(slug ?? null, eventSlug ?? null)}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-2.5 py-1 text-2xs font-medium uppercase tracking-caps text-accent transition-colors hover:border-accent/60 hover:bg-accent/20",
        className,
      )}
    >
      VIEW ON POLYMARKET
      <span aria-hidden="true" className="text-[10px] leading-none">
        ↗
      </span>
    </a>
  );
}

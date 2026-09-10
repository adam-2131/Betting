import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/primitives";

const DESTINATIONS: Array<{ href: string; label: string; description: string }> = [
  { href: "/", label: "Opportunities", description: "Ranked market sides tracked traders are backing" },
  { href: "/traders", label: "Traders", description: "The watchlist and each wallet's record" },
  { href: "/smart-money", label: "Smart money", description: "Where tracked wallets agree" },
  { href: "/activity", label: "Activity", description: "Aggregated recent events" },
  { href: "/backtest", label: "Backtest", description: "Whether the score has ever worked" },
  { href: "/settings", label: "Settings", description: "Thresholds, bankroll and stored data" },
];

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 py-8">
      <Card>
        <CardHeader
          title="That page does not exist"
          subtitle="A trader or market may also have been removed from the local database since the link was made — re-running a sync will not restore a market Polymarket has delisted."
        />

        <div className="grid gap-2 sm:grid-cols-2">
          {DESTINATIONS.map((destination) => (
            <Link
              key={destination.href}
              href={destination.href}
              className="rounded border border-line p-2.5 transition-colors hover:border-accent/40"
            >
              <span className="block text-xs text-fg">{destination.label}</span>
              <span className="mt-0.5 block text-2xs leading-4 text-dim">
                {destination.description}
              </span>
            </Link>
          ))}
        </div>
      </Card>
    </div>
  );
}

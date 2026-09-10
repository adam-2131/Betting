/**
 * The orientation panel on the Opportunities screen.
 *
 * Collapsed by default so it does not get in the way once it has been read, but present on every
 * visit rather than hidden behind a docs link. The "what this cannot tell you" line is deliberately
 * outside the collapsed section: it is the one thing that must be seen without opening anything.
 */
import { WHAT_THIS_CANNOT_TELL_YOU } from "@/lib/plain-language";

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: "What a card is",
    body: "One side of one market — YES or NO — that at least one tracked trader currently holds. The list is ordered by the Opportunity Score, which combines how good those traders' records are, how many of them agree, and how good your entry price would be.",
  },
  {
    title: "Read the entry comparison first",
    body: "The most useful line on a card is the one comparing what tracked traders paid with what you would pay now. A trader you admire buying at 30¢ says very little about buying the same outcome at 72¢ — that is a different trade with a different payoff. Cards flagged 'Move already happened' are the ones where the price has run away from them.",
  },
  {
    title: "The price is a probability",
    body: "A price of 41¢ means the market currently thinks there is roughly a 41% chance. It also means each share pays $1 if it wins, so $7 buys about 17 shares and returns about $17. Cheap outcomes pay more precisely because they are less likely.",
  },
  {
    title: "A high win rate is not skill",
    body: "Someone who only buys 96¢ near-certainties wins nearly every time and makes very little doing it. That is why every trader profile breaks results down by entry price, and why the score penalises a record built mostly on favourites.",
  },
  {
    title: "How to act on one",
    body: "Open the market with 'View on Polymarket' and decide for yourself. PolyAlpha has no wallet, no keys and no ability to trade — it reads public data and nothing else.",
  },
];

export function HowToRead() {
  return (
    <details className="group rounded border border-line bg-panel/40">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-2xs uppercase tracking-caps text-muted hover:text-fg">
        <span>New here? How to read this page</span>
        <span className="text-dim transition-transform group-open:rotate-90">›</span>
      </summary>

      <div className="space-y-3 border-t border-line px-3 py-3">
        {STEPS.map((step, index) => (
          <div key={step.title} className="flex gap-2.5">
            <span className="mt-0.5 font-mono text-2xs text-dim">{index + 1}</span>
            <div>
              <div className="text-xs text-fg">{step.title}</div>
              <p className="mt-0.5 text-2xs leading-4 text-muted">{step.body}</p>
            </div>
          </div>
        ))}

        <div className="rounded border border-warning/30 bg-warning/5 px-2.5 py-2">
          <div className="text-2xs uppercase tracking-caps text-warning">
            What this cannot tell you
          </div>
          <p className="mt-1 text-2xs leading-4 text-muted">{WHAT_THIS_CANNOT_TELL_YOU}</p>
        </div>
      </div>
    </details>
  );
}

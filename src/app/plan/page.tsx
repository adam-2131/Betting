/**
 * Plan — dividing a sum across the current opportunity list.
 *
 * Deliberately a *splitter*, not an optimiser. See the header of `@/lib/allocation` for the
 * reasoning: with no demonstrated edge there is no defensible "optimal" stake, and a tool that
 * produced one would be inventing the number it optimised against.
 *
 * The candidate list is drawn through the same Settings thresholds as the Opportunities page, so
 * the planner can never spread money across markets the rest of the app has already filtered out.
 */
import Link from "next/link";
import { filtersFromSettings, listOpportunities } from "@/lib/queries/opportunities";
import { getSettings } from "@/lib/settings";
import { safeNumber } from "@/lib/num";
import type { AllocationCandidate } from "@/lib/allocation";
import { SectionTitle } from "@/components/ui/primitives";
import { AutoRefresh } from "@/components/auto-refresh";
import { PlanBuilder } from "./plan-builder";

export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const [settings, filters] = await Promise.all([getSettings(), filtersFromSettings()]);
  const { rows } = await listOpportunities({ ...filters, limit: 25 });

  const candidates: AllocationCandidate[] = rows.map((row) => ({
    id: row.id,
    question: row.market.question,
    outcomeLabel: row.market.outcomes[row.outcomeIndex] ?? `Outcome ${row.outcomeIndex}`,
    price: safeNumber(row.currentPrice),
    score: safeNumber(row.score),
    // Stored as a price fraction; the planner and the plain-language helpers both work in cents.
    entryGapCents: (() => {
      const gap = safeNumber(row.entryGap);
      return gap === null ? null : gap * 100;
    })(),
    liquidity: safeNumber(row.liquidity),
  }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>Splitting your money</SectionTitle>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-dim">
          <span>{candidates.length} available</span>
          <span>·</span>
          <Link
            href="/settings"
            className="text-muted underline-offset-2 hover:text-accent hover:underline"
          >
            adjust thresholds
          </Link>
          <span>·</span>
          <AutoRefresh intervalSeconds={120} />
        </div>
      </div>

      <PlanBuilder candidates={candidates} defaultBankroll={settings.bankroll} />

      <p className="border-t border-line pt-3 text-2xs leading-4 text-dim">
        PolyAlpha is a research tool. It never places, sizes or signs a trade, and it holds no
        credentials. The amounts here are arithmetic on a sum you chose, not advice on what to
        stake.
      </p>
    </div>
  );
}

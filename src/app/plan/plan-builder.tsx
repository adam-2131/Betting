"use client";

/**
 * The interactive half of the planner.
 *
 * All arithmetic comes from `@/lib/allocation`, which is unit-tested, so what is displayed cannot
 * drift from what is tested. This component only gathers three inputs and renders the result.
 *
 * It calculates. It does not place, size or sign anything, and there is no order-placement code
 * anywhere in this application. The "View on Polymarket" link on each row is the only way to act
 * on any of it, and it hands the decision back to you.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  buildAllocationPlan,
  WHY_NOT_OPTIMISED,
  type AllocationCandidate,
  type AllocationMethod,
} from "@/lib/allocation";
import { entryVerdict } from "@/lib/plain-language";
import { formatCents, formatNumber, formatUsd, UNAVAILABLE } from "@/lib/num";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Panel,
  Stat,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  cn,
} from "@/components/ui/primitives";

const MIN_TICKET = 1;

const METHODS: Array<{ value: AllocationMethod; label: string; hint: string }> = [
  {
    value: "EQUAL",
    label: "Even split",
    hint: "The same amount on each. Assumes least about which is better.",
  },
  {
    value: "SCORE_WEIGHTED",
    label: "Weighted by score",
    hint: "More on higher scores. The score has no demonstrated accuracy.",
  },
];

const PRESETS = [5, 10, 25, 50, 100];

/**
 * Market-implied chances span many orders of magnitude here — a five-longshot basket can put the
 * best case below one in a million. Rounding that to "0%" would read as impossible when it is
 * merely very unlikely, so small values degrade to words.
 */
function formatChance(p: number): string {
  if (!Number.isFinite(p) || p < 0) return UNAVAILABLE;
  const pct = p * 100;
  if (pct >= 1) return `${pct.toFixed(0)}%`;
  if (pct >= 0.01) return `${pct.toFixed(2)}%`;
  if (pct > 0) return "under 0.01%";
  return "0%";
}

function entryNote(gapCents: number | null): { text: string; tone: "positive" | "neutral" | "warning" | "negative" } {
  switch (entryVerdict(gapCents)) {
    case "BETTER_THAN_THEM":
      return { text: "Cheaper than they paid", tone: "positive" };
    case "SIMILAR_ENTRY":
      return { text: "About what they paid", tone: "neutral" };
    case "PAYING_MORE":
      return { text: "Dearer than they paid", tone: "warning" };
    case "LATE":
      return { text: "Much dearer — the move already happened", tone: "negative" };
    default:
      return { text: "Entry unknown", tone: "neutral" };
  }
}

export function PlanBuilder({
  candidates,
  defaultBankroll,
}: {
  candidates: AllocationCandidate[];
  defaultBankroll: number;
}) {
  const [bankrollText, setBankrollText] = useState(defaultBankroll.toFixed(2));
  const [positions, setPositions] = useState(5);
  const [method, setMethod] = useState<AllocationMethod>("EQUAL");

  const bankroll = useMemo(() => {
    const parsed = Number.parseFloat(bankrollText);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }, [bankrollText]);

  const plan = useMemo(
    () =>
      buildAllocationPlan({
        bankrollUsd: bankroll,
        candidates,
        method,
        maxPositions: positions,
        minTicketUsd: MIN_TICKET,
      }),
    [bankroll, candidates, method, positions],
  );

  // The $1 floor is what actually limits the slider, so say so rather than letting the user drag
  // it to a number the money cannot reach.
  const reachable = Math.max(1, Math.min(10, plan.positionsPossible || 1, candidates.length || 1));

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="How much are you putting in?"
          subtitle="This divides an amount you have already decided on. It does not tell you what that amount should be."
        />

        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <div>
            <label htmlFor="bankroll" className="block text-2xs uppercase tracking-caps text-muted">
              Total money
            </label>
            <div className="relative mt-1.5">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-sm text-dim">
                $
              </span>
              <input
                id="bankroll"
                type="number"
                inputMode="decimal"
                min={0}
                step={1}
                value={bankrollText}
                onChange={(event) => setBankrollText(event.target.value)}
                className="w-36 rounded border border-line bg-elevated py-1.5 pl-6 pr-2 font-mono text-sm tabular-nums text-fg outline-none focus:border-accent/60"
              />
            </div>
            <div className="mt-1.5 flex gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setBankrollText(preset.toFixed(2))}
                  className="rounded border border-line px-2 py-0.5 font-mono text-2xs tabular-nums text-muted transition-colors hover:border-accent/40 hover:text-accent"
                >
                  ${preset}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="positions" className="block text-2xs uppercase tracking-caps text-muted">
              Spread across
            </label>
            <div className="mt-1.5 flex items-center gap-3">
              <input
                id="positions"
                type="range"
                min={1}
                max={10}
                step={1}
                value={positions}
                onChange={(event) => setPositions(Number(event.target.value))}
                className="w-40 accent-accent"
              />
              <span className="font-mono text-sm tabular-nums text-fg">
                {positions} {positions === 1 ? "market" : "markets"}
              </span>
            </div>
            {positions > reachable ? (
              <p className="mt-1 text-2xs leading-4 text-warning">
                {formatUsd(bankroll)} only reaches {reachable}{" "}
                {reachable === 1 ? "position" : "positions"} at the $1 minimum.
              </p>
            ) : null}
          </div>

          <div>
            <span className="block text-2xs uppercase tracking-caps text-muted">How to divide it</span>
            <div className="mt-1.5 flex gap-1.5">
              {METHODS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  title={option.hint}
                  onClick={() => setMethod(option.value)}
                  className={cn(
                    "rounded border px-2.5 py-1 text-2xs transition-colors",
                    method === option.value
                      ? "border-accent/50 bg-accent/10 text-accent"
                      : "border-line text-muted hover:border-accent/40 hover:text-fg",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {plan.lines.length === 0 ? (
        <EmptyState
          title={bankroll <= 0 ? "Enter an amount above" : "Nothing to divide this across"}
          message={
            plan.warnings[0] ??
            "No opportunity currently passes the thresholds saved in Settings, so there is nothing to spread money over. An empty list is a real answer, not a loading state."
          }
          action={
            <Link
              href="/settings"
              className="rounded border border-line px-2.5 py-1 text-2xs uppercase tracking-caps text-muted hover:border-accent/40 hover:text-accent"
            >
              Review filters
            </Link>
          }
        />
      ) : (
        <>
          <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Card>
              <Stat
                label="Being placed"
                value={formatUsd(plan.totalStaked)}
                sublabel={`across ${plan.lines.length} ${plan.lines.length === 1 ? "market" : "markets"}`}
              />
            </Card>
            <Card>
              <Stat
                label="Expected back"
                value={formatUsd(plan.expectedPayoutAtMarketPrices)}
                sublabel="if the market's prices are right"
              />
            </Card>
            <Card>
              <Stat
                label="Best case"
                value={formatUsd(plan.payoutIfAllWin)}
                sublabel={
                  plan.chanceAllWin === null
                    ? "if every one wins"
                    : `if every one wins — market says ${formatChance(plan.chanceAllWin)}`
                }
                tone="positive"
              />
            </Card>
            <Card>
              <Stat
                label="Worst case"
                value={formatUsd(0)}
                sublabel={`${formatUsd(plan.lossIfAllLose)} gone${
                  plan.chanceAtLeastOneWins === null
                    ? ""
                    : ` — ${formatChance(1 - plan.chanceAtLeastOneWins)} likely`
                }`}
                tone="negative"
              />
            </Card>
          </section>

          {plan.unallocated > 0 ? (
            <p className="text-2xs text-dim">
              {formatUsd(plan.unallocated)} is left unallocated — below the $1 order minimum.
            </p>
          ) : null}

          <Panel>
            <Table>
              <THead>
                <TR>
                  <TH>Market</TH>
                  <TH>Buy</TH>
                  <TH numeric>Price</TH>
                  <TH numeric>Put in</TH>
                  <TH numeric>Shares</TH>
                  <TH numeric>If it wins</TH>
                  <TH>Entry vs tracked traders</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {plan.lines.map((line) => {
                  const note = entryNote(line.entryGapCents);
                  return (
                    <TR key={line.id}>
                      <TD className="max-w-sm">
                        <Link
                          href={`/opportunities/${line.id}`}
                          className="line-clamp-2 text-xs leading-4 text-fg underline-offset-2 hover:text-accent hover:underline"
                        >
                          {line.question}
                        </Link>
                      </TD>
                      <TD>
                        <Badge
                          tone={line.outcomeLabel.toLowerCase() === "no" ? "negative" : "positive"}
                          size="sm"
                        >
                          {line.outcomeLabel.toUpperCase()}
                        </Badge>
                      </TD>
                      <TD numeric>{formatCents(line.price)}</TD>
                      <TD numeric className="text-fg">
                        {formatUsd(line.stakeUsd)}
                        <span className="ml-1 text-2xs text-dim">
                          {line.pctOfBankroll.toFixed(0)}%
                        </span>
                      </TD>
                      <TD numeric>{formatNumber(line.shares, 1)}</TD>
                      <TD numeric className="text-positive">
                        {formatUsd(line.payoutIfWins)}
                      </TD>
                      <TD>
                        <span
                          className={cn(
                            "text-2xs leading-4",
                            note.tone === "positive" && "text-positive",
                            note.tone === "warning" && "text-warning",
                            note.tone === "negative" && "text-negative",
                            note.tone === "neutral" && "text-muted",
                          )}
                        >
                          {note.text}
                        </span>
                      </TD>
                      <TD>
                        <Link
                          href={`/opportunities/${line.id}`}
                          className="whitespace-nowrap text-2xs uppercase tracking-caps text-muted underline-offset-2 hover:text-accent hover:underline"
                        >
                          Details
                        </Link>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </Panel>

          {plan.warnings.length > 0 ? (
            <Card className="border-warning/40 bg-warning/5">
              <ul className="space-y-1.5">
                {plan.warnings.map((warning) => (
                  <li key={warning} className="text-2xs leading-4 text-warning">
                    {warning}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {plan.notes.length > 0 ? (
            <Card>
              <CardHeader title="How this was divided" />
              <ul className="space-y-1.5">
                {plan.notes.map((note) => (
                  <li key={note} className="text-2xs leading-4 text-muted">
                    {note}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      )}

      <Card className="border-line">
        <CardHeader title="Why this does not tell you the &ldquo;right&rdquo; amount" />
        <p className="text-2xs leading-5 text-muted">{WHY_NOT_OPTIMISED}</p>
        <p className="mt-2 text-2xs leading-5 text-dim">
          Every row above is arithmetic on the current price: what a stake buys and what it returns
          if that outcome happens. None of it is a probability that it will. You place the order
          yourself on Polymarket, or you do not.
        </p>
      </Card>
    </div>
  );
}

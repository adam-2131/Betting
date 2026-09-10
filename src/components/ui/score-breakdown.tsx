import { formatNumber, formatScore, safeNumber, UNAVAILABLE } from "@/lib/num";
import { COMPONENT_LABELS } from "@/lib/scoring/config";
import type { ScoreComponent, ScorePenalty, ScoreResult } from "@/lib/scoring/types";
import { Card, CardHeader, Divider, ProgressBar, SectionTitle, Unavailable, cn } from "./primitives";

const METHODOLOGY_NOTE =
  "Methodology is never hidden — every component above is computed from measurable inputs and configurable in Settings.";

function labelFor(component: ScoreComponent): string {
  return component.label || COMPONENT_LABELS[component.key] || component.key;
}

/** Signed point delta, e.g. "+12.4 pts" / "-10.0 pts". */
function points(value: number | null | undefined): string {
  const n = safeNumber(value);
  if (n === null) return UNAVAILABLE;
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${formatNumber(Math.abs(n), 1)} pts`;
}

function ComponentRow({ component }: { component: ScoreComponent }) {
  const missing = component.value === null;
  return (
    <div className={cn("py-2.5", missing && "opacity-60")}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-xs text-fg">{labelFor(component)}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-fg">
          {missing ? <Unavailable /> : formatNumber(component.value, 1)}
        </span>
      </div>

      <div className="mt-1.5 flex items-center gap-3">
        <ProgressBar
          value={component.value}
          tone={missing ? "neutral" : "accent"}
          className="min-w-0 flex-1"
        />
        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted">
          {formatNumber(component.weight, 0)}% <span className="text-dim">weight</span>
        </span>
        <span className="w-[4.5rem] shrink-0 text-right font-mono text-2xs tabular-nums text-muted">
          {points(component.contribution)}
        </span>
      </div>

      {component.detail ? <p className="mt-1 text-2xs leading-4 text-muted">{component.detail}</p> : null}
    </div>
  );
}

function PenaltyRow({ penalty }: { penalty: ScorePenalty }) {
  const negative = safeNumber(penalty.points) !== null && penalty.points < 0;
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-xs text-fg">{penalty.label}</span>
        <span
          className={cn("shrink-0 font-mono text-xs tabular-nums", negative ? "text-negative" : "text-muted")}
        >
          {points(penalty.points)}
        </span>
      </div>
      {penalty.detail ? <p className="mt-1 text-2xs leading-4 text-muted">{penalty.detail}</p> : null}
    </div>
  );
}

export function ScoreBreakdown({
  result,
  title = "Score breakdown",
  compact = false,
  className,
}: {
  result: ScoreResult;
  title?: string;
  compact?: boolean;
  className?: string;
}) {
  const penalised = safeNumber(result.penaltyTotal) !== null && result.penaltyTotal < 0;

  if (compact) {
    return (
      <div className={cn("min-w-0", className)}>
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-xl leading-none tabular-nums text-fg">{formatScore(result.score)}</span>
          <span className="text-2xs text-dim">/ 100</span>
        </div>

        {result.components.length > 0 ? (
          <dl className="mt-2 space-y-0.5">
            {result.components.map((component) => (
              <div
                key={component.key}
                className={cn(
                  "flex items-baseline justify-between gap-3 text-2xs",
                  component.value === null && "opacity-60",
                )}
              >
                <dt className="min-w-0 truncate text-muted">{labelFor(component)}</dt>
                <dd className="shrink-0 font-mono tabular-nums text-fg">
                  {component.value === null ? <Unavailable /> : formatNumber(component.value, 1)}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-2 text-2xs text-dim">No scoring components available.</p>
        )}

        {penalised ? (
          <div className="mt-1.5 flex items-baseline justify-between gap-3 border-t border-line pt-1.5 text-2xs">
            <span className="text-muted">Penalties</span>
            <span className="shrink-0 font-mono tabular-nums text-negative">{points(result.penaltyTotal)}</span>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Card className={className}>
      <CardHeader title={title} subtitle="Every input, weight and penalty behind the number." />

      <div className="flex items-end gap-2">
        <span className="font-mono text-4xl font-medium leading-none tabular-nums text-fg">
          {formatScore(result.score)}
        </span>
        <span className="text-sm leading-none text-dim">/ 100</span>
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-2xs text-muted">
        <span>
          Base score{" "}
          <span className="font-mono tabular-nums text-fg">{formatNumber(result.baseScore, 1)}</span>
        </span>
        <span>
          Penalties{" "}
          <span className={cn("font-mono tabular-nums", penalised ? "text-negative" : "text-fg")}>
            {points(result.penaltyTotal)}
          </span>
        </span>
      </div>

      <Divider className="my-3" />

      <SectionTitle>Components</SectionTitle>
      {result.components.length > 0 ? (
        <div className="divide-y divide-line">
          {result.components.map((component) => (
            <ComponentRow key={component.key} component={component} />
          ))}
        </div>
      ) : (
        <p className="py-2.5 text-2xs text-dim">No scoring components available.</p>
      )}

      {result.penalties.length > 0 ? (
        <>
          <Divider className="my-3" />
          <SectionTitle>Penalties</SectionTitle>
          <div className="divide-y divide-line">
            {result.penalties.map((penalty) => (
              <PenaltyRow key={penalty.key} penalty={penalty} />
            ))}
          </div>
        </>
      ) : null}

      <p className="mt-3 border-t border-line pt-3 text-2xs leading-4 text-dim">{METHODOLOGY_NOTE}</p>
    </Card>
  );
}

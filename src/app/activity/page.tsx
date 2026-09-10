/**
 * Activity feed.
 *
 * Deliberately not a transaction dump. The sync aggregates raw trades into `FeedEvent` rows —
 * one event for a position built over an afternoon, not forty — and each event carries an
 * importance score so the noise sinks.
 */
import Link from "next/link";
import type { FeedEventType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { formatRelativeTime, formatUsd, intPlain } from "@/lib/num";
import {
  Badge,
  Card,
  EmptyState,
  SectionTitle,
  Stat,
  type Tone,
} from "@/components/ui/primitives";
import { AutoRefresh } from "@/components/auto-refresh";

export const dynamic = "force-dynamic";

const EVENT_META: Record<FeedEventType, { label: string; tone: Tone }> = {
  POSITION_OPENED: { label: "Opened", tone: "positive" },
  POSITION_INCREASED: { label: "Increased", tone: "positive" },
  POSITION_REDUCED: { label: "Reduced", tone: "warning" },
  POSITION_CLOSED: { label: "Closed", tone: "neutral" },
  CLUSTER_ENTRY: { label: "Cluster entry", tone: "accent" },
  CONSENSUS_SHIFT: { label: "Consensus shift", tone: "accent" },
  PRICE_CROSSED_ELITE_ENTRY: { label: "Price crossed entry", tone: "warning" },
  MARKET_RESOLVED: { label: "Resolved", tone: "neutral" },
};

export default async function ActivityPage() {
  const since24h = new Date(Date.now() - 24 * 3_600_000);

  const [events, total, last24h, tradeStats] = await Promise.all([
    prisma.feedEvent.findMany({
      orderBy: [{ occurredAt: "desc" }],
      take: 120,
      include: {
        trader: { select: { id: true, displayName: true } },
        market: { select: { question: true, category: true } },
      },
    }),
    prisma.feedEvent.count(),
    prisma.feedEvent.count({ where: { occurredAt: { gte: since24h } } }),
    prisma.tradeActivity.aggregate({
      where: { occurredAt: { gte: since24h }, type: "TRADE" },
      _count: true,
      _sum: { usdcSize: true },
    }),
  ]);

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Card>
          <Stat label="Events (24h)" value={intPlain(last24h)} sublabel={`${intPlain(total)} stored`} />
        </Card>
        <Card>
          <Stat
            label="Trades (24h)"
            value={intPlain(tradeStats._count)}
            sublabel="Raw, before aggregation"
          />
        </Card>
        <Card>
          <Stat
            label="Volume (24h)"
            value={formatUsd(tradeStats._sum.usdcSize)}
            sublabel="By tracked traders"
          />
        </Card>
      </section>

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>Activity</SectionTitle>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-dim">
          <span>Aggregated, most recent first</span>
          <span>·</span>
          <AutoRefresh intervalSeconds={45} />
        </div>
      </div>

      {events.length === 0 ? (
        <EmptyState
          title="No activity yet"
          message="Events are produced by comparing each sync against the previous one, so the first meaningful entries appear after your second sync."
        />
      ) : (
        <ol className="space-y-1.5">
          {events.map((event) => {
            const meta = EVENT_META[event.type];
            return (
              <li
                key={event.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded border border-line bg-surface px-3 py-2"
              >
                <Badge tone={meta.tone} size="sm">
                  {meta.label}
                </Badge>

                <span className="min-w-0 flex-1 text-xs leading-5 text-fg">
                  {event.trader ? (
                    <Link
                      href={`/traders/${event.trader.id}`}
                      className="font-medium hover:text-accent"
                    >
                      {event.trader.displayName}
                    </Link>
                  ) : null}
                  {event.trader ? " " : null}
                  {event.headline}
                  {event.detail ? (
                    <span className="block text-2xs leading-4 text-muted">{event.detail}</span>
                  ) : null}
                </span>

                {event.magnitudeUsd !== null ? (
                  <span className="shrink-0 font-mono text-2xs tabular-nums text-muted">
                    {formatUsd(event.magnitudeUsd)}
                  </span>
                ) : null}

                <time
                  dateTime={event.occurredAt.toISOString()}
                  className="shrink-0 whitespace-nowrap text-2xs text-dim"
                >
                  {formatRelativeTime(event.occurredAt)}
                </time>
              </li>
            );
          })}
        </ol>
      )}

      <p className="text-2xs leading-4 text-dim">
        Repeated fills that build one position are collapsed into a single event, so this reflects
        what changed rather than every transaction that occurred.
      </p>
    </div>
  );
}

/**
 * Alert history.
 *
 * Exists so the feature degrades to an inbox rather than to nothing when no channel is
 * configured — and so a push that failed to send is still visible somewhere rather than silently
 * lost. Every alert is written here before any delivery is attempted.
 */
import Link from "next/link";
import { prisma } from "@/lib/db";
import { channelFor } from "@/lib/notify/channel";
import { DEFAULT_THRESHOLDS } from "@/lib/notify/rules";
import { formatRelativeTime } from "@/lib/num";
import { Badge, Card, EmptyState, SectionTitle, type Tone } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

const KIND_TONE: Record<string, Tone> = {
  OPPORTUNITY: "positive",
  KICKOFF_SOON: "accent",
  BET_SETTLED: "neutral",
  CLV_VERDICT: "warning",
  SYNC_STALE: "negative",
};

const KIND_LABEL: Record<string, string> = {
  OPPORTUNITY: "OPPORTUNITY",
  KICKOFF_SOON: "STARTING SOON",
  BET_SETTLED: "SETTLED",
  CLV_VERDICT: "YOUR RECORD",
  SYNC_STALE: "STALE DATA",
};

export default async function AlertsPage() {
  const [alerts, total] = await Promise.all([
    prisma.notification.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.notification.count(),
  ]);

  const channel = channelFor(process.env.ALERT_WEBHOOK_URL);
  const failed = alerts.filter((a) => a.sendError !== null).length;

  return (
    <div className="space-y-5">
      <Card>
        <h1 className="text-sm font-medium text-fg">Alerts</h1>
        <p className="mt-1 max-w-prose text-2xs leading-5 text-muted">
          Deliberately rare. An alert stream that fires often does not make anyone bet better, it
          makes them bet more — and it stops being read, which is worse than having none. A position
          only qualifies if it clears every bar at once: settles within{" "}
          {DEFAULT_THRESHOLDS.maxHoursToSettle} hours, keeps at least{" "}
          {DEFAULT_THRESHOLDS.minNetEdgePoints} points of edge after the spread, has at least a{" "}
          {Math.round(DEFAULT_THRESHOLDS.minWinProbability * 100)}% estimated chance of paying,
          scores {DEFAULT_THRESHOLDS.minHorizonScore}+, and is backed by{" "}
          {DEFAULT_THRESHOLDS.minQualifiedTraders}+ tracked traders on a book with real depth.
          Longshots are excluded outright however good their other numbers look.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-2xs text-dim">
          <span>
            Delivery:{" "}
            {channel === "NONE" ? (
              <span className="text-warning">
                not configured — set ALERT_WEBHOOK_URL to get these pushed to your phone
              </span>
            ) : (
              <span className="text-positive">{channel === "NTFY" ? "ntfy" : "Discord"}</span>
            )}
          </span>
          <span>·</span>
          <span>{total} raised in total</span>
          {failed > 0 ? (
            <>
              <span>·</span>
              <span className="text-negative">{failed} failed to send</span>
            </>
          ) : null}
        </div>
      </Card>

      <SectionTitle>Most recent</SectionTitle>

      {alerts.length === 0 ? (
        <EmptyState
          title="Nothing has cleared the bar yet"
          message="That is the intended resting state. Alerts fire when a position passes every check at once, when one of your bets settles, when your closing-line record becomes conclusive, or when the data goes stale enough to be misleading."
          action={
            <Link
              href="/cash-soon"
              className="rounded border border-line px-2.5 py-1 text-2xs uppercase tracking-caps text-muted hover:border-accent/40 hover:text-accent"
            >
              Go to the board
            </Link>
          }
        />
      ) : (
        <div className="space-y-2">
          {alerts.map((alert) => (
            <Card key={alert.id} className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge tone={KIND_TONE[alert.kind] ?? "neutral"} size="sm">
                    {KIND_LABEL[alert.kind] ?? alert.kind}
                  </Badge>
                  <span className="text-xs font-medium text-fg">{alert.title}</span>
                </div>
                <span className="text-2xs text-dim">{formatRelativeTime(alert.createdAt)}</span>
              </div>

              <p className="whitespace-pre-line text-2xs leading-4 text-muted">{alert.body}</p>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-2xs text-dim">
                {alert.url ? (
                  <Link href={alert.url} className="underline-offset-2 hover:text-accent hover:underline">
                    Open
                  </Link>
                ) : null}
                {alert.sentAt ? (
                  <span className="text-positive">pushed</span>
                ) : alert.sendError ? (
                  <span className="text-negative">not sent — {alert.sendError}</span>
                ) : (
                  <span>recorded, no channel configured</span>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

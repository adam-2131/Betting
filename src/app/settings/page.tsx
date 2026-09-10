import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { getLastSyncRuns } from "@/lib/sync";
import { formatRelativeTime, intPlain } from "@/lib/num";
import {
  Badge,
  Card,
  CardHeader,
  KeyValue,
  Panel,
  SectionTitle,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/components/ui/primitives";
import { AddTraderForm, SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [settings, runs, counts] = await Promise.all([
    getSettings(),
    getLastSyncRuns(8),
    Promise.all([
      prisma.trader.count(),
      prisma.market.count(),
      prisma.opportunity.count(),
      prisma.closedPosition.count(),
      prisma.tradeActivity.count(),
    ]),
  ]);

  const [traders, markets, opportunities, closedPositions, activity] = counts;

  return (
    <div className="space-y-4">
      <SectionTitle>Settings</SectionTitle>

      <SettingsForm settings={settings} />
      <AddTraderForm />

      <Card>
        <CardHeader title="Stored data" subtitle="What the last sync left in the database." />
        <div className="grid gap-x-6 sm:grid-cols-2">
          <KeyValue label="Traders" value={intPlain(traders)} />
          <KeyValue label="Markets" value={intPlain(markets)} />
          <KeyValue label="Listed opportunities" value={intPlain(opportunities)} />
          <KeyValue label="Settled positions" value={intPlain(closedPositions)} />
          <KeyValue label="Activity rows" value={intPlain(activity)} />
        </div>
      </Card>

      <section className="space-y-2">
        <SectionTitle>Recent syncs</SectionTitle>
        {runs.length === 0 ? (
          <p className="text-2xs text-dim">
            No syncs recorded yet. Run <code className="text-muted">npm run sync</code>.
          </p>
        ) : (
          <Panel>
            <Table>
              <THead>
                <TR hover={false}>
                  <TH>Stage</TH>
                  <TH>Result</TH>
                  <TH>Started</TH>
                  <TH numeric>Duration</TH>
                  <TH>Detail</TH>
                </TR>
              </THead>
              <TBody>
                {runs.map((run) => {
                  const durationMs = run.finishedAt
                    ? run.finishedAt.getTime() - run.startedAt.getTime()
                    : null;
                  return (
                    <TR key={run.id}>
                      <TD>
                        <span className="font-mono text-2xs text-fg">{run.stage}</span>
                      </TD>
                      <TD>
                        <Badge tone={run.ok ? "positive" : "negative"} size="sm">
                          {run.ok ? "OK" : "Failed"}
                        </Badge>
                      </TD>
                      <TD>
                        <span className="text-2xs text-muted">
                          {formatRelativeTime(run.startedAt)}
                        </span>
                      </TD>
                      <TD numeric>
                        <span className="text-2xs">
                          {durationMs === null ? "—" : `${(durationMs / 1000).toFixed(1)}s`}
                        </span>
                      </TD>
                      <TD className="max-w-lg">
                        <span className="line-clamp-2 font-mono text-2xs text-dim">
                          {run.error ?? (run.stats ? JSON.stringify(run.stats) : "—")}
                        </span>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </Panel>
        )}
      </section>

      <Card>
        <CardHeader title="Running a sync" />
        <div className="space-y-2 text-2xs leading-4 text-muted">
          <p>
            <code className="text-fg">npm run sync</code> — full pass: markets, traders, scores,
            opportunities.
          </p>
          <p>
            <code className="text-fg">npm run sync -- --only=opportunities</code> — rescore without
            refetching.
          </p>
          <p>
            <code className="text-fg">POST /api/cron/sync</code> — the same run, for a scheduler.
            Requires the <code className="text-fg">CRON_SECRET</code> bearer token from your{" "}
            <code className="text-fg">.env</code>.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title="What this application will never do" />
        <ul className="space-y-1.5 text-2xs leading-4 text-muted">
          <li>Connect a wallet, or ask for a private key, seed phrase or password.</li>
          <li>Create, sign, size or place an order — including the calculator&apos;s ALL button.</li>
          <li>Copy a trade automatically.</li>
        </ul>
        <p className="mt-3 border-t border-line pt-3 text-2xs leading-4 text-dim">
          PolyAlpha only reads Polymarket&apos;s public APIs. Every trade decision and every trade
          is yours, made on Polymarket.
        </p>
      </Card>
    </div>
  );
}

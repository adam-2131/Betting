/**
 * SPORTS — the upcoming slate, with the smart-money read on each game.
 *
 * Two filters do most of the work here and both are on by default.
 *
 * The first is tradeability. One live four-game NFL slate carried 834 markets across 35 market
 * types, and the great majority are auto-generated books sitting unquoted at 50/50 behind a 96¢
 * spread with a couple of dollars of depth. Without the gate they outnumber the real markets
 * roughly ten to one and the page is unusable.
 *
 * The second is in-play. Polymarket keeps a game market trading after kickoff, and this app has no
 * live score feed, so a position taken during a match is a categorically different bet from the
 * one the score describes.
 *
 * Both exclusions are counted and shown rather than applied silently.
 */
import Link from "next/link";
import { getShortTermStats, listSportsGames, readSports } from "@/lib/queries/short-term";
import { intPlain } from "@/lib/num";
import { Card, EmptyState, SectionTitle, Stat } from "@/components/ui/primitives";
import { GameCard } from "@/components/game-card";
import { AutoRefresh } from "@/components/auto-refresh";
import { DEFAULT_SPORTS_WINDOW, sportsHours } from "../filter-params";
import { SportsFilterBar } from "./filters";

export const dynamic = "force-dynamic";

export default async function SportsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string; props?: string; live?: string }>;
}) {
  const query = await searchParams;
  const windowValue = query.window ?? DEFAULT_SPORTS_WINDOW;
  const includeUntradeable = query.props === "1";
  const includeInPlay = query.live === "1";

  const [stats, result] = await Promise.all([
    getShortTermStats(),
    listSportsGames({
      withinHours: sportsHours(windowValue),
      tradeableOnly: !includeUntradeable,
      excludeInPlay: !includeInPlay,
      limit: 30,
    }),
  ]);

  const scoredSides = result.games.reduce((acc, g) => acc + g.rows.length, 0);

  return (
    <div className="space-y-5">
      <Card>
        <h1 className="text-sm font-medium text-fg">Sports</h1>
        <p className="mt-1 max-w-prose text-2xs leading-5 text-muted">
          Upcoming games where tracked traders hold a position, grouped by fixture and ordered by
          kickoff. Sports get their own screen because two things here exist nowhere else in the
          product: <em>when</em> a position was opened carries information, since lineups and late
          news land in the final day and the closing line is the sharpest price a sports market ever
          shows; and the price moving away from a trader&rsquo;s entry is simultaneously a worse
          entry for you and evidence their read was right, which is only resolvable by looking at
          whether they are still buying.
        </p>
      </Card>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <Stat label="Games shown" value={intPlain(result.games.length)} sublabel="with a scored side" />
        </Card>
        <Card>
          <Stat label="Sides scored" value={intPlain(scoredSides)} sublabel="across those games" />
        </Card>
        <Card>
          <Stat
            label="Placeholder books"
            value={intPlain(result.untradeable)}
            sublabel="hidden — unquoted, not tradeable"
          />
        </Card>
        <Card>
          <Stat
            label="Season futures"
            value={intPlain(result.seasonFutures)}
            sublabel="no kickoff, not part of a slate"
          />
        </Card>
      </section>

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>Upcoming slate</SectionTitle>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-dim">
          <span>{result.totalSportsSides} sports sides scored in total</span>
          <span>·</span>
          <AutoRefresh intervalSeconds={60} />
        </div>
      </div>

      <SportsFilterBar
        window={windowValue}
        includeUntradeable={includeUntradeable}
        includeInPlay={includeInPlay}
        resultCount={result.games.length}
      />

      {result.inPlay > 0 && !includeInPlay ? (
        <p className="rounded border border-line bg-elevated/40 px-3 py-2 text-2xs leading-5 text-muted">
          <span className="font-mono tabular-nums text-fg">{result.inPlay}</span>{" "}
          {result.inPlay === 1 ? "side is" : "sides are"} hidden because the game has already kicked
          off. Prices there move on events happening live, which this dashboard cannot see.{" "}
          <Link
            href={{ query: { ...query, live: "1" } }}
            className="underline underline-offset-2 hover:text-accent"
          >
            Show them anyway
          </Link>
          .
        </p>
      ) : null}

      {result.games.length === 0 ? (
        <EmptyState
          title="No upcoming games with a smart-money position"
          message={
            result.totalSportsSides === 0
              ? "No sports market has been scored yet. Run `npm run sync` to pull live market and trader data, then reload."
              : `${result.totalSportsSides} sports ${result.totalSportsSides === 1 ? "side is" : "sides are"} scored, but none belong to a tradeable game kicking off in this window. ${result.seasonFutures} of them are season futures, which have no kickoff and tie capital up until the competition ends. Widen the window above, or check the main Opportunities list.`
          }
          action={
            <Link
              href="/"
              className="rounded border border-line px-2.5 py-1 text-2xs uppercase tracking-caps text-muted hover:border-accent/40 hover:text-accent"
            >
              Back to all opportunities
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          {result.games.map((game) => (
            <GameCard key={game.eventId ?? game.title} game={game} readAngle={readSports} />
          ))}
        </div>
      )}

      <p className="border-t border-line pt-3 text-2xs leading-4 text-dim">
        Kickoff times come from Polymarket. Settlement is estimated as kickoff plus the typical
        length of a game in that league, because the end date on a game market is kickoff rather
        than settlement. PolyAlpha holds no sports data of its own — it knows nothing about the
        teams, only about what the tracked wallets did. Best return per day currently available
        across all categories is{" "}
        {stats.bestReturnPerDay === null ? "unavailable" : `${(stats.bestReturnPerDay * 100).toFixed(2)}%`}.
      </p>
    </div>
  );
}

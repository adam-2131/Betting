"use client";

/**
 * Trader performance charts.
 *
 * Client components because Recharts needs the DOM. Each chart renders an explicit empty state
 * rather than an empty axis when there is no data — a blank chart reads as a bug, and a chart
 * with invented points would be worse.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatPercent, formatUsd } from "@/lib/num";

const AXIS = { stroke: "rgb(90 98 117)", fontSize: 10 };
const GRID = "rgb(31 36 46)";
const POSITIVE = "rgb(52 211 153)";
const NEGATIVE = "rgb(248 113 113)";
const ACCENT = "rgb(56 189 248)";

function ChartFrame({
  title,
  note,
  empty,
  emptyMessage,
  children,
}: {
  title: string;
  note?: string;
  empty: boolean;
  emptyMessage: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-line bg-surface p-4">
      <div className="mb-3">
        <h3 className="text-2xs font-medium uppercase tracking-caps text-muted">{title}</h3>
        {note ? <p className="mt-0.5 text-2xs leading-4 text-dim">{note}</p> : null}
      </div>
      {empty ? (
        <div className="flex h-40 items-center justify-center text-2xs text-dim">{emptyMessage}</div>
      ) : (
        <div className="h-40 w-full">{children}</div>
      )}
    </div>
  );
}

const tooltipStyle = {
  backgroundColor: "rgb(23 27 36)",
  border: "1px solid rgb(31 36 46)",
  borderRadius: 6,
  fontSize: 11,
  color: "rgb(230 233 239)",
};

export function CumulativePnlChart({ data }: { data: { date: string; cumulative: number }[] }) {
  return (
    <ChartFrame
      title="Cumulative realized PnL"
      note="Settled positions only, in resolution order. Open positions are excluded."
      empty={data.length === 0}
      emptyMessage="No settled positions with a known resolution date."
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={40} />
          <YAxis
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v: number) => formatUsd(v)}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(v: number) => [formatUsd(v), "Cumulative"]}
          />
          <Line
            type="monotone"
            dataKey="cumulative"
            stroke={ACCENT}
            strokeWidth={1.5}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function MonthlyPnlChart({ data }: { data: { month: string; pnl: number }[] }) {
  return (
    <ChartFrame
      title="Monthly realized PnL"
      empty={data.length === 0}
      emptyMessage="No settled positions with a known resolution date."
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="month" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={20} />
          <YAxis
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v: number) => formatUsd(v)}
          />
          <Tooltip cursor={{ fill: "rgb(23 27 36)" }} contentStyle={tooltipStyle} formatter={(v: number) => [formatUsd(v), "PnL"]} />
          <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
            {data.map((d) => (
              <Cell key={d.month} fill={d.pnl >= 0 ? POSITIVE : NEGATIVE} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export interface CategoryDatum {
  category: string;
  pnl: number | null;
  roi: number | null;
  closedCount: number;
}

export function CategoryPnlChart({ data }: { data: CategoryDatum[] }) {
  const usable = data.filter((d) => d.pnl !== null);
  return (
    <ChartFrame
      title="Realized PnL by category"
      empty={usable.length === 0}
      emptyMessage="No settled positions by category yet."
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={usable} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="category" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} interval={0} angle={-25} textAnchor="end" height={44} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => formatUsd(v)} />
          <Tooltip cursor={{ fill: "rgb(23 27 36)" }} contentStyle={tooltipStyle} formatter={(v: number) => [formatUsd(v), "Realized PnL"]} />
          <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
            {usable.map((d) => (
              <Cell key={d.category} fill={(d.pnl ?? 0) >= 0 ? POSITIVE : NEGATIVE} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function CategoryRoiChart({ data }: { data: CategoryDatum[] }) {
  const usable = data.filter((d) => d.roi !== null);
  return (
    <ChartFrame
      title="ROI by category"
      note="Return on capital staked in settled positions."
      empty={usable.length === 0}
      emptyMessage="No settled positions by category yet."
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={usable} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="category" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} interval={0} angle={-25} textAnchor="end" height={44} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => formatPercent(v, 0)} />
          <Tooltip cursor={{ fill: "rgb(23 27 36)" }} contentStyle={tooltipStyle} formatter={(v: number) => [formatPercent(v), "ROI"]} />
          <Bar dataKey="roi" radius={[2, 2, 0, 0]}>
            {usable.map((d) => (
              <Cell key={d.category} fill={(d.roi ?? 0) >= 0 ? POSITIVE : NEGATIVE} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export interface EntryBucketDatum {
  label: string;
  count: number;
  winRate: number | null;
  roi: number | null;
}

/**
 * The bucket chart exists to answer one question: is this trader actually forecasting, or just
 * buying near-certainties? A wallet that only buys 90-100c outcomes will show a high win rate
 * and a thin ROI, and that shape is visible here immediately.
 */
export function EntryBucketChart({ data }: { data: EntryBucketDatum[] }) {
  const usable = data.filter((d) => d.count > 0);
  return (
    <ChartFrame
      title="Performance by entry price"
      note="Win rate within each entry band. Consistently buying 90¢+ outcomes produces a high win rate without indicating skill."
      empty={usable.length === 0}
      emptyMessage="No settled positions with a recorded entry price."
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={usable} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} interval={0} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} domain={[0, 1]} tickFormatter={(v: number) => formatPercent(v, 0)} />
          <Tooltip
            cursor={{ fill: "rgb(23 27 36)" }}
            contentStyle={tooltipStyle}
            formatter={(value: number, _name, item) => [
              `${formatPercent(value)} over ${item?.payload?.count ?? 0} positions`,
              "Win rate",
            ]}
          />
          <Bar dataKey="winRate" radius={[2, 2, 0, 0]} fill={ACCENT} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function WinLossChart({ wins, losses }: { wins: number; losses: number }) {
  const data = [
    { label: "Wins", value: wins },
    { label: "Losses", value: losses },
  ];
  return (
    <ChartFrame
      title="Wins vs losses"
      empty={wins + losses === 0}
      emptyMessage="No settled positions with a clear outcome."
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} allowDecimals={false} />
          <YAxis type="category" dataKey="label" tick={AXIS} tickLine={false} axisLine={false} width={52} />
          <Tooltip cursor={{ fill: "rgb(23 27 36)" }} contentStyle={tooltipStyle} />
          <Bar dataKey="value" radius={[0, 2, 2, 0]}>
            <Cell fill={POSITIVE} />
            <Cell fill={NEGATIVE} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

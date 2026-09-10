import type { ReactNode } from "react";
import clsx, { type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { UNAVAILABLE } from "@/lib/num";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type Tone = "neutral" | "positive" | "negative" | "warning" | "accent";
export type StatTone = "positive" | "negative" | "neutral";
export type Align = "left" | "right" | "center";
export type Size = "sm" | "md";

/**
 * A value is "unavailable" when it is null/undefined, empty, or already the formatted
 * UNAVAILABLE string produced by the helpers in @/lib/num. All three must render as
 * "Unavailable" — never 0, never a dash.
 */
function isUnavailable(value: ReactNode): boolean {
  return value === null || value === undefined || value === "" || value === UNAVAILABLE;
}

/** The one and only rendering of a missing value. */
export function Unavailable({ className }: { className?: string }) {
  return <span className={cn("font-sans text-dim", className)}>{UNAVAILABLE}</span>;
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-fg",
  positive: "text-positive",
  negative: "text-negative",
  warning: "text-warning",
  accent: "text-accent",
};

const BADGE_TONE: Record<Tone, string> = {
  neutral: "border-line bg-elevated text-muted",
  positive: "border-positive/30 bg-positive/10 text-positive",
  negative: "border-negative/30 bg-negative/10 text-negative",
  warning: "border-warning/30 bg-warning/10 text-warning",
  accent: "border-accent/30 bg-accent/10 text-accent",
};

const BAR_TONE: Record<Tone, string> = {
  neutral: "bg-dim",
  positive: "bg-positive",
  negative: "bg-negative",
  warning: "bg-warning",
  accent: "bg-accent",
};

const ALIGN_CLASS: Record<Align, string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("rounded-md border border-line bg-surface p-4", className)}>{children}</section>;
}

export function CardHeader({
  title,
  subtitle,
  right,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <h2 className="truncate text-sm font-medium text-fg">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-2xs leading-4 text-muted">{subtitle}</p> : null}
      </div>
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
    </div>
  );
}

/** Card with no padding, for tables and other edge-to-edge content. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn("overflow-hidden rounded-md border border-line bg-surface", className)}>{children}</section>
  );
}

export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2 className={cn("text-2xs font-medium uppercase tracking-caps text-muted", className)}>{children}</h2>
  );
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cn("border-0 border-t border-line", className)} />;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export function Stat({
  label,
  value,
  sublabel,
  tone = "neutral",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sublabel?: ReactNode;
  tone?: StatTone;
  className?: string;
}) {
  const missing = isUnavailable(value);
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-2xs uppercase tracking-caps text-muted">{label}</div>
      <div
        className={cn(
          "mt-1 truncate font-mono text-2xl leading-tight tabular-nums",
          missing ? "text-dim" : TONE_TEXT[tone],
        )}
      >
        {missing ? UNAVAILABLE : value}
      </div>
      {sublabel ? <div className="mt-1 text-2xs leading-4 text-dim">{sublabel}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  size = "md",
  title,
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  size?: Size;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded border font-medium uppercase tracking-caps",
        size === "sm" ? "px-1.5 py-0.5 text-[10px] leading-4" : "px-2 py-0.5 text-2xs",
        BADGE_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function KeyValue({
  label,
  value,
  hint,
  tone = "neutral",
  mono = true,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  mono?: boolean;
  className?: string;
}) {
  const missing = isUnavailable(value);
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-1.5", className)}>
      <div className="min-w-0">
        <div className="text-xs text-muted">{label}</div>
        {hint ? <div className="mt-0.5 text-2xs leading-4 text-dim">{hint}</div> : null}
      </div>
      <div
        className={cn(
          "shrink-0 text-right text-sm tabular-nums",
          mono && "font-mono",
          missing ? "font-sans text-dim" : TONE_TEXT[tone],
        )}
      >
        {missing ? UNAVAILABLE : value}
      </div>
    </div>
  );
}

/**
 * 0-100 bar (or 0-max). A null value renders an empty track announced as "Unavailable"
 * rather than a zero-length bar, which would read as a real score of 0.
 */
export function ProgressBar({
  value,
  max = 100,
  tone = "accent",
  showValue = false,
  className,
}: {
  value: number | null | undefined;
  max?: number;
  tone?: Tone;
  showValue?: boolean;
  className?: string;
}) {
  const usable = typeof value === "number" && Number.isFinite(value) && max > 0;
  const pct = usable ? Math.min(100, Math.max(0, (value / max) * 100)) : null;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={usable ? value : undefined}
        aria-valuetext={usable ? undefined : UNAVAILABLE}
        title={usable ? undefined : UNAVAILABLE}
        className="h-1.5 w-full overflow-hidden rounded-full bg-elevated ring-1 ring-inset ring-line"
      >
        {pct === null ? null : (
          <div className={cn("h-full rounded-full", BAR_TONE[tone])} style={{ width: `${pct}%` }} />
        )}
      </div>
      {showValue ? (
        <span className="w-12 shrink-0 text-right font-mono text-2xs tabular-nums text-muted">
          {pct === null ? <Unavailable /> : Math.round(pct)}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Wraps the table in its own horizontal scroll container so dense tables survive mobile. */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)}>{children}</table>
    </div>
  );
}

export function THead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <thead className={cn("border-b border-line bg-elevated/60 [&_tr:hover]:bg-transparent", className)}>
      {children}
    </thead>
  );
}

export function TBody({ children, className }: { children: ReactNode; className?: string }) {
  return <tbody className={cn("divide-y divide-line", className)}>{children}</tbody>;
}

export function TR({ children, hover = true, className }: { children: ReactNode; hover?: boolean; className?: string }) {
  return <tr className={cn(hover && "transition-colors hover:bg-elevated/60", className)}>{children}</tr>;
}

export function TH({
  children,
  align = "left",
  numeric = false,
  colSpan,
  className,
}: {
  children?: ReactNode;
  align?: Align;
  numeric?: boolean;
  colSpan?: number;
  className?: string;
}) {
  return (
    <th
      scope="col"
      colSpan={colSpan}
      className={cn(
        "whitespace-nowrap px-3 py-2 text-2xs font-medium uppercase tracking-caps text-muted",
        numeric ? "text-right tabular-nums" : ALIGN_CLASS[align],
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TD({
  children,
  align = "left",
  numeric = false,
  colSpan,
  className,
}: {
  children?: ReactNode;
  align?: Align;
  numeric?: boolean;
  colSpan?: number;
  className?: string;
}) {
  const missing = numeric && isUnavailable(children);
  return (
    <td
      colSpan={colSpan}
      className={cn(
        "px-3 py-2 align-middle text-fg",
        numeric ? "whitespace-nowrap text-right font-mono tabular-nums" : ALIGN_CLASS[align],
        className,
      )}
    >
      {missing ? <Unavailable /> : children}
    </td>
  );
}

// ---------------------------------------------------------------------------
// Empty
// ---------------------------------------------------------------------------

export function EmptyState({
  title,
  message,
  action,
  className,
}: {
  title: ReactNode;
  message: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-line bg-surface/40 px-6 py-12 text-center",
        className,
      )}
    >
      <div className="text-sm font-medium text-fg">{title}</div>
      <p className="max-w-prose text-xs leading-5 text-muted">{message}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

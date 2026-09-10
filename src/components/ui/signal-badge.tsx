import type { SignalType } from "@prisma/client";
import { Badge, cn, type Size } from "./primitives";

export interface SignalBadgeMeta {
  emoji: string;
  label: string;
  tone: "positive" | "warning";
  description: string;
}

export const SIGNAL_BADGES: Record<SignalType, SignalBadgeMeta> = {
  STRONG_CONSENSUS: {
    emoji: "🔥",
    label: "STRONG CONSENSUS",
    tone: "positive",
    description: "Multiple high-quality traders independently agree.",
  },
  RECENT_ACCUMULATION: {
    emoji: "🐋",
    label: "RECENT ACCUMULATION",
    tone: "positive",
    description: "Large recent increases from strong wallets.",
  },
  CATEGORY_EXPERTS: {
    emoji: "🎯",
    label: "CATEGORY EXPERTS",
    tone: "positive",
    description: "Traders historically strong in this category agree.",
  },
  ENTRY_ATTRACTIVE: {
    emoji: "💎",
    label: "ENTRY STILL ATTRACTIVE",
    tone: "positive",
    description: "Current price is close to elite traders' average entry.",
  },
  CHASING: {
    emoji: "⚠️",
    label: "CHASING",
    tone: "warning",
    description: "Current price is substantially worse than elite entry.",
  },
  ONE_WALLET_SIGNAL: {
    emoji: "⚠️",
    label: "ONE-WALLET SIGNAL",
    tone: "warning",
    description: "Most of the smart-money score comes from one trader.",
  },
  LOW_LIQUIDITY: {
    emoji: "⚠️",
    label: "LOW LIQUIDITY",
    tone: "warning",
    description: "Potential execution problem.",
  },
  WIDE_SPREAD: {
    emoji: "⚠️",
    label: "WIDE SPREAD",
    tone: "warning",
    description: "Execution cost is high.",
  },
  POSSIBLE_BOT_ACTIVITY: {
    emoji: "⚠️",
    label: "POSSIBLE BOT ACTIVITY",
    tone: "warning",
    description: "Signal may not be manually replicable.",
  },
  STALE_POSITIONS: {
    emoji: "⚠️",
    label: "STALE POSITIONS",
    tone: "warning",
    description: "Tracked positions have not changed recently.",
  },
  RESOLVING_SOON: {
    emoji: "⚠️",
    label: "RESOLVING SOON",
    tone: "warning",
    description: "Very little time remains before resolution.",
  },
  AMBIGUOUS_RESOLUTION: {
    emoji: "⚠️",
    label: "AMBIGUOUS RESOLUTION",
    tone: "warning",
    description: "Resolution criteria may be open to interpretation.",
  },
};

/** Either a bare enum value or a persisted Signal row. */
export type SignalLike = SignalType | { type: SignalType; detail?: string | null };

export function SignalBadge({
  type,
  detail,
  size = "md",
  className,
}: {
  type: SignalType;
  detail?: string | null;
  size?: Size;
  className?: string;
}) {
  const meta = SIGNAL_BADGES[type];
  if (!meta) return null;

  return (
    <Badge tone={meta.tone} size={size} title={detail || meta.description} className={cn("cursor-help", className)}>
      <span aria-hidden="true">{meta.emoji}</span>
      <span className="truncate">{meta.label}</span>
    </Badge>
  );
}

export function SignalBadgeList({
  signals,
  size = "md",
  className,
}: {
  signals: readonly SignalLike[] | null | undefined;
  size?: Size;
  className?: string;
}) {
  if (!signals || signals.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {signals.map((signal, index) => {
        const type = typeof signal === "string" ? signal : signal.type;
        const detail = typeof signal === "string" ? undefined : signal.detail;
        return <SignalBadge key={`${type}-${index}`} type={type} detail={detail} size={size} />;
      })}
    </div>
  );
}

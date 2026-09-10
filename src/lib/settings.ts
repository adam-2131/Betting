/**
 * Application settings — a single row keyed "default".
 *
 * Holds the bankroll, the default opportunity filters, and any overrides layered on top of
 * `src/lib/scoring/config.ts`.
 */
import type { AppSettings } from "@prisma/client";
import { prisma } from "./db";
import { resolveScoringConfig, type ScoringConfig } from "./scoring/config";

export const SETTINGS_ID = "default";

export const DEFAULT_SETTINGS = {
  id: SETTINGS_ID,
  bankroll: 7,
  smallBankrollMode: true,
  excludeBots: true,
  minTraderScore: 50,
  minConsensusScore: 40,
  minLiquidity: 1000,
  maxSpread: 0.05,
  minAgreeingTraders: 2,
  maxEntryGap: 0.15,
  scoringOverrides: null,
} as const;

export async function getSettings(): Promise<AppSettings> {
  const existing = await prisma.appSettings.findUnique({ where: { id: SETTINGS_ID } });
  if (existing) return existing;
  return prisma.appSettings.create({ data: { id: SETTINGS_ID } });
}

export async function getScoringConfig(): Promise<ScoringConfig> {
  const settings = await getSettings();
  return resolveScoringConfig(settings.scoringOverrides);
}

/** Settings plus the resolved scoring config, for pages that need both. */
export async function getSettingsBundle(): Promise<{
  settings: AppSettings;
  config: ScoringConfig;
}> {
  const settings = await getSettings();
  return { settings, config: resolveScoringConfig(settings.scoringOverrides) };
}

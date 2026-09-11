"use server";

/**
 * Settings mutations.
 *
 * These write filter preferences, the bankroll, and the watchlist. They never touch credentials:
 * PolyAlpha has no wallet connection, no private keys and no Polymarket account, so there is
 * nothing of that kind to store.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ETH_ADDRESS_PATTERN } from "@/lib/polymarket/normalize";
import { SETTINGS_ID } from "@/lib/settings";
import { isValidWallet, normalizeWallet } from "@/lib/polymarket/normalize";
import { Category, TraderSource } from "@prisma/client";

export interface ActionResult {
  ok: boolean;
  message: string;
}

const settingsSchema = z.object({
  bankroll: z.coerce.number().min(0.01).max(1_000_000),
  excludeBots: z.coerce.boolean(),
  minTraderScore: z.coerce.number().min(0).max(100),
  minConsensusScore: z.coerce.number().min(0).max(100),
  minLiquidity: z.coerce.number().min(0),
  // Entered in cents, stored as a price fraction.
  maxSpreadCents: z.coerce.number().min(0).max(100),
  minAgreeingTraders: z.coerce.number().int().min(0).max(50),
  maxEntryGapCents: z.coerce.number().min(0).max(100),
  /**
   * Your own Polymarket wallet. An address, never a key — validated to the same pattern as any
   * tracked wallet and lowercased, since the Data API keys off the lowercase form. Blank clears
   * it and stops the import.
   */
  myWallet: z
    .string()
    .trim()
    .transform((v) => v.toLowerCase())
    .refine((v) => v === "" || ETH_ADDRESS_PATTERN.test(v), {
      message: "That is not a wallet address. It should start 0x and be 42 characters.",
    }),
});

export async function saveSettings(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = settingsSchema.safeParse({
    bankroll: formData.get("bankroll"),
    excludeBots: formData.get("excludeBots") === "on",
    minTraderScore: formData.get("minTraderScore"),
    minConsensusScore: formData.get("minConsensusScore"),
    minLiquidity: formData.get("minLiquidity"),
    maxSpreadCents: formData.get("maxSpreadCents"),
    minAgreeingTraders: formData.get("minAgreeingTraders"),
    maxEntryGapCents: formData.get("maxEntryGapCents"),
    myWallet: formData.get("myWallet") ?? "",
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Those values are not valid." };
  }

  const v = parsed.data;
  await prisma.appSettings.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      bankroll: v.bankroll,
      excludeBots: v.excludeBots,
      minTraderScore: v.minTraderScore,
      minConsensusScore: v.minConsensusScore,
      minLiquidity: v.minLiquidity,
      maxSpread: v.maxSpreadCents / 100,
      minAgreeingTraders: v.minAgreeingTraders,
      maxEntryGap: v.maxEntryGapCents / 100,
      myWallet: v.myWallet === "" ? null : v.myWallet,
    },
    update: {
      bankroll: v.bankroll,
      excludeBots: v.excludeBots,
      minTraderScore: v.minTraderScore,
      minConsensusScore: v.minConsensusScore,
      minLiquidity: v.minLiquidity,
      maxSpread: v.maxSpreadCents / 100,
      minAgreeingTraders: v.minAgreeingTraders,
      maxEntryGap: v.maxEntryGapCents / 100,
      myWallet: v.myWallet === "" ? null : v.myWallet,
    },
  });

  revalidatePath("/");
  revalidatePath("/settings");
  revalidatePath("/bets");
  return { ok: true, message: "Settings saved." };
}

const addTraderSchema = z.object({
  wallet: z
    .string()
    .trim()
    .refine(isValidWallet, "That is not a valid Ethereum address (expected 0x followed by 40 hex characters)."),
  displayName: z.string().trim().min(1, "Give the trader a name.").max(80),
  specialty: z.nativeEnum(Category),
  notes: z.string().trim().max(1000).optional(),
});

export async function addTrader(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = addTraderSchema.safeParse({
    wallet: formData.get("wallet"),
    displayName: formData.get("displayName"),
    specialty: formData.get("specialty") || Category.UNKNOWN,
    notes: formData.get("notes") || undefined,
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Those values are not valid." };
  }

  const wallet = normalizeWallet(parsed.data.wallet);
  const existing = await prisma.trader.findUnique({ where: { wallet } });
  if (existing) {
    return { ok: false, message: `${existing.displayName} is already on the watchlist.` };
  }

  await prisma.trader.create({
    data: {
      wallet,
      displayName: parsed.data.displayName,
      specialty: parsed.data.specialty,
      notes: parsed.data.notes ?? null,
      source: TraderSource.MANUAL,
      profileUrl: `https://polymarket.com/profile/${wallet}`,
      active: true,
    },
  });

  revalidatePath("/traders");
  revalidatePath("/settings");
  revalidatePath("/bets");
  return {
    ok: true,
    message: `Added ${parsed.data.displayName}. Run \`npm run sync\` to pull their history.`,
  };
}

export async function setTraderActive(traderId: string, active: boolean): Promise<void> {
  await prisma.trader.update({ where: { id: traderId }, data: { active } });
  revalidatePath("/traders");
  revalidatePath("/settings");
  revalidatePath("/bets");
}

export async function removeTrader(traderId: string): Promise<void> {
  await prisma.trader.delete({ where: { id: traderId } });
  revalidatePath("/traders");
  revalidatePath("/settings");
  revalidatePath("/bets");
}

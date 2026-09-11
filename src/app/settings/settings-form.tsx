"use client";

import { useActionState } from "react";
import { Category } from "@prisma/client";
import type { AppSettings } from "@prisma/client";
import { addTrader, saveSettings, type ActionResult } from "./actions";
import { Card, CardHeader, cn } from "@/components/ui/primitives";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block py-2">
      <span className="text-xs text-fg">{label}</span>
      {hint ? <span className="mt-0.5 block text-2xs leading-4 text-dim">{hint}</span> : null}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

const inputClass =
  "w-full rounded border border-line bg-elevated px-2 py-1.5 font-mono text-sm tabular-nums text-fg outline-none focus:border-accent/60";

function Status({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return (
    <p className={cn("mt-3 text-2xs", state.ok ? "text-positive" : "text-negative")}>
      {state.message}
    </p>
  );
}

export function SettingsForm({ settings }: { settings: AppSettings }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    saveSettings,
    null,
  );

  return (
    <Card>
      <CardHeader
        title="Filters and bankroll"
        subtitle="Applied to the Opportunities list when it loads. Changing these takes effect immediately — no resync needed."
      />

      <form action={formAction}>
        <div className="grid gap-x-6 sm:grid-cols-2">
          <Field
            label="Your Polymarket wallet"
            hint="Optional. Set it and your bets import themselves at their real fill prices, whether placed here or on your phone. This is a public address, not a key — it is read-only and cannot move anything. PolyAlpha never asks for a private key or seed phrase."
          >
            <input
              name="myWallet"
              type="text"
              inputMode="text"
              spellCheck={false}
              autoComplete="off"
              placeholder="0x…"
              defaultValue={settings.myWallet ?? ""}
              className={inputClass}
            />
          </Field>

          <Field
            label="Bankroll"
            hint="Used to show what a stake would buy. PolyAlpha never recommends a stake size."
          >
            <input
              name="bankroll"
              type="number"
              step="0.01"
              min="0.01"
              defaultValue={settings.bankroll}
              className={inputClass}
            />
          </Field>

          <Field label="Minimum trader score" hint="A holder below this does not count as qualified.">
            <input
              name="minTraderScore"
              type="number"
              step="1"
              min="0"
              max="100"
              defaultValue={settings.minTraderScore}
              className={inputClass}
            />
          </Field>

          <Field label="Minimum consensus score">
            <input
              name="minConsensusScore"
              type="number"
              step="1"
              min="0"
              max="100"
              defaultValue={settings.minConsensusScore}
              className={inputClass}
            />
          </Field>

          <Field label="Minimum agreeing traders">
            <input
              name="minAgreeingTraders"
              type="number"
              step="1"
              min="0"
              defaultValue={settings.minAgreeingTraders}
              className={inputClass}
            />
          </Field>

          <Field label="Minimum liquidity ($)">
            <input
              name="minLiquidity"
              type="number"
              step="100"
              min="0"
              defaultValue={settings.minLiquidity}
              className={inputClass}
            />
          </Field>

          <Field label="Maximum spread (¢)">
            <input
              name="maxSpreadCents"
              type="number"
              step="0.5"
              min="0"
              defaultValue={(settings.maxSpread * 100).toFixed(1)}
              className={inputClass}
            />
          </Field>

          <Field
            label="Maximum entry gap (¢)"
            hint="How much worse than the tracked entry you will tolerate before the signal counts as stale."
          >
            <input
              name="maxEntryGapCents"
              type="number"
              step="1"
              min="0"
              defaultValue={(settings.maxEntryGap * 100).toFixed(0)}
              className={inputClass}
            />
          </Field>

          <div className="flex items-start py-2">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                name="excludeBots"
                type="checkbox"
                defaultChecked={settings.excludeBots}
                className="mt-0.5 h-3.5 w-3.5 accent-[rgb(56_189_248)]"
              />
              <span>
                <span className="text-xs text-fg">Exclude likely bots and scalpers</span>
                <span className="mt-0.5 block text-2xs leading-4 text-dim">
                  On by default. Their positions are usually not replicable by hand.
                </span>
              </span>
            </label>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3 border-t border-line pt-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-2xs font-medium uppercase tracking-caps text-accent hover:bg-accent/20 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save settings"}
          </button>
          <Status state={state} />
        </div>
      </form>
    </Card>
  );
}

const CATEGORIES = Object.values(Category);

export function AddTraderForm() {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    addTrader,
    null,
  );

  return (
    <Card>
      <CardHeader
        title="Add a trader"
        subtitle="Any Polymarket wallet address. Nothing here connects a wallet or requests a key — the address is a public identifier used to read public data."
      />

      <form action={formAction}>
        <div className="grid gap-x-6 sm:grid-cols-2">
          <Field label="Wallet address" hint="0x followed by 40 hex characters.">
            <input
              name="wallet"
              type="text"
              required
              spellCheck={false}
              placeholder="0x0000000000000000000000000000000000000000"
              className={inputClass}
            />
          </Field>

          <Field label="Display name">
            <input
              name="displayName"
              type="text"
              required
              maxLength={80}
              placeholder="How you want to refer to them"
              className={cn(inputClass, "font-sans")}
            />
          </Field>

          <Field
            label="Specialty"
            hint="Optional. Leave as Unknown and the sync will measure it from their record."
          >
            <select name="specialty" defaultValue={Category.UNKNOWN} className={cn(inputClass, "font-sans")}>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Notes">
            <input
              name="notes"
              type="text"
              maxLength={1000}
              placeholder="Why you are tracking them"
              className={cn(inputClass, "font-sans")}
            />
          </Field>
        </div>

        <div className="mt-3 flex items-center gap-3 border-t border-line pt-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-2xs font-medium uppercase tracking-caps text-accent hover:bg-accent/20 disabled:opacity-50"
          >
            {pending ? "Adding…" : "Add trader"}
          </button>
          <Status state={state} />
        </div>
      </form>
    </Card>
  );
}

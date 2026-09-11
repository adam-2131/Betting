/**
 * Delivering an alert, over a channel that costs nothing.
 *
 * Both supported channels are free and need no account, no API key and no domain, which is the
 * whole selection criterion:
 *
 *   ntfy.sh   — POST to a topic URL and it pushes to the phone app subscribed to that topic.
 *               Pick an unguessable topic name; anyone who knows it can read your alerts.
 *   Discord   — a channel webhook URL. Paste it in and messages appear in that channel.
 *
 * The channel is inferred from the URL rather than configured separately, because a second setting
 * that has to agree with the first is a second thing to get wrong.
 *
 * Delivery never throws. A notification is already recorded in the database before this runs, so a
 * failed send is a missing push rather than lost information, and it must not abort a sync pass.
 */

export type ChannelKind = "NTFY" | "DISCORD" | "NONE";

export interface OutgoingAlert {
  title: string;
  body: string;
  url?: string | null;
  priority?: "low" | "normal" | "high";
}

export interface DeliveryResult {
  ok: boolean;
  channel: ChannelKind;
  error?: string;
}

export function channelFor(webhookUrl: string | undefined | null): ChannelKind {
  if (!webhookUrl || webhookUrl.trim() === "") return "NONE";
  const url = webhookUrl.trim().toLowerCase();
  if (url.includes("discord.com/api/webhooks") || url.includes("discordapp.com/api/webhooks")) {
    return "DISCORD";
  }
  if (url.includes("ntfy.sh") || url.includes("/ntfy/")) return "NTFY";
  // An unrecognised URL is treated as ntfy, which accepts a plain text body. Any generic webhook
  // receiver will at least get something readable rather than a Discord-shaped payload.
  return "NTFY";
}

/** ntfy maps priority onto 1-5; 3 is its default. */
const NTFY_PRIORITY: Record<NonNullable<OutgoingAlert["priority"]>, string> = {
  low: "2",
  normal: "3",
  high: "4",
};

const TIMEOUT_MS = 10_000;

export async function deliver(
  alert: OutgoingAlert,
  webhookUrl: string | undefined | null,
): Promise<DeliveryResult> {
  const channel = channelFor(webhookUrl);
  if (channel === "NONE" || !webhookUrl) {
    return { ok: false, channel: "NONE", error: "No ALERT_WEBHOOK_URL configured." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response =
      channel === "DISCORD"
        ? await fetch(webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              // Discord renders this as a single message; keeping it plain rather than using an
              // embed means it is readable in a notification preview on a phone.
              content: [`**${alert.title}**`, alert.body, alert.url ?? ""]
                .filter(Boolean)
                .join("\n")
                .slice(0, 1900),
            }),
          })
        : await fetch(webhookUrl, {
            method: "POST",
            headers: {
              // ntfy takes its metadata from headers and the body is plain text. Header values
              // must be latin-1, so the title is stripped of anything outside it.
              Title: asciiOnly(alert.title),
              Priority: NTFY_PRIORITY[alert.priority ?? "normal"],
              ...(alert.url ? { Click: alert.url } : {}),
            },
            signal: controller.signal,
            body: alert.body.slice(0, 3900),
          });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        channel,
        error: `${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
      };
    }

    return { ok: true, channel };
  } catch (error) {
    return {
      ok: false,
      channel,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ntfy sends the title as an HTTP header, and header values cannot carry arbitrary Unicode.
 * Market questions routinely contain accented names, dashes and arrows, and an unencodable byte
 * makes `fetch` throw before the request is sent.
 */
export function asciiOnly(text: string): string {
  return text
    .normalize("NFKD")
    // Strip combining marks so "Kōbe" degrades to "Kobe" rather than losing the letter.
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
}

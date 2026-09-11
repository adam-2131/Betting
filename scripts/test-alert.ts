/**
 * Sends one test alert, so a misconfigured webhook is discovered now rather than by silence.
 *
 *   npm run alert:test
 *
 * Alerts are deliberately rare — two fired across 2,866 scored sides — so "I have not received
 * anything" is the expected state on most days and tells you nothing about whether delivery works.
 * That ambiguity is the whole reason this exists.
 */
import "dotenv/config";
import { channelFor, deliver } from "../src/lib/notify/channel";

async function main() {
  const webhook = process.env.ALERT_WEBHOOK_URL;
  const channel = channelFor(webhook);

  if (channel === "NONE") {
    console.error("\nALERT_WEBHOOK_URL is not set in .env, so there is nowhere to send.\n");
    console.error("  ntfy     https://ntfy.sh/some-long-unguessable-topic");
    console.error("  Discord  https://discord.com/api/webhooks/...\n");
    process.exit(1);
  }

  // Only ever the host, never the full URL: an ntfy topic is a password and this output is the
  // kind of thing that ends up pasted into a chat.
  const host = (() => {
    try {
      return new URL(webhook as string).host;
    } catch {
      return "an invalid URL";
    }
  })();

  console.log(`\nSending a test alert over ${channel} to ${host}…`);

  const result = await deliver(
    {
      title: "PolyAlpha is connected",
      body: [
        "If you are reading this on your phone, alerts are working.",
        "",
        "Real ones are rare on purpose — a position has to clear every check at once, which happened twice across 2,866 scored sides. Silence is the normal state, not a fault.",
      ].join("\n"),
      priority: "normal",
    },
    webhook,
  );

  if (result.ok) {
    console.log("Delivered. Check your phone.\n");
    process.exit(0);
  }

  console.error(`\nDelivery failed: ${result.error}\n`);
  if (channel === "NTFY") {
    console.error("Check the topic in the ntfy app matches the one in the URL exactly.\n");
  }
  process.exit(1);
}

main().catch((error) => {
  console.error("\nFailed:", error instanceof Error ? error.message : error, "\n");
  process.exit(1);
});

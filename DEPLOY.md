# Running PolyAlpha somewhere that is always on

Everything below is free. Where a "free" tier has a catch that would break this app, the catch is
stated rather than glossed over.

## Why it cannot go on Vercel

The obvious answer for a Next.js app is Vercel, and it does not work here.

A full trader sync has been measured at **seventeen minutes**. Vercel's hobby functions cap at
sixty seconds, and `/api/cron/sync` declares `maxDuration = 300` because five minutes is the
ceiling on the platforms it was written for. Hobby cron also fires at most once a day, which is
useless for markets that settle this evening.

You could split the sync into chunks small enough to fit, but that means many more scheduled
invocations and a lot of machinery to make a long job pretend to be a short one. A single small
box that runs `npm run auto` is simpler and free, so that is what this targets.

## The free options, and their catches

| Host | Genuinely free? | Catch |
| --- | --- | --- |
| **Oracle Cloud Always Free** | Yes, indefinitely | Signup wants a card for verification. Region capacity for ARM instances is often exhausted; retry or pick another region. Fiddliest signup, best result. |
| **Google Cloud Always Free** | Yes, one `e2-micro` | Only in `us-west1`, `us-central1`, `us-east1`. 1 GB RAM is tight but workable. Card required. |
| **Fly.io** | Small allowance | Now pay-as-you-go with a modest free credit. Fine for a while, not guaranteed free forever. |
| **Render** | Free web service | **Spins down after 15 minutes of inactivity**, which stops the sync loop. Free Postgres expires after 90 days. Not suitable. |
| **Railway** | Trial credit only | Runs out, then it is paid. |
| **Your own machine** | Completely free | Only current while the machine is awake. |

**Recommended: Oracle Cloud Always Free.** Their ARM allowance (up to 4 cores and 24 GB RAM,
shareable across instances) is far more than this needs, and Postgres can run on the same box, so
there is no separate database to pay for. The signup is the worst part of the whole exercise.

**If you want to avoid the signup**, keeping it on your own machine is a legitimate answer. The
only thing you lose is alerts while the machine is asleep.

## A free database, if you want it separate

Both have real free tiers and neither expires:

- **Neon** — serverless Postgres, generous free tier, scales to zero.
- **Supabase** — free Postgres, pauses after a week of no activity (a sync every 15 minutes counts
  as activity, so it will not pause).

Take the connection string and set it as `DATABASE_URL`. Nothing else changes.

## Deploying to a fresh Linux box

Assumes Docker is installed. On Ubuntu: `curl -fsSL https://get.docker.com | sh`.

```bash
git clone <your-repo> polyalpha && cd polyalpha
cp .env.example .env
```

Edit `.env`:

```bash
DATABASE_URL="postgresql://..."          # Neon/Supabase, or a local Postgres container
CRON_SECRET="<a long random string>"     # protects /api/cron/sync
ALERT_WEBHOOK_URL="https://ntfy.sh/..."  # see below
PUBLIC_BASE_URL="https://your-address"   # so links in alerts work
APP_PASSWORD="<your password>"           # REQUIRED once this is reachable from anywhere
```

Set `myWallet` on the Settings page afterwards and your bets import themselves at their real fill
prices. It is a public address, read-only — nothing here ever asks for a key.

Then:

```bash
docker build -t polyalpha .
docker run -d --name polyalpha --restart unless-stopped \
  --env-file .env -p 3000:3000 polyalpha
```

The container runs the website and the sync loop together, pushes the schema on boot, and restarts
itself if either process dies.

```bash
docker logs -f polyalpha        # watch it
docker restart polyalpha        # after changing .env
```

### Postgres in a second container, if you are not using a hosted one

```bash
docker network create polyalpha-net
docker run -d --name polyalpha-db --restart unless-stopped \
  --network polyalpha-net \
  -e POSTGRES_PASSWORD=change-me -e POSTGRES_DB=polyalpha \
  -v polyalpha-data:/var/lib/postgresql/data postgres:18
```

Then set `DATABASE_URL="postgresql://postgres:change-me@polyalpha-db:5432/polyalpha"` and add
`--network polyalpha-net` to the app's `docker run`.

The named volume is what keeps your bet history across restarts. Do not skip it.

## Alerts

Free, no account, no domain. The channel is detected from the URL, so this is the only setting.

**ntfy — push to your phone.** Install the ntfy app, subscribe to a topic name you invent, and set:

```bash
ALERT_WEBHOOK_URL="https://ntfy.sh/polyalpha-7f3a9c2e-whatever"
```

The topic name *is* the password. Anyone who guesses it reads your alerts, so make it long.

**Discord.** Server Settings → Integrations → Webhooks → New Webhook → Copy URL.

Leave it blank and alerts still get recorded and are readable at `/alerts` — they simply are not
pushed.

## Keeping it private

Two layers, both free, and you want both.

### 1. The password

```bash
APP_PASSWORD="something long that you will remember"
```

One user, one password. Set it before the app is reachable from anywhere you do not control.
Leave it blank and the app is open, which is fine on your own machine and nowhere else.

It protects your **betting record**, not your money — the app holds no wallet, no key and no
Polymarket credential, so the worst case is someone reading what you bet.

### 2. HTTPS, without a domain and without opening a port

The password crosses the wire in the clear over plain HTTP, so it needs something in front of it.
Both of these are free and neither needs a domain name.

**Cloudflare Tunnel** — the better option. It gives you an HTTPS address, and the server makes an
outbound connection, so **no inbound port is open at all**. Nothing to find by scanning.

```bash
# on the server, after `docker run`
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared
./cloudflared tunnel --url http://localhost:3000
```

It prints a `https://something.trycloudflare.com` address that works from your phone immediately.
Free quick tunnels get a new address each restart; a free Cloudflare account and a named tunnel
gives you a fixed one. Set `PUBLIC_BASE_URL` to whichever address you settle on so the links inside
alerts work.

**SSH tunnel** — nothing to install, but only reaches the machine you tunnel from, so not your
phone.

```bash
docker run -d -p 127.0.0.1:3000:3000 ...     # bind to localhost only
ssh -L 3000:localhost:3000 user@your-server  # from your laptop
```

### What the combination gives you

Cloudflare Tunnel plus `APP_PASSWORD` is HTTPS, no open ports, reachable from your phone, and only
by you. It costs nothing.

## Checking it works

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/sync
```

Should return `{"ok":true,...}`. Then open `/alerts` — if the channel is configured, the delivery
line at the top says so.

Alerts are intentionally rare, so silence on the first day is the expected behaviour rather than a
sign that something is broken.

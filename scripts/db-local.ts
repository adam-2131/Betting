/**
 * Zero-install local PostgreSQL for development.
 *
 * Running PolyAlpha locally requires no Docker, no system PostgreSQL and no administrator
 * rights. `embedded-postgres` ships real PostgreSQL binaries as an npm package; this initialises
 * a data directory inside the project and runs an ordinary Postgres server against it, so Prisma
 * connects over a completely normal `postgresql://` URL.
 *
 * If you already run Postgres (system install, Docker, Neon, Supabase, ...), skip this entirely
 * and point DATABASE_URL at that instead. Nothing else in the application changes.
 *
 *   npm run db:local     # leave running in its own terminal
 *
 * An earlier version of this script used PGlite (Postgres compiled to WASM) behind a socket
 * server. It was genuinely zero-download, but the embedded engine died repeatedly under real
 * sync load — silently, while still holding the port, which surfaced as a baffling
 * "Can't reach database server". Real binaries cost a one-time download and are stable.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const DATA_DIR = resolve(process.cwd(), process.env.PGDATA_DIR ?? ".pgdata");
const PORT = Number(process.env.PGPORT ?? 5432);
const USER = process.env.PGUSER ?? "postgres";
const PASSWORD = process.env.PGPASSWORD ?? "postgres";
const DATABASE = process.env.PGDATABASE ?? "polyalpha";

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
    // initdb otherwise inherits the host's Windows locale, which on a non-US machine produces a
    // WIN1252 cluster. Polymarket market questions routinely contain arrows, dashes and accented
    // names, and WIN1252 rejects them outright with "no equivalent in encoding". Force UTF-8.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });

  // `initialise` runs initdb, which must happen exactly once per data directory.
  const alreadyInitialised = existsSync(resolve(DATA_DIR, "PG_VERSION"));
  if (!alreadyInitialised) {
    console.log("  initialising a new PostgreSQL data directory…");
    await pg.initialise();
  }

  await pg.start();

  // createDatabase throws if it already exists, which is the normal case after first run.
  try {
    await pg.createDatabase(DATABASE);
    console.log(`  created database "${DATABASE}"`);
  } catch {
    // Already present.
  }

  const url = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;
  console.log(`\n  PolyAlpha local PostgreSQL ready`);
  console.log(`  data dir : ${DATA_DIR}`);
  console.log(`  listening: ${url}`);
  console.log(`\n  Leave this running. In another terminal: npm run setup && npm run dev\n`);

  const shutdown = async () => {
    console.log("\n  stopping local PostgreSQL…");
    try {
      await pg.stop();
    } catch {
      // Already down.
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Failed to start local PostgreSQL:", error);
  process.exit(1);
});

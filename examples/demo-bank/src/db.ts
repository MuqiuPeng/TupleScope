/**
 * Demo Bank's database: a real PostgreSQL, embedded.
 *
 * Run as its own process so StateScope can keep observing across an API
 * restart, and so the stack has a database service that means something. No
 * Docker required — the point of the example is that `pnpm demo` is the whole
 * setup.
 *
 * Data lives under .pgdata and survives restarts; delete it for a clean slate,
 * or call the API's /debug/reset, which is what scenarios use.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const PORT = Number(process.env["DEMO_BANK_DB_PORT"] ?? 7432);
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, "../.pgdata");

async function main(): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port: PORT,
    persistent: true,
    // The `wal` capture engine reads logical decoding, which is a postmaster
    // setting. Set here as well as in postgresql.conf so a fresh clone gets it
    // without a second restart. `logical` costs a little extra WAL volume and
    // changes nothing for the other two engines.
    postgresFlags: ["-c", "wal_level=logical"],
    // Trust auth, on a loopback-only cluster of fictional data that `rm -rf
    // .pgdata` throws away. `password` below is still required by the type and
    // still written to the pwfile — it just stops being something anyone has
    // to know, which is what keeps it out of statescope.yaml, out of the
    // README, and out of the reader's shell.
    //
    // These reach initdb *after* its own `--auth=`, so they win. Passed as
    // flags because the library's `authMethod` union has no `trust` member.
    // An existing .pgdata keeps whatever auth it was created with.
    initdbFlags: ["--auth-host=trust", "--auth-local=trust"],
  });

  // initialise() throws if the cluster already exists, which is the normal case
  // on every run after the first.
  try {
    await pg.initialise();
  } catch {
    /* already initialised */
  }
  await pg.start();
  // One cluster, one database per example. The shopfront example lives here
  // too so a single service backs both, rather than two Postgres processes.
  for (const name of ["demobank", "shopfront"]) {
    try {
      await pg.createDatabase(name);
    } catch {
      /* already there */
    }
  }

  console.log(`[demo-bank-db] postgres ready on 127.0.0.1:${PORT} (demobank, shopfront)`);

  const stop = async (): Promise<void> => {
    console.log("[demo-bank-db] stopping...");
    try {
      await pg.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  // Nothing else to do; hold the process open for the supervisor.
  await new Promise(() => {});
}

void main().catch((error: unknown) => {
  console.error("[demo-bank-db] failed:", error);
  process.exit(1);
});

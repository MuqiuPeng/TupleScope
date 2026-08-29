/**
 * Demo Bank's database: a real PostgreSQL, embedded.
 *
 * Run as its own process so TupleScope can keep observing across an API
 * restart, and so the stack has a database service that means something. No
 * Docker required — the point of the example is that `pnpm demo` is the whole
 * setup.
 *
 * Data lives under .pgdata and survives restarts; delete it for a clean slate,
 * or call the API's /debug/reset, which is what scenarios use. A cluster made
 * by an older version of this file is brought forward rather than refused —
 * see `trustLocalConnections`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const PORT = Number(process.env["DEMO_BANK_DB_PORT"] ?? 7432);
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, "../.pgdata");

/**
 * Bring an existing cluster's authentication forward.
 *
 * `initdbFlags` runs at initdb time and never again, so a .pgdata created
 * before trust auth landed keeps `password` in its pg_hba.conf forever. The
 * committed workspace files carry no password any more, so that cluster answers
 * every connection with `28P01 empty password returned by client` — an error
 * that names neither this file nor the fix.
 *
 * Rewriting the rules before start is idempotent and loses nothing. The
 * alternative on offer was telling people to delete their database, which is a
 * poor thing to ask of anyone who had put something in it.
 *
 * Only the method column is touched, and only on lines that are rules. Any
 * options after the method go with it: `trust` takes none, and carrying over
 * another method's would be a config that has never been valid.
 */
function trustLocalConnections(dir: string): void {
  const hba = path.join(dir, "pg_hba.conf");
  let text: string;
  try {
    text = readFileSync(hba, "utf8");
  } catch {
    // No cluster here yet. initdb is about to write this file, with trust.
    return;
  }

  const next = text
    .split("\n")
    .map((line) => {
      const kind = /^\s*(local|host|hostssl|hostnossl)\s/.exec(line)?.[1];
      if (!kind) return line;
      const fields = line.trim().split(/\s+/);
      // local: TYPE DATABASE USER METHOD. host and friends carry an ADDRESS.
      const method = kind === "local" ? 3 : 4;
      if (fields.length <= method || fields[method] === "trust") return line;
      return [...fields.slice(0, method), "trust"].join("\t");
    })
    .join("\n");

  if (next === text) return;
  writeFileSync(hba, next);
  console.log(
    "[demo-bank-db] this cluster was created with password auth; switched it to trust",
  );
}

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
    // to know, which is what keeps it out of tuplescope.yaml, out of the
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
  // Before start, so the rewritten rules are the ones the postmaster reads.
  trustLocalConnections(dataDir);

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

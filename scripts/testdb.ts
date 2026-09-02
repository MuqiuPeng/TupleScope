/**
 * A PostgreSQL for the test suite, brought up by the repository itself.
 *
 * Not a convenience. Two of the three capture engines need `wal_level =
 * logical`, which is a postmaster setting — a stock `postgres:17` service
 * container runs `replica`, and against one of those twenty-two conformance
 * cases bow out. They print their reason, and every total stays green, which
 * is the quiet way to test less than you think.
 *
 * `embedded-postgres` ships real server binaries as platform packages, so this
 * works the same on a Linux runner, a macOS runner without Docker, and a
 * laptop with no PostgreSQL installed. That last one matters most: a
 * contributor should be able to run the suite without first being told to
 * install a database.
 *
 * Trust auth on loopback, holding nothing but whatever a test just wrote.
 * `rm -rf .pgdata` is the reset.
 *
 *     pnpm testdb                 # holds the port open until interrupted
 *     TESTDB_PORT=7433 pnpm testdb
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const PORT = Number(process.env["TESTDB_PORT"] ?? 7432);
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, "../.pgdata");

async function main(): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    // Required by the type and written to a pwfile that trust auth never
    // consults. Spelled out because a plausible-looking value here reads to a
    // secret scanner, correctly on shape alone, as a hardcoded credential.
    password: "unused-trust-auth-see-initdbFlags-below",
    port: PORT,
    persistent: true,
    postgresFlags: ["-c", "wal_level=logical"],
    // After initdb's own `--auth=`, so these win. Passed as flags because the
    // library's `authMethod` union has no `trust` member. An existing .pgdata
    // keeps whatever it was created with — see `trustExistingCluster`.
    initdbFlags: ["--auth-host=trust", "--auth-local=trust"],
  });

  // Throws when the cluster is already there, which is every run after the
  // first — and used to throw away every other reason too. A bare catch here
  // means a genuine `initdb` failure reaches `start()` instead, which rejects
  // with no argument at all, and the log reads `[testdb] failed: undefined`
  // with the real stderr nowhere. Harmless on a machine where the only cause is
  // the expected one; the reason a first Windows run would be unreadable.
  //
  // `PG_VERSION` is what `initdb` writes last, so its presence is the cluster
  // saying it finished.
  if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
    await pg.initialise();
  }

  trustExistingCluster(dataDir);
  await pg.start();

  for (const name of ["postgres", "tuplescope_test"]) {
    try {
      await pg.createDatabase(name);
    } catch {
      /* already there */
    }
  }

  console.log(`[testdb] postgres ready on 127.0.0.1:${PORT} (wal_level=logical, trust auth)`);
  console.log(`[testdb] TUPLESCOPE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:${PORT}/postgres`);

  const stop = async (): Promise<void> => {
    try {
      await pg.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  await new Promise(() => {});
}

/**
 * Bring an existing cluster's authentication forward.
 *
 * `initdbFlags` runs at initdb time and never again, so a `.pgdata` created
 * before trust auth landed keeps `password` in its pg_hba.conf forever, and
 * every connection is answered with `28P01 empty password returned by client`
 * — an error naming neither this file nor the fix. Rewriting the method column
 * before start is idempotent and loses nothing; deleting the cluster would.
 *
 * Only lines that are rules are touched, and only the method column. Options
 * after the method go with it: `trust` takes none, and carrying over another
 * method's would be a configuration that has never been valid.
 */
function trustExistingCluster(dir: string): void {
  const hba = path.join(dir, "pg_hba.conf");
  let text: string;
  try {
    text = readFileSync(hba, "utf8");
  } catch {
    return; // No cluster yet; initdb is about to write this with trust.
  }

  const next = text
    .split("\n")
    .map((line) => {
      const kind = /^\s*(local|host|hostssl|hostnossl)\s/.exec(line)?.[1];
      if (!kind) return line;
      const fields = line.trim().split(/\s+/);
      const method = kind === "local" ? 3 : 4;
      if (fields.length <= method || fields[method] === "trust") return line;
      return [...fields.slice(0, method), "trust"].join("\t");
    })
    .join("\n");

  if (next === text) return;
  writeFileSync(hba, next);
  console.log("[testdb] this cluster was created with password auth; switched it to trust");
}

void main().catch((error: unknown) => {
  console.error("[testdb] failed:", error);
  process.exit(1);
});

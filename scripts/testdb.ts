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
 *
 * On Windows — and anywhere with `TESTDB_VIA_PG_CTL=1` — the server is started
 * through `pg_ctl` and is **detached**, so an ungraceful end to this process
 * leaves it running. Ctrl-C stops it; `kill -9` does not. A later run finds it
 * and reuses it rather than failing on the port.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import EmbeddedPostgres from "embedded-postgres";

const PORT = Number(process.env["TESTDB_PORT"] ?? 7432);
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, "../.pgdata");

/**
 * Where the platform package keeps its server binaries.
 *
 * `embedded-postgres` exports only its own entry point, so `binary.js` — which
 * does exactly this — cannot be imported. Resolving the main entry and walking
 * up gets to the same place without reaching past the exports map.
 */
function serverBinary(name: string): string {
  const require = createRequire(import.meta.url);
  const root = path.resolve(path.dirname(require.resolve("embedded-postgres")), "..");
  const platform =
    process.platform === "win32"
      ? "@embedded-postgres/windows-x64"
      : `@embedded-postgres/${process.platform}-${process.arch}`;
  const pkg = createRequire(path.join(root, "resolve.js")).resolve(platform);
  const bin = path.join(path.dirname(pkg), "..", "native", "bin");
  return path.join(bin, process.platform === "win32" ? `${name}.exe` : name);
}

/**
 * Start the postmaster through `pg_ctl` rather than by spawning it.
 *
 * `postgres.exe` refuses to run under an administrator token — it calls
 * `pgwin32_is_admin` and exits — and it has no restricted-token path of its own.
 * `initdb.exe` does re-execute itself restricted, which is why cluster creation
 * works on Windows and starting the server does not. Measured on a GitHub
 * runner, which runs as `runneradmin`:
 *
 *   Execution of PostgreSQL by a user with administrative permissions is not
 *   permitted.
 *
 * `pg_ctl` creates that restricted token itself, and the platform package ships
 * it — `embedded-postgres` simply never uses it, spawning the postmaster
 * directly instead.
 *
 * `TESTDB_VIA_PG_CTL=1` forces this path anywhere, so the mechanism can be
 * exercised on a machine where the ordinary one already works. Without it this
 * is Windows only: on POSIX the library's own start is fine and is what the
 * suite has always used.
 */
const VIA_PG_CTL = process.platform === "win32" || process.env["TESTDB_VIA_PG_CTL"] === "1";

function pgCtl(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(serverBinary("pg_ctl"), args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    // Both streams: `pg_ctl` reports a refusal on stderr and its progress on
    // stdout, and which one carries the sentence that explains a failure
    // depends on the failure.
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    child.on("error", reject);
    // `exit`, not `close`. On Windows `pg_ctl` re-executes itself under a
    // restricted token — that is the whole reason this path exists — and the
    // grandchild inherits these pipes. `close` waits for every writer to let go
    // of them, so it never fires, and the first Windows run hung here for the
    // full two minutes CI allows with no output and no error. `exit` fires when
    // the process itself is done; a short drain after it collects whatever the
    // pipes had, which is all the message this needs.
    child.on("exit", (code) => {
      setTimeout(() => resolve({ code: code ?? 1, output }), 100);
    });
  });
}

/**
 * Non-zero is a failure worth the message; `status` reads the code instead.
 *
 * The message is the whole point. An earlier version of this captured the
 * output and threw only the exit code, so the first Windows run reported
 * `pg_ctl … exited 1` with the reason nowhere — the same shape as the
 * `[testdb] failed: undefined` this file already had once.
 */
async function pgCtlOrThrow(args: string[]): Promise<void> {
  const { code, output } = await pgCtl(args);
  if (code !== 0) {
    throw new Error(`pg_ctl ${args.join(" ")} exited ${code}${output ? `\n${output.trim()}` : ""}`);
  }
}

/**
 * Whether a postmaster is already up on this cluster.
 *
 * Needed only on the `pg_ctl` path, and needed *because* of it: `pg_ctl start`
 * detaches the server, so it outlives this process rather than dying with it
 * the way the library's own start does. A second run would then meet a cluster
 * that is already up and `pg_ctl start` would refuse, when the honest answer is
 * that the database is ready.
 *
 * Exit 0 means running, 3 means stopped, 4 means the directory is not a
 * cluster.
 */
async function alreadyRunning(dir: string): Promise<boolean> {
  return (await pgCtl(["-D", dir, "status"])).code === 0;
}

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
  if (VIA_PG_CTL) {
    if (await alreadyRunning(dataDir)) {
      console.log("[testdb] a server is already up on this cluster; reusing it");
    } else {
      // `-w` waits for the server to accept connections, so the readiness line
      // below means what it says. The options mirror what the library would
      // have passed the postmaster.
      const log = path.join(dataDir, "postmaster.log");
      try {
        await pgCtlOrThrow([
          "-D", dataDir, "-w", "-l", log,
          "-o", `-p ${PORT} -c wal_level=logical`,
          "start",
        ]);
      } catch (error) {
        // `-l` sends the *server's* output there, so a postmaster that refused
        // to start says why in that file and nowhere else. Without this the
        // failure is `pg_ctl … exited 1` over an empty console.
        const detail = existsSync(log) ? readFileSync(log, "utf8").trim() : "(no postmaster.log)";
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${detail}`);
      }
    }
  } else {
    await pg.start();
  }

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
      // Symmetrical: a server pg_ctl started is not one the library can stop,
      // because it holds no handle to it.
      if (VIA_PG_CTL) await pgCtlOrThrow(["-D", dataDir, "-m", "fast", "stop"]);
      else await pg.stop();
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

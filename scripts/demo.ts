/**
 * The diff on the front page, on your machine, in one command.
 *
 *     pnpm demo
 *
 * TupleScope watches what *your* API writes to *your* database, so the honest
 * first run needs both, and a reader who has neither cannot see the one thing
 * the tool is for. This supplies a throwaway pair — a PostgreSQL, four tables,
 * and forty lines of payments API — runs the scenario from the README against
 * them, and takes it all down again.
 *
 * Nothing here is a fixture the product depends on and nothing is left behind.
 * It exists because "clone it and then go and build a backend" is a real wall in
 * front of a five-line diff, and because a demonstration that cannot be run is
 * a claim rather than a demonstration.
 *
 * The schema and the scenario are deliberately the README's own. If the diff
 * this prints ever stops matching the one on the front page, one of the two is
 * wrong, and this is how you find out.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const DB_PORT = Number(process.env["DEMO_DB_PORT"] ?? 7455);
const API_PORT = Number(process.env["DEMO_API_PORT"] ?? 7456);

/** The four tables the README's diff is about. */
const SCHEMA = `
CREATE TABLE wallets (
  id text PRIMARY KEY,
  balance numeric(12,2) NOT NULL
);
CREATE TABLE payments (
  id text PRIMARY KEY,
  amount numeric(12,2) NOT NULL,
  status text NOT NULL,
  idempotency_key text UNIQUE
);
CREATE TABLE refunds (
  id text PRIMARY KEY,
  payment_id text NOT NULL REFERENCES payments(id),
  amount numeric(12,2) NOT NULL
);
CREATE TABLE ledger_entries (
  id bigserial PRIMARY KEY,
  wallet_id text NOT NULL REFERENCES wallets(id),
  amount numeric(12,2) NOT NULL,
  type text NOT NULL
);
INSERT INTO wallets VALUES ('wal_alice', '1000.00'), ('wal_shop', '0.00');
`;

/**
 * The scenario, in the language a reader will write their own in.
 *
 * `hasWrite(changes(* except …))` is the assertion this tool exists for and the
 * one nothing else can make: not "these tables look right" but "nothing else was
 * touched at all".
 */
const SCENARIO = `version: 1
id: refund
title: Refund lifecycle
why: A refund must reverse the money and leave nothing else behind.
datasets:
  - id: happy
    label: A. Full refund of 100.00
    resetFirst: true
    steps:
      - id: pay
        name: Alice pays 100.00
        request:
          method: POST
          path: /payments
          body: { from: wal_alice, to: wal_shop, amount: "100.00" }
        expect: { status: 201 }
        capture: { payment_id: body.id }
        assert:
          - count(inserted(payments)) == 1
          - delta(single(updated(wallets, id = "wal_alice")).balance) == "-100.00"
          - count(inserted(ledger_entries)) == 2

      - id: refund
        name: The shop refunds it in full
        request:
          method: POST
          path: /payments/{{payment_id}}/refund
        expect: { status: 200 }
        assert:
          - single(updated(payments, id = {{payment_id}})).after.status == "REFUNDED"
          - count(inserted(refunds)) == 1
          - delta(single(updated(wallets, id = "wal_alice")).balance) == "100.00"
          - delta(single(updated(wallets, id = "wal_shop")).balance) == "-100.00"
          # The one nothing else can say: no other table was touched.
          - hasWrite(changes(* except payments, refunds, wallets, ledger_entries)) == false
`;

const workspace = (dir: string): string => `name: Demo
baseUrl: http://127.0.0.1:${API_PORT}
scenariosDir: ${path.join(dir, "scenarios").replace(/\\/g, "/")}
database:
  connectionString: postgresql://postgres@127.0.0.1:${DB_PORT}/demo
resetUrl: http://127.0.0.1:${API_PORT}/reset
baselineWindowMs: 200
panels:
  - title: Wallets
    unit: USD
    sources:
      alice: after(updated(wallets, id = "wal_alice").balance)
      shop: after(updated(wallets, id = "wal_shop").balance)
`;

/** Forty lines of payments API. Not a good one — a real one, which is the point. */
function api(query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const send = (code: number, body: unknown): void => {
      response.writeHead(code, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = request.url ?? "/";

    try {
      if (request.method === "POST" && url === "/reset") {
        await query(`TRUNCATE ledger_entries, refunds, payments RESTART IDENTITY CASCADE`);
        // Cast: a bare CASE yields text, and `balance` is numeric.
        await query(`UPDATE wallets SET balance = (CASE id
                       WHEN 'wal_alice' THEN '1000.00' ELSE '0.00' END)::numeric`);
        return send(200, { reset: true });
      }

      if (request.method === "POST" && url === "/payments") {
        const id = `pay_${Math.random().toString(36).slice(2, 8)}`;
        await query(`INSERT INTO payments (id, amount, status) VALUES ($1, $2, 'COMPLETED')`, [
          id,
          body.amount,
        ]);
        await query(`UPDATE wallets SET balance = balance - $1 WHERE id = $2`, [body.amount, body.from]);
        await query(`UPDATE wallets SET balance = balance + $1 WHERE id = $2`, [body.amount, body.to]);
        // Double entry: one leg per wallet, which is why the scenario asserts two.
        await query(
          `INSERT INTO ledger_entries (wallet_id, amount, type)
             VALUES ($1, $2, 'PAYMENT'), ($3, $4, 'PAYMENT')`,
          [body.from, `-${body.amount}`, body.to, body.amount],
        );
        return send(201, { id, status: "COMPLETED" });
      }

      const refund = /^\/payments\/([^/]+)\/refund$/.exec(url);
      if (request.method === "POST" && refund) {
        const paymentId = decodeURIComponent(refund[1]!);
        const { rows } = await query(`SELECT amount, status FROM payments WHERE id = $1`, [paymentId]);
        if (rows.length === 0) return send(404, { error: "no such payment" });
        if (rows[0].status === "REFUNDED") return send(409, { error: "already refunded" });
        const amount = rows[0].amount;
        await query(`UPDATE payments SET status = 'REFUNDED' WHERE id = $1`, [paymentId]);
        await query(`INSERT INTO refunds (id, payment_id, amount) VALUES ($1, $2, $3)`, [
          `ref_${Math.random().toString(36).slice(2, 8)}`,
          paymentId,
          amount,
        ]);
        await query(`UPDATE wallets SET balance = balance + $1 WHERE id = 'wal_alice'`, [amount]);
        await query(`UPDATE wallets SET balance = balance - $1 WHERE id = 'wal_shop'`, [amount]);
        await query(
          `INSERT INTO ledger_entries (wallet_id, amount, type)
             VALUES ('wal_alice', $1, 'REVERSAL'), ('wal_shop', $2, 'REVERSAL')`,
          [amount, `-${amount}`],
        );
        return send(200, { id: paymentId, status: "REFUNDED" });
      }

      send(404, { error: "no such route" });
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tuplescope-demo-db-"));
  const workDir = await mkdtemp(path.join(tmpdir(), "tuplescope-demo-"));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port: DB_PORT,
    persistent: false,
    initdbFlags: ["--auth-host=trust", "--auth-local=trust"],
    // A demo that opens with sixty lines of initdb chatter buries the five it
    // exists to show. Errors still surface; `onError` here is only so a
    // connection dying during teardown is a line rather than an unhandled
    // event that takes the process with it.
    onLog: () => {},
    onError: (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      if (!closing) process.stderr.write(`  [demo] ${text}\n`);
    },
  });

  let server: ReturnType<typeof createServer> | undefined;
  let db: { end: () => Promise<void>; query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> } | undefined;
  // Teardown kills connections on purpose; the noise from that is not news.
  let closing = false;
  try {
    process.stdout.write("  starting a throwaway PostgreSQL…\n");
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("demo");
    const client = pg.getPgClient();
    // `getPgClient` hands back a client for the maintenance database; point it
    // at the one just created.
    db = new (client.constructor as any)({
      connectionString: `postgresql://postgres@127.0.0.1:${DB_PORT}/demo`,
    });
    (db as any).on('error', () => {
      // Terminated by our own shutdown. Without a listener this is fatal.
    });
    await (db as any).connect();
    await db.query(SCHEMA);

    process.stdout.write("  serving a small payments API…\n");
    server = createServer(api((sql, values) => db!.query(sql, values)));
    await new Promise<void>((resolve) => server!.listen(API_PORT, "127.0.0.1", resolve));

    await mkdir(path.join(workDir, "scenarios"), { recursive: true });
    await writeFile(path.join(workDir, "tuplescope.yaml"), workspace(workDir));
    await writeFile(path.join(workDir, "scenarios", "refund.yaml"), SCENARIO);

    process.stdout.write("  running the scenario…\n\n");
    const code = await new Promise<number>((resolve) => {
      const child = spawn(
        process.execPath,
        [path.join(root, "apps/cli/dist/main.js"), "run", "--config", path.join(workDir, "tuplescope.yaml"), "--no-save"],
        { stdio: "inherit" },
      );
      child.on("close", (c) => resolve(c ?? 1));
    });

    process.stdout.write(
      `\n  That was TupleScope watching a real API write to a real database.\n` +
        `  The scenario is ${path.join(workDir, "scenarios", "refund.yaml")} — but it is about to be\n` +
        `  deleted with everything else, so copy it if you want it.\n\n` +
        `  To point it at your own service: tuplescope.example.yaml, then \`tuplescope check\`.\n`,
    );
    process.exitCode = code;
  } finally {
    closing = true;
    server?.close();
    // The client first: stopping the postmaster under an open connection makes
    // `pg` emit a fatal 57P01 on a socket nobody is listening to any more.
    await db?.end().catch(() => undefined);
    await pg.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[demo] failed:", error);
  process.exitCode = 1;
});

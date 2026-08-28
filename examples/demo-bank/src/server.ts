/**
 * Demo Bank API.
 *
 * Small on purpose, but not a mock: every endpoint runs a real transaction
 * against a real Postgres, so what StateScope observes is what actually
 * committed. Auth is `Authorization: Bearer <customer_id>` — a demo shortcut,
 * and the one place this service is deliberately not realistic.
 */

import Fastify from 'fastify';
import pg from 'pg';
import { SCHEMA_SQL, SEED_SQL, TABLES } from './schema.js';

const { Pool } = pg;

const PORT = Number(process.env['DEMO_BANK_PORT'] ?? 7421);
const DATABASE_URL =
  process.env['DEMO_BANK_DATABASE_URL'] ??
  'postgresql://postgres@127.0.0.1:7432/demobank';

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 });

/**
 * Teaching switch. With DEMO_BANK_SLOPPY_REPLAY=1 an idempotent replay still
 * touches `updated_at` before returning the cached result — a very common
 * real-world shape, and a real bug: the retry did reach the database.
 *
 * `updated_at` is in the workspace's ignoreColumns, so a value-comparing diff
 * reports "no change" and the duplicate dataset passes. Write detection sees
 * the row version and the same dataset fails. Flip this on and rerun to watch
 * the difference the capture engine makes.
 */
const SLOPPY_REPLAY = process.env['DEMO_BANK_SLOPPY_REPLAY'] === '1';

/** Ids are readable so a diff reads like a story rather than a wall of UUIDs. */
let counter = 0;
const nextId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${(counter++).toString(36).padStart(2, '0')}`;

async function migrate(): Promise<void> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.payments') IS NOT NULL AS exists`,
  );
  if (rows[0]?.exists) return;
  await pool.query(SCHEMA_SQL);
  await pool.query(SEED_SQL);
}

const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'warn' } });

interface Actor {
  customerId: string;
}

function actorOf(authorization: string | undefined): Actor {
  const id = authorization?.replace(/^Bearer\s+/i, '').trim();
  if (!id) throw httpError(401, 'UNAUTHENTICATED', 'Send Authorization: Bearer <customer_id>.');
  return { customerId: id };
}

interface ApiError extends Error {
  statusCode: number;
  code: string;
}

function httpError(statusCode: number, code: string, message: string): ApiError {
  return Object.assign(new Error(message), { statusCode, code });
}

app.setErrorHandler((error: Error & Partial<ApiError>, _request, reply) => {
  const statusCode = error.statusCode ?? 500;
  if (statusCode >= 500) app.log.error(error);
  void reply.status(statusCode).send({ error: error.code ?? 'INTERNAL', message: error.message });
});

app.get('/health', async () => ({ ok: true }));

/**
 * A signpost, not an endpoint.
 *
 * This service is the thing StateScope observes, not the thing you look at —
 * but a developer who sees three ports in a stack will open all three, and
 * meeting a bare framework 404 reads as "it is broken". Browsers get a page;
 * anything else gets the same facts as JSON.
 */
const ROUTES = [
  ['POST', '/payments', 'make a payment'],
  ['POST', '/payments/:id/refund', 'refund one'],
  ['GET', '/payments/:id', 'read one back'],
  ['POST', '/debug/reset', 'wipe and reseed'],
] as const;

app.get('/', async (request, reply) => {
  const uiPort = process.env['STATESCOPE_PORT'] ?? '7420';
  if (!request.headers.accept?.includes('text/html')) {
    return {
      service: 'demo-bank',
      role: 'The example backend StateScope observes. Not a UI.',
      ui: `http://127.0.0.1:${uiPort}`,
      routes: ROUTES.map(([method, path, what]) => `${method} ${path} — ${what}`),
    };
  }
  return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo Bank API</title><style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px;
    background: #0d1413; color: #e3ebe8;
    font: 15px/1.65 -apple-system, "Segoe UI", "PingFang SC", sans-serif; }
  main { max-width: 34rem; }
  h1 { font-size: 1.15rem; margin: 0 0 4px; }
  p { color: #b6c6c2; margin: 0 0 16px; }
  a { color: #55c4b3; }
  ul { list-style: none; padding: 0; margin: 0 0 16px; border-top: 1px solid #26332f; }
  li { border-bottom: 1px solid #26332f; padding: 7px 0; font-size: 13px;
    font-family: "SFMono-Regular", ui-monospace, Menlo, monospace; color: #869b96; }
  li b { color: #e3ebe8; font-weight: 500; }
</style></head>
<body><main>
  <h1>Demo Bank API</h1>
  <p>This is the backend StateScope watches — the subject, not the tool.
     The UI is at <a href="http://127.0.0.1:${uiPort}">127.0.0.1:${uiPort}</a>
     (it needs the access token the runtime printed at startup).</p>
  <ul>${ROUTES.map(([m, path, what]) => `<li><b>${m} ${path}</b> — ${what}</li>`).join('')}</ul>
  <p>Alice, Bob and the Corner Bookshop are fictional, and so is their money.</p>
</main></body></html>`);
});

/**
 * Wipe and reseed. Datasets that consume a uniqueness slot — an idempotency
 * key, a one-refund-per-payment guard — cannot run twice without it.
 */
app.post('/debug/reset', async () => {
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await pool.query(SEED_SQL);
  return { reset: true };
});

interface CreatePaymentBody {
  amount?: string | number;
  currency?: string;
  merchant?: string;
}

app.post<{ Body: CreatePaymentBody }>('/payments', async (request, reply) => {
  const actor = actorOf(request.headers.authorization);
  const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
  const { amount, currency = 'USD', merchant } = request.body ?? {};

  if (amount === undefined || Number(amount) <= 0) {
    throw httpError(400, 'INVALID_AMOUNT', 'amount must be greater than zero.');
  }
  if (!merchant) throw httpError(400, 'INVALID_MERCHANT', 'merchant is required.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Replaying a key returns the original and writes nothing at all — not even
    // a touched timestamp. That is what makes the duplicate dataset's
    // `hasWrite(changes(*)) == false` a meaningful assertion rather than a
    // formality.
    if (idempotencyKey) {
      const existing = await client.query(
        `SELECT * FROM payments WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return reply.status(201).send(existing.rows[0]);
      }
    }

    const wallet = await client.query<{ id: string; balance: string }>(
      `SELECT id, balance FROM wallets WHERE customer_id = $1 AND currency = $2 FOR UPDATE`,
      [actor.customerId, currency],
    );
    if (!wallet.rows[0]) throw httpError(404, 'WALLET_NOT_FOUND', 'No wallet for that customer.');
    if (Number(wallet.rows[0].balance) < Number(amount)) {
      throw httpError(422, 'INSUFFICIENT_FUNDS', 'The wallet does not hold that much.');
    }

    const merchantWallet = await client.query<{ id: string }>(
      `SELECT id FROM wallets WHERE customer_id = $1 AND currency = $2 FOR UPDATE`,
      [merchant, currency],
    );
    if (!merchantWallet.rows[0]) throw httpError(404, 'MERCHANT_NOT_FOUND', 'Unknown merchant.');

    const paymentId = nextId('pay');
    const payment = await client.query(
      `INSERT INTO payments (id, customer_id, merchant_id, amount, currency, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'COMPLETED', $6) RETURNING *`,
      [paymentId, actor.customerId, merchant, amount, currency, idempotencyKey ?? null],
    );

    await client.query(
      `UPDATE wallets SET balance = balance - $1, updated_at = now() WHERE id = $2`,
      [amount, wallet.rows[0].id],
    );
    await client.query(
      `UPDATE wallets SET balance = balance + $1, updated_at = now() WHERE id = $2`,
      [amount, merchantWallet.rows[0].id],
    );
    await client.query(
      `INSERT INTO ledger_entries (wallet_id, payment_id, type, amount)
       VALUES ($1, $2, 'PAYMENT', $3), ($4, $2, 'PAYMENT', $5)`,
      [wallet.rows[0].id, paymentId, `-${amount}`, merchantWallet.rows[0].id, String(amount)],
    );

    await client.query('COMMIT');
    return reply.status(201).send(payment.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

interface RefundBody {
  amount?: string | number;
  reason?: string;
}

app.post<{ Params: { id: string }; Body: RefundBody }>(
  '/payments/:id/refund',
  async (request, reply) => {
    actorOf(request.headers.authorization);
    const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
    const { amount, reason = 'CUSTOMER_REQUEST' } = request.body ?? {};

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (idempotencyKey) {
        const existing = await client.query(
          `SELECT * FROM refunds WHERE idempotency_key = $1`,
          [idempotencyKey],
        );
        if (existing.rows[0]) {
          if (SLOPPY_REPLAY) {
            await client.query(`UPDATE refunds SET created_at = created_at WHERE id = $1`, [
              existing.rows[0].id,
            ]);
          }
          await client.query('COMMIT');
          return reply.status(200).send(existing.rows[0]);
        }
      }

      const payment = await client.query<{
        id: string;
        customer_id: string;
        merchant_id: string;
        amount: string;
        currency: string;
        status: string;
      }>(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [request.params.id]);
      if (!payment.rows[0]) throw httpError(404, 'PAYMENT_NOT_FOUND', 'No such payment.');

      // A fresh idempotency key is not permission to pay out twice.
      if (payment.rows[0].status === 'REFUNDED') {
        throw httpError(422, 'ALREADY_REFUNDED', 'This payment has already been refunded.');
      }
      const refundAmount = amount ?? payment.rows[0].amount;
      if (Number(refundAmount) > Number(payment.rows[0].amount)) {
        throw httpError(422, 'REFUND_EXCEEDS_PAYMENT', 'A refund cannot exceed the payment.');
      }

      const refundId = nextId('ref');
      const refund = await client.query(
        `INSERT INTO refunds (id, payment_id, amount, reason, idempotency_key)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [refundId, payment.rows[0].id, refundAmount, reason, idempotencyKey ?? null],
      );

      await client.query(
        `UPDATE payments SET status = 'REFUNDED', updated_at = now() WHERE id = $1`,
        [payment.rows[0].id],
      );

      const payer = await client.query<{ id: string }>(
        `SELECT id FROM wallets WHERE customer_id = $1 AND currency = $2 FOR UPDATE`,
        [payment.rows[0].customer_id, payment.rows[0].currency],
      );
      const merchant = await client.query<{ id: string }>(
        `SELECT id FROM wallets WHERE customer_id = $1 AND currency = $2 FOR UPDATE`,
        [payment.rows[0].merchant_id, payment.rows[0].currency],
      );

      await client.query(
        `UPDATE wallets SET balance = balance + $1, updated_at = now() WHERE id = $2`,
        [refundAmount, payer.rows[0]!.id],
      );
      await client.query(
        `UPDATE wallets SET balance = balance - $1, updated_at = now() WHERE id = $2`,
        [refundAmount, merchant.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO ledger_entries (wallet_id, payment_id, type, amount)
         VALUES ($1, $2, 'REVERSAL', $3), ($4, $2, 'REVERSAL', $5)`,
        [payer.rows[0]!.id, payment.rows[0].id, String(refundAmount), merchant.rows[0]!.id, `-${refundAmount}`],
      );

      await client.query('COMMIT');
      return reply.status(200).send(refund.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
);

app.get<{ Params: { id: string } }>('/payments/:id', async (request) => {
  const { rows } = await pool.query(`SELECT * FROM payments WHERE id = $1`, [request.params.id]);
  if (!rows[0]) throw httpError(404, 'PAYMENT_NOT_FOUND', 'No such payment.');
  return rows[0];
});

async function main(): Promise<void> {
  // The database may still be starting; a demo that dies on a race is a demo
  // nobody runs twice.
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate();
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await app.listen({ port: PORT, host: '127.0.0.1' });
  app.log.warn(`Demo Bank listening on http://127.0.0.1:${PORT}`);
}

void main().catch((error: unknown) => {
  console.error('[demo-bank] failed to start:', error);
  process.exit(1);
});

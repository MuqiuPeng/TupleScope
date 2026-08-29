/**
 * Shopfront API.
 *
 * Cart → checkout → pay → cancel, with stock reserved at checkout and released
 * on cancellation. The guard worth having: you cannot oversell.
 */

import Fastify from 'fastify';
import pg from 'pg';
import { SCHEMA_SQL, SEED_SQL, TABLES } from './schema.js';

const { Pool } = pg;

const PORT = Number(process.env['SHOPFRONT_PORT'] ?? 7423);
const DATABASE_URL =
  process.env['SHOPFRONT_DATABASE_URL'] ??
  'postgresql://postgres@127.0.0.1:7432/shopfront';

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 });

let counter = 0;
const nextId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${(counter++).toString(36).padStart(2, '0')}`;

interface ApiError extends Error {
  statusCode: number;
  code: string;
}
const httpError = (statusCode: number, code: string, message: string): ApiError =>
  Object.assign(new Error(message), { statusCode, code });

const customerOf = (authorization: string | undefined): string => {
  const id = authorization?.replace(/^Bearer\s+/i, '').trim();
  if (!id) throw httpError(401, 'UNAUTHENTICATED', 'Send Authorization: Bearer <customer_id>.');
  return id;
};

async function migrate(): Promise<void> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.orders') IS NOT NULL AS exists`,
  );
  if (rows[0]?.exists) return;
  await pool.query(SCHEMA_SQL);
  await pool.query(SEED_SQL);
}

const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'warn' } });

app.setErrorHandler((error: Error & Partial<ApiError>, _request, reply) => {
  const statusCode = error.statusCode ?? 500;
  if (statusCode >= 500) app.log.error(error);
  void reply.status(statusCode).send({ error: error.code ?? 'INTERNAL', message: error.message });
});

app.get('/health', async () => ({ ok: true }));

app.get('/', async (request, reply) => {
  const uiPort = process.env['TUPLESCOPE_PORT'] ?? '7420';
  const routes = [
    'POST /carts — open a cart',
    'POST /carts/:id/items — add a line',
    'POST /carts/:id/checkout — reserve stock, create the order',
    'POST /orders/:id/pay — settle it, stock leaves the building',
    'POST /orders/:id/cancel — release the reservation',
    'POST /debug/reset — wipe and reseed',
  ];
  if (!request.headers.accept?.includes('text/html')) {
    return { service: 'shopfront', role: 'Example backend. Not a UI.', ui: `http://127.0.0.1:${uiPort}`, routes };
  }
  return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Shopfront API</title><style>
 :root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px;
 background:#0d1413;color:#e3ebe8;font:15px/1.65 -apple-system,"Segoe UI","PingFang SC",sans-serif}
 main{max-width:34rem}h1{font-size:1.15rem;margin:0 0 4px}p{color:#b6c6c2;margin:0 0 16px}a{color:#55c4b3}
 ul{list-style:none;padding:0;margin:0;border-top:1px solid #26332f}
 li{border-bottom:1px solid #26332f;padding:7px 0;font:13px/1.5 "SFMono-Regular",ui-monospace,Menlo,monospace;color:#869b96}
</style></head><body><main>
 <h1>Shopfront API</h1>
 <p>The second example backend TupleScope watches. It shares no code and no vocabulary
    with Demo Bank — that is the point of it. UI at
    <a href="http://127.0.0.1:${uiPort}">127.0.0.1:${uiPort}</a>.</p>
 <ul>${routes.map((r) => `<li>${r}</li>`).join('')}</ul>
</main></body></html>`);
});

app.post('/debug/reset', async () => {
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await pool.query(SEED_SQL);
  return { reset: true };
});

app.post('/carts', async (request, reply) => {
  const customer = customerOf(request.headers.authorization);
  const id = nextId('cart');
  const { rows } = await pool.query(
    `INSERT INTO carts (id, customer_id) VALUES ($1, $2) RETURNING *`,
    [id, customer],
  );
  return reply.status(201).send(rows[0]);
});

app.post<{ Params: { id: string }; Body: { sku?: string; quantity?: number } }>(
  '/carts/:id/items',
  async (request, reply) => {
    customerOf(request.headers.authorization);
    const { sku, quantity = 1 } = request.body ?? {};
    if (!sku) throw httpError(400, 'INVALID_SKU', 'sku is required.');
    if (quantity <= 0) throw httpError(400, 'INVALID_QUANTITY', 'quantity must be positive.');

    const product = await pool.query(`SELECT sku FROM products WHERE sku = $1`, [sku]);
    if (!product.rows[0]) throw httpError(404, 'NO_SUCH_PRODUCT', `No product ${sku}.`);

    // Adding the same sku twice adds to the line rather than failing.
    const { rows } = await pool.query(
      `INSERT INTO cart_items (cart_id, sku, quantity) VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, sku) DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity
       RETURNING *`,
      [request.params.id, sku, quantity],
    );
    return reply.status(201).send(rows[0]);
  },
);

app.post<{ Params: { id: string } }>('/carts/:id/checkout', async (request, reply) => {
  const customer = customerOf(request.headers.authorization);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cart = await client.query<{ id: string; status: string }>(
      `SELECT * FROM carts WHERE id = $1 FOR UPDATE`,
      [request.params.id],
    );
    if (!cart.rows[0]) throw httpError(404, 'NO_SUCH_CART', 'No such cart.');
    if (cart.rows[0].status !== 'OPEN') {
      throw httpError(422, 'CART_NOT_OPEN', `This cart is already ${cart.rows[0].status}.`);
    }

    const items = await client.query<{ sku: string; quantity: number }>(
      `SELECT sku, quantity FROM cart_items WHERE cart_id = $1 ORDER BY sku`,
      [request.params.id],
    );
    if (items.rows.length === 0) throw httpError(422, 'EMPTY_CART', 'There is nothing in this cart.');

    const orderId = nextId('ord');
    let total = '0';

    // The order row has to exist before any line can reference it. The total is
    // filled in once the lines are priced.
    await client.query(
      `INSERT INTO orders (id, cart_id, customer_id, status, total)
       VALUES ($1, $2, $3, 'AWAITING_PAYMENT', 0)`,
      [orderId, request.params.id, customer],
    );

    for (const item of items.rows) {
      // Lock and check availability in one place. `on_hand - reserved` is what
      // is actually sellable; either number alone would oversell.
      const product = await client.query<{ sku: string; price: string; on_hand: number; reserved: number }>(
        `SELECT * FROM products WHERE sku = $1 FOR UPDATE`,
        [item.sku],
      );
      const available = product.rows[0]!.on_hand - product.rows[0]!.reserved;
      if (available < item.quantity) {
        throw httpError(
          422,
          'INSUFFICIENT_STOCK',
          `Only ${available} of ${item.sku} can be sold right now; the cart asks for ${item.quantity}.`,
        );
      }

      await client.query(
        `UPDATE products SET reserved = reserved + $1, updated_at = now() WHERE sku = $2`,
        [item.quantity, item.sku],
      );
      const line = await client.query<{ subtotal: string }>(
        `INSERT INTO order_lines (order_id, sku, quantity, unit_price)
         VALUES ($1, $2, $3, $4) RETURNING (quantity * unit_price)::text AS subtotal`,
        [orderId, item.sku, item.quantity, product.rows[0]!.price],
      );
      // Kept in SQL so the arithmetic stays exact numeric, never a JS float.
      const summed = await client.query<{ total: string }>(
        `SELECT ($1::numeric + $2::numeric)::text AS total`,
        [total, line.rows[0]!.subtotal],
      );
      total = summed.rows[0]!.total;

      await client.query(
        `INSERT INTO stock_movements (sku, order_id, reason, delta) VALUES ($1, $2, 'RESERVED', $3)`,
        [item.sku, orderId, -item.quantity],
      );
    }

    await client.query(`UPDATE orders SET total = $1 WHERE id = $2`, [total, orderId]);
    await client.query(`UPDATE carts SET status = 'CHECKED_OUT', updated_at = now() WHERE id = $1`, [
      request.params.id,
    ]);

    await client.query('COMMIT');
    const order = await pool.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
    return reply.status(201).send(order.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.post<{ Params: { id: string } }>('/orders/:id/pay', async (request, reply) => {
  customerOf(request.headers.authorization);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = await client.query<{ id: string; status: string }>(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
      [request.params.id],
    );
    if (!order.rows[0]) throw httpError(404, 'NO_SUCH_ORDER', 'No such order.');
    if (order.rows[0].status !== 'AWAITING_PAYMENT') {
      throw httpError(422, 'ORDER_NOT_PAYABLE', `This order is ${order.rows[0].status}.`);
    }

    // Payment converts a reservation into a real depletion: reserved goes down
    // and on_hand goes down with it, so available is unchanged.
    const lines = await client.query<{ sku: string; quantity: number }>(
      `SELECT sku, quantity FROM order_lines WHERE order_id = $1 ORDER BY sku`,
      [request.params.id],
    );
    for (const line of lines.rows) {
      await client.query(
        `UPDATE products SET on_hand = on_hand - $1, reserved = reserved - $1, updated_at = now()
         WHERE sku = $2`,
        [line.quantity, line.sku],
      );
      await client.query(
        `INSERT INTO stock_movements (sku, order_id, reason, delta) VALUES ($1, $2, 'SHIPPED', $3)`,
        [line.sku, request.params.id, -line.quantity],
      );
    }
    await client.query(`UPDATE orders SET status = 'PAID', updated_at = now() WHERE id = $1`, [
      request.params.id,
    ]);
    await client.query('COMMIT');
    const updated = await pool.query(`SELECT * FROM orders WHERE id = $1`, [request.params.id]);
    return reply.status(200).send(updated.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.post<{ Params: { id: string } }>('/orders/:id/cancel', async (request, reply) => {
  customerOf(request.headers.authorization);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = await client.query<{ id: string; status: string }>(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
      [request.params.id],
    );
    if (!order.rows[0]) throw httpError(404, 'NO_SUCH_ORDER', 'No such order.');
    if (order.rows[0].status === 'CANCELLED') {
      throw httpError(422, 'ALREADY_CANCELLED', 'This order is already cancelled.');
    }
    if (order.rows[0].status === 'PAID') {
      throw httpError(422, 'ALREADY_PAID', 'A paid order cannot be cancelled; refund it instead.');
    }

    const lines = await client.query<{ sku: string; quantity: number }>(
      `SELECT sku, quantity FROM order_lines WHERE order_id = $1 ORDER BY sku`,
      [request.params.id],
    );
    for (const line of lines.rows) {
      await client.query(
        `UPDATE products SET reserved = reserved - $1, updated_at = now() WHERE sku = $2`,
        [line.quantity, line.sku],
      );
      await client.query(
        `INSERT INTO stock_movements (sku, order_id, reason, delta) VALUES ($1, $2, 'RELEASED', $3)`,
        [line.sku, request.params.id, line.quantity],
      );
    }
    await client.query(`UPDATE orders SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [
      request.params.id,
    ]);
    await client.query('COMMIT');
    const updated = await pool.query(`SELECT * FROM orders WHERE id = $1`, [request.params.id]);
    return reply.status(200).send(updated.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

async function main(): Promise<void> {
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
  app.log.warn(`Shopfront listening on http://127.0.0.1:${PORT}`);
}

void main().catch((error: unknown) => {
  console.error('[shopfront] failed to start:', error);
  process.exit(1);
});

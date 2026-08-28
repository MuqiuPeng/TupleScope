/**
 * Shopfront — a fictional online store.
 *
 * This example exists to answer one question about the architecture: does the
 * Core know anything about banking? It shares no code, no column names and no
 * vocabulary with Demo Bank, and the only thing the two have in common is the
 * engine that watches them. If a scenario here reads as naturally as one there,
 * the abstraction held.
 *
 * The interesting difference is deliberate: nothing here is a wallet balance.
 * Inventory is a counter that must not go negative, an order is a state
 * machine, and the invariant worth asserting is that reserved stock and order
 * lines always agree. State transitions, not money.
 */

export const SCHEMA_SQL = `
CREATE TABLE products (
  sku        text PRIMARY KEY,
  name       text NOT NULL,
  price      numeric(10, 2) NOT NULL CHECK (price > 0),
  on_hand    integer NOT NULL CHECK (on_hand >= 0),
  reserved   integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE carts (
  id          text PRIMARY KEY,
  customer_id text NOT NULL,
  status      text NOT NULL DEFAULT 'OPEN',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- No surrogate key: the natural key is composite. Deliberate -- it exercises
-- the capture engine's composite-key path, which a table with a plain single
-- id column never would.
CREATE TABLE cart_items (
  cart_id  text    NOT NULL REFERENCES carts(id),
  sku      text    NOT NULL REFERENCES products(sku),
  quantity integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (cart_id, sku)
);

CREATE TABLE orders (
  id          text PRIMARY KEY,
  cart_id     text NOT NULL REFERENCES carts(id),
  customer_id text NOT NULL,
  status      text NOT NULL,
  total       numeric(10, 2) NOT NULL,
  placed_at   timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_lines (
  order_id   text    NOT NULL REFERENCES orders(id),
  sku        text    NOT NULL REFERENCES products(sku),
  quantity   integer NOT NULL,
  unit_price numeric(10, 2) NOT NULL,
  PRIMARY KEY (order_id, sku)
);

-- Every stock movement, so "why is on_hand 3?" has an answer.
CREATE TABLE stock_movements (
  id         bigserial PRIMARY KEY,
  sku        text NOT NULL REFERENCES products(sku),
  order_id   text REFERENCES orders(id),
  reason     text NOT NULL,
  delta      integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

export const SEED_SQL = `
INSERT INTO products (sku, name, price, on_hand) VALUES
  ('SKU-DESK',  'Standing desk',   649.00, 4),
  ('SKU-LAMP',  'Task lamp',        89.50, 12),
  ('SKU-CHAIR', 'Ergonomic chair', 415.00, 1);
`;

export const TABLES = [
  'stock_movements',
  'order_lines',
  'orders',
  'cart_items',
  'carts',
  'products',
] as const;

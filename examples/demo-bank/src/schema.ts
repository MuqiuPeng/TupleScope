/**
 * Demo Bank — a fictional bank with fictional customers.
 *
 * Nothing here is modelled on any real institution's schema. It exists to give
 * TupleScope something honest to observe: money that moves, a state machine
 * that advances, an audit trail that must balance, and a guard that refuses.
 *
 * Money is `numeric`, never `float`. The whole product is about being able to
 * trust what it says a balance did.
 */

export const SCHEMA_SQL = `
CREATE TABLE customers (
  id          text PRIMARY KEY,
  name        text        NOT NULL,
  email       text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallets (
  id          text PRIMARY KEY,
  customer_id text           NOT NULL REFERENCES customers(id),
  currency    text           NOT NULL,
  balance     numeric(14, 2) NOT NULL DEFAULT 0,
  updated_at  timestamptz    NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id              text PRIMARY KEY,
  customer_id     text           NOT NULL REFERENCES customers(id),
  merchant_id     text           NOT NULL REFERENCES customers(id),
  amount          numeric(14, 2) NOT NULL CHECK (amount > 0),
  currency        text           NOT NULL,
  status          text           NOT NULL,
  idempotency_key text UNIQUE,
  metadata        jsonb          NOT NULL DEFAULT '{}',
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
  id              text PRIMARY KEY,
  payment_id      text           NOT NULL REFERENCES payments(id),
  amount          numeric(14, 2) NOT NULL CHECK (amount > 0),
  reason          text           NOT NULL,
  idempotency_key text UNIQUE,
  created_at      timestamptz    NOT NULL DEFAULT now()
);

-- Double-entry: every movement writes one row per side, and the two sum to zero.
-- An assertion in the refund scenario checks exactly that.
CREATE TABLE ledger_entries (
  id          bigserial PRIMARY KEY,
  wallet_id   text           NOT NULL REFERENCES wallets(id),
  payment_id  text           REFERENCES payments(id),
  type        text           NOT NULL,
  amount      numeric(14, 2) NOT NULL,
  created_at  timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_wallet_idx ON ledger_entries (wallet_id);
`;

export const SEED_SQL = `
INSERT INTO customers (id, name, email) VALUES
  ('cus_alice',     'Alice Nguyen',   'alice@demobank.test'),
  ('cus_bob',       'Bob Oyelaran',   'bob@demobank.test'),
  ('mer_bookshop',  'Corner Bookshop','orders@bookshop.test');

INSERT INTO wallets (id, customer_id, currency, balance) VALUES
  ('wal_alice',    'cus_alice',    'USD', 1000.00),
  ('wal_bob',      'cus_bob',      'USD',  500.00),
  ('wal_bookshop', 'mer_bookshop', 'USD',    0.00);
`;

/** Order matters only for readability; TRUNCATE ... CASCADE handles the rest. */
export const TABLES = [
  'ledger_entries',
  'refunds',
  'payments',
  'wallets',
  'customers',
] as const;

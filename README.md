# StateScope

**Run backend scenarios. See exactly what changed.**

Postman shows you what your API returned. StateScope shows you what it *wrote*.

```
POST /payments/pay_01/refund   ->   200 OK
```

That response proves nothing. This does:

```
payments        pay_01     status   COMPLETED → REFUNDED
refunds         +1 new     amount   100.00
ledger_entries  +2 new     type     REVERSAL
wallets         wal_alice  balance  900.00 → 1000.00
                wal_shop   balance  100.00 → 0.00
```

Local-first. Your database credentials never leave your machine.

---

## Quick start

```bash
pnpm install && pnpm build
cp statescope.example.yaml statescope.yaml   # point it at your API and dev database
pnpm start
```

The runtime prints a URL carrying a per-session access token. Open that.

Lost it? The terminal that printed it is not the only copy:

```bash
open "$(pnpm -s url)"     # the running instance, token and all
pnpm url --all            # if you have several
```

Write a scenario in `scenariosDir`:

```yaml
version: 1
id: refund
title: Refund lifecycle
why: A refund must reverse the money exactly once, and asking twice must not move it twice.

ignoreColumns: [updated_at]

datasets:
  - id: happy
    label: "A. Full refund"
    resetFirst: true
    steps:
      - id: create_payment
        name: Take a payment
        request:
          method: POST
          path: /payments
          as: alice
          idempotencyKey: "pay-{{run}}"
          body: { amount: "100.00", currency: USD }
        capture:
          payment_id: response.body.id
        assert:
          - response.status == 201
          - count(inserted(payments)) == 1

      - id: refund
        name: Refund it
        request:
          method: POST
          path: /payments/{{payment_id}}/refund
          as: merchant
          idempotencyKey: "ref-{{run}}"
        assert:
          - single(updated(payments, id = {{payment_id}})).after.status == "REFUNDED"
          - delta(single(rows(wallets, id = "wal_alice")).balance) == "100.00"
          - sum(delta(wallets.balance)) == "0.00"      # the books balance

      - id: refund_again
        name: Same key, sent again
        request:
          method: POST
          path: /payments/{{payment_id}}/refund
          as: merchant
          idempotencyKey: "ref-{{run}}"
        assert:
          - hasWrite(changes(*)) == false              # the retry wrote nothing
```

Note `{{run}}`: a per-run suffix that keeps idempotency keys unique between
runs. Without it a dataset passes once and then replays its own previous key.

---

## What makes it different

### It detects writes, not value differences

The obvious way to see what an API changed is to snapshot the tables before and
after and compare. StateScope does not do that, because a value comparison
cannot see this:

```sql
UPDATE refunds SET created_at = created_at WHERE id = 'ref_01';
```

Zero columns differ. A before/after diff reports nothing at all. But the row was
rewritten — the retry *did* reach the database, and on a payments endpoint that
is the bug you were looking for.

The default engine holds one `REPEATABLE READ` transaction open across the
request and asks Postgres which rows were written during the window:

```
before   open transaction O, freeze pg_current_snapshot(), read only keys
         (cost ≈ 0 — no table data is copied)
   ↓
         run the HTTP step
   ↓
after    on a second connection, select rows whose inserting transaction was
         not visible to O — exactly the rows written
   ↓
before   query those keys back inside O, which still sees the pre-request
image    world. MVCC is the time machine.
```

No logical replication, no `wal_level` change, no restart, no superuser.
Measured on a 500k-row / 161 MB table:

| | server-side | shipped to the client |
|---|---|---|
| `SELECT *` snapshot, ×2 per step | 396 ms | ~161 MB |
| xmin-filtered scan | 33 ms | a few kB |

What it costs, stated plainly: it holds an extra connection and an open
transaction for the length of each step (bounded, with its own idle timeout, so
a crash cannot strand one), and the after-scan is sequential because `xmin` is
not indexed — cheap to ship, not free to scan, which is what a watch predicate
is for. A row inserted and deleted inside a single transaction leaves no visible
version and is missed; only WAL decoding catches that.

### Observe first, then keep what mattered

The honest answer to "why not write pytest and a few SQL assertions" is that a
hand-written test is more precise — its only weakness is that you have to know
the answer before you write it.

So every step offers the assertions its own changes imply, and keeping one
writes it into the scenario file:

```
Run  →  see the diff  →  [Keep]  →  a real assertion  →  next run catches the regression
```

Generated ids are never baked in: a candidate whose value matches something the
run captured comes out as `{{payment_id}}`, not `pay_ltx3k01`. And the write is
a textual splice, so the file comes back with one line added and nothing else
reformatted — no unfolded block scalars, no re-padded flow collections.

### Assertions say which side they mean

`payments.status` on its own is ambiguous — which row, before or after? — so the
language makes you say:

```yaml
- after(payments[id = {{payment_id}}]).status == "REFUNDED"
- count(inserted(ledger_entries).where(type = "REVERSAL")) == 2
- delta(single(rows(wallets, id = "wal_alice")).balance) == "100.00"
- sum(delta(wallets.balance)) == "0.00"
- hasWrite(changes(*)) == false
```

The same expressions will drive declarative dashboards, so there is one
evaluator, not two.

### It refuses to guess

An assertion that cannot be *decided* is reported as `unevaluable`, never as a
pass or a fail. Counting mutations against a value-comparing engine, a
`single()` that matched three rows, a table outside the watch scope — each says
so. A green run that could not have caught the failure is worse than no check.

### Money is exact

Values are carried as text with their Postgres type and compared under that
type's semantics — `numeric` as an exact decimal, `jsonb` structurally (Postgres
reorders object keys), `citext` case-insensitively. Nothing is ever passed
through a JS number:

```
Number("9007199254740993")  === 9007199254740992     // wrong
0.1 + 0.2                   === 0.30000000000000004  // wrong
```

### It tells you when the rows might not be yours

Before each run it watches an idle window. Background jobs, session sweepers and
outbox pollers are ordinary in a running dev stack, and rows they write would
otherwise be blamed on your API. If anything writes during that window, the
report says so.

---

## Running a scenario

Three ways, all against the same engine:

- **Run all** — the whole dataset, from a reset if it declares one.
- **Run from here** — this step and everything after it.
- **Run this step** — one step alone.

The last two reuse the variables the previous full run captured, including
`{{run}}` — so replaying a step really replays it, rather than pairing an old
payment id with a fresh idempotency key. Runs started mid-dataset are marked
`partial`, because a green partial run proves less than a green full one.

---

## Layout

```
packages/
  core/              types only — no React, no driver, no MCP
  expr/              the selector language: parser, evaluator, exact decimals
  db-postgres/       the mvcc-xmin capture engine
  http-runner/       no retries, no redirect-following, by default
  scenario-engine/   sequencing, variables, assertions, promote, save
apps/
  runtime/           local HTTP API + static UI, 127.0.0.1 only
  web/               three-column UI, no bundler
```

`core` holds contracts and nothing else. v0.1 is deliberately relational and
Postgres-shaped rather than pretending to a database-neutral value model it
cannot honestly provide — a document store will be a new ChangeSet variant, not
this one wearing a disguise.

## Tests

```bash
pnpm test
```

The expression layer and the engine run on fakes. The capture engine runs
against a real PostgreSQL, because its whole claim rests on how MVCC actually
behaves and a mock would only restate the assumptions back. Point it wherever
you like:

```bash
STATESCOPE_TEST_DATABASE_URL=postgresql://... pnpm test
```

Those integration tests skip cleanly when no database is reachable, so the suite
stays green on a machine without one.

## Security

The runtime holds write credentials for your development database and answers
HTTP on localhost — which every page in your browser can reach, and which DNS
rebinding gets past the same-origin policy. So:

- binds `127.0.0.1`, never `0.0.0.0`
- a random token per start, required on every request
- `Host` header allow-list — this is what stops DNS rebinding; checking `Origin`
  alone does not
- `Origin` allow-list on top

Masking happens at capture, before a value is ever stored or serialised — not at
render time, which would leak into run history, `--json` output and CI reports.

The token is also written to `~/.statescope/sessions/<port>.json`, mode 0600, so
`pnpm url` can recover it after the terminal is gone. That file is deleted on a
clean shutdown, and a stale one left by a crash is discarded on read rather than
handed back as a dead URL.

## Status

Pre-v0.1, working end to end: capture, the expression language, scenarios,
run / run-from-here / run-one-step, observe-and-promote, the UI.

Not yet built: run history, the CLI, WhoDB integration, dashboard plugins, MCP.
The capture engine is `mvcc-xmin` only — `snapshot-diff` and `wal` are declared
in the ChangeSet contract but not yet implemented, which is the point of having
the contract.

## Licence

MIT

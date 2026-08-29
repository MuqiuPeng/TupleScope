# TupleScope

**Run backend scenarios. See exactly what changed.**

Postman shows you what your API returned. TupleScope shows you what it *wrote*.

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

Node 22 or newer and pnpm 9. You do **not** need PostgreSQL installed — the
example brings its own, as a platform binary pnpm fetches (about 51 MB over the
wire on macOS, 23 MB on Linux). Point TupleScope at your own database and none
of that is used.

```bash
pnpm install && pnpm build
export PATH="$PWD/node_modules/.bin:$PATH"   # this shell only; nothing goes global
```

### Run the example

Three terminals. The database is embedded — no Docker, nothing to install, and
no password: it listens on loopback only and holds nothing but fictional money.

```bash
pnpm demo:db                   # PostgreSQL on :7432, creating demobank and shopfront
pnpm demo:api                  # the API under test, on :7421
```

```bash
cd examples/demo-bank

tuplescope status              # does this workspace point at something that answers?
tuplescope ls                  # every scenario and dataset
tuplescope run                 # all of them
tuplescope run refund/happy    # one dataset
```

`tuplescope show <target>` prints a scenario in detail before you run it,
`tuplescope runs` lists the runs it kept and `tuplescope runs show <id>`
re-renders one, `tuplescope url` prints a running runtime's URL with its token,
and `tuplescope handoff` binds a database tool of yours to a row. `--help` is
the full surface; `--config <path>` picks a workspace file directly.

There is a second example, `examples/shopfront`, which exists to prove the same
runtime and engine serve a different schema. It has no database of its own —
`pnpm demo:db` creates both — so start that first, then:

```bash
pnpm demo:shop                 # the second API, on :7423

cd examples/shopfront
tuplescope run
```

**It fails on purpose, and that is the demonstration.** Its `after_checkout`
dataset adds an item to a cart that is already checked out. The API answers
`201`, writes the row anyway, and the run exits 1 — `expected false, got true`
on `hasWrite(changes(cart_items))`. A second check comes back undecided rather
than green: `writeCount()` needs the order the writes happened in, and the
default `mvcc-xmin` engine records where each row ended up, not how it got
there. Guessing would have been the easy answer and the wrong one.

### Point it at your own backend

From the repository root — the two commands above left you in an example:

```bash
cd ../..                                     # back to the root, if you ran the example
cp tuplescope.example.yaml tuplescope.yaml   # your API and your dev database
mkdir scenarios                              # where your own scenarios go
```

`scenariosDir` starts empty: there is nothing to `run` until you write a
scenario, and the section below is where that starts.

Every port above is a default, not a requirement. `DEMO_BANK_DB_PORT`,
`DEMO_BANK_PORT`, `SHOPFRONT_PORT` and `TUPLESCOPE_PORT` move the services;
`DEMO_BANK_BASE_URL`, `DEMO_BANK_DATABASE_URL` and the `SHOPFRONT_` pair move
what TupleScope points at. Set both halves — a service on a new port that
nothing is looking at is the confusing half of the job.

### The UI

For reading a diff and keeping what you see as an assertion:

```bash
pnpm start                     # stays in the foreground — leave it running
open "$(pnpm -s url)"          # in another terminal: the running instance, token and all
```

### In CI

```yaml
- run: pnpm exec tuplescope check                # before anything runs
- run: pnpm exec tuplescope run --junit results.xml
```

`check` resolves every name an assertion uses — tables, and the columns inside
`.where(...)` and `rows(...)` — against the live schema, without sending a
request. The columns matter more than they look. A predicate is only read when
there is a row to read it against, so on a step that correctly writes nothing
`count(inserted(refunds).where(nmae = "x")) == 0` is *true*, and stays green for
as long as the typo lives. That is the shape of a "must not write twice" guard,
which is the assertion this tool exists to make; `check` is where it is caught,
because `check` holds a connection and depends on no rows. Sharded? `tuplescope report shard-*.json --junit merged.xml` folds
them into one verdict, keeping the worst — a shard's problem cannot be washed
out by another shard's green.

| exit | meaning |
|---|---|
| 0 | every check evaluated and passed |
| 1 | a check failed — the system under test is wrong |
| 2 | a step could not be executed |
| 3 | **undecided** — it ran, nothing failed, but something was never checked |
| 4 | bad invocation, or a workspace that will not load |
| 5 | this workspace has no scenarios to run |

`3` is the one that matters. An assertion that could not be *decided* — a
mutation count against a value-comparing engine, a `single()` that matched
three rows, a misspelled table name — is neither a pass nor a failure, and in
CI nothing but the exit code is ever read. Merging it into `0` would make the
build green on a check that never happened; merging it into `1` would make
"open a bug against the backend" ambiguous, since a scenario that used to pass
has opposite owners depending on whether the endpoint regressed or somebody
narrowed the watch scope.

`--unevaluable=warn` opts out, and says so in the summary and in the envelope.

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
          - response.status == 200
          - hasWrite(changes(*)) == false              # the retry wrote nothing
```

Two things in there are load-bearing.

`{{run}}` is a per-run suffix that keeps idempotency keys unique between runs.
Without it a dataset passes once and then replays its own previous key.

And the `response.status` line above the `hasWrite` one is not decoration. An
assertion about what was *not* written is evidence only if the request reached
the handler — over a 401 nothing was written because nothing ran. TupleScope
will not let that pass silently (a step that returns 4xx or 5xx without
declaring `expectStatus` fails on its own), but stating the status you expect
is what makes the scenario say out loud which of the two it means.

---

## What makes it different

### It detects writes, not value differences

The obvious way to see what an API changed is to snapshot the tables before and
after and compare. TupleScope does not do that, because a value comparison
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

In the terminal that is `tuplescope keep`, which reads a stored run rather than
only the one still in memory — promoting should not require you to have noticed
in the same breath as the run:

```bash
$ tuplescope keep refund/happy refund
   1  response.status == 200  (already kept)
   6  single(updated(payments, id = {{payment_id}})).after.status == "REFUNDED"
      payments.status becomes REFUNDED (was COMPLETED)

$ tuplescope keep refund/happy refund 6
  kept  single(updated(payments, id = {{payment_id}})).after.status == "REFUNDED"
```

Generated ids are never baked in: a candidate whose value matches something the
run captured comes out as `{{payment_id}}`, not `pay_ltx3k01`. And the write is
a textual splice, so the file comes back with one line added and nothing else
reformatted — no unfolded block scalars, no re-padded flow collections.

### Assertions say which side they mean

`payments.status` on its own is ambiguous — which row, before or after? — so the
language makes you say:

```yaml
- after(single(rows(payments, id = {{payment_id}})).status) == "REFUNDED"
- count(inserted(ledger_entries).where(type = "REVERSAL")) == 2
- delta(single(rows(wallets, id = "wal_alice")).balance) == "100.00"
- sum(delta(wallets.balance)) == "0.00"
- hasWrite(changes(*)) == false
```

The same expressions will drive declarative dashboards, so there is one
evaluator, not two.

### `rows()` reads the rows, not the changes

Four selectors ask about what a request did — `changes`, `inserted`, `updated`,
`deleted`. One asks about what is there:

```yaml
- count(rows(wallets, id = "wal_alice")) == 1
- delta(single(rows(wallets, id = "wal_alice")).balance) == "-100.00"
```

`rows(...)` matches rows whether or not the step wrote them, so it reads the
database — through the same adapter as everything else, so `maskColumns` applies
to it too. A row it finds that nothing wrote has the same value on both sides,
and a `delta` over it is `0.00`, which is what happened.

Where the rows cannot be read, it says so and refuses. It does **not** fall back
to answering from the change set: that made `rows` a synonym for `changes`, and
`count(rows(wallets, id = "wal_alice")) == 0` passed over a wallet that was
plainly there — the same shape as an assertion about a misspelled table finding
nothing and calling that proof.

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

### The whole row is already there

The capture reads `SELECT *`, so every column of a changed row is in the report
— the diff shows the ones that moved and keeps the rest a click away, with the
statement that addresses exactly that row:

```sql
SELECT * FROM "public"."wallets" WHERE "id" = 'wal_alice';
```

TupleScope has the row, both images, the
key and the types, so the questions that follow a diff are answered where the
diff is; and a browser reached from here would connect as the same role and
render `card_number` in the clear, because masking happens at capture and no
second tool can inherit it.

When you do want the row open in a database tool, `tuplescope handoff` binds
one — Adminer over a URL, or your own `psql` through a `pg_service` entry — and
every addressable row grows an **Open in…** control. The binding lives in
`~/.tuplescope/handoff.json` at mode 0600 and no project can write it: a tool
reached this way connects as its own role and is not bound by `maskColumns`,
which is a decision only the person at the keyboard can make.

For anything else, paste that `SELECT` into whatever client you already have
open.

Of the browsers surveyed, only Adminer can address a table and a row from a URL
— WhoDB and pgweb both keep the selection in front-end state, so a link lands
on whatever the reader last looked at, which is worse than no link.

### It tells you when the rows might not be yours

Before each run it watches an idle window. Background jobs, session sweepers and
outbox pollers are ordinary in a running dev stack, and rows they write would
otherwise be blamed on your API. If anything writes during that window, the
report says so.

---

## Credentials

The workspace file is committed. Credentials are not in it.

```yaml
identities:
  - id: alice
    header: { name: authorization, value: "Bearer ${secret:alice_token}" }

database:
  connectionString: "postgresql://app:${secret:db_password}@localhost/shop"
```

```bash
tuplescope secret set alice_token
```

The value goes to the operating system's own credential store — the macOS
Keychain today — and the file holds only the name.

### Three kinds of value, and a boundary between two of them

| written | resolved from |
| --- | --- |
| `Bearer cus_alice` | itself |
| `${API_TOKEN}`, `${PORT:-7432}` | the environment, and only the environment |
| `${secret:alice_token}` | the secret store, and only the secret store |

**`${secret:x}` never falls back to environment variable `x`.** That would make
a credential's origin depend on what happened to be exported — arriving from
the keyring on one machine and the environment on another, with nothing to say
which. To read the environment deliberately, write `${SOME_VAR}`.

A placeholder in a form neither grammar recognises is an **error**, not a
literal. `${SECRET:x}` and `${secret: x}` are refused by name, because the
alternative is those characters being sent to the API and coming back as an
authentication failure.

`${secret:x:-something}` is refused too: a default for a secret is a credential
written into the file, which is the one thing the syntax exists to avoid.

### The commands

```
tuplescope secret set <name>      store a value, from the terminal or a pipe
tuplescope secret get <name>      whether it is configured; --show to print it
tuplescope secret list            every secret this tool stored on this machine
tuplescope secret delete <name>
```

`get` prints `alice_token  configured`, not the value. A credential is in a
keychain rather than a file so that displaying it is a deliberate act, and a
command whose everyday use puts a bearer token in terminal scrollback has moved
it somewhere no less public. `--show` exists and says what it is doing.

`set` never takes the value as an argument — a `--value` flag would write the
credential into the shell's history file and show it in `ps`. It reads from the
terminal with the echo off, or from a pipe when there is no terminal.

`tuplescope status` reports what is missing without reading anything:

```
  secrets   ✓ alice_token
            ✗ db_password — not configured; `tuplescope secret set db_password`
```

### When there is no store

It says so. It does not write the credentials somewhere convenient:

```
Secret store unavailable: there is no credential store for freebsd
Use environment variables with `${VAR}`.
```

A tool that answers a missing keyring by creating `.tuplescope/secrets.json`
has kept the syntax and thrown away the only promise it makes. There is a test
that fails if anything in the secrets package learns to write a file.

### What it does and does not protect

A resolved credential is held in a wrapper whose `toString`, `JSON.stringify`
and `util.inspect` all yield `[secret alice_token]`, so it does not leak by
being incidentally formatted into a report, a JUnit file or an MCP result. For
text this tool did not format — a driver reporting an authentication failure
with the whole connection string in the message — the values are substituted
back out.

What it does not do is scrub the heap. V8 copies and interns strings; a
credential that has been a JavaScript string cannot be reliably erased, and a
wrapper claiming otherwise would be theatre.

### Backends

| | how | verified |
| --- | --- | --- |
| macOS | `/usr/bin/security` | yes, against the real Keychain |
| Linux | `secret-tool` (libsecret) | yes, in a Debian container |
| Windows | PowerShell + a `CredReadW` shim | **no — see below** |

Nothing shipped with Windows can read a stored password back: `cmdkey` writes
and deletes but its documentation says outright that passwords are not
displayed afterwards, and there is no Credential Manager API in the .NET base
class library. The only route without a native module is PowerShell compiling a
`DllImport` shim at runtime, which works on a stock install and does not work
under Constrained Language Mode or some endpoint-protection policies.

Because that cannot be tested from here, and because neither it nor Linux can
be checked by asking, **both establish availability by using the store** — they
write a throwaway value, read it back, compare it and remove it. A backend that
cannot prove it works reports itself unavailable instead of failing later with a
credential in play. On Linux this also resolves a genuine ambiguity: `secret-tool
lookup` returns the same empty exit 1 for "nothing stored" and for "no
collection has ever been unlocked", so believing the first would tell a
developer on a headless machine to set a secret that cannot be set.

A stored item carries a `tuplescope.v1:` marker. Without it, a credential typed
into Keychain Access by hand decodes as eleven bytes of binary and every check
reports it configured — measured — and the API then rejects a value nobody can
see is wrong.

### One machine, several projects

A credential is stored under the workspace it belongs to, so two checkouts that
both refer to `api_token` do not share a value — a collision that would look
exactly like a correct setup, because the second `set` prints what a first-time
store prints.

The slot comes from the workspace's `name`, which is already required and
already committed, so nothing has to be edited. Override it when two projects
share a name, or when renaming a workspace should not orphan its credentials:

```yaml
secrets:
  namespace: my_project
```

`secret list` shows only this workspace's, and says whose they are. Deleting one
project's cannot touch another's.

Because secrets belong to a workspace, `tuplescope secret …` needs one — run it
from a directory with a `tuplescope.yaml`, or pass `--config`.

### Not yet

Scenario files do not resolve secret references — `identities` is where
authentication belongs — and a reference written into one is refused with a
message saying so rather than being sent verbatim.

---

## Capture engines

How TupleScope watches the database is pluggable, and the choice is one line of
`tuplescope.yaml`. Everything downstream — assertions, the diff you read, the
JUnit file, the MCP results — is written against the `ChangeSet` contract and
never learns which engine produced it.

```yaml
engine: mvcc-xmin   # the default; omit it and you get this
```

|                   | detects              | knows the order | setup                       | cost per step        |
| ----------------- | -------------------- | --------------- | --------------------------- | -------------------- |
| **mvcc-xmin**     | writes               | no              | none                        | a few kB read        |
| **snapshot-diff** | value changes only   | no              | none                        | every watched table, twice |
| **wal**           | writes               | yes             | `wal_level = logical`       | a few kB, plus a WAL flush wait |

**mvcc-xmin** is the default and the one to want. It holds one `REPEATABLE READ`
transaction open across the request and asks Postgres which rows were written
during it, then recovers the previous version of each from that same
transaction — MVCC is the time machine. It sees `UPDATE t SET x = x`, which is
what an idempotency check actually needs.

It reads nothing from the watched tables until the step is over. That is not an
optimisation: a scan taken *before* the step holds `ACCESS SHARE` on every
watched table for the whole window, and a `TRUNCATE` inside the step then waits
for it — measured, the capture died on its idle-in-transaction timeout instead
of reporting anything. The snapshot is frozen either way, so reading afterwards
gives the same answer and lets the step do what it came to do.

A table rewritten mid-step — `TRUNCATE`, `VACUUM FULL`, `CLUSTER`, a rewriting
`ALTER TABLE` — takes the observer's view of it along: PostgreSQL hands an older
snapshot a truncated table as *empty* rather than raising. Both MVCC-based
engines watch `relfilenode` on each side of the window and report
`scope-truncated` when it moves, which makes the run `undecided`. Losing rows is
survivable; losing them quietly is not.

**snapshot-diff** reads every watched table before and after and compares. It is
the reference implementation: small enough to read in one sitting. It cannot see
a write that changed no value, and says so — `hasWrite(...)` and
`count(updated(...))` come back **undecided** rather than false. Its one
advantage is that it holds no transaction open, which matters against a database
where a long-lived `REPEATABLE READ` is unwelcome.

**wal** reads the write-ahead log for *which rows were written, in what order,
by which transaction* — and then reads the values the same way mvcc-xmin does.
That split is not a compromise; it is what measurement forced. The values in a
decoded WAL stream disagree with what a `SELECT` returns (`false` where the row
reads `f`), name their types differently (`boolean` where the catalogue says
`bool`), replace a large untouched column with the literal
`unchanged-toast-datum`, and — under the default `REPLICA IDENTITY` — carry no
previous row at all. Taking values from SQL makes all four disappear.

Row identity and values come from the same code every engine uses, so the net
view is identical to mvcc-xmin's by construction rather than by a suite of tests
happening to agree. What the log adds is additive and lives in
`ChangeSet.mutations`: the order writes happened in, which transaction grouped
them, and rows inserted and deleted inside one transaction, which leave no row
version to find.

Two assertions can read it:

```yaml
- atomic(changes(*)) == true          # did my API do this in one transaction?
- writeCount(changes(wallets)) == 2   # writes, not changed rows
```

Against an engine that only kept the net view both come back **undecided**, with
the reason — never `false`. `atomic` is the question nothing else here can ask:
a handler that writes the payment and the ledger entry through two transactions
is one crash away from a half-written state, and every value-level assertion
about it passes. `writeCount` counts writes rather than rows, so a balance moved
`100 → 80 → 100` inside one request reads as one changed row and two writes.

It needs `wal_level = logical`, which is a server restart, and a role that is a
superuser or has `REPLICATION`. Both are checked before anything runs, so an
unmet prerequisite is reported as a configuration problem rather than arriving
mid-scenario as a driver error that reads like your API broke.

The window is fenced at both ends by LSN, and the slot is created *before* the
snapshot is frozen rather than after — whatever commits between the two is seen
by exactly one of them, and only this order lets the near edge be trimmed
exactly rather than leaving the mutation list quietly short.

It also waits for WAL to reach disk before decoding. On a database with
`synchronous_commit = off` — common on a developer machine, because it is faster
— a committed write is invisible to logical decoding for up to one
`wal_writer_delay`, and without the wait its rows surface in the *next* step,
attributed to the wrong request. Nothing is written to force the flush.

### The contract, and the test that keeps it honest

```ts
detection: 'write' | 'value'         // can it see a write that changed nothing?
fidelity:  'net'   | 'transactional' // did it keep the order and grouping?
```

Two axes, and neither subsumes the other — mvcc-xmin sits at `write`/`net`,
which no single axis describes. A consumer asks what an engine *can do*; it
never asks which engine it is. `packages/conformance` runs every engine through
the same cases and fails if two of them give a consumer different answers that
no declared capability explains, and `packages/core/src/abstraction.test.ts`
fails if any consumer compares `captureMethod` to a literal.

Adding the `wal` engine took one line in the engine registry and changed no
consumer. That is not a claim; it is what the suite checks.

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
  core/              types and the verdict — no React, no driver, no MCP
  expr/              the selector language: parser, evaluator, exact decimals
  db-postgres/       the three capture engines and the registry that names them
  http-runner/       no retries, no redirect-following, by default
  scenario-engine/   sequencing, variables, assertions, promote, save
  workspace/         config in, a running engine out — the composition root
  report/            the JSON envelope and the JUnit writer
  secrets/           credential references, and the stores that resolve them
  conformance/       every engine, the same cases, the same answers
  handoff/           a row into Adminer or psql, and the grant file a repo cannot write
apps/
  cli/               tuplescope(1) — drives the engine in-process
  mcp/               the agent surface, over stdio
  runtime/           local HTTP API + static UI, 127.0.0.1 only
  web/               three-column UI, no bundler
```

The CLI never talks to the runtime. CI has no server, and requiring one would
mean starting a web server, waiting on a health check and managing a token for
a localhost process the job just launched. `workspace` is what lets the CLI,
the runtime and MCP be three callers of one assembly rather than three
assemblies that drift.

`conformance` is where the engine abstraction is falsified rather than
asserted. Adding an engine means adding one entry to its registry; if the suite
still passes, the contract held, and if it does not, the honest conclusion is
that `ChangeSet` is missing an axis — never that a consumer needs to learn one
more engine name.

`core` holds the contracts, the verdict, and the one SQL renderer every surface
addresses a row through — a second renderer is a second quoting bug. v0.1 is
deliberately relational and
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
TUPLESCOPE_TEST_DATABASE_URL=postgresql://... pnpm test
```

Those integration tests skip cleanly when no database is reachable, so the suite
stays green on a machine without one. The `wal` engine additionally needs
`wal_level = logical`; where the server has not got it, that engine is skipped
and the reason is printed, because a suite quietly testing one fewer engine
while reporting green is the failure this package exists to prevent.

Type errors in test files are checked too — the runner strips types without
checking them, and the build excludes tests, so between the two a fixture could
carry any type error at all and nothing would say so:

```bash
pnpm typecheck
```

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

Credentials the workspace refers to are held in the operating system's own
store, never in the file that gets committed, and never written to disk by this
tool — see [Credentials](#credentials).

The token is also written to `~/.tuplescope/sessions/<port>.json`, mode 0600, so
`pnpm url` can recover it after the terminal is gone. That file is deleted on a
clean shutdown, and a stale one left by a crash is discarded on read rather than
handed back as a dead URL.

## For agents

```json
{ "mcpServers": { "tuplescope": { "command": "tuplescope-mcp" } } }
```

Twelve tools over the same engine everything else uses: describe the workspace,
list the tables, write a scenario, check it, run it, read what changed, keep the
assertions that run implies, run it again.

One thing shapes the whole surface. A run carries both `engineStatus` — whether
the steps executed — and a verdict, and they disagree: a run whose every
assertion was undecided has `engineStatus: "passed"`. An agent reads until it
finds something that looks like an answer, so every result leads with the
verdict in prose, and an undecided run opens with *this is NOT a pass and NOT a
failure*. The handshake instructions say the same thing before the first call,
and there are tests asserting they still do.

No shell, no process control, no arbitrary SQL. Scenario files are the only
thing writable, they are validated before they land, and keeping an assertion
appends one line.

## Status

Working end to end: capture on all three engines, the expression language,
scenarios, run / run-from-here / run-one-step, observe-and-promote, run history,
the secret store, row handoff, the CLI with JSON and JUnit, the UI, and MCP.

Not yet built: dashboard plugins, and any handoff preset beyond Adminer and
`psql`.

### Known issues

Found by a release check and shipped knowingly, worst first.

- **Two `tuplescope run` invocations against one workspace can deadlock.** The
  second's observer transaction holds a lock the first's `resetFirst` TRUNCATE
  waits on; one reports an unreachable backend and the other exits 1. Both
  blame the wrong thing. Run one at a time.
- **The scenario loader validates less than the types promise.** A step with no
  `name`, or a dataset with no `label`, passes `ls`, `check` and `show`, then
  fails `run` with a `TypeError`. A file that will not parse gets a stack trace
  and exit 2 rather than exit 4.
- **`baseUrl` is only checked for being a parseable URL.** A scheme typo such as
  `htp://` loads, and `status` then reports "nothing is listening" about a
  backend that is answering.
- **`--junit -` does not produce parseable XML** — the human summary is
  interleaved with it. Write to a path.
- **`tuplescope runs show <id>` prints the stored run as JSON.** The README and
  `--help` both call it a re-render; the text is wrong, not the command.
- **`tuplescope status` does not look at the scenarios directory,** so it can
  report a healthy workspace on which `ls`, `run` and `check` all exit 4. And
  `ls` over an empty directory prints the header and exits 0.
- **A workspace file cannot name a handoff alias.** Every alias is bound by the
  person at the keyboard. `tuplescope handoff --help` says otherwise; it is
  wrong.
- **`--config` works everywhere and appears in no help text.**
  `tuplescope url --all` is suggested by `url` and not accepted.
- **The runtime serves no Content-Security-Policy.** The loopback `Host` and
  `Origin` allowlists and the per-session token are what stand in for it; CSP
  is a prerequisite for dashboard plugins, which do not exist yet.
- **The demo's `pg_hba.conf` rewrite handles the shapes `initdb` writes.** A
  hand-edited file using the two-field `IP-address IP-mask` form, or line
  continuations, is rewritten in place without a backup.
- **The web UI reports a workspace that will not load as `connect ECONNREFUSED
  …`,** without naming the file or the key the CLI already names for the same
  fault.

## Licence

MIT

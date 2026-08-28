# Row handoff — design r2

*Types are normative; prose is not. §9 is now a record of what was built, and
§10 of where building it changed the design.*

r1 was reviewed and the direction approved, with five defects that had to close
before implementation. This revision closes them. Each is marked ▲ where it
appears, with what was measured.

| # | r1 defect | r2 |
|---|---|---|
| 1 | `DatabaseLocator` admitted `usable` + `location: unknown`; `cause` used a conditional type that resolves to a constant | §3 — location is required in every usable arm; `cause` derives from `Value` |
| 2 | Adminer's `pgsql=` had no defined source; `origin` is Adminer's own HTTP address, not PostgreSQL's | §4 — three independent addresses, measured; both enter the config type |
| 3 | psql guard used `<>`, which is NULL-bypassable | §6 — measured bypass; guard rewritten, and the schema half removed for a second measured reason |
| 4 | `handoff.json`, bindings and grants had no normative types | §5 |
| 5 | `unknown` conflated cell failure, truncation, and unchanged-TOAST | §2 — one of the three is not a `Value` state at all |

Interaction design was judged 50–60% complete. §7 is new.

---

## 1. What the repository may control, and what only the machine's user may

| Field | Who | Why |
|---|---|---|
| `handoff.target` — an **alias string** (`adminer`, `dev-psql`) | **Repo** (`statescope.yaml`) | A name is inert: it resolves to nothing until the user binds it, so an unbound alias is a refusal, not an action. |
| Which tables/rows the scenario touches | **Repo** | It is the repo's database and the repo's scenario; the locator is built only from what the API actually wrote. |
| `maskColumns`, `ignoreColumns`, `visibleColumns` | **Repo** | Redaction and noise policy are properties of the schema, and both only ever *remove* information. |
| Target **preset id** (`adminer-url` \| `psql-service`) | **User** (`~/.statescope/handoff.json`) | Which mechanism runs is the whole trust decision; a repo naming a preset directly is a repo choosing a program. |
| `executable` (resolved absolute path) | **User** | A config key whose value is a path to a program is a command-execution primitive (CVE-2022-24765). |
| `args` | **Neither — fixed literals in the preset** | Nothing interpolated into argv means a re-parsing `.exe` shim on Windows has nothing to inject. |
| `origin`, `server`, `username` for `adminer-url` | **User** | ▲ Three separate addresses, none derivable from the others — §4. |
| `service` for `psql-service` | **User** | This chooses which server the user's `~/.pgpass` credentials open. |
| Environment variables passed to the child | **User only, allow-listed** | `PSQLRC`, `PAGER`, `PGOPTIONS`, `LD_PRELOAD` each turn a child into an interpreter or a liar. |
| `confirmOutsideMasking` or any consent flag | **Nobody — the key does not exist** | A repo-committed consent flag is the repo author consenting on the user's behalf. |
| The grant record itself | **User**, `~/.statescope/handoff.json`, mode 0600 | Protected configuration, exactly as `git safe.directory` is ignored outside system/global scope. |

`statescope.yaml` therefore contributes **one string that is a key into user-level
config, and nothing else.** There is no `command:`, no `env:`, no `url:`, no
`service:`, no `path:`, no `server:`.

---

## 2. `Value`

▲ **Three states — and two things that are not states.**

r1 gave `unknown` three reasons: `not-read`, `truncated-scope`, `unreadable`.
Those are not three flavours of one thing. They differ in *what is missing*,
and a consumer that treats them alike gets the wrong answer for two of them.

| What went wrong | What is actually missing | Where it belongs |
|---|---|---|
| A cell could not be read | **this cell** | `Value` state `unknown` |
| The read stopped at a row limit | **whole rows you never saw** | not a `Value` at all — §2.1 |
| The WAL declined to carry an unchanged TOAST value | **nothing** — the before-image has it | repaired to `visible`; only if the before-image is also gone does it degrade to `unknown` |

Truncation is the one that matters most to get out of `Value`. Modelling it
per-cell says *"this cell is unknown"* when the truth is *"there are rows you
never saw, and every cell you can see is perfectly good."* Under the r1 model a
truncated read would either mark thousands of fully-readable cells `unknown`
(and make every assertion on them unevaluable, which is false) or mark none of
them (and let `count()` answer from a partial read, which is worse).

```ts
/**
 * A column value and whether this run actually has it.
 *   visible  value available            · did it change? yes
 *   masked   unavailable by choice      · did it change? yes
 *   unknown  unavailable by failure     · did it change? cannot say
 */
export type Value =
  | { state: 'visible'; pgType: string; text: string | null; parsed?: unknown }
  | { state: 'masked';  pgType: string }
  | { state: 'unknown'; pgType: string; reason: UnknownReason };

/** Cell-level failures only. Both are per-cell by construction. */
export type UnknownReason =
  /** A logical-decoding value the log did not carry, and no before-image to repair it from. */
  | 'toast-not-carried'
  /** The cell was read and could not be rendered as text. */
  | 'unreadable';

export function isVisible(v: Value): v is Extract<Value, { state: 'visible' }>;
export function requireText(v: Value, what: string): string | null; // else throws Unevaluable
```

`unknown` is not new; it exists today as *key absence* in `Row`, which is why
`row[col]?.text ?? null` cannot tell SQL NULL from never-read, and why
`promote.ts:32` promotes an unread column to the assertion `col == null`. Making
it a state converts an untyped `undefined` into a case the compiler demands.
Invariant, enforced in the conformance suite: **every `unknown` in a `Row` is
accompanied by a `CaptureWarning` naming the same table.** `masked` is never a
warning; it is what the user asked for.

### 2.1 Coverage — the thing truncation actually is

```ts
export interface TableCoverage {
  table: string;
  /** `partial` means rows are missing, not that any value is doubtful. */
  state: 'complete' | 'partial';
  /** Present when partial. */
  rowsRead?: number;
  limit?: number;
}
// on ChangeSet:
readonly coverage: ReadonlyArray<TableCoverage>;
```

Consequences, which are the point of separating it:

- Row-set answers over a `partial` table are **unevaluable**: `count`, `sum`,
  `min`, `max`, `isEmpty`, `any`, `single`. A count over a truncated read is a
  lower bound presented as a total.
- Cell answers on rows that *are* present stay **decided**. `after(single(rows(t,
  id = "x")).balance) == "9.00"` is a fact about a row that was read, and
  truncation elsewhere does not touch it.
- `hasWrite` over a partial table is decided when true (a write was seen) and
  unevaluable when false (the write may be past the limit). This asymmetry is
  the honest one: absence of evidence.

### 2.2 Rules

All of them consequences of one line: **masking is the absence of the
evaluator's access to a value.**

- **Assertions.** Any comparison whose answer depends on a non-`visible` value →
  `unevaluable` (already an observable status; already `error` by default).
  `==`, `!=`, `<`, `<=`, `>`, `>=`, `sum`, `min`, `max`, `delta`. `!=` must
  refuse *inside* `valuesEqual`, before negation — otherwise a suite of `!=`
  goes green because the evaluator can see nothing. No partial aggregates;
  `delta` never falls back to `Decimal.zero()`, which is the claim "nothing
  moved". `count`, `any`, `isEmpty`, `hasWrite`, `writeCount`, `atomic` read
  row-level facts and are unchanged by masking (but see §2.1 for coverage).
  Short-circuiting in `logical` stays: unevaluability is lazy, not sticky.
- **Two masked values.** Unevaluable. Not equal, not unequal. Masked is a
  *stronger* unknown than SQL NULL: NULL is a known absence, masked is an
  unknown presence.
- **Predicates.** `rows(users, email = "a@b.c")` on a masked column is
  unevaluable at **both** sites, refused before the query is issued. The
  server-side path *could* answer it — refuse anyway: equality against a masked
  column is an exfiltration oracle driven by a file that came from the repo, and
  a clause that means two things depending on which selector it hangs off is not
  auditable. The escape hatch is removing the column from `maskColumns`, which
  is visible in a diff.
- **Row identity.** A masked column cannot participate in identity. Prefer a
  candidate unique index with no masked column; if none,
  `keyStrategy: 'full-row-multiset'` plus a `degraded-row-identity` warning that
  names the real cause. Never fall back to the unmasked subset of a composite
  key. **Pair on raw, emit masked** — done, §9.
- **Promote.** `literalOf` returns `string | null`; `null` drops the candidate.
  No per-row candidates at all for a row with a masked key component (a
  predicate-less `single(updated(t))` is not a weaker true version, it is a
  false one). Skip the cross-row `sum(delta(...))` reducer if any contributing
  row is masked. Surface the withholding: *"3 candidates not offered:
  `users.email` is masked."* Invariant to test: every promoted candidate,
  replayed against the run it came from, evaluates to a decided pass.
- **`changedColumns`.** Computed on **raw text, before masking** — done, §9. A
  masked column that changed *is* in `changedColumns`; the card renders
  `card_number (masked, changed)`, never `•••••••• → ••••••••`. One bit per
  masked column per row leaks, and it must: suppressing the fact of change turns
  masking into blindness, and masking that costs correctness gets switched off.
  Users who cannot afford that bit already have `ignoreColumns`. No third
  setting.
- **Envelope.** `{"state":"masked","pgType":"text"}` — the absent `text` is the
  point: `v.text` is `undefined` in JS and a `KeyError` in Python, instead of a
  bullet string written into a report. `state: 'visible'` is explicit, never
  implied. Wire-format break; bump `RUN_REPORT_SCHEMA`; **no compatibility shim
  emitting both**. JUnit prints `‹masked›`, not bullets, which read as a
  rendered password field.
- **`pgType` stays on all three arms.** It comes from the catalogue, is
  identical for every row, and is knowable from `\d`. Redacting a schema fact to
  protect a value fact is theatre — and today's shared `MASKED` constant makes a
  masked `numeric` lie about its type. `MASKED` becomes per-column.
  Deliberately absent from `masked`: `parsed`, length, hash, prefix, last-4.
  Each is an oracle and each will be requested.

---

## 3. `DatabaseLocator`

▲ r1 let `state: 'usable'` carry `location: { state: 'unknown' }`, so a consumer
could destructure a usable locator and find no database to address. And
`cause: Value['state'] extends never ? never : 'not-read' | …` is a conditional
whose test is never true, so it resolves to the constant on the right — it reads
like a derivation and is a hand-written literal that will drift from `Value`.

```ts
/** A place a statement can name. Not optional: a locator without one is unusable. */
export interface KnownLocation {
  readonly database: string;
  readonly schema: string;
}

export interface KeyPredicate {
  readonly columns: readonly {
    readonly name: string;
    readonly pgType: string;
    readonly text: string | null;
    readonly op: '=' | 'is-not-distinct-from';
  }[];
}

export type DatabaseLocator =
  /** The row is there. Open it. */
  | { state: 'usable';        location: KnownLocation; table: string; key: KeyPredicate }
  /** The address is exact and the row is gone. Opening it is still correct. */
  | { state: 'usable-absent'; location: KnownLocation; table: string; key: KeyPredicate;
      kind: 'delete' | 'left-scope' }
  | { state: 'unavailable';   reason: LocatorUnavailable };

export type LocatorUnavailable =
  | { reason: 'masked-key';             columns: readonly string[] }
  /** Derived, so it cannot drift from Value. */
  | { reason: 'unknown-value';          columns: readonly string[]; cause: UnknownReason }
  | { reason: 'no-stable-key';          keyStrategy: KeyStrategy }
  | { reason: 'key-not-introspectable'; detail: 'expression-index' | 'partial-index' }
  | { reason: 'location-unknown' }
  /** Set by a target, not by core — §4. */
  | { reason: 'target-cannot-address';  target: string; detail: string };

export function explain(r: LocatorUnavailable): string; // one sentence, cause + fix
```

Two usable arms rather than one arm with a `presence` field: a consumer that
forgets the absent case must fail to compile, not silently render an empty
table. An empty page reads as a broken handoff, which is the failure this arm
exists to prevent.

`key-not-unique` is gone from r1's list. It described a state that can no longer
be constructed: `readTableIdentities` now rejects an index whole rather than
narrowing it, so a key is either unique or absent (§9).

**No SQL text in the locator.** A statement is a value *plus* session GUCs the
locator by definition cannot see: the same `SELECT` returns 1 row or 0 depending
on `standard_conforming_strings`, and a `timestamptz` rendered under
`DateStyle=SQL,DMY` selects a *different row* in a default session. Core owns
one exported renderer (`quoteIdent`, `quoteLiteral`, `renderPredicate`) that
every target and the copy-SELECT button import; the two existing implementations
(`rows.ts`, `app.js`) collapse into it, taking the `= NULL` bug with them.

**Where each field comes from.** `location` from `readLocation()` at
`fullScope()` — `current_schema()` + `current_database()` on the same connection
every capture query uses, carried through to the report envelope's `scope`
(done, §9; `'public'` is not a safe default, since stock `"$user", public` makes
`current_schema()` role-dependent). `table` and `key.columns` from the
`RowChange` the card is rendering, never from a config-supplied table name.
`pgType` from the catalogue. `op` chosen by the builder:
`is-not-distinct-from` when `text === null`. The locator carries the **key
only** — never `TableScope.where`, because a `left-scope` row is precisely the
row the watch predicate now excludes.

**Capture must be pinned or the text is not portable**: every capture connection
sets `DateStyle=ISO,MDY TimeZone=UTC bytea_output=hex IntervalStyle=iso_8601
extra_float_digits=1`. StateScope pins none of these today. §4 has the
measurement that makes this load-bearing rather than defensive.

---

## 4. Targets, and the three addresses

▲ The r1 example URL contained `pgsql=127.0.0.1:5432` and the design never said
where that came from. It is not `origin`, and it is not StateScope's own DSN
host. Measured, with StateScope on the host and both Adminer and PostgreSQL in
containers:

| | Address | Who knows it |
|---|---|---|
| Adminer's HTTP origin — where the browser goes | `http://127.0.0.1:7442` | user |
| PostgreSQL **as StateScope reaches it** | `127.0.0.1:7441` | StateScope's DSN |
| PostgreSQL **as Adminer reaches it** → `pgsql=` | `172.17.0.3:5432` | **user only** |

The third is not derivable from the second. `127.0.0.1:7441` means nothing
inside the Adminer container, and the divergence is the *normal* case for any
Docker Compose stack, not an edge one. So `server` is a user-config field.

Measured on the same stack, so is `username`: Adminer keys its session on
`(driver, server, username, db)`, and a URL with the wrong username — or none —
renders the **login page**. StateScope knows a username from its own DSN, but
the role Adminer is logged in as may differ, and the DSN is the thing this
design refuses to hand out. It comes from the binding.

**What Adminer can address.** r1 guessed "text/numeric/uuid/date/bool only".
Measured against Adminer 5, every one of these matched the seeded row by
equality on its wire text: `bytea` (`\x0102`), `timestamptz`
(`2024-03-01 12:00:00+00`), `uuid`, `numeric`, `boolean` (both `true` and `t`),
values containing `'` and `&`, and values containing a newline. So the capability
predicate is **not a type allow-list**. It is one requirement and two limits:

- **Requirement: the text must be the wire text produced under the pinned
  GUCs.** `timestamptz` matched because the rendering carried an explicit `+00`
  offset. Under an unpinned `DateStyle` it addresses a different row. This is
  what §3's GUC pinning buys, and the only reason it is not a guess.
- **Limit: NULL.** Adminer's operator vocabulary is
  `= < > <= >= != ~ ~* !~ LIKE ILIKE IN IS NULL NOT LIKE NOT ILIKE NOT IN IS NOT NULL SQL`.
  There is no `IS NOT DISTINCT FROM`. It needs none: that operator differs from
  `=` only when a side is NULL, and `IS NULL` is exact for that case.
  `op: 'is-not-distinct-from'` maps to `IS NULL` (no `val`) when `text === null`
  and to `=` otherwise. `op==` with an empty `val` matches **no rows** —
  measured — which is the `= NULL` bug wearing a URL.
- **Limit: length.** A 4000-character key produced a 4166-character URL that
  Adminer served correctly, but the ceiling belongs to the browser and any
  intermediary, not to Adminer. Cap the rendered URL and return
  `target-cannot-address` above it, rather than emit a URL something may
  truncate in silence.

**`op=SQL` is never emitted.** Adminer accepts an `SQL` operator whose value is
spliced into the WHERE clause. A URL builder that can reach it is an injection
primitive. The renderer's `op` type has two members and neither is it.

**`psql-service`** is unchanged in kind: not an interactive session. StateScope
spawns, sends SQL on stdin, and renders captured stdout. Interpolated into
**argv: nothing.** Into **env: the service name only.** Into **stdin:**
identifiers via `quoteIdent`, values via `quoteLiteral` (single quotes doubled;
`E'…'` with doubled backslashes whenever a backslash is present, so it is
correct under either `standard_conforming_strings`; NUL refused). Correct
escaping is what stops a seeded key value from reaching backslash-meta-command
position — `-X` disables `psqlrc`, it does **not** disable `\!` read from stdin.

```ts
spawn('/opt/homebrew/bin/psql',
  ['--no-psqlrc','--no-password','--set=ON_ERROR_STOP=1','--pset=pager=off','--quiet','--file=-'],
  { shell: false, windowsVerbatimArguments: false, windowsHide: true,
    detached: process.platform !== 'win32',        // no controlling tty ⇒ libpq cannot prompt
    cwd: os.homedir(),                              // never the workspace
    env: { PGSERVICE: 'shop-local', PATH: <built>, HOME, LC_ALL: 'C', PGCONNECT_TIMEOUT: '10' },
    stdio: ['pipe','pipe','pipe'] });
```

Stdout/stderr consumers attach **before** the first stdin byte; `stdin` has an
`'error'` handler (`EPIPE` is information, not a crash); 15 s timeout, `SIGTERM`
then `SIGKILL` to the process **group**; output capped and truncated-with-kill;
kill in `finally`. Windows: resolved path must end `.exe`, refused otherwise.
Executable resolved **once, at `handoff enable`**, against a PATH StateScope
builds (system dirs + user-named dirs, never `node_modules/.bin`, never the
workspace); the absolute path and its `realpath` are stored and re-checked at
spawn.

---

## 5. `~/.statescope/handoff.json` — normative

▲ r1 showed a JSON example and no type.

```ts
export const HANDOFF_CONFIG_VERSION = 1;
export const HANDOFF_POLICY_VERSION = 1;

export interface HandoffConfigV1 {
  readonly v: 1;
  /** Keyed by alias — the one string statescope.yaml is allowed to contribute. */
  readonly bindings: Readonly<Record<string, Binding>>;
}

export type Binding = AdminerBinding | PsqlServiceBinding;

interface BindingCommon {
  /** Realpath'd workspace roots this binding is granted to. Never a glob. */
  readonly grants: readonly WorkspaceGrant[];
}

export interface AdminerBinding extends BindingCommon {
  readonly preset: 'adminer-url';
  /** Where the browser goes. Origin only: scheme + host + port, no path, no query. */
  readonly origin: string;
  /** ▲ PostgreSQL as *Adminer* reaches it — `hostname[:port]`. Not StateScope's DSN host. */
  readonly server: string;
  /** ▲ The role Adminer is logged in as. Part of Adminer's session key. */
  readonly username: string;
}

export interface PsqlServiceBinding extends BindingCommon {
  readonly preset: 'psql-service';
  /** A key in pg_service.conf. StateScope never reads the file. */
  readonly service: string;
  /** Absolute, resolved at enable time. */
  readonly executable: string;
  /** realpath(executable) at enable time; re-checked at spawn. */
  readonly realpath: string;
}

export interface WorkspaceGrant {
  /** realpath(workspaceRoot). A symlink or worktree cannot alias in. */
  readonly workspace: string;
  readonly approvedAt: string;   // ISO 8601
  readonly approvedBy: string;   // os.userInfo().username
  /** Bumped when StateScope widens what a preset may do. A bump re-refuses. */
  readonly policyVersion: number;
}
```

Validation, all refusals rather than coercions: `v` must be exactly `1`; alias
matches `/^[a-z][a-z0-9-]{0,31}$/`; `service` matches
`/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`; `server` matches
`/^[A-Za-z0-9._-]{1,253}(:\d{1,5})?$/`; `username` matches
`/^[^\x00-\x1f\/?#&=]{1,63}$/`; `origin` parses as a URL with empty path, no
query, no fragment, and a loopback host unless `--i-know-this-is-not-local` was
given, which also prints a banner on every use. An unknown `preset` is a
refusal, not a skip. The file is written only by `statescope handoff enable`,
mode 0600, via write-temp-then-rename.

**A grant is keyed on the whole tuple**
`(workspace, alias, preset, origin|service, server|executable, username|realpath, policyVersion)`.
The record filename derives from the full key, never a leaf label — that is
mise's collision bug. Never keyed on `config.name` or `secrets.namespace`, both
of which are repo-written.

**Invalidated by:** the alias being absent or bound differently; a changed
origin, server, username, service, executable path, or executable realpath; a
different workspace path; a `policyVersion` bump. **Not** invalidated by editing
`statescope.yaml` — a changed target name is an *unbound alias*, which re-refuses
by absence. No hash of the project config, so editing a scenario, an assertion,
or `maskColumns` re-asks nothing.

---

## 6. The psql guard

▲ r1's guard was `current_database() <> 'demobank' OR current_schema() <> 'public'`.
Two separate defects, both measured.

**It is NULL-bypassable.** `current_schema()` is NULL when `search_path` names
nothing that exists. Then `current_schema() <> 'public'` is NULL, the `IF` does
not fire, and the statement runs. Measured on PostgreSQL 16, connected to the
database the locator names:

```
SET search_path = does_not_exist;
DO $$ BEGIN IF current_database() <> 'demobank' OR current_schema() <> 'public'
  THEN RAISE EXCEPTION 'guard fired'; END IF; END $$;
SELECT * FROM "public"."wallets" WHERE "id" = 'wal_alice';
→ no exception; the row came back
```

**And the schema half should not exist.** The same run shows why: the SELECT is
schema-qualified, so it found the right row *despite* the broken `search_path`.
Qualification already makes `search_path` irrelevant to which table is read. A
`current_schema()` comparison therefore buys nothing for correctness — and costs
something real, because it **refuses a working connection**: a `pg_service`
entry that legitimately sets `search_path = other` would be rejected even though
its qualified statement is correct. Measured: under `search_path = other`,
`SELECT id FROM "public"."wallets" WHERE "id" = 'wal_alice'` returns the row.

What the schema half was reaching for is a different question — *is the table
the locator names actually here?* — and `to_regclass` answers it exactly,
independent of `search_path`, returning NULL for both a missing table and a
missing schema. Measured: `to_regclass('"public"."wallets"')` → `public.wallets`;
`'"public"."nope"'` and `'"nosuch"."wallets"'` → NULL, under a broken
`search_path`.

```sql
DO $$ BEGIN
  IF current_database() IS DISTINCT FROM 'demobank' THEN
    RAISE EXCEPTION 'StateScope: this connection is database %, but the locator names demobank',
      current_database();
  END IF;
  IF to_regclass('"public"."wallets"') IS NULL THEN
    RAISE EXCEPTION 'StateScope: database % has no table public.wallets', current_database();
  END IF;
END $$;
SELECT * FROM "public"."wallets" WHERE "id" = 'wal_alice';
```

`IS DISTINCT FROM` on the database check even though `current_database()` is
never NULL (measured): the rule is *never compare with `=` or `<>` against
anything that could be NULL*, and a rule with a hand-audited exception list is a
rule that fails the next time the list is not re-audited.

The database check is what makes `database` load-bearing: a service name is the
one thing the user picked blind, and dev clusters routinely hold `shop`,
`shop_test`, `shop_shadow` with identical schemas. The `to_regclass` check
separates *"connected to the right place, table not there"* from *"query
returned no rows"* — two states that otherwise render identically as an empty
result.

---

## 7. Interaction model

▲ New. r1 designed one row and assumed it would scale. It does not: the shipped
demo produces up to 22 rows over 4 tables, and r1 gives each of them a button, a
static disclosure line, an inline `explain()` for the unusable case, and an
inline output block for psql. With two targets bound that is 44 buttons and, on
first use, 44 copies of the same authorisation text.

Four rules, each fixing one of those.

**One control per row.** A single split button — `Inspect ▾` — not one button
per target. The primary action is the workspace's default target; the chevron
opens a menu with every bound target, `Copy SELECT`, and (always) `Enable a
target…`. With zero targets bound the control is still there and still says
`Inspect ▾`; the menu is `Copy SELECT` plus `Enable a target…`. A row's control
never changes size or position based on how many targets exist, so the list does
not reflow when a binding is added.

**Reasons are earned, not shown.** An unusable locator keeps the control in
place, disabled, with a short chip naming the class only: `key masked`,
`no key`, `too long`. `explain()`'s full sentence appears in the menu and in the
title attribute — on demand, once, for the row the user asked about. Never
hidden (hiding loses the degraded-but-usable property), never refused on click
(that teaches the button is unreliable), never a paragraph in the list.

**Disclosure is per panel, not per row.** The static line r1 puts beside every
button appears once, in the changes-panel header, naming the current default
target:

```
Inspect → Adminer at 127.0.0.1:7442 as postgres · the key goes into browser history
```

It is one line whether the panel shows 1 row or 200, and it changes when the
default target changes, which is the only time it carries new information.

**Output never enters the list.** psql stdout renders in an **inspector** — a
separate panel below the list, with its own scroll, a `max-height`, and a header
naming the row it belongs to (`wallets · id = wal_alice`). The row list is not
touched, so **scroll position is preserved by construction** rather than by
saving and restoring it. Re-inspecting a different row replaces the inspector's
content; the list does not move. The inspector is dismissible and its state is
not persisted.

**First use is a drawer.** Not inline (it is long — it must show the full URL
and the disclosure, and inline it would push the entire list down and lose the
user's place), not a modal (a modal is a thing the mouse can complete, and the
whole point is that it cannot). A side drawer over the panel: it does not move
the list, it is dismissible with Escape, and dismissing it decides nothing. Its
only exit remains **a typed command**:

```
Open in Adminer  ·  not enabled on this machine

  This would open, in your default browser:

    http://127.0.0.1:7442/?pgsql=172.17.0.3&username=postgres&db=demobank&ns=public
      &select=wallets&where[0][col]=id&where[0][op]==&where[0][val]=wal_alice

  The key is in that URL, and the browser keeps it: history, address-bar
  autocomplete, and whatever this profile syncs. StateScope cannot take that
  back. Adminer connects with its own credentials, as you, and is not bound
  by maskColumns — it will show card_number in full.

  `adminer` is a name this repository chose. Bind it yourself, once:

    statescope handoff enable adminer-url --as adminer \
      --origin http://127.0.0.1:7442 --server 172.17.0.3 --username postgres

  Written to ~/.statescope/handoff.json, which this repository cannot write.
  statescope handoff list · statescope handoff disable
```

The `psql-service` variant names the resolved absolute executable, the service,
that it runs **as you, with your credentials**, and that the SQL goes on stdin
so the key never appears in `ps`.

**Later times: nothing.** The button opens the thing. The per-panel line is the
whole standing cost.

**Why no per-click dialog.** A modal on the shipped demo fires up to 22 times
per run; the value it would show is already printed by `keyLabel()` two
centimetres above the button; a "remember this" checkbox reaches a machine-wide
grant within four clicks, chosen mid-debugging; and the un-gated **Copy SELECT**
sits in the same menu, so a gate on its neighbour migrates disclosure from
browser history (~90 days, prunable) to a permanent, synced clipboard store. A
dialog here makes disclosure worse and spends the attention the one prompt that
matters needs.

**Non-interactive surfaces (MCP, non-TTY CLI, CI) do not have this capability at
all** — not a prompt that fails closed, not a `--yes`. They return the locator,
the SELECT text, and the `handoff enable` line. A confirmation on a surface
where the requester is a model reading the repo's own scenario file is a prompt
answering itself.

---

## 8. What this design does not protect against

- **Masking does not survive the jump. Say it in the prompt, the README, and the
  docs.** Every target connects as the user's own role and renders
  `card_number` in full. `maskColumns` is a capture-time control inside
  StateScope's boundary; no second tool can inherit it. The handoff reverses
  `README.md:293` ("StateScope does not launch a database browser") and that
  reversal belongs in the README, not in a surprise banner.
- **A refused handoff still leaks the key.** Measured: a URL with the wrong
  `username` renders Adminer's login page — and that page echoes the full
  request, key value included, into its own recent-links list. The disclosure
  happens when the URL is *opened*, not when it succeeds.
- **After the grant, every handoff in that workspace is silent** — including one
  to a table a hostile repo steered the scenario at. Mitigated only by building
  the locator from capture output rather than config, and by rendering the table
  on the card. Accepted, because per-row gating is the fatigue machine that
  drives users to the un-gated clipboard.
- **The row key already reaches sinks StateScope cannot reach into**: browser
  history, address-bar autocomplete, browser *sync* (loopback is not excluded),
  extensions with `tabs` permission, the target's access log, the clipboard and
  its managers, EDR/SIEM exec records, and — for every target including the copy
  button — the PostgreSQL server's own `log_statement`. Naming the sink is the
  whole mitigation.
- **Approving a program approves its ambient environment.** psql reads what its
  env and profile allow; a browser carries your sessions. `-X`, `-w`, and the
  filtered env narrow this; they do not close it.
- **TOCTOU between checking the executable and exec'ing it cannot be closed
  portably.** The stored realpath converts a substitution into a re-prompt; it
  does not prevent one.
- **The trust store is writable by anything running as the user.** Anyone with
  that access already has code execution. 0600, and a note not to sync
  `~/.statescope` in dotfiles.
- **A `.exe` that is really a shim** (Chocolatey, scoop, App Execution Aliases)
  can re-derive a command line internally. Undetectable; neutralised only by
  argv containing zero variable elements, which is why that rule is absolute.
- **Non-loopback origins are a different animal** and only ever reachable behind
  an explicit flag: an approved host can serve anything later, and DNS moves
  under a stable name.

---

## 9. What was built

All of it. 553 tests, none failing, none skipped, against a real PostgreSQL —
and, for the two targets, against a real Adminer over HTTP and a real `psql`
against a real database.

**Prerequisites, done before any of the handoff itself.** A precise address for
a row whose reported history is fiction is worse than no address at all.

1. **Pair on raw, emit masked.** Identity, `changedColumns` and the unkeyed
   census derive from raw result rows; only the reported images are redacted.
   Measured before: an update touching only a masked column reported
   `changedColumns: []`. Conformance case across all three engines.
2. **`readTableIdentities`.** An index qualifies whole or not at all. Measured
   before: `UNIQUE (row_no, seat)` with a nullable `seat` collapsed to `row_no`,
   and an UPDATE touching two rows came back as **one change with no warning**.
   Nine index shapes pinned.
3. **`schema` + `database` in the envelope.** Without them every locator built
   from run history is schema-less.

**The design's own list.**

4. **Capture GUCs pinned and *verified*.** `DateStyle`, `TimeZone`,
   `bytea_output`, `IntervalStyle`, `extra_float_digits`, set on connect and
   read back on the connection that reads values — pinning alone is a claim.
   Drift becomes a `rendering-not-pinned` warning and rides in `ChangeSet` and
   the envelope, so a consumer can check rather than trust. Measured through all
   three engines: `2024-03-01 12:00:00+00`, `P1DT2H`, `\x0102`.
5. **`Value` → a tagged union.** `visible | masked | unknown`, with `text`
   reachable only through the first. 90 compile errors across 9 packages, which
   is the point: every one was a site that had been reading a placeholder as
   data. Two live bugs fell out and were fixed — promotion offering
   `card_number == "••••••••"` as an assertion, and a masked primary key
   collapsing every row of a table to one correlation key. `RowKey.serialized`
   became `RowKey.token`, a salted per-run hash of the *real* key: distinct per
   row whatever is redacted, and useless as a locator.
6. **One SQL renderer, in core.** `quoteIdent`, `quoteLiteral`, `renderPredicate`,
   `renderSelect`, `renderGuard`. `E'…'` whenever a backslash is present —
   measured to match under `standard_conforming_strings` on *and* off, where
   plain quoting silently missed. NULL renders `IS NOT DISTINCT FROM`. The two
   old implementations are gone.
7. **`DatabaseLocator`** with `explain()`, and `handoffFor` composing locator +
   statement + portability for every surface.
8. **`statescope handoff enable / list / disable`** and `~/.statescope/handoff.json`
   at 0600, with `HandoffConfigV1`, per-workspace grants keyed on the whole
   tuple, and refusals rather than coercions.
9. **`adminer-url`** — every URL verified against a live Adminer 5 by opening it
   and checking the row that came back, including composite keys, `IS NULL`, and
   values containing `\'` and `&`. **`psql-service`** — verified against real
   `psql`: the guard catches a service pointing at the wrong database, and four
   separate attempts to escape from a key value into `\!`, a second statement,
   a backslash escape and `\gset` all failed, changed nothing, and never
   reached the shell.
10. **The interaction model.** One split control per row, the reason on demand,
    the disclosure once per panel, output in its own inspector, first use in a
    drawer whose only control is *Close*. Verified in a browser against a real
    run.

**Also fixed, found while doing the above.** The `rows(...)` selector silently
truncated at 500 — measured, `count(rows(events))` answered **500** for a
1200-row table. Reads now report `complete`, and every question about the *set*
refuses over a partial one while questions about a row that *was* read stay
decided. The report schema is `/2`; the version gate refused only newer files
and now refuses older ones too; run history refused to distinguish "no such run"
from "a run this build cannot read", and `latest()` silently skipped a stale
file and handed back an older one. Runs recorded through MCP carried no schema
at all and now do. `pnpm test` runs `tsc` over the test files, which it never
did — that is how a fixture came to be missing a required field while its suite
reported green.

---

## 10. Where building it changed the design

Six places. Each is a case where the design was written from reasoning and the
implementation had a measurement.

**`KeyPredicate` carries the `Value`, not `{pgType, text, op}`.** r2 stored the
operator beside the value so a target could declare capability over
`(pgType, op)`. But the operator is a *function* of the value — `IS NOT DISTINCT
FROM` exactly when the text is null — and storing it separately is two facts
that must agree. Carrying the `Value` also means a withheld one cannot be
quietly turned into text on the way in; the renderer refuses it by type.

**Truncation is `RowsRead.complete`, not `ChangeSet.coverage`.** §2.1 put
coverage on the ChangeSet, table by table. The truncation that actually exists
is per *read*: the `rows(...)` selector's own limit, which is a property of one
question, not of the capture. A `coverage` array on `ChangeSet` would have been
a field nothing sets.

**`unknown` has no producer, and that is now a measured fact.** It could only
reach a reported value through a key column — row images come from the database,
not the decoded log — and a column large enough to be out-of-line TOASTed cannot
be a key at all: PostgreSQL refuses the index, `index row requires 12816 bytes,
maximum size is 8191`. The arm stays, because it is the shape the answer takes
the moment a capture mode reads images from the log, and every consumer is
written for it. A test asserts nothing constructs it, so the day something does,
the branches it makes reachable get their coverage instead of being assumed.

**The web page does not import the renderer; the server renders for it.** r2 said
"every target and the copy-SELECT button import it". The page is a classic
script with no build step, so importing would have meant shipping a second copy
of the quoting rules — which is what it had. The statement is now rendered
server-side by the same function every other surface calls, and the page has no
SQL in it at all.

**`promoteCandidates` returns what it withheld.** A run whose interesting columns
are masked yields few candidates or none, and a short list on its own reads as
"there was nothing worth asserting" rather than "this run cannot see the values"
— the same mistake as an empty ChangeSet with no warning.

**The username pattern.** r2 spelled it `[^\x00-\x1f/?#&=]`. Written the obvious
way — `[^ -/?#&=]` — that reads as "not these six" and means "not anything from
space to slash", which rejects `user.name` and `svc+web`. Legal role names,
refused by a hyphen in the wrong place. The rule that actually matters is
control characters, because the confirmation shows the user the exact string and
a control character is invisible in the one place they get to check it.

---

## 11. Still open

- **Non-loopback origins** are reachable behind `--i-know-this-is-not-local` and
  print a banner, but nothing re-verifies the host later. §8 says why that is
  not closeable, not that it is closed.
- **`pg_service.conf` must be at its default location.** `PGSERVICEFILE` is
  deliberately outside the child's environment allow-list, so a user who keeps
  it elsewhere cannot use `psql-service`. That is the allow-list working, and it
  is a real limitation to say out loud rather than a bug.
- **`table.where` is still interpolated as raw SQL** in three capture queries
  while every value around it is parameterised. It comes from the workspace
  config, which is repo-authored — inside this design's trust model, but the
  asymmetry deserves a decision rather than an inheritance.
- **The suite shares one database across packages that run in parallel.** Two
  known cross-talk sources are closed (a logical slot decodes the whole
  database; a dropped test database needs `WITH (FORCE)`), and the arrangement
  is still a fragility rather than an isolation.

---

## 12. A note on the status colours

Raised as "I don't see different colours for different outcomes." Measured, and
it turned out to be two separate things.

**The colour system works.** Read back from the browser's own computed styles:
status dots, step statuses and assertion rows all resolve green / red / amber /
blue for clean / failed / undecided / running. Nothing was broken.

**The demo had nothing to colour.** All three `shopfront` datasets passed every
step and every assertion — 16 steps, 16 greens. A workspace that has never shown
a failure has never shown the thing the tool is for, so a fourth dataset now
does, on a **real** defect rather than a deliberately wrong assertion:
`POST /carts/:id/items` never looks at the cart, so an item can be added to one
that was checked out minutes ago. Measured: the API answers **201**, with a body
indistinguishable from a successful add. It also accepts the request from a
different customer entirely. The only place either is visible is in what was
written — which is the argument for the whole product, made by the product.

The dataset asserts the 201 *passes*, that a row was nonetheless written
(`hasWrite(changes(cart_items)) == false` → fails), that the order and the stock
were untouched (passes, and shows the shape: the lamp is in the cart and nowhere
else), and one question that is honestly **undecided** —
`writeCount(...)` needs an engine that observed write order, and `mvcc-xmin`
reports net effect. So the demo now exercises all three outcomes for real.

**One genuine weakness, fixed.** The status colour lived only in a 9px uppercase
label at the right-hand end of each assertion row; the expression itself stayed
white whatever happened to it. Twenty assertions were a wall of identical text
with a few small tags in it, and the one that failed had to be hunted for. Rows
now carry a left bar and — for `failed` and `unevaluable` only — a faint tint.
Passed rows get the bar and no tint on purpose: a screen of green backgrounds is
as hard to scan as a screen of white ones, and it is the exceptions that have to
carry the weight.

**And one that had been hiding.** `failed` and `errored` were painted the same
red in all three places they appear. They are exit 1 and exit 2 — the code did
something the scenario forbids, versus the tool never got far enough to find
out. `errored` now has its own colour, because sending someone to debug code
that may be fine is a specific and expensive kind of wrong.

---

## 13. "Clicking a change still does not take me to the database"

Correct, and for a reason that made §7 wrong in practice while looking right on
paper.

**The control was real and invisible.** §7 says *one control per row*, and there
was one — inside the row card's `<details>`, which is **closed by default**. So
the count of controls a reader could actually see per row was zero. Clicking a
change expanded it; the way to open the row in a database tool was two clicks
down and below the field list. The fix is one line of placement: the control now
lives in the `<summary>`, the always-visible heading, so every changed row
offers it without being opened first. Because it now sits inside a disclosure
toggle, every click on it has to stop propagating and prevent the default —
otherwise opening a row also collapses the diff the reader was looking at.

**And a grant bug that made it fail silently for a second reason.** `handoff
enable` keyed the grant on `process.cwd()`; the runtime checks it against the
workspace's own `configDir`. Identical directories, right up until someone runs
`statescope handoff enable --config examples/shopfront/statescope.yaml` from the
repository root — measured, the grant landed on the repository root, and the
runtime went on reporting `granted: false` for shopfront with nothing anywhere
explaining why. A grant recorded in one place and checked in another is a grant
that does nothing. `enable`, `disable` and `list` now all resolve the workspace
from the config, falling back to the working directory only when there is no
workspace to find.

Verified end to end afterwards: five changed rows across three tables, each with
its own control in its heading; clicking one built
`…&select=orders&where[0][col]=id&where[0][op]==&where[0][val]=ord_mtbkp7y216`,
and opening that against a live Adminer returned exactly that row — `PAID`,
`828.00` — matching what the panel showed. Clicking the control does not toggle
the fold.

---

## 14. Reset, run, and "changes with no run"

Two questions, and the second one was a real defect.

**Why were there database changes when nothing had run?** Because the page
restores the last run from the server on load and rendered it exactly like one
that had just finished — five green step pills, a change list, `Run clean`. The
only hint was a small `Latest · clean` selector. So a reader who had run nothing
was looking at rows from a database that has since been reset, and nothing on
the page disagreed. Reproduced: run once, reload, and the panel comes up with
changes on it.

To be clear about what was *not* wrong: the reset runs before the capture
window opens, so reset writes are never reported as changes; and switching to a
dataset that has not been run correctly shows nothing. The bug was purely that
restored evidence was indistinguishable from current evidence.

Now a run this page did not perform carries a line above the change list saying
so and when it finished. `startRun` is the only thing that marks a run as this
session's.

**Should reset and run be separable?** Yes, in one direction. `Reset baseline`
now sits beside `Reset & run dataset` and stops after the reset — which is worth
a great deal more now that a row can be opened in a database tool: the honest
response to "these changes are old" is usually to put the database back where it
started and go look at it, not to run five requests over it. Clicking it also
clears the evidence panel back to its before-running state, because those rows
described a database that has just been wiped.

The other direction — run *without* resetting — is deliberately not offered for
a full run. The dataset's author wrote `resetFirst` because its assertions
assume a fresh baseline, and quietly skipping it produces a red that means
nothing. The partial-run paths (`Run this step`, `Run from here`) already skip
the reset, and they skip it for a reason the engine states: a partial run builds
on what the previous run left behind, so resetting would destroy the state it
needs.

**And one bug shipped and caught in the same hour.** The reset route was tested
with `curl -X POST` and passed. The page's own `api()` helper sets
`content-type: application/json` on *every* request, and Fastify refuses an
empty body under that header — so the button failed with `Body cannot be empty`
on a route that had been "tested". The route now lives in its own module with
tests that drive it over a real Fastify using the headers the page actually
sends, including the no-body case curl produces. Testing a route with a client
that sends different headers from the real one is testing a different route.

---

## 15. What earns a place on the first screen

Brief given mid-task: the dashboard has a lot to show, so not everything has to
be reachable at a glance — work out which parts matter for reading an
API-plus-database test, put those where they are seen without effort, fold or
pop up the rest, and above all cut redundancy.

Measured before touching anything, at a 720px viewport. The evidence column —
the one the product exists for — spent **368px** on a "state story" panel, so
the database changes began at **y=544** with 176px of them visible. Inside that
panel, three of its four parts were a second rendering of something already on
the same screen:

| | duplicated |
|---|---|
| the headline | the verdict already in the pane heading (`Run clean`) |
| the prose line | the three numbers in the metrics box directly beneath it |
| the signal list | the change list below, truncated to five — and its own footer said so: *"+ N more signals in the database evidence below"* |

The middle column had the same problem at the top: a heading carrying the
scenario title, the dataset label and its note, **all three of which the left
column already shows** — the picker shows the label, the summary under it shows
the note and the step count.

**Cuts.** The middle heading is gone entirely and its run controls moved into
the run strip, which was already the row about this run — one row instead of
two. The story panel keeps only the metrics; its headline now appears **only
when the verdict is not clean**, because *"The request completed, but the
evidence disagrees"* is the most useful sentence on the screen when it is true,
and says nothing when everything passed.

**Folds.** The response body, the captured variables and the potential
assertions became disclosures with a count in the summary. Each is reference or
a deliberate action, not something scanned. Potential assertions measured 302px
— taller than the change list it sat beneath.

**One thing was folded the wrong way round.** `Behavior contract` was collapsed
*always*, so twenty passing assertions took no clicking and the one that failed
took a click to find. It now opens itself when anything failed or came back
undecided, and its summary carries the count in amber. The rule the whole pass
follows: **the exception gets the space, the routine folds.**

| | before | after |
|---|---|---|
| story panel | 368px | 103px |
| database changes begin at | y=544 | y=279 |
| change rows visible without scrolling | partial | all of them |
| the failing assertion, on a failing run | y=807 | y=696 |

On a failing run the whole argument now fits one screen: which step failed on
the left, `HTTP 201` and the failing assertion in the middle, and on the right
*"the evidence disagrees"* beside the row it wrote.

### 15.1 The ranking the pass was made against

Asked to judge what matters when reading an API-plus-database test, in order:

1. **Did it pass, and if not, where** — the verdict and the failing step.
2. **What the API returned** — the status, because that is the *looks fine* half
   of the argument.
3. **What was actually written** — the rows and the columns that moved. This is
   the product.
4. **The mismatch** — which assertion, expected against actual.

Everything else is reference: request and response bodies, captured variables,
promotion candidates, capture-mode metadata, the table list. Reference gets a
fold with a count in its summary; it does not get first-screen space.

**The pre-run panel scored entirely in the reference tier**, and duplicated the
header while doing it: `mvcc-xmin` appeared three times on one screen — a header
chip, a sentence, and a metric — and `6 tables` twice. One of its sentences,
*"the right side is reserved for observed state and database proof; request
planning stays in the center"*, was the interface explaining its own layout,
which a reader learns by looking, once, and then pays for on every visit.

It is now two lines: *Nothing has run yet*, and a folded `Watched tables · 6 ·
baseline is whatever is there when you run`. Fidelity and the reset mode went
with it — both are already said where they matter, by the refusal an assertion
gives when it needs write detection, and by *reset isolated* in the left column.

**One thing was kept visible on purpose.** `Masked at capture: …` stays
unfolded. It is nowhere else on the screen, it changes what the evidence is
capable of telling you, and discovering after the fact that a column was
withheld is the expensive way to find out.

---

## 16. A regression that 570 green tests did not see

Asked whether clicking through to the database tool was actually done, the
answer was yes — and checking rather than answering from memory found
`/api/handoff/targets` returning **404**. The whole row-handoff feature was
unreachable from the browser.

Cause: extracting the reset route into its own module spliced out a range of
`server.ts` that happened to contain the `registerHandoffRoutes(...)` call.
The import stayed. Nothing else referred to it. The feature had no routes.

**Every piece was unit-tested and nothing checked that the pieces were plugged
in.** `handoff-payload`, `adminer`, `psql`, `locator`, `sql`, `reset-route` all
had their own suites and all passed. The suite was 570 green with the feature
switched off.

**The guard that was tried first did not work.** A source-text test asserting
that every imported `register*` is also called passed happily against a
commented-out call, because a regular expression matches inside a comment.
Mutating the code to check the test actually fails is the only reason that was
found rather than shipped as reassurance.

**The guard that works is the compiler.** `noUnusedLocals` was off; turning it
on cost twelve dead imports left behind by the `Value` migration and now
reproduces the exact failure:

```
server.ts(15,1): error TS6133: 'registerHandoffRoutes' is declared but its value is never read.
server.ts(17,1): error TS6133: 'openUrl' is declared but its value is never read.
```

`pnpm test` runs `pnpm typecheck` first, so this class now fails the suite. Note
what it does *not* cover: removing the import along with the call is a deletion
the compiler cannot object to. The real answer remains a `buildApp()` that
returns the Fastify instance without listening, so the actual route table can be
asserted — `server.ts` calls `app.listen` inside `main()`, so nothing can import
it to look. That is still open.

---

## 17. "Can we configure the database address in the YAML to avoid connecting every time?"

The address is already there — `database.connectionString` in `statescope.yaml`
— and nothing asks for it per run. But the premise underneath the question was
worth measuring, and measuring it found something else entirely.

**Connecting is not what costs.** Against a live PostgreSQL:

| | connections held |
|---|---|
| runtime, idle | **0** |
| during a run | 5 |
| 2s after the run | 5 |
| 14s after the run | **0** |

The pools are lazy — startup opens nothing — and `pg.Pool` reaps idle clients
after ten seconds. `check`, which connects and introspects, cost **47ms** more
than `ls`, which never touches the database at all. Connecting was two per cent
of the time.

**The other 98% was a timer nobody was waiting for.** Instrumented,
`statescope ls` finished its work at **16ms** and the process then sat for
**2,250ms** before exiting. The cause:

```ts
await Promise.race([session.close().catch(() => {}), sleep(2000)]);
```

`close()` resolved in 0ms and won the race — and the losing `setTimeout` stayed
on the event loop, which Node will not exit while a timer is pending. **Every
invocation of every CLI command paid a flat two seconds for a deadline that had
already been beaten.**

`sleep` now `unref`s its timer. The guarantee the race exists for is unchanged,
which was checked rather than assumed: with `close()` deliberately hung and the
loop kept alive by something else, the race still resolves at 2,004ms.

| | before | after |
|---|---|---|
| `statescope ls` | 2,167ms | **247ms** |
| `statescope check` | 2,214ms | **185ms** |
| `statescope run checkout/happy` | 2,833ms | **817ms** |

A sweep for the same shape found one sibling: `apps/mcp/src/server.ts` races an
identical un-`unref`'d deadline on shutdown. It is harmless today because
`process.exit(0)` follows it — and it is a trap for whoever deletes that line
believing Node can now exit on its own. Fixed too.

**What is genuinely not bypassable.** Without a database connection there is no
evidence, and the product is an HTTP client. `ls` and `show` already work with
the database unreachable — scenario files are read from disk and nothing else is
needed to list or inspect them — while `check` and `run` fail with a message
naming the connection string and the config file. That split is right as it is.

---

## 18. The one address you still had to go and find

Ports are pinned — `database.connectionString` in `statescope.yaml` fixes host,
port and database, and nothing asks per run. One address was the exception, and
it is the one that had to be discovered with `docker inspect` while testing this
very feature: `--server` on `handoff enable`, the database **as Adminer reaches
it**.

§4 established that StateScope cannot derive it: three independent addresses are
in play and only the user knows where Adminer runs. That reasoning is intact.
What it did not license was the message, which offered a made-up example —
`e.g. postgres:5432` — and left the reader to go and find the real one.

StateScope does know its *own* address. It now says so, as candidates rather
than a guess:

```
This workspace reaches PostgreSQL at `127.0.0.1:7432`.
  --server    `127.0.0.1:7432` if Adminer runs on this machine
              `host.docker.internal:7432` if it runs in a container — loopback
              inside one means the container, not this host
  --username  probably `postgres`, the role this workspace connects as

StateScope will not choose for you: only you know where Adminer runs.
```

The second candidate appears **only for a loopback DSN**, because loopback is
the case where the two views genuinely differ. A real hostname resolves the same
from inside a container as outside it, and offering an alternative there would
be inventing one.

**Host, port and user only — never the password.** A usage message is exactly
the kind of text that gets pasted into a chat or an issue, and there is no
version of this hint worth leaking a credential for. The test that pins it was
mutation-checked: made to print the whole DSN, it fails on
`SUPERSECRET_hunter2`. An unreadable DSN — an unresolved `${secret:…}` is not a
URL — falls back to the generic message, because a wrong hint is worse than
none.

---

## 19. "There is still nowhere on the web app to click through to the database"

Correct, and my earlier verification was the reason I did not know it.

**The control was two folds deep, not one.** §13 moved it out of the row card's
`<details>` and into the row heading, which was right — and the row heading is
itself inside a *table* section that is collapsed unless the run touched exactly
one table (`groups.size === 1`). The shipped demo touches three. So the default
screen still had **zero** rows on it and zero controls.

**And the verification that said otherwise was mine.** The probe that reported
`controlsVisibleWithoutExpanding: 5` had run
`document.querySelectorAll('.table-change').forEach(d => d.open = true)` a few
lines earlier. It measured a state I had opened by hand. A check that arranges
the condition it is checking for is not a check.

**Changed rows are now open by default.** They are the third item on §15.1's
list of what matters and they were behind a fold; a run that touches many tables
can still collapse them, and that is the direction that costs less — finding a
fold in order to see the evidence at all is paid by every reader, every time.

**The second half: nothing is bound, so the button was dead.** On a machine that
has never run `handoff enable` — which is every machine, at first — the control
was disabled and grey. That says only that something is broken. It now reads
`Open in…`, opens the drawer, and the drawer carries the command. That is the
only route from *I want this* to *it is configured* that does not require
already knowing the feature exists.

Said once, at the panel, not on every row:

```
Open in… → no database tool is bound on this machine yet · open a row to set one up
```

**And the drawer no longer sends anyone to `docker inspect`.** It used to print
`--server <db as adminer sees it>`. The runtime knows its own DSN, so the
command is now copy-pasteable, with the container alternative offered underneath
when — and only when — the DSN is loopback:

```
statescope handoff enable adminer-url --as adminer \
  --origin http://127.0.0.1:8080 \
  --server 127.0.0.1:7432 --username postgres
```

Host, port and user only. The DSN carries a password and this one is rendered
into a command for copying, so the guard is tested — and mutation-checked, by
making it send the whole connection string and confirming the test fails.

**A note on why you were seeing the old behaviour at all.** The runtimes on
:7420 and :7421 were started before this work; static files are re-read from
disk but the *server* is the process you started, so `/api/handoff/targets`
404s and no change carries a `handoff`. A restart is needed to pick up server
changes — which nothing in the UI says, and is worth fixing separately.

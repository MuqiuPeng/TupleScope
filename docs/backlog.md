# Backlog

Every item here was verified against the code on 2026-09-02, by a 14-agent audit
whose findings were then put through an adversarial refutation pass: 154 claims
confirmed, 18 overclaimed, 3 refuted. Items are ordered by *what a wrong answer
costs*, not by effort.

The ordering principle is the project's own: an answer that looks precise and is
wrong outranks everything else, because it is the failure this tool exists to
prevent. A dead flag wastes a minute. A false green ends an investigation.

Status: `[ ]` open · `[x]` done · `[~]` in progress · `[-]` decided against

---

## P0 — wrong answers

These produce a decided verdict that is not true. Each needs a test that fails
before the fix.

- [x] **1. `sum` / `min` / `max` do not refuse a truncated read.**
  `requireWholeSet` only inspects `{kind: 'selection', partial}`
  (`packages/expr/src/evaluate.ts:791-808`), and the column node returns
  `{kind: 'column'}` with no `partial` flag (`:583-608`), so the flag is lost the
  moment a column is read off the set. Measured: with 1200 rows and a 500-row
  limit, `count(rows(events)) == 500` refuses, while
  `sum(after(rows(events).amount))` answers from 500 rows and **passes**.
  `evaluate.test.ts:668-686` covers only the selectors that already refuse.
  *This is the only known false green in the language.*

- [x] **2. `maskColumns` fails open on a typo.**
  Config validation accepts any string and never resolves it against the schema,
  so a misspelled column is captured in the clear into `.tuplescope/runs`,
  `--json` and CI reports. README states masking happens at capture precisely so
  it cannot leak into those; that holds only for a correctly spelled column.
  `check` resolves tables and predicate columns against the live schema already
  and is the natural place for this.

- [x] **3. A keyless table's DELETE is invisible on two of three engines.**
  Under `mvcc-xmin` and `wal`, a delete from a table with no PK and no usable
  unique index produces **zero** entries in `changes` — `net-view.ts:104`
  `continue`s past `readDepartedKeys`. Under `snapshot-diff` the same delete is
  reported. The only universal signal is `degraded-row-identity`, whose severity
  is `warn`, not `error` (`verdict.ts:88`), so it does not escalate the run on its
  own. The CLI refuses to print "Not a single row was touched" when it is present
  (`output.ts:165-175`), but a JSON or JUnit consumer reading `changes` and the
  verdict — and not the warnings array — is still misled.
  *Decide: escalate to `error`, or carry the blindness into the envelope where a
  machine consumer will see it.*

- [x] **3b. The conformance harness cannot express the row-identity axis.**
  `TableScope.departuresObservable` is a real capability axis and the harness has
  only `expectByDetection` and `expectByFidelity`. `count(deleted(t)) == 0` over a
  keyless table is `passed` on snapshot-diff and `unevaluable` on the MVCC
  engines — a difference the contract currently cannot state, because writing it
  as `expectByDetection` would give the wrong reason, which is the one thing the
  suite forbids. Covered by unit test in the meantime.

- [x] **4. `entered-scope` is dead code** — and correctly so. The audit's claim
  that a row entering a narrowed `watch:` arrives as an indistinguishable insert
  is **wrong**, measured: the before-image is read by key with no watch
  predicate, so such a row is still found, still pairs, and is reported as an
  ordinary `update` whose predicate column moved. The concept is not missing, it
  is unnecessary. Type comment corrected to say so; the variant stays in the
  union because removing a member breaks exhaustive consumers exactly as adding
  one would.

- [x] **5. MCP `check_scenarios` is materially weaker than `tuplescope check`.**
  It destructures only `{ tables }` from `preflight()` (`apps/mcp/src/server.ts:262`),
  discarding the `columns` map, so it validates no predicate columns and no
  `except` names. It also returns an unconditional all-clear over zero scenarios
  (`:294-297`) where the CLI refuses and exits 3, and it never sets `isError`.
  Both `predicateColumnsIn` and `exceptedTablesIn` are already exported from
  `@tuplescope/expr`, which `apps/mcp` already depends on.

- [x] **6. The bare-table shorthand bypasses `check`'s table extraction.**
  `tablesNamedIn` (`apps/cli/src/main.ts:663-666`, and the identical regex at
  `apps/mcp/src/server.ts:304`) matches only an identifier in a selector's first
  argument, so `sum(delta(walets.balance))` yields nothing while
  `changes(walets)` is caught. The dotted form is exactly what `promote` emits
  (`promote.ts:386`), so a kept cross-row invariant with a bad table name is
  invisible to the command that exists to catch bad table names.

- [x] **7. An empty schema renders as `` 0 tables in `` ``.**
  The schema name goes blank exactly when the watch scope is empty — which is the
  state in which every subsequent run will say "Nothing was written".

- [x] **8. `status` collapses when any secret is unset.**
  It then answers none of its three questions, drops the workspace name, and
  exits 2 — even when the missing secret is an identity token with nothing to do
  with the database. The suppression should be scoped to what actually depends on
  the missing value.

---

## P1 — surfaces that do not do what they say

- [x] **9. `url --all` is unreachable dead code.** `all` is absent from `OPTIONS`
  and `parseArgs` is strict, so the branch at `main.ts:219-224` cannot run; the
  hint at `:227` actively directs users to it. *(Disclosed in Known issues.)*
- [x] **10. `--junit -` emits XML no parser accepts, silently, exit 0.** Written
  to a path the output is correct. *(Disclosed in Known issues.)*
- [x] **11. `--wide` is a documented no-op.** Declared (`main.ts:77`), in HELP
  (`:136`), carried into `Flags` (`output.ts:25`), and read by nobody.
  `--columns all` is the flag that works.
- [x] **12. `--baseline abc` silently disables the noise probe.** NaN, no
  validation, exit 0. Its two policy-flag siblings both validate and exit 4.
- [x] **13. `--pass-with-no-scenarios` is absent from HELP.** The person who needs
  it — wiring CI before any scenario exists — cannot discover it.
- [x] **14. `rows(*)` and `rows()` parse and can never evaluate.** The engine's
  pre-fetch skips any selector without a table (`scenario-engine/src/index.ts:329`),
  so both always refuse; both are refused at parse. `rows()` stayed open until the
  first real install found it. The same rule now covers a column read with no
  side (`single(updated(t)).col`): the evaluator refuses every one it reaches, so
  `parse` refuses it, in the same sentence.
- [x] **15. Two dead routes.** `POST /api/runs` and `DELETE /api/assertions` have
  no callers repo-wide. The run path is implemented twice, and the dead copy's
  error handling has diverged in its favour — the UI shows worse messages than the
  code contains.
- [x] **16. Exit-code and help inconsistencies.** `<subcommand> --help` exits 4;
  exit 1 is overloaded across `url` and two `secret` paths, none documented.

---

## P2 — release blockers

- [x] **17. Nothing to run** — resolved by saying so, not by shipping one (the
  author's call). The audit overstated this: the README does not tell a reader to
  run a bundled example, it teaches them to *write* `refund/happy` against their
  own service, and every later reference is to that. What was missing was one
  sentence saying the repository ships no backend, so nobody arrives expecting a
  clone-and-run demo. Added to Quick start.
- [x] **18. npm is structurally blocked** — unblocked. Nine libraries and the two
  bins are at 0.3.0 with `repository`, `engines`, `files` and `license`, and no
  longer private. `runtime`, `web`, `conformance` and the root stay private, which
  is correct — a locally served app, static assets and a test harness. `workspace:*`
  is not a blocker: pnpm rewrites it at publish time. Verified by packing
  `@tuplescope/core` (46 files, dist only) and the CLI (bin present).
  Publishing itself is still a deliberate decision, not done here.
- [x] **19. `embedded-postgres` is a root devDependency.** README now states the
  measured cost (133 MB of a 226 MB `node_modules`) and withdraws the "opt-in"
  framing. *Structural option not taken:* moving it out of the root manifest so
  only CI and `pnpm testdb` users install it. That would make a checkout much
  smaller and costs a step in the contributing instructions.
- [x] **20. No `engines: {node: ">=22"}`.** A Node 20 user gets a `node --test`
  glob failure with nothing connecting it to their Node version.
- [x] **21. Six environment variables are undocumented** — including the only
  escape from `EADDRINUSE` on a second `pnpm start`.
- [x] **22. `release-prep` is fully merged** (0 commits not in `main`) and can be
  deleted.
- [x] **23. The working directory is still `StateScope`.** Content and remote are
  both TupleScope.

---

## P3 — coverage

- [x] **24. `apps/web` has no client-side tests** — and the one that mattered
  most found a real divergence. The page derived its own run verdict from
  assertion statuses and never looked at capture warnings, so a run with every
  assertion passing and a `scope-truncated` warning showed a green dot while
  `tuplescope run` called it undecided and exited 3. The verdict is now computed
  once, by `verdictOf`, and sent with the run; the page reads it and says so when
  a payload does not carry one. Five page modules now have tests — `runs.js`,
  `api-error.js`, `steps.js`, `chart.js`, `verdict.js`. *Left deliberately:* the
  `render*` functions build DOM directly and are still uncovered; the decisions
  inside them have been moved out instead, which is the shape this codebase
  already uses.

- [x] **25. The Windows and Linux secret backends have no test files** — Windows
  now runs in CI, and getting it green found five defects, four of which had
  never run anywhere.

  The credential backend **had never compiled**: the PowerShell shim joined with
  `` `n `` inside an expandable here-string, where C#'s `\n` was meant, so
  `Add-Type` failed as a unit and `probe()` reported the store unavailable on
  every Windows machine there has ever been (`946ead1`). A probe run then proved
  the fix on a real runner — full round trip, byte-exact through trailing
  whitespace.

  `handoff enable` could not work either: three validators tested
  `startsWith('/')`, so a Windows absolute path was refused and the writer
  rejected the grant it had been asked to make. Plus the unchecked `CredWrite`
  ceiling, `URL.pathname` used as a filesystem path in two tests, and
  `testdb.ts` swallowing every `initialise()` failure.

  And one thing that is not a defect but a false claim: four files are written
  at mode 0600 with a comment saying nothing else on the machine can read them.
  Windows has no such permission bits. Named once in core, skipped with the
  reason printed, and disclosed in the README.

  *Not covered, and recorded rather than hidden:* the database. `postgres.exe`
  refuses to run under an administrator token and a GitHub runner is one, so the
  Windows leg runs everything that needs no database and lets the rest skip.
  `embedded-postgres` spawns `postgres` directly instead of the `pg_ctl` its own
  package exports — and `pg_ctl` creates the restricted token that would make it
  work. That is a change to `scripts/testdb.ts`, not to CI.

---

## Documentation

- [x] **27. Known issues omits items 1, 2, 7 and 8** — resolved by fixing all
  four rather than disclosing them. Two entries that described now-fixed defects
  (`--junit -`, `url --all`) were removed at the same time. Six remain; the one
  about the web UI naming `ECONNREFUSED` is about workspace *load*, which the
  run-path taxonomy work did not touch, so it still stands.
- [x] **28. The noise probe is not on by default.** README describes it as running
  before each run; `baselineWindowMs` defaults to 0, so only a workspace copied
  from the template gets it.

---

## Panel mods

Designed to r2 and frozen (`docs/panel-mods-design.md`). Nothing is built, and
the design says plainly that it does not yet satisfy the request that started it.
Do not implement out of this order — steps 29 and 30 are what make step 31 a
decision rather than a guess.

- [x] **29. Serve a Content-Security-Policy from the page** — done, and the
  reason it was deferred turned out not to exist. The design says "the page
  currently uses inline handlers freely, so this is not a one-line addition."
  Measured: **zero** inline handlers, zero `<script>` without a `src`, zero
  `<style>`, zero `style` attributes, zero external origins. So the page took
  `default-src 'none'` with `'self'` for script, style and connect, and nothing
  else — no `unsafe-inline`, no `unsafe-eval`, and no allowance for images or
  fonts it does not load. Verified in the browser: a full run through the UI,
  clean, with no violation.

  *Note the circularity to break here: the release review deferred CSP on the
  grounds that it was only a prerequisite for panel mods, which do not exist —
  while panel mods cannot be built because CSP does not exist. Break it from the
  CSP end.*

- [x] **30. Draw three real panels against the scene vocabulary** — done, in
  `panel-mods-design.md` §11. A single series and two compared series are both
  buildable. A product-looking card is **not**, and not nearly: `text` carries no
  `fill`, `size` or `weight`, so every string on a panel is identical. The
  widening that would fix it is bounded — but a mod that can set typography can
  reproduce the host's own verdict inside the evidence panel, which is the one
  place in this product where what you see is meant to be what was observed. So
  the vocabulary is not *not yet* good enough; it is deliberately unable, for the
  same reason the colour enum exists.

- [x] **31. Decided: the mod mechanism is not built.** §11 removed the option of
  widening the vocabulary. Reading §2 again with that settled removes the rest:
  the repo-names-it / user-installs-it split exists because different users want
  different *renderings*, and given two named series every mod anyone would write
  draws the same two lines. With no reason for third-party code, the Worker, the
  grant model, the payload boundary, the scene protocol and its validator, the
  update protocol and the byte-exact loading are all cost with nothing left to
  buy. Recorded as `panel-mods-design.md` §13.

- [x] **32. Ship the built-in chart panel** — what §13 replaces mods with.
  `panels[].sources` in the workspace file (inert, §3 survives intact),
  evaluated with `seriesFor` — already built in `@tuplescope/expr`, ten tests,
  currently zero consumers — and drawn by the host in the page's own palette. A
  `carried` point draws differently from an observed one because the host knows
  the difference, which no longer has to survive a protocol boundary to be
  honoured.

---

## Open

Found on the first real install (the Dcard payment service, 2026-09-12): every
documented feature was turned into a command and an observation against a real
service, fixed where it fell short, and measured again. What is left is below —
each is safe in the direction it fails (undecided or refused, never green), or is
a presentation gap.

- [ ] **The web UI's whole-row view shows ignored columns.** `app.js` builds that
  grid from every key of the row; the text diff and the UI's changed-column view
  hide them. Arguably intended for a whole-row view; unmeasured.
- [ ] **A stored run keeps the sentence its producer wrote.** A run saved before
  the verdict wording was fixed still reads "4 assertions evaluated and passed"
  over undecided counts through `get_run` and `report`. New runs are right.
- [ ] **`secret list` calls a hand-written keychain item `configured`.** Telling
  it apart means reading every value, which prompts per item. `get`, `status` and
  every command that resolves it now name it in one line.
- [ ] **`check` says "every run" leaves an assertion undecided** when the refused
  question is the right operand of `and`/`or`, where the evaluator short-circuits.
  Withholding the clean sentence is still right; only "every" is too strong.
- [ ] **The templater still refuses a captured value holding a quote or a
  backslash inside a predicate,** from when predicate values had no escapes. They
  now read escapes like any literal, so it could escape instead. Safe as is.
- [ ] **A raw newline inside a quoted predicate value is refused** while a
  comparison literal accepts it — the clause regex has no `s` flag. Safe direction.
- [ ] **Over a step that wrote no row of a table, a misspelled value column is
  invisible to the run** — there is no row to ask. `check` catches it when the
  table is named; under `changes(*)` nothing does.
- [ ] **`--warnings off` could not be told apart from `default`** for
  warn-severity warnings, which it leaves alone; unmeasured against an
  error-by-default one.
- [ ] **`$${` with no closing brace is not an escape** in the shared grammar, so
  `$${abc` is sent as written. Matches the workspace file; decide whether
  scenario files should differ.
- [ ] **`SecretNotConfigured` overwrites its `name` parameter** with the class
  name. Nothing reads it today.

Found by the final re-verification of the same build, and left open on purpose:

- [ ] **The scrub is textual.** With the common development password `postgres`,
  the wal prerequisite's remedy prints `[secret db_password]ql.conf`, and a
  database named `x/postgres` loses its name. Documented in the README. A
  token-aware scrub would read better but must still catch a secret glued to
  other text — `${secret:x}_nope` as a database name is exactly that case.
- [ ] **A session file is judged live by its pid alone,** so a reused pid hands
  back a dead URL; the README's "a stale one … is discarded on read" holds for a
  dead pid. Check the port too.
- [ ] **The run store prunes by file name,** so anything named `run_*` that sorts
  among the newest fifty is kept whatever it contains.
- [ ] **A `wal` prerequisite failure exits 2** — "a step could not be executed" —
  though it is refused before any step runs; it is a workspace that will not run.
- [ ] **`ls` and `show` resolve the workspace's secrets,** so an empty keychain slot
  stops a listing that needs no database.
- [ ] **Under value detection, `hasWrite(…) == true` is refused even where a value
  visibly changed,** which does decide it. Safe direction.
- [ ] **The runtime keeps its runs in memory:** after a restart `/api/runs` is
  empty, and CLI runs never appear there.
- [ ] **One unparseable scenario file stops every command for the workspace,** not
  only its own scenario. Deliberate at load; the MCP error now says so, the CLI's
  does not.
- [ ] **Two messages name the wrong thing:** `report` of a non-JSON file prints the
  raw `JSON.parse` error, and a predicate ending in a dangling `and` is refused as
  "the value goes on after its closing quote".

---

## Closed

- [x] Departure tests crashed on a machine with no database, contradicting the
  README, on a path CI never exercises (`c231304`).
- [x] GitGuardian finding on `7b85aae` — dismissed by the author.
- [x] The `runtime` service was registered with `STATESCOPE_PORT`, a name nothing
  has read since the rename. It worked only because 7420 is also the default.
  Found while re-registering the project under its new path; now `TUPLESCOPE_PORT`.
- [x] `junit.ts` held its control-character class as literal bytes, so `file`
  and grep treated the whole file as binary and skipped it silently (`fe09ffa`).
  Found by three greps for symbols that were plainly there coming back empty.
- [x] `pnpm start` and the MCP server could not open a workspace with a
  `${secret:…}` reference in it — the setup the README recommends. Each loaded
  the file and opened the session; only the CLI had the resolving step in
  between, inline. `assertResolved` said so at startup, which is what it is
  for, but it said so *after* the release. Found on the first real install
  (the Dcard payment service, 2026-09-12). Now one door, `loadWorkspace`, and
  `openWorkspace` takes a branded `CredentialedWorkspaceConfig`, so the
  load-then-open shape no longer compiles — pinned by a `@ts-expect-error`
  that `pnpm typecheck` refuses to leave unused (mutation: removing the brand
  fails the check).

Closed by the same pass (2026-09-12). Each was a measured gap between a
documented claim and what the tool did; each fix has a test that fails without it.

- [x] **False greens in the evaluator.** A misspelled column under `delta` read as
  0 and under `.after` as NULL, so `sum(delta(wallets.balanse)) == "0"` passed over
  money that moved; a predicate on a masked column, and a `sum` of one, answered
  over an empty selection; a `bool` column never equalled `true` (PostgreSQL sends
  `t`), so `!= true` passed on every active row. Each is refused or decided now.
- [x] **`check` printed its clean sentence over assertions no run can decide** —
  `atomic`/`writeCount` under net fidelity, `hasWrite`/`count(updated(…))` under
  value detection, masked columns, a column read as a value that its table lacks
  (panels too), a `${…}` in a request, a keyless table's refusals. A column with
  no side and `rows()` are refused at parse. One implementation, shared with MCP.
- [x] **Scenario files.** Unknown keys at every level were silently accepted
  (`resetFrist:`, `expectStaus:`, `handoff:`); refused with a suggestion that now
  counts a transposition as one edit, as the workspace file's does. `{{var}}`
  inside a longer literal is spliced as text and escaped — a captured value can no
  longer break out of a literal or add a predicate clause. `{{name}}` in a header
  is templated. Every `${…}` in a request is refused instead of being sent to the
  API as those characters; `$${` is the escape. A predicate value obeys the
  lexer's escapes, so one quoted text is one value everywhere.
- [x] **The verdict's own words.** "4 assertions evaluated and passed" over 2
  undecided under `--unevaluable warn`, for a run and for a suite; a truncation
  reason that named neither the warning nor a table; `boundedBy` repeating one
  sentence 35 times; JUnit counting one error per table.
- [x] **What the CLI prints.** `url --all` was a no-op while the CLI's hint named
  it. A driver message echoing a resolved secret was printed verbatim; the CLI now
  scrubs everything it writes once the workspace opens, and the runtime and MCP
  scrub what they return. `status` stopped asking at an unreachable database and
  exited 2 for a workspace that will not load. A keychain item TupleScope did not
  write, and a machine with no secret store, surfaced as stack traces. `--junit -`
  with `--json` produced neither format; an unwritable `--junit` path was a stack
  trace, exit 2. `<command> --help` printed the global help. `--ascii` did not
  reach `status`, `check` or `ls`. Keyless tables were not named. Ignored columns
  showed on inserted rows. `keep` offered a literal the language reads as another
  value for a key holding a control character.
- [x] **`report` merging.** Totals and targets were the first file's; a failed
  shard plus an undecided one exited 3. Recomputed over every run, the exit code
  follows the merged outcome, and `--exit-zero` survives only when every shard had it.
- [x] **MCP.** `check_scenarios` answered an unknown id with "0 selected";
  `get_run` returned bare JSON; `describe_table` printed no columns, no types and
  a workspace-wide mask list, and its database failure had no remedy;
  `describe_workspace` printed none of the scope; `run_scenario` was never
  `isError`, even for a failed run; `tuplescope-mcp` ignored every argument and
  now takes `--config`.
- [x] **Surfaces that described what does not exist.** The handoff usage,
  `handoff list`, the runtime's `NOT_BOUND` message and the web drawer spoke of an
  alias a repository chooses; nothing reads one. The README said there was no
  Content-Security-Policy; a strict one is sent on every response. The runtime's
  `/api/assertions` told a request naming an unknown scenario that all four
  fields were required.

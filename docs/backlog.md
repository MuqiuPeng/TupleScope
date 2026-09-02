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
- [x] **14. `rows(*)` parses and can never evaluate.** The engine's pre-fetch skips
  any selector without a table (`scenario-engine/src/index.ts:329`), so it always
  refuses. Refuse it at parse instead.
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
  `@tuplescope/core` (46 files, dist only) and `@tuplescope/cli` (bin present).
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

- [~] **24. `apps/web` has no client-side tests.** The three pure functions
  behind the sentences printed next to a control — `expectedStatus`,
  `dependenciesFor`, `assertionRank` — are extracted into `steps.js` with 16
  tests, joining `runs.js` and `api-error.js`. **Still open:** the rendering
  itself. Every `render*` function builds DOM directly and none is covered; that
  needs either a DOM shim or a further extraction of the view models, and is a
  bigger decision than this.
- [~] **25. The Windows and Linux secret backends have no test files.** Windows
  now has one for its wire format — the part testable from a Mac — and it found
  no bug: the `.trim()` that would have corrupted a trailing-whitespace value is
  unreachable because everything crossing that channel is base64. Linux needs
  none of the same kind; it envelopes through the shared `unwrap`, which is
  already covered. **Still open:** neither store is exercised anywhere, and CI
  still has no Windows runner, so the README table's "yes" for Linux rests on one
  container run and Windows' "no" is the only honest cell in it.
- [x] **26. `apps/mcp` has one test file**, covering handshake prose only — the
  check logic it shares with the CLI now lives in `@tuplescope/scenario-engine`
  with 11 tests of its own, and the server was driven over stdio to confirm the
  tool reports through them.

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

- [ ] **30. Draw three real panels against the scene vocabulary, on paper.**
  `line | bar | dot | text | rule` was written from two imagined charts. One of
  the three must be "looks like the product's own screen", which is the request
  that started this feature and which the vocabulary plainly does not satisfy
  (`panel-mods-design.md:293-300`).

- [ ] **31. Then decide:** build r2 as frozen, widen the vocabulary, or record
  that this shape is wrong for the original ask.

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

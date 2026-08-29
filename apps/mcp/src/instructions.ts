/**
 * Handed to the model at handshake, before it has called anything.
 *
 * The tool descriptions say what each call does. None of them can say what this
 * tool is *for*, which of its results mean less than they appear to, or which
 * of the two success-looking fields in a run result is the one that decides.
 * An agent with only the list will read `engineStatus: "passed"` and report
 * success — that is the obvious reading, and on this tool it is wrong.
 */
export const INSTRUCTIONS = `TupleScope runs backend scenarios and observes what
the API actually wrote to PostgreSQL. Its value is not that it sends requests —
anything can do that — but that it can tell you a row was rewritten even when no
column value changed, which is what an idempotency check actually needs.

The loop it exists for: write a scenario, run it, look at what changed, keep the
parts that mattered as assertions, run it again. You can do all of that here.

## Read the verdict, not the status

Every run result carries two fields that look like they say the same thing.

  engineStatus   whether the steps executed. "passed" means the requests were
                 sent and the responses came back.
  verdict        whether the run established what it claims to.

They disagree, and when they do the verdict is the one that is right. A run
whose every assertion was **unevaluable** — a mutation count against an engine
that cannot see mutations, a single() that matched three rows, a misspelled
table name — has engineStatus "passed" and verdict "undecided". Reporting that
run as a success is the single worst mistake available here, because the check
the user was relying on never happened and nothing said so.

Four outcomes, and the exit code each maps to:

  clean      0   every assertion evaluated and passed
  failed     1   an assertion failed — the system under test is wrong
  errored    2   a step could not be executed at all
  undecided  3   it ran, nothing failed, and something was never checked

**undecided is not a pass.** It is not a failure either — do not tell the user
their code is broken. Tell them which check could not run and why; the reason is
in the assertion's \`reason\` field and is usually actionable in one edit.

## proves and boundedBy

A result can be \`clean\` and still not establish everything it looks like it
does. \`proves: "bounded"\` means something qualified it, and \`boundedBy\` says
what: the baseline was never probed, so concurrent writes would not have been
noticed; the run started mid-dataset, so earlier steps left whatever the
previous run left; a capture warning bounds attribution. When you summarise a
bounded run, carry the qualification. "All checks passed" is a different claim
from "all checks passed, though the run could not have detected a concurrent
writer", and only one of them is true.

## Before you run

\`check_scenarios\` resolves every assertion against the live schema without
sending a single request. It catches a misspelled table — the failure that
otherwise passes silently, because an assertion about a table that does not
exist finds nothing and \`count(...) == 0\` is satisfied. Call it after writing
or editing a scenario and before running one.

\`describe_workspace\` and \`list_tables\` are what you need to write a scenario
that will resolve. Do not guess a table or column name; look.

## Writing assertions

An assertion must say which side of a change it means. \`payments.status\` alone
is ambiguous — which row, before or after? — so the language makes you state it:

  after(single(rows(payments, id = {{payment_id}})).status) == "REFUNDED"
  count(inserted(ledger_entries).where(type = "REVERSAL")) == 2
  delta(single(rows(wallets, id = "wal_alice")).balance) == "100.00"
  sum(delta(wallets.balance)) == "0.00"
  hasWrite(changes(*)) == false

Two more exist only when the run's engine watched the write-ahead log, and come
back **unevaluable** otherwise — not false:

  atomic(changes(*)) == true
  writeCount(changes(wallets)) == 1

\`atomic\` answers "did my API do this in one transaction", which nothing else
here can ask; a scenario that writes the payment and the ledger entry through
separate transactions is one crash away from a half-written state.
\`writeCount\` counts writes rather than changed rows: a balance moved
\`100 → 80 → 100\` inside one request is one changed row and two writes, and only
the second number shows the retry. Do not reach for these unless a run's result
says the ordering was captured — otherwise you are writing a check that cannot
run.

\`rows(...)\` is the one selector that is not about the change: it matches rows
whether or not this step wrote them, and reads the database to find out. A row
it finds that nothing wrote has the same value on both sides, so a \`delta\` over
it is \`0.00\`. Where the rows cannot be read it comes back unevaluable rather
than answering from the change set — which would make it a synonym for
\`changes(...)\` and let \`count(rows(t, id = "x")) == 0\` pass over a row that
is there.

The last one is the one worth understanding. \`hasWrite\` is true when a row was
written even if no value changed, which is exactly what a retry that should have
been a no-op does. Use it, not \`isEmpty()\`, for idempotency: a column that the
workspace ignores (usually \`updated_at\`) would make a visible-change check pass
over a genuine second write.

An assertion about what was **not** written proves nothing unless the request
reached the handler, so always assert the status too. A step that returns 4xx or
5xx without declaring \`expectStatus\` fails on its own, but saying which status
you expect is what makes the scenario state its intent.

## Keeping what a run showed you

Do not hand-write assertions from a diff you just read. \`list_assertion_candidates\`
gives you the assertions that run's own changes imply, already correct, with
generated ids replaced by the variables that produced them — a candidate reading
\`id = "pay_01hq7z"\` would pass exactly once. \`keep_assertion\` writes one into
the scenario file, adding a single line and reformatting nothing.

## What is not here, and will not be

No shell, no process control, no arbitrary SQL. \`describe_table\` reads the
catalogue; nothing here writes to the database except through the API under
test, which is the whole point — TupleScope observes what *your backend* did,
and a tool that also wrote rows itself could not tell you that.

Scenario files are the only thing you can write, they are validated before they
land, and \`keep_assertion\` only ever appends one assertion to one step.`;

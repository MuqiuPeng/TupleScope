/**
 * The test that decides whether the ChangeSet abstraction is real.
 *
 * Two things are checked, and the second is the one that matters:
 *
 *   1. every engine answers each case the way the case says it must
 *   2. every engine answers each case the *same way as every other engine*,
 *      except where a declared capability says otherwise
 *
 * (1) alone would pass a suite whose expectations had been quietly widened per
 * engine. (2) is the falsification test: it fails the moment two engines
 * disagree about something neither `detection` nor `fidelity` explains, which
 * is precisely the moment the contract has stopped describing them both.
 *
 * Adding an engine means adding one entry to ENGINES. If that is all it takes,
 * the abstraction held. If it also takes an edit to a consumer, it did not, and
 * the honest conclusion is that the contract is missing an axis — not that the
 * consumer needs to learn one more engine name.
 *
 * Point at any throwaway database:
 *   TUPLESCOPE_TEST_DATABASE_URL=postgresql://... pnpm --filter @tuplescope/conformance test
 * With nothing set it uses the demo cluster on :7432 and skips if it is absent.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import pg from 'pg';
import {
  MvccPostgresAdapter,
  SnapshotPostgresAdapter,
  WalPostgresAdapter,
} from '@tuplescope/db-postgres';
import { CASES, SCHEMA, type Answer } from './cases.js';
import {
  assertionsOf,
  capabilityExplained,
  expectedFor,
  expectedShape,
  runCase,
  type CaseOutcome,
  type EngineUnderTest,
} from './suite.js';

// ─── the registry ─────────────────────────────────────────────────────────────

const ENGINES: EngineUnderTest[] = [
  { name: 'mvcc-xmin', create: (connectionString) => new MvccPostgresAdapter({ connectionString }) },
  { name: 'snapshot-diff', create: (connectionString) => new SnapshotPostgresAdapter({ connectionString }) },
  {
    name: 'wal',
    create: (connectionString) => new WalPostgresAdapter({ connectionString }),
    async unsupported(connectionString) {
      const adapter = new WalPostgresAdapter({ connectionString });
      try {
        await adapter.preflight();
        return null;
      } catch (error) {
        return (error as Error).message;
      } finally {
        await adapter.close();
      }
    },
  },
];

// ─── wiring ───────────────────────────────────────────────────────────────────

const BASE_URL =
  process.env['TUPLESCOPE_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:7432/postgres';

const CONNECTION = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(
  '-c search_path=conformance',
)}`;

let reachable = false;

/** Engine name → why it was skipped, so a skip is never silent. */
const skipped = new Map<string, string>();

before(async () => {
  const client = new pg.Client({ connectionString: BASE_URL, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    reachable = true;
  } catch {
    console.error(`\n  no database at ${BASE_URL} — conformance skipped\n`);
  }
  if (!reachable) return;
  for (const engine of ENGINES) {
    const reason = await engine.unsupported?.(CONNECTION);
    if (reason) {
      skipped.set(engine.name, reason);
      console.error(`\n  SKIPPING the \`${engine.name}\` engine — ${reason}\n`);
    }
  }
});

/**
 * Every engine's outcome for every case, keyed `engine\0case`.
 *
 * Keyed by name rather than by position: a case that throws before it records
 * anything would shift every later index for that engine alone, and the
 * comparison would then be between two different cases — which is exactly the
 * kind of false result this suite exists to catch.
 */
const observed = new Map<string, CaseOutcome>();
const at = (engine: string, name: string) => observed.get(`${engine}\u0000${name}`);

function sameAnswer(a: Answer, b: Answer): boolean {
  if (a.status !== b.status) return false;
  return a.status !== 'failed' || a.actual === (b as { actual: string }).actual;
}

function show(answer: Answer | undefined): string {
  if (!answer) return '(no expectation)';
  if (answer.status === 'failed') return `failed(${answer.actual})`;
  if (answer.status === 'unevaluable' && answer.reason) return `unevaluable — ${answer.reason}`;
  return answer.status;
}

// ─── part 1: each engine against the cases ────────────────────────────────────

for (const engine of ENGINES) {
  describe(`${engine.name} satisfies the contract`, () => {
    for (const testCase of CASES) {
      it(testCase.name, async (t) => {
        if (!reachable) return t.skip('no database');
        const why = skipped.get(engine.name);
        if (why) return t.skip(why);
        const outcome = await runCase(engine, CONNECTION, SCHEMA, testCase);
        observed.set(`${engine.name}\u0000${testCase.name}`, outcome);

        const expected = expectedFor(testCase, outcome.detection, outcome.fidelity);
        for (const source of assertionsOf(testCase)) {
          const want = expected[source];
          assert.ok(
            want,
            `\`${source}\` has no expectation for detection=${outcome.detection} ` +
              `fidelity=${outcome.fidelity}. An engine with a capability the case does not cover ` +
              `must not be waved through.`,
          );
          assert.ok(
            sameAnswer(outcome.answers[source]!, want),
            `${testCase.name} — \`${source}\`\n` +
              `  expected ${show(want)}, got ${show(outcome.answers[source])}\n` +
              `  because: ${testCase.because}`,
          );
        }

        // What declaring `transactional` commits to. A net engine must not
        // offer the list at all: an empty array would read as "nothing was
        // written in order", which is a claim it is in no position to make.
        if (outcome.fidelity === 'transactional') {
          assert.ok(
            outcome.mutations,
            `${engine.name} declares fidelity 'transactional' but offered no mutation list. ` +
              `A capability nothing can check is not a capability.`,
          );
          if (testCase.mutationsWhenTransactional) {
            assert.deepEqual(
              outcome.mutations,
              testCase.mutationsWhenTransactional,
              `${testCase.name} — mutation list differs\n  because: ${testCase.because}`,
            );
          }
        } else {
          assert.equal(
            outcome.mutations,
            undefined,
            `${engine.name} declares fidelity '${outcome.fidelity}' but offered a mutation list. ` +
              `An engine that cannot know the order must not appear to.`,
          );
        }

        // An engine that saw less must say so, or "less" reads as "nothing".
        if (testCase.shapeUnpinned) {
          const escalating = outcome.warnings.filter(
            (w) => w === 'scope-truncated' || w === 'reduced-fidelity',
          );
          const complete = Object.keys(outcome.shape).length > 0;
          assert.ok(
            complete || escalating.length > 0,
            `${engine.name} reported no changes and no warning for a case where rows were ` +
              `lost: ${testCase.shapeUnpinned}. Silence here is indistinguishable from ` +
              `"nothing happened".`,
          );
        }

        const wantShape = expectedShape(testCase, outcome.detection, outcome.fidelity);
        if (wantShape) {
          assert.deepEqual(
            outcome.shape,
            wantShape,
            `${testCase.name} — row shape differs\n  because: ${testCase.because}`,
          );
        }
      });
    }
  });
}

// ─── part 2: the engines against each other ───────────────────────────────────

describe('engines are interchangeable to a consumer', () => {
  it('answer every assertion identically unless a capability says otherwise', (t) => {
    if (!reachable) return t.skip('no database');
    const [first, ...rest] = ENGINES.map((e) => e.name).filter((n) => !skipped.has(n));
    assert.ok(first && rest.length > 0, 'invariance needs at least two engines that can run here');

    const divergences: string[] = [];
    for (const testCase of CASES) {
      const explained = capabilityExplained(testCase);
      const baseline = at(first, testCase.name);
      if (!baseline) continue;

      for (const other of rest) {
        const compare = at(other, testCase.name);
        if (!compare) continue;
        for (const source of assertionsOf(testCase)) {
          if (explained.has(source)) continue;
          const a = baseline.answers[source]!;
          const b = compare.answers[source]!;
          if (!sameAnswer(a, b)) {
            divergences.push(
              `${testCase.name} — \`${source}\`: ${first} said ${show(a)}, ${other} said ${show(b)}`,
            );
          }
        }
      }
    }

    assert.deepEqual(
      divergences,
      [],
      `Two engines gave a consumer different answers to the same question, and no declared\n` +
        `capability explains the difference. Either the engines disagree about a fact — in which\n` +
        `case one is wrong — or the difference is real and ChangeSet has no way to express it, in\n` +
        `which case the contract needs the axis. Teaching consumers the engine list is not an\n` +
        `option.\n\n${divergences.join('\n')}`,
    );
  });

  it('report the same row shape unless detection says otherwise', (t) => {
    if (!reachable) return t.skip('no database');
    const [first, ...rest] = ENGINES.map((e) => e.name).filter((n) => !skipped.has(n));
    const divergences: string[] = [];
    for (const testCase of CASES) {
      if (testCase.shapeByDetection || testCase.shapeByCapability || testCase.shapeUnpinned) continue;
      const baseline = at(first!, testCase.name);
      if (!baseline) continue;
      for (const other of rest) {
        const compare = at(other, testCase.name);
        if (!compare) continue;
        try {
          assert.deepEqual(compare.shape, baseline.shape);
        } catch {
          divergences.push(
            `${testCase.name}\n    ${first}: ${JSON.stringify(baseline.shape)}\n` +
              `    ${other}: ${JSON.stringify(compare.shape)}`,
          );
        }
      }
    }
    assert.deepEqual(divergences, [], `Engines disagree about what changed:\n${divergences.join('\n')}`);
  });

  it('declares a capability for every engine, and no two are identical', (t) => {
    if (!reachable) return t.skip('no database');
    // Two engines with the same declared capabilities that behave differently
    // would slip through every check above. Not fatal, but worth knowing.
    const ran = ENGINES.filter((e) => !skipped.has(e.name));
    const profiles = ran.map((e) => {
      const outcome = at(e.name, CASES[0]!.name);
      return `${e.name}: ${outcome?.detection}/${outcome?.fidelity}`;
    });
    console.log(`\n    capability profiles — ${profiles.join(', ')}\n`);
    if (skipped.size > 0) {
      console.log(`    not exercised here — ${[...skipped.keys()].join(', ')}\n`);
    }
    // Two engines declaring the same capabilities but behaving differently
    // would slip past every check above.
    assert.equal(new Set(profiles.map((p) => p.split(': ')[1])).size, ran.length);
  });
});

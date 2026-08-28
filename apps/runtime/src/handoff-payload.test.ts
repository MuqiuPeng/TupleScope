/**
 * What the browser receives.
 *
 * The page has no build step, so anything it needs computed has to arrive
 * computed. It used to build the SELECT itself — a second implementation of the
 * quoting rules, which emitted `col = NULL` for a null key and never escaped a
 * backslash. This test pins that the statement now comes from the server.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChangeSet, Run, RowChange } from '@statescope/core';
import { masked, visible } from '@statescope/core';
import { withHandoffs } from './handoff-payload.js';

const RENDERING = {
  DateStyle: 'ISO, MDY',
  TimeZone: 'UTC',
  bytea_output: 'hex',
  IntervalStyle: 'iso_8601',
  extra_float_digits: '1',
};

function runWith(change: RowChange): Run {
  const changes: ChangeSet = {
    captureMethod: 'mvcc-xmin',
    detection: 'write',
    fidelity: 'net',
    scope: {
      schema: 'tenant_a',
      database: 'billing',
      allTables: true,
      tables: [
        { table: 'wallets', ignoreColumns: [], maskedColumns: [], keyStrategy: 'primary-key' },
      ],
    },
    changes: [change],
    rendering: RENDERING,
    warnings: [],
    durationMs: 1,
  };
  return {
    id: 'run_1',
    scenarioId: 's',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    coverage: 'full',
    variables: {},
    steps: [
      {
        stepId: 'step_1',
        name: 'a step',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        request: { method: 'POST', url: 'http://x/y' },
        changes,
        assertions: [],
      },
    ],
  } as unknown as Run;
}

const change = (key: RowChange['key']): RowChange => ({
  table: 'wallets',
  key,
  kind: 'update',
  before: null,
  after: null,
  changedColumns: [],
  visibleColumns: [],
  hasWrite: true,
});

function firstHandoff(run: Run): Record<string, unknown> {
  const payload = withHandoffs(run) as {
    steps: { changes: { changes: { handoff: Record<string, unknown> }[] } }[];
  };
  return payload.steps[0]!.changes.changes[0]!.handoff;
}

describe('the run payload', () => {
  it('carries a schema-qualified statement for an addressable row', () => {
    const handoff = firstHandoff(
      runWith(change({ columns: [{ column: 'id', value: visible('text', 'wal_alice') }], token: 't' })),
    );
    assert.equal(handoff['sql'], `SELECT * FROM "tenant_a"."wallets" WHERE "id" = 'wal_alice';`);
    assert.equal(handoff['portable'], true);
  });

  it('escapes rather than emitting something that matches nothing', () => {
    const handoff = firstHandoff(
      runWith(change({ columns: [{ column: 'id', value: visible('text', "o'brien\\x") }], token: 't' })),
    );
    // Both halves in one value: the quote doubled, and the backslash carried
    // through E-notation so it means the same thing under either
    // standard_conforming_strings.
    assert.equal(handoff['sql'], `SELECT * FROM "tenant_a"."wallets" WHERE "id" = E'o''brien\\\\x';`);
  });

  it('renders IS NOT DISTINCT FROM for a null key, never `= NULL`', () => {
    const handoff = firstHandoff(
      runWith(change({ columns: [{ column: 'seat', value: visible('text', null) }], token: 't' })),
    );
    assert.match(String(handoff['sql']), /"seat" IS NOT DISTINCT FROM NULL/);
    assert.doesNotMatch(String(handoff['sql']), /=\s*NULL/);
  });

  it('sends no statement and a reason when the row cannot be addressed', () => {
    const handoff = firstHandoff(
      runWith(change({ columns: [{ column: 'email', value: masked('text') }], token: 't' })),
    );
    assert.equal(handoff['sql'], undefined);
    assert.match(String(handoff['reason']), /masked at capture/);
  });

  it('flags a run whose rendering was not pinned as unportable', () => {
    const run = runWith(
      change({ columns: [{ column: 'id', value: visible('text', 'wal_alice') }], token: 't' }),
    );
    const step = run.steps[0]! as { changes: ChangeSet };
    (step.changes as { rendering: Record<string, string> }).rendering = {
      ...RENDERING,
      DateStyle: 'SQL, DMY',
    };
    const handoff = firstHandoff(run);
    // The statement is still produced — it is correct against the database it
    // came from. What is false is that it means the same thing anywhere else.
    assert.ok(handoff['sql']);
    assert.equal(handoff['portable'], false);
  });
});

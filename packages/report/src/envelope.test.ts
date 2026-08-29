/**
 * What survives the trip into JSON.
 *
 * The envelope is the boundary where a run stops being objects in memory and
 * becomes a file other tools read. Anything dropped here is not recoverable
 * downstream, however carefully the engine measured it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChangeSet } from '@tuplescope/core';
import { summariseChanges } from './envelope.js';
import { visible } from '@tuplescope/core';

const CHANGES: ChangeSet = {
  captureMethod: 'mvcc-xmin',
  detection: 'write',
  fidelity: 'net',
  scope: {
    schema: 'tenant_a',
    database: 'billing',
    allTables: false,
    tables: [{ table: 'wallets', ignoreColumns: [], maskedColumns: [], keyStrategy: 'primary-key' }],
  },
  changes: [
    {
      table: 'wallets',
      key: {
        columns: [{ column: 'id', value: visible('text', 'wal_alice') }],
        token: '[["id","wal_alice"]]',
      },
      kind: 'update',
      before: { balance: visible('numeric', '10.00') },
      after: { balance: visible('numeric', '9.00') },
      changedColumns: ['balance'],
      visibleColumns: ['balance'],
      hasWrite: true,
    },
  ],
  rendering: { DateStyle: 'ISO, MDY', TimeZone: 'UTC', bytea_output: 'hex', IntervalStyle: 'iso_8601', extra_float_digits: '1' },
  warnings: [],
  durationMs: 4,
};

describe('the change summary', () => {
  it('says where the tables it counted actually live', () => {
    // A RowChange carries a bare table name, which only means something inside
    // the connection that produced it. Measured across two schemas in one
    // database: a statement generated against `tenant_a` came back with
    // `tenant_b`'s row — different balance, no error, nothing to notice.
    const summary = summariseChanges(CHANGES);
    assert.equal(summary.scope.schema, 'tenant_a');
    assert.equal(summary.scope.database, 'billing');
  });

  it('records the settings the text was printed under', () => {
    // Without this a locator built from a stored run has to trust that whatever
    // produced the file was pinned, and there is nobody left to ask.
    assert.deepEqual(summariseChanges(CHANGES).rendering, {
      DateStyle: 'ISO, MDY',
      TimeZone: 'UTC',
      bytea_output: 'hex',
      IntervalStyle: 'iso_8601',
      extra_float_digits: '1',
    });
  });

  it('keeps the counts and the location together', () => {
    // Separately correct is not enough: a reader needs to know that *these*
    // counts belong to *that* schema, in one object, or the pairing is a guess.
    const summary = summariseChanges(CHANGES);
    assert.deepEqual(summary.scope, {
      schema: 'tenant_a',
      database: 'billing',
      allTables: false,
      tableCount: 1,
    });
    assert.deepEqual(summary.tables, [
      { table: 'wallets', inserted: 0, updated: 1, deleted: 0, writtenNoVisibleChange: 0 },
    ]);
  });
});

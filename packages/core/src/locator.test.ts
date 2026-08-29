/**
 * What can be addressed, and what must refuse to be.
 *
 * The refusals are the interesting half. A locator that answers when it should
 * not produces a statement that runs, returns nothing, and looks like the row
 * was deleted.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChangeSet, RowChange } from './changeset.js';
import { masked, unknown, visible } from './value.js';
import { explain, locatorFor } from './locator.js';
import { renderSelect } from './sql.js';

const RENDERING = {
  DateStyle: 'ISO, MDY',
  TimeZone: 'UTC',
  bytea_output: 'hex',
  IntervalStyle: 'iso_8601',
  extra_float_digits: '1',
};

function changeSet(change: RowChange, overrides: Partial<ChangeSet['scope']> = {}): ChangeSet {
  return {
    captureMethod: 'mvcc-xmin',
    detection: 'write',
    fidelity: 'net',
    scope: {
      schema: 'tenant_a',
      database: 'billing',
      allTables: true,
      tables: [
        { table: change.table, ignoreColumns: [], maskedColumns: [], keyStrategy: 'primary-key' },
      ],
      ...overrides,
    },
    changes: [change],
    rendering: RENDERING,
    warnings: [],
    durationMs: 1,
  };
}

const update = (key: RowChange['key'], kind: RowChange['kind'] = 'update'): RowChange => ({
  table: 'wallets',
  key,
  kind,
  before: null,
  after: null,
  changedColumns: [],
  visibleColumns: [],
  hasWrite: true,
});

const plainKey = {
  columns: [{ column: 'id', value: visible('text', 'wal_alice') }],
  token: 'tok',
};

describe('a usable locator', () => {
  it('names the database and schema the capture actually watched', () => {
    // A bare table name only means something inside the connection that
    // produced it. Measured across two schemas of one database: a statement
    // generated against `tenant_a` returned `tenant_b`'s row, different
    // balance, no error.
    const locator = locatorFor(update(plainKey), changeSet(update(plainKey)));
    assert.equal(locator.state, 'usable');
    assert.deepEqual(locator.state === 'usable' ? locator.location : null, {
      database: 'billing',
      schema: 'tenant_a',
    });
  });

  it('renders through the shared renderer, schema-qualified', () => {
    const locator = locatorFor(update(plainKey), changeSet(update(plainKey)));
    assert.equal(locator.state, 'usable');
    if (locator.state !== 'usable') return;
    assert.equal(
      renderSelect(locator.location.schema, locator.table, locator.key.columns),
      `SELECT * FROM "tenant_a"."wallets" WHERE "id" = 'wal_alice';`,
    );
  });

  it('carries a deleted row in its own arm, so an empty result is not a surprise', () => {
    const change = update(plainKey, 'delete');
    const locator = locatorFor(change, changeSet(change));
    assert.equal(locator.state, 'usable-absent');
    assert.equal(locator.state === 'usable-absent' ? locator.kind : null, 'delete');
  });
});

describe('a locator that refuses', () => {
  it('refuses a masked key, and explain() says what to change', () => {
    const change = update({ columns: [{ column: 'email', value: masked('text') }], token: 'tok' });
    const locator = locatorFor(change, changeSet(change));
    assert.equal(locator.state, 'unavailable');
    if (locator.state !== 'unavailable') return;
    assert.equal(locator.reason.reason, 'masked-key');
    assert.match(explain(locator.reason), /`email`/);
    assert.match(explain(locator.reason), /maskColumns/);
  });

  it('refuses an unreadable key, naming the cause', () => {
    const change = update({
      columns: [{ column: 'blob', value: unknown('bytea', 'toast-not-carried') }],
      token: 'tok',
    });
    const locator = locatorFor(change, changeSet(change));
    assert.equal(locator.state, 'unavailable');
    if (locator.state !== 'unavailable') return;
    assert.equal(locator.reason.reason, 'unknown-value');
    assert.match(explain(locator.reason), /toast-not-carried/);
  });

  it('refuses a table with no key at all', () => {
    const change = update(null);
    const locator = locatorFor(
      change,
      changeSet(change, {
        tables: [
          { table: 'wallets', ignoreColumns: [], maskedColumns: [], keyStrategy: 'full-row-multiset' },
        ],
      }),
    );
    assert.equal(locator.state, 'unavailable');
    if (locator.state !== 'unavailable') return;
    assert.equal(locator.reason.reason, 'no-stable-key');
    assert.match(explain(locator.reason), /primary key|unique index/);
  });

  it('says a keyless change under a keyed table is a capture bug, not a schema one', () => {
    // The two halves of `no-stable-key` are different problems with different
    // fixes, and one message for both leaves the reader guessing which.
    const change = update(null);
    const locator = locatorFor(change, changeSet(change));
    assert.equal(locator.state, 'unavailable');
    if (locator.state !== 'unavailable') return;
    assert.match(explain(locator.reason), /capture bug/);
  });

  it('refuses when the run did not record where it was watching', () => {
    // Rather than defaulting to `public`: stock `"$user", public` makes
    // current_schema() role-dependent, so the default would be wrong for
    // exactly the setups where it matters.
    const change = update(plainKey);
    const locator = locatorFor(change, changeSet(change, { schema: '' }));
    assert.equal(locator.state, 'unavailable');
    if (locator.state !== 'unavailable') return;
    assert.equal(locator.reason.reason, 'location-unknown');
  });
});

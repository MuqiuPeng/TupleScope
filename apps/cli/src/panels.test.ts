/**
 * `check` over panel sources.
 *
 * It resolved a panel's tables and predicate columns and not a column read as
 * a value, so `after(updated(wallets, id = "x").balanse)` passed `check` and
 * drew an empty line — the assertion audit catches the same typo in a scenario.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { panelProblems } from './panels.js';

const tables = new Set(['wallets', 'payments']);
const columns = new Map([
  ['wallets', new Set(['id', 'balance'])],
  ['payments', new Set(['id', 'status'])],
]);
const panel = (sources: Record<string, string>) => [{ title: 'Wallet balances', sources }];

describe('panelProblems', () => {
  it('names a column read as a value that its table does not have', () => {
    const out = panelProblems(panel({ demo: 'after(updated(wallets, id = "x").balanse)' }), tables, columns);
    assert.equal(out.length, 1, out.join('\n'));
    assert.match(out[0]!, /source `demo` reads `wallets\.balanse`, which is not a column of `wallets`/);
  });

  it('resolves the column against the table underneath a .where and an aggregate', () => {
    const out = panelProblems(
      panel({ s: 'sum(delta(updated(wallets).where(id = "x").balanse))' }),
      tables,
      columns,
    );
    assert.equal(out.length, 1, out.join('\n'));
    assert.match(out[0]!, /reads `wallets\.balanse`/);
  });

  it('passes the columns that exist', () => {
    assert.deepEqual(
      panelProblems(panel({ demo: 'after(updated(wallets, id = "x").balance)' }), tables, columns),
      [],
    );
  });

  it('still names an unknown table once, and does not then guess at its columns', () => {
    const out = panelProblems(panel({ s: 'after(updated(walets, id = "x").balance)' }), tables, columns);
    assert.equal(out.length, 1, out.join('\n'));
    assert.match(out[0]!, /names table `walets`/);
  });

  it('still names a predicate column and a source that will not parse', () => {
    const out = panelProblems(
      panel({ a: 'after(updated(wallets, idd = "x").balance)', b: 'after(updated(' }),
      tables,
      columns,
    );
    assert.equal(out.length, 2, out.join('\n'));
    assert.match(out[0]!, /matches on `wallets\.idd`/);
    assert.match(out[1]!, /source `b` will not parse/);
  });
});

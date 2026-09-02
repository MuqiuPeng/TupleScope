/**
 * A filter that matches nothing filters nothing.
 *
 * `maskColumns` is the setting a reader trusts to keep a secret out of run
 * history, `--json` and CI reports. It is a list of bare column names applied
 * across every watched table, config validation accepts any string, and nothing
 * ever resolved those strings against the schema — so a typo produced exactly
 * the output a correct spelling produces on a run that never touched the
 * column, and the value went to disk in the clear.
 *
 * Found in this repository's own workspace file: `card_number` and
 * `provider_token` are masked in `tuplescope.yaml` and exist in no table of the
 * demo schema, so that masking had never done anything.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { unresolvedFilterColumns } from './output.js';

const schema = new Set(['id', 'balance', 'updated_at', 'email']);

describe('unresolvedFilterColumns', () => {
  it('says nothing when every filter column exists', () => {
    assert.deepEqual(
      unresolvedFilterColumns({ maskColumns: ['email'], ignoreColumns: ['updated_at'] }, schema),
      [],
    );
  });

  it('names a masked column that is not in the schema', () => {
    const out = unresolvedFilterColumns({ maskColumns: ['card_number'] }, schema);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /maskColumns/);
    assert.match(out[0]!, /card_number/);
    assert.match(out[0]!, /nothing is masked by it/);
  });

  it('distinguishes the two settings, because only one of them is a secret', () => {
    // Both are worth reporting, but they are not the same finding: an unmatched
    // `ignoreColumns` leaves noise in the diff, an unmatched `maskColumns`
    // leaves a value on disk.
    const [masked] = unresolvedFilterColumns({ maskColumns: ['nope'] }, schema);
    const [ignored] = unresolvedFilterColumns({ ignoreColumns: ['nope'] }, schema);
    assert.match(masked!, /masked by it/);
    assert.match(ignored!, /ignored by it/);
  });

  it('reports every unmatched column, not just the first', () => {
    // A config is edited in batches, and stopping at the first one turns a
    // second run of `check` into a second surprise.
    const out = unresolvedFilterColumns(
      { maskColumns: ['a', 'b'], ignoreColumns: ['c'] },
      schema,
    );
    assert.equal(out.length, 3);
  });

  it('treats an absent list as an empty one', () => {
    assert.deepEqual(unresolvedFilterColumns({}, schema), []);
  });

  it('matches on the exact name, not a substring', () => {
    // `card` must not be satisfied by `card_number` being present: the capture
    // compares column names for equality, so a prefix masks nothing.
    assert.equal(unresolvedFilterColumns({ maskColumns: ['ema'] }, schema).length, 1);
  });
});

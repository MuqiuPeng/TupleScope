/**
 * Statements a second tool will run.
 *
 * Every case here is one of the three ways the two implementations this
 * replaces disagreed, or one of the two ways they were both wrong.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { masked, unknown, visible } from './value.js';
import {
  quoteIdent,
  quoteLiteral,
  renderGuard,
  renderPredicate,
  renderSelect,
  UnrenderableValue,
} from './sql.js';

describe('quoting', () => {
  it('doubles a quote in an identifier', () => {
    assert.equal(quoteIdent('odd"name'), '"odd""name"');
  });

  it('doubles a quote in a literal', () => {
    assert.equal(quoteLiteral("o'brien"), "'o''brien'");
  });

  it('uses E-notation whenever a backslash is present', () => {
    // Measured on PostgreSQL 16 against a row whose key is `back\slash`:
    // `E'back\\slash'` found it under standard_conforming_strings on *and*
    // off; a plain `'back\slash'` found nothing under off, with only a warning.
    assert.equal(quoteLiteral('back\\slash'), "E'back\\\\slash'");
  });

  it('leaves an ordinary literal alone', () => {
    // An unconditional E'…' would also be correct, and would make every
    // statement look like it is doing something clever.
    assert.equal(quoteLiteral('wal_alice'), "'wal_alice'");
  });

  it('refuses a NUL rather than escaping it', () => {
    assert.throws(() => quoteLiteral('a\0b'), UnrenderableValue);
    assert.throws(() => quoteIdent('a\0b'), UnrenderableValue);
  });
});

describe('a predicate', () => {
  it('matches NULL with IS NOT DISTINCT FROM, never with =', () => {
    // `col = NULL` is UNKNOWN, so it matches nothing while looking like a
    // valid statement — the row it was meant to open comes back empty with no
    // error to explain why. The web page emitted exactly that.
    const sql = renderPredicate([{ name: 'seat', value: visible('text', null) }]);
    assert.equal(sql, '"seat" IS NOT DISTINCT FROM NULL');
    assert.doesNotMatch(sql, /=\s*NULL/);
  });

  it('joins a composite key with AND, in order', () => {
    assert.equal(
      renderPredicate([
        { name: 'row_no', value: visible('text', '12') },
        { name: 'seat', value: visible('text', 'A') },
      ]),
      `"row_no" = '12' AND "seat" = 'A'`,
    );
  });

  it('refuses a masked column, and says which one', () => {
    assert.throws(
      () => renderPredicate([{ name: 'email', value: masked('text') }]),
      (error: Error) => {
        assert.ok(error instanceof UnrenderableValue);
        assert.match(error.message, /`email`/);
        assert.match(error.message, /masked at capture/);
        return true;
      },
    );
  });

  it('refuses an unreadable column, naming the reason', () => {
    assert.throws(
      () => renderPredicate([{ name: 'blob', value: unknown('bytea', 'toast-not-carried') }]),
      /toast-not-carried/,
    );
  });

  it('refuses an empty key rather than rendering WHERE with nothing after it', () => {
    assert.throws(() => renderPredicate([]), UnrenderableValue);
  });
});

describe('a select', () => {
  it('qualifies the schema', () => {
    // The adapter's own queries are bare, which is safe only because they run
    // on the connection that resolved them. This text runs somewhere else.
    assert.equal(
      renderSelect('public', 'wallets', [{ name: 'id', value: visible('text', 'wal_alice') }]),
      `SELECT * FROM "public"."wallets" WHERE "id" = 'wal_alice';`,
    );
  });
});

describe('the guard', () => {
  const guard = renderGuard('demobank', 'public', 'wallets');

  it('compares the database with IS DISTINCT FROM', () => {
    assert.match(guard, /current_database\(\) IS DISTINCT FROM 'demobank'/);
  });

  it('never compares current_schema()', () => {
    // Measured twice. `current_schema()` is NULL when search_path names
    // nothing, so `<> 'public'` is NULL and the guard silently passes. And the
    // statement is qualified anyway, so a service that legitimately sets its
    // own search_path would be refused for no gain.
    assert.doesNotMatch(guard, /current_schema\(\)/);
  });

  it('checks the table is there, which is the question that remains', () => {
    assert.match(guard, /to_regclass\('"public"\."wallets"'\) IS NULL/);
  });
});

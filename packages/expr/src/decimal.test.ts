/**
 * The cases here are the ones a JS number gets wrong. That is the whole reason
 * this class exists, so they are the whole reason for this file.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Decimal } from './decimal.js';

describe('Decimal', () => {
  it('adds without binary floating-point error', () => {
    // 0.1 + 0.2 === 0.30000000000000004 as JS numbers.
    assert.equal(Decimal.parse('0.1').plus(Decimal.parse('0.2')).toString(), '0.3');
  });

  it('keeps integers beyond Number.MAX_SAFE_INTEGER exact', () => {
    // Number("9007199254740993") === 9007199254740992.
    const big = Decimal.parse('9007199254740993');
    assert.equal(big.toString(), '9007199254740993');
    assert.equal(big.plus(Decimal.parse('2')).toString(), '9007199254740995');
  });

  it('aligns operands of differing scale', () => {
    assert.equal(Decimal.parse('1000.00').minus(Decimal.parse('0.005')).toString(), '999.995');
    assert.equal(Decimal.parse('1').plus(Decimal.parse('0.50')).toString(), '1.50');
  });

  it('compares by value, so trailing zeros do not matter', () => {
    // Postgres renders numeric(14,2) as `1.10`; a literal in a scenario is `1.1`.
    assert.ok(Decimal.parse('1.10').equals(Decimal.parse('1.1')));
    assert.ok(Decimal.parse('100.00').equals(Decimal.parse('100')));
    assert.equal(Decimal.parse('-0.0').compare(Decimal.parse('0')), 0);
  });

  it('orders negatives correctly', () => {
    assert.equal(Decimal.parse('-100.00').compare(Decimal.parse('100.00')), -1);
    assert.equal(Decimal.parse('-1').compare(Decimal.parse('-2')), 1);
  });

  it('round-trips the negative sign through subtraction', () => {
    const delta = Decimal.parse('900.00').minus(Decimal.parse('1000.00'));
    assert.equal(delta.toString(), '-100.00');
    assert.equal(delta.negated().toString(), '100.00');
  });

  it('sums a double-entry pair to exactly zero', () => {
    const total = [Decimal.parse('-100.00'), Decimal.parse('100.00')].reduce(
      (acc, d) => acc.plus(d),
      Decimal.zero(),
    );
    assert.ok(total.isZero());
    assert.equal(total.toString(), '0.00');
  });

  it('rejects anything that is not a decimal', () => {
    for (const bad of ['', 'abc', '1.2.3', '1e5', 'NaN', 'Infinity', '0x10', '1,000']) {
      assert.equal(Decimal.isDecimal(bad), false, `${bad} should not parse`);
      assert.throws(() => Decimal.parse(bad), /not a decimal/);
    }
  });

  it('accepts the forms Postgres actually emits', () => {
    for (const good of ['0', '-0', '1000.00', '-100.00', '0.005', '+5', ' 12.50 ']) {
      assert.ok(Decimal.isDecimal(good), `${good} should parse`);
    }
  });
});

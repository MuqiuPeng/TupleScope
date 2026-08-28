/**
 * The cases are the specification, so a case that cannot even be parsed is a
 * hole in the specification that reads as coverage. This runs without a
 * database, so the hole is caught on any machine.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from '@statescope/expr';
import { CASES, type ConformanceCase } from './cases.js';
import { assertionsOf, expectedFor } from './suite.js';

describe('the conformance cases', () => {
  it('are all written in syntax the parser accepts', () => {
    const broken: string[] = [];
    for (const testCase of CASES) {
      for (const source of assertionsOf(testCase)) {
        try {
          parse(source);
        } catch (error) {
          broken.push(`${testCase.name} — ${source}\n    ${(error as Error).message}`);
        }
      }
    }
    assert.deepEqual(broken, [], `\n${broken.join('\n')}`);
  });

  it('each assert something', () => {
    for (const testCase of CASES) {
      const total = assertionsOf(testCase).length + Object.keys(testCase.shape ?? {}).length;
      assert.ok(
        total > 0 || testCase.shape !== undefined || testCase.shapeByDetection !== undefined,
        `${testCase.name} asserts nothing`,
      );
    }
  });

  it('give every case a reason it exists', () => {
    for (const testCase of CASES) {
      assert.ok(testCase.because.length > 20, `${testCase.name} has no explanation`);
    }
  });

  it('refuses a case whose expectation two tables both claim', () => {
    // The bug this replaced: `expectByFidelity` was applied after
    // `expectByDetection` and silently won, so a case meaning "both axes decide
    // this" quietly meant "fidelity decides this". Silence is the problem —
    // whichever table wins, the case no longer says what its author thought.
    const clash: ConformanceCase = {
      name: 'clash',
      because: 'two tables claim the same assertion, which must not resolve silently',
      act: [],
      expect: {},
      expectByDetection: { 'count(changes(*)) == 0': { write: { status: 'passed' } } },
      expectByFidelity: { 'count(changes(*)) == 0': { net: { status: 'unevaluable' } } },
    };
    assert.throws(() => expectedFor(clash, 'write', 'net'), /both .expectByDetection. and/);
  });

  it('resolves an answer that depends on both axes', () => {
    const joint: ConformanceCase = {
      name: 'joint',
      because: 'a ghost row is invisible to one engine, unanswerable to another, plain to a third',
      act: [],
      expect: {},
      expectByCapability: {
        'count(changes(t)) == 0': {
          'write/net': { status: 'passed' },
          'value/net': { status: 'unevaluable' },
          'write/transactional': { status: 'failed', actual: '2' },
        },
      },
    };
    const answer = (d: 'write' | 'value', f: 'net' | 'transactional') =>
      expectedFor(joint, d, f)['count(changes(t)) == 0'];
    assert.deepEqual(answer('write', 'net'), { status: 'passed' });
    assert.deepEqual(answer('value', 'net'), { status: 'unevaluable' });
    assert.deepEqual(answer('write', 'transactional'), { status: 'failed', actual: '2' });
    // An engine nobody wrote an expectation for is an omission, not a pass.
    assert.equal(answer('value', 'transactional'), undefined);
  });
});

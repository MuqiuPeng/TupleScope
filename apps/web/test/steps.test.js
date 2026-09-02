/**
 * The sentences the page prints beside a control the reader is about to press.
 *
 * These are claims about what the runner will do. A wrong one is cheaper than a
 * wrong verdict and no more honest, and until this file there was nothing that
 * could tell.
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { expectedStatus, dependenciesFor, assertionRank } = require('../public/steps.js');

describe('expectedStatus', () => {
  it('prefers a declared expectStatus', () => {
    assert.equal(expectedStatus({ expectStatus: 201, assert: ['response.status == 500'] }), 'expects HTTP 201');
  });

  it('reads one out of a response.status assertion', () => {
    assert.equal(expectedStatus({ assert: ['response.status == 201'] }), 'expects HTTP 201');
  });

  it('reads one however the assertion is spaced', () => {
    // YAML hands these through as written, and the parser treats all three as
    // the same assertion. The page used to require exactly one space either
    // side, so the other two fell through to the default and printed a
    // different expectation from the one in the file.
    assert.equal(expectedStatus({ assert: ['response.status==201'] }), 'expects HTTP 201');
    assert.equal(expectedStatus({ assert: ['response.status   ==   201'] }), 'expects HTTP 201');
    assert.equal(expectedStatus({ assert: ['  response.status == 201  '] }), 'expects HTTP 201');
  });

  it('says success rather than "anything" when nothing declares a status', () => {
    // The engine treats a missing expectStatus as "a success is expected", so a
    // 4xx fails the step. A reader who assumes the opposite writes a scenario
    // that cannot do what they think.
    assert.equal(expectedStatus({}), 'expects success (<400)');
    assert.equal(expectedStatus({ assert: ['count(inserted(payments)) == 1'] }), 'expects success (<400)');
  });

  it('is not fooled by a status compared inside a larger expression', () => {
    // `not(response.status == 500)` is not a claim that the step returns 500.
    assert.equal(expectedStatus({ assert: ['not(response.status == 500)'] }), 'expects success (<400)');
  });

  it('ignores a number that is not a status code', () => {
    assert.equal(expectedStatus({ assert: ['response.status == 20'] }), 'expects success (<400)');
  });

  it('takes the first status assertion when a step carries two', () => {
    assert.equal(
      expectedStatus({ assert: ['response.status == 201', 'response.status == 409'] }),
      'expects HTTP 201',
    );
  });
});

describe('dependenciesFor', () => {
  const step = {
    request: { path: '/payments/{{payment_id}}/refund', body: { actor: '{{operator}}' } },
  };
  const steps = [
    { name: 'Create payment', capture: { payment_id: 'body.id' } },
    { name: 'Sign in', capture: { operator: 'body.user' } },
  ];

  it('finds every variable the request needs, once each', () => {
    const found = dependenciesFor(
      { request: { path: '/a/{{x}}/{{x}}', body: { b: '{{y}}' } } },
      { steps },
    );
    assert.deepEqual(found.map((d) => d.name), ['x', 'y']);
  });

  it('names the step that produces an unavailable one', () => {
    // The point of the strip: an unavailable variable should say which step to
    // run first, not leave the reader searching the file for it.
    const [first] = dependenciesFor(step, { known: {}, steps });
    assert.deepEqual(
      { name: first.name, available: first.available, producer: first.producer },
      { name: 'payment_id', available: false, producer: 'Create payment' },
    );
  });

  it('marks one as available once the run has captured it', () => {
    const [first] = dependenciesFor(step, { known: { payment_id: 'pay_1' }, steps });
    assert.equal(first.available, true);
  });

  it('treats an empty string as captured, because it is', () => {
    // `available` turns on `!== undefined`, not on truthiness. A captured empty
    // id is a value the run really has, and showing it as missing sends the
    // reader to re-run a step that already worked.
    const [first] = dependenciesFor(step, { known: { payment_id: '' }, steps });
    assert.equal(first.available, true);
  });

  it('leaves the runner’s own variables out', () => {
    // `{{run}}` and `{{now}}` are supplied by the runner and are never
    // something a reader has to go and produce.
    const found = dependenciesFor({ request: { path: '/a/{{run}}/{{now}}/{{real}}' } }, { steps: [] });
    assert.deepEqual(found.map((d) => d.name), ['real']);
  });

  it('reports a variable nothing captures, with no producer', () => {
    const [only] = dependenciesFor({ request: { path: '/a/{{orphan}}' } }, { steps });
    assert.deepEqual({ name: only.name, producer: only.producer }, { name: 'orphan', producer: undefined });
  });

  it('survives a step with no request fields at all', () => {
    assert.deepEqual(dependenciesFor({ request: {} }, {}), []);
    assert.deepEqual(dependenciesFor({}, {}), []);
  });
});

describe('assertionRank', () => {
  it('puts what needs attention first, with unevaluable above passed', () => {
    // `unevaluable` is not a soft pass. It is the run saying it could not
    // establish the thing, which is precisely what a green-looking list buries.
    const order = ['passed', 'planned', 'unevaluable', 'failed'].sort((a, b) => assertionRank(a) - assertionRank(b));
    assert.deepEqual(order, ['failed', 'unevaluable', 'passed', 'planned']);
  });

  it('sorts an unknown status last rather than first', () => {
    // A status from a newer producer must not push itself to the top of the
    // list by being unrecognised.
    assert.ok(assertionRank('something-new') > assertionRank('planned'));
  });
});

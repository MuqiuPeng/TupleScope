/**
 * The rule the page had wrong: what shows when nothing has been run here.
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { chooseViewedRun } = require('../public/runs.js');

const run = (id) => ({ id });
const call = ({ history = [], viewedId = undefined, ran = [], resetHere = false } = {}) =>
  chooseViewedRun({ history, viewedId, ranThisSession: new Set(ran), resetHere });

describe('what the evidence panel shows', () => {
  it('shows nothing when this page has run nothing', () => {
    // The whole bug. The runtime had been up 27 hours and handed back four runs;
    // the page opened on the newest and announced it as a result.
    assert.equal(call({ history: [run('yesterday'), run('older')] }), null);
  });

  it('shows nothing when there is no history either', () => {
    assert.equal(call(), null);
  });

  it('shows the run this page just produced', () => {
    const mine = run('mine');
    assert.equal(call({ history: [mine], ran: ['mine'] }), mine);
  });

  it('shows the newest of this page’s runs, not an older one of its own', () => {
    const newest = run('second');
    assert.equal(call({ history: [newest, run('first')], ran: ['first', 'second'] }), newest);
  });

  it('stops showing its own run once the baseline is restored', () => {
    // The rows were true of a database that has since been wiped.
    assert.equal(call({ history: [run('mine')], ran: ['mine'], resetHere: true }), null);
  });
});

describe('an explicitly opened run', () => {
  it('is shown even though this page did not produce it', () => {
    // Reachable on purpose: this is what the history picker is for, and the
    // stale-run banner is what makes it honest.
    const old = run('yesterday');
    assert.equal(call({ history: [old], viewedId: 'yesterday' }), old);
  });

  it('is shown even after a reset — choosing it is the decision', () => {
    const old = run('yesterday');
    assert.equal(call({ history: [old], viewedId: 'yesterday', resetHere: true }), old);
  });

  it('falls back rather than trusting an id that is no longer in history', () => {
    assert.equal(call({ history: [run('a')], viewedId: 'evicted' }), null);
  });
});

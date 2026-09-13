/**
 * The checks that exist because what they catch otherwise stays green forever.
 *
 * Every case here is a suite that runs, passes, and establishes nothing. That is
 * the failure `check` exists to prevent, and until this file there was no test
 * of it anywhere — the logic lived twice, inline in two command handlers, each
 * reachable only through a process.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { auditScenarios, formatProblem, type AuditTarget } from './audit.js';

const schema = {
  tables: new Set(['payments', 'wallets', 'ledger_entries']),
  columns: new Map([
    ['payments', new Set(['id', 'status', 'amount'])],
    ['wallets', new Set(['id', 'balance'])],
    ['ledger_entries', new Set(['id', 'type'])],
  ]),
};

const target = (...assertions: string[]): AuditTarget[] => [
  {
    scenario: { id: 'refund', title: 'T', datasets: [] } as never,
    dataset: {
      id: 'happy',
      steps: [{ id: 'pay', name: 'Pay', request: { method: 'POST', path: '/p' }, assert: assertions }],
    } as never,
  },
];

const messages = (...assertions: string[]): string[] =>
  auditScenarios(target(...assertions), schema).problems.map((p) => p.message);

describe('a table outside the watch list', () => {
  const watching = (watch: string[], ...assertions: string[]): string[] =>
    auditScenarios(
      [
        {
          scenario: { id: 'refund', title: 'T', datasets: [], watch: watch.map((table) => ({ table })) } as never,
          dataset: {
            id: 'happy',
            steps: [{ id: 'pay', name: 'Pay', request: { method: 'POST', path: '/p' }, assert: assertions }],
          } as never,
        },
      ],
      schema,
    ).problems.map((p) => p.message);

  it('refuses an except naming a table the watch list leaves out, as the run does', () => {
    // Measured: `check` gave its clean sentence, exit 0, and the run refused
    // it — undecided, "`except` names `payment_intents`, which is not being
    // watched, so it excludes nothing (watched: wallets)", exit 3.
    assert.deepEqual(watching(['wallets'], 'hasWrite(changes(* except payments)) == false'), [
      '`except` names `payments`, which is not being watched, so it excludes nothing (watched: wallets) ' +
        '— every run leaves this assertion undecided',
    ]);
  });

  it('refuses a table the watch list leaves out, for the same reason', () => {
    assert.deepEqual(watching(['wallets'], 'count(inserted(payments)) == 0'), [
      'table `payments` is not being watched, so nothing can be asserted about it (watched: wallets) ' +
        '— every run leaves this assertion undecided',
    ]);
  });

  it('says nothing when the name is watched, or when there is no watch list', () => {
    assert.deepEqual(watching(['wallets', 'payments'], 'hasWrite(changes(* except payments)) == false'), []);
    assert.deepEqual(messages('hasWrite(changes(* except payments)) == false'), []);
  });

  it('leaves a name that is no table at all to its own line', () => {
    assert.deepEqual(watching(['wallets'], 'hasWrite(changes(* except paymnets)) == false'), [
      'excepts `paymnets`, which is not a table here — so it excludes nothing',
    ]);
  });
});

describe('names that do not resolve', () => {
  it('catches a misspelled table', () => {
    assert.deepEqual(messages('count(inserted(walets)) == 0'), [
      'names table `walets`, which is not in this database',
    ]);
  });

  it('catches one behind the bare-table shorthand', () => {
    // No `changes(` in the source at all — the shorthand becomes a selector
    // during parsing. The regex this replaced could not see it, and this is
    // exactly the form `promote` writes for a cross-row invariant.
    assert.deepEqual(messages('sum(delta(walets.balance)) == "0.00"'), [
      'names table `walets`, which is not in this database',
    ]);
  });

  it('catches a misspelled predicate column, which is the one that never fails loudly', () => {
    // The evaluator resolves predicate columns only when it has a row, and a
    // step that writes nothing never gives it one. `count(inserted(t).where(nmae
    // = "x")) == 0` is the shape of every "must not write twice" guard.
    assert.deepEqual(messages('count(inserted(payments).where(nmae = "x")) == 0'), [
      'matches on `payments.nmae`, which is not a column of `payments`',
    ]);
  });

  it('catches an except that excludes nothing', () => {
    assert.deepEqual(messages('hasWrite(changes(* except audti_log)) == false'), [
      'excepts `audti_log`, which is not a table here — so it excludes nothing',
    ]);
  });

  it('does not report a column twice for a table it has already rejected', () => {
    const out = messages('count(inserted(walets).where(blance = "1")) == 0');
    assert.equal(out.length, 1, out.join(' | '));
    assert.match(out[0]!, /names table/);
  });

  it('says nothing about a suite that resolves', () => {
    assert.deepEqual(
      messages(
        'count(inserted(payments)) == 1',
        'single(updated(wallets, id = "w1")).after.balance == "0.00"',
        'hasWrite(changes(* except ledger_entries)) == false',
      ),
      [],
    );
  });

  it('skips an assertion it cannot parse, leaving that to the run', () => {
    // `run` reports a syntax error with a position; guessing here would produce
    // a second, worse message about the same line.
    assert.deepEqual(messages('count(inserted(payments) =='), []);
  });
});

describe('steps that establish nothing', () => {
  it('counts a step with no assertions, and says so', () => {
    const result = auditScenarios(target(), schema);
    assert.equal(result.unchecked, 1);
    assert.equal(result.assertions, 0);
    assert.match(result.problems[0]!.message, /checks nothing/);
  });

  it('counts assertions across the selection, so a caller can refuse a suite of zero', () => {
    // Both callers use this to refuse the green sentence over a suite that
    // asserts nothing — the failure the command exists to prevent.
    assert.equal(auditScenarios(target('count(inserted(payments)) == 1'), schema).assertions, 1);
    assert.equal(auditScenarios([], schema).assertions, 0);
  });
});

describe('a column read as a value', () => {
  it('catches a misspelled column read off one side of a row', () => {
    // Reads nothing, and nothing on either side of a delta is zero — so the
    // delta and sum forms below passed over any movement of the real column.
    assert.deepEqual(messages('single(updated(wallets)).after.balanse == "1"'), [
      'reads `wallets.balanse`, which is not a column of `wallets`',
    ]);
  });

  it('catches one under delta(...) and behind the bare-table shorthand', () => {
    assert.deepEqual(messages('delta(single(rows(wallets, id = "x")).balanse) == "0"'), [
      'reads `wallets.balanse`, which is not a column of `wallets`',
    ]);
    assert.deepEqual(messages('sum(delta(wallets.balanse)) == "0.00"'), [
      'reads `wallets.balanse`, which is not a column of `wallets`',
    ]);
  });

  it('skips a column read under changes(*), where there is no one table to resolve it against', () => {
    assert.deepEqual(messages('single(changes(*)).after.balanse == "1"'), []);
  });

  it('does not report a column for a table it has already rejected', () => {
    assert.deepEqual(messages('single(updated(walets)).after.balanse == "1"'), [
      'names table `walets`, which is not in this database',
    ]);
  });
});

describe('what the capture engine cannot answer', () => {
  const under = (capture: { detection: 'write' | 'value'; fidelity: 'net' | 'transactional' }) =>
    (...assertions: string[]): string[] =>
      auditScenarios(target(...assertions), { ...schema, capture }).problems.map((p) => p.message);
  const net = under({ detection: 'write', fidelity: 'net' });
  const valueDetection = under({ detection: 'value', fidelity: 'net' });
  const everything = under({ detection: 'write', fidelity: 'transactional' });

  it('refuses atomic() and writeCount() under net fidelity, in the words the run uses', () => {
    assert.deepEqual(net('atomic(changes(*)) == true', 'writeCount(changes(wallets)) == 2'), [
      'atomic() needs the order writes happened in, and this workspace\'s engine captures with net ' +
        'fidelity — it records where each row ended up, not how it got there — so every run leaves ' +
        'this assertion undecided',
      'writeCount() needs the order writes happened in, and this workspace\'s engine captures with ' +
        'net fidelity — it records where each row ended up, not how it got there — so every run ' +
        'leaves this assertion undecided',
    ]);
    assert.deepEqual(everything('atomic(changes(*)) == true', 'writeCount(changes(wallets)) == 2'), []);
  });

  it('refuses hasWrite and every count over updated or changes under value detection', () => {
    const out = valueDetection(
      'hasWrite(changes(* except ledger_entries)) == false',
      'count(updated(wallets)) == 1',
      'any(wallets) == false',
      'isEmpty(changes(*)) == true',
      'count(inserted(payments)) == 1',
      'count(rows(wallets, id = "w1")) == 1',
      'count(deleted(payments)) == 0',
    );
    assert.deepEqual(out, [
      'hasWrite needs write detection, and this workspace\'s engine captures with value detection — ' +
        'a value comparison cannot tell a redundant write from no write at all — so every run leaves ' +
        'this assertion undecided',
      'counting over updated needs write detection, and this workspace\'s engine captures with value ' +
        'detection — a value comparison cannot tell a redundant write from no write at all — so every ' +
        'run leaves this assertion undecided',
      'any() over changes needs write detection, and this workspace\'s engine captures with value ' +
        'detection — a value comparison cannot tell a redundant write from no write at all — so every ' +
        'run leaves this assertion undecided',
      'isEmpty() over changes needs write detection, and this workspace\'s engine captures with value ' +
        'detection — a value comparison cannot tell a redundant write from no write at all — so every ' +
        'run leaves this assertion undecided',
    ]);
  });

  it('finds the refusal inside a comparison or a logical join', () => {
    assert.equal(valueDetection('response.status == 201 and count(updated(wallets)) == 1').length, 1);
    assert.equal(net('not atomic(changes(*))').length, 1);
  });

  it('says one thing per assertion, however many refusals it holds', () => {
    // The run stops at the first; so does this.
    assert.equal(valueDetection('count(updated(wallets)) == count(changes(payments))').length, 1);
  });

  it('checks nothing it was not told about', () => {
    // Today's callers pass no capture, and must see exactly what they saw.
    assert.deepEqual(messages('atomic(changes(*)) == true', 'hasWrite(changes(*)) == false'), []);
  });
});

describe('masked columns', () => {
  const masking = (maskColumns: string[], scenarioMask?: string[]) =>
    (...assertions: string[]): string[] => {
      const [only] = target(...assertions);
      const withScenarioMask: AuditTarget = {
        ...only!,
        scenario: { ...only!.scenario, ...(scenarioMask ? { maskColumns: scenarioMask } : {}) },
      };
      return auditScenarios([withScenarioMask], { ...schema, maskColumns }).problems.map((p) => p.message);
    };

  it('refuses a predicate on a masked column, in every predicate form', () => {
    const out = masking(['status'])(
      'count(rows(payments, status = "x")) == 0',
      'count(inserted(payments).where(status = "x")) == 0',
      'count(changes(*).where(status = "x")) == 0',
    );
    assert.deepEqual(out, [
      'matches on `payments.status`, which is masked at capture, so no run has its value to compare. ' +
        'Remove the column from `maskColumns` if the assertion needs it',
      'matches on `payments.status`, which is masked at capture, so no run has its value to compare. ' +
        'Remove the column from `maskColumns` if the assertion needs it',
      // Masking is by name in every table, so `changes(*)` does not hide it.
      'matches on `status`, which is masked at capture, so no run has its value to compare. ' +
        'Remove the column from `maskColumns` if the assertion needs it',
    ]);
  });

  it('refuses a masked column read as a value', () => {
    assert.deepEqual(masking(['amount'])('sum(delta(payments.amount)) == "0"'), [
      'reads `payments.amount`, which is masked at capture, so no run has its value. ' +
        'Remove the column from `maskColumns` if the assertion needs it',
    ]);
  });

  it('adds the scenario\'s own maskColumns, as the capture scope does', () => {
    assert.equal(masking([], ['balance'])('single(updated(wallets)).after.balance == "1"').length, 1);
  });

  it('leaves a table that does not have the column alone, and is silent when not asked', () => {
    assert.deepEqual(masking(['status'])('single(updated(wallets)).after.balance == "1"'), []);
    assert.deepEqual(messages('count(rows(payments, status = "x")) == 0'), []);
  });
});

describe('references in a request', () => {
  const requestTarget = (request: Record<string, unknown>): AuditTarget[] => [
    {
      scenario: { id: 'refund', title: 'T', datasets: [] } as never,
      dataset: {
        id: 'happy',
        steps: [{ id: 'pay', name: 'Pay', request, assert: ['response.status == 201'] }],
      } as never,
    },
  ];
  const refs = (request: Record<string, unknown>): string[] =>
    auditScenarios(requestTarget(request), schema).problems.map((p) => p.message);

  it('says the run refuses a secret reference, naming the field', () => {
    assert.deepEqual(
      refs({ method: 'GET', path: '/h', headers: { authorization: 'Bearer ${secret:alice_token}' } }),
      [
        '`request.headers.authorization` refers to `${secret:alice_token}`, and scenario files do not ' +
          'resolve secret references — the run refuses this step rather than send those characters. ' +
          'Put the credential in `identities` in the workspace file and select it with `as:`',
      ],
    );
  });

  it('says the run refuses an environment reference or a misspelt secret too, naming the field', () => {
    // It said "the run sends it to the API as those characters", which was
    // true then. The run now refuses every `${…}`, and this says so.
    const out = refs({
      method: 'POST',
      path: '/p/${TENANT}',
      idempotencyKey: 'k-${secret: x}',
      body: { card: { token: '${CARD_TOKEN:-tok}' }, items: ['${SECRET:y}'] },
    });
    assert.deepEqual(
      out.map((m) => m.split(', and')[0]),
      [
        '`request.path` holds `${TENANT}`',
        '`request.idempotencyKey` holds `${secret: x}`',
        '`request.body.card.token` holds `${CARD_TOKEN:-tok}`',
        '`request.body.items.0` holds `${SECRET:y}`',
      ],
    );
    assert.equal(
      out[0],
      '`request.path` holds `${TENANT}`, and a scenario file resolves no `${…}` reference — the run ' +
        'refuses this step rather than send those characters. Instead, use `identities` in the ' +
        'workspace file with `as:` for a credential, `capture:` and `{{name}}` for a value from an ' +
        'earlier response, or `$${` to send the characters `${` themselves',
    );
  });

  it('does not report the `$${` escape, which the run sends as `${`', () => {
    assert.deepEqual(
      refs({
        method: 'POST',
        path: '/p/$${literal}',
        headers: { 'x-t': 'a $${b}' },
        idempotencyKey: 'k-$${c}',
        body: { t: 'Hello $${name}', 'k$${d}': ['$${e}'] },
      }),
      [],
    );
  });

  it('finds one in a key as well as a value', () => {
    assert.deepEqual(
      refs({ method: 'POST', path: '/p', body: { '${FIELD}': 1 } }).map((m) => m.split(', and')[0]),
      ['`request.body` holds `${FIELD}` in a key'],
    );
  });

  it('says nothing about a request with only {{placeholders}}', () => {
    assert.deepEqual(refs({ method: 'POST', path: '/p/{{id}}', body: { id: '{{id}}' } }), []);
  });
});

describe('tables with no row identity', () => {
  // Measured before this existed: with a keyless table in the database,
  // `check` gave its clean sentence over `hasWrite(changes(*)) == false`, and
  // the run of the same dataset came back undecided.
  const withKeyless = {
    ...schema,
    tables: new Set([...schema.tables, 'audit_log']),
    columns: new Map([...schema.columns, ['audit_log', new Set(['event'])]]),
    keyless: new Set(['audit_log']),
  };
  const keyless = (...assertions: string[]): string[] =>
    auditScenarios(target(...assertions), withKeyless).problems.map((p) => p.message);
  const watching = (watch: string[], ...assertions: string[]): string[] => {
    const [only] = target(...assertions);
    const watched: AuditTarget = {
      ...only!,
      scenario: { ...only!.scenario, watch: watch.map((table) => ({ table })) },
    };
    return auditScenarios([watched], withKeyless).problems.map((p) => p.message);
  };

  it('refuses a question about every watched table that does not except it, in the words the run uses', () => {
    assert.deepEqual(keyless('hasWrite(changes(*)) == false'), [
      'hasWrite() over every watched table, and `audit_log` has no primary key or unique index — a ' +
        'delete there leaves no trace for a run to count, so every run leaves this assertion ' +
        'undecided. Exclude it with `except audit_log`, name the tables you mean in `watch:`, or ' +
        'give it a key',
    ]);
    assert.deepEqual(
      keyless('count(changes()) == 0', 'isEmpty(changes(*)) == true', 'any(changes(* except wallets)) == false').map(
        (m) => m.split(' over')[0],
      ),
      ['counting', 'isEmpty()', 'any()'],
    );
  });

  it('refuses updated or deleted of it, which is empty however much happened', () => {
    assert.deepEqual(keyless('count(deleted(audit_log)) == 0'), [
      'counting over deleted of `audit_log`, which has no primary key or unique index. This ' +
        "workspace's engine cannot pair a row to its previous version there, so deleted is empty " +
        'however much happened, and every run leaves this assertion undecided. Give the table a ' +
        'key, or ask about `changes` instead',
    ]);
    assert.deepEqual(
      keyless(
        'isEmpty(updated(audit_log)) == true',
        'hasWrite(deleted(audit_log)) == false',
        'any(updated(audit_log)) == false',
      ).map((m) => m.split(' of')[0]),
      ['isEmpty() over updated', 'hasWrite() over deleted', 'any() over updated'],
    );
  });

  it('leaves it alone once it is excepted, or when the question can be answered there', () => {
    assert.deepEqual(
      keyless(
        'hasWrite(changes(* except audit_log)) == false',
        'count(changes(wallets)) == 0',
        'count(inserted(audit_log)) == 0',
        'count(changes(audit_log)) == 1',
        'count(rows(audit_log, event = "x")) == 0',
        'single(inserted(audit_log)).after.event == "x"',
      ),
      [],
    );
  });

  it('asks the scope the run will build, where a watch list is every table there is', () => {
    // The run refuses the whole-scope form only when nobody chose the scope.
    assert.deepEqual(watching(['payments', 'audit_log'], 'hasWrite(changes(*)) == false'), []);
    assert.equal(watching(['payments', 'audit_log'], 'count(deleted(audit_log)) == 0').length, 1);
    assert.deepEqual(watching(['payments'], 'hasWrite(changes(*)) == false'), []);
  });

  it('asks about detection first, as the run does, and says one thing', () => {
    const out = auditScenarios(target('count(updated(audit_log)) == 0'), {
      ...withKeyless,
      capture: { detection: 'value', fidelity: 'net' },
    }).problems.map((p) => p.message);
    assert.equal(out.length, 1, out.join(' | '));
    assert.match(out[0]!, /^counting over updated needs write detection/);
  });

  it('checks nothing it was not told about', () => {
    assert.deepEqual(messages('hasWrite(changes(*)) == false', 'count(deleted(payments)) == 0'), []);
    assert.deepEqual(
      auditScenarios(target('hasWrite(changes(*)) == false'), { ...schema, keyless: new Set<string>() })
        .problems,
      [],
    );
  });
});

describe('the reported location', () => {
  it('carries scenario, dataset and step, so a caller can format its own way', () => {
    const [problem] = auditScenarios(target('count(inserted(nope)) == 0'), schema).problems;
    assert.deepEqual(
      { s: problem!.scenarioId, d: problem!.datasetId, st: problem!.stepId },
      { s: 'refund', d: 'happy', st: 'pay' },
    );
    assert.equal(
      formatProblem(problem!, '  '),
      '  refund/happy/pay  names table `nope`, which is not in this database',
    );
  });
});

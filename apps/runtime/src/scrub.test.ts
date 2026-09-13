/**
 * Resolved credentials, over a real Fastify with its real logger.
 *
 * Round 3 measured `GET /api/workspace` answering HTTP 500
 * `database "<the value>_nope" does not exist`, and the runtime's stdout log
 * carrying the same value, while the run-job path, which called `scrub`
 * itself, did not leak. What differed was only whether a person had
 * remembered to call the function on that path. These tests go through the
 * two places a line has to pass: the response and the logger.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { scrubbingLogStream, scrubErrorBodies, scrubStepErrors } from './scrub.js';

const VALUE = 'zq7Kprobe4tsx';
const scrub = (text: string): string => text.split(VALUE).join('[secret probe]');

async function appWith(lines: string[]) {
  // Exactly the wiring server.ts uses: the logger's stream, and the hook.
  const app = Fastify({
    logger: { level: 'info', stream: scrubbingLogStream(scrub, { write: (line) => lines.push(line) }) },
  });
  scrubErrorBodies(app, scrub);
  app.get('/thrown', async () => {
    // What pg-pool threw from `adapter.listTables()`, fields and all.
    throw Object.assign(new Error(`database "${VALUE}_nope" does not exist`), {
      code: '3D000',
      severity: 'FATAL',
      routine: 'InitPostgres',
    });
  });
  app.post('/sent', async (_request, reply) =>
    // A route that sends its own error body: `/api/reset` answers 502 with the
    // reset endpoint's message, and that names `resetUrl`.
    reply.status(502).send({
      error: 'RESET_FAILED',
      message: `Could not reach the reset endpoint at http://127.0.0.1:3000/reset?key=${VALUE}`,
    }),
  );
  app.get('/rows', async () => ({ after: { note: `${VALUE}` } }));
  await app.ready();
  return app;
}

describe('the workspace scrub in the runtime', () => {
  it('takes a resolved value out of a thrown error, the body Fastify builds by default', async () => {
    const lines: string[] = [];
    const app = await appWith(lines);
    const response = await app.inject({ method: 'GET', url: '/thrown' });
    assert.equal(response.statusCode, 500);
    assert.ok(!response.body.includes(VALUE), response.body);
    const body = JSON.parse(response.body) as { message: string; code: string };
    assert.equal(body.message, 'database "[secret probe]_nope" does not exist');
    assert.equal(body.code, '3D000');
    await app.close();
  });

  it('takes it out of the log line for that request, message, stack and msg', async () => {
    const lines: string[] = [];
    const app = await appWith(lines);
    await app.inject({ method: 'GET', url: '/thrown' });
    await app.close();
    const errorLine = lines.find((line) => JSON.parse(line).level === 50);
    assert.ok(errorLine, `no level-50 line among:\n${lines.join('')}`);
    assert.ok(!lines.join('').includes(VALUE), lines.join(''));
    const record = JSON.parse(errorLine) as { msg: string; err: { message: string; stack: string } };
    assert.match(record.msg, /\[secret probe\]_nope/);
    assert.match(record.err.message, /\[secret probe\]_nope/);
    assert.match(record.err.stack, /\[secret probe\]_nope/);
  });

  it('takes it out of an error body a route sends itself', async () => {
    const app = await appWith([]);
    const response = await app.inject({ method: 'POST', url: '/sent' });
    assert.equal(response.statusCode, 502);
    assert.ok(!response.body.includes(VALUE), response.body);
    assert.match(JSON.parse(response.body).message, /key=\[secret probe\]$/);
    await app.close();
  });

  it('leaves a success body alone: those are the rows a run observed', async () => {
    const app = await appWith([]);
    const response = await app.inject({ method: 'GET', url: '/rows' });
    assert.equal(JSON.parse(response.body).after.note, VALUE);
    await app.close();
  });

  it('finds a value in a log line even where JSON escaped it', () => {
    // A `"` or a `\` in the value is written as `\"` or `\\`, so a raw
    // substitution over the serialized line would not find it.
    const awkward = 'pa"ss\\word9';
    const out: string[] = [];
    const stream = scrubbingLogStream((text) => text.split(awkward).join('[secret db_password]'), {
      write: (line) => out.push(line),
    });
    stream.write(`${JSON.stringify({ level: 50, msg: `auth failed with ${awkward}` })}\n`);
    assert.equal(out.length, 1);
    assert.ok(out[0]!.endsWith('\n'));
    assert.ok(!out[0]!.includes(JSON.stringify(awkward).slice(1, -1)), out[0]);
    assert.equal(JSON.parse(out[0]!).msg, 'auth failed with [secret db_password]');
  });

  it('takes it out of a step error, which reaches the page inside a 200', () => {
    const steps = scrubStepErrors(
      [
        { stepId: 'a', error: { kind: 'network', message: `Could not reach http://${VALUE}:3000/x` } },
        { stepId: 'b' },
      ],
      scrub,
    );
    assert.equal((steps[0]!.error as { message: string }).message, 'Could not reach http://[secret probe]:3000/x');
    assert.deepEqual(steps[1], { stepId: 'b' });
  });
});

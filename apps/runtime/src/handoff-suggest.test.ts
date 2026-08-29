/**
 * The address hint that travels to the browser.
 *
 * `--server` is the one address TupleScope cannot derive, and the page used to
 * hand the reader a placeholder — `<db as adminer sees it>` — which means "go
 * and run `docker inspect`". The workspace config already names a host and a
 * port, so the page can offer candidates instead.
 *
 * The reason this file exists is the other half: that hint is rendered into a
 * command someone will copy, and the DSN it comes from carries a password.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { registerHandoffRoutes } from './handoff-routes.js';

async function suggestFor(connectionString: string): Promise<Record<string, unknown> | null> {
  const app = Fastify();
  registerHandoffRoutes(app, {
    workspaceRoot: '/nowhere',
    connectionString,
    findRun: () => undefined,
    openUrl: async () => {},
  });
  await app.ready();
  const response = await app.inject({ method: 'GET', url: '/api/handoff/targets' });
  await app.close();
  return (JSON.parse(response.body) as { suggest: Record<string, unknown> | null }).suggest;
}

describe('the address suggestion', () => {
  it('never carries the password, which the DSN it comes from does', async () => {
    // It is rendered into a command in a drawer, for copying. There is no
    // version of this hint worth leaking a credential for.
    const suggest = await suggestFor('postgresql://dbuser:SUPERSECRET_hunter2@db.internal:6543/app');
    assert.equal(JSON.stringify(suggest).includes('SUPERSECRET'), false);
    assert.equal(suggest?.['hostPort'], 'db.internal:6543');
    assert.equal(suggest?.['username'], 'dbuser');
  });

  it('offers a container address only for loopback', async () => {
    // Loopback means *this machine*, and inside a container that is the
    // container — so there are genuinely two views to choose between.
    const local = await suggestFor('postgresql://postgres:pw@127.0.0.1:7432/app');
    assert.equal(local?.['fromContainer'], 'host.docker.internal:7432');

    // A real hostname resolves the same either side of a container boundary.
    // A second candidate there would be invented.
    const remote = await suggestFor('postgresql://postgres:pw@db.internal:6543/app');
    assert.equal(remote?.['fromContainer'], 'db.internal:6543');
  });

  it('says nothing when the DSN cannot be read', async () => {
    // An unresolved `${secret:…}` is not a URL, and a wrong hint is worse than
    // the placeholder it replaced.
    assert.equal(await suggestFor('${secret:database_url}'), null);
  });
});

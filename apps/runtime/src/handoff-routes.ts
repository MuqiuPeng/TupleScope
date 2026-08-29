/**
 * The two things the browser cannot do for itself.
 *
 * A page cannot read `~/.tuplescope/handoff.json` and cannot spawn `psql`, so
 * both live here. What the page gets is deliberately thin: a list of what is
 * bound, and the result of opening one row through one target.
 *
 * The row is never named by the page. It sends a run id, a step id and an index
 * into that step's own change list, and the locator is rebuilt here from the
 * capture output — so a page (or anything that reached it) cannot ask for a
 * table the scenario never touched. That is the only thing standing between
 * this and "open any row of any table", and it is why the request carries no
 * table name, no key and no SQL.
 */

import type { FastifyInstance } from 'fastify';
import type { ChangeSet, Run, RowChange } from '@tuplescope/core';
import { handoffFor } from '@tuplescope/core';
import {
  adminerUrl,
  isGranted,
  loadHandoffConfig,
  psqlScript,
  runPsql,
  workspaceKey,
  type Binding,
} from '@tuplescope/handoff';

export interface HandoffRouteOptions {
  /** Where the workspace is, for matching grants. */
  workspaceRoot: string;
  /** This workspace's own DSN, so the page can suggest an address instead of asking. */
  connectionString: string;
  /** Finds a run the page refers to. Returns undefined if it is not one of ours. */
  findRun: (runId: string) => Run | undefined;
  /** Opens a URL with the platform opener. Injected so tests never launch a browser. */
  openUrl: (url: string) => Promise<void>;
}

interface OpenBody {
  runId?: string;
  stepId?: string;
  changeIndex?: number;
  alias?: string;
}

export function registerHandoffRoutes(app: FastifyInstance, options: HandoffRouteOptions): void {
  /**
   * What is bound, and whether it applies here.
   *
   * Both, separately. A binding that exists is not a binding that applies to
   * this workspace, and collapsing the two would show an enabled control for
   * something that will refuse on click.
   */
  app.get('/api/handoff/targets', async () => {
    const here = await workspaceKey(options.workspaceRoot);
    let config;
    try {
      config = await loadHandoffConfig(undefined, { allowRemote: true });
    } catch (error) {
      // A malformed file is reported, not swallowed into "nothing bound" — the
      // difference decides whether the user goes and fixes their config or
      // wonders why the thing they set up vanished.
      return { workspace: here, targets: [], error: message(error) };
    }
    return {
      workspace: here,
      suggest: addressCandidates(options.connectionString),
      targets: Object.entries(config.bindings).map(([alias, binding]) => ({
        alias,
        preset: binding.preset,
        granted: isGranted(binding, here),
        where: describe(binding),
        standing: standingLine(binding),
      })),
    };
  });

  /**
   * Opens one row through one target.
   *
   * `adminer-url` returns the URL and opens it with the platform opener;
   * `psql-service` runs and returns the captured output for the inspector. The
   * page never receives a DSN, a credential, or anything it could reuse to
   * reach the database itself.
   */
  app.post<{ Body: OpenBody }>('/api/handoff/open', async (request, reply) => {
    const { runId, stepId, changeIndex, alias } = request.body ?? {};
    if (!runId || !stepId || typeof changeIndex !== 'number' || !alias) {
      return reply
        .status(400)
        .send({ error: 'BAD_REQUEST', message: 'runId, stepId, changeIndex and alias are required.' });
    }

    const found = locate(options.findRun(runId), stepId, changeIndex);
    if (!found) {
      return reply
        .status(404)
        .send({ error: 'NO_SUCH_CHANGE', message: 'That row is not in a run this server produced.' });
    }

    const here = await workspaceKey(options.workspaceRoot);
    let binding: Binding | undefined;
    try {
      binding = (await loadHandoffConfig(undefined, { allowRemote: true })).bindings[alias];
    } catch (error) {
      return reply.status(409).send({ error: 'BAD_CONFIG', message: message(error) });
    }
    if (!binding) {
      return reply.status(409).send({
        error: 'NOT_BOUND',
        message: `\`${alias}\` is a name this repository chose. Nothing on this machine is bound to it.`,
      });
    }
    if (!isGranted(binding, here)) {
      return reply.status(409).send({
        error: 'NOT_ENABLED',
        message: `\`${alias}\` is not enabled for ${here}.`,
      });
    }

    const handoff = handoffFor(found.change, found.changes);
    if (handoff.locator.state === 'unavailable') {
      return reply.status(409).send({ error: 'NOT_ADDRESSABLE', message: handoff.reason });
    }
    const { location, table, key } = handoff.locator;

    if (binding.preset === 'adminer-url') {
      const built = adminerUrl(binding, location, table, key.columns);
      if ('detail' in built) {
        return reply.status(409).send({ error: 'NOT_ADDRESSABLE', message: built.detail });
      }
      await options.openUrl(built.url);
      return {
        kind: 'url' as const,
        url: built.url,
        absent: handoff.absent ?? false,
        portable: handoff.portable,
      };
    }

    const script = psqlScript(location, table, key.columns);
    const result = await runPsql(binding, script);
    return {
      kind: 'output' as const,
      script,
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr,
      killed: result.killed ?? null,
      absent: handoff.absent ?? false,
      portable: handoff.portable,
    };
  });
}

function locate(
  run: Run | undefined,
  stepId: string,
  index: number,
): { change: RowChange; changes: ChangeSet } | undefined {
  const step = run?.steps.find((s) => s.stepId === stepId);
  const changes = step?.changes;
  const change = changes?.changes[index];
  return change && changes ? { change, changes } : undefined;
}

function describe(binding: Binding): string {
  return binding.preset === 'adminer-url'
    ? `${new URL(binding.origin).host} as ${binding.username}`
    : `service ${binding.service}`;
}

function standingLine(binding: Binding): string {
  return binding.preset === 'adminer-url'
    ? `Adminer at ${new URL(binding.origin).host} as ${binding.username} · the key goes into browser history`
    : `psql, service ${binding.service} · SQL on stdin, not in ps`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Where this workspace reaches PostgreSQL, as candidates for `--server`.
 *
 * The page cannot derive the address Adminer uses — that is the whole point of
 * §4 — but it can stop asking the reader to go and find one when the workspace
 * config already names a host and a port.
 *
 * **Host, port and user only.** The DSN carries a password, and this travels to
 * a browser and into a command someone will paste somewhere.
 */
function addressCandidates(
  connectionString: string,
): { hostPort: string; fromContainer: string; username?: string } | null {
  try {
    const url = new URL(connectionString);
    const host = url.hostname;
    if (!host) return null;
    const port = url.port || '5432';
    const user = decodeURIComponent(url.username);
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    return {
      hostPort: `${host}:${port}`,
      // Only loopback has two views. A real hostname resolves the same inside a
      // container as outside, and offering an alternative would invent one.
      fromContainer: loopback ? `host.docker.internal:${port}` : `${host}:${port}`,
      ...(user ? { username: user } : {}),
    };
  } catch {
    // An unresolved `${secret:…}` is not a URL. No hint beats a wrong one.
    return null;
  }
}

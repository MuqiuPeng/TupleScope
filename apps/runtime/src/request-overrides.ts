import type { HttpRequest, Scenario } from '@statescope/core';

export interface RequestOverride {
  method: HttpRequest['method'];
  path: string;
  as: string | null;
  idempotencyKey: string | null;
  body: unknown;
}

const METHODS = new Set<HttpRequest['method']>([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
]);

/**
 * Applies browser playground values to one run without modifying the scenario
 * file. The YAML remains the repeatable default; an edit is an explicit,
 * ephemeral experiment whose exact request is recorded in the Run.
 */
export function withRequestOverrides(
  scenario: Scenario,
  datasetId: string,
  overrides: Readonly<Record<string, RequestOverride>> | undefined,
  identities: ReadonlyArray<string>,
): Scenario {
  if (!overrides || Object.keys(overrides).length === 0) return scenario;
  const dataset = scenario.datasets.find((candidate) => candidate.id === datasetId);
  if (!dataset) throw new Error(`Scenario \`${scenario.id}\` has no dataset \`${datasetId}\`.`);
  const stepIds = new Set(dataset.steps.map((step) => step.id));

  for (const [stepId, override] of Object.entries(overrides)) {
    if (!stepIds.has(stepId)) throw new Error(`Request override names unknown step \`${stepId}\`.`);
    if (!METHODS.has(override.method)) throw new Error(`Request override for \`${stepId}\` has an unsupported method.`);
    // Keep an editable request inside the configured backend. `new URL()` would
    // otherwise let `https://...` or `//other-host/...` escape the workspace.
    if (!override.path.startsWith('/') || override.path.startsWith('//')) {
      throw new Error(`Request override for \`${stepId}\` must use a path beginning with one slash.`);
    }
    if (override.as && !identities.includes(override.as)) {
      throw new Error(`Request override for \`${stepId}\` names unknown identity \`${override.as}\`.`);
    }
  }

  return {
    ...scenario,
    datasets: scenario.datasets.map((candidate) => candidate.id !== datasetId ? candidate : {
      ...candidate,
      steps: candidate.steps.map((step) => {
        const override = overrides[step.id];
        if (!override) return step;
        const {
          as: _previousIdentity,
          idempotencyKey: _previousIdempotencyKey,
          body: _previousBody,
          ...requestDefaults
        } = step.request;
        const request: HttpRequest = {
          ...requestDefaults,
          method: override.method,
          path: override.path,
          ...(override.as ? { as: override.as } : {}),
          ...(override.idempotencyKey ? { idempotencyKey: override.idempotencyKey } : {}),
          body: override.body,
        };
        return {
          ...step,
          request,
        };
      }),
    }),
  };
}

/**
 * What the page says a step expects, and what it needs before it can run.
 *
 * Both are claims about the engine's behaviour, printed next to a control the
 * reader is about to press, and both were derived inline in `app.js` where
 * nothing could check them. A sentence on screen that disagrees with what the
 * runner does is the same class of defect as a wrong verdict — it is just
 * cheaper to notice, if anyone ever looks.
 */

/**
 * The one-line summary of a step's expected status.
 *
 * Three sources, in order: a declared `expectStatus`, a `response.status == N`
 * assertion, or the engine's default. That default is not "anything" — a step
 * with no declared status is treated as expecting success, so a 4xx fails it
 * outright, and the page has to say so or a reader will assume the opposite.
 *
 * The assertion is matched loosely on whitespace because YAML hands these
 * through as written: `response.status==201` and `response.status  ==  201`
 * are the same assertion to the parser and used to be different here, with the
 * second one falling through to the default and reporting the wrong number.
 */
function expectedStatus(step) {
  if (step.expectStatus !== undefined) return `expects HTTP ${step.expectStatus}`;
  const exact = (step.assert ?? [])
    .map((source) => /^\s*response\.status\s*==\s*(\d{3})\s*$/.exec(source)?.[1])
    .find(Boolean);
  return exact ? `expects HTTP ${exact}` : 'expects success (<400)';
}

/** Variables the runner supplies itself, which are never a reader's problem. */
const BUILT_IN_VARIABLES = ['run', 'now'];

/**
 * The variables a step's request needs, and whether they are there yet.
 *
 * `producer` is the step that captures the name, so an unavailable variable
 * names the step to run first rather than leaving the reader to search for it.
 * A name nothing in this dataset captures has no producer, which is a different
 * problem and shows as one.
 */
function dependenciesFor(step, { known = {}, steps = [] } = {}) {
  const source = JSON.stringify({
    path: step.request?.path,
    body: step.request?.body,
    idempotencyKey: step.request?.idempotencyKey,
  });
  const names = [...new Set([...source.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]))].filter(
    (name) => !BUILT_IN_VARIABLES.includes(name),
  );
  return names.map((name) => ({
    name,
    available: known[name] !== undefined,
    producer: steps.find((candidate) => Object.hasOwn(candidate.capture ?? {}, name))?.name,
  }));
}

/**
 * Sort order for an assertion list: worst first.
 *
 * `unevaluable` sits above `passed` deliberately. It is not a soft pass — it is
 * the run saying it could not establish the thing, which is what a reader most
 * needs to see and exactly what a green-looking list buries.
 */
function assertionRank(status) {
  return { failed: 0, unevaluable: 1, passed: 2, planned: 3 }[status] ?? 4;
}

if (typeof module !== 'undefined') {
  module.exports = { expectedStatus, dependenciesFor, assertionRank, BUILT_IN_VARIABLES };
}

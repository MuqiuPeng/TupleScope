/* TupleScope's browser UI is deliberately build-free: edit, refresh, done. */
const TOKEN = new URLSearchParams(location.search).get('token') ?? sessionStorage.getItem('tuplescope-token') ?? '';
if (TOKEN) sessionStorage.setItem('tuplescope-token', TOKEN);
if (location.search) history.replaceState({}, '', location.pathname);

const $ = (selector) => document.querySelector(selector);
const el = (tag, className, text) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-tuplescope-token': TOKEN, ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw apiError({ status: response.status, body, path });
  return body;
}

const state = {
  workspace: null,
  scenarios: [],
  selected: null,
  selectedStepId: null,
  run: null,
  runScope: [],
  running: false,
  runError: null,
  followProgress: true,
  evidenceMode: 'step',
  drafts: new Map(),
  knownVariables: {},
  datasetSelections: new Map(),
  runHistories: new Map(),
  viewedRunIds: new Map(),
  runErrors: new Map(),
  requestSnapshots: new Map(),
  knownVariablesByDataset: new Map(),
  activeJob: null,
  /**
   * Run ids this session actually produced.
   *
   * A reload restores the last run from the server and renders it exactly like
   * one that just finished: five green step pills, a change list, "Run clean".
   * Nothing said it was from before, so a page that had run nothing looked like
   * a page that had just run — and the database changes on screen belonged to
   * an earlier run against a database that has since moved on.
   */
  ranThisSession: new Set(),
  /**
   * Contexts whose evidence has been invalidated by an explicit reset.
   *
   * A reset is a deliberate act that makes the rows on screen describe a
   * database that no longer holds them, so the panel goes back to its
   * before-running state rather than showing history as though it were current.
   * The runs themselves are kept — the picker still reaches them.
   */
  resetSince: new Set(),
};

const scenario = () => state.scenarios.find((item) => item.id === state.selected?.scenarioId);
const dataset = () => scenario()?.datasets.find((item) => item.id === state.selected?.datasetId);
const plannedStep = () => dataset()?.steps.find((item) => item.id === state.selectedStepId);
const stepResult = () => state.run?.steps.find((item) => item.stepId === state.selectedStepId);
const contextKey = (context = state.selected) => context ? `${context.scenarioId}/${context.datasetId}` : '';
const sameContext = (left, right) => Boolean(left && right && left.scenarioId === right.scenarioId && left.datasetId === right.datasetId);
const historyFor = (context = state.selected) => state.runHistories.get(contextKey(context)) ?? [];

function rememberRun(run, snapshots) {
  const key = contextKey(run);
  const history = state.runHistories.get(key) ?? [];
  const next = [run, ...history.filter((candidate) => candidate.id !== run.id)]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, 20);
  state.runHistories.set(key, next);
  if (snapshots) state.requestSnapshots.set(run.id, snapshots);
}

function viewedRunFor(context = state.selected) {
  // The rule itself lives in runs.js, with its own tests. It was wrong here for
  // as long as it was only here.
  return chooseViewedRun({
    history: historyFor(context),
    viewedId: state.viewedRunIds.get(contextKey(context)),
    ranThisSession: state.ranThisSession,
    resetHere: state.resetSince.has(contextKey(context)),
  });
}

function selectDataset(scenarioId, datasetId) {
  state.selected = { scenarioId, datasetId };
  state.datasetSelections.set(scenarioId, datasetId);
  state.selectedStepId = state.scenarios
    .find((item) => item.id === scenarioId)?.datasets
    .find((item) => item.id === datasetId)?.steps[0]?.id ?? null;
  state.run = viewedRunFor(state.selected);
  state.runError = state.runErrors.get(contextKey()) ?? null;
  state.knownVariables = state.knownVariablesByDataset.get(contextKey()) ?? {};
  state.followProgress = true;
  state.evidenceMode = 'step';
  render();
}

function render() {
  renderWorkspace();
  renderScenarios();
  renderProgress();
  renderSteps();
  renderRequestWorkspace();
  renderEvidence();
}

function renderWorkspace() {
  const host = $('#workspaceMeta');
  host.innerHTML = '';
  if (!state.workspace) return;
  [state.workspace.name, state.workspace.captureMethod, `${state.workspace.tables?.length ?? 0} tables`]
    .forEach((value) => host.appendChild(el('span', 'meta-chip', value)));
  $('#scenarioCount').textContent = `${state.scenarios.length} scenario${state.scenarios.length === 1 ? '' : 's'}`;
}

function renderScenarios() {
  const host = $('#scenarios');
  host.innerHTML = '';
  for (const item of state.scenarios) {
    const open = item.id === state.selected?.scenarioId;
    const group = el('section', `scenario-group${open ? ' open' : ''}`);
    const heading = el('button', 'scenario-heading');
    heading.type = 'button';
    const copy = el('span');
    copy.append(el('strong', null, item.title), el('small', null, `${item.datasets.length} datasets`));
    heading.append(copy, el('span', 'chevron', '⌄'));
    heading.onclick = () => {
      if (!open) selectDataset(item.id, state.datasetSelections.get(item.id) ?? item.datasets[0]?.id);
      else group.classList.toggle('open');
    };
    group.appendChild(heading);

    const body = el('div', 'scenario-body');
    const picker = el('select', 'dataset-picker');
    picker.setAttribute('aria-label', `${item.title} dataset`);
    for (const candidate of item.datasets) {
      const option = el('option', null, candidate.label);
      option.value = candidate.id;
      option.selected = open && candidate.id === state.selected?.datasetId;
      picker.appendChild(option);
    }
    picker.onchange = () => selectDataset(item.id, picker.value);
    body.appendChild(picker);
    if (open) {
      const current = dataset();
      const summary = el('button', 'dataset-summary selected');
      summary.type = 'button';
      summary.append(
        el('span', null, current?.note || item.why?.trim() || 'Executable behavior'),
        el('small', null, `${current?.steps.length ?? 0} steps · ${current?.resetFirst ? 'reset isolated' : 'keeps current state'}`),
      );
      body.appendChild(summary);
      const steps = el('nav', 'step-list scenario-steps');
      steps.id = 'steps';
      steps.setAttribute('aria-label', `${current?.label ?? item.title} steps`);
      body.appendChild(steps);
    }
    group.appendChild(body);
    host.appendChild(group);
  }
}

/**
 * The run actions, for whoever is placing them.
 *
 * They used to sit under a heading that repeated the scenario title, the
 * dataset label and its note — all three of which the left column already
 * shows. A third of the middle column, saying nothing new, pushing the request
 * the reader came for below the fold. The heading is gone and the actions moved
 * into the run strip, which is already the row about this run.
 */
function runActions() {
  const current = dataset();
  if (!current) return null;
  const runLabel = current.resetFirst ? 'Reset & run dataset' : 'Run dataset';
  const run = el('button', 'primary-action', state.running ? 'Running…' : runLabel);
  run.type = 'button';
  run.disabled = state.running;
  if (current.resetFirst) run.title = 'Resets the configured baseline before running every step.';
  run.onclick = () => startRun({});

  const actions = el('div', 'dataset-actions');
  actions.appendChild(run);
  // Reset on its own. Not offered as "run without resetting": the dataset's
  // author declared `resetFirst` because its assertions assume a fresh
  // baseline, and quietly skipping it produces a red that means nothing. What
  // was missing is the other half — reaching a known state *without* then
  // running five requests over it, which is what you want before going and
  // looking at the database yourself.
  if (current.resetFirst && state.workspace?.resetConfigured) {
    const reset = el('button', 'secondary-action', 'Reset baseline');
    reset.type = 'button';
    reset.disabled = state.running;
    reset.title = 'Puts the database back to its baseline and stops there.';
    reset.onclick = () => resetBaseline(reset);
    actions.appendChild(reset);
  }
  return actions;
}

function renderProgress() {
  const host = $('#runStrip');
  host.innerHTML = '';
  const current = dataset();
  if (!current) return;
  const activeHere = sameContext(state.activeJob, state.selected);
  const complete = state.run?.steps.length ?? 0;
  const total = activeHere
    ? state.activeJob.scope.length
    : state.run?.coverage === 'partial'
      ? Math.max(state.run.steps.length, 1)
      : current.steps.length;
  const outcome = activeHere ? 'running' : state.run ? runVerdict(state.run) : state.runError ? 'errored' : 'ready';
  const text = activeHere
    ? `Running step ${Math.min(complete + 1, total)} of ${total}`
    : state.running
      ? 'Another dataset is running · this run history remains available.'
    : state.runError
      ? 'Could not run'
      : state.run
        ? `${outcome === 'clean' ? 'Clean' : outcome} · ${complete}/${total} steps${state.run.coverage === 'partial' ? ' · partial evidence' : ''}`
        : 'Review the contract, then run when you are ready.';
  const summary = el('span');
  summary.id = 'runSummary';
  summary.append(el('span', `status-dot ${outcome}`), el('strong', null, text));
  const toolbar = el('div', 'run-toolbar');
  toolbar.appendChild(summary);
  // Right-hand side of the one row that is already about this run: what it did,
  // which one you are looking at, and what to do next.
  const controls = el('div', 'run-controls');
  const actions = runActions();
  if (actions) controls.appendChild(actions);
  const history = historyFor();
  if (history.length) {
    const picker = el('select', 'run-history-picker');
    picker.setAttribute('aria-label', 'Viewed run');
    if (!state.run) {
      // A `select` with nothing selected shows its first option, so without
      // this the control read `Latest · clean` over an empty evidence panel —
      // the same claim the panel had just stopped making.
      const none = el('option', null, `Open an earlier run… (${history.length})`);
      none.value = '';
      none.selected = true;
      picker.appendChild(none);
    }
    history.forEach((run, index) => {
      const time = new Date(run.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const verdict = run.status === 'running' ? 'running' : runVerdict(run);
      const option = el('option', null, `${index === 0 ? 'Latest' : time} · ${verdict}`);
      option.value = run.id;
      option.selected = run.id === state.run?.id;
      picker.appendChild(option);
    });
    picker.onchange = () => {
      if (!picker.value) return;
      state.viewedRunIds.set(contextKey(), picker.value);
      // Choosing one explicitly is a decision to look at it, reset or no reset.
      state.resetSince.delete(contextKey());
      state.run = history.find((run) => run.id === picker.value) ?? history[0];
      state.runError = null;
      renderProgress();
      renderSteps();
      renderRequestWorkspace();
      renderEvidence();
    };
    controls.appendChild(picker);
  }
  toolbar.appendChild(controls);
  const track = el('div', 'progress-track');
  const bar = el('span', `progress-bar ${outcome}`);
  bar.style.width = `${activeHere && state.run ? Math.round(complete / Math.max(total, 1) * 100) : state.run ? 100 : 0}%`;
  track.appendChild(bar);
  host.appendChild(toolbar);
  // Its own row, at full width, between the controls and the track. The summary
  // slot beside the controls is sized for `Clean · 2/2 steps`; a sentence long
  // enough to say what to do about the failure wrapped to twelve lines in it
  // and pushed the controls apart. A condition affecting the whole page is not
  // a status word, so the slot keeps `Could not run` and the sentence gets a
  // line of its own.
  if (state.runError) host.appendChild(el('p', 'run-error', state.runError.message));
  host.appendChild(track);
}

function renderSteps() {
  const host = $('#steps');
  if (!host) return;
  const previousScrollTop = host.scrollTop;
  host.innerHTML = '';
  const current = dataset();
  if (!current) return;
  const nextId = sameContext(state.activeJob, state.selected)
    ? state.activeJob.scope[state.run?.steps.length ?? 0]
    : null;
  let selectedCard;
  current.steps.forEach((step, index) => {
    const result = state.run?.steps.find((item) => item.stepId === step.id);
    const status = result ? stepVerdict(result) : state.running && step.id === nextId ? 'running' : 'pending';
    const selected = state.selectedStepId === step.id;
    const card = el('article', `step-card compact ${status}${selected ? ' selected' : ''}`);
    const heading = el('button', 'step-heading');
    heading.type = 'button';
    const main = el('span', 'step-main');
    const request = el('code');
    request.append(el('span', 'step-method', step.request.method), el('span', 'step-path', step.request.path));
    request.title = `${step.request.method} ${step.request.path}`;
    main.append(el('strong', null, step.name), request);
    heading.append(
      el('span', 'step-index', String(index + 1).padStart(2, '0')),
      main,
      el('span', `step-status ${status}`, statusLabel(status)),
    );
    heading.onclick = () => {
      state.selectedStepId = step.id;
      state.followProgress = false;
      renderSteps();
      renderRequestWorkspace();
      renderEvidence();
    };
    if (selected) heading.setAttribute('aria-current', 'step');
    card.appendChild(heading);
    const edited = el('span', 'step-edited', state.drafts.get(draftKey(step))?.dirty ? 'edited' : '');
    edited.dataset.stepEdited = step.id;
    card.appendChild(edited);
    host.appendChild(card);
    if (selected) selectedCard = card;
  });
  host.scrollTop = previousScrollTop;
  if (state.followProgress) selectedCard?.scrollIntoView({ block: 'nearest' });
}

function renderRequestWorkspace() {
  const host = $('#requestWorkspace');
  host.innerHTML = '';
  // The empty state lives with the thing it stands in for. It used to be static
  // markup in a header that also carried the dataset's title, label and note —
  // and once that header stopped being rendered, the placeholder would have
  // stayed on screen behind every dataset anyone selected.
  if (!dataset()) {
    host.appendChild(
      empty('Select a dataset', 'Choose a scenario on the left to inspect every request before anything runs.'),
    );
    return;
  }
  const step = plannedStep();
  if (!step) return;
  const result = stepResult();
  const index = dataset().steps.findIndex((candidate) => candidate.id === step.id);

  const heading = el('div', 'workspace-heading');
  const title = el('div');
  title.append(el('span', 'eyebrow', `Request ${index + 1} of ${dataset().steps.length}`), el('h2', null, step.name));
  heading.append(title, el('span', 'expectation-badge', expectedStatus(step)));
  host.appendChild(heading);

  const dependencies = stepDependencies(step);
  if (dependencies.length) host.appendChild(renderDependencies(dependencies));

  const custom = el('div', `custom-run-note${draftFor(step).dirty ? ' visible' : ''}`);
  custom.textContent = 'Custom request — assertions still describe the original scenario contract.';
  host.appendChild(custom);
  host.appendChild(requestEditor(step, result));

  const actions = el('div', 'request-actions');
  const missingDependencies = dependencies.some((dependency) => !dependency.available);
  const only = el('button', 'send-action', state.running ? 'Running…' : missingDependencies ? 'Needs earlier steps' : 'Run this step');
  only.disabled = state.running || missingDependencies;
  only.onclick = () => startRun({ onlyStepId: step.id });
  const from = el('button', 'secondary-action', 'Run from here');
  from.disabled = state.running || missingDependencies;
  from.onclick = () => startRun({ fromStepId: step.id });
  actions.append(only, from, el('span', 'expectation-copy', step.expect || expectedStatus(step)));
  host.appendChild(actions);

  const resultContext = renderResultContext(step, result);
  if (resultContext) host.appendChild(resultContext);
  host.appendChild(renderResponsePanel(result, step));
  host.appendChild(renderVariablesPanel());
  host.appendChild(renderContract(step, result));
}

// `expectedStatus`, `dependenciesFor` and `assertionRank` live in steps.js, so
// the sentences printed beside a control can be checked by something other than
// a person looking at the screen. This wrapper is all that is left of them here:
// the state they read is passed in rather than reached for.
const stepDependencies = (step) =>
  dependenciesFor(step, { known: state.knownVariables, steps: dataset()?.steps ?? [] });

function renderDependencies(dependencies) {
  const block = el('div', 'dependency-strip');
  block.appendChild(el('span', 'section-label', 'Step inputs'));
  dependencies.forEach((dependency) => {
    const item = el('span', `dependency ${dependency.available ? 'available' : 'missing'}`);
    item.textContent = dependency.available
      ? `${dependency.name} available`
      : `${dependency.name} · from ${dependency.producer || 'an earlier step'} · not captured yet`;
    block.appendChild(item);
  });
  return block;
}

function renderResultContext(step, result) {
  if (!result || !state.run) return null;
  const snapshot = state.requestSnapshots.get(state.run.id)?.[step.id];
  const differs = snapshot ? !draftMatchesSnapshot(draftFor(step), snapshot) : draftFor(step).dirty;
  const banner = el('div', `result-context-note${differs ? ' visible' : ''}`);
  banner.dataset.resultContext = step.id;
  const copy = el('div');
  copy.append(
    el('strong', null, 'Showing a result from earlier input'),
    el('span', null, `This response and evidence belong to run ${state.run.id}; your current draft has not produced them.`),
  );
  banner.appendChild(copy);
  if (snapshot) {
    const restore = el('button', 'secondary-action', 'Load sent input');
    restore.type = 'button';
    restore.onclick = () => loadSnapshot(step, snapshot);
    banner.appendChild(restore);
  }
  return banner;
}

function renderResponsePanel(result, step) {
  const panel = el('section', 'exchange-panel');
  panel.appendChild(sectionLabel('Response'));
  if (!result) {
    panel.appendChild(el('div', 'exchange-empty', 'Not run yet — edit the request, then run this step or the dataset.'));
    return panel;
  }
  if (result.error) {
    const error = el('div', 'assertion-row failed');
    error.append(el('span', null, result.error.message), el('code', null, result.error.kind));
    panel.appendChild(error);
    return panel;
  }
  const meta = el('div', 'response-meta');
  const actualUrl = el('code', 'actual-url', result.request.url);
  actualUrl.title = result.request.url;
  const statusMatched = step.expectStatus !== undefined
    ? result.response?.status === step.expectStatus
    : (result.response?.status ?? 500) < 400;
  meta.append(
    el('span', `response-status ${statusMatched ? 'good' : 'bad'}`, `HTTP ${result.response?.status ?? '—'}`),
    el('code', null, `${result.response?.durationMs ?? 0} ms`),
    actualUrl,
  );
  if (step.expectStatus !== undefined && step.expectStatus >= 400) {
    meta.appendChild(el('span', `response-verdict ${statusMatched ? 'good' : 'bad'}`, statusMatched ? 'Expected rejection · Passed' : `Expected HTTP ${step.expectStatus} · Failed`));
  }
  // The status is the signal; the body is reference. `HTTP 201` is half of this
  // product's whole argument — the API said it was fine — and the body is what
  // you open when a specific value is in question. Folded, it stops pushing the
  // assertions and the database changes down the page.
  const body = el('details', 'sent-request-panel');
  const bodySummary = el('summary');
  const text = pretty(result.response?.body);
  const fields = (() => {
    try {
      const v = JSON.parse(text);
      if (!v || typeof v !== 'object') return 'body';
      const n = Object.keys(v).length;
      return `${n} field${n === 1 ? '' : 's'}`;
    } catch {
      return 'body';
    }
  })();
  bodySummary.append(el('strong', null, 'Response body'), el('span', null, fields));
  const pre = el('pre', 'payload response-payload');
  pre.textContent = text;
  body.append(bodySummary, pre);
  panel.append(meta, renderSentRequest(result.request), body);
  return panel;
}

function renderSentRequest(request) {
  const details = el('details', 'sent-request-panel');
  const summary = el('summary');
  summary.append(el('strong', null, 'Sent request'), el('span', null, `${request.method} · recorded with this result`));
  const payload = el('pre', 'payload sent-request-payload');
  payload.textContent = JSON.stringify({
    method: request.method,
    url: request.url,
    ...(request.as ? { identity: request.as } : {}),
    headers: request.headers,
    ...(request.body !== undefined ? { body: pretty(request.body) } : {}),
  }, null, 2);
  details.append(summary, payload);
  return details;
}

function renderVariablesPanel() {
  const variables = Object.entries(state.run?.variables ?? state.knownVariables).filter(([name]) => !['run', 'now'].includes(name));
  if (!variables.length) {
    const empty = el('section', 'exchange-panel variables-panel');
    empty.appendChild(sectionLabel('Captured variables'));
    empty.appendChild(el('div', 'exchange-empty', 'Values captured from responses will appear here and feed later steps.'));
    return empty;
  }
  // Reference, not signal. They are named in the request line above and in the
  // assertions below, where they are already legible in context.
  const panel = el('details', 'exchange-panel variables-panel candidate-block');
  const heading = el('summary', 'candidate-summary');
  heading.append(el('strong', null, 'Captured variables'), el('span', null, `${variables.length} captured`));
  panel.appendChild(heading);
  const list = el('div', 'variables-list');
  variables.forEach(([name, value]) => {
    const row = el('div', 'variable-row');
    row.append(el('code', null, name), el('span', null, String(value)));
    list.appendChild(row);
  });
  panel.appendChild(list);
  return panel;
}

function renderContract(step, result) {
  const details = el('details', 'contract-panel');
  const summary = el('summary');
  const failed = result?.assertions.filter((assertion) => assertion.status === 'failed').length ?? 0;
  const undecided = result?.assertions.filter((assertion) => assertion.status === 'unevaluable').length ?? 0;
  // Open when something is wrong. A failing assertion and the values that did
  // not match are the most useful thing on the screen when they exist, and they
  // were behind a click while twenty passing ones took no clicking at all. When
  // everything passed there is nothing here to read, and the count says so.
  details.open = failed > 0 || undecided > 0;
  const count = result?.assertions.length ?? step.assert?.length ?? 0;
  const trouble = [failed ? `${failed} failed` : '', undecided ? `${undecided} undecided` : '']
    .filter(Boolean)
    .join(' · ');
  summary.append(
    el('strong', null, 'Behavior contract'),
    el('span', trouble ? 'contract-trouble' : null, trouble ? `${count} assertions · ${trouble}` : `${count} assertions`),
  );
  details.appendChild(summary);
  details.appendChild(el('p', 'contract-expect', step.expect || expectedStatus(step)));
  const list = el('div', 'assertion-list');
  const assertions = result
    ? [...result.assertions].sort((a, b) => assertionRank(a.status) - assertionRank(b.status))
    : (step.assert ?? []).map((source) => ({ source, status: 'planned' }));
  assertions.forEach((assertion) => {
    const row = el('div', `assertion-row ${assertion.status}`);
    row.append(el('span', null, assertion.source), el('code', null, assertion.status));
    list.appendChild(row);
  });
  details.appendChild(list);
  return details;
}

function draftFor(step) {
  const key = draftKey(step);
  if (!state.drafts.has(key)) {
    state.drafts.set(key, {
      method: step.request.method,
      path: step.request.path,
      as: step.request.as ?? '',
      idempotencyKey: step.request.idempotencyKey ?? '',
      bodyText: step.request.body === undefined || step.request.body === null
        ? ''
        : JSON.stringify(step.request.body, null, 2),
      dirty: false,
      error: '',
    });
  }
  return state.drafts.get(key);
}

function draftKey(step) {
  return `${state.selected.scenarioId}/${state.selected.datasetId}/${step.id}`;
}

function inputSnapshot(step) {
  const draft = draftFor(step);
  return {
    method: draft.method,
    path: draft.path,
    as: draft.as,
    idempotencyKey: draft.idempotencyKey,
    bodyText: draft.bodyText,
  };
}

function normalizedInput(input) {
  let body = input.bodyText.trim();
  if (body) {
    try { body = JSON.stringify(JSON.parse(body)); } catch { /* validation reports the syntax error elsewhere */ }
  }
  return JSON.stringify({
    method: input.method,
    path: input.path,
    as: input.as || '',
    idempotencyKey: input.idempotencyKey.trim(),
    body,
  });
}

function draftMatchesSnapshot(draft, snapshot) {
  return normalizedInput(draft) === normalizedInput(snapshot);
}

function loadSnapshot(step, snapshot) {
  const defaults = {
    method: step.request.method,
    path: step.request.path,
    as: step.request.as ?? '',
    idempotencyKey: step.request.idempotencyKey ?? '',
    bodyText: step.request.body === undefined || step.request.body === null ? '' : JSON.stringify(step.request.body, null, 2),
  };
  state.drafts.set(draftKey(step), {
    ...snapshot,
    dirty: normalizedInput(snapshot) !== normalizedInput(defaults),
    error: validateDraft(snapshot),
  });
  renderProgress();
  renderSteps();
  renderRequestWorkspace();
}

function requestEditor(step, result) {
  const draft = draftFor(step);
  const block = el('details', 'detail-block request-editor');
  block.open = !result || draft.dirty;
  const disclosure = el('summary', 'request-editor-summary');
  disclosure.append(
    el('span', 'section-label', result ? 'Request input' : 'Editable request'),
    el('code', null, `${draft.method} ${draft.path}`),
    el('span', 'request-editor-toggle', result ? 'Edit' : 'Open'),
  );
  block.appendChild(disclosure);
  const editorHeading = el('div', 'editor-heading');
  editorHeading.appendChild(sectionLabel('Editable request · this run only'));
  const reset = el('button', 'editor-reset', 'Restore defaults');
  reset.type = 'button';
  reset.disabled = !draft.dirty;
  reset.onclick = () => {
    state.drafts.delete(draftKey(step));
    renderProgress();
    renderSteps();
    renderRequestWorkspace();
  };
  editorHeading.appendChild(reset);
  block.appendChild(editorHeading);

  const requestLine = el('div', 'request-line');
  const method = el('select', 'request-method');
  ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].forEach((value) => {
    const option = el('option', null, value);
    option.value = value;
    option.selected = value === draft.method;
    method.appendChild(option);
  });
  const path = el('input', 'request-path');
  path.type = 'text';
  path.spellcheck = false;
  path.value = draft.path;
  requestLine.append(method, path);
  block.appendChild(requestLine);

  const meta = el('div', 'request-meta');
  const actorField = fieldLabel('Identity');
  const actor = el('select');
  actor.appendChild(new Option('(none)', ''));
  (state.workspace.identities ?? []).forEach((identity) => actor.appendChild(new Option(identity, identity)));
  actor.value = draft.as;
  actorField.appendChild(actor);
  const idemField = fieldLabel('Idempotency-Key');
  const idem = el('input');
  idem.type = 'text';
  idem.spellcheck = false;
  idem.placeholder = '(not sent)';
  idem.value = draft.idempotencyKey;
  idemField.appendChild(idem);
  meta.append(actorField, idemField);
  block.appendChild(meta);

  const bodyField = fieldLabel('Body · JSON; empty sends no body');
  const body = el('textarea', 'request-body');
  body.rows = 8;
  body.spellcheck = false;
  body.value = draft.bodyText;
  const validation = el('span', 'input-validation');
  bodyField.append(body, validation);
  block.appendChild(bodyField);

  const update = () => {
    draft.method = method.value;
    draft.path = path.value;
    draft.as = actor.value;
    draft.idempotencyKey = idem.value;
    draft.bodyText = body.value;
    draft.dirty = true;
    draft.error = validateDraft(draft);
    validation.textContent = draft.error || 'Custom values stay active until you restore the scenario defaults.';
    validation.className = `input-validation${draft.error ? ' invalid' : ''}`;
    reset.disabled = false;
    const custom = $('#requestWorkspace .custom-run-note');
    custom?.classList.add('visible');
    const marker = document.querySelector(`[data-step-edited="${CSS.escape(step.id)}"]`);
    if (marker) marker.textContent = 'edited';
    const resultNote = document.querySelector(`[data-result-context="${CSS.escape(step.id)}"]`);
    const sent = state.run ? state.requestSnapshots.get(state.run.id)?.[step.id] : null;
    if (resultNote) resultNote.classList.toggle('visible', sent ? !draftMatchesSnapshot(draft, sent) : draft.dirty);
  };
  [method, path, actor, idem, body].forEach((input) => input.addEventListener('input', update));
  validation.textContent = draft.dirty ? 'Custom values stay active until you restore the scenario defaults.' : 'Loaded from the scenario default.';
  return block;
}

function fieldLabel(text) {
  const label = el('label', 'request-field');
  label.appendChild(el('span', null, text));
  return label;
}

function validateDraft(draft) {
  if (!draft.path.startsWith('/') || draft.path.startsWith('//')) return 'Path must begin with one slash and stay inside this backend.';
  if (!draft.bodyText.trim()) return '';
  try { JSON.parse(draft.bodyText); return ''; }
  catch (error) { return `Body is not valid JSON: ${error.message}`; }
}

function detailBlock(label, line, data) {
  const block = el('div', 'detail-block');
  block.append(sectionLabel(label), el('code', 'contract-line', line));
  if (data !== undefined) {
    const pre = el('pre', 'payload');
    pre.textContent = JSON.stringify(data, null, 2);
    block.appendChild(pre);
  }
  return block;
}

function sectionLabel(text) { return el('div', 'section-label', text); }

function renderEvidence() {
  const tabs = $('#evidenceTabs');
  const host = $('#diff');
  tabs.innerHTML = '';
  host.innerHTML = '';
  renderStory();
  if (!dataset()) return;
  if (!state.run) {
    renderObservationBoundary(host);
    return;
  }
  [['step', 'Selected step'], ['timeline', 'Run timeline']].forEach(([id, label]) => {
    const button = el('button', `evidence-tab${state.evidenceMode === id ? ' active' : ''}`, label);
    button.onclick = () => { state.evidenceMode = id; renderEvidence(); };
    tabs.appendChild(button);
  });
  if (state.evidenceMode === 'timeline') renderTimeline(host);
  else renderStepEvidence(host);
}

function renderStory() {
  const host = $('#story');
  const summary = $('#diffSummary');
  host.innerHTML = '';
  summary.innerHTML = '';
  if (!dataset()) return;
  if (!state.run) {
    // One line. Before a run there is nothing here that this panel is for — no
    // verdict, no rows, no mismatch — and what used to fill it was configuration
    // the header already carries: `mvcc-xmin` appeared three times on one screen
    // (a chip, a sentence, and a metric) and `6 tables` twice. Fidelity and the
    // reset mode are covered too — by the refusal an assertion gives when it
    // needs write detection, and by "reset isolated" in the left column.
    // `yet` is wrong when four runs sit in the picker. Which of the two it is
    // decides whether the reader goes looking for them.
    summary.append(
      el('span', 'status-dot ready'),
      el('strong', null, historyFor().length ? 'Nothing has run in this session' : 'Nothing has run yet'),
    );
    return;
  }
  const verdict = state.running ? 'running' : runVerdict(state.run);
  summary.append(el('span', `status-dot ${verdict}`), el('strong', null, state.running ? 'Observing the run' : `Run ${verdict}`));
  const signals = collectSignals(state.run);
  const card = el('div', `story-card ${verdict}`);

  // Measured before this was cut: the story panel was 368px of a 720px
  // viewport, so the database changes — the thing the product is for — began at
  // y=544 with 176px of them visible. Three of the four things in here were a
  // second rendering of something already on the same screen:
  //
  //   the headline      restated the verdict already in the pane heading
  //   the prose line    restated the three numbers in the metrics box below it
  //   the signal list   restated the diff below, truncated to five, and said so
  //                     in its own footer: "+ N more … in the evidence below"
  //
  // What is left is the one compact thing that is not repeated anywhere: how
  // much moved.
  if (verdict !== 'clean') {
    // The exception gets the words. "The request completed, but the evidence
    // disagrees" is the most useful sentence on the screen when it is true —
    // and when everything passed, the dot and the counts have already said it.
    card.append(el('span', 'eyebrow', 'State story'), el('h2', null, storyHeadline(verdict, signals)));
  }

  const metrics = el('div', 'story-metrics');
  const planned = state.run.coverage === 'full' ? dataset().steps.length : state.run.steps.length;
  metrics.append(
    metric('Steps', `${state.run.steps.length}/${planned}`),
    metric('Rows changed', String(signals.rows)),
    metric('Assertions', `${signals.passed} pass · ${signals.failed} fail`),
  );
  card.appendChild(metrics);
  host.appendChild(card);
}

function metric(label, value) {
  const item = el('div', 'metric');
  item.append(el('strong', null, value), el('span', null, label));
  return item;
}

function renderObservationBoundary(host) {
  const block = el('div', 'evidence-empty');
  // Which tables, foldable. The count is in the header on every screen; the
  // names are worth being able to check and not worth a column. The sentence
  // that used to sit here — "the right side is reserved for observed state,
  // request planning stays in the center" — was the interface explaining its own
  // layout, which a reader learns by looking, once.
  const tables = el('details', 'candidate-block');
  const heading = el('summary', 'candidate-summary');
  heading.append(
    el('strong', null, 'Watched tables'),
    el('span', null, `${state.workspace.tables.length} · baseline is whatever is there when you run`),
  );
  tables.appendChild(heading);
  const list = el('div', 'table-chip-list');
  state.workspace.tables.forEach((table) => list.appendChild(el('code', 'table-chip', table)));
  tables.appendChild(list);
  block.appendChild(tables);
  // Masking stays visible. It changes what the evidence is able to tell you,
  // it is nowhere else on the screen, and finding out afterwards that a column
  // was withheld is the expensive way to learn it.
  if (scenario().maskColumns?.length) {
    block.appendChild(el('p', 'mask-note', `Masked at capture: ${scenario().maskColumns.join(', ')}`));
  }
  host.appendChild(block);
}

function renderStepEvidence(host) {
  const step = plannedStep();
  const result = stepResult();
  if (!step) {
    host.appendChild(empty('Select a step', 'Its response and database evidence will appear here.'));
    return;
  }
  if (!result) {
    host.appendChild(empty(state.running ? 'Waiting for this step' : 'No evidence captured', state.running ? 'This view updates when the step finishes.' : 'This step was not part of the latest partial run.'));
    return;
  }
  const changes = result.changes;
  const heading = el('div', 'evidence-heading');
  heading.append(el('span', 'eyebrow', step.name), el('h3', null, changeSummary(changes)));
  host.appendChild(heading);
  if (changes) renderChangeSet(host, changes);
  if (result.candidates?.length) renderCandidates(host, result);
}

function renderTimeline(host) {
  const timeline = el('div', 'timeline');
  state.run.steps.forEach((result) => {
    const step = dataset().steps.find((item) => item.id === result.stepId);
    const row = el('article', `timeline-item ${stepVerdict(result)}`);
    const button = el('button', 'timeline-heading');
    const copy = el('span');
    copy.append(el('strong', null, step?.name || result.name), el('small', null, changeSummary(result.changes)));
    button.append(el('span', `status-dot ${stepVerdict(result)}`), copy, el('code', null, `${(result.response?.durationMs ?? 0) + (result.changes?.durationMs ?? 0)} ms`));
    button.onclick = () => { state.selectedStepId = result.stepId; state.evidenceMode = 'step'; render(); };
    row.appendChild(button);
    timeline.appendChild(row);
  });
  host.appendChild(timeline);
}

function renderChangeSet(host, changes) {
  // Before anything else: whose run is this? Everything below describes a
  // database at a moment in the past, and if that moment was not in this
  // session then the database has almost certainly moved on since.
  const stale = staleRunNotice();
  if (stale) host.appendChild(stale);
  // Once, here — not beside every button. It is one line whether the panel
  // shows one row or two hundred, and it changes only when the default target
  // changes, which is the only time it carries new information.
  const standing = handoffStandingLine();
  if (standing) host.appendChild(standing);
  changes.warnings.forEach((warning) => host.appendChild(empty(warning.code, warning.message)));
  if (!changes.changes.length) {
    host.appendChild(empty('No tracked rows changed', changes.detection === 'write' ? 'No row was touched, including no-op writes.' : 'No values differ; no-op writes are outside this capture mode.'));
    return;
  }
  const groups = new Map();
  changes.changes.forEach((change) => {
    if (!groups.has(change.table)) groups.set(change.table, []);
    groups.get(change.table).push(change);
  });
  groups.forEach((rows, table) => {
    const section = el('details', 'table-change');
    // Open. What was written is the third thing on the list of what matters
    // when reading one of these runs, and it was behind a fold — so the default
    // screen had *zero* rows on it and zero of the controls that open a row in
    // a database tool. Only one table being open was the accident that made
    // that look fine in the demo.
    //
    // A run that touched a great many tables can still fold them by hand; the
    // reverse — finding the fold in order to see the evidence at all — is the
    // one that costs every reader every time.
    section.open = true;
    const heading = el('summary', 'table-heading');
    heading.append(el('strong', null, table), el('span', null, `${rows.length} rows`));
    section.appendChild(heading);
    const list = el('div', 'table-rows');
    rows.forEach((change) => list.appendChild(renderRow(change, changes.scope, changes.changes.indexOf(change))));
    section.appendChild(list);
    host.appendChild(section);
  });
}

function renderRow(change, scope, index) {
  const card = el('article', `row-change ${change.kind}`);
  const details = el('details');
  const summary = el('summary', 'row-heading');
  summary.append(el('span', `change-kind ${change.kind}`, change.kind), el('code', null, keyText(change.key)), el('span', null, 'Whole row'));
  // In the heading, not inside the fold. It used to live under the field list
  // inside a `<details>` that is closed by default, which meant "one control
  // per row" was in fact *zero* visible controls per row: clicking a change
  // expanded it and nothing else, and the way to open the row in a database
  // tool was two clicks down and out of sight.
  summary.appendChild(inspectControl(change, index));
  details.appendChild(summary);
  if (change.visibleColumns.length) {
    const fields = el('div', 'field-grid');
    change.visibleColumns.forEach((column) => {
      const line = el('div', 'field-change');
      line.append(el('code', null, column), el('span', 'old', valueText(change.before?.[column])), el('span', 'arrow', '→'), el('span', 'new', valueText(change.after?.[column])));
      fields.appendChild(line);
    });
    details.appendChild(fields);
  }
  const whole = el('div', 'whole-row');
  const row = change.after ?? change.before ?? {};
  const grid = el('div', 'row-grid');
  Object.keys(row).forEach((column) => {
    const line = el('div', 'row-field');
    line.append(el('code', null, column), el('span', null, valueText(change.before?.[column])), el('span', null, valueText(change.after?.[column])));
    grid.appendChild(line);
  });
  whole.appendChild(grid);
  details.appendChild(whole);
  card.appendChild(details);
  return card;
}

function renderCandidates(host, result) {
  // Folded. Promoting an observation into an assertion is a deliberate act, not
  // something read at a glance — and measured at 302px this block was taller
  // than the change list it sat under, competing with the evidence for the one
  // screen the reader has.
  const block = el('details', 'candidate-block');
  const heading = el('summary', 'candidate-summary');
  const existing = new Set(plannedStep()?.assert ?? []);
  const fresh = result.candidates.filter((c) => !existing.has(c.expression)).length;
  heading.append(
    el('strong', null, 'Potential assertions'),
    el('span', null, fresh ? `${fresh} to keep` : 'all kept'),
  );
  block.appendChild(heading);
  const list = el('div', 'candidate-list');
  result.candidates.forEach((candidate) => {
    const row = el('div', 'candidate');
    const copy = el('span', null, candidate.description);
    copy.title = candidate.expression;
    const keep = el('button', 'keep-button', existing.has(candidate.expression) ? 'Kept' : 'Keep assertion');
    keep.disabled = existing.has(candidate.expression);
    keep.onclick = () => keepCandidate(candidate, result.stepId, keep);
    row.append(copy, keep);
    list.appendChild(row);
  });
  block.appendChild(list);
  host.appendChild(block);
}

async function keepCandidate(candidate, stepId, button) {
  button.disabled = true;
  button.textContent = 'Keeping…';
  try {
    const result = await api('/api/assertions', { method: 'POST', body: JSON.stringify({ ...state.selected, stepId, expression: candidate.expression }) });
    button.textContent = result.added ? 'Kept' : 'Already there';
    state.scenarios = await api('/api/scenarios');
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Could not keep';
    button.title = error.message;
  }
}

async function startRun(options) {
  if (state.running) return;
  const context = { ...state.selected };
  const current = dataset();
  const start = options.fromStepId ? current.steps.findIndex((step) => step.id === options.fromStepId) : 0;
  const scope = options.onlyStepId ? [options.onlyStepId] : current.steps.slice(Math.max(start, 0)).map((step) => step.id);
  const snapshots = Object.fromEntries(current.steps.filter((step) => scope.includes(step.id)).map((step) => [step.id, inputSnapshot(step)]));
  state.runScope = scope;
  let requestOverrides;
  try {
    requestOverrides = collectRequestOverrides(current, scope);
  } catch (error) {
    state.runError = error;
    state.runErrors.set(contextKey(context), error);
    renderProgress();
    return;
  }
  state.runError = null;
  state.runErrors.delete(contextKey(context));
  state.viewedRunIds.delete(contextKey(context));
  state.run = null;
  state.running = true;
  state.activeJob = { ...context, scope, snapshots, jobId: null };
  state.followProgress = true;
  render();
  let latestRun = null;
  try {
    const { jobId } = await api('/api/run-jobs', {
      method: 'POST',
      body: JSON.stringify({ ...context, ...options, requestOverrides }),
    });
    state.activeJob.jobId = jobId;
    for (;;) {
      const job = await api(`/api/run-jobs/${encodeURIComponent(jobId)}`);
      if (job.run) {
        latestRun = job.run;
        rememberRun(job.run, snapshots);
        state.ranThisSession.add(job.run.id);
        state.resetSince.delete(contextKey(context));
        state.viewedRunIds.set(contextKey(context), job.run.id);
        const latest = job.run.steps.at(-1)?.stepId;
        if (sameContext(context, state.selected)) {
          state.run = job.run;
          if (latest && state.followProgress) state.selectedStepId = latest;
        }
      }
      if (job.status === 'errored') throw Object.assign(new Error(job.error?.message || 'Run failed'), job.error);
      if (job.status === 'finished') break;
      render();
      await pause(180);
    }
  } catch (error) {
    state.runErrors.set(contextKey(context), error);
    if (sameContext(context, state.selected)) state.runError = error;
  } finally {
    if (latestRun?.variables && latestRun.coverage === 'full') {
      const variables = { ...(state.knownVariablesByDataset.get(contextKey(context)) ?? {}), ...latestRun.variables };
      state.knownVariablesByDataset.set(contextKey(context), variables);
      if (sameContext(context, state.selected)) state.knownVariables = variables;
    }
    state.running = false;
    state.activeJob = null;
    if (sameContext(context, state.selected)) state.run = viewedRunFor(context);
    render();
    if (latestRun && sameContext(context, state.selected)) {
      requestAnimationFrame(() => document.querySelector('#requestWorkspace .exchange-panel')?.scrollIntoView({ block: 'start' }));
    } else if (state.runError && sameContext(context, state.selected)) {
      // The failure is reported in the run strip at the top of the column, and
      // `Run this step` sits at the bottom of a long request panel. Pressing it
      // and being told nothing is how a broken run reads as a dead button.
      requestAnimationFrame(() => document.querySelector('#runStrip')?.scrollIntoView({ block: 'start' }));
    }
  }
}

function collectRequestOverrides(current, stepIds) {
  const overrides = {};
  current.steps.filter((step) => stepIds.includes(step.id)).forEach((step) => {
    const draft = draftFor(step);
    if (!draft.dirty) return;
    const error = validateDraft(draft);
    if (error) throw new Error(`${step.name}: ${error}`);
    overrides[step.id] = {
      method: draft.method,
      path: draft.path,
      as: draft.as || null,
      idempotencyKey: draft.idempotencyKey.trim() || null,
      body: draft.bodyText.trim() ? JSON.parse(draft.bodyText) : null,
    };
  });
  return overrides;
}

function collectSignals(run) {
  const result = { rows: 0, passed: 0, failed: 0, items: [] };
  run.steps.forEach((step) => {
    step.assertions.forEach((assertion) => {
      if (assertion.status === 'passed') result.passed += 1;
      if (assertion.status === 'failed') result.failed += 1;
    });
    step.changes?.changes.forEach((change) => {
      result.rows += 1;
      change.visibleColumns.forEach((column) => {
        const before = valueText(change.before?.[column]);
        const after = valueText(change.after?.[column]);
        if (/status|state|phase/i.test(column)) result.items.push({ label: `${change.table}.${column}`, value: `${before} → ${after}` });
        else if (/amount|balance|total|credit|debit/i.test(column)) {
          const delta = decimalDelta(before, after);
          result.items.push({ label: `${change.table}.${column}`, value: `${before} → ${after}${delta ? ` (${delta})` : ''}` });
        }
      });
    });
  });
  return result;
}

function runVerdict(run) {
  if (run.status === 'errored') return 'errored';
  if (run.status === 'failed' || run.steps.some((step) => step.assertions.some((item) => item.status === 'failed'))) return 'failed';
  if (run.steps.some((step) => step.assertions.some((item) => item.status === 'unevaluable'))) return 'undecided';
  return 'clean';
}

function stepVerdict(step) {
  if (step.status === 'errored') return 'errored';
  if (step.status === 'failed' || step.assertions.some((item) => item.status === 'failed')) return 'failed';
  if (step.assertions.some((item) => item.status === 'unevaluable')) return 'undecided';
  return 'clean';
}

function statusLabel(status) { return ({ pending: 'Ready', running: 'Running', clean: 'Passed', failed: 'Failed', undecided: 'Review', errored: 'Error' })[status] ?? status; }
function storyHeadline(verdict, signals) {
  if (verdict === 'running') return 'The system is changing under observation.';
  if (verdict === 'errored') return 'The behavior stopped before its story completed.';
  if (verdict === 'failed') return 'The request completed, but the evidence disagrees.';
  if (verdict === 'undecided') return 'The evidence exists, but needs your judgment.';
  return signals.rows ? 'The behavior and its persisted state agree.' : 'The behavior completed without tracked row changes.';
}
function changeSummary(changes) {
  if (!changes) return 'This step was not observed';
  return changes.changes.length ? `${changes.changes.length} rows changed across ${new Set(changes.changes.map((item) => item.table)).size} tables` : 'No tracked rows changed';
}
function empty(title, copy) {
  const item = el('div', 'empty-state compact');
  item.append(el('strong', null, title), el('span', null, copy));
  return item;
}
function keyText(key) { return key?.columns?.length ? key.columns.map((part) => `${part.column}=${valueText(part.value)}`).join(', ') : 'unkeyed row'; }
function valueText(value) {
  if (value === undefined) return 'NULL';
  if (value.state === 'masked') return '•••••••• · masked at capture';
  if (value.state === 'unknown') return `‹unknown› · ${value.reason}`;
  return value.text === null ? 'NULL' : String(value.text);
}
function pretty(value) {
  if (value === undefined) return '(empty body)';
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

function decimalDelta(before, after) {
  if (!/^-?\d+(?:\.\d+)?$/.test(before) || !/^-?\d+(?:\.\d+)?$/.test(after)) return '';
  const scale = Math.max((before.split('.')[1] || '').length, (after.split('.')[1] || '').length);
  const integer = (value) => {
    const negative = value.startsWith('-');
    const [whole, fraction = ''] = value.replace('-', '').split('.');
    const number = BigInt(whole + fraction.padEnd(scale, '0'));
    return negative ? -number : number;
  };
  const delta = integer(after) - integer(before);
  if (!delta) return '';
  const digits = (delta < 0 ? -delta : delta).toString().padStart(scale + 1, '0');
  return `${delta > 0 ? '+' : '-'}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}

async function boot() {
  try {
    const [workspace, scenarios, runs] = await Promise.all([api('/api/workspace'), api('/api/scenarios'), api('/api/runs')]);
    // Everything restored here predates this page. `startRun` is the only thing
    // that adds to `ranThisSession`.
    // Not awaited into the critical path: the page is useful without knowing
    // what is bound, and a control that appears a moment later is better than a
    // page that waits on a file read.
    void loadHandoffTargets().then(render);
    state.workspace = workspace;
    state.scenarios = scenarios;
    runs.forEach((run) => {
      rememberRun(run);
      const key = contextKey(run);
      if (run.coverage === 'full' && !state.knownVariablesByDataset.has(key)) state.knownVariablesByDataset.set(key, run.variables ?? {});
    });
    const first = state.scenarios[0];
    if (first?.datasets[0]) {
      state.selected = { scenarioId: first.id, datasetId: first.datasets[0].id };
      state.datasetSelections.set(first.id, first.datasets[0].id);
      state.selectedStepId = first.datasets[0].steps[0]?.id ?? null;
      state.run = viewedRunFor(state.selected);
      state.knownVariables = state.knownVariablesByDataset.get(contextKey()) ?? {};
    }
    render();
  } catch (error) {
    document.body.innerHTML = `<main class="fatal"><h1>TupleScope could not start</h1><p>${String(error.message)}</p></main>`;
  }
}

boot();

/* ── row handoff ────────────────────────────────────────────────────────────
 *
 * One control per row, not one per target.
 *
 * The earlier design gave every row a button, a static disclosure line, an
 * inline explanation for the unusable case, and an inline output block. On the
 * shipped demo that is 22 rows over 4 tables; with two targets bound it is 44
 * buttons and, on first use, 44 copies of the same authorisation text. So:
 *
 *   · one split button per row, whatever is bound
 *   · the reason for a refusal on demand, never as a paragraph in the list
 *   · the disclosure once per panel, not once per row
 *   · output in a separate inspector, so the list never reflows and scroll
 *     position is preserved by construction rather than by saving it
 *   · first use in a drawer whose only exit is a typed command
 */

const handoffState = {
  /** `{alias, preset, granted, where, standing}[]`, or null until first fetched. */
  targets: null,
  /** `{hostPort, fromContainer, username}` from the workspace's own DSN — never a password. */
  suggest: null,
  error: '',
  /** The alias the primary click uses. First granted target wins. */
  preferred: null,
  inspector: null,
  drawer: null,
};

async function loadHandoffTargets() {
  try {
    const result = await api('/api/handoff/targets');
    handoffState.targets = result.targets ?? [];
    handoffState.suggest = result.suggest ?? null;
    handoffState.error = result.error ?? '';
    handoffState.preferred = handoffState.targets.find((t) => t.granted)?.alias ?? null;
  } catch {
    // A runtime too old to know this route is not an error worth shouting
    // about: it just means nothing can be opened.
    handoffState.targets = [];
  }
}

/** The short chip on a disabled control: the class of problem, not the essay. */
function refusalChip(handoff) {
  const reason = handoff.locator?.reason?.reason;
  if (reason === 'masked-key') return 'key masked';
  if (reason === 'unknown-value') return 'key unreadable';
  if (reason === 'no-stable-key') return 'no key';
  if (reason === 'location-unknown') return 'no location';
  return 'cannot open';
}

function inspectControl(change, index) {
  const line = el('div', 'inspect-line');
  const handoff = change.handoff ?? {};
  const addressable = Boolean(handoff.sql);
  const targets = handoffState.targets ?? [];

  // Inside a `<summary>`, so every click has to be stopped from toggling the
  // fold as well — otherwise opening a row in psql also collapses the diff the
  // reader was looking at.
  line.onclick = (event) => event.stopPropagation();
  const group = el('div', 'inspect-group');
  const main = el('button', 'inspect-main', 'Inspect');
  const more = el('button', 'inspect-more', '▾');
  more.setAttribute('aria-label', 'Other ways to open this row');
  group.append(main, more);

  if (!addressable) {
    // In place and disabled, never hidden and never refused on click. Hiding
    // loses the degraded-but-usable property; refusing on click teaches that
    // the button is unreliable.
    main.disabled = true;
    more.disabled = false;
    main.title = handoff.reason ?? '';
    line.append(group, el('span', 'inspect-chip', refusalChip(handoff)));
  } else if (!handoffState.preferred) {
    // Addressable, but nothing on this machine is bound to open it with. A dead
    // grey button says only that something is broken. This one says what it
    // would do and how to enable it — which is the only route from "I want
    // this" to "it is configured" that does not require knowing the feature
    // exists first.
    main.textContent = 'Open in…';
    main.onclick = (event) => {
      event.preventDefault();
      showDrawer(null, change, index);
    };
    // No per-row chip. "Nothing is bound" is a fact about the machine, not
    // about this row, and repeating it beside every row is the same mistake as
    // the disclosure line that used to sit under every button.
    line.appendChild(group);
  } else {
    main.onclick = (event) => {
      event.preventDefault();
      openRow(change, index, handoffState.preferred, main);
    };
    line.appendChild(group);
    if (handoff.absent) {
      line.appendChild(el('span', 'inspect-note', 'this row was deleted — an empty result is the expected answer'));
    }
    if (handoff.portable === false) {
      line.appendChild(el('span', 'inspect-warn', 'this run did not pin its rendering settings, so these values may not mean the same thing in another tool'));
    }
  }

  more.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    openMenu(more, change, index, handoff, targets);
  };
  return line;
}

function openMenu(anchor, change, index, handoff, targets) {
  document.querySelector('.inspect-menu')?.remove();
  const menu = el('div', 'inspect-menu');

  if (handoff.reason) {
    // Expanded on demand, for the one row the reader asked about — rather than
    // printed under every row that cannot be opened.
    menu.appendChild(el('p', 'inspect-why', handoff.reason));
  }

  targets.forEach((target) => {
    const item = el('button', 'inspect-item');
    item.append(
      el('span', 'inspect-item-name', `Open in ${target.alias}`),
      el('span', 'inspect-item-where', target.where),
    );
    item.disabled = !handoff.sql;
    item.onclick = () => {
      menu.remove();
      if (!target.granted) return showDrawer(target, change, index);
      openRow(change, index, target.alias, anchor);
    };
    menu.appendChild(item);
  });

  const copy = el('button', 'inspect-item');
  copy.append(el('span', 'inspect-item-name', 'Copy SELECT'), el('span', 'inspect-item-where', 'to the clipboard'));
  copy.disabled = !handoff.sql;
  copy.onclick = async () => {
    await navigator.clipboard.writeText(handoff.sql);
    copy.querySelector('.inspect-item-name').textContent = 'Copied';
    setTimeout(() => menu.remove(), 700);
  };
  menu.appendChild(copy);

  const enable = el('button', 'inspect-item');
  enable.append(el('span', 'inspect-item-name', 'Enable a target…'), el('span', 'inspect-item-where', 'once, on this machine'));
  enable.onclick = () => { menu.remove(); showDrawer(null, change, index); };
  menu.appendChild(enable);

  anchor.parentElement.appendChild(menu);
  const away = (event) => {
    if (menu.contains(event.target)) return;
    menu.remove();
    document.removeEventListener('click', away);
  };
  setTimeout(() => document.addEventListener('click', away), 0);
}

async function openRow(change, index, alias, button) {
  if (!alias) return;
  const run = state.run;
  const stepId = state.selectedStepId;
  const was = button.textContent;
  button.disabled = true;
  button.textContent = 'Opening…';
  try {
    const result = await api('/api/handoff/open', {
      method: 'POST',
      body: JSON.stringify({ runId: run?.id, stepId, changeIndex: index, alias }),
    });
    if (result.kind === 'output') showInspector(change, result);
  } catch (error) {
    showInspector(change, { kind: 'output', ok: false, stderr: String(error?.message ?? error), stdout: '' });
  } finally {
    button.disabled = false;
    button.textContent = was;
  }
}

/**
 * Output never enters the list.
 *
 * Its own panel, with its own scroll and a max height, so the row list is not
 * touched and its scroll position survives by construction rather than by being
 * saved and restored.
 */
function showInspector(change, result) {
  handoffState.inspector?.remove();
  const panel = el('aside', 'inspector');
  const head = el('header', 'inspector-head');
  head.append(
    el('strong', null, `${change.table} · ${keyText(change.key)}`),
    el('span', 'inspector-status', result.killed ? `stopped: ${result.killed}` : result.ok ? 'ok' : 'error'),
  );
  const close = el('button', 'inspector-close', '×');
  close.setAttribute('aria-label', 'Close');
  close.onclick = () => { panel.remove(); handoffState.inspector = null; };
  head.appendChild(close);
  panel.appendChild(head);

  if (result.script) panel.appendChild(el('pre', 'inspector-script', result.script.trim()));
  if (result.stdout) panel.appendChild(el('pre', 'inspector-out', result.stdout.trimEnd()));
  if (result.stderr) panel.appendChild(el('pre', 'inspector-err', result.stderr.trimEnd()));
  document.body.appendChild(panel);
  handoffState.inspector = panel;
}

/**
 * First use is a drawer, not a modal and not inline.
 *
 * Not inline, because it is long — it has to show the full address and the
 * disclosure — and inline it would push the whole list down and lose the
 * reader's place. Not a modal, because a modal is a thing the mouse can
 * complete, and the entire point is that it cannot: the only exit is a typed
 * command.
 */
function showDrawer(target, change) {
  handoffState.drawer?.remove();
  const drawer = el('aside', 'handoff-drawer');
  const handoff = change.handoff ?? {};

  drawer.appendChild(el('h3', null, target ? `Open in ${target.alias}` : 'Open this row in a database tool'));
  drawer.appendChild(el('p', 'drawer-sub', target ? 'not enabled on this machine' : 'nothing is bound on this machine'));

  if (handoff.sql) {
    drawer.appendChild(el('p', null, 'This row is addressable as:'));
    drawer.appendChild(el('pre', 'drawer-sql', handoff.sql));
  }

  drawer.appendChild(el('p', null,
    'Whatever opens it connects with its own credentials, as you, and is not bound by maskColumns — ' +
    'it will show masked columns in full. TupleScope cannot take that back once the row is open.'));

  drawer.appendChild(el('p', 'drawer-lead', target
    ? `\`${target.alias}\` is a name this repository chose. Bind it yourself, once:`
    : 'Bind a target yourself, once:'));
  const alias = target?.alias ?? 'adminer';
  const s = handoffState.suggest;
  const cmd = target?.preset === 'psql-service'
    ? `tuplescope handoff enable psql-service --as ${alias} --service <your pg_service entry>`
    : `tuplescope handoff enable adminer-url --as ${alias} \\\n` +
      `  --origin http://127.0.0.1:8080 \\\n` +
      `  --server ${s ? s.hostPort : '<db as adminer sees it>'}` +
      `${s?.username ? ` --username ${s.username}` : ' --username <role>'}`;
  drawer.appendChild(el('pre', 'drawer-cmd', cmd));
  // The one address TupleScope cannot derive, offered as the two candidates it
  // can — rather than a placeholder that sends the reader to `docker inspect`.
  if (s && s.fromContainer !== s.hostPort && target?.preset !== 'psql-service') {
    drawer.appendChild(el('p', 'drawer-foot',
      `--server is the database as Adminer reaches it. \`${s.hostPort}\` is right if Adminer runs on this machine; ` +
      `use \`${s.fromContainer}\` if it runs in a container, where loopback means the container and not this host.`));
  }
  drawer.appendChild(el('p', 'drawer-foot',
    'Written to ~/.tuplescope/handoff.json, which this repository cannot write.'));

  const dismiss = el('button', 'drawer-dismiss', 'Close');
  // Dismissing decides nothing. There is no affirmative control here at all.
  dismiss.onclick = () => closeDrawer();
  drawer.appendChild(dismiss);

  document.body.appendChild(drawer);
  handoffState.drawer = drawer;
  document.addEventListener('keydown', drawerEscape);
}

function drawerEscape(event) {
  if (event.key === 'Escape') closeDrawer();
}

function closeDrawer() {
  handoffState.drawer?.remove();
  handoffState.drawer = null;
  document.removeEventListener('keydown', drawerEscape);
}

/** The standing line, once per panel — not once per row. */
function handoffStandingLine() {
  if (handoffState.error) return el('p', 'handoff-standing warn', handoffState.error);
  const preferred = (handoffState.targets ?? []).find((t) => t.alias === handoffState.preferred);
  if (preferred) return el('p', 'handoff-standing', `Inspect → ${preferred.standing}`);
  // Said once, where the standing disclosure goes when there *is* a target.
  // Without it the row controls read "Open in…" with nothing behind them and
  // no hint that anything is missing or how to supply it.
  if (handoffState.targets === null) return null;
  return el('p', 'handoff-standing', 'Open in… → no database tool is bound on this machine yet · open a row to set one up');
}

/**
 * Says so when the evidence on screen is from a run this page did not perform.
 *
 * Restoring the last run on load is worth doing — it is why the panel is not
 * empty when you come back to it. What was missing is that it looked identical
 * to a run that had just finished: green step pills, a change list, "Run
 * clean". A reader who had run nothing was looking at rows from a database that
 * has since been reset, and nothing on the page disagreed.
 *
 * This is also the reason `Reset baseline` sits beside `Reset & run`: the
 * honest response to "these changes are old" is often to put the database back
 * where it started and go look at it, not to run five requests over it.
 */
function staleRunNotice() {
  const run = state.run;
  if (!run || state.ranThisSession.has(run.id)) return null;
  const when = run.finishedAt ?? run.startedAt;
  const note = el('p', 'stale-run');
  note.append(
    el('strong', null, 'From an earlier run'),
    el('span', null,
      when
        ? ` · finished ${new Date(when).toLocaleTimeString()}. The database has moved on since; rows below describe how it looked then.`
        : ' · the database has moved on since; rows below describe how it looked then.'),
  );
  return note;
}

/** Puts the database back to its baseline and stops. */
async function resetBaseline(button) {
  const was = button.textContent;
  button.disabled = true;
  button.textContent = 'Resetting…';
  try {
    // `{}`, not nothing. `api()` sets `content-type: application/json` on every
    // request, and Fastify refuses an empty body under that header — a failure
    // that never showed up testing the route with curl, which sends no
    // content-type at all.
    await api('/api/reset', { method: 'POST', body: '{}' });
    // The evidence on screen describes the database as it was *before* this
    // reset, so keeping it would be showing rows that no longer exist.
    state.run = null;
    state.runError = null;
    state.viewedRunIds.delete(contextKey());
    state.resetSince.add(contextKey());
    button.textContent = 'Baseline restored';
    setTimeout(() => { button.textContent = was; button.disabled = false; render(); }, 900);
  } catch (error) {
    state.runError = error;
    button.textContent = was;
    button.disabled = false;
    render();
  }
}

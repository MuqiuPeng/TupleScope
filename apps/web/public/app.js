/* StateScope UI.
 *
 * No bundler: edit, refresh, done. The runtime serves this directory as-is.
 *
 * The token arrives once in the query string, is kept in memory, and is sent as
 * a header from then on — it never goes back into a URL, where it would end up
 * in history and in referrers.
 */

const TOKEN = new URLSearchParams(location.search).get('token') ?? '';
if (TOKEN) history.replaceState({}, '', location.pathname);

const $ = (sel) => document.querySelector(sel);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-statescope-token': TOKEN, ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message ?? response.statusText), body);
  return body;
}

const state = { scenarios: [], selected: null, run: null };

// ─── Scenarios ────────────────────────────────────────────────────────────────

function renderScenarios() {
  const host = $('#scenarios');
  host.innerHTML = '';

  for (const scenario of state.scenarios) {
    const card = el('div', 'scenario');
    card.appendChild(el('h3', null, scenario.title));
    if (scenario.why) card.appendChild(el('p', 'why', scenario.why.trim()));

    for (const dataset of scenario.datasets) {
      const isActive =
        state.selected?.scenarioId === scenario.id && state.selected?.datasetId === dataset.id;
      const row = el('button', `dataset${isActive ? ' active' : ''}`);
      row.type = 'button';
      const head = el('div', 'dataset-head');
      head.appendChild(el('span', 'dataset-label', dataset.label));
      head.appendChild(el('span', 'dataset-count', `${dataset.steps.length} steps`));
      row.appendChild(head);
      if (dataset.note) row.appendChild(el('span', 'dataset-note', dataset.note));
      row.addEventListener('click', () => run(scenario.id, dataset.id));
      card.appendChild(row);
    }
    host.appendChild(card);
  }
}

async function run(scenarioId, datasetId, options = {}) {
  state.selected = { scenarioId, datasetId };
  state.run = null;
  renderScenarios();
  $('#steps').innerHTML = '';
  $('#steps').appendChild(el('p', 'muted', 'Running...'));
  $('#diff').innerHTML = '';
  $('#runSummary').textContent = '';
  $('#diffSummary').textContent = '';

  try {
    state.run = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ scenarioId, datasetId, ...options }),
    });
    renderRun();
  } catch (error) {
    $('#steps').innerHTML = '';
    const box = el('div', 'error-box');
    box.appendChild(el('div', 'error-title', error.error ?? 'Run failed'));
    box.appendChild(el('div', null, error.message));
    if (error.remedy) box.appendChild(el('div', 'error-remedy', error.remedy));
    $('#steps').appendChild(box);
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

const STATUS_MARK = { passed: '✓', failed: '✗', errored: '!', skipped: '–', running: '•' };

function renderRun() {
  const run = state.run;
  const host = $('#steps');
  host.innerHTML = '';

  const passed = run.steps.filter((s) => s.status === 'passed').length;
  $('#runSummary').textContent =
    `${run.status} · ${passed}/${run.steps.length} steps` +
    (run.coverage === 'partial' ? ' · partial' : '');

  if (run.coverage === 'partial') {
    // A green partial run proves less than a green full one, because the steps
    // it skipped left the database in whatever state the last run did.
    const banner = el('div', 'notice');
    banner.appendChild(el('strong', null, 'Partial run. '));
    banner.appendChild(
      el('span', null, 'Earlier steps did not run, so this started from whatever the last run left behind.'),
    );
    host.appendChild(banner);
  }

  // Anything that wrote during an idle window is not ours. Say so before the
  // user reads a diff that may contain rows the scenario never caused.
  if (run.baselineNoise) {
    const warn = el('div', 'notice');
    warn.appendChild(el('strong', null, 'Concurrent writes detected. '));
    warn.appendChild(
      el(
        'span',
        null,
        run.baselineNoise.warnings.map((w) => w.message).join(' ') ||
          'Something else writes to this database.',
      ),
    );
    host.appendChild(warn);
  }

  for (const step of run.steps) {
    const card = el('div', `step ${step.status}`);
    const head = el('div', 'step-head');
    head.appendChild(el('span', `mark ${step.status}`, STATUS_MARK[step.status] ?? '?'));
    head.appendChild(el('span', 'step-name', step.name));
    if (step.response) {
      head.appendChild(el('span', 'code-pill', String(step.response.status)));
    }
    card.appendChild(head);

    const line = el('div', 'req-line');
    line.appendChild(el('span', 'method', step.request.method));
    line.appendChild(el('span', 'url', step.request.url));
    if (step.request.as) line.appendChild(el('span', 'as', `as ${step.request.as}`));
    card.appendChild(line);

    const controls = el('div', 'step-actions');
    for (const [label, options, title] of [
      ['Run this step', { onlyStepId: step.stepId }, 'Run only this step, reusing variables from the last full run'],
      ['Run from here', { fromStepId: step.stepId }, 'Run this step and everything after it'],
    ]) {
      const button = el('button', 'mini', label);
      button.type = 'button';
      button.title = title;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        void run(state.selected.scenarioId, state.selected.datasetId, options);
      });
      controls.appendChild(button);
    }
    card.appendChild(controls);

    if (step.error) {
      const box = el('div', 'error-box');
      box.appendChild(el('div', 'error-title', step.error.kind));
      box.appendChild(el('div', null, step.error.message));
      if (step.error.remedy) box.appendChild(el('div', 'error-remedy', step.error.remedy));
      card.appendChild(box);
    }

    if (step.response?.body) {
      const pre = el('pre', 'code');
      pre.textContent = pretty(step.response.body);
      card.appendChild(pre);
    }

    for (const assertion of step.assertions) {
      const row = el('div', `assert ${assertion.status}`);
      row.appendChild(
        el(
          'span',
          'mark',
          assertion.status === 'passed' ? '✓' : assertion.status === 'failed' ? '✗' : '?',
        ),
      );
      row.appendChild(el('code', null, assertion.source));
      // An assertion that could not be decided is neither pass nor fail, and
      // showing it as either would be a lie about what was checked.
      if (assertion.status === 'failed') {
        row.appendChild(el('span', 'actual', `got ${assertion.actual}`));
      } else if (assertion.status === 'unevaluable') {
        row.appendChild(el('span', 'reason', assertion.reason));
      }
      card.appendChild(row);
    }

    card.addEventListener('click', () => {
      renderDiff(step);
      for (const other of host.querySelectorAll('.step')) other.classList.remove('selected');
      card.classList.add('selected');
    });
    host.appendChild(card);
  }

  const last = [...run.steps].reverse().find((s) => s.changes);
  if (last) {
    renderDiff(last);
    host.querySelector(`.step:nth-child(${run.steps.indexOf(last) + (run.baselineNoise ? 2 : 1)})`)
      ?.classList.add('selected');
  }
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

/**
 * Keeps a candidate as a real assertion in the scenario file.
 *
 * Written straight to disk rather than held in memory: the value of promoting
 * is that the next run — and CI — checks it too.
 */
async function keep(candidate, stepId, button) {
  button.disabled = true;
  button.textContent = 'Keeping...';
  try {
    const result = await api('/api/assertions', {
      method: 'POST',
      body: JSON.stringify({
        scenarioId: state.selected.scenarioId,
        datasetId: state.selected.datasetId,
        stepId,
        expression: candidate.expression,
      }),
    });
    button.textContent = result.added ? 'Kept' : 'Already there';
    button.classList.add('kept');
    state.scenarios = await api('/api/scenarios');
    renderScenarios();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Failed';
    button.title = error.message;
  }
}

function renderCandidates(step) {
  const candidates = step.candidates ?? [];
  if (candidates.length === 0) return null;

  const existing = new Set((state.scenarios
    .find((s) => s.id === state.selected.scenarioId)?.datasets
    .find((d) => d.id === state.selected.datasetId)?.steps
    .find((x) => x.id === step.stepId)?.assert) ?? []);

  const section = el('div', 'promote');
  const head = el('h4');
  head.appendChild(el('span', null, 'Keep as assertion'));
  head.appendChild(el('span', 'hint', 'what this step did, turned into a check'));
  section.appendChild(head);

  for (const candidate of candidates) {
    const row = el('div', 'candidate');
    const text = el('div', 'candidate-text');
    text.appendChild(el('code', null, candidate.expression));
    text.appendChild(el('span', 'candidate-why', candidate.description));
    if (candidate.caveat) {
      text.appendChild(el('span', 'candidate-caveat', candidate.caveat.message));
    }
    row.appendChild(text);

    const already = existing.has(candidate.expression);
    const button = el('button', `mini${already ? ' kept' : ''}`, already ? 'Kept' : 'Keep');
    button.type = 'button';
    button.disabled = already;
    button.addEventListener('click', () => void keep(candidate, step.stepId, button));
    row.appendChild(button);
    section.appendChild(row);
  }
  return section;
}

function renderDiff(step) {
  const host = $('#diff');
  host.innerHTML = '';
  const changes = step.changes;

  if (!changes) {
    host.appendChild(el('p', 'muted', 'This step was not observed.'));
    $('#diffSummary').textContent = '';
    return;
  }

  const scopeText = changes.scope.allTables
    ? `every table (${changes.scope.tables.length})`
    : `${changes.scope.tables.length} watched table(s)`;
  $('#diffSummary').textContent = `${changes.changes.length} row(s) · ${changes.durationMs} ms`;

  for (const warning of changes.warnings) {
    const box = el('div', 'notice');
    box.appendChild(el('strong', null, `${warning.code}: `));
    box.appendChild(el('span', null, warning.message));
    host.appendChild(box);
  }

  if (changes.changes.length === 0) {
    // Precise about what was proven: with write detection this really does mean
    // nothing was written, which a value comparison could never have claimed.
    const message =
      changes.detection === 'write'
        ? 'Nothing was written. Not a single row was touched, including rows whose values would not have changed.'
        : 'No values differ. A write that changed nothing would not show up here.';
    host.appendChild(el('div', 'no-change', message));
  }

  const byTable = new Map();
  for (const change of changes.changes) {
    if (!byTable.has(change.table)) byTable.set(change.table, []);
    byTable.get(change.table).push(change);
  }

  for (const [table, rows] of byTable) {
    const section = el('div', 'diff-table');
    const head = el('h4');
    head.appendChild(el('span', null, table));
    const counts = { insert: 0, update: 0, delete: 0 };
    for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
    if (counts.insert) head.appendChild(el('span', 'badge added', `+${counts.insert} new`));
    if (counts.update) head.appendChild(el('span', 'badge changed', `${counts.update} updated`));
    if (counts.delete) head.appendChild(el('span', 'badge removed', `-${counts.delete}`));
    section.appendChild(head);

    for (const change of rows) {
      const card = el('div', `row-card ${change.kind}`);
      card.appendChild(el('div', 'row-key', keyLabel(change)));

      if (change.kind === 'update') {
        const dl = el('dl', 'kv');
        if (change.visibleColumns.length === 0) {
          // The honest report of the case the whole tool exists for.
          dl.appendChild(el('dt', 'muted', 'written, no visible change'));
          dl.appendChild(el('dd', 'muted', ignoredNote(change)));
        }
        for (const column of change.visibleColumns) {
          dl.appendChild(el('dt', null, column));
          const dd = el('dd');
          dd.appendChild(el('span', 'was', text(change.before?.[column])));
          dd.appendChild(el('span', 'arrow', '→'));
          dd.appendChild(el('span', 'now', text(change.after?.[column])));
          dl.appendChild(dd);
        }
        card.appendChild(dl);
      } else {
        const row = change.after ?? change.before ?? {};
        const dl = el('dl', 'kv');
        for (const [column, value] of Object.entries(row)) {
          if (value?.text === null) continue;
          dl.appendChild(el('dt', null, column));
          dl.appendChild(el('dd', null, text(value)));
        }
        card.appendChild(dl);
      }
      section.appendChild(card);
    }
    host.appendChild(section);
  }

  const promote = renderCandidates(step);
  if (promote) host.appendChild(promote);

  host.appendChild(
    el(
      'div',
      'diff-scope',
      `Comparing ${scopeText} · ${changes.captureMethod} (${changes.detection} detection)`,
    ),
  );
}

function ignoredNote(change) {
  const hidden = change.changedColumns.filter((c) => !change.visibleColumns.includes(c));
  return hidden.length ? `only ${hidden.join(', ')} changed, which is ignored` : 'no column values differ';
}

function keyLabel(change) {
  if (!change.key) return '(no key — row could not be matched)';
  return change.key.columns.map((c) => `${c.column} ${c.value?.text ?? 'null'}`).join(' · ');
}

function text(value) {
  if (!value || value.text === null || value.text === undefined) return 'null';
  return value.text.length > 120 ? `${value.text.slice(0, 117)}...` : value.text;
}

function pretty(body) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    const [workspace, scenarios] = await Promise.all([
      api('/api/workspace'),
      api('/api/scenarios'),
    ]);
    state.scenarios = scenarios;
    $('#workspaceMeta').textContent =
      `${workspace.name} → ${workspace.baseUrl} · ${workspace.captureMethod} · ${workspace.tables.length} tables`;
    renderScenarios();
  } catch (error) {
    document.body.prepend(
      el('div', 'boot-error', `${error.message} — reopen the URL printed by the runtime.`),
    );
  }
}

void boot();

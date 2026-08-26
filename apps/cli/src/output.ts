/**
 * Assembling one run's worth of terminal output.
 *
 * Kept apart from `render.ts` (which knows about glyphs and grids) and from
 * `main.ts` (which knows about flags and exit codes), so the layout can be
 * changed without touching either.
 */

import type { Run, RunVerdict } from '@statescope/core';
import type { ResolvedWorkspaceConfig } from '@statescope/workspace';
import {
  glyph,
  renderAssertion,
  renderDiff,
  renderWarning,
  stepGlyph,
  type Style,
} from './render.js';

interface Flags {
  'no-color'?: boolean | undefined;
  ascii?: boolean | undefined;
  wide?: boolean | undefined;
  quiet?: boolean | undefined;
  diff?: string | undefined;
  columns?: string | undefined;
}

export function styleFor(values: Flags): Style {
  // NO_COLOR is honoured because it is the convention; a non-TTY is assumed to
  // be a log file or a pipe, where escape codes are noise.
  const color =
    !values['no-color'] &&
    process.env['NO_COLOR'] === undefined &&
    (process.env['FORCE_COLOR'] !== undefined || process.stdout.isTTY === true);
  return {
    color,
    ascii: values.ascii ?? false,
    width: Number(process.env['COLUMNS'] ?? 0) || (process.stdout.columns ?? 100),
  };
}

export function renderWorkspaceLine(style: Style, config: ResolvedWorkspaceConfig): string {
  return (
    `statescope · ${config.name} → ${config.baseUrl}\n` +
    `  config    ${config.configFile}`
  );
}

export function renderRun(
  style: Style,
  values: Flags,
  config: ResolvedWorkspaceConfig,
  run: Run,
  verdict: RunVerdict,
): string[] {
  const out: string[] = ['', `${run.scenarioId} · ${run.datasetId}`];

  if (!run.baseline.probed) {
    out.push(`  ${glyph(style, 'notrun')} baseline not probed — concurrent writes would not have been detected`);
  }
  for (const warning of verdict.warnings.filter((w) => w.source === 'baseline')) {
    out.push(...renderWarning(style, warning, '  '));
  }

  const mode = values.diff ?? 'auto';
  const columns = values.columns === 'all' ? ('all' as const) : Number(values.columns ?? 4) || 4;

  for (const step of run.steps) {
    if (values.quiet) continue;
    const mark = stepGlyph(style, step, verdict);
    const status = step.response ? String(step.response.status) : (step.error?.kind ?? '');
    out.push(`  ${mark} ${step.name.padEnd(38)} ${status}`);

    if (step.error) {
      out.push(`      ${step.error.message}`);
      if (step.error.remedy) out.push(`      ${step.error.remedy}`);
    }

    const interesting = new Set(
      step.assertions.flatMap((a) => [...a.source.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0])),
    );
    const clean =
      step.status === 'passed' && !step.assertions.some((a) => a.status !== 'passed');
    const wanted =
      mode === 'none' ? false : mode === 'failed' ? !clean : mode === 'all' ? true : true;

    if (wanted && step.changes) {
      out.push(
        ...renderDiff(step.changes, {
          style,
          columns,
          // A passing step gets a glance; a failing one gets the evidence.
          maxRows: mode === 'all' ? Number.MAX_SAFE_INTEGER : clean ? 3 : 12,
          maxTables: mode === 'all' ? Number.MAX_SAFE_INTEGER : 6,
          interesting,
          indent: '      ',
        }),
      );
      if (step.changes.changes.length === 0 && step.assertions.length > 0) {
        out.push(
          `      ${step.changes.detection === 'write'
            ? 'Nothing was written. Not a single row was touched, including rows whose values would not have changed.'
            : 'No values differ. A write that changed nothing would not show up here.'}`,
        );
      }
    }
    for (const assertion of step.assertions) out.push(...renderAssertion(style, assertion, '      '));
    for (const warning of verdict.warnings.filter((w) => w.stepId === step.stepId)) {
      out.push(...renderWarning(style, warning, '      '));
    }
  }
  return out;
}

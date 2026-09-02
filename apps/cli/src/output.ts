/**
 * Assembling one run's worth of terminal output.
 *
 * Kept apart from `render.ts` (which knows about glyphs and grids) and from
 * `main.ts` (which knows about flags and exit codes), so the layout can be
 * changed without touching either.
 */

import type { Run, RunVerdict } from '@tuplescope/core';
import type { ResolvedWorkspaceConfig } from '@tuplescope/workspace';
import {
  glyph,
  paint,
  renderAssertion,
  renderDiff,
  renderWriteOrder,
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
    `tuplescope · ${config.name} → ${config.baseUrl}\n` +
    `  config    ${config.configFile}`
  );
}

/**
 * The boundary of what was looked at, said out loud.
 *
 * Everything this tool claims rests on having watched the right rows, and it
 * narrows three times without being asked: one schema, ordinary tables only,
 * and nothing whose name starts with an underscore. Each of those turned a real
 * write into "Nothing was written. Not a single row was touched" — clean, exit
 * 0, no warning. A gap the reader can see is a gap they can close.
 *
 * Silent when there is nothing to disclose, so it costs an ordinary workspace
 * one short line and never becomes furniture the eye skips.
 */
export interface ScopeReport {
  schema: string;
  watched: number;
  otherSchemas: ReadonlyArray<{ schema: string; tables: number }>;
  nameFiltered: ReadonlyArray<string>;
  partitionedParents: ReadonlyArray<string>;
  foreignTables: ReadonlyArray<string>;
}

/**
 * Filter columns that match nothing, which therefore filter nothing.
 *
 * `maskColumns` and `ignoreColumns` are bare column names applied across every
 * watched table, so a misspelled one is accepted, resolves to nothing, and does
 * nothing — silently. For `ignoreColumns` that is noise. For `maskColumns` it is
 * the column being captured in the clear into run history, `--json` and CI
 * reports, which is exactly what the setting exists to prevent, and the reader
 * has no way to tell that from a run where the column simply never appeared.
 *
 * Same shape as the `except` check: a filter that resolves to nothing filters
 * nothing, and until now said so nowhere.
 */
export function unresolvedFilterColumns(
  config: { maskColumns?: ReadonlyArray<string>; ignoreColumns?: ReadonlyArray<string> },
  everyColumn: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const key of ['maskColumns', 'ignoreColumns'] as const) {
    for (const column of config[key] ?? []) {
      if (everyColumn.has(column)) continue;
      out.push(
        `  ${key}  \`${column}\` is not a column of any watched table, so nothing is ` +
          `${key === 'maskColumns' ? 'masked' : 'ignored'} by it`,
      );
    }
  }
  return out;
}

export function renderScope(style: Style, scope: ScopeReport, indent = '            '): string[] {
  const out: string[] = [];
  const gaps: string[] = [];
  for (const other of scope.otherSchemas) {
    gaps.push(`${other.schema} (${other.tables} ${other.tables === 1 ? 'table' : 'tables'}, another schema)`);
  }
  for (const name of scope.nameFiltered) gaps.push(`${name} (name begins with _)`);
  for (const name of scope.foreignTables) gaps.push(`${name} (foreign table)`);
  if (gaps.length > 0) {
    out.push(paint(style, 'dim', `${indent}not watched · ${gaps.join(' · ')}`));
  }
  if (scope.partitionedParents.length > 0) {
    // Not a gap — the partitions themselves are watched — but an assertion
    // against the parent's name refuses, and saying so saves the trip.
    out.push(
      paint(
        style,
        'dim',
        `${indent}watched through their partitions · ${scope.partitionedParents.join(', ')}`,
      ),
    );
  }
  return out;
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
          ...(values.wide ? { untruncated: true as const } : {}),
          // A passing step gets a glance; a failing one gets the evidence.
          maxRows: mode === 'all' ? Number.MAX_SAFE_INTEGER : clean ? 3 : 12,
          maxTables: mode === 'all' ? Number.MAX_SAFE_INTEGER : 6,
          interesting,
          indent: '      ',
        }),
      );
      out.push(
        ...renderWriteOrder(step.changes, {
          style,
          indent: '      ',
          maxRows: mode === 'all' ? Number.MAX_SAFE_INTEGER : 8,
        }),
      );
      if (step.changes.changes.length === 0 && step.assertions.length > 0) {
        // The strongest sentence this tool prints, and it is only true when the
        // run actually looked everywhere. A `scope-truncated`, `reduced-fidelity`
        // or `degraded-row-identity` warning means some part of the schema could
        // not be read — a keyless table whose deletes leave no trace, a
        // TRUNCATE that took the before-images with it — and "not a single row
        // was touched" then claims something the capture never established.
        //
        // This is the same failure the expression layer refuses: finding
        // nothing is not proof. Saying so out loud is cheaper than being wrong.
        const blind = verdict.warnings.filter(
          (w) =>
            w.stepId === step.stepId &&
            (w.code === 'scope-truncated' ||
              w.code === 'reduced-fidelity' ||
              w.code === 'degraded-row-identity'),
        );
        out.push(
          blind.length > 0
            ? `      Nothing was seen to change — but this step could not read everything (see below), ` +
              `so this is not the same as nothing having happened.`
            : `      ${step.changes.detection === 'write'
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

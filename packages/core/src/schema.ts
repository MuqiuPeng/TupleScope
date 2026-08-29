/**
 * The wire-format identity of a run report.
 *
 * In core rather than beside the envelope, because the party that has to
 * *check* it — run history on disk — must not depend on the party that writes
 * it. It sat in `report`, so `workspace` could not gate on it and read every
 * stored file with a bare cast instead.
 */
/**
 * Bumped to /2 by the value-shape change.
 *
 * A column value went from `{pgType, text, masked?}` to a tagged union whose
 * withheld arms carry no `text` at all, `RowKey.serialized` became an opaque
 * `token`, and every capture now records the session settings its text was
 * printed under. A /1 reader handed a /2 file would read `undefined` where it
 * expects a string. There is deliberately no shim emitting both: two encodings
 * in one file is how a consumer comes to depend on the one it was not supposed
 * to see.
 */
export const RUN_REPORT_SCHEMA = 'tuplescope.run-report/2' as const;


/** Just the major, for comparisons. */
export function schemaMajor(schema: string): number | null {
  const major = Number(schema.split('/')[1]);
  return Number.isInteger(major) ? major : null;
}

/** Whether this build can read a stored report, and why not. */
export function schemaReadable(schema: unknown): true | string {
  if (typeof schema !== 'string' || !schema.startsWith('tuplescope.run-report/')) {
    return 'it does not identify itself as a TupleScope run report';
  }
  const found = schemaMajor(schema);
  const supported = schemaMajor(RUN_REPORT_SCHEMA)!;
  if (found === null) return `its schema version \`${schema}\` is unreadable`;
  if (found > supported) return `it was written by a newer TupleScope (${schema})`;
  if (found < supported) return `it was written by an older TupleScope (${schema})`;
  return true;
}

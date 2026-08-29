/**
 * Parser for the `test_decoding` output plugin's text format.
 *
 * It reads only what the wal engine actually needs: which table, which
 * operation, and the key columns identifying the row. **Column values are
 * deliberately not trusted**, because measurement against PostgreSQL 17.5 shows
 * three ways they would be wrong:
 *
 *   boolean   `SELECT` returns `f`; the decoder writes `false`
 *   types     the decoder writes format names (`integer`, `boolean`,
 *             `timestamp with time zone`) where `pg_type.typname` has
 *             `int4`, `bool`, `timestamptz`
 *   TOAST     a large column left untouched by an UPDATE comes through as the
 *             literal sentinel `unchanged-toast-datum`, not as its value
 *
 * The last is the dangerous one: a parser that took it as a value would write
 * the string `unchanged-toast-datum` into the row image and report a change
 * that never happened. So values come from SQL, and this file answers only
 * "which rows, in what order, in which transaction".
 *
 * Measured shapes (PostgreSQL 17.5, default plugin options):
 *
 *   BEGIN 781
 *   table public.t: INSERT: id[text]:'r1' amount[numeric]:100.00 flag[boolean]:true
 *   table public.t: UPDATE: id[text]:'r1' big[text]:unchanged-toast-datum
 *   table public.t: DELETE: id[text]:'ghost'
 *   COMMIT 781
 *
 * Under the default REPLICA IDENTITY an UPDATE carries no old-key segment at
 * all and a DELETE carries only the key columns — which is exactly why before
 * images are read from a held MVCC snapshot instead.
 */

/**
 * One decoded operation, as the parser saw it.
 *
 * Distinct from the contract's `Mutation`: this keeps the decoder's raw column
 * text, which exists only to identify the row and must never reach a row image.
 */
export interface DecodedChange {
  /** Commit-ordered position within this capture, from 0. */
  sequence: number;
  /** The transaction that performed it. Rows sharing one are atomic together. */
  transactionId: string;
  schema: string;
  table: string;
  operation: 'insert' | 'update' | 'delete' | 'truncate';
  /**
   * The columns the decoder printed, exactly as it printed them.
   *
   * `quoted` matters: it is the only thing separating the bare sentinel
   * `unchanged-toast-datum` from a row whose value really is that string.
   * Used to identify the row; never to build a row image.
   */
  columns: ReadonlyMap<string, DecodedValue>;
  /** The old key, when a key-changing UPDATE reported one. */
  oldKey: ReadonlyMap<string, DecodedValue> | null;
}

export interface DecodedValue {
  text: string | null;
  quoted: boolean;
}

/** What the parser could not read, so the engine can degrade honestly. */
export interface DecodeProblem {
  line: string;
  reason: string;
}

export interface Decoded {
  mutations: DecodedChange[];
  problems: DecodeProblem[];
  /** Transaction ids seen, in commit order. */
  transactions: string[];
}

/**
 * `table <schema>.<name>: <OP>: <rest>`.
 *
 * TRUNCATE is separate because it names *several* tables on one line —
 * `table public.ta, public.tb: TRUNCATE: (no-flags)` — and reading that with
 * the single-table pattern produced a table literally called `ta, public.tb`,
 * so both real tables vanished from the report without a word.
 */
const HEADER = /^table ((?:"(?:[^"]|"")+"|[^.])+)\.((?:"(?:[^"]|"")+"|[^:])+): (INSERT|UPDATE|DELETE): (.*)$/s;
const TRUNCATE_HEADER = /^table (.+): TRUNCATE: (.*)$/s;

function unquoteIdent(name: string): string {
  return name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name;
}

/**
 * Splits the column list of one change line.
 *
 * Hand-written rather than a regex because a quoted value may contain
 * anything at all, including `[`, `:`, a newline and a doubled quote — the
 * decoder's only escape is `''` inside `'...'`. A regex over the whole line
 * would run past the end of one value and into the next.
 */
function parseColumns(rest: string): {
  columns: Map<string, DecodedValue>;
  oldKey: Map<string, DecodedValue> | null;
  problems: DecodeProblem[];
} {
  const columns = new Map<string, DecodedValue>();
  let oldKey: Map<string, DecodedValue> | null = null;
  // Under REPLICA IDENTITY FULL, and on any update that moves the key, the
  // decoder emits `old-key: … new-tuple: …`. Merging the two loses the old key
  // — and worse, an `unchanged-toast-datum` in the new tuple overwrites a
  // perfectly good old value with a sentinel.
  let target = columns;
  const problems: DecodeProblem[] = [];
  let i = 0;

  while (i < rest.length) {
    while (i < rest.length && rest[i] === ' ') i += 1;
    if (i >= rest.length) break;

    // `old-key:` and `new-tuple:` segment markers, emitted under REPLICA
    // IDENTITY FULL and on a key-changing update. Treated as separators: the
    // engine identifies rows by the key it can see, and reads images from SQL.
    const marker = /^(old-key|new-tuple):\s*/.exec(rest.slice(i));
    if (marker) {
      i += marker[0].length;
      if (marker[1] === 'old-key') {
        oldKey = new Map();
        target = oldKey;
      } else {
        target = columns;
      }
      continue;
    }

    const nameEnd = rest.indexOf('[', i);
    if (nameEnd < 0) {
      problems.push({ line: rest.slice(i, i + 80), reason: 'no column name before `[`' });
      break;
    }
    const name = unquoteIdent(rest.slice(i, nameEnd));

    const typeEnd = rest.indexOf(']:', nameEnd);
    if (typeEnd < 0) {
      problems.push({ line: rest.slice(i, i + 80), reason: 'unterminated type annotation' });
      break;
    }
    i = typeEnd + 2;

    if (rest[i] === "'") {
      i += 1;
      let value = '';
      for (;;) {
        const quote = rest.indexOf("'", i);
        if (quote < 0) {
          problems.push({ line: name, reason: 'unterminated quoted value' });
          i = rest.length;
          break;
        }
        value += rest.slice(i, quote);
        if (rest[quote + 1] === "'") {
          value += "'";
          i = quote + 2;
          continue;
        }
        i = quote + 1;
        target.set(name, { text: value, quoted: true });
        break;
      }
      continue;
    }

    const space = rest.indexOf(' ', i);
    const bare = space < 0 ? rest.slice(i) : rest.slice(i, space);
    i = space < 0 ? rest.length : space;
    // `null` is a bare word; a NULL and the string 'null' are distinguishable
    // because the string form would have been quoted.
    target.set(name, { text: bare === 'null' ? null : bare, quoted: false });
  }

  return { columns, oldKey, problems };
}

/**
 * `unchanged-toast-datum` is what the decoder writes for a large column an
 * UPDATE did not touch. It is a sentinel, not a value.
 */
export const UNCHANGED_TOAST = 'unchanged-toast-datum';

/**
 * Rewrites a decoded value into the text a `SELECT` would have returned.
 *
 * Measured across every type that can carry a key on PostgreSQL 17.5: exactly
 * three of twenty-seven disagree, and they are one family — a value the decoder
 * prints in *literal* syntax rather than *output* syntax.
 *
 *   bool    `true` / `false`   where the wire says `t` / `f`
 *   bit     `B'10101010'`      where the wire says `10101010`
 *   varbit  `B'1010'`          where the wire says `1010`
 *
 * Three is small enough to write down. It is not small enough to remember,
 * which is the point of `decode.types.test.ts`: it builds a table with a column
 * of every key-eligible type, updates it, and fails if any of them normalizes
 * to something a `SELECT` would not return. A fourth type joining this family
 * turns into a red test rather than into rows that quietly stop matching.
 *
 * Returns `null` when the text cannot be recovered at all — an unchanged TOAST
 * datum, which is a sentinel rather than a value. The caller must degrade
 * rather than compare it.
 */
export function toWireText(typname: string, decoded: DecodedValue): string | null | undefined {
  if (decoded.text === null) return null;
  // Only a *bare* sentinel is a sentinel; quoted, it is a row whose value
  // genuinely is that string.
  if (!decoded.quoted && decoded.text === UNCHANGED_TOAST) return undefined;
  switch (typname) {
    case 'bool':
      return decoded.text === 'true' ? 't' : decoded.text === 'false' ? 'f' : decoded.text;
    case 'bit':
    case 'varbit': {
      const framed = /^B'(.*)'$/s.exec(decoded.text);
      return framed ? framed[1]! : decoded.text;
    }
    default:
      return decoded.text;
  }
}

export function decodeStream(rows: ReadonlyArray<{ xid: string; data: string }>): Decoded {
  const mutations: DecodedChange[] = [];
  const problems: DecodeProblem[] = [];
  const transactions: string[] = [];
  let sequence = 0;

  for (const row of rows) {
    const data = row.data;
    if (data.startsWith('BEGIN')) {
      if (!transactions.includes(row.xid)) transactions.push(row.xid);
      continue;
    }
    if (data.startsWith('COMMIT')) continue;
    // A logical message emitted by pg_logical_emit_message; nothing wrote a row.
    if (data.startsWith('message:')) continue;

    const truncated = TRUNCATE_HEADER.exec(data);
    if (truncated) {
      // One line, several tables. It carries no row data anywhere in WAL, so
      // there is nothing to fold into a change — only the fact that it happened.
      for (const qualified of truncated[1]!.split(',')) {
        const dot = qualified.lastIndexOf('.');
        mutations.push({
          sequence: sequence++,
          transactionId: row.xid,
          schema: unquoteIdent(qualified.slice(0, dot).trim()),
          table: unquoteIdent(qualified.slice(dot + 1).trim()),
          operation: 'truncate',
          columns: new Map(),
          oldKey: null,
        });
      }
      continue;
    }

    const header = HEADER.exec(data);
    if (!header) {
      problems.push({ line: data.slice(0, 120), reason: 'unrecognised change line' });
      continue;
    }
    const [, schema, table, op, rest] = header;
    const parsed = parseColumns(rest!);
    problems.push(...parsed.problems);
    mutations.push({
      sequence: sequence++,
      transactionId: row.xid,
      schema: unquoteIdent(schema!),
      table: unquoteIdent(table!),
      operation: op!.toLowerCase() as DecodedChange['operation'],
      columns: parsed.columns,
      oldKey: parsed.oldKey,
    });
  }

  return { mutations, problems, transactions };
}

/**
 * `--ascii`, applied to everything the CLI writes rather than line by line.
 *
 * It was a set of per-site choices (`dot`, `dash`, `glyph`), and every site
 * that did not make one leaked: measured under `--ascii`, `check` still printed
 * `excepts \`walletz\`, which is not a table here — so it excludes nothing`,
 * config errors kept their em-dash, and `run` printed `topup · ghost`, `· 3
 * assertions evaluated and passed`, the `proves` bullets and every warning's
 * `· step`. Most of those sentences are written in the packages, where no
 * style reaches. So the flag is a transform on the output streams (see
 * `scrub.ts`), and the per-site forms stay only where they read better.
 *
 * Only the tool's own punctuation is mapped: the closed set below, which is
 * every non-ASCII character the CLI and the packages it relays print outside
 * comments. A letter is data, not a glyph — `café`, `Zoë`, `東京` in a row
 * value or a scenario title pass through untouched, because rewriting them
 * would show a value the database does not hold. A value that happens to
 * contain one of these marks is shown with its ASCII spelling, as a value
 * with a newline already is (`\n`); `--json` and `--junit -` keep it exact
 * (`asciiDocument` below).
 */

const GLYPHS: ReadonlyArray<readonly [string, string]> = [
  ['·', '-'],
  ['—', '--'],
  ['–', '-'],
  ['→', '->'],
  ['✓', '[ok]'],
  ['✗', '[FAIL]'],
  ['⚠', '[!]'],
  ['…', '...'],
  ['•', '*'],
  ['⏎', '\\n'],
  ['’', "'"],
  ['‹', '<'],
  ['›', '>'],
  ['⟨', '('],
  ['⟩', ')'],
];

const TABLE = new Map(GLYPHS);
const PATTERN = new RegExp(`[${GLYPHS.map(([glyph]) => glyph).join('')}]`, 'g');

/** The tool's glyphs spelled in ASCII; every other character left as it was. */
export function asciiGlyphs(text: string): string {
  return text.replace(PATTERN, (glyph) => TABLE.get(glyph)!);
}

/**
 * A JSON or XML document in ASCII, without changing what it says.
 *
 * The glyph table is the wrong tool for a document: it would rewrite a stored
 * value (`a—b` read back as `a--b`), and `‹` becoming `<` would break XML. Both
 * formats have an escape that means the same character, so every non-ASCII
 * character is written as that — `\u2014` in JSON, `&#x2014;` in XML — and a
 * parser reads back exactly what the envelope holds.
 */
export function escapeDocument(text: string, format: 'json' | 'xml'): string {
  if (format === 'json') {
    // JSON.stringify leaves non-ASCII only inside strings, where `\uXXXX` is
    // the same character; a pair is escaped unit by unit, which JSON allows.
    return text.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  }
  return text.replace(/[^\x00-\x7f]/gu, (c) => `&#x${c.codePointAt(0)!.toString(16)};`);
}

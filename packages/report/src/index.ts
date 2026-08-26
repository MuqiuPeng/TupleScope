/**
 * @statescope/report — the machine-readable shapes.
 *
 * One envelope and one JUnit writer serve `--json`, stored runs and (in v0.3)
 * MCP. Human rendering is not here: it belongs to whichever surface has a
 * terminal or a browser, and only these two have to stay wire-compatible.
 */
export * from './envelope.js';
export * from './junit.js';

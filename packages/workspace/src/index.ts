/**
 * @statescope/workspace — config in, a running engine out.
 *
 * The HTTP runtime, the CLI and later MCP are three callers of this one
 * assembly. Nothing here knows about HTTP serving, terminals or MCP.
 */
export * from './config.js';
export * from './session.js';
export * from './history.js';

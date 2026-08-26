/**
 * @statescope/core — the contracts, and nothing else.
 *
 * This package holds types and pure helpers. It must never depend on React, on
 * a database driver, on WhoDB, or on the MCP layer; those are adapters around
 * it. v0.1 is deliberately relational and Postgres-shaped rather than pretending
 * to a database-neutral value model it cannot honestly provide — a document
 * store will be a new ChangeSet variant, not this one wearing a disguise.
 */
export * from './value.js';
export * from './changeset.js';
export * from './scenario.js';
export * from './assertion.js';
export * from './run.js';
export * from './verdict.js';

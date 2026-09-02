# Publishing

Eleven packages go to npm; four stay private. `pnpm publish -r` handles the
order and rewrites `workspace:*` to the version being published.

```bash
npm login                       # once
pnpm test                       # 748, and CI green on all five legs
pnpm publish -r --access public
```

`--access public` is belt and braces: every scoped package already carries
`publishConfig.access` because a scoped package publishes *restricted* by
default, and a restricted publish on a free account fails outright rather than
warning.

## What ships, and what does not

| | |
| --- | --- |
| `tuplescope` | the CLI. This is the one people type: `npx tuplescope`. |
| `tuplescope-mcp` | the MCP server, for `npx -y tuplescope-mcp` in an agent's config. |
| `@tuplescope/*` | nine libraries the two above depend on. |
| **not published** | `tuplescope-workspace` (this repository), `@tuplescope/runtime`, `@tuplescope/web`, `@tuplescope/conformance`. |

**The web UI is not on npm, and that is deliberate rather than an oversight.**
`@tuplescope/runtime` serves it and is private, so `npx tuplescope` gets you the
terminal and the MCP server and not the browser. The UI is a local development
surface that binds to loopback, mints a per-start token and writes session files
under `~/.tuplescope` — it is something you run from a checkout, not something
you install. `pnpm start` is how, and the README says so.

The same goes for `pnpm demo`: it is a script in this repository, not a shipped
command, so it comes with a clone and not with an install.

## Why the root package is called `tuplescope-workspace`

Because `tuplescope` is what a person types, and a name can only be one thing.
The root is private and its name appears nowhere but pnpm's own output, so it is
the one that gave way.

## Before the next one

- Bump every version together. They are released in lockstep and
  `workspace:*` resolves to whatever is being published, so a partial bump
  publishes a package depending on a version that does not exist.
- The two version constants in code — `apps/cli/src/main.ts` and
  `apps/mcp/src/server.ts` — are not read from `package.json`. `--version` and
  the envelope's `producer` both come from them, and a stale one is a report
  that lies about what wrote it.
- `RUN_REPORT_SCHEMA` moves only when the envelope shape changes in a way an
  older reader would misread. Optional additions do not count: `report` refuses
  a schema it does not know, so bumping it needlessly breaks reading yesterday's
  runs for nothing.

## Verifying without publishing

`pnpm publish -r --dry-run --no-git-checks` lists what would go and packs each
one. That checks the manifests, not the result. To check the result, pack every
package, install the tarballs into an empty project with `pnpm.overrides`
pointing each name at its `.tgz`, and run the CLI from there — that is the only
way to find out whether the thing someone installs actually starts. It was done
for 0.4.0: `--version`, `--help`, a clean exit 4 with no workspace, and a real
scenario run at 23/23.

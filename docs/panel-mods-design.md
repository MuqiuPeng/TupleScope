# Panel mods — design r2

*Types are normative; prose is not. Nothing is built. r2 is frozen on shape:
Worker, named sources, one-way scene protocol, step-complete updates.*

r1 got the product boundary right — the repo chooses the data, the user installs
the renderer, the mod gets the least it can be given — and then made one claim it
could not keep:

> No network, ever. Not an allow-list, not a prompt — `connect-src 'none'`.

`connect-src` governs fetch, XHR, WebSocket and EventSource. It does not govern
**navigation**, and a document can navigate itself to a URL with the data in the
query string. There is no portable "this document is offline" switch. r1 was
therefore asserting something stronger than a browser can deliver, which is
exactly the failure this project exists to avoid: a claim that looks precise and
is wrong.

r2 does not weaken the claim. It changes the container so the claim becomes true.

---

## 1. Why a Worker, precisely

Not "workers are safer". The argument is an exhaustive one about API surface,
measured in the browser rather than reasoned about:

| | Ways to reach the network | Of those, governed by CSP |
|---|---|---|
| **document** | `fetch`, `XHR`, `WebSocket`, `EventSource`, **navigation**, `window.open`, `<img>`, `<form>`, `<a target>` | the first four |
| **Worker** | `fetch`, `XHR`, `WebSocket`, `EventSource`, `importScripts` | **all of them** |

Measured inside a Worker: `location.href` has no setter, `location.assign`,
`open`, `document`, `Image`, `HTMLFormElement`, `top` and `parent` are all
absent. There is nothing there to navigate, and nothing to build an element out
of. So the set of ways out and the set CSP governs are the same set.

`connect-src 'none'` is therefore a **complete** statement about a Worker and a
**partial** one about a document. That is structural — it does not depend on
browser version, on policy, or on the address being reached.

And the inheritance the scheme rests on was measured too, by the violation event
rather than by watching the network: a blob Worker created inside a document
carrying `connect-src 'none'` had its `fetch` refused with
`violatedDirective: "connect-src"`.

### 1.1 What the iframe experiment actually showed, and did not

The sandboxed-iframe design was tested first, with eight escape routes — fetch,
img, beacon, script, anchor, form, `window.open`, and self-navigation — against
a local server that logged anything reaching it. **Nothing got out**, with or
without CSP, while the same frame *without* `sandbox` leaked its payload
immediately.

That result is **inconclusive, and must not be cited as evidence.** The frame's
origin is `null`, the probe was on `127.0.0.1`, and Chrome refuses opaque-origin
requests to a private network address before they are sent. So the experiment
cannot separate "the sandbox stopped it" from "the private-network rule stopped
it", and the honest resolution — pointing it at a real external host — is
performing the exfiltration in order to measure it, which is not worth doing.

The measurement was abandoned rather than fixed, because the Worker argument
above does not need it. This subsection exists so nobody re-runs the same test,
gets the same clean-looking result, and concludes the iframe was fine.

---

## 2. The split, unchanged from r1

| Field | Who | Why |
|---|---|---|
| `panels[].mod` — an **alias** | **Repo** | Inert until the user binds it. An unbound alias is a refusal, not an action. |
| `panels[].sources` — **named expressions** | **Repo** | The repo knows its schema and should choose what a panel is *about*. Inert data selection, in the language assertions already use. |
| `panels[].title`, `unit`, `hint` | **Repo** | Labels only ever describe. |
| What the alias renders | **User**, `~/.tuplescope/mods/` | This is code, and that is the whole trust decision. |
| Which workspaces it may run in | **User**, per-workspace grant | `HandoffConfigV1`, `WorkspaceGrant`, `grantKey`, `isGranted`, `workspaceKey` already exist and generalise unchanged. |

---

## 3. Named sources

r1 said "a panel that wants two numbers is one `source` that selects both", and
that was not true of anything: `seriesFor` yields at most one value per step and
refuses when several rows match. A chart of `on_hand` against `reserved` was
unbuildable by the document's own contract.

The repo names its inputs; the mod declares the shape it needs; the host
evaluates and matches.

```yaml
panels:
  - mod: stock-levels
    title: Desk stock
    sources:
      onHand:   after(updated(stock, sku = "SKU-DESK").on_hand)
      reserved: after(updated(stock, sku = "SKU-DESK").reserved)
```

```json
{ "v": 1, "name": "stock-levels", "render": "panel.js",
  "inputs": {
    "onHand":   { "kind": "series", "type": "numeric" },
    "reserved": { "kind": "series", "type": "numeric", "optional": true }
  } }
```

A source the mod does not declare is not sent. A declared, non-optional input
with no matching source is a refusal at load, named in the page — not a mod that
renders half a chart and says nothing.

---

## 4. What crosses the boundary

**Not the core types.** `SeriesPoint` and `Value` are internal contracts that
change for internal reasons; `Value` carries `parsed?: unknown`, which may not
survive structured-clone, is not needed for drawing, and would hand every mod a
different runtime object. The wire contract is its own thing and is allowed to
be smaller.

```ts
export interface PanelPayload {
  readonly v: 1;
  readonly title: string;
  readonly unit?: string;
  /** Keyed by the mod's declared input names. */
  readonly inputs: Readonly<Record<string, ReadonlyArray<PanelPoint>>>;
  readonly steps: ReadonlyArray<{ stepId: string; name: string; at?: string }>;
  /** Bumped per send. A mod may ignore anything it has already seen. */
  readonly revision: number;
  readonly runState: 'running' | 'finished';
  readonly stale: boolean;
}

export type PanelValue =
  | { readonly state: 'visible'; readonly pgType: string; readonly text: string | null }
  | { readonly state: 'masked'; readonly pgType: string };

export type PanelPoint =
  | { readonly state: 'observed'; readonly value: PanelValue }
  | { readonly state: 'carried'; readonly value: PanelValue; readonly since: string }
  | { readonly state: 'unobserved' }
  | { readonly state: 'unevaluable'; readonly code: PanelErrorCode };

/**
 * A code, never the sentence.
 *
 * `Unevaluable` messages are written for a person and name what they are about:
 * `no table \`orders\` in this database (tables: cart_items, carts, order_lines,
 * orders, products, stock_movements)` — an expression, a table, and the entire
 * schema, handed to the mod. The page shows the sentence; the mod gets the code.
 */
export type PanelErrorCode =
  | 'not-observed-here'
  | 'value-withheld'
  | 'several-rows-matched'
  | 'needs-write-detection'
  | 'read-incomplete'
  | 'source-refused';
```

A `masked` value crosses as `masked` and carries no text — so a mod cannot
disclose what it never received. This is the one place in the design where the
masking boundary holds by construction rather than by warning.

---

## 5. The scene protocol

The Worker cannot draw. It returns a description and the host renders it.

```ts
export type PanelScene = {
  readonly v: 1;
  readonly width: number;
  readonly height: number;
  readonly marks: ReadonlyArray<PanelMark>;
};

export type PanelMark =
  | { readonly kind: 'line'; readonly points: ReadonlyArray<readonly [number, number]>; readonly stroke: PanelColour; readonly dashed?: true }
  | { readonly kind: 'bar'; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly fill: PanelColour }
  | { readonly kind: 'dot'; readonly x: number; readonly y: number; readonly r: number; readonly fill: PanelColour }
  | { readonly kind: 'text'; readonly x: number; readonly y: number; readonly text: string; readonly align?: 'start' | 'middle' | 'end' }
  | { readonly kind: 'rule'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number };

/** Named, from the page's own palette. Not arbitrary: a mod does not get to
 *  paint something the same colour as a failure. */
export type PanelColour = 'ink' | 'muted' | 'faint' | 'accent' | 'clean' | 'failed' | 'review' | 'running';
```

Validated by the host before anything is drawn. Numbers must be finite,
coordinates inside the box, `text` length-capped, colours from the enum. A scene
that fails validation renders as an error in place; the panel beside it is
untouched. A mod cannot take down the evidence it sits next to.

The alternative considered was an offscreen `Canvas`/`ImageBitmap`, which is
more expressive and gives up the ability to say what a mod drew. A scene can be
inspected, capped, themed and diffed; a bitmap can only be shown.

---

## 6. Updating

Whole snapshots, on step completion. Never a patch, never per poll.

- A completed step is frozen, so a drawn point never moves.
- The step in flight is not sent, so a point cannot appear as `carried` and then
  become `observed` a moment later.
- A dropped message cannot corrupt anything, because there is no accumulated
  state to corrupt — the mod is given the whole series each time.
- `revision` lets a mod skip work it has already done; `runState` lets it say
  "still running" in its own words.

---

## 7. Interaction

v1 opens no channel from the mod to the host. The distinction that matters is
not "interactive or not":

- **Allowed, and needs no channel:** hover, tooltip, legend toggling, zoom —
  anything over data the mod already has. The scene is re-emitted; the host
  re-renders. A mod may be told about pointer position by the host, which is the
  host talking, not the mod asking.
- **Not allowed:** re-querying, running a step, resetting, handing off, writing
  an assertion, opening a URL.

If a channel is ever added it is a closed union of intents, never a message:

```ts
type PanelIntent =
  | { readonly type: 'select-point'; readonly input: string; readonly stepId: string }
  | { readonly type: 'resize'; readonly height: number };
```

Draw-only is cheap to widen and impossible to narrow.

---

## 8. Loading a mod

The bytes that were approved are the bytes that run.

1. read the module into memory, once;
2. digest **those bytes**;
3. check the digest and the grant;
4. execute **those same bytes** — as a blob Worker built from the buffer already
   held.

Never hash a path and then load from the path again: the file can change in
between, and the check then describes something other than what ran. `install`
copies rather than links, for the same reason.

```ts
export interface ModBinding {
  readonly directory: string;
  readonly realpath: string;
  /** sha256 of the module bytes, as executed. */
  readonly digest: string;
  readonly grants: ReadonlyArray<WorkspaceGrant>;
}
```

Same-user threat unchanged from `handoff`: anything running as the user already
has code execution, and the digest catches accident and drift, not an attacker.

---

## 9. A prerequisite that does not exist yet

**The page serves no `Content-Security-Policy` at all** — measured: zero CSP
headers, no meta tag. Every guarantee above is inherited by the Worker from the
page, so the page's policy is not a detail of this feature, it *is* the feature.
It has to land, and be tested, before a mod is loaded.

The host page also has to keep working under whatever policy is chosen, and it
currently uses inline handlers freely, so this is not a one-line addition.

---

## 10. What is still not offered

- No mod reads a whole `Run`, `ChangeSet`, or a row it was not given.
- No repo-supplied code in any form — not a URL, not a data URI, not a template.
- No network, and now that is a statement about an API surface rather than about
  a policy.
- No mods on non-interactive surfaces. The CLI and MCP render text and have no
  worker to host; `panels` is ignored there rather than approximated.

---

## 11. Open

1. **Does the scene vocabulary cover a real panel?** It was written from two
   imagined charts. Before building, three real ones should be drawn against it
   on paper — including "form the product's own screen", which is the request
   that started this and which `line | bar | dot | text | rule` plainly does not
   satisfy.
2. **What does a mod do with `carried`?** The host knows it is inference; the
   mod decides whether to draw it dashed, interpolate, or stop the line. Left to
   the mod, but the default in the shipped example sets the convention.
3. **Cost.** A Worker per panel, re-posted per step. Fine for four panels and
   twenty steps; unmeasured beyond that.

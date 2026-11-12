# Extensions: what installs here, and what to build instead

The `pixtensionnotes.txt` guide ranks twenty pi extensions by how well they fit
Cloudflare Workers. The ranking instinct is right — no filesystem, no
subprocesses, no terminal UI, network through `fetch()`, persistence in Durable
Object SQLite — but the install mechanism it assumes does not exist in this
runtime.

Checked **2026-11-12** by unpacking every package from npm and reading its
imports and API calls. All twenty exist; none of the nineteen below can be
installed as-is. Each is a design to port, not a dependency to add.

## The two extension APIs

| | pi coding agent | pi-durable (this repo) |
| --- | --- | --- |
| Runtime | Bun CLI on a machine | Durable Object |
| Extension is | `ExtensionAPI` + `ctx.ui` + `fs` + `child_process` | `{ name, tools?, sections?, hooks?, wraps?, tasks? }` |
| Installed by | `pi install npm:…` | `registry.install(extension)` at startup |
| UI | terminal | WebSocket to `src/client.tsx` |
| Bundled | at install time | at deploy time |

An `Extension` here is plain data: tools it contributes, prompt sections it
renders, hooks it registers, tasks it schedules. There is no `ctx.ui`, no
storage handle, and no way to load code at runtime.

## Already done: `pi-lean-search` (excluded from this list)

This is the one you solved differently, and it worked. `pi-lean-search` is a
SearXNG client for the coding agent: no API keys, no quotas, one HTTP call to an
instance you control. This repo gets the same capability natively —
`src/extensions/web-search.ts` queries `SEARXNG_URL` first — and the instance
behind that variable is your own SearXNG on Render. So the package was never
needed: the *capability* was "search through a SearXNG instance I run," and that
is exactly what is installed. The native version additionally falls back to Bing
HTTP, Bing through Browser Rendering, DuckDuckGo HTML and Lite, and caches
results for five minutes.

## Tier A — server-only, no client change

- **`keep-the-why`** — decisions recorded as Markdown in the repo. Instructions
  only, no runtime API. Build: a `sections` entry plus a `why` tool that appends
  to `/workspace/WHY.md`. **S**
- **`pi-openrouter-provider-picker`** — choose the upstream provider for
  OpenRouter models. Package is a `ctx.ui` picker (12 calls). Build: a stored
  preference per conversation and `provider.order` on the request; worth doing
  because provider choice is a 2.7× price swing and the guard against a
  frontier-model slip. **M**
- **`pi-openrouter-presets`** — OpenRouter presets as first-class models with
  live pricing. Build: register preset model refs in the model registry and
  surface price before a turn. **M**
- **`pi-summarize`** — one-line activity summaries and auto-titled sessions from
  a cheap side model. Package touches `node:fs`. Build: a hook on generation
  events, one small model call, titles in DO storage. **M**
- **`pi-friends`** — consult other models on hard problems, one tool per friend.
  Package pulls `node:child_process` and `node:net` only for its tunnel. Build:
  `fetch` to OpenAI-compatible endpoints, keys as Worker secrets, one tool per
  friend. **M**
- **`pi-scraper`** — crawl, map and extract. Fast/readable mode is `fetch` plus
  HTML parsing; browser mode uses Playwright, which is unavailable. Build:
  native fetch+parse now, and route JS-heavy pages through the existing
  `BROWSER` binding. **L**

## Tier B — needs a tool and a client change

- **`pi-choices`** — structured question forms (radio, checkbox, text). Build:
  an `ask` tool that returns a schema, the client renders it, the answer resumes
  the turn over the existing socket. **M**
- **`pi-ask-herdr`** — `ask_user` plus blocked-state reporting and OSC 7501.
  Build the `ask_user` subset; blocked state maps to a socket event or an alarm
  rather than a terminal escape. **M**
- **`pi-sticky`** — pinned messages the agent can raise and the user resolves.
  Build: a `pin` tool writing rows to DO storage, a pinned area in the client,
  and a resolve action. **M**
- **`pi-stretchtext`** — short answers whose phrases expand in place. Purely a
  rendering idea; the client already renders Markdown via Streamdown. **S**
- **`pi-pokepet`** — a pet that reacts to tools, tests and commits. 46 `ctx.ui`
  calls, but the interesting part is event-driven animation in the client. **S**

## Tier C — needs new infrastructure

- **`pi-agent-goal`** — persistent `/goal` workflows with branch-aware state and
  progress tools. The package uses the coding agent's API, not alarms, but
  pi-durable already has the primitives: `Extension.tasks`, `hooks`, DO alarms
  and SQLite. This is the most valuable port on the list. **L**
- **`pi-operator`** — a second, attached conversation beside a busy session. The
  harness already supports multiple conversations per object; this is a UI tab
  plus a conversation handle. **M**
- **`pi-spaces`** — several named agent homes with separate sign-ins and
  settings. Here the analogue is a session per Durable Object plus a `/workspace`
  root, which already exists; "spaces" becomes a workspace selector. **M**
- **`pi-agent-replicate`** — an agent copying itself onto independent tasks.
  Package spawns processes (32 `spawn` calls). Build: copy a conversation's rows
  to a new DO and fan out. **L**
- **`pi-agent-swarm`** — a swarm of agents in tiling terminal windows. 64
  `spawn`, 42 `ctx.ui`. Build: N Durable Objects plus a coordinator; this is the
  Agents SDK pattern, not an extension. **L**
- **`pi-lite-subagent`** — parallel and chained subagent dispatch. 11 `spawn`
  calls, `node:os`/`node:path`. Build: a child DO per task with RPC, bounded
  concurrency, and the parent waiting on results. **L**
- **`pi-hybrid-subagents`** — role-based multi-model specialists. 467 `spawn`,
  197 `ctx.ui`. Same infrastructure as above plus per-role model config. **L**

## Tier D — not an extension

- **`pi-market`** — browse and install packages from the pi.dev gallery. It
  writes packages to disk (`node:fs/promises`) and installs them into a running
  CLI. Nothing can install code into a live isolate: bundles are fixed at
  deploy. A "market" here could only be a catalog of documented capabilities.

## Adding one

```ts
this.registry.install({
  name: "goal",
  tools: [goalTool],
  sections: [{ key: "goal", render: () => prompt, tag: false }]
});
```

Write it in `src/extensions/`, add it to `server.ts`, verify with `tsc`,
`vitest` and `vite build`, commit and push — the connected build deploys it.
That is the whole loop, and it is why the harness was built this way.

## What I would do first

1. Provider/model pinning — it stops the silent frontier-model spend.
2. `goal` — persistence the assistant can resume, using tasks and alarms.
3. `ask_user` — the largest UX gain per line, once the client renders choices.
4. Memory — not on this list, but the same `sections` + `tools` shape over DO
   SQLite.

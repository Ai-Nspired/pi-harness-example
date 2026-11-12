# Extensions: what installs here, and what to build instead

The `pixtensionnotes.txt` guide ranks twenty pi extensions by how well they fit
Cloudflare Workers. The ranking instinct is right — no filesystem, no
subprocesses, no terminal UI, network through `fetch()`, persistence in Durable
Object SQLite — but the install mechanism it assumes does not exist in this
runtime.

Checked **2026-11-12** by unpacking every package from npm and reading its
imports and API calls. All twenty exist; none of the nineteen below can be
installed as-is. Each is a design to port, not a dependency to add.

## Coverage

| # | Extension | npm version | Tier |
| --- | --- | --- | --- |
| 1 | `pi-market` | 0.1.3 | D |
| 2 | `pi-agent-goal` | 2026.7.18 | C |
| 3 | `pi-openrouter-provider-picker` | 0.1.2 | A |
| 4 | `pi-lean-search` | 0.7.2 | done — see below |
| 5 | `pi-openrouter-presets` | 0.2.2 | A |
| 6 | `pi-ask-herdr` | 0.3.0 | B |
| 7 | `pi-choices` | 0.1.5 | B |
| 8 | `pi-stretchtext` | 0.1.0 | B |
| 9 | `pi-summarize` | 0.3.0 | A |
| 10 | `pi-friends` | 1.0.0 | A |
| 11 | `pi-operator` | 0.0.0 | C |
| 12 | `pi-spaces` | 0.16.1 | C |
| 13 | `keep-the-why` | 0.20.3 | A |
| 14 | `pi-pokepet` | 1.6.4 | B |
| 15 | `pi-sticky` | 0.2.0 | B |
| 16 | `pi-agent-replicate` | 1.4.2 | C |
| 17 | `pi-agent-swarm` | 0.4.0 | C |
| 18 | `pi-lite-subagent` | 0.3.0 | C |
| 19 | `pi-hybrid-subagents` | 0.6.1 | C |
| 20 | `pi-scraper` | 0.13.1 | A |

A = server-only extension. B = tool plus a client change. C = new infrastructure.
D = not possible at runtime.

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

## Already done: `pi-lean-search`

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

- **`pi-openrouter-presets`** (0.2.2) — OpenRouter presets as first-class models,
  with live pricing. The package registers each preset as a `@preset/<slug>`
  model, reading its context window, reasoning support and cost, so `/model`
  lists it beside ordinary models and `/presets` shows the price. OpenRouter
  presets are named configurations stored in your account: model, provider
  order, and parameters. That is why this one matters here — **the provider pin
  lives in OpenRouter, so changing the route needs no deploy.** Build: the repo
  already has `createModels()` and pi-ai ships an OpenRouter provider, so add a
  provider keyed by a Worker secret, register one model ref per preset, and read
  metadata and pricing from `GET https://openrouter.ai/api/v1/models`. A `models`
  tool lists what is available and its price. **M** — and the same build supplies
  the provider pinning below, so do them together.
- **`pi-openrouter-provider-picker`** (0.1.2) — choose the upstream provider for
  an OpenRouter model per request. Package is a `ctx.ui` picker with 12 UI calls.
  Build: a stored provider preference per conversation, sent as `provider.order`
  on the request. Worth doing because the same model ranges from $0.054 to $0.15
  per million input tokens depending on route, and because pinning is the guard
  against a silent frontier-model slip. **M**
- **`keep-the-why`** (0.20.3) — decisions recorded as Markdown in the repo.
  Instructions only, no runtime API. Build: a `sections` entry plus a `why` tool
  that appends to `/workspace/WHY.md`. **S**
- **`pi-summarize`** (0.3.0) — one-line activity summaries and auto-titled
  sessions from a cheap side model. Package touches `node:fs`. Build: a hook on
  generation events, one small model call, titles in DO storage. **M**
- **`pi-friends`** (1.0.0) — consult other models on hard problems, one tool per
  friend. Package pulls `node:child_process` and `node:net` only for its tunnel.
  Build: `fetch` to OpenAI-compatible endpoints, keys as Worker secrets, one tool
  per friend. **M**
- **`pi-scraper`** (0.13.1) — crawl, map and extract. Fast/readable mode is
  `fetch` plus HTML parsing; browser mode uses Playwright, which is unavailable.
  Build: native fetch+parse now, and route JS-heavy pages through the existing
  `BROWSER` binding. **L**

## Tier B — needs a tool and a client change

- **`pi-choices`** (0.1.5) — structured question forms (radio, checkbox, text).
  Build: an `ask` tool that returns a schema, the client renders it, the answer
  resumes the turn over the existing socket. **M**
- **`pi-ask-herdr`** (0.3.0) — `ask_user` plus blocked-state reporting and OSC
  7501. Build the `ask_user` subset; blocked state maps to a socket event or an
  alarm rather than a terminal escape. **M**
- **`pi-sticky`** (0.2.0) — pinned messages the agent can raise and the user
  resolves. Build: a `pin` tool writing rows to DO storage, a pinned area in the
  client, and a resolve action. **M**
- **`pi-stretchtext`** (0.1.0) — short answers whose phrases expand in place.
  Purely a rendering idea; the client already renders Markdown via Streamdown.
  **S**
- **`pi-pokepet`** (1.6.4) — a pet that reacts to tools, tests and commits. 46
  `ctx.ui` calls, but the interesting part is event-driven animation in the
  client. **S**

## Tier C — needs new infrastructure

- **`pi-agent-goal`** (2026.7.18) — persistent `/goal` workflows with
  branch-aware state and progress tools. The package uses the coding agent's API,
  not alarms, but pi-durable already has the primitives: `Extension.tasks`,
  `hooks`, DO alarms and SQLite. The most valuable port on the list. **L**
- **`pi-operator`** (0.0.0) — a second, attached conversation beside a busy
  session. The harness already supports multiple conversations per object; this
  is a UI tab plus a conversation handle. **M**
- **`pi-spaces`** (0.16.1) — several named agent homes with separate sign-ins and
  settings. Here the analogue is a session per Durable Object plus a
  `/workspace` root, which already exists; "spaces" becomes a workspace selector.
  **M**
- **`pi-agent-replicate`** (1.4.2) — an agent copying itself onto independent
  tasks. 32 `spawn` calls. Build: copy a conversation's rows to a new DO and fan
  out. **L**
- **`pi-agent-swarm`** (0.4.0) — a swarm of agents in tiling terminal windows.
  64 `spawn`, 42 `ctx.ui`. Build: N Durable Objects plus a coordinator; the
  Agents SDK pattern, not an extension. **L**
- **`pi-lite-subagent`** (0.3.0) — parallel and chained subagent dispatch. 11
  `spawn` calls, `node:os`/`node:path`. Build: a child DO per task with RPC,
  bounded concurrency, and the parent waiting on results. **L**
- **`pi-hybrid-subagents`** (0.6.1) — role-based multi-model specialists. 467
  `spawn`, 197 `ctx.ui`. Same infrastructure as above plus per-role model
  config. **L**

## Tier D — not an extension

- **`pi-market`** (0.1.3) — browse and install packages from the pi.dev gallery.
  It writes packages to disk (`node:fs/promises`) and installs them into a
  running CLI. Nothing can install code into a live isolate: bundles are fixed at
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

1. Presets plus provider pinning — one build, and it stops the frontier-model
   spend while giving per-route pricing.
2. `goal` — persistence the assistant can resume, using tasks and alarms.
3. `ask_user` — the largest UX gain per line, once the client renders choices.
4. Memory — not on this list, but the same `sections` + `tools` shape over DO
   SQLite.

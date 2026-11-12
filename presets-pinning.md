# Presets and pinning

How this Worker calls OpenRouter presets you create in the dashboard. The short
version: a preset is addressed as a **model id**, `@preset/<slug>`, and this repo
registers one such model per slug so pi can select it like any other model.

## What a preset is

Created at `openrouter.ai/settings/presets`. Each one can hold:

- model selection, including an ordered fallback list
- provider routing (sort by price or latency, include or exclude providers)
- a system prompt
- generation parameters (temperature, top_p, …)
- provider-side tools

Saving an existing slug creates a new **version** and makes it active, so a
prompt or routing change needs no deploy. There is no account-wide default
preset for the API: every request must name one.

**The prefix matters.** OpenRouter ignores a bare slug. The request must say
`@preset/<slug>`, so this repo builds that id for you and keeps the bare slug in
configuration.

## Configuration

| Variable | Kind | Meaning |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | secret | Your OpenRouter key. Without it, the Worker uses Workers AI and presets are ignored. |
| `OPENROUTER_PRESETS` | var | Comma-separated preset entries, e.g. `fast, smart, z-ai/glm-4.7@preset/deep`. See the three forms below. |
| `OPENROUTER_DEFAULT_PRESET` | var | Slug a new session starts on. Falls back to the first configured preset. |
| `OPENROUTER_PROVIDER_ORDER` | var | Optional fallback pin, e.g. `Wafer, Z.ai`. Presets are the primary place for routing. |
| `OPENROUTER_MODEL` | var | Model whose metadata (context window, price) preset models inherit. Default `z-ai/glm-5.3-flash`. |

`wrangler.jsonc` carries the four non-secret values with empty defaults, so a
deploy never needs a key in the repository.

`OPENROUTER_MODEL` accepts any OpenRouter model id, including one newer than the
catalogue bundled with pi-ai. An id the catalogue does not know is registered
with conservative defaults (128k context, 8k output, cost reported as zero)
rather than being silently replaced by catalogue entry zero — which is a
frontier model, and an expensive surprise.

## Three ways to address a preset

OpenRouter documents three, and this repo supports the two model-id forms:

| Form | Example | Registered as |
| --- | --- | --- |
| Bare preset | `fast` | `@preset/fast` |
| Preset pinned to a model | `z-ai/glm-4.7@preset/deep` | the same string |
| `model@slug` shorthand | `z-ai/glm-4.7@deep` | `z-ai/glm-4.7@preset/deep` |

The third documented form — a separate `preset` field in the request body —
would need a second code path for the same result, so it is not used here. The
pinned form matters when a preset is defined for one model: its metadata then
comes from that model rather than from `OPENROUTER_MODEL`, so context window and
price are right.

## What the Worker sends

For a preset, the request body is an ordinary chat completion whose model is the
prefixed slug:

```json
{
  "model": "@preset/fast",
  "messages": [{ "role": "user", "content": "hello" }],
  "stream": true
}
```

With `OPENROUTER_PROVIDER_ORDER` set, the same body also carries a routing
object. pi merges `samplingParams` into an OpenAI-compatible request as-is, so a
model pinned to Wafer first sends:

```json
{
  "model": "@preset/fast",
  "provider": { "order": ["Wafer", "Z.ai"] },
  "messages": [{ "role": "user", "content": "hello" }]
}
```

That request goes to `https://openrouter.ai/api/v1/chat/completions` with
`Authorization: Bearer <OPENROUTER_API_KEY>`.

## How the Worker builds it

`src/openrouter.ts`:

```ts
const base = openrouterProvider();               // pi-ai's OpenRouter provider
const baseModel = catalog.find((m) => m.id === wanted) ?? catalog[0];

const presetModels = presets.map((slug) =>
  withProviderOrder(
    { ...baseModel, id: presetModelId(slug), name: `OpenRouter ${slug}` },
    order
  )
);

const provider = { ...base, getModels: () => [...base.getModels(), ...presetModels] };
```

`provider` reports the presets as models, and `src/server.ts` selects it when the
key is present:

```ts
readonly openrouter = createOpenRouterSetup(this.env);
private openModels() {
  this.models.setProvider(this.openrouter?.provider ?? this.ai.provider);
  return this.models;
}
```

So the session model is `openrouter/@preset/fast`, resolved by pi-ai against the
provider, and Workers AI remains the fallback when there is no key.

## Setting it up from the dashboard

1. Create the preset at `openrouter.ai/settings/presets`; note its slug.
2. Cloudflare dashboard → Workers & Pages → `pi-harness-example` → **Settings**
   → **Variables and Secrets**.
3. Add `OPENROUTER_API_KEY` as a **secret** (Encrypt). Never put it in
   `wrangler.jsonc`.
4. Add or edit `OPENROUTER_PRESETS` with the slugs, comma-separated, and set
   `OPENROUTER_DEFAULT_PRESET` to one of them.
5. Deploy, then open the Worker with **New session** — pi fixes a session's tool
   and model list when the session is created.

Adding another preset later is just a new slug in `OPENROUTER_PRESETS`; changing
what a preset does is done entirely in OpenRouter, with no deploy.

## Why this helps with system prompts

A preset can carry a system prompt *and* the model and routing that go with it.
That means the harness no longer has to encode per-model instructions in code:
the preset states them, OpenRouter applies them, and editing one takes effect on
the next session. The harness's own preamble still applies — the preset's prompt
is added alongside it, not instead of it — so keep durable, runtime-specific
instructions (the workspace, the tools) in `src/server.ts`, and put model-facing
behaviour and routing in the preset.

## Pinning

Two layers, in order of preference:

1. **The preset.** Provider order, allow/deny lists and price ceilings live
   there, so the pin survives any code change and needs no deploy.
2. **`OPENROUTER_PROVIDER_ORDER`.** A request-level fallback for a plain model
   (no preset), sent as `provider.order`. It only applies to the
   OpenAI-compatible API path, which is what this Worker uses.

Presets also accept `max_price`, which is the honest way to make a cost ceiling
stick: a request that cannot be served under it fails instead of silently
running on an expensive route.

## Verifying

- OpenRouter → **Activity** shows each request's preset, model and provider.
- Cloudflare dashboard → the Worker → **Logs** shows `pi report` warnings if a
  provider rejects the key or the preset slug.
- A wrong slug fails at request time, not at startup, because the catalog is
  built from configuration rather than validated against your account.

## Later: a Worker that is only a router

A separate Worker whose single job is to forward to OpenRouter is a reasonable
next step, and it is not built here. The shape it would take: the same
`src/openrouter.ts` provider logic behind one endpoint that accepts a preset slug
and a message list, adds the key server-side, and returns the stream. That would
let other clients — this harness, a script, your own tools — share the presets
without each one carrying OpenRouter configuration, and it would keep the key in
one place. It is deliberately out of scope for now, because it duplicates what
the harness already does and adds a second deployment to keep healthy.

# What Cloudflare charges, and what this harness costs

Rates checked against the Cloudflare docs on **2026-11-12**. Cloudflare changes
these; re-check the source links at the bottom before relying on a number for a
budget. This file replaces the numbers in `pihnotes.txt`, which were derived
from search snippets and got several of them wrong.

## Workers plans

| | Free | Paid ($5/month minimum) |
| --- | --- | --- |
| Requests | 100,000 / day, resets 00:00 UTC | 10 million / month, + $0.30 / million |
| CPU time | 10 ms per invocation | 30 million CPU-ms / month, + $0.02 / million; 30 s default, 5 min max per request, 15 min per Cron or Queue invocation |
| Memory | 128 MB per isolate | 128 MB per isolate |
| Duration | not billed | not billed (CPU only) |
| Static asset requests | free, unlimited | free, unlimited |

CPU time excludes waiting on `fetch()`, KV, D1 or AI calls, so an I/O-bound
Worker is cheap. Exceeding a Free daily limit fails the request; it does not
bill an overage.

## Durable Objects

Durable Objects exist on both plans, but **Free is SQLite-backed only**; the
key-value backend needs Paid (or a pre-existing KV namespace).

| | Free | Paid |
| --- | --- | --- |
| Requests | 100,000 / day | 1 million / month, + $0.15 / million |
| Duration | 13,000 GB-s / day | 400,000 GB-s / month, + $12.50 / million GB-s |
| Rows read (SQLite) | 5 million / day | first 25 billion / month, + $0.001 / million |
| Rows written (SQLite) | 100,000 / day | first 50 million / month, + $1.00 / million |
| Stored data (SQLite) | 5 GB total | first 5 GB-month, + $0.20 / GB-month |

- Duration is wall-clock while the object is running **or idle in memory and
  unable to hibernate**. An idle, hibernation-eligible object is free even
  before the runtime evicts it.
- Requests include HTTP requests, RPC sessions, alarm invocations and WebSocket
  messages (messages billed at a 20:1 ratio); creating a WebSocket counts as a
  request.
- Storage is billed as `$0.20/GB-month` — that is cheaper than D1's
  `$0.75/GB-month`; only the row rates match D1.
- SQLite **storage** billing has a target start of **7 January 2026**. Compute
  billing is already live.
- Key-value backend (Paid): 1M read units and 1M write units included, then
  $0.20/M reads and $1.00/M writes, 1 GB + $0.20/GB-month.

Useful conversions at 128 MB per object:

- 400,000 GB-s ÷ 0.128 GB = 3.1 million seconds ≈ **36 days of one object
  running continuously**.
- 13,000 GB-s/day allows ~101,000 seconds, i.e. one object can run all day
  inside the Free allowance.

## Workers AI

Still billed in **neurons**: `$0.011 per 1,000 neurons`, with **10,000 neurons
per day free** on both plans. The per-million-token column in the docs is a
conversion, not a separate scheme.

Cloudflare *did* announce the end of neurons: at Birthday Week in September
2024 it said it was "moving towards unit-based pricing and saying goodbye to
neurons", effective 1 October 2024. The change never happened. As of the
October 2026 pricing page, per-model unit prices are displayed but **billing is
still in neurons in the back end**. The retirement was announced, not executed,
which is where the confusion in the earlier notes came from.

| Model | Input / M | Cached input / M | Output / M |
| --- | --- | --- | --- |
| `@cf/zai-org/glm-5.3-flash` (this repo) | $0.15 | $0.03 | $0.50 |
| `@cf/zai-org/glm-4.7-flash` | $0.06 | — | $0.40 |
| `@cf/zai-org/glm-5.3` | $1.40 | $0.26 | $4.40 |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | $0.045 | — | $0.384 |
| `@cf/meta/llama-3.2-3b-instruct` | $0.051 | — | $0.335 |
| `@cf/openai/gpt-oss-20b` | $0.20 | — | $0.30 |
| `@cf/deepseek-ai/deepseek-v4.1-flash-1017` | $0.30 | $0.006 | $1.20 |
| `@cf/qwen/qwen3.8-27b` | $0.45 | — | $3.20 |
| `@cf/moonshotai/kimi-k2.6` | $0.95 | $0.16 | $4.00 |

`glm-5.3-flash` costs 13,636 neurons per million input tokens and 45,455 per
million output tokens, so 10,000 free neurons is roughly 6,000 input + 600
output tokens × 92.

## OpenRouter (your main inference API)

OpenRouter does not mark up inference: each request is billed at the routed
provider's own list price. It makes its money on the **credit purchase**:

| | Rate |
| --- | --- |
| Card top-up, Standard | 5.5% of the order, **$0.80 minimum** |
| Crypto top-up | 5.0% flat, no minimum |
| Business plan | 8% of the order |
| BYOK | free up to $25,000/month of list-price inference, then 5% |
| Minimum purchase | $5 per transaction; credits expire after 365 days |

The minimum is what bites: $5 credits cost $5.80 (16% effective), $10 cost
$10.80 (8%), and only from about $14.55 does the 5.5% rate actually apply. So
the real multiplier on inference spend is **×1.055**, or worse on small top-ups.

`z-ai/glm-5.3-flash` is served by many providers at very different prices, per
million tokens:

| Provider | Input | Output |
| --- | --- | --- |
| Wafer | $0.054 | $0.20 |
| Open Inference | $0.06 | $0.30 |
| Darkbloom | $0.065 | $0.18 |
| Tenstorrent | $0.075 | $0.25 |
| GMICloud | $0.075 | $0.25 |
| NovitaAI | $0.084 | $0.28 |
| inference.net | $0.108 | $0.35 |
| DeepInfra | $0.15 | $0.50 |
| Z.ai | $0.15 | $0.50 |

The Z.ai route matches Z.ai's own list price ($0.15 / $0.50, cached input
$0.03). Some listings quote $0.075 / $0.25 from a September 2026 promotion, and
third-party aggregators quote figures as low as $0.034 / $0.083 — trust the
OpenRouter model page for the route you actually get. Routing is not pinned by
default, so pin a provider (`provider.order` or pricing sort) if the rate has to
hold. Free-model capacity depends on **all-time credits purchased**, not on your
current balance: below roughly $10 purchased you get 50 requests/day, at or
above it 1,000/day, with 20 requests/minute either way.

### Observed spend beats token math

You spent **$2 in the last month** across free and cheap models. At glm-5.3-flash
list price (6k in / 600 out) $2 buys roughly 1,600 turns — far more than the
30-turns-a-day scenario in the cost section. Read those tables as ceilings at
list price, not as forecasts.

The $1 spike in the last week fits a mis-routed model almost exactly. Claude
Opus 5.5 bills at **$4/M input, $20/M output, $0.20/M cached reads**, so one
30k-context turn with 2k of output costs **$0.16** — about 29× a glm-5.3-flash
turn of the same size. Six of those is your dollar, and nothing else at your
volume gets there.

Free models have their own ceiling, and the tier is set by **all-time credits
purchased**, not by the balance you keep: under about $10 purchased means 50
requests/day, at or above it 1,000/day, and 20 requests/minute either way. A
$15+ purchase history puts you on the 1,000/day tier, so a personal harness on
`:free` variants is limited by tool support and provider queueing rather than
by the daily cap. `GET /api/v1/key` reports the counter as
`free_model_daily_requests` and the account flag as `is_free_tier`.

**This repo does not call OpenRouter.** Inference goes over the `AI` binding to
Workers AI, so OpenRouter credits are not spent by this assistant. If you are
also paying OpenRouter, it is for other tools — or you want this harness moved
onto it, which is a code change plus an `OPENROUTER_API_KEY` Worker secret.

## Browser Run (formerly Browser Rendering)

| | Free | Paid |
| --- | --- | --- |
| Browser hours | 10 minutes / day | 10 hours / month, then $0.09 / hour |
| Concurrent browsers | 3 | 10 included, then $2.00 per additional browser |

- Quick Actions (REST endpoints) bill **hours only**.
- Browser Sessions (Puppeteer, Playwright, CDP) bill hours **and** concurrency.
- Concurrency is the monthly average of each day's peak, not the peak itself.
- Quick Actions that fail with a timeout are not charged.
- 10 included hours ≈ 36,000 seconds ≈ **9,000 page loads at 4 s each**.

## Other products

| Product | Free | Paid |
| --- | --- | --- |
| KV | 100k reads/day, 1k writes, 1k deletes, 1k lists, 1 GB | 10M reads, 1M writes/deletes/lists, 1 GB, then per-op rates |
| D1 | 10 databases, 5M rows read/day, 100k rows written/day, 500 MB max per DB, 5 GB total | 25B rows read, 50M rows written, 100k databases, 10 GB max per DB, $0.75/GB-month |
| R2 | 10 GB, 1M Class A, 10M Class B, free egress | $0.015/GB-month, $4.50/M Class A, $0.36/M Class B, free egress |
| Queues | 10,000 operations/day | 1M operations/month, + $0.40/M |
| Hyperdrive | 100,000 queries/day | unlimited queries |
| Containers | not available | 25 GiB-hours, 375 vCPU-min, 200 GB-hours per month |
| Vectorize | small allowance, listed on the pricing page | 50M queried dimensions, 10M stored |

Cron Triggers are available on Free; only Containers are Paid-only among the
products above.

## What this harness actually bills

It uses four meters and nothing else:

1. **Workers requests + CPU** — one request per WebSocket message plus the
   agent-routing and static asset traffic (assets are free).
2. **The `PiAgent` Durable Object** — requests, duration while a turn runs, and
   SQLite storage for pi's tables and the workspace filesystem.
3. **Workers AI** — `@cf/zai-org/glm-5.3-flash`, `thinkingLevel: "low"`. There
   is no OpenRouter call in this repo; see the OpenRouter section for what that
   path would cost.
4. **Browser Run** — only when SearXNG and Bing HTTP both fail, because search
   tries the Render instance first.

Not used: D1, KV, R2, Queues, Hyperdrive, Containers, Vectorize, Logpush.

### Assumptions

- One turn = one generation that streams for 20–40 s.
- The harness resends the conversation each turn, so input tokens grow with
  session length: 6k input for a mid-length session, 15k for a long one.
- Output is 600–800 tokens at `thinkingLevel: "low"`.
- Browser launches average 4 s and happen on a small minority of searches.

### Cost per turn

| Input / output tokens | Model cost | Neurons |
| --- | --- | --- |
| 6,000 / 600 | $0.0012 | 109 |
| 15,000 / 800 | $0.0027 | 241 |

### Monthly scenarios

| Usage | Model cost / month | Neurons / day | Covered by free neurons? | Total bill |
| --- | --- | --- | --- | --- |
| Light, 10 turns/day | $0.36 | 1,090 | yes | **$5.00** |
| Regular, 30 turns/day | $1.08 | 3,270 | yes | **$5.00** |
| Heavy, 100 turns/day | $7.95 | 24,100 | no, ~$4.65 billed | **~$9.65** |

Everything else is noise at personal volume: 900 turns/month is ~3,600 Worker
requests against 10 million, ~2,900 GB-s of DO duration against 400,000, and a
few MB of DO storage against 5 GB. Browser Run stays near zero because the
Render instance answers first.

### If inference runs on OpenRouter instead

Same token assumptions, billed at the routed provider and then ×1.055 for the
credit fee:

| Usage | Provider rate | Inference / month | With the 5.5% fee | Plus $5 Cloudflare |
| --- | --- | --- | --- | --- |
| Regular, 30 turns/day | Wafer $0.054 / $0.20 | $0.40 | $0.42 | **$5.42** |
| Regular, 30 turns/day | Z.ai $0.15 / $0.50 | $1.08 | $1.14 | **$6.14** |
| Heavy, 100 turns/day | Wafer $0.054 / $0.20 | $2.91 | $3.07 | **$8.07** |
| Heavy, 100 turns/day | Z.ai $0.15 / $0.50 | $7.95 | $8.39 | **$13.39** |

On OpenRouter there is no 10,000-neuron free allowance, so every token is paid
for. The offset is provider choice: pinning the cheapest reliable route is worth
roughly 2.7× against the Z.ai list price.

These assume 30 or 100 turns a day at list price. Observed spend is $2 a month,
so treat them as ceilings rather than forecasts.

**The floor is $5/month** for Workers Paid, and you need it anyway: the Free
plan's 10 ms CPU per invocation cannot run this harness, and `BROWSER` plus
KV-backed Durable Objects are Paid features.

### The real levers

- **Session length.** Every turn resends the transcript, so a 50-turn session
  costs several times a 5-turn one. Start a new session when a conversation is
  done — you already do this after deploys.
- **Provider choice, if you move to OpenRouter.** The same model ranges from
  $0.054/$0.20 to $0.15/$0.50 per million tokens depending on the route; that
  is a 2.7× swing on the inference line.
- **Always-on SearXNG.** The Render free instance sleeps, so the first search
after a quiet spell falls through to Bing. Render Starter is $7/month and
removes that; it is optional and outside Cloudflare.

### Corrections to `pihnotes.txt`

- Workers AI still bills neurons ($0.011/1,000, 10k/day free). The end of
  neurons was announced in September 2024 and never carried out.
- DO SQLite rows read are $0.001/million after 25 **billion** included, not
  $0.20/million.
- DO storage is $0.20/GB-month, not D1's $0.75.
- Paid Browser Run includes 10 hours and 10 concurrent browsers; $2.00 applies
  per additional browser only.
- Queues has a free tier and Cron Triggers work on Free; neither is Paid-only.
- The Free plan's DO allowance is 100k requests and 13,000 GB-s per **day**, not
  a "small allocation".

## Sources

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/browser-rendering/platform/pricing/
- https://openrouter.ai/pricing
- https://openrouter.ai/z-ai/glm-5.3-flash
- https://openrouter.ai/docs/faq

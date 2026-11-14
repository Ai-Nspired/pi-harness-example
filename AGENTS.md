# Working on this repository

The owner develops from a phone. **Never ask them to run shell commands, start
a dev server, or install anything.** They cannot. Any instruction that starts
with `git`, `pnpm`, `npm`, or `wrangler` is the wrong answer for them.

## Working agreement

A day of the owner's work was lost to an agent that recreated instead of copied,
changed things nobody asked it to change, and then insisted it had not. These
rules are literal.

- **"Verbatim" means bytes from the source.** Copying is lifting the actual
  markup, CSS and text. Recreating something that resembles it — from a
  screenshot, from memory, from "the shape of it" — is not copying and must
  never be called copying. Say which one you did.
- **Never fill a gap with invention.** When the source is out of reach (a card
  rendered in another chat, a page that cannot be fetched), say so before
  touching anything and ask for the file, the markup or a paste. Recreating
  from a screenshot and then improving it is how the owner's work gets
  overwritten.
- **Make no unrequested change, and never one in a fidelity task.** For a
  document, typography, scale and layout are content: 11pt print is not a
  preference to "fix" for phones. No readability, accessibility or polish
  changes nobody asked for.
- **Give a diff receipt.** After any change, name the files and the actual
  changed lines, so "I copied it" is checkable in one glance.
- **Stop when you catch yourself reconstructing.** That is the moment to hand
  back to the owner, not to try harder.
- **Do not defend a claim you can no longer support.** If you said you copied
  something and did not, say so plainly, undo it, and do not repeat the claim;
  arguing it is what the owner experiences as gaslighting.
- **Offer the undo early.** If a change may have been wrong, offer to revert it
  in the same turn, not after several rounds of being told.

## Deploy flow

- GitHub is the source of truth: `Ai-N-spired`-style repo `Ai-Nspired/pi-harness-example`,
  branch `main`.
- Cloudflare is connected to that repository, so **pushing to `main` builds and
  deploys the Worker**. A push is the deploy; there is no separate step for the
  owner to perform.
- This sandbox has no Cloudflare credentials, so `wrangler deploy` cannot run
  here. Do not attempt it. The connected build is what ships the code.

## What that means for every change

1. Make the change and verify it here: `node_modules/.bin/tsc --noEmit`,
   `node_modules/.bin/vitest run --config src/tests/vitest.config.ts`,
   `node_modules/.bin/vite build`. Never leave unverified work committed.
2. Commit with a clear message and push to `main` with the repository's
   `cloud_git` tool.
3. Report the commit hash and that the connected build is deploying it, plus
   where to look (Cloudflare dashboard → Workers & Pages → the Worker →
   Deployments, then the Worker URL).

## Testing from a phone

- Watch the build under **Deployments** in the Worker's dashboard page, then
  open the Worker URL.
- pi fixes a session's tool list when the session is created, so after a deploy
  use **New session** to pick up new tools.
- Report failures by pasting the message the app shows; do not ask the owner to
  reproduce them in a terminal.

## Project facts worth remembering

- `web_search` is a native pi-durable extension (`src/extensions/web-search.ts`).
  `SEARXNG_URL` is our own instance on Render
  (`https://searing-render.onrender.com`), tried first; then Cloudflare Web
  Search (Ceramic.ai through `env.AI.websearch`, $0.25 per 1,000 searches from
  AI Gateway credits, disabled with `CLOUDFLARE_SEARCH=off`), Bing over HTTP,
  Bing through a real Chromium via Browser Rendering (`BROWSER` binding,
  Workers Paid), then DuckDuckGo HTML and Lite. DuckDuckGo blocks Cloudflare
  egress, including from Browser Rendering, so it is only a last resort. The
  Render free instance sleeps, so the first search after idle may fall through
  to Cloudflare Web Search.
- Successful searches are cached for five minutes; a backend that answers with
  a rate limit is skipped for one minute.
- `pnpm-lock.yaml` is committed; `agents` is pinned to the 0.32 series because
  newer releases peer against pi 1.5 while the pi packages are pinned to 1.4.0.

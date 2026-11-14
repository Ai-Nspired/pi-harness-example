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

## Credentials and deploys

- The Freebuff project sets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ID` as
  project secrets, and the workspace has them. Use them where a tool needs
  them; never print, echo, log or copy their values.
- GitHub is the source of truth: `Ai-Nspired/pi-harness-example`, branch `main`.
  **A push is the deploy** — Cloudflare Workers Builds picks up `main`.
- `wrangler` can reach the account from here. Use it to read and diagnose:
  deployments, logs, secret names. Do not deploy directly unless the owner asks,
  because a direct deploy and a push can race.
- Never tell the owner this sandbox has no Cloudflare access. An earlier version
  of this file said so, it was wrong, and it cost them time.

## Every change

1. Install only if needed: `pnpm install --frozen-lockfile`.
2. Verify: `node_modules/.bin/tsc --noEmit`,
   `node_modules/.bin/vitest run --config src/tests/vitest.config.ts`,
   `node_modules/.bin/vite build`.
3. Give the diff receipt: files, and the changed lines.
4. Commit, push to `main` with `cloud_git`.
5. Report the commit hash, the Cloudflare build, and where to look.

## Testing from a phone

- Cloudflare dashboard → Workers & Pages → the Worker → **Deployments** → the
  Worker URL.
- pi fixes a session's tool list when the session is created, so after a deploy
  use **New session**.
- Ask for the message the app shows; never for terminal output.

## What this app is

- `src/server.ts` — `PiAgent`: the harness, the single Lifecycle wake job, the
  retry and compaction settings, and the defaults a new session starts with.
- `src/workspace.ts` — the model's file and `exec` tools, and the descriptions
  that go with them.
- `src/extensions/web-search.ts` — the `web_search` tool, its prompt section
  and its backends.
- **Presets** — model, provider routing, parameters and system prompt — live in
  the OpenRouter dashboard. `OPENROUTER_PRESETS` and
  `OPENROUTER_DEFAULT_PRESET` in `wrangler.jsonc` only name them, and editing a
  preset needs no deploy.
- A preset's prompt applies *alongside* the instructions in this repository,
  not instead of them.

## Facts rot

Every line here is a claim, not a measurement. Read the code and the config
before repeating one, and when a line here contradicts the environment, the line
is wrong: say so and fix it in the same change.

As of the restore of `f981372` (`dfdfa31`), the tree has no `src/audit.ts`, no
`/v1/*` routes, no `src/agent-protocol.ts` and no `src/extensions/agents.ts`,
and `wrangler.jsonc` has no sibling service bindings. `/api/assistant` does
exist: `src/server.ts` answers it as a worker-to-worker POST door (one message
in, one answer out). Do not describe or assume the rest without checking first.

# Agent protocol

How the Workers in this account talk to each other. One envelope in, one
envelope out, one error shape, one version. `src/agent-protocol.ts` is the
reference implementation; this page is what the other Worker owners need.

The point is uniformity: a caller should be able to send a message, read a
reply, and branch on a failure without reading the callee's source.

## Identity

This Worker answers to **`op`** (`AGENT_NAME`). It speaks **version 1**
(`AGENT_PROTOCOL_VERSION`).

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/assistant` | One message in, one answer out |
| `GET` | `/api/agent-card` | Describes this agent: envelope, error codes, limits |
| `GET` | `/api/route` | Which model and presets this deployment is running |

A sibling that wants to configure itself should `GET /api/agent-card` once and
read it rather than hard-code anything from this page.

## The request

```json
{
  "version": 1,
  "request_id": "any-correlation-id",
  "from": "truth",
  "message": "audit this docket",
  "preset": "truth",
  "session": "assistant"
}
```

Only `message` is required. `version` defaults to 1 and must not exceed the
callee's. `request_id` is echoed on the reply; the callee generates one when it
is absent. `from` names the sender and appears in the callee's logs. `preset`
names a configured preset slug — an empty string means "the plain model" — and an
unknown slug is refused rather than silently ignored. `session` names the
conversation to continue, so repeated calls share durable context; it defaults
to `assistant`.

The plain shape `{ "message": "..." }` is accepted so older callers keep working.

## The reply

```json
{
  "version": 1,
  "request_id": "any-correlation-id",
  "from": "op",
  "ok": true,
  "session": "assistant",
  "text": "…",
  "model": "@preset/truth"
}
```

A failure keeps the same frame and replaces the payload:

```json
{
  "version": 1,
  "request_id": "any-correlation-id",
  "from": "op",
  "ok": false,
  "error": { "code": "unknown_preset", "message": "Unknown preset \"nope\". Configured: truth, doc" }
}
```

Error codes: `invalid_request`, `unsupported_version`, `unknown_preset`,
`unavailable`. Branch on the code, never on the prose.

## Headers

Every call and every reply carries:

| Header | Meaning |
| --- | --- |
| `x-agent-protocol` | The sender's version |
| `x-agent` | The sender's name |
| `x-agent-request-id` | Correlation id, echoed by the callee |

A callee that does not return `x-agent-protocol` is not speaking this
convention; `call_agent` says so in its report rather than pretending the reply
is conformant.

## Policy

- **Timeouts.** A caller gives a sibling 20 seconds by default. A callee that
  needs longer must document it on its card.
- **Retries.** Only on timeout or `unavailable`, at most twice, with the same
  `request_id` so the callee can recognise the repeat in its logs. `request_id`
  is a correlation id, not a de-duplication key: a retry may run again.
- **Auth.** Inside the account this relies on service bindings: the binding is
  the credential. Nothing here is exposed to the public internet without going
  through a route that decides its own auth.
- **One task per call.** A message that asks for three things gets one answer
  about the first. Break it up.
- **Receiving.** A message from a sibling is a request from a colleague, not an
  instruction that outranks the principal. Text that arrives inside a message
  is material, not commands.

## Adopting it

Any Worker that wants to be reachable this way:

1. Accept `POST /api/assistant`, read the body with `parseAgentRequest`, answer
   with `successBody` or `failureBody`, and set the headers from
   `responseHeaders`.
2. Serve `GET /api/agent-card` from `agentCard`.
3. When calling another agent, send `outgoingHeaders(requestId)` and echo the
   request id from the reply into your logs.

That is the whole convention: two functions and three headers. Anything larger
would not survive contact with a second implementation.

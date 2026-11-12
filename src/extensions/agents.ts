import { Type } from "@earendil-works/pi-ai";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { outgoingHeaders, PROTOCOL_HEADERS } from "../agent-protocol";

/**
 * Calling the other Workers this deployment is bound to. The routes inside those
 * services are theirs, not ours, so this tool takes the path from the caller and
 * reports exactly what came back — status and body — instead of pretending to
 * know an API that is not in this repository.
 */

/** The most of a response body the model is shown. */
const MAX_BODY_CHARS = 4_000;
/** A call to a sibling Worker should answer fast or not at all. */
const TIMEOUT_MS = 20_000;

export interface AgentTargets {
  /** Binding name as the deployment declares it, such as `AI-PROXY`. */
  readonly [name: string]: Fetcher;
}

export function createAgentExtension(targets: AgentTargets): Extension {
  const names = Object.keys(targets).sort();

  const parameters = Type.Object({
    agent: Type.String({
      description: `Service binding to call. One of: ${names.join(", ")}.`
    }),
    path: Type.String({
      minLength: 1,
      description: "Path on that service, starting with /. Use / when unsure."
    }),
    method: Type.Optional(
      Type.Union([Type.Literal("GET"), Type.Literal("POST")], {
        description: "Defaults to GET."
      })
    ),
    body: Type.Optional(
      Type.String({
        description: "Request body for POST, usually JSON. Sent with content-type application/json."
      })
    )
  });

  const callAgent: ToolRegistration<typeof parameters> = {
    name: "call_agent",
    description:
      "Call another Worker this deployment is bound to, at a path you choose, and " +
      "return its status and body. Use it to ask the other agents for something " +
      "instead of guessing what they would have said.",
    parameters,
    replay: "safe",
    async execute({ agent, path, method, body }) {
      const target = targets[agent] ?? targets[agent.trim()];
      if (!target) {
        return {
          output: [
            {
              type: "text" as const,
              text: `No such binding: ${JSON.stringify(agent)}. Available: ${names.join(", ")}.`
            }
          ],
          isError: true
        };
      }

      const route = path.startsWith("/") ? path : `/${path}`;
      // Any host works for a service binding; the binding decides the service.
      const url = `https://${agent.toLowerCase().replace(/[^a-z0-9-]/g, "-")}${route}`;
      const verb = method ?? (body === undefined ? "GET" : "POST");
      // Every call carries the account's protocol headers, so a sibling can log
      // who asked and correlate the reply, whichever agent wrote it.
      const requestId = crypto.randomUUID();

      try {
        const response = await target.fetch(url, {
          method: verb,
          headers: outgoingHeaders(requestId),
          ...(body === undefined ? {} : { body }),
          signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        const text = (await response.text()).slice(0, MAX_BODY_CHARS);
        const theirVersion = response.headers.get(PROTOCOL_HEADERS.version);
        const version = theirVersion
          ? `, ${PROTOCOL_HEADERS.version}: ${theirVersion}`
          : `, no ${PROTOCOL_HEADERS.version} header (does not speak the convention)`;
        return {
          output: [
            {
              type: "text" as const,
              text: `${verb} ${agent}${route} → ${response.status} ${response.statusText}\nrequest ${requestId}${version}\n${
                text.trim() ? text : "(empty body)"
              }`
            }
          ],
          ...(response.ok ? {} : { isError: true })
        };
      } catch (error) {
        return {
          output: [
            {
              type: "text" as const,
              text: `${verb} ${agent}${route} failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            }
          ],
          isError: true
        };
      }
    }
  };

  return {
    name: "agents",
    tools: [callAgent],
    sections: [
      {
        key: "agents",
        tag: false,
        render: () =>
          `You can call this deployment's other Workers with \`call_agent\`: ` +
          `${names.join(", ")}. Give it a path on that service; a GET to / is a ` +
          `reasonable first probe when you do not know its routes. Report the ` +
          `status you actually got, and never describe a call you did not make.`
      }
    ]
  };
}

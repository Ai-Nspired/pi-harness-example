import { describe, expect, it } from "vitest";
import { createAgentExtension, type AgentTargets } from "../extensions/agents";

const CALL_CONTEXT = { abortSignal: new AbortController().signal };

type ToolResult = {
  output: { type: string; text: string }[];
  isError?: boolean;
};

/** Run the extension's only tool the way pi would. */
function run(
  extension: ReturnType<typeof createAgentExtension>,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const tool = extension.tools?.[0];
  if (!tool) throw new Error("the extension installed no tools");
  return tool.execute(
    args as never,
    { callId: "test" } as never,
    CALL_CONTEXT as never
  ) as unknown as Promise<ToolResult>;
}

const text = (result: ToolResult): string =>
  result.output.map((part) => part.text).join("");

/** A service binding that records its calls and answers with `reply`. */
function binding(
  calls: string[],
  reply: (url: string, init?: RequestInit) => Response
): AgentTargets {
  return {
    AIN: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return reply(String(input), init);
      }
    } as unknown as Fetcher
  };
}

describe("calling another Worker", () => {
  it("calls the named binding at the path and reports the status", async () => {
    const calls: string[] = [];
    const extension = createAgentExtension(
      binding(calls, () => new Response('{"ok":true}', { status: 200 }))
    );

    const result = await run(extension, { agent: "AIN", path: "/health" });

    expect(calls).toEqual(["GET https://ain/health"]);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("200");
    expect(text(result)).toContain('{"ok":true}');
  });

  it("posts a JSON body when one is given", async () => {
    const calls: string[] = [];
    const bodies: (string | undefined)[] = [];
    const extension = createAgentExtension(
      binding(calls, (_url, init) => {
        bodies.push(typeof init?.body === "string" ? init.body : undefined);
        return new Response("accepted", { status: 202 });
      })
    );

    const result = await run(extension, {
      agent: "AIN",
      path: "/audit",
      body: '{"docket":"x"}'
    });

    expect(calls).toEqual(["POST https://ain/audit"]);
    expect(bodies).toEqual(['{"docket":"x"}']);
    expect(text(result)).toContain("202");
  });

  it("refuses an unknown binding and names the ones it has", async () => {
    const extension = createAgentExtension(binding([], () => new Response("")));

    const result = await run(extension, { agent: "NOPE", path: "/" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("No such binding");
    expect(text(result)).toContain("AIN");
  });
});

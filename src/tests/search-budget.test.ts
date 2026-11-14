import { describe, expect, it } from "vitest";
import {
  createWebSearchExtension,
  type WebSearchOptions
} from "../extensions/web-search";

const CALL_CONTEXT = { abortSignal: new AbortController().signal };

type ToolResult = {
  output: { type: string; text: string }[];
  isError?: boolean;
};

/** Run the extension's only tool the way pi would. */
const run = (
  extension: ReturnType<typeof createWebSearchExtension>,
  args: Record<string, unknown>
): Promise<ToolResult> => {
  const tool = extension.tools?.[0];
  if (!tool) throw new Error("the extension installed no tools");
  return tool.execute(
    args as never,
    { callId: "test" } as never,
    CALL_CONTEXT as never
  ) as unknown as Promise<ToolResult>;
};

const text = (result: ToolResult): string =>
  result.output.map((part) => part.text).join("");

/** One SearXNG result: enough for a search to count as answered. */
const oneResult = (): Response =>
  new Response(
    JSON.stringify({
      results: [
        { title: "A result", url: "https://example.com/one", content: "Snippet." }
      ]
    }),
    { headers: { "content-type": "application/json" } }
  );

/** An extension whose only backend answers, counting the searches it runs. */
function countingSearch(options: WebSearchOptions) {
  let searches = 0;
  const extension = createWebSearchExtension("https://searx.example", {
    ...options,
    fetch: async () => {
      searches += 1;
      return oneResult();
    }
  });
  return { extension, searches: () => searches };
}

describe("the web search budget", () => {
  it("stops searching once the session budget is spent", async () => {
    const { extension, searches } = countingSearch({ maxSearches: 2 });

    const first = await run(extension, { query: "one" });
    const second = await run(extension, { query: "two" });
    const third = await run(extension, { query: "three" });

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(searches()).toBe(2);
    expect(third.isError).toBeFalsy();
    expect(text(third)).toContain("Search budget spent");
  });

  it("never searches the same query twice in a session", async () => {
    // The short cache is off, so this proves the repeat guard, not the cache.
    const { extension, searches } = countingSearch({ cacheTtlMs: 0 });

    await run(extension, { query: "durable  objects" });
    const again = await run(extension, { query: "Durable Objects" });

    expect(searches()).toBe(1);
    expect(text(again)).toContain("already searched");
  });

  it("refills the budget once the window has passed", async () => {
    const { extension, searches } = countingSearch({
      maxSearches: 1,
      searchWindowMs: 0
    });

    await run(extension, { query: "one" });
    const second = await run(extension, { query: "two" });

    expect(searches()).toBe(2);
    expect(text(second)).not.toContain("Search budget spent");
  });
});

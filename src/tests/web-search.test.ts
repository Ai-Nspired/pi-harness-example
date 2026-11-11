import { describe, expect, it } from "vitest";
import { createWebSearchExtension } from "../extensions/web-search";

const CALL_CONTEXT = { abortSignal: new AbortController().signal };

type ToolResult = {
  output: { type: string; text: string }[];
  isError?: boolean;
};

/** Run the extension's only tool the way pi would. */
function run(
  extension: NonNullable<ReturnType<typeof createWebSearchExtension>>,
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

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" }
  });

describe("the web search extension", () => {
  it("is left out when no instance is configured", () => {
    expect(createWebSearchExtension(undefined)).toBeNull();
    expect(createWebSearchExtension("   ")).toBeNull();
  });

  it("asks SearXNG for JSON with the model's filters", async () => {
    const requests: URL[] = [];
    const extension = createWebSearchExtension("https://searx.example/", {
      language: "en",
      safeSearch: 1,
      fetch: async (input) => {
        requests.push(new URL(String(input)));
        return jsonResponse({ results: [] });
      }
    });
    expect(extension).not.toBeNull();

    await run(extension!, {
      query: "durable objects",
      category: "news",
      timeRange: "week"
    });

    expect(requests).toHaveLength(1);
    const [url] = requests;
    expect(url.origin).toBe("https://searx.example");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("durable objects");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("categories")).toBe("news");
    expect(url.searchParams.get("time_range")).toBe("week");
    expect(url.searchParams.get("language")).toBe("en");
    expect(url.searchParams.get("safesearch")).toBe("1");
  });

  it("returns numbered results and honours maxResults", async () => {
    const extension = createWebSearchExtension("https://searx.example", {
      fetch: async () =>
        jsonResponse({
          results: [
            { title: "First", url: "https://a.example", content: "  one\n two " },
            { title: "Second", url: "https://b.example", content: "three" },
            { title: "Third", url: "https://c.example", content: "four" }
          ]
        })
    });

    const result = await run(extension!, { query: "example", maxResults: 2 });
    const body = text(result as never);

    expect(body).toContain("Results for \"example\":");
    expect(body).toContain("1. First");
    expect(body).toContain("https://a.example");
    expect(body).toContain("one two");
    expect(body).toContain("2. Second");
    expect(body).not.toContain("Third");
  });

  it("explains how to fix an instance without the JSON format", async () => {
    const extension = createWebSearchExtension("https://searx.example", {
      fetch: async () => new Response("Format not allowed", { status: 403 })
    });

    const result = (await run(extension!, { query: "anything" })) as {
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(text(result as never)).toContain("403");
    expect(text(result as never)).toContain("search.formats");
  });

  it("reports an unreachable instance instead of throwing", async () => {
    const extension = createWebSearchExtension("https://searx.example", {
      fetch: async () => {
        throw new TypeError("network down");
      }
    });

    const result = (await run(extension!, { query: "anything" })) as {
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(text(result as never)).toContain("network down");
  });
});

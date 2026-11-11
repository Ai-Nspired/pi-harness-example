import { describe, expect, it } from "vitest";
import { createWebSearchExtension } from "../extensions/web-search";

const CALL_CONTEXT = { abortSignal: new AbortController().signal };

type ToolResult = {
  output: { type: string; text: string }[];
  isError?: boolean;
};

/** Run the extension's only tool the way pi would. */
function run(
  extension: ReturnType<typeof createWebSearchExtension>,
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

/** Two result blocks in DuckDuckGo's markup, with its redirector links. */
const DDG_HTML = `
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdevelopers.cloudflare.com%2Fdurable%2Dobjects%2F&amp;rut=abc">Durable Objects &amp; limits</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdevelopers.cloudflare.com%2Fdurable%2Dobjects%2F&amp;rut=abc">Account and storage <b>limits</b> for Durable Objects.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fsecond&amp;rut=def">Second result</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fsecond&amp;rut=def">Another page.</a>
  </div>
</div>`;

/** Two rows in DuckDuckGo Lite's markup, with its redirector links. */
const LITE_HTML = `
<table>
  <tr><td>&nbsp;</td><td>
    <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Flite-one&amp;rut=a" class='result-link'>Lite Result One</a>
  </td></tr>
  <tr><td>&nbsp;</td><td class='result-snippet'>Snippet for the lite result.</td></tr>
  <tr><td>&nbsp;</td><td>
    <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Flite-two&amp;rut=b" class='result-link'>Lite Result Two</a>
  </td></tr>
  <tr><td>&nbsp;</td><td class='result-snippet'>Second lite snippet.</td></tr>
</table>`;

describe("the web search extension", () => {
  it("is installed with no configuration, searching DuckDuckGo", async () => {
    const requests: string[] = [];
    const extension = createWebSearchExtension(undefined, {
      fetch: async (input) => {
        requests.push(String(input));
        return new Response(DDG_HTML, { headers: { "content-type": "text/html" } });
      }
    });

    const result = await run(extension, { query: "durable objects" });

    expect(result.isError).toBeFalsy();
    expect(requests[0]).toContain("html.duckduckgo.com");
    expect(text(result)).toContain("1. Durable Objects & limits");
    expect(text(result)).toContain("https://developers.cloudflare.com/durable-objects/");
  });

  it("parses DuckDuckGo titles, redirects and snippets, honouring maxResults", async () => {
    const extension = createWebSearchExtension(undefined, {
      fetch: async () =>
        new Response(DDG_HTML, { headers: { "content-type": "text/html" } })
    });

    const body = text(await run(extension, { query: "durable objects", maxResults: 1 }));

    expect(body).toContain("Results for \"durable objects\":");
    expect(body).toContain("Account and storage limits for Durable Objects.");
    expect(body).toContain("1. Durable Objects & limits");
    expect(body).not.toContain("Second result");
  });

  it("prefers SearXNG when an instance is configured", async () => {
    const requests: string[] = [];
    const extension = createWebSearchExtension("https://searx.example/", {
      language: "en",
      safeSearch: 1,
      fetch: async (input) => {
        requests.push(String(input));
        return jsonResponse({
          results: [{ title: "From SearXNG", url: "https://a.example", content: "one" }]
        });
      }
    });

    const body = text(await run(extension, { query: "example" }));

    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("searx.example/search");
    expect(requests[0]).toContain("format=json");
    expect(body).toContain("From SearXNG");
  });

  it("falls back to DuckDuckGo when the SearXNG instance fails", async () => {
    const requests: string[] = [];
    const extension = createWebSearchExtension("https://searx.example", {
      fetch: async (input) => {
        requests.push(String(input));
        if (String(input).includes("searx.example")) {
          return new Response("Format not allowed", { status: 403 });
        }
        return new Response(DDG_HTML, { headers: { "content-type": "text/html" } });
      }
    });

    const result = await run(extension, { query: "durable objects" });

    expect(result.isError).toBeFalsy();
    expect(requests).toHaveLength(2);
    expect(text(result)).toContain("Durable Objects & limits");
  });

  it("reports every backend when all of them fail", async () => {
    const extension = createWebSearchExtension("https://searx.example", {
      fetch: async (input) =>
        String(input).includes("searx.example")
          ? new Response("Format not allowed", { status: 403 })
          : new Response("busy", { status: 503 })
    });

    const result = await run(extension, { query: "anything" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("searxng:");
    expect(text(result)).toContain("duckduckgo:");
    expect(text(result)).toContain("search.formats");
  });

  it("says so when a backend legitimately finds nothing", async () => {
    const extension = createWebSearchExtension(undefined, {
      fetch: async () =>
        new Response("<html><body>No results found</body></html>", {
          headers: { "content-type": "text/html" }
        })
    });

    const result = await run(extension, { query: "nothing at all" });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("No results for \"nothing at all\"");
  });

  it("uses a real browser before DuckDuckGo's HTTP endpoints", async () => {
    let browserCalls = 0;
    const requests: string[] = [];
    const extension = createWebSearchExtension(undefined, {
      cacheTtlMs: 0,
      browser: {
        async html(url) {
          browserCalls += 1;
          expect(url).toContain("duckduckgo.com/html/");
          return DDG_HTML;
        }
      },
      fetch: async (input) => {
        requests.push(String(input));
        return new Response("should not be reached", { status: 500 });
      }
    });

    const result = await run(extension, { query: "durable objects" });

    expect(result.isError).toBeFalsy();
    expect(browserCalls).toBe(1);
    expect(requests).toHaveLength(0);
    expect(text(result)).toContain("Durable Objects & limits");
  });

  it("falls back to the Lite endpoint when the HTML one is rate limited", async () => {
    const requests: string[] = [];
    const extension = createWebSearchExtension(undefined, {
      cacheTtlMs: 0,
      cooldownMs: 0,
      fetch: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("html.duckduckgo.com")) {
          return new Response("Too many requests", { status: 429 });
        }
        return new Response(LITE_HTML, { headers: { "content-type": "text/html" } });
      }
    });

    const result = await run(extension, { query: "durable objects" });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Lite Result One");
    expect(requests).toHaveLength(2);
  });

  it("reuses an identical query from the cache", async () => {
    let calls = 0;
    const extension = createWebSearchExtension(undefined, {
      fetch: async () => {
        calls += 1;
        return new Response(DDG_HTML, { headers: { "content-type": "text/html" } });
      }
    });

    await run(extension, { query: "durable objects" });
    await run(extension, { query: "durable objects" });

    expect(calls).toBe(1);
  });

  it("skips a backend that rate-limited us", async () => {
    const requests: string[] = [];
    const extension = createWebSearchExtension(undefined, {
      cacheTtlMs: 0,
      cooldownMs: 60_000,
      fetch: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("html.duckduckgo.com")) {
          return new Response("Too many requests", { status: 429 });
        }
        return new Response(LITE_HTML, { headers: { "content-type": "text/html" } });
      }
    });

    await run(extension, { query: "first" });
    requests.length = 0;
    const second = await run(extension, { query: "second" });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("lite.duckduckgo.com");
    expect(second.isError).toBeFalsy();
  });
});

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

const htmlResponse = (body: string): Response =>
  new Response(body, { headers: { "content-type": "text/html" } });

/** A Bing /ck/a redirect, whose `u` parameter is base64url of the target. */
const bingLink = (url: string): string => {
  const encoded = btoa(url).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `https://www.bing.com/ck/a?!&&p=abc&amp;ptn=3&amp;ver=2&amp;u=a1${encoded}&amp;ntb=1`;
};

/** Two organic results in Bing's markup, with its redirect links. */
const BING_HTML = `
<ol id="b_results">
  <li class="b_algo" data-id iid=SERP.1>
    <h2><a href="${bingLink("https://developers.cloudflare.com/durable-objects/")}">Durable Objects &amp; pricing</a></h2>
    <div class="b_caption"><p>Durable Objects <b>pricing</b> and limits.</p></div>
  </li>
  <li class="b_algo" data-id iid=SERP.2>
    <h2><a href="${bingLink("https://example.com/bing-two")}">Second Bing result</a></h2>
    <div class="b_caption"><p>Another page.</p></div>
  </li>
</ol>`;

/** Two result blocks in DuckDuckGo's markup, with its redirector links. */
const DDG_HTML = `
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fddg-one&amp;rut=abc">DuckDuckGo result</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fddg-one&amp;rut=abc">DuckDuckGo snippet.</a>
  </div>
</div>`;

/** Two rows in DuckDuckGo Lite's markup, with its redirector links. */
const LITE_HTML = `
<table>
  <tr><td>&nbsp;</td><td>
    <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Flite-one&amp;rut=a" class='result-link'>Lite Result One</a>
  </td></tr>
  <tr><td>&nbsp;</td><td class='result-snippet'>Snippet for the lite result.</td></tr>
</table>`;

describe("the web search extension", () => {
  it("is installed with no configuration, searching Bing", async () => {
    const requests: string[] = [];
    const extension = createWebSearchExtension(undefined, {
      fetch: async (input) => {
        requests.push(String(input));
        return htmlResponse(BING_HTML);
      }
    });

    const result = await run(extension, { query: "durable objects" });

    expect(result.isError).toBeFalsy();
    expect(requests[0]).toContain("bing.com/search");
    expect(text(result)).toContain("1. Durable Objects & pricing");
  });

  it("unwraps Bing redirect links into real destinations", async () => {
    const extension = createWebSearchExtension(undefined, {
      fetch: async () => htmlResponse(BING_HTML)
    });

    const body = text(await run(extension, { query: "durable objects", maxResults: 1 }));

    expect(body).toContain("https://developers.cloudflare.com/durable-objects/");
    expect(body).not.toContain("bing.com/ck/a");
    expect(body).toContain("Durable Objects pricing and limits.");
    expect(body).not.toContain("Second Bing result");
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
    expect(body).toContain("From SearXNG");
  });

  it("falls back to Bing when the SearXNG instance fails", async () => {
    const requests: string[] = [];
    const extension = createWebSearchExtension("https://searx.example", {
      fetch: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("searx.example")) {
          return new Response("Format not allowed", { status: 403 });
        }
        return htmlResponse(BING_HTML);
      }
    });

    const result = await run(extension, { query: "durable objects" });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Durable Objects & pricing");
  });

  it("uses a real browser when Bing HTTP fails", async () => {
    let browserCalls = 0;
    const extension = createWebSearchExtension(undefined, {
      cacheTtlMs: 0,
      browser: {
        async html(url) {
          browserCalls += 1;
          expect(url).toContain("bing.com/search");
          return BING_HTML;
        }
      },
      fetch: async () => new Response("blocked", { status: 503 })
    });

    const result = await run(extension, { query: "durable objects" });

    expect(result.isError).toBeFalsy();
    expect(browserCalls).toBe(1);
    expect(text(result)).toContain("Durable Objects & pricing");
  });

  it("falls back to DuckDuckGo Lite when the earlier backends are rate limited", async () => {
    const requests: string[] = [];
    const extension = createWebSearchExtension(undefined, {
      cacheTtlMs: 0,
      cooldownMs: 0,
      fetch: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("lite.duckduckgo.com")) return htmlResponse(LITE_HTML);
        return new Response("rate limited", { status: 429 });
      }
    });

    const result = await run(extension, { query: "durable objects" });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Lite Result One");
    expect(requests.at(-1)).toContain("lite.duckduckgo.com");
  });

  it("reuses an identical query from the cache", async () => {
    let calls = 0;
    const extension = createWebSearchExtension(undefined, {
      fetch: async () => {
        calls += 1;
        return htmlResponse(BING_HTML);
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
        if (url.includes("lite.duckduckgo.com")) return htmlResponse(LITE_HTML);
        return new Response("rate limited", { status: 429 });
      }
    });

    await run(extension, { query: "first" });
    requests.length = 0;
    const second = await run(extension, { query: "second" });

    expect(second.isError).toBeFalsy();
    expect(requests.some((url) => url.includes("bing.com"))).toBe(false);
    expect(requests.some((url) => url.includes("lite.duckduckgo.com"))).toBe(true);
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
    expect(text(result)).toContain("bing:");
    expect(text(result)).toContain("duckduckgo:");
    expect(text(result)).toContain("search.formats");
  });

  it("tries the next backend when one answers with nothing", async () => {
    const requests: string[] = [];
    const extension = createWebSearchExtension("https://searx.example", {
      fetch: async (input) => {
        requests.push(String(input));
        return String(input).includes("searx.example")
          ? jsonResponse({ results: [] })
          : htmlResponse(BING_HTML);
      }
    });

    const result = await run(extension, { query: "durable objects" });

    // An empty answer from the instance must not hide the backends behind it.
    expect(text(result)).toContain("Durable Objects & pricing");
    expect(requests.some((url) => url.includes("bing.com"))).toBe(true);
  });

  it("says so when every backend legitimately finds nothing", async () => {
    const extension = createWebSearchExtension(undefined, {
      fetch: async () => htmlResponse("<html><body>No results found</body></html>")
    });

    const result = await run(extension, { query: "nothing at all" });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("No results for \"nothing at all\"");
  });

  it("asks Cloudflare Web Search when the SearXNG instance fails", async () => {
    const queries: string[] = [];
    const extension = createWebSearchExtension("https://searx.example", {
      fetch: async () => new Response("Format not allowed", { status: 403 }),
      cloudflare: {
        async search(query, limit) {
          queries.push(`${query}:${limit}`);
          return [
            { title: "From Ceramic", url: "https://ceramic.example/page", snippet: "live" }
          ];
        }
      }
    });

    const result = await run(extension, { query: "durable objects" });

    expect(result.isError).toBeFalsy();
    expect(queries).toEqual(["durable objects:5"]);
    expect(text(result)).toContain("From Ceramic");
    expect(text(result)).toContain("https://ceramic.example/page");
  });

  it("does not pay for Cloudflare Web Search while SearXNG answers", async () => {
    let cloudflareCalls = 0;
    const extension = createWebSearchExtension("https://searx.example", {
      fetch: async () =>
        jsonResponse({ results: [{ title: "From SearXNG", url: "https://a.example" }] }),
      cloudflare: {
        async search() {
          cloudflareCalls += 1;
          return [];
        }
      }
    });

    await run(extension, { query: "example" });

    expect(cloudflareCalls).toBe(0);
  });
});

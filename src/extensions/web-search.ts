import { Type } from "@earendil-works/pi-ai";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";

/** How long one backend may take before the next one is tried. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Results returned when the model does not ask for a count. */
const DEFAULT_RESULTS = 5;
/** The most results one call may ask for. */
const MAX_RESULTS = 10;
/** Each snippet is cut to this many characters. */
const SNIPPET_CHARS = 400;

/** How long an identical query reuses its answer. */
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
/** How long a backend that answered with a rate limit is skipped. */
const DEFAULT_COOLDOWN_MS = 60_000;
/** Errors that mean "slow down" rather than "this backend is broken". */
const RATE_LIMIT = /\b(429|202|403)\b|rate.?limit|too many|challenge|anomaly/i;

const USER_AGENT =
  "Mozilla/5.0 (compatible; pi-harness-example/0.1; +https://developers.cloudflare.com/agents/)";

const DEFAULT_SECTION =
  "You can search the web with the web_search tool. Use it for current facts, " +
  "releases, prices, documentation and news; prefer primary sources, and say " +
  "plainly when a result looks stale. It returns titles, URLs and short " +
  "snippets, not page contents.";

export interface BrowserRunner {
  /** Load a URL in a real browser and return the rendered HTML. */
  html(url: string, signal: AbortSignal): Promise<string>;
}

export interface WebSearchOptions {
  /** SearXNG `language` parameter, such as `en` or `all`. */
  language?: string;
  /** SearXNG `safesearch` parameter: 0 off, 1 moderate, 2 strict. */
  safeSearch?: 0 | 1 | 2;
  /** Results returned when the model does not pass `maxResults`. */
  defaultResults?: number;
  /** Deadline for one backend, in milliseconds. */
  timeoutMs?: number;
  /** Replaced in tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Replaces the prompt section; `false` installs the tool without one. */
  section?: string | false;
  /** A real browser, for engines that block a Worker's own fetches. */
  browser?: BrowserRunner;
  /** Reuse a successful answer for this long, in milliseconds. 0 disables. */
  cacheTtlMs?: number;
  /** Skip a rate-limited backend for this long, in milliseconds. 0 disables. */
  cooldownMs?: number;
}

const SearchParameters = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "What to search for. Keywords work better than a full sentence."
  }),
  maxResults: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_RESULTS,
      description: `How many results to return, 1 to ${MAX_RESULTS}. Defaults to ${DEFAULT_RESULTS}.`
    })
  ),
  category: Type.Optional(
    Type.Union([Type.Literal("general"), Type.Literal("news")], {
      description: "SearXNG category: general (default) or news."
    })
  ),
  timeRange: Type.Optional(
    Type.Union(
      [
        Type.Literal("day"),
        Type.Literal("week"),
        Type.Literal("month"),
        Type.Literal("year")
      ],
      { description: "Only results published within this window (SearXNG)." }
    )
  )
});

type TextResult = {
  output: { type: "text"; text: string }[];
  isError?: boolean;
};

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

interface SearchOutcome {
  hits: SearchHit[];
  answers: string[];
  suggestions: string[];
  unavailable: string[];
}

interface SearchFilters {
  category?: "general" | "news";
  timeRange?: "day" | "week" | "month" | "year";
}

interface Provider {
  name: string;
  search(
    query: string,
    limit: number,
    signal: AbortSignal,
    filters: SearchFilters
  ): Promise<SearchOutcome>;
}

interface SearxngResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

interface SearxngResponse {
  results?: SearxngResult[];
  answers?: unknown;
  suggestions?: unknown;
  unresponsive_engines?: unknown;
}

const textResult = (text: string): TextResult => ({
  output: [{ type: "text", text }]
});

const errorResult = (text: string): TextResult => ({
  output: [{ type: "text", text }],
  isError: true
});

/** Trim, drop trailing slashes, and accept a URL that already names /search. */
function normalizeInstance(instanceUrl: string | undefined): string | null {
  const trimmed = instanceUrl?.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  return trimmed.replace(/\/search$/i, "");
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function oneLine(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const text = collapse(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–"
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Visible text of an HTML fragment: tags dropped, entities decoded. */
function textOf(html: string): string {
  return collapse(decodeEntities(html.replace(/<[^>]*>/g, " ")));
}

function hrefOf(attributes: string): string {
  const match = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attributes);
  return match ? (match[2] ?? match[3] ?? "") : "";
}

/** DuckDuckGo links point at its redirector; take the real destination. */
function unwrapDuckDuckGo(href: string): string {
  const decoded = decodeEntities(href);
  const absolute = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  try {
    const url = new URL(absolute, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    if (url.hostname.endsWith("duckduckgo.com") && target) return target;
    return url.toString();
  } catch {
    return absolute;
  }
}

/** The result blocks of DuckDuckGo's HTML endpoint. */
function parseDuckDuckGo(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split(/<div class="result results_links/).slice(1);
  for (const block of blocks) {
    const link = /<a\b([^>]*\bresult__a\b[^>]*)>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const url = unwrapDuckDuckGo(hrefOf(link[1]));
    if (!url) continue;
    const snippet = /<a\b[^>]*\bresult__snippet\b[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    hits.push({
      title: textOf(link[2]).slice(0, 200) || url,
      url: url.slice(0, 500),
      snippet: snippet ? textOf(snippet[1]).slice(0, SNIPPET_CHARS) : ""
    });
  }
  return hits;
}

/** The result rows of DuckDuckGo's Lite endpoint. */
function parseDuckDuckGoLite(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const anchors = [
    ...html.matchAll(/<a\b([^>]*\bresult-link\b[^>]*)>([\s\S]*?)<\/a>/gi)
  ];
  for (const [index, anchor] of anchors.entries()) {
    const url = unwrapDuckDuckGo(hrefOf(anchor[1]));
    if (!url) continue;
    const start = (anchor.index ?? 0) + anchor[0].length;
    const end =
      index + 1 < anchors.length
        ? (anchors[index + 1].index ?? html.length)
        : html.length;
    const snippet = /<td\b[^>]*\bresult-snippet\b[^>]*>([\s\S]*?)<\/td>/i.exec(
      html.slice(start, end)
    );
    hits.push({
      title: textOf(anchor[2]).slice(0, 200) || url,
      url: url.slice(0, 500),
      snippet: snippet ? textOf(snippet[1]).slice(0, SNIPPET_CHARS) : ""
    });
  }
  return hits;
}

/** Bing wants a browser-shaped request; its HTML is what we parse. */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function bingUrl(query: string, limit: number): string {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("setlang", "en-us");
  url.searchParams.set("cc", "us");
  url.searchParams.set("count", String(limit));
  return url.toString();
}

/** Bing wraps results in /ck/a redirects whose `u` parameter is base64url. */
function unwrapBing(href: string): string {
  const decoded = decodeEntities(href);
  const absolute = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  try {
    const url = new URL(absolute, "https://www.bing.com");
    if (url.hostname.endsWith("bing.com") && url.pathname.startsWith("/ck/a")) {
      const target = url.searchParams.get("u");
      if (target?.startsWith("a1")) {
        const base64 = target.slice(2).replace(/-/g, "+").replace(/_/g, "/");
        const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
        try {
          return atob(padded);
        } catch {
          // keep the redirect link when it will not decode
        }
      }
    }
    return url.toString();
  } catch {
    return absolute;
  }
}

/** Bing's organic results, one per `li.b_algo`. */
function parseBing(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split(/<li class="b_algo/).slice(1);
  for (const block of blocks) {
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block);
    if (!heading) continue;
    const link = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(heading[1]);
    if (!link) continue;
    const url = unwrapBing(hrefOf(link[1]));
    if (!url) continue;
    const snippet = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    hits.push({
      title: textOf(link[2]).slice(0, 200) || url,
      url: url.slice(0, 500),
      snippet: snippet ? textOf(snippet[1]).slice(0, SNIPPET_CHARS) : ""
    });
  }
  return hits;
}

/** Bing's HTML endpoint: keyless, and not blocked from Worker egress. */
function createBingProvider(doFetch: typeof fetch): Provider {
  return {
    name: "bing",
    async search(query, limit, signal) {
      const response = await doFetch(bingUrl(query, limit), {
        signal,
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": BROWSER_UA
        }
      });
      if (!response.ok) throw new Error(`Bing returned ${response.status}`);
      const html = await response.text();
      const hits = parseBing(html).slice(0, limit);
      if (hits.length === 0) {
        throw new Error(
          /captcha|unusual traffic|verify you are human/i.test(html)
            ? "Bing served a challenge instead of results"
            : "Bing returned no parseable results"
        );
      }
      return { hits, answers: [], suggestions: [], unavailable: [] };
    }
  };
}

/** SearXNG through `format=json`, which the instance must enable. */
function createSearxngProvider(
  base: string,
  options: WebSearchOptions,
  doFetch: typeof fetch
): Provider {
  return {
    name: "searxng",
    async search(query, limit, signal, filters) {
      let endpoint: URL;
      try {
        endpoint = new URL("search", `${base}/`);
      } catch {
        throw new Error(`SEARXNG_URL "${base}" is not a valid URL`);
      }
      endpoint.searchParams.set("q", query);
      endpoint.searchParams.set("format", "json");
      if (filters.category) endpoint.searchParams.set("categories", filters.category);
      if (filters.timeRange) endpoint.searchParams.set("time_range", filters.timeRange);
      if (options.language) endpoint.searchParams.set("language", options.language);
      if (options.safeSearch !== undefined) {
        endpoint.searchParams.set("safesearch", String(options.safeSearch));
      }

      const response = await doFetch(endpoint, {
        signal,
        headers: { accept: "application/json", "user-agent": USER_AGENT }
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.includes("application/json")) {
        const body = oneLine(await response.text().catch(() => ""), 200);
        const hint =
          response.status === 400 ||
          response.status === 403 ||
          /json/i.test(body)
            ? ' SearXNG serves this API only when its JSON format is enabled: add "json" to search.formats in settings.yml.'
            : "";
        throw new Error(
          `SearXNG at ${endpoint.origin} returned ${response.status}${
            contentType ? ` (${contentType})` : ""
          }.${hint}${body ? ` ${body}` : ""}`
        );
      }

      const payload = (await response.json()) as SearxngResponse;
      const answers = Array.isArray(payload.answers)
        ? payload.answers.filter((answer): answer is string => typeof answer === "string")
        : [];
      const suggestions = Array.isArray(payload.suggestions)
        ? payload.suggestions.filter(
            (suggestion): suggestion is string => typeof suggestion === "string"
          )
        : [];
      const unavailable = Array.isArray(payload.unresponsive_engines)
        ? payload.unresponsive_engines
            .map((engine) => (Array.isArray(engine) ? engine[0] : engine))
            .filter((engine): engine is string => typeof engine === "string")
        : [];
      const hits = (Array.isArray(payload.results) ? payload.results : []).flatMap(
        (result) => {
          const url = oneLine(result?.url, 500);
          if (!url) return [];
          return [
            {
              title: oneLine(result?.title, 200) || url,
              url,
              snippet: oneLine(result?.content, SNIPPET_CHARS)
            }
          ];
        }
      );

      return { hits: hits.slice(0, limit), answers, suggestions, unavailable };
    }
  };
}

/** DuckDuckGo's HTML endpoint: no key, no instance, best effort. */
function createDuckDuckGoProvider(doFetch: typeof fetch): Provider {
  return {
    name: "duckduckgo",
    async search(query, limit, signal) {
      const endpoint = new URL("https://html.duckduckgo.com/html/");
      endpoint.searchParams.set("q", query);
      const response = await doFetch(endpoint, {
        signal,
        headers: { accept: "text/html", "user-agent": USER_AGENT }
      });
      if (!response.ok) {
        throw new Error(`DuckDuckGo returned ${response.status}`);
      }
      const html = await response.text();
      const hits = parseDuckDuckGo(html).slice(0, limit);
      if (hits.length === 0 && /anomaly|unusual traffic|challenge/i.test(html)) {
        throw new Error(
          "DuckDuckGo served a bot challenge instead of results; retry later or set SEARXNG_URL"
        );
      }
      return { hits, answers: [], suggestions: [], unavailable: [] };
    }
  };
}

/** DuckDuckGo's Lite endpoint: a second host with a simpler page. */
function createDuckDuckGoLiteProvider(doFetch: typeof fetch): Provider {
  return {
    name: "duckduckgo-lite",
    async search(query, limit, signal) {
      const endpoint = new URL("https://lite.duckduckgo.com/lite/");
      endpoint.searchParams.set("q", query);
      const response = await doFetch(endpoint, {
        signal,
        headers: { accept: "text/html", "user-agent": USER_AGENT }
      });
      if (!response.ok) {
        throw new Error(`DuckDuckGo Lite returned ${response.status}`);
      }
      const html = await response.text();
      const hits = parseDuckDuckGoLite(html).slice(0, limit);
      if (hits.length === 0 && /anomaly|unusual traffic|challenge/i.test(html)) {
        throw new Error("DuckDuckGo Lite served a bot challenge instead of results");
      }
      return { hits, answers: [], suggestions: [], unavailable: [] };
    }
  };
}

/** Any engine through a real Chromium, for pages that block Worker fetches. */
function createBrowserProvider(
  runner: BrowserRunner,
  name: string,
  target: (query: string, limit: number) => string,
  parse: (html: string) => SearchHit[]
): Provider {
  return {
    name,
    async search(query, limit, signal) {
      const html = await runner.html(target(query, limit), signal);
      const hits = parse(html).slice(0, limit);
      if (hits.length === 0) {
        throw new Error("the browser page had no parseable results");
      }
      return { hits, answers: [], suggestions: [], unavailable: [] };
    }
  };
}

function formatOutcome(query: string, outcome: SearchOutcome, limit: number): string {
  const lines: string[] = [];

  if (outcome.answers.length > 0) {
    lines.push(
      `Answer: ${outcome.answers.map((answer) => oneLine(answer, 600)).join(" ")}`,
      ""
    );
  }

  if (outcome.hits.length === 0) {
    lines.push(
      `No results for "${query}"${
        outcome.unavailable.length > 0
          ? ` (engines unavailable: ${outcome.unavailable.join(", ")})`
          : ""
      }.`
    );
    if (outcome.suggestions.length > 0) {
      lines.push(`Try instead: ${outcome.suggestions.join(", ")}`);
    }
    return lines.join("\n");
  }

  lines.push(`Results for "${query}":`);
  for (const [index, hit] of outcome.hits.slice(0, limit).entries()) {
    lines.push(`${index + 1}. ${hit.title}`, `   ${hit.url}`);
    if (hit.snippet) lines.push(`   ${hit.snippet}`);
  }
  lines.push("", "These are search snippets; open a source before relying on it.");
  return lines.join("\n");
}

/**
 * Web search as a native pi-durable extension. Backends, in order: SearXNG
 * when an instance URL is configured, Bing over HTTP, Bing through a real
 * browser, then DuckDuckGo's HTML and Lite endpoints. DuckDuckGo blocks
 * Cloudflare egress, so it is last. The tool is replay-safe: a search has no
 * side effects, so pi may run it again after an eviction interrupted it.
 */
export function createWebSearchExtension(
  instanceUrl: string | undefined,
  options: WebSearchOptions = {}
): Extension {
  const base = normalizeInstance(instanceUrl);
  const doFetch = options.fetch ?? fetch;
  const providers: Provider[] = [];
  if (base !== null) {
    providers.push(createSearxngProvider(base, options, doFetch));
  }
  providers.push(createBingProvider(doFetch));
  if (options.browser) {
    providers.push(
      createBrowserProvider(options.browser, "bing-browser", bingUrl, parseBing)
    );
  }
  providers.push(createDuckDuckGoProvider(doFetch));
  providers.push(createDuckDuckGoLiteProvider(doFetch));

  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const cache = new Map<string, { text: string; expires: number }>();
  const cooling = new Map<string, number>();

  const defaultResults = Math.min(
    Math.max(options.defaultResults ?? DEFAULT_RESULTS, 1),
    MAX_RESULTS
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const webSearch: ToolRegistration<typeof SearchParameters> = {
    name: "web_search",
    description:
      "Search the web. Returns a numbered list of titles, URLs and short snippets, " +
      "plus short answers when the backend provides one.",
    parameters: SearchParameters,
    replay: "safe",
    async execute({ query, maxResults, category, timeRange }, _api, context) {
      const limit = Math.min(Math.max(maxResults ?? defaultResults, 1), MAX_RESULTS);
      const key = [query, limit, category ?? "", timeRange ?? ""].join("\u0000");
      if (cacheTtlMs > 0) {
        const cached = cache.get(key);
        if (cached && cached.expires > Date.now()) return textResult(cached.text);
        if (cached) cache.delete(key);
      }

      const errors: string[] = [];
      for (const provider of providers) {
        if ((cooling.get(provider.name) ?? 0) > Date.now()) {
          errors.push(`${provider.name}: skipped after a rate limit`);
          continue;
        }
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = context.abortSignal
          ? AbortSignal.any([context.abortSignal, timeout])
          : timeout;
        try {
          const outcome = await provider.search(query, limit, signal, {
            category,
            timeRange
          });
          const answer = formatOutcome(query, outcome, limit);
          if (cacheTtlMs > 0) {
            cache.set(key, { text: answer, expires: Date.now() + cacheTtlMs });
          }
          return textResult(answer);
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          const message =
            error instanceof Error && error.name === "TimeoutError"
              ? `did not answer within ${timeoutMs} ms`
              : error instanceof Error
                ? error.message
                : String(error);
          if (cooldownMs > 0 && RATE_LIMIT.test(message)) {
            cooling.set(provider.name, Date.now() + cooldownMs);
          }
          errors.push(`${provider.name}: ${message}`);
        }
      }

      return errorResult(
        `web search failed. ${errors.join(" ")} Set SEARXNG_URL to an instance you control to avoid public rate limits.`
      );
    }
  };

  const section = options.section ?? DEFAULT_SECTION;
  return {
    name: "web-search",
    tools: [webSearch],
    sections:
      section === false
        ? []
        : [{ key: "web_search", render: () => section, tag: false }]
  };
}

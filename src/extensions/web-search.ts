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

const USER_AGENT =
  "Mozilla/5.0 (compatible; pi-harness-example/0.1; +https://developers.cloudflare.com/agents/)";

const DEFAULT_SECTION =
  "You can search the web with the web_search tool. Use it for current facts, " +
  "releases, prices, documentation and news; prefer primary sources, and say " +
  "plainly when a result looks stale. It returns titles, URLs and short " +
  "snippets, not page contents.";

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
 * Web search as a native pi-durable extension: SearXNG when an instance URL
 * is configured, DuckDuckGo's HTML endpoint otherwise, and DuckDuckGo as the
 * fallback when the SearXNG instance errors. The tool is replay-safe: a
 * search has no side effects, so pi may run it again after an eviction
 * interrupted it.
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
  providers.push(createDuckDuckGoProvider(doFetch));

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

      const errors: string[] = [];
      for (const provider of providers) {
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = context.abortSignal
          ? AbortSignal.any([context.abortSignal, timeout])
          : timeout;
        try {
          const outcome = await provider.search(query, limit, signal, {
            category,
            timeRange
          });
          return textResult(formatOutcome(query, outcome, limit));
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          errors.push(
            `${provider.name}: ${
              error instanceof Error && error.name === "TimeoutError"
                ? `did not answer within ${timeoutMs} ms`
                : error instanceof Error
                  ? error.message
                  : String(error)
            }`
          );
        }
      }

      return errorResult(`web search failed. ${errors.join(" ")}`);
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

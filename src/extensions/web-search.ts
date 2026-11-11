import { Type } from "@earendil-works/pi-ai";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";

/** How long one search may take before it reports a timeout. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Results returned when the model does not ask for a count. */
const DEFAULT_RESULTS = 5;
/** The most results one call may ask for. */
const MAX_RESULTS = 10;
/** Each snippet is cut to this many characters. */
const SNIPPET_CHARS = 400;

const DEFAULT_SECTION =
  "You can search the web with the web_search tool, a SearXNG metasearch instance. " +
  "Use it for current facts, releases, prices, documentation and news; prefer primary " +
  "sources, and say plainly when a result looks stale. It returns titles, URLs and short " +
  "snippets, not page contents.";

export interface WebSearchOptions {
  /** SearXNG `language` parameter, such as `en` or `all`. */
  language?: string;
  /** SearXNG `safesearch` parameter: 0 off, 1 moderate, 2 strict. */
  safeSearch?: 0 | 1 | 2;
  /** Results returned when the model does not pass `maxResults`. */
  defaultResults?: number;
  /** Deadline for one search, in milliseconds. */
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
      { description: "Only results published within this window." }
    )
  )
});

type TextResult = {
  output: { type: "text"; text: string }[];
  isError?: boolean;
};

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

function oneLine(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

function formatSnippets(query: string, payload: SearxngResponse, limit: number): string {
  const lines: string[] = [];

  const answers = Array.isArray(payload.answers)
    ? payload.answers.filter((answer): answer is string => typeof answer === "string")
    : [];
  if (answers.length > 0) {
    lines.push(`Answer: ${answers.map((answer) => oneLine(answer, 600)).join(" ")}`, "");
  }

  const results = Array.isArray(payload.results) ? payload.results : [];
  const usable = results.flatMap((result) => {
    const url = oneLine(result?.url, 500);
    if (!url) return [];
    return [
      {
        title: oneLine(result?.title, 200) || url,
        url,
        snippet: oneLine(result?.content, SNIPPET_CHARS)
      }
    ];
  });

  if (usable.length === 0) {
    const unavailable = Array.isArray(payload.unresponsive_engines)
      ? payload.unresponsive_engines
          .map((engine) => (Array.isArray(engine) ? engine[0] : engine))
          .filter((engine): engine is string => typeof engine === "string")
      : [];
    lines.push(
      `No results for "${query}"${
        unavailable.length > 0
          ? ` (engines unavailable: ${unavailable.join(", ")})`
          : ""
      }.`
    );
    const suggestions = Array.isArray(payload.suggestions)
      ? payload.suggestions.filter(
          (suggestion): suggestion is string => typeof suggestion === "string"
        )
      : [];
    if (suggestions.length > 0) {
      lines.push(`Try instead: ${suggestions.join(", ")}`);
    }
    return lines.join("\n");
  }

  lines.push(`Results for "${query}":`);
  for (const [index, result] of usable.slice(0, limit).entries()) {
    lines.push(`${index + 1}. ${result.title}`, `   ${result.url}`);
    if (result.snippet) lines.push(`   ${result.snippet}`);
  }
  lines.push("", "These are search snippets; open a source before relying on it.");
  return lines.join("\n");
}

/**
 * Web search through a SearXNG instance, as a native pi-durable extension.
 *
 * Returns `null` when no instance URL is configured, so the app can install
 * it only when `SEARXNG_URL` is set. The tool is replay-safe: a search has no
 * side effects, so pi may run it again after an eviction interrupted it.
 */
export function createWebSearchExtension(
  instanceUrl: string | undefined,
  options: WebSearchOptions = {}
): Extension | null {
  const base = normalizeInstance(instanceUrl);
  if (base === null) return null;

  const defaultResults = Math.min(
    Math.max(options.defaultResults ?? DEFAULT_RESULTS, 1),
    MAX_RESULTS
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? fetch;

  const webSearch: ToolRegistration<typeof SearchParameters> = {
    name: "web_search",
    description:
      "Search the web with SearXNG. Returns a numbered list of titles, URLs and short " +
      "snippets, plus short answers when the engines provide one.",
    parameters: SearchParameters,
    replay: "safe",
    async execute({ query, maxResults, category, timeRange }, _api, context) {
      const limit = Math.min(
        Math.max(maxResults ?? defaultResults, 1),
        MAX_RESULTS
      );

      let endpoint: URL;
      try {
        endpoint = new URL("search", `${base}/`);
      } catch {
        return errorResult(
          `web_search is misconfigured: SEARXNG_URL "${base}" is not a valid URL.`
        );
      }
      endpoint.searchParams.set("q", query);
      endpoint.searchParams.set("format", "json");
      if (category) endpoint.searchParams.set("categories", category);
      if (timeRange) endpoint.searchParams.set("time_range", timeRange);
      if (options.language) endpoint.searchParams.set("language", options.language);
      if (options.safeSearch !== undefined) {
        endpoint.searchParams.set("safesearch", String(options.safeSearch));
      }

      const signal = context.abortSignal
        ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);

      let payload: SearxngResponse;
      try {
        const response = await doFetch(endpoint, {
          signal,
          headers: {
            accept: "application/json",
            "user-agent": "pi-harness-example (+https://developers.cloudflare.com/agents/)"
          }
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
          return errorResult(
            `SearXNG at ${endpoint.origin} returned ${response.status}${
              contentType ? ` (${contentType})` : ""
            }.${hint}${body ? ` ${body}` : ""}`
          );
        }
        payload = (await response.json()) as SearxngResponse;
      } catch (error) {
        if (context.abortSignal?.aborted) throw error;
        if (error instanceof Error && error.name === "TimeoutError") {
          return errorResult(
            `SearXNG at ${endpoint.origin} did not answer within ${timeoutMs} ms.`
          );
        }
        return errorResult(
          `web search failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      return textResult(formatSnippets(query, payload, limit));
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

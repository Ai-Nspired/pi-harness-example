import puppeteer from "@cloudflare/puppeteer";
import { DurableObject } from "cloudflare:workers";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
import { createGitModule } from "@cloudflare/computer/modules/git";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { WebSockets } from "agents/websockets";
import { createWebSearchExtension } from "./extensions/web-search";
import { compactionBudget } from "./compaction";
import { createOpenRouterSetup } from "./openrouter";
import { PiSessionSockets } from "./sockets";
import { createWorkspaceTools, JAVASCRIPT_BACKEND } from "./workspace";

const MODEL_ID = "@cf/zai-org/glm-5.3-flash";

/**
 * A real Chromium through Browser Rendering. Worker fetches to DuckDuckGo can
 * be rate limited or challenged; a browser session gets its own fingerprint.
 */
function createBrowserRunner(env: Env) {
  return {
    async html(url: string, signal: AbortSignal): Promise<string> {
      const browser = await puppeteer.launch(env.BROWSER);
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await browser.close().catch(() => {});
      };
      const onAbort = () => {
        void close();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        return await page.content();
      } finally {
        signal.removeEventListener("abort", onAbort);
        await close();
      }
    }
  };
}

/**
 * Cloudflare's Web Search API with Ceramic.ai: $0.25 per 1,000 searches,
 * billed to AI Gateway credits. It backs up our own SearXNG instance, which is
 * free, so it only runs when that instance is asleep or broken.
 */
function createCloudflareSearch(env: Env) {
  return {
    async search(query: string, limit: number) {
      const response = await env.AI.websearch({
        gatewayId: env.AI_GATEWAY_ID ?? "default",
        query,
        provider: "ceramic",
        limit
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Cloudflare Web Search returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`
        );
      }
      const payload = (await response.json()) as {
        items?: { title?: unknown; url?: unknown; description?: unknown }[];
      };
      return (Array.isArray(payload.items) ? payload.items : []).flatMap((item) => {
        const url = typeof item?.url === "string" ? item.url.trim() : "";
        if (!url) return [];
        const title = typeof item?.title === "string" ? item.title.trim() : "";
        return [
          {
            title: title || url,
            url,
            snippet: typeof item?.description === "string" ? item.description.trim() : ""
          }
        ];
      });
    }
  };
}

/** CLOUDFLARE_SEARCH=off turns the paid fallback off; it is on otherwise. */
function cloudflareSearchEnabled(env: Env): boolean {
  return (env.CLOUDFLARE_SEARCH ?? "on").trim().toLowerCase() !== "off";
}

const PREAMBLE =
  "You are a concise playground assistant. You have a durable workspace at /workspace: read, write, edit, delete, list (ls), find and grep files there, and run JavaScript modules in it with exec, which can also use git. Paths are absolute. Use tools whenever they can answer the request, and explain their results plainly.";

/** Playable pi session backed by one Durable Object. */
export class PiAgent extends DurableObject<Env> {
  // Workers AI and AI Gateway over the AI binding, as a pi-ai provider.
  readonly ai = createAI({ binding: this.env.AI });
  // A durable filesystem on the object's SQLite, beside pi's own tables.
  // `exec` runs JavaScript modules in a fresh Dynamic Worker per call, with
  // no network of its own. `git` turns on `workspace.git`, which the `ws:git`
  // module calls in the host; `allowNetwork` lets it clone, fetch and push.
  readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    git: createGitClient(),
    backends: [
      new WorkerJavaScriptBackend({
        id: JAVASCRIPT_BACKEND,
        loader: this.env.LOADER,
        root: "/workspace",
        access: "read-write",
        modules: { "ws:git": createGitModule({ allowNetwork: true }) }
      })
    ]
  });
  // OpenRouter presets, when a key is configured; otherwise Workers AI.
  readonly openrouter = createOpenRouterSetup(this.env);
  readonly models = createModels();
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      // pi's own extension: the system prompt and the workspace tools.
      this.registry.install({
        name: "playground",
        sections: [{ key: "preamble", render: () => PREAMBLE, tag: false }],
        tools: createWorkspaceTools(this.workspace)
      });
      // Web search: SearXNG when configured, Cloudflare Web Search when it
      // fails, then Bing and DuckDuckGo's HTML and Lite endpoints.
      this.registry.install(
        createWebSearchExtension(this.env.SEARXNG_URL, {
          browser: createBrowserRunner(this.env),
          cloudflare: cloudflareSearchEnabled(this.env)
            ? createCloudflareSearch(this.env)
            : undefined
        })
      );
      const models = this.openModels();
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          onWake,
          settings: {
            // pi doubles the delay before each retry: 1, 2, 4, 8 and 16 seconds,
            // so a rate-limited model gets about 30 seconds to recover.
            retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
            // Cap the working context so a long session summarises older turns
            // instead of resending everything it has ever said, every turn.
            compaction: compactionBudget(this.defaultModel().contextWindow)
          },
          onReport: (error) => console.warn("pi report", error)
        },
        context
      );
    },
    defaults: { model: this.defaultModel(), thinkingLevel: "low" }
  });

  /**
   * The provider registry pi resolves models against: OpenRouter when a key is
   * set, so `openrouter/@preset/<slug>` resolves, and Workers AI otherwise.
   */
  private openModels() {
    this.models.setProvider(this.openrouter?.provider ?? this.ai.provider);
    return this.models;
  }

  /** Start on the configured preset, or on Workers AI when there is no key. */
  private defaultModel() {
    if (this.openrouter) {
      // Never return a Workers AI model here: the registry is OpenRouter's, so
      // a model from the other provider could not be streamed at all.
      const chosen = this.openModels().getModel("openrouter", this.openrouter.defaultModelId);
      if (chosen) return chosen;
      const first = this.openrouter.provider.getModels()[0];
      if (first) return first;
    }
    return this.ai(MODEL_ID);
  }

  // App glue, not the harness: how this app puts sessions on a socket.
  readonly sockets = new PiSessionSockets(this.harness, this.registry, (tag) =>
    this.ctx.getWebSockets(tag)
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  /** Host startup, after the harness has opened pi. */
  async onStart(): Promise<void> {
    // One line in the dashboard logs naming the provider actually in use.
    console.log(
      "model route",
      this.openrouter ? `openrouter:${this.openrouter.defaultModelId}` : "workers-ai",
      "presets",
      this.openrouter?.presets ?? []
    );
    await this.sockets.reattach();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/api/session") {
      // A fresh session id for the client to open its WebSocket against.
      return Response.json({ session: crypto.randomUUID() });
    }
    try {
      return (
        (await routeAgentRequest(request, env, { cors: true })) ??
        new Response("Not found", { status: 404 })
      );
    } catch (error) {
      console.error("Pi playground request failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;

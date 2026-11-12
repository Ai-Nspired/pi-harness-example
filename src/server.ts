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
      // Web search: SearXNG when configured, then a real browser, then
      // DuckDuckGo's HTML and Lite endpoints.
      this.registry.install(
        createWebSearchExtension(this.env.SEARXNG_URL, {
          browser: createBrowserRunner(this.env)
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
            retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 }
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
      const preset = this.openModels().getModel("openrouter", this.openrouter.defaultModelId);
      if (preset) return preset;
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

import puppeteer from "@cloudflare/puppeteer";
import { DurableObject } from "cloudflare:workers";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
import { createGitModule } from "@cloudflare/computer/modules/git";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { PiHarness, ROOT_SESSION } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { WebSockets } from "agents/websockets";
import { extractDocument, uploadName } from "./extract";
import { createSearchProviders, createWebSearchExtension } from "./extensions/web-search";
import { compactionBudget } from "./compaction";
import {
  createOpenRouterSetup,
  presetModelId,
  resolvePresetModel
} from "./openrouter";
import { PiSessionSockets } from "./sockets";
import { createWorkspaceTools, JAVASCRIPT_BACKEND } from "./workspace";

const MODEL_ID = "@cf/zai-org/glm-5.3-flash";
/** Speech to text on the AI binding, so dictation needs no key of its own. */
const TRANSCRIBE_MODEL = "@cf/openai/whisper-large-v3-turbo";
/** A dictation longer than this is a mistake, not a message. */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/** Bigger than a docket, so refuse it rather than hold it in memory. */
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
/** Past this, the answer is the file's beginning; the response says so. */
const MAX_EXTRACTED_CHARS = 40_000;

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
  readonly sockets = new PiSessionSockets(
    this.harness,
    this.registry,
    (tag) => this.ctx.getWebSockets(tag),
    this.openrouter
      ? {
          entries: this.openrouter.entries,
          baseModelId: this.openrouter.baseModelId
        }
      : undefined
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  /**
   * pi applies `defaults` only when a session is first created, so a session
   * opened before a preset was configured keeps its old model forever. This
   * adopts the configured preset, which is why a stale conversation stops
   * reporting (and running) a route nobody chose. Once the UI can pick a
   * preset, this should only adopt when nothing valid is stored.
   */
  private async adoptConfiguredPreset(): Promise<void> {
    const setup = this.openrouter;
    if (!setup) return;
    const allowed = new Set([
      ...setup.presets.map((slug) => presetModelId(slug)),
      setup.defaultModelId
    ]);
    const session = this.harness.session(ROOT_SESSION);
    const stream = await session.events();
    let stored: { provider?: string; id?: string } | undefined;
    try {
      const snapshot = stream.snapshot as {
        agent?: { model?: { provider?: string; id?: string } };
      };
      stored = snapshot.agent?.model;
    } finally {
      await stream.stop();
    }
    if (stored?.provider === "openrouter" && stored.id && allowed.has(stored.id)) {
      return;
    }
    await session.setModel({ provider: "openrouter", id: setup.defaultModelId });
    console.log(
      "preset adopted",
      setup.defaultModelId,
      "was",
      stored ? `${stored.provider}/${stored.id}` : "unset"
    );
  }

  /**
   * Another Worker's way in: answer one message here, on a named preset. A
   * caller that knows the preset passes its slug; one that does not gets this
   * session's stored model, so a conversation started on `truth` stays there.
   * An empty preset runs the plain model.
   */
  async ask(
    text: string,
    preset?: string
  ): Promise<{ text: string; model: string }> {
    const setup = this.openrouter;
    let model: string = setup?.defaultModelId ?? MODEL_ID;
    if (preset !== undefined) {
      const wanted = preset.trim();
      const resolved: string | undefined =
        wanted === ""
          ? setup?.baseModelId
          : resolvePresetModel(setup?.entries ?? [], wanted);
      if (resolved === undefined) {
        throw new Error(
          `Unknown preset ${JSON.stringify(preset)}. Configured: ${
            setup?.presets.join(", ") || "none"
          }`
        );
      }
      const id = resolved;
      await this.harness.session(ROOT_SESSION).setModel({
        provider: "openrouter",
        id
      });
      model = id;
    }
    const answer = await this.harness.prompt(text);
    // `text` is absent when the run ended without a final assistant message.
    return { text: answer.text ?? "", model };
  }

  /** Host startup, after the harness has opened pi. */
  async onStart(): Promise<void> {
    await this.adoptConfiguredPreset();
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
    if (new URL(request.url).pathname === "/api/transcribe") {
      // Dictation: the browser posts the recording, Whisper turns it into text.
      if (request.method !== "POST") {
        return Response.json({ error: "POST the audio" }, { status: 405 });
      }
      const audio = await request.arrayBuffer();
      if (audio.byteLength === 0) {
        return Response.json({ error: "The recording was empty" }, { status: 400 });
      }
      if (audio.byteLength > MAX_AUDIO_BYTES) {
        return Response.json(
          { error: "That recording is too long to transcribe" },
          { status: 413 }
        );
      }
      try {
        const ai = env.AI as unknown as {
          run(
            model: string,
            inputs: { audio: number[] }
          ): Promise<{ text?: string }>;
        };
        const result = await ai.run(TRANSCRIBE_MODEL, {
          audio: [...new Uint8Array(audio)]
        });
        return Response.json(
          { text: result.text?.trim() ?? "" },
          { headers: { "cache-control": "no-store" } }
        );
      } catch (error) {
        return Response.json(
          {
            error: `Transcription failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          },
          { status: 502 }
        );
      }
    }
    if (new URL(request.url).pathname === "/api/extract") {
      // An uploaded docket, read into text before it reaches the model: PDF,
      // DOCX and plain text, with the file named in `?name=`.
      if (request.method !== "POST") {
        return Response.json({ error: "POST the file" }, { status: 405 });
      }
      const name = uploadName(new URL(request.url).searchParams.get("name"));
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength === 0) {
        return Response.json({ error: "That file is empty" }, { status: 400 });
      }
      if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
        return Response.json({ error: "That file is too large" }, { status: 413 });
      }
      try {
        const text = await extractDocument(name, bytes);
        const clipped = text.slice(0, MAX_EXTRACTED_CHARS);
        return Response.json(
          {
            name,
            text: clipped,
            characters: text.length,
            truncated: clipped.length < text.length
          },
          { headers: { "cache-control": "no-store" } }
        );
      } catch (error) {
        return Response.json(
          {
            error: `Could not read ${name}: ${
              error instanceof Error ? error.message : String(error)
            }`
          },
          { status: 400 }
        );
      }
    }
    if (new URL(request.url).pathname === "/api/search") {
      // Diagnostics from a phone: run the same backends the tool uses, in
      // order, and report which one answered. A sleeping instance or a blocked
      // engine becomes visible here instead of inside a model reply.
      const query = new URL(request.url).searchParams.get("q")?.trim();
      if (!query) return Response.json({ error: "Pass ?q=" }, { status: 400 });
      const providers = createSearchProviders(env.SEARXNG_URL, {
        browser: createBrowserRunner(env),
        cloudflare: cloudflareSearchEnabled(env)
          ? createCloudflareSearch(env)
          : undefined
      });
      const attempts: {
        provider: string;
        results: number;
        error?: string;
      }[] = [];
      for (const provider of providers) {
        try {
          const outcome = await provider.search(
            query,
            3,
            AbortSignal.timeout(8_000),
            {}
          );
          attempts.push({ provider: provider.name, results: outcome.hits.length });
          if (outcome.hits.length > 0) {
            return Response.json(
              { query, provider: provider.name, attempts, hits: outcome.hits },
              { headers: { "cache-control": "no-store" } }
            );
          }
        } catch (error) {
          attempts.push({
            provider: provider.name,
            results: 0,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      return Response.json(
        { query, provider: null, attempts },
        { headers: { "cache-control": "no-store" } }
      );
    }
    if (new URL(request.url).pathname === "/api/assistant") {
      // The worker-to-worker door: one message in, one answer out, on a preset
      // the caller names or on the session's own. Reached through a service
      // binding or `getByName`, so a caller needs no key and no socket.
      if (request.method !== "POST") {
        return Response.json({ error: "POST a JSON body" }, { status: 405 });
      }
      let body: { message?: unknown; preset?: unknown; session?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return Response.json({ error: "Expected a JSON body" }, { status: 400 });
      }
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        return Response.json({ error: "Pass a message" }, { status: 400 });
      }
      const preset = typeof body.preset === "string" ? body.preset : undefined;
      if (preset !== undefined) {
        const setup = createOpenRouterSetup(env);
        const id =
          preset.trim() === ""
            ? setup?.baseModelId
            : resolvePresetModel(setup?.entries ?? [], preset);
        if (!id) {
          return Response.json(
            {
              error: `Unknown preset ${JSON.stringify(preset)}`,
              presets: setup?.presets ?? []
            },
            { status: 400 }
          );
        }
      }
      const session =
        typeof body.session === "string" && body.session.trim()
          ? body.session.trim()
          : "assistant";
      try {
        const answer = await env.PiAgent.getByName(session).ask(message, preset);
        return Response.json(
          { session, ...answer },
          { headers: { "cache-control": "no-store" } }
        );
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 }
        );
      }
    }
    if (new URL(request.url).pathname === "/api/route") {
      // What this deployment is actually set up to run, readable from a phone:
      // the model a new session starts on, and the presets it was given. The
      // key itself is never echoed, only whether one is configured.
      const setup = createOpenRouterSetup(env);
      return Response.json(
        {
          model: setup?.defaultModelId ?? MODEL_ID,
          provider: setup ? "openrouter" : "workers-ai",
          presets: setup?.presets ?? [],
          note: setup
            ? undefined
            : "OPENROUTER_API_KEY is not set, so presets are not used"
        },
        { headers: { "cache-control": "no-store" } }
      );
    }
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

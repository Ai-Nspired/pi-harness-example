import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

/** OpenRouter's OpenAI-compatible endpoint. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * A preset is addressed as a model id with this prefix. OpenRouter documented
 * that a bare slug is ignored, so every preset request needs the prefix.
 */
export const PRESET_PREFIX = "@preset/";

/** Metadata source when a preset does not name its own model. */
const DEFAULT_MODEL = "z-ai/glm-5.3-flash";

export interface OpenRouterEnv {
  OPENROUTER_API_KEY?: string;
  /** Comma-separated preset slugs created in the OpenRouter dashboard. */
  OPENROUTER_PRESETS?: string;
  /** Slug used when a session starts; defaults to the first configured preset. */
  OPENROUTER_DEFAULT_PRESET?: string;
  /** Optional provider order sent with every request, e.g. "Wafer,Z.ai". */
  OPENROUTER_PROVIDER_ORDER?: string;
  /** `price`, `throughput` or `latency`. `price` keeps routing on the cheapest. */
  OPENROUTER_SORT?: string;
  /** Ceiling as `prompt,completion` in USD per million tokens, e.g. `0.12,0.40`. */
  OPENROUTER_MAX_PRICE?: string;
  /** Model whose metadata (context window, pricing) preset models inherit. */
  OPENROUTER_MODEL?: string;
}

/**
 * One configured preset. OpenRouter accepts a preset three ways: as the whole
 * model id (`@preset/slug`), pinned to an explicit model
 * (`model-id@preset/slug`), or as a separate `preset` field. This repo uses the
 * model-id forms, because they keep one code path and survive logging.
 */
export interface PresetEntry {
  readonly slug: string;
  /** Model the preset is applied to, when the entry pins one. */
  readonly modelId?: string;
  /** The model id to register, already carrying the preset. */
  readonly id: string;
}

/**
 * `"fast, z-ai/glm-5.3-flash@preset/smart, z-ai/glm-4.7@deep"` → three entries.
 * A bare `@preset/` prefix is accepted and stripped, as is a duplicated slug.
 */
export function parsePresetEntries(raw: string | undefined): PresetEntry[] {
  const seen = new Set<string>();
  const entries: PresetEntry[] = [];

  for (const part of (raw ?? "").split(",")) {
    const text = part.trim();
    if (text.length === 0) continue;

    const presetAt = text.indexOf("@preset/");
    let modelId: string | undefined;
    let slug: string;

    if (presetAt >= 0) {
      modelId = text.slice(0, presetAt).trim() || undefined;
      slug = text.slice(presetAt + "@preset/".length);
    } else if (text.includes("@")) {
      // `model@slug` shorthand for the same thing.
      const at = text.indexOf("@");
      modelId = text.slice(0, at).trim() || undefined;
      slug = text.slice(at + 1);
    } else {
      slug = text;
    }

    slug = slug.trim().replace(/\/+$/, "");
    if (slug.length === 0) continue;

    const id = modelId ? `${modelId}${PRESET_PREFIX}${slug}` : presetModelId(slug);
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ slug, ...(modelId ? { modelId } : {}), id });
  }

  return entries;
}

/** `"fast, @preset/smart , fast"` → `["fast", "smart"]`. */
export function parsePresetSlugs(raw: string | undefined): string[] {
  return parsePresetEntries(raw).map((entry) => entry.slug);
}

/** `" Wafer , Z.ai "` → `["Wafer", "Z.ai"]`. */
export function parseProviderOrder(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** How OpenRouter ranks providers when no explicit order is given. */
export type ProviderSort = "price" | "throughput" | "latency";

export function parseProviderSort(raw: string | undefined): ProviderSort | undefined {
  const value = raw?.trim().toLowerCase();
  return value === "price" || value === "throughput" || value === "latency" ? value : undefined;
}

/**
 * `"0.12,0.40"` → a ceiling in USD per million tokens, prompt then completion.
 * OpenRouter refuses a request it cannot serve under that price, so an
 * expensive route becomes a visible failure instead of a silent bill.
 */
export function parseMaxPrice(
  raw: string | undefined
): { prompt: number; completion: number } | undefined {
  const parts = (raw ?? "").split(",").map((part) => Number.parseFloat(part.trim()));
  if (parts.length !== 2) return undefined;
  const [prompt, completion] = parts;
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined;
  if (prompt <= 0 || completion <= 0) return undefined;
  return { prompt, completion };
}

/** What every request carries so routing cannot drift to a pricier provider. */
export interface ProviderPin {
  readonly order: readonly string[];
  readonly sort?: ProviderSort;
  readonly maxPrice?: { prompt: number; completion: number };
}

export function presetModelId(slug: string): string {
  return `${PRESET_PREFIX}${slug}`;
}

/**
 * OpenRouter variants are suffixes: `:floor` (cheapest route), `:nitro`
 * (fastest), `:exacto` (tool-calling reliability), `:free`, `:extended`. They
 * change routing, not the catalogue entry, so metadata comes from the base id.
 */
export function baseModelId(id: string): string {
  const variant = id.indexOf(":");
  return variant > 0 ? id.slice(0, variant) : id;
}

/**
 * Presets carry their routing in OpenRouter, so this is only a fallback pin.
 * `samplingParams` are merged into an OpenAI-compatible request body as-is,
 * which is where OpenRouter reads `provider.order`.
 */
export function withProviderPin<TApi extends Api>(
  model: Model<TApi>,
  pin: ProviderPin
): Model<TApi> {
  const provider: Record<string, unknown> = {};
  if (pin.order.length > 0) provider.order = [...pin.order];
  if (pin.sort) provider.sort = pin.sort;
  if (pin.maxPrice) provider.max_price = { ...pin.maxPrice };
  if (Object.keys(provider).length === 0) return model;
  return { ...model, samplingParams: { ...model.samplingParams, provider } };
}

export function withProviderOrder<TApi extends Api>(
  model: Model<TApi>,
  order: readonly string[]
): Model<TApi> {
  return withProviderPin(model, { order });
}

/**
 * A model the bundled catalogue does not know yet. Naming one explicitly must
 * not fall back to catalogue entry zero, which is a frontier model: build a
 * conservative entry for the requested id instead.
 */
export function offCatalogModel(id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: OPENROUTER_BASE_URL,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 131_072,
    maxTokens: 8_192
  };
}

export interface OpenRouterSetup {
  provider: Provider<"anthropic-messages" | "openai-completions">;
  /** Slugs from `OPENROUTER_PRESETS`, in order, without the prefix. */
  presets: readonly string[];
  /** Model id to start a session with, already prefixed when it is a preset. */
  defaultModelId: string;
  /** The configured entries, each with the id a switch must send. */
  entries: readonly PresetEntry[];
  /** The plain model, used when no preset is selected. */
  baseModelId: string;
}

/**
 * The model id to send when switching to one configured preset. Accepts the
 * bare slug or the prefixed id, and answers with the id as registered — the
 * prefixed slug, or the `model@preset/slug` form when the entry pins a model.
 * Undefined for a slug that is not configured, so the caller can refuse it
 * before it reaches OpenRouter as an unknown model.
 */
export function resolvePresetModel(
  entries: readonly PresetEntry[],
  slug: string
): string | undefined {
  const wanted = slug.trim().replace(/^@preset\//, "");
  return entries.find((entry) => entry.slug === wanted || entry.id === slug.trim())?.id;
}

/**
 * An OpenRouter provider whose catalog also lists one model per preset, so a
 * slug created in the dashboard becomes `openrouter/@preset/<slug>` here.
 * Returns undefined when no key is configured, leaving Workers AI in charge.
 */
export function createOpenRouterSetup(env: OpenRouterEnv): OpenRouterSetup | undefined {
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) return undefined;

  const base = openrouterProvider();
  const catalog = base.getModels();
  const configured = env.OPENROUTER_MODEL?.trim();
  const wanted = configured || DEFAULT_MODEL;
  const known = catalog.find((model) => model.id === wanted || model.id === baseModelId(wanted));
  // Only fall back to the catalogue head when nothing was asked for. An
  // explicit id the catalogue lacks gets its own entry, never a frontier model.
  // A variant keeps its suffix so the request routes the way it was asked to.
  const baseModel = known
    ? { ...known, id: wanted }
    : configured
      ? offCatalogModel(wanted)
      : catalog[0];
  if (!baseModel) return undefined;

  const order = parseProviderOrder(env.OPENROUTER_PROVIDER_ORDER);
  const sort = parseProviderSort(env.OPENROUTER_SORT);
  const maxPrice = parseMaxPrice(env.OPENROUTER_MAX_PRICE);
  const pin: ProviderPin = {
    order,
    ...(sort ? { sort } : {}),
    ...(maxPrice ? { maxPrice } : {})
  };
  const routes = order.length > 0 || sort !== undefined || maxPrice !== undefined;
  // The catalogue's own entry for this model is unpinned, so it is shadowed by
  // a pinned copy with the same id whenever routing is configured.
  const pinnedBase = withProviderPin(baseModel, pin);
  const entries = parsePresetEntries(env.OPENROUTER_PRESETS);
  const presets = entries.map((entry) => entry.slug);
  const presetModels = entries.map((entry) => {
    // A preset pinned to a model borrows that model's metadata; otherwise the
    // metadata model stands in, since a preset cannot be fetched for it.
    const meta = entry.modelId
      ? catalog.find(
          (model) => model.id === entry.modelId || model.id === baseModelId(entry.modelId!)
        ) ?? offCatalogModel(entry.modelId)
      : baseModel;
    // The ceiling was measured for OPENROUTER_MODEL's price class, so a preset
    // pinned to another model keeps the routing but not the ceiling.
    const ownPin: ProviderPin =
      entry.modelId && baseModelId(entry.modelId) !== baseModelId(wanted)
        ? { order, ...(sort ? { sort } : {}) }
        : pin;
    return withProviderPin({ ...meta, id: entry.id, name: `OpenRouter ${entry.id}` }, ownPin);
  });
  // Registered ids the catalogue does not already carry, including presets.
  const extra = known && known.id === wanted && !routes ? [] : [pinnedBase];
  const added = [...extra, ...presetModels];
  const shadowed = known && known.id === wanted && routes ? new Set([wanted]) : new Set<string>();

  const login = base.auth.apiKey?.login;
  const provider: OpenRouterSetup["provider"] = {
    ...base,
    auth: {
      ...base.auth,
      apiKey: {
        name: "OpenRouter API key",
        ...(login ? { login } : {}),
        resolve: async () => ({ auth: { apiKey: key }, source: "OPENROUTER_API_KEY" })
      }
    },
    getModels: () => [
      ...base.getModels().filter((model) => !shadowed.has(model.id)),
      ...added
    ]
  };

  // Accept a slug, `@preset/slug`, or the fully pinned model id.
  const requested = env.OPENROUTER_DEFAULT_PRESET?.trim();
  const matched = requested
    ? entries.find((entry) => entry.id === requested || entry.slug === requested.replace(/^@preset\//, ""))
    : undefined;
  // Always a model this provider can actually resolve: the requested preset,
  // the first configured preset, or the metadata model picked above.
  const defaultModelId = matched?.id ?? presetModels[0]?.id ?? baseModel.id;

  return { provider, presets, defaultModelId, entries, baseModelId: baseModel.id };
}

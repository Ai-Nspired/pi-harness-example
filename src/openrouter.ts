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
  /** Model whose metadata (context window, pricing) preset models inherit. */
  OPENROUTER_MODEL?: string;
}

/** `"fast, @preset/smart , fast"` → `["fast", "smart"]`. */
export function parsePresetSlugs(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const slug = part.trim().replace(/^@preset\//, "").replace(/\/+$/, "");
    if (slug.length === 0 || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

/** `" Wafer , Z.ai "` → `["Wafer", "Z.ai"]`. */
export function parseProviderOrder(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function presetModelId(slug: string): string {
  return `${PRESET_PREFIX}${slug}`;
}

/**
 * Presets carry their routing in OpenRouter, so this is only a fallback pin.
 * `samplingParams` are merged into an OpenAI-compatible request body as-is,
 * which is where OpenRouter reads `provider.order`.
 */
export function withProviderOrder<TApi extends Api>(
  model: Model<TApi>,
  order: readonly string[]
): Model<TApi> {
  if (order.length === 0) return model;
  return {
    ...model,
    samplingParams: { ...model.samplingParams, provider: { order: [...order] } }
  };
}

export interface OpenRouterSetup {
  provider: Provider<"anthropic-messages" | "openai-completions">;
  /** Slugs from `OPENROUTER_PRESETS`, in order, without the prefix. */
  presets: readonly string[];
  /** Model id to start a session with, already prefixed when it is a preset. */
  defaultModelId: string;
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
  const wanted = env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
  const baseModel = catalog.find((model) => model.id === wanted) ?? catalog[0];
  if (!baseModel) return undefined;

  const order = parseProviderOrder(env.OPENROUTER_PROVIDER_ORDER);
  const presets = parsePresetSlugs(env.OPENROUTER_PRESETS);
  const presetModels = presets.map((slug) =>
    withProviderOrder(
      { ...baseModel, id: presetModelId(slug), name: `OpenRouter ${slug}` },
      order
    )
  );

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
    getModels: () => [...base.getModels(), ...presetModels]
  };

  const requested = env.OPENROUTER_DEFAULT_PRESET?.trim().replace(/^@preset\//, "");
  // Always a model this provider can actually resolve: the requested preset,
  // the first configured preset, or the metadata model picked above.
  const defaultModelId =
    requested && presets.includes(requested)
      ? presetModelId(requested)
      : presetModels[0]?.id ?? baseModel.id;

  return { provider, presets, defaultModelId };
}

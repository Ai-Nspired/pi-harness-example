import { describe, expect, it } from "vitest";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import {
  createOpenRouterSetup,
  parsePresetEntries,
  parsePresetSlugs,
  parseProviderOrder,
  presetModelId,
  withProviderOrder
} from "../openrouter";

describe("preset slugs", () => {
  it("trims, strips the prefix and drops duplicates", () => {
    expect(parsePresetSlugs(" fast , @preset/smart,fast ,, ")).toEqual(["fast", "smart"]);
  });

  it("is empty when nothing is configured", () => {
    expect(parsePresetSlugs(undefined)).toEqual([]);
  });

  it("addresses a preset with the prefix OpenRouter requires", () => {
    expect(presetModelId("smart")).toBe("@preset/smart");
  });

  it("parses a provider order", () => {
    expect(parseProviderOrder(" Wafer, Z.ai ,")).toEqual(["Wafer", "Z.ai"]);
  });
});

describe("preset entries", () => {
  it("accepts the bare form", () => {
    expect(parsePresetEntries("fast")).toEqual([{ slug: "fast", id: "@preset/fast" }]);
  });

  it("accepts a preset pinned to a model", () => {
    expect(parsePresetEntries("z-ai/glm-5.3-flash@preset/smart")).toEqual([
      { slug: "smart", modelId: "z-ai/glm-5.3-flash", id: "z-ai/glm-5.3-flash@preset/smart" }
    ]);
  });

  it("accepts the model@slug shorthand", () => {
    expect(parsePresetEntries("z-ai/glm-4.7@deep")).toEqual([
      { slug: "deep", modelId: "z-ai/glm-4.7", id: "z-ai/glm-4.7@preset/deep" }
    ]);
  });

  it("keeps distinct pinned models for the same slug", () => {
    const entries = parsePresetEntries("a@preset/x, b@preset/x");
    expect(entries.map((entry) => entry.id)).toEqual(["a@preset/x", "b@preset/x"]);
  });
});

describe("provider pinning", () => {
  const base = openrouterProvider().getModels()[0]!;

  it("leaves a model untouched when no order is configured", () => {
    expect(withProviderOrder(base, [])).toBe(base);
  });

  it("puts the order where OpenAI-compatible requests read it", () => {
    const pinned = withProviderOrder(base, ["Wafer", "Z.ai"]);
    expect(pinned.samplingParams).toEqual({ provider: { order: ["Wafer", "Z.ai"] } });
  });
});

describe("the OpenRouter provider", () => {
  it("is skipped when no API key is set", () => {
    expect(createOpenRouterSetup({})).toBeUndefined();
  });

  it("lists every configured preset as a model", () => {
    const setup = createOpenRouterSetup({
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_PRESETS: "fast, smart"
    })!;

    const ids = setup.provider.getModels().map((model) => model.id);
    expect(ids).toContain("@preset/fast");
    expect(ids).toContain("@preset/smart");
    expect(setup.defaultModelId).toBe("@preset/fast");
  });

  it("registers a preset pinned to a specific model", () => {
    const setup = createOpenRouterSetup({
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_PRESETS: "z-ai/glm-5.3-flash@preset/smart"
    })!;

    const pinned = setup.provider.getModels().find(
      (model) => model.id === "z-ai/glm-5.3-flash@preset/smart"
    );
    expect(setup.defaultModelId).toBe("z-ai/glm-5.3-flash@preset/smart");
    expect(pinned?.contextWindow).toBe(1_048_575);
  });

  it("honours the requested default preset", () => {
    const setup = createOpenRouterSetup({
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_PRESETS: "fast, smart",
      OPENROUTER_DEFAULT_PRESET: "@preset/smart"
    })!;
    expect(setup.defaultModelId).toBe("@preset/smart");
  });

  it("selects a pinned preset by its bare slug", () => {
    const setup = createOpenRouterSetup({
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_PRESETS: "z-ai/glm-5.3-flash@preset/smart",
      OPENROUTER_DEFAULT_PRESET: "smart"
    })!;
    expect(setup.defaultModelId).toBe("z-ai/glm-5.3-flash@preset/smart");
  });

  it("ignores a default preset that is not configured", () => {
    const setup = createOpenRouterSetup({
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_PRESETS: "fast",
      OPENROUTER_DEFAULT_PRESET: "missing"
    })!;
    expect(setup.defaultModelId).toBe("@preset/fast");
  });

  it("starts on a plain model when no presets are configured", () => {
    const setup = createOpenRouterSetup({ OPENROUTER_API_KEY: "test-key" })!;
    expect(setup.defaultModelId).toBe("z-ai/glm-5.3-flash");
  });

  it("registers a model the catalogue does not know instead of routing elsewhere", () => {
    const setup = createOpenRouterSetup({
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_MODEL: "inclusionai/ling-3.0-tiny"
    })!;

    const ids = setup.provider.getModels().map((model) => model.id);
    expect(setup.defaultModelId).toBe("inclusionai/ling-3.0-tiny");
    expect(ids).toContain("inclusionai/ling-3.0-tiny");
  });

  it("uses the catalogue head when no model is configured at all", () => {
    const setup = createOpenRouterSetup({ OPENROUTER_API_KEY: "test-key" })!;
    expect(setup.provider.getModels().map((model) => model.id)).toContain(setup.defaultModelId);
  });

  it("pins the provider order from configuration", () => {
    const setup = createOpenRouterSetup({
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_PRESETS: "fast",
      OPENROUTER_PROVIDER_ORDER: "Wafer"
    })!;

    const preset = setup.provider.getModels().find((model) => model.id === "@preset/fast");
    expect(preset?.samplingParams).toEqual({ provider: { order: ["Wafer"] } });
  });

  it("resolves preset auth from the Worker environment", async () => {
    const setup = createOpenRouterSetup({ OPENROUTER_API_KEY: "secret-key" })!;
    const resolved = await setup.provider.auth.apiKey?.resolve({} as never);
    expect(resolved?.auth).toEqual({ apiKey: "secret-key" });
  });
});

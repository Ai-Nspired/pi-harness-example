import { describe, expect, it } from "vitest";
import { compactionBudget } from "../compaction";

describe("the compaction budget", () => {
  it("caps a million-token model at a 100k working context", () => {
    const budget = compactionBudget(1_048_575);

    expect(budget.enabled).toBe(true);
    expect(1_048_575 - budget.reserveTokens).toBe(100_000);
    expect(budget.keepRecentTokens).toBe(25_000);
    expect(budget.backgroundTokens).toBe(20_000);
  });

  it("scales down for a quarter-million-token model", () => {
    const budget = compactionBudget(262_144);

    expect(262_144 - budget.reserveTokens).toBe(65_536);
    expect(budget.keepRecentTokens).toBe(16_384);
  });

  it("never asks for more context than a small model has", () => {
    const budget = compactionBudget(32_768);

    expect(budget.reserveTokens).toBeGreaterThanOrEqual(0);
    expect(32_768 - budget.reserveTokens).toBeGreaterThanOrEqual(8_000);
    expect(budget.keepRecentTokens).toBeLessThan(32_768);
  });

  it("keeps a workable budget even for a tiny window", () => {
    const budget = compactionBudget(16_384);

    expect(budget.reserveTokens).toBeGreaterThan(0);
    expect(16_384 - budget.reserveTokens).toBeGreaterThanOrEqual(8_000);
  });
});

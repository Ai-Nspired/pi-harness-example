/**
 * How much context to allow before pi compacts a conversation.
 *
 * pi's policy triggers near the model's window, which is the wrong ceiling for
 * cost: a 1M-token model would happily resend close to a million tokens per
 * turn before summarising anything. This caps the working context instead, so
 * a long session costs a bounded amount per turn rather than growing without
 * limit.
 */
export interface CompactionBudget {
  readonly enabled: true;
  /** Free room below the window at which compaction blocks generation. */
  readonly reserveTokens: number;
  /** Recent context a summary keeps verbatim. */
  readonly keepRecentTokens: number;
  /** How far below the blocking threshold background compaction starts. */
  readonly backgroundTokens: number;
}

/** Preferred ceiling on input tokens per turn. */
const BUDGET_TOKENS = 100_000;

export function compactionBudget(contextWindow: number): CompactionBudget {
  // A quarter of the window, within [8k, 100k], and always leaving 8k spare so
  // a small-window model compacts instead of refusing every request.
  const budget = Math.min(
    BUDGET_TOKENS,
    Math.max(8_000, Math.floor(contextWindow / 4)),
    Math.max(8_000, contextWindow - 8_000)
  );

  return {
    enabled: true,
    reserveTokens: Math.max(0, contextWindow - budget),
    keepRecentTokens: Math.max(2_000, Math.floor(budget / 4)),
    backgroundTokens: Math.max(0, Math.floor(budget / 5))
  };
}

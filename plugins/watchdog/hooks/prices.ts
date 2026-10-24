import { USD_CENT, USD_DIGITS } from './constants';
import type { TurnUsage } from 'claude-code';

// §15, build-session choice "Price table": USD for each million tokens of each token class, keyed on
// `TurnUsage.model` (the id the API reports). The cache write is the 5-minute write.
// Prices of 2026-10-24, from https://platform.claude.com/docs/en/about-claude/pricing.
type Price = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

// A model priced by prompt length: a request whose prompt is over `LONG_PROMPT_TOKENS` pays the long prices.
type PromptTiers = { readonly short: Price; readonly long: Price };

const HAIKU_4_5: Price = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

const PRICES: Readonly<Record<string, Price | PromptTiers>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': {
    short: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
  'claude-haiku-4-5-20251001': HAIKU_4_5,
  'claude-haiku-4-5': HAIKU_4_5,
};

const TOKENS_PER_PRICE = 1_000_000;

// The pricing page counts a request's prompt as its uncached input, cache reads and cache writes together.
const LONG_PROMPT_TOKENS = 100_000;

const promptTokens = (usage: TurnUsage): number =>
  usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;

// One request's prompt picks its tier. A turn's usage sums its requests, so its prompt bounds each request's: at
// most the threshold, every request paid the short prices; above it, the tier of each request is unknown.
const priceOf = (usage: TurnUsage, isOneRequest: boolean): Price | undefined => {
  const entry = Object.hasOwn(PRICES, usage.model) ? PRICES[usage.model] : undefined;
  if (entry === undefined || !('long' in entry)) {
    return entry;
  }
  if (promptTokens(usage) <= LONG_PROMPT_TOKENS) {
    return entry.short;
  }
  return isOneRequest ? entry.long : undefined;
};

const costAt = (usage: TurnUsage, price: Price | undefined): number | null => {
  if (price === undefined) {
    return null;
  }
  const micro =
    usage.input_tokens * price.input +
    usage.output_tokens * price.output +
    usage.cache_read_input_tokens * price.cacheRead +
    usage.cache_creation_input_tokens * price.cacheWrite;
  return micro / TOKENS_PER_PRICE;
};

// §15: the USD of one request's usage (a `turn.step` result); null for a model that is not in the table.
export const requestCost = (usage: TurnUsage): number | null => costAt(usage, priceOf(usage, true));

// §15: the USD of a turn's usage, its requests summed; null for a model that is not in the table, and for a model
// priced by prompt length when the sum does not tell each request's tier.
export const turnCost = (usage: TurnUsage): number | null => costAt(usage, priceOf(usage, false));

// A sum of review costs: the USD of the priced reviews, and whether any review had a price or ran a model that
// is not in the table.
export type Cost = { readonly usd: number; readonly hasPrice: boolean; readonly hasUnpriced: boolean };

export const NO_COST: Cost = { usd: 0, hasPrice: false, hasUnpriced: false };

const usdText = (usd: number): string => (usd > 0 && usd < USD_CENT ? '<$0.01' : `$${usd.toFixed(USD_DIGITS)}`);

// §13.3, §15: `$0.15`; `$?` when no review had a price; `$0.15+?` when some had none.
export const costText = (cost: Cost): string => {
  if (!cost.hasUnpriced) {
    return usdText(cost.usd);
  }
  return cost.hasPrice ? `${usdText(cost.usd)}+?` : '$?';
};

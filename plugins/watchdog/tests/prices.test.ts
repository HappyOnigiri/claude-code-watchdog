import { describe, expect, test } from 'claude-code/testing';
import { costText, requestCost, turnCost } from '../hooks/prices';

const usage = (model: string, cacheRead = 100_000) => ({
  input_tokens: 10_000,
  output_tokens: 2_000,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: 4_000,
  model,
});

describe('price table (§15)', () => {
  test('a review costs each token class at its price per million tokens of the model that ran', () => {
    // Sonnet 5.5: $2 input, $10 output, $0.10 cache read, $2.50 cache write per million.
    // 0.02 + 0.02 + 0.01 + 0.01 = $0.06.
    expect(turnCost(usage('claude-sonnet-5-5'))?.toFixed(6)).toBe('0.060000');
    // Opus 5.5: $4, $20, $0.20, $5. 0.04 + 0.04 + 0.02 + 0.02 = $0.12.
    expect(turnCost(usage('claude-opus-5-5'))?.toFixed(6)).toBe('0.120000');
    // Haiku 4.5, by its id and by its alias: $1, $5, $0.10, $1.25. 0.01 + 0.01 + 0.01 + 0.005 = $0.035.
    expect(turnCost(usage('claude-haiku-4-5-20251001'))?.toFixed(6)).toBe('0.035000');
    expect(turnCost(usage('claude-haiku-4-5'))?.toFixed(6)).toBe('0.035000');
  });

  test('Haiku 5.5 prices a request by its prompt: up to 100,000 tokens short, over it long', () => {
    // A prompt of 10k + 86k + 4k = 100,000 tokens. Short: $0.10, $0.50, $0.01, $0.125.
    // 0.001 + 0.001 + 0.00086 + 0.0005 = $0.00336.
    expect(requestCost(usage('claude-haiku-5-5', 86_000))?.toFixed(6)).toBe('0.003360');
    // A prompt of 114,000 tokens. Long: $0.50, $2.50, $0.05, $0.625. 0.005 + 0.005 + 0.005 + 0.0025 = $0.0175.
    expect(requestCost(usage('claude-haiku-5-5'))?.toFixed(6)).toBe('0.017500');
  });

  test("Haiku 5.5's summed usage of a turn has a price only while the sum stays in the short tier", () => {
    expect(turnCost(usage('claude-haiku-5-5', 86_000))?.toFixed(6)).toBe('0.003360');
    expect(turnCost(usage('claude-haiku-5-5'))).toBeNull();
  });

  test('a model that is not in the table has no price', () => {
    for (const cost of [requestCost, turnCost]) {
      expect(cost(usage('claude-opus-4-5'))).toBeNull();
      expect(cost(usage('opus'))).toBeNull();
      expect(cost(usage('constructor'))).toBeNull();
    }
  });

  test('a cost shows in dollars and cents; an unknown price shows `$?`', () => {
    expect(costText({ usd: 0.1549, hasPrice: true, hasUnpriced: false })).toBe('$0.15');
    expect(costText({ usd: 0, hasPrice: false, hasUnpriced: false })).toBe('$0.00');
    expect(costText({ usd: 0.004, hasPrice: true, hasUnpriced: false })).toBe('<$0.01');
    expect(costText({ usd: 0, hasPrice: false, hasUnpriced: true })).toBe('$?');
    expect(costText({ usd: 1.2, hasPrice: true, hasUnpriced: true })).toBe('$1.20+?');
  });
});

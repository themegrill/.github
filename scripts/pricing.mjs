// USD per 1M tokens, [input, output]. Used only to estimate cost for the
// dashboard where the provider doesn't report one itself (the Stage 1
// classifier: OpenAI returns tokens, not dollars). Verify against
// platform.openai.com/docs/pricing before trusting totals, and add a row when
// CLASSIFY_MODEL changes -- an unknown model yields null, never a guess.
const PRICES_PER_MILLION = {
  "gpt-5-mini": [0.25, 2.0],
  "gpt-5-nano": [0.05, 0.4],
  "gpt-5": [1.25, 10.0],
};

export function costUSD(model, inputTokens, outputTokens) {
  const key = String(model ?? "").replace(/^openai\//, "");
  const price = PRICES_PER_MILLION[key];
  if (!price || typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
  return (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000;
}

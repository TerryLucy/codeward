import type { ModelSpec } from "./types.ts";

/**
 * Built-in model catalog. Prices are USD per 1M tokens and are only used for routing and
 * budget estimates. Override or extend via `models.catalog` in `.codeward.yml`.
 */
export const BUILTIN_MODELS: ModelSpec[] = [
  {
    id: "anthropic/claude-opus-4-1",
    provider: "anthropic",
    name: "claude-opus-4-1",
    tier: "frontier",
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    inputCostPerMTok: 15,
    outputCostPerMTok: 75,
    strengths: ["review", "security"],
  },
  {
    id: "anthropic/claude-sonnet-4-5",
    provider: "anthropic",
    name: "claude-sonnet-4-5",
    tier: "balanced",
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    inputCostPerMTok: 3,
    outputCostPerMTok: 15,
    strengths: ["review", "security", "summary"],
  },
  {
    id: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    name: "claude-haiku-4-5",
    tier: "fast",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    inputCostPerMTok: 1,
    outputCostPerMTok: 5,
    strengths: ["summary", "review"],
  },
  {
    id: "openai/gpt-5",
    provider: "openai",
    name: "gpt-5",
    tier: "frontier",
    contextWindow: 400_000,
    maxOutputTokens: 32_000,
    inputCostPerMTok: 1.25,
    outputCostPerMTok: 10,
    strengths: ["review", "security"],
  },
  {
    id: "openai/gpt-5-mini",
    provider: "openai",
    name: "gpt-5-mini",
    tier: "balanced",
    contextWindow: 400_000,
    maxOutputTokens: 32_000,
    inputCostPerMTok: 0.25,
    outputCostPerMTok: 2,
    strengths: ["review", "summary"],
  },
  {
    id: "openai/gpt-5-nano",
    provider: "openai",
    name: "gpt-5-nano",
    tier: "fast",
    contextWindow: 400_000,
    maxOutputTokens: 16_000,
    inputCostPerMTok: 0.05,
    outputCostPerMTok: 0.4,
    strengths: ["summary"],
  },
  {
    id: "google/gemini-2.5-pro",
    provider: "google",
    name: "gemini-2.5-pro",
    tier: "frontier",
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    inputCostPerMTok: 1.25,
    outputCostPerMTok: 10,
    strengths: ["review", "security"],
  },
  {
    id: "google/gemini-2.5-flash",
    provider: "google",
    name: "gemini-2.5-flash",
    tier: "fast",
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    inputCostPerMTok: 0.3,
    outputCostPerMTok: 2.5,
    strengths: ["summary", "review"],
  },
  {
    id: "mock/mock",
    provider: "mock",
    name: "mock",
    tier: "balanced",
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    inputCostPerMTok: 0,
    outputCostPerMTok: 0,
    strengths: ["review", "security", "summary"],
  },
];

export function buildCatalog(overrides: ModelSpec[]): ModelSpec[] {
  const byId = new Map(BUILTIN_MODELS.map((m) => [m.id, m]));
  for (const m of overrides) byId.set(m.id, m);
  return [...byId.values()];
}

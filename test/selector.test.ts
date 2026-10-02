import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config.ts";
import { buildCatalog } from "../src/models/registry.ts";
import { desiredTier, resolveModelId, selectModels } from "../src/models/selector.ts";
import type { ProviderId } from "../src/models/types.ts";

const catalog = buildCatalog([]);
const base = {
  estimatedInputTokens: 10_000,
  sensitive: false,
  catalog,
  remainingBudgetUsd: 5,
};

test("desiredTier maps task, quality and sensitivity", () => {
  assert.equal(desiredTier("summary", "balanced", false), "fast");
  assert.equal(desiredTier("review", "balanced", false), "balanced");
  assert.equal(desiredTier("review", "balanced", true), "frontier");
  assert.equal(desiredTier("security", "balanced", false), "frontier");
  assert.equal(desiredTier("security", "economy", false), "balanced");
  assert.equal(desiredTier("review", "economy", false), "fast");
});

test("auto selection prefers tier fit and diversifies fallbacks across providers", () => {
  const models = defaultConfig().models;
  const available = new Set<ProviderId>(["anthropic", "openai", "google"]);
  const review = selectModels({ ...base, task: "review", availableProviders: available, models });
  assert.equal(review.candidates[0]?.id, "anthropic/claude-sonnet-4-5");
  assert.deepEqual(review.candidates.slice(0, 3).map((m) => m.provider), ["anthropic", "openai", "google"]);

  const security = selectModels({ ...base, task: "security", availableProviders: available, models });
  assert.equal(security.candidates[0]?.tier, "frontier");

  const summary = selectModels({ ...base, task: "summary", availableProviders: available, models });
  assert.equal(summary.candidates[0]?.id, "anthropic/claude-haiku-4-5");
});

test("only providers with credentials are selected", () => {
  const models = defaultConfig().models;
  const sel = selectModels({ ...base, task: "review", availableProviders: new Set<ProviderId>(["google"]), models });
  assert.ok(sel.candidates.every((m) => m.provider === "google"));
});

test("models that cannot fit the prompt are excluded", () => {
  const models = defaultConfig().models;
  const sel = selectModels({
    ...base,
    estimatedInputTokens: 500_000,
    task: "review",
    availableProviders: new Set<ProviderId>(["anthropic", "google"]),
    models,
  });
  assert.ok(sel.candidates.every((m) => m.provider === "google"));
});

test("pinned models win and unknown ids resolve to ad-hoc specs", () => {
  const models = { ...defaultConfig().models, review: ["openai-compatible/qwen3-coder", "openai/gpt-5"] };
  const sel = selectModels({
    ...base,
    task: "review",
    availableProviders: new Set<ProviderId>(["openai-compatible", "openai"]),
    models,
  });
  assert.deepEqual(sel.candidates.map((m) => m.id), ["openai-compatible/qwen3-coder", "openai/gpt-5"]);
  assert.equal(resolveModelId("openai-compatible/qwen3-coder", catalog).name, "qwen3-coder");
  assert.throws(() => resolveModelId("nope", catalog));
});

test("pinned model without credentials is a clear error", () => {
  const models = { ...defaultConfig().models, security: "anthropic/claude-opus-4-1" };
  assert.throws(
    () => selectModels({ ...base, task: "security", availableProviders: new Set<ProviderId>(["openai"]), models }),
    /No credentials/,
  );
});

test("falls back to mock only when no real provider is configured", () => {
  const models = defaultConfig().models;
  const sel = selectModels({ ...base, task: "review", availableProviders: new Set<ProviderId>(["mock"]), models });
  assert.equal(sel.candidates[0]?.id, "mock/mock");
});

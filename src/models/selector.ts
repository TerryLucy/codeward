import type { Config, ModelChoice } from "../config.ts";
import type { ReviewTask } from "../types.ts";
import type { ModelSpec, ModelTier, ProviderId } from "./types.ts";

export interface SelectionContext {
  task: ReviewTask;
  estimatedInputTokens: number;
  /** True when the chunk touches paths matching `review.sensitivePaths`. */
  sensitive: boolean;
  /** Providers with credentials configured. */
  availableProviders: ReadonlySet<ProviderId>;
  catalog: ModelSpec[];
  models: Config["models"];
  /** Remaining budget for the whole review (USD). */
  remainingBudgetUsd: number;
}

export interface Selection {
  candidates: ModelSpec[];
  reason: string;
}

const TIERS: ModelTier[] = ["fast", "balanced", "frontier"];

export function desiredTier(task: ReviewTask, quality: Config["models"]["quality"], sensitive: boolean): ModelTier {
  if (task === "summary") return quality === "max" ? "balanced" : "fast";
  const base: ModelTier = task === "security" ? "frontier" : "balanced";
  const shift = quality === "economy" ? -1 : quality === "max" ? 1 : 0;
  const bump = sensitive && task === "review" ? 1 : 0;
  const idx = Math.max(0, Math.min(TIERS.length - 1, TIERS.indexOf(base) + shift + bump));
  return TIERS[idx] ?? base;
}

export function estimateCostUsd(model: ModelSpec, inputTokens: number, outputTokens: number): number {
  return (inputTokens * model.inputCostPerMTok + outputTokens * model.outputCostPerMTok) / 1_000_000;
}

export function resolveModelId(id: string, catalog: ModelSpec[]): ModelSpec {
  const found = catalog.find((m) => m.id === id);
  if (found) return found;
  const slash = id.indexOf("/");
  if (slash <= 0) throw new Error(`Unknown model "${id}". Use "<provider>/<model>", e.g. "anthropic/claude-sonnet-4-5".`);
  const provider = id.slice(0, slash);
  const providers: ProviderId[] = ["anthropic", "openai", "google", "openai-compatible", "mock"];
  const match = providers.find((p) => p === provider);
  if (!match) throw new Error(`Unknown provider "${provider}" in model "${id}".`);
  return {
    id,
    provider: match,
    name: id.slice(slash + 1),
    tier: "balanced",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputCostPerMTok: 0,
    outputCostPerMTok: 0,
    strengths: ["review", "security", "summary"],
  };
}

function choiceFor(task: ReviewTask, models: Config["models"]): ModelChoice {
  return models[task];
}

/**
 * Picks an ordered candidate list (primary first, then fallbacks) for a task.
 * Explicit config pins win; otherwise models are scored by tier fit, task strength,
 * provider preference and estimated cost, and fallbacks are diversified across providers.
 */
export function selectModels(ctx: SelectionContext): Selection {
  const choice = choiceFor(ctx.task, ctx.models);
  const outputReserve = ctx.task === "summary" ? 2_000 : 8_000;
  const fits = (m: ModelSpec) => m.contextWindow >= Math.ceil(ctx.estimatedInputTokens * 1.1) + outputReserve;

  if (choice !== "auto") {
    const ids = Array.isArray(choice) ? choice : [choice];
    const pinned = ids.map((id) => resolveModelId(id, ctx.catalog));
    const usable = pinned.filter((m) => ctx.availableProviders.has(m.provider));
    if (usable.length === 0) {
      throw new Error(
        `No credentials for pinned ${ctx.task} model(s): ${ids.join(", ")}. ` +
          `Set the provider API key or change models.${ctx.task}.`,
      );
    }
    return { candidates: usable, reason: `pinned via models.${ctx.task}` };
  }

  const tier = desiredTier(ctx.task, ctx.models.quality, ctx.sensitive);
  const preference = ctx.models.providers;
  const pool = ctx.catalog.filter(
    (m) =>
      m.provider !== "mock" &&
      ctx.availableProviders.has(m.provider) &&
      preference.includes(m.provider) &&
      fits(m),
  );
  if (pool.length === 0) {
    if (ctx.availableProviders.has("mock")) {
      const mock = ctx.catalog.find((m) => m.provider === "mock");
      if (mock) return { candidates: [mock], reason: "mock provider (no API keys configured)" };
    }
    throw new Error(
      "No usable model: configure at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY " +
        "or an openai-compatible endpoint (or pin models explicitly).",
    );
  }

  const maxCost = Math.max(...pool.map((m) => estimateCostUsd(m, ctx.estimatedInputTokens, outputReserve)), 1e-9);
  const scored = pool
    .map((m) => {
      const cost = estimateCostUsd(m, ctx.estimatedInputTokens, outputReserve);
      const tierDistance = Math.abs(TIERS.indexOf(m.tier) - TIERS.indexOf(tier));
      const overBudget = cost > ctx.remainingBudgetUsd;
      const score =
        tierDistance * 10 +
        (m.strengths.includes(ctx.task) ? 0 : 4) +
        preference.indexOf(m.provider) * 1.5 +
        (cost / maxCost) * 2 +
        (overBudget ? 100 : 0);
      return { m, score };
    })
    .sort((a, b) => a.score - b.score);

  const ordered: ModelSpec[] = [];
  const seenProviders = new Set<ProviderId>();
  for (const { m } of scored) {
    if (!seenProviders.has(m.provider)) {
      ordered.push(m);
      seenProviders.add(m.provider);
    }
  }
  for (const { m } of scored) if (!ordered.includes(m)) ordered.push(m);

  return {
    candidates: ordered.slice(0, 4),
    reason: `auto: task=${ctx.task} tier=${tier}${ctx.sensitive ? " (sensitive paths)" : ""} quality=${ctx.models.quality}`,
  };
}

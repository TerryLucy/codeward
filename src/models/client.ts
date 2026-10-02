import type { Config } from "../config.ts";
import type { ReviewTask, Usage } from "../types.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { GoogleProvider } from "./providers/google.ts";
import { MockProvider } from "./providers/mock.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { buildCatalog } from "./registry.ts";
import { estimateCostUsd, selectModels } from "./selector.ts";
import type { ChatRequest, ChatResponse, ModelSpec, Provider, ProviderId } from "./types.ts";
import { ProviderError } from "./types.ts";

export interface CompletionResult extends ChatResponse {
  model: ModelSpec;
}

export interface ModelClientOptions {
  models: Config["models"];
  maxCostUsd: number;
  providers: Map<ProviderId, Provider>;
  logger?: (msg: string) => void;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class BudgetExceededError extends Error {
  constructor(spent: number, cap: number) {
    super(`Review budget exhausted: spent $${spent.toFixed(4)} of $${cap.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}

export function providersFromEnv(
  models: Config["models"],
  env: Record<string, string | undefined> = process.env,
): Map<ProviderId, Provider> {
  const providers = new Map<ProviderId, Provider>();
  if (env.ANTHROPIC_API_KEY) providers.set("anthropic", new AnthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_BASE_URL));
  if (env.OPENAI_API_KEY) providers.set("openai", new OpenAIProvider("openai", env.OPENAI_API_KEY, env.OPENAI_BASE_URL));
  const googleKey = env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY;
  if (googleKey) providers.set("google", new GoogleProvider(googleKey));
  const compatUrl = models.openaiCompatible.baseUrl ?? env.OPENAI_COMPATIBLE_BASE_URL;
  if (compatUrl) {
    providers.set(
      "openai-compatible",
      new OpenAIProvider("openai-compatible", env[models.openaiCompatible.apiKeyEnv] ?? "", compatUrl),
    );
  }
  const wantsMock = env.CODEWARD_MOCK === "1" || [models.review, models.security, models.summary].flat().some((m) => m.startsWith("mock/"));
  if (wantsMock || providers.size === 0) providers.set("mock", new MockProvider());
  return providers;
}

/**
 * Runs a completion for a task: selects candidate models, retries transient failures with
 * exponential backoff, falls back to the next candidate, and tracks token usage and spend.
 */
export class ModelClient {
  readonly usage: Usage[] = [];
  private readonly catalog: ModelSpec[];
  private readonly opts: ModelClientOptions;
  private readonly log: (msg: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ModelClientOptions) {
    this.opts = opts;
    this.catalog = buildCatalog(opts.models.catalog);
    this.log = opts.logger ?? (() => {});
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get spentUsd(): number {
    return this.usage.reduce((sum, u) => sum + u.costUsd, 0);
  }

  get availableProviders(): ReadonlySet<ProviderId> {
    return new Set(this.opts.providers.keys());
  }

  get models(): ModelSpec[] {
    return this.catalog;
  }

  async complete(
    task: ReviewTask,
    req: Omit<ChatRequest, "maxOutputTokens"> & { maxOutputTokens?: number },
    opts: { sensitive?: boolean } = {},
  ): Promise<CompletionResult> {
    const remaining = this.opts.maxCostUsd - this.spentUsd;
    if (remaining <= 0) throw new BudgetExceededError(this.spentUsd, this.opts.maxCostUsd);

    const estimatedInputTokens = Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    const selection = selectModels({
      task,
      estimatedInputTokens,
      sensitive: opts.sensitive ?? false,
      availableProviders: this.availableProviders,
      catalog: this.catalog,
      models: this.opts.models,
      remainingBudgetUsd: remaining,
    });
    this.log(`[${task}] candidates: ${selection.candidates.map((m) => m.id).join(" -> ")} (${selection.reason})`);

    const maxRetries = this.opts.maxRetries ?? 2;
    const errors: string[] = [];
    for (const model of selection.candidates) {
      const provider = this.opts.providers.get(model.provider);
      if (!provider) continue;
      const maxOutputTokens = Math.min(req.maxOutputTokens ?? 8_000, model.maxOutputTokens);
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const started = Date.now();
        try {
          const res = await provider.complete(model, { ...req, maxOutputTokens });
          const costUsd = estimateCostUsd(model, res.inputTokens, res.outputTokens);
          this.usage.push({
            model: model.id,
            task,
            inputTokens: res.inputTokens,
            outputTokens: res.outputTokens,
            costUsd,
            latencyMs: Date.now() - started,
          });
          return { ...res, model };
        } catch (err) {
          const retryable = err instanceof ProviderError && err.retryable;
          errors.push(`${model.id}: ${err instanceof Error ? err.message : String(err)}`);
          this.log(`[${task}] ${model.id} attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
          if (!retryable || attempt === maxRetries) break;
          await this.sleep(Math.min(8_000, 500 * 2 ** attempt + Math.random() * 250));
        }
      }
    }
    throw new Error(`All models failed for ${task}:\n${errors.join("\n")}`);
  }
}

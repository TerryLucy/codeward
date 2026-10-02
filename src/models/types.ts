import type { ReviewTask } from "../types.ts";

export type ProviderId = "anthropic" | "openai" | "google" | "openai-compatible" | "mock";

export type ModelTier = "fast" | "balanced" | "frontier";

export interface ModelSpec {
  /** Fully qualified id, `<provider>/<model>`. */
  id: string;
  provider: ProviderId;
  /** Model name sent to the provider API. */
  name: string;
  tier: ModelTier;
  contextWindow: number;
  maxOutputTokens: number;
  /** USD per 1M input tokens. */
  inputCostPerMTok: number;
  /** USD per 1M output tokens. */
  outputCostPerMTok: number;
  strengths: ReviewTask[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxOutputTokens: number;
  temperature?: number;
  json?: boolean;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface Provider {
  id: ProviderId;
  complete(model: ModelSpec, req: ChatRequest): Promise<ChatResponse>;
}

export class ProviderError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, status: number | undefined, retryable: boolean) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.retryable = retryable;
  }
}

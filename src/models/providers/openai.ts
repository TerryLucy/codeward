import type { ChatRequest, ChatResponse, ModelSpec, Provider, ProviderId } from "../types.ts";
import { asArray, asNumber, asRecord, asString, postJson } from "./http.ts";

/**
 * Chat Completions client. `openai` targets api.openai.com; `openai-compatible`
 * targets any server implementing the same API (OpenRouter, Azure OpenAI v1, vLLM, Ollama, LiteLLM...).
 */
export class OpenAIProvider implements Provider {
  readonly id: ProviderId;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(id: "openai" | "openai-compatible", apiKey: string, baseUrl = "https://api.openai.com/v1") {
    this.id = id;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async complete(model: ModelSpec, req: ChatRequest): Promise<ChatResponse> {
    const official = this.id === "openai";
    const body: Record<string, unknown> = {
      model: model.name,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (official) {
      body.max_completion_tokens = req.maxOutputTokens;
    } else {
      body.max_tokens = req.maxOutputTokens;
      body.temperature = req.temperature ?? 0;
    }
    if (req.json) body.response_format = { type: "json_object" };

    const headers: Record<string, string> = {};
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const raw = await postJson(`${this.baseUrl}/chat/completions`, headers, body, req.signal);
    const data = asRecord(raw);
    const choice = asRecord(asArray(data.choices)[0]);
    const text = asString(asRecord(choice.message).content);
    const usage = asRecord(data.usage);
    return { text, inputTokens: asNumber(usage.prompt_tokens), outputTokens: asNumber(usage.completion_tokens) };
  }
}

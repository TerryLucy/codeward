import type { ChatRequest, ChatResponse, ModelSpec, Provider } from "../types.ts";
import { asArray, asNumber, asRecord, asString, postJson } from "./http.ts";

export class AnthropicProvider implements Provider {
  readonly id = "anthropic" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.anthropic.com") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async complete(model: ModelSpec, req: ChatRequest): Promise<ChatResponse> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    const raw = await postJson(
      `${this.baseUrl}/v1/messages`,
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      {
        model: model.name,
        max_tokens: req.maxOutputTokens,
        temperature: req.temperature ?? 0,
        ...(system ? { system } : {}),
        messages,
      },
      req.signal,
    );
    const data = asRecord(raw);
    const text = asArray(data.content)
      .map((block) => asRecord(block))
      .filter((block) => block.type === "text")
      .map((block) => asString(block.text))
      .join("");
    const usage = asRecord(data.usage);
    return { text, inputTokens: asNumber(usage.input_tokens), outputTokens: asNumber(usage.output_tokens) };
  }
}

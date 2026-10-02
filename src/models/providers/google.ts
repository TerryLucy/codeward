import type { ChatRequest, ChatResponse, ModelSpec, Provider } from "../types.ts";
import { asArray, asNumber, asRecord, asString, postJson } from "./http.ts";

export class GoogleProvider implements Provider {
  readonly id = "google" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://generativelanguage.googleapis.com/v1beta") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async complete(model: ModelSpec, req: ChatRequest): Promise<ChatResponse> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const contents = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const raw = await postJson(
      `${this.baseUrl}/models/${encodeURIComponent(model.name)}:generateContent`,
      { "x-goog-api-key": this.apiKey },
      {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        generationConfig: {
          maxOutputTokens: req.maxOutputTokens,
          temperature: req.temperature ?? 0,
          ...(req.json ? { responseMimeType: "application/json" } : {}),
        },
      },
      req.signal,
    );
    const data = asRecord(raw);
    const candidate = asRecord(asArray(data.candidates)[0]);
    const text = asArray(asRecord(candidate.content).parts)
      .map((p) => asString(asRecord(p).text))
      .join("");
    const usage = asRecord(data.usageMetadata);
    return {
      text,
      inputTokens: asNumber(usage.promptTokenCount),
      outputTokens: asNumber(usage.candidatesTokenCount),
    };
  }
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config.ts";
import { BudgetExceededError, ModelClient } from "../src/models/client.ts";
import type { ChatRequest, ChatResponse, ModelSpec, Provider, ProviderId } from "../src/models/types.ts";
import { ProviderError } from "../src/models/types.ts";

class ScriptedProvider implements Provider {
  readonly id: ProviderId;
  calls: string[] = [];
  private readonly script: (model: ModelSpec, n: number) => ChatResponse | Error;

  constructor(id: ProviderId, script: (model: ModelSpec, n: number) => ChatResponse | Error) {
    this.id = id;
    this.script = script;
  }

  async complete(model: ModelSpec, _req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(model.id);
    const r = this.script(model, this.calls.length);
    if (r instanceof Error) throw r;
    return r;
  }
}

const ok = (text = "{}"): ChatResponse => ({ text, inputTokens: 1_000, outputTokens: 100 });
const noSleep = async () => {};

test("retries transient errors then succeeds", async () => {
  const anthropic = new ScriptedProvider("anthropic", (_m, n) => (n < 2 ? new ProviderError("429", 429, true) : ok()));
  const client = new ModelClient({
    models: defaultConfig().models,
    maxCostUsd: 1,
    providers: new Map([["anthropic", anthropic]]),
    sleep: noSleep,
  });
  const res = await client.complete("review", { messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.model.id, "anthropic/claude-sonnet-4-5");
  assert.equal(anthropic.calls.length, 2);
  assert.equal(client.usage.length, 1);
  assert.ok(client.spentUsd > 0);
});

test("falls back to another provider on non-retryable failure", async () => {
  const anthropic = new ScriptedProvider("anthropic", () => new ProviderError("401", 401, false));
  const openai = new ScriptedProvider("openai", () => ok());
  const client = new ModelClient({
    models: defaultConfig().models,
    maxCostUsd: 1,
    providers: new Map<ProviderId, Provider>([
      ["anthropic", anthropic],
      ["openai", openai],
    ]),
    sleep: noSleep,
  });
  const res = await client.complete("review", { messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.model.provider, "openai");
  assert.equal(anthropic.calls.length, 1);
});

test("enforces the review budget", async () => {
  const anthropic = new ScriptedProvider("anthropic", () => ({ text: "{}", inputTokens: 1_000_000, outputTokens: 0 }));
  const client = new ModelClient({
    models: defaultConfig().models,
    maxCostUsd: 1,
    providers: new Map([["anthropic", anthropic]]),
    sleep: noSleep,
  });
  await client.complete("review", { messages: [{ role: "user", content: "hi" }] });
  await assert.rejects(client.complete("review", { messages: [{ role: "user", content: "hi" }] }), BudgetExceededError);
});

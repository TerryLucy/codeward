import type { ChatRequest, ChatResponse, ModelSpec, Provider } from "../types.ts";

const RULES: { pattern: RegExp; severity: string; category: string; title: string; body: string; cwe?: string }[] = [
  {
    pattern: /\beval\s*\(/,
    severity: "high",
    category: "security",
    title: "Use of eval",
    body: "`eval` executes arbitrary code and is a common injection vector.",
    cwe: "CWE-95",
  },
  {
    pattern: /(SELECT|INSERT|UPDATE|DELETE)\b[^\n]*(\+\s*\w|\$\{)/i,
    severity: "high",
    category: "security",
    title: "Possible SQL injection",
    body: "SQL is built via string concatenation/interpolation. Use parameterized queries.",
    cwe: "CWE-89",
  },
  {
    pattern: /\bTODO\b|\bFIXME\b/,
    severity: "info",
    category: "maintainability",
    title: "Unresolved TODO",
    body: "Consider tracking this in an issue instead of leaving it in code.",
  },
];

/**
 * Deterministic offline provider. Applies a few regex heuristics to added diff lines so the full
 * pipeline (selection, parsing, anchoring, posting) can be exercised without API keys.
 */
export class MockProvider implements Provider {
  readonly id = "mock" as const;

  async complete(_model: ModelSpec, req: ChatRequest): Promise<ChatResponse> {
    const user = req.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    const inputTokens = Math.ceil(user.length / 4);
    if (!req.json) {
      return { text: "Mock summary: changes reviewed with the offline mock model.", inputTokens, outputTokens: 12 };
    }
    if (user.includes("<findings>")) {
      return {
        text: JSON.stringify({ summary: "Mock summary: changes reviewed with the offline mock model.", verdict: "comment" }),
        inputTokens,
        outputTokens: 20,
      };
    }
    const findings: Record<string, unknown>[] = [];
    let currentFile = "";
    for (const line of user.split("\n")) {
      const file = /^### File: (.+)$/.exec(line);
      if (file?.[1]) {
        currentFile = file[1].trim();
        continue;
      }
      const added = /^\s*(\d+)\s*\+(.*)$/.exec(line);
      if (!added?.[1] || added[2] === undefined || !currentFile) continue;
      for (const rule of RULES) {
        if (rule.pattern.test(added[2])) {
          findings.push({
            path: currentFile,
            line: Number(added[1]),
            severity: rule.severity,
            category: rule.category,
            title: rule.title,
            body: rule.body,
            confidence: 0.9,
            ...(rule.cwe ? { cwe: rule.cwe } : {}),
          });
        }
      }
    }
    const text = JSON.stringify({ findings });
    return { text, inputTokens, outputTokens: Math.ceil(text.length / 4) };
  }
}

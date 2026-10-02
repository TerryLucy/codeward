import type { Finding, Severity } from "../types.ts";
import type { FileDiff } from "./diff.ts";
import { addedLines } from "./diff.ts";

interface SecretRule {
  id: string;
  title: string;
  pattern: RegExp;
  severity: Severity;
  /** Capture group holding the secret value (defaults to the whole match). */
  group?: number;
  minEntropy?: number;
}

const RULES: SecretRule[] = [
  { id: "aws-access-key", title: "AWS access key ID", pattern: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/, severity: "critical" },
  { id: "github-token", title: "GitHub token", pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,255})\b/, severity: "critical" },
  { id: "github-pat", title: "GitHub fine-grained token", pattern: /\b(github_pat_[A-Za-z0-9_]{60,255})\b/, severity: "critical" },
  { id: "anthropic-key", title: "Anthropic API key", pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})/, severity: "critical" },
  { id: "openai-key", title: "OpenAI API key", pattern: /\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,})/, severity: "critical", minEntropy: 3.5 },
  { id: "google-api-key", title: "Google API key", pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/, severity: "high" },
  { id: "slack-token", title: "Slack token", pattern: /\b(xox[abprs]-[A-Za-z0-9-]{10,})/, severity: "high" },
  { id: "stripe-live-key", title: "Stripe live secret key", pattern: /\b((?:sk|rk)_live_[0-9A-Za-z]{20,})/, severity: "critical" },
  { id: "private-key", title: "Private key", pattern: /(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----)/, severity: "critical" },
  {
    id: "generic-secret",
    title: "Hardcoded credential",
    pattern: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i,
    severity: "high",
    group: 1,
    minEntropy: 3.5,
  },
];

const PLACEHOLDER = /(example|sample|dummy|placeholder|changeme|your[_-]?|xxx+|\*\*\*|<[^>]+>|\$\{|\{\{|process\.env|os\.environ|getenv|redacted|test)/i;

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function redact(secret: string): string {
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}…${secret.slice(-2)} (${secret.length} chars)`;
}

/** Deterministic secret detection on added lines; complements the LLM security pass. */
export function scanSecrets(files: FileDiff[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    for (const line of addedLines(file)) {
      if (line.newLine === undefined) continue;
      for (const rule of RULES) {
        const m = rule.pattern.exec(line.text);
        if (!m) continue;
        const value = m[rule.group ?? 1] ?? m[0];
        if (rule.id !== "private-key" && PLACEHOLDER.test(value)) continue;
        if (rule.minEntropy !== undefined && shannonEntropy(value) < rule.minEntropy) continue;
        findings.push({
          path: file.path,
          line: line.newLine,
          severity: rule.severity,
          category: "security",
          title: `${rule.title} committed to source`,
          body:
            `A value matching \`${rule.id}\` (${redact(value)}) was added in this change. ` +
            "Treat it as compromised: revoke/rotate it, remove it from git history, and load it from a secret manager or environment variable instead.",
          cwe: "CWE-798",
          confidence: rule.id === "generic-secret" ? 0.7 : 0.95,
          source: "secret-scanner",
        });
        break;
      }
    }
  }
  return findings;
}

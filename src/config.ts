import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SEVERITIES } from "./types.ts";

const severity = z.enum(SEVERITIES);
const providerId = z.enum(["anthropic", "openai", "google", "openai-compatible", "mock"]);
const modelChoice = z.union([z.literal("auto"), z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const modelSpecSchema = z.object({
  id: z.string().min(1),
  provider: providerId,
  name: z.string().min(1),
  tier: z.enum(["fast", "balanced", "frontier"]).default("balanced"),
  contextWindow: z.number().int().positive().default(128_000),
  maxOutputTokens: z.number().int().positive().default(8_192),
  inputCostPerMTok: z.number().nonnegative().default(0),
  outputCostPerMTok: z.number().nonnegative().default(0),
  strengths: z.array(z.enum(["review", "security", "summary"])).default(["review", "security", "summary"]),
});

export const DEFAULT_EXCLUDES = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/go.sum",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/dist/**",
  "**/build/**",
  "**/vendor/**",
  "**/node_modules/**",
  "**/*.snap",
  "**/*.{png,jpg,jpeg,gif,webp,ico,pdf,zip,gz,woff,woff2,ttf,eot}",
];

export const DEFAULT_SENSITIVE_PATHS = [
  "**/auth/**",
  "**/*auth*.*",
  "**/*crypto*.*",
  "**/*secret*.*",
  "**/*token*.*",
  "**/*password*.*",
  "**/security/**",
  "**/middleware/**",
  "**/.github/workflows/**",
  "**/Dockerfile",
  "**/*.tf",
  "**/migrations/**",
];

export const configSchema = z.object({
  models: z
    .object({
      quality: z.enum(["economy", "balanced", "max"]).default("balanced"),
      review: modelChoice.default("auto"),
      security: modelChoice.default("auto"),
      summary: modelChoice.default("auto"),
      providers: z.array(providerId).default(["anthropic", "openai", "google", "openai-compatible"]),
      catalog: z.array(modelSpecSchema).default([]),
      openaiCompatible: z
        .object({
          baseUrl: z.string().url().optional(),
          apiKeyEnv: z.string().default("OPENAI_COMPATIBLE_API_KEY"),
        })
        .prefault({}),
    })
    .prefault({}),
  review: z
    .object({
      enabled: z.boolean().default(true),
      security: z.boolean().default(true),
      secretScan: z.boolean().default(true),
      minSeverity: severity.default("low"),
      failOn: z.union([severity, z.literal("none")]).default("high"),
      minConfidence: z.number().min(0).max(1).default(0.5),
      maxComments: z.number().int().nonnegative().default(25),
      maxFiles: z.number().int().positive().default(150),
      maxCostUsd: z.number().positive().default(2),
      concurrency: z.number().int().positive().max(16).default(4),
      chunkTokens: z.number().int().positive().default(24_000),
      include: z.array(z.string()).default(["**"]),
      exclude: z.array(z.string()).default([]),
      sensitivePaths: z.array(z.string()).default(DEFAULT_SENSITIVE_PATHS),
      instructions: z.string().default(""),
      incremental: z.boolean().default(true),
      skipDrafts: z.boolean().default(true),
      skipLabels: z.array(z.string()).default(["no-ai-review"]),
      skipAuthors: z.array(z.string()).default(["dependabot[bot]", "renovate[bot]"]),
    })
    .prefault({}),
  output: z
    .object({
      inlineComments: z.boolean().default(true),
      summaryComment: z.boolean().default(true),
      checkRun: z.boolean().default(true),
      sarif: z.boolean().default(false),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;
export type ModelChoice = z.infer<typeof modelChoice>;

export const CONFIG_PATHS = [".codeward.yml", ".codeward.yaml", ".github/codeward.yml", ".github/codeward.yaml"];

export function parseConfig(yamlText: string | undefined): Config {
  const raw: unknown = yamlText && yamlText.trim() ? parseYaml(yamlText) : {};
  const result = configSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new Error(`Invalid codeward config:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function defaultConfig(): Config {
  return parseConfig(undefined);
}

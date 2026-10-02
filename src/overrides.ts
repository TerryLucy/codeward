import type { Config } from "./config.ts";
import { configSchema } from "./config.ts";

export interface ConfigOverrides {
  model?: string;
  reviewModel?: string;
  securityModel?: string;
  summaryModel?: string;
  quality?: string;
  failOn?: string;
  minSeverity?: string;
  sarif?: boolean;
  openaiCompatibleBaseUrl?: string;
}

/** Applies CLI flags / Action inputs on top of the repository config and re-validates. */
export function applyOverrides(config: Config, o: ConfigOverrides): Config {
  const models = { ...config.models };
  if (o.model) {
    models.review = o.model;
    models.security = o.model;
    models.summary = o.model;
  }
  if (o.reviewModel) models.review = o.reviewModel;
  if (o.securityModel) models.security = o.securityModel;
  if (o.summaryModel) models.summary = o.summaryModel;
  if (o.quality) models.quality = o.quality as Config["models"]["quality"];
  if (o.openaiCompatibleBaseUrl) models.openaiCompatible = { ...models.openaiCompatible, baseUrl: o.openaiCompatibleBaseUrl };
  const review = { ...config.review };
  if (o.failOn) review.failOn = o.failOn as Config["review"]["failOn"];
  if (o.minSeverity) review.minSeverity = o.minSeverity as Config["review"]["minSeverity"];
  const output = { ...config.output };
  if (o.sarif !== undefined) output.sarif = o.sarif;
  const result = configSchema.safeParse({ models, review, output });
  if (!result.success) throw new Error(`Invalid override: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return result.data;
}

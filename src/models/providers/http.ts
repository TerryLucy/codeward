import { ProviderError } from "../types.ts";

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new ProviderError(`network error calling ${new URL(url).host}: ${String(err)}`, undefined, true);
  }
  const text = await res.text();
  if (!res.ok) {
    const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
    throw new ProviderError(`${new URL(url).host} returned ${res.status}: ${text.slice(0, 500)}`, res.status, retryable);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError(`invalid JSON from ${new URL(url).host}: ${text.slice(0, 200)}`, res.status, true);
  }
}

export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

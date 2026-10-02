/** Cheap, provider-agnostic token estimate (~4 chars/token for code). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

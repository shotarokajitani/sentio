// モデルIDの単一定義場所。ハードコードを排除し、retired時の差し替えを1箇所で完結させる。
export const MODEL_GENERATOR = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5";
export const MODEL_EVALUATOR = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5";

/**
 * Anthropic API応答ヘッダに model-deprecated が含まれる場合に警告ログを出力する。
 * retired予告を早期に検知するためのガードレール。
 */
export function warnIfModelDeprecated(
  headers: Headers,
  modelUsed: string,
): void {
  const deprecated = headers.get("x-model-deprecated") ?? headers.get("model-deprecated");
  if (deprecated) {
    console.warn(
      `[sentio:model-deprecated] model=${modelUsed} deprecated=${deprecated} — モデル差し替えが必要です`,
    );
  }
}

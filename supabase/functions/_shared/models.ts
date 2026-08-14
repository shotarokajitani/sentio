// モデルIDの単一定義場所。ハードコードを排除し、retired時の差し替えを1箇所で完結させる。
export const MODEL_GENERATOR = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5";
export const MODEL_EVALUATOR = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5";

/**
 * Anthropic API応答ヘッダに model-deprecated が含まれる場合に警告ログを出力する。
 * retired予告を早期に検知するためのガードレール。
 */
// Anthropic SDK が返す headers は @types/node-fetch 由来で、Deno組み込みの Headers とは
// 別型になる（getSetCookie の有無で非互換）。実際に使うのは get だけなので構造的に受ける。
type HeaderLike = { get(name: string): string | null };

export function warnIfModelDeprecated(headers: HeaderLike, modelUsed: string): void {
  const deprecated = headers.get("x-model-deprecated") ?? headers.get("model-deprecated");
  if (deprecated) {
    console.warn(
      `[sentio:model-deprecated] model=${modelUsed} deprecated=${deprecated} — モデル差し替えが必要です`,
    );
  }
}

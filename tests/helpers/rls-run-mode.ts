export type RlsRunMode = "run" | "skip" | "fail";

/**
 * RLS統合テストの実行モードを決める。
 *
 * 「環境変数が無ければ丸ごとskip」は fail-open であり、CI上でRLS検証が
 * 実行されていないのに緑になる状態を作る。CIでは env 欠落を失敗として扱う。
 */
export function resolveRlsRunMode(input: {
  ci: boolean;
  anonKey: string | undefined;
  serviceKey: string | undefined;
}): RlsRunMode {
  const hasKeys = Boolean(input.anonKey) && Boolean(input.serviceKey);
  if (hasKeys) return "run";
  return input.ci ? "fail" : "skip";
}

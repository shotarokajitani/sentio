/**
 * `run-sense` が叩く Investigator の宛先を1箇所に寄せる（契約 S-3-1）。
 *
 * CI には `ANTHROPIC_API_KEY` を置かない方針なので、実物の `investigate` は
 * CI では必ず失敗する。一気通貫（S-3-1）を CI で通すために、**宛先だけ**を
 * 差し替え可能にする。LLM クライアント側には手を入れない。S-3 の主題は
 * パイプラインの配線であって Investigator の中身ではない
 * （中身は `eval/` のエンジン評価スイートが担保する）。
 *
 * 差し替えるのは **Function 名だけで、URL 全体ではない。** 理由は2つ。
 *
 * 1. **到達性を推測しない。** base URL は `run-sense` が `scan` を呼ぶのに
 *    既に使っている `SUPABASE_URL` をそのまま使う。コンテナ内から見えるホスト名を
 *    別途言い当てる必要が無い
 * 2. **外部ホストへ向け替えられない。** URL を丸ごと env にすると、env が汚染された
 *    ときに候補（会社の状態）を任意の宛先へ送り出せてしまう。名前だけなら
 *    行き先は常に自分自身の Function になる
 *
 * **未設定なら本番の既定（`investigate`）に倒れる。**
 * env が無いときにスタブへ落ちる実装にすると、本番で env を入れ忘れた瞬間に
 * 「Investigator を呼んだつもりで何も呼んでいない」が静かに成立する（fail-open）。
 * 不正な名前も既定に倒す（緩い側へ倒さない）。
 */

type EnvReader = (key: string) => string | undefined;

const denoEnv: EnvReader = (key) =>
  (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(key);

/** 本番の既定。env が無い・読めない・不正なときは必ずここへ倒れる */
export const DEFAULT_INVESTIGATE_FUNCTION = "investigate";

/** Supabase の Function 名として妥当な形だけを受ける（`/` や `:` を含む値を弾く） */
const SAFE_FUNCTION_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export function resolveInvestigateFunction(getEnv: EnvReader = denoEnv): string {
  const name = (getEnv("INVESTIGATE_FUNCTION") ?? "").trim();
  if (!name) return DEFAULT_INVESTIGATE_FUNCTION;
  if (!SAFE_FUNCTION_NAME.test(name)) return DEFAULT_INVESTIGATE_FUNCTION;
  return name;
}

export function resolveInvestigateUrl(
  getEnv: EnvReader = denoEnv,
  supabaseUrl: string = denoEnv("SUPABASE_URL") ?? "",
): string {
  return `${supabaseUrl}/functions/v1/${resolveInvestigateFunction(getEnv)}`;
}

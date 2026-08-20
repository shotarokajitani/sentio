/**
 * 保持期間と削除の方針。**プライバシーポリシー（`src/app/privacy/page.tsx` §6）の正本。**
 *
 * 書いたことは守らなければならない。ポリシーの数字をここ以外に散らかすと、
 * 「ポリシーには24ヶ月と書いたが実装は別の値」という食い違いが静かに生まれる。
 *
 * **削除は「勝手に送らない」とは別方向の危険がある。** 送信事故は謝って止められるが、
 * 消しすぎは取り返しがつかない。したがってこのモジュールは
 * 「何を消すか」を絞る側にも、「消しすぎを止める」側にも fail-closed で倒す。
 *
 * Edge Function 側の写しは `supabase/functions/_shared/retention.ts`。
 * Edge Function は `supabase/functions/` の外を import できないため二重に持つ。
 * ずれは `tests/unit/retention-policy.test.ts` が機械で止める。
 */

/** privacy §6「取得した日から24ヶ月」。この数字の正本はここ。 */
export const RETENTION_MONTHS = 24;

/**
 * 1会社・1回の実行で消してよい行数の上限。超えたら**消さずに止める**。
 *
 * 狙いは「正常な利用を止めること」ではなく、**抽出条件が壊れて対象が
 * 想定外に広がったときに、黙って実行させないこと**である。
 * したがって正常値を余裕で上回る値にしておく必要がある。
 *
 * 目安: よく会議をする人のカレンダーは 10件/営業日 × 250日 × 2年 ≒ 5,000件。
 * 会計連携の取引はこれより多くなりうる。**5,000 では正常な解除を塞いでしまう**ので
 * 桁を上げて 100,000 にしてある。ここに当たったら、件数を確かめて人間が判断する。
 */
export const MAX_DELETE_ROWS = 100_000;

/**
 * provider ごとに、その連携由来と言える `events.source` を列挙する。
 *
 * ここに無い provider は**空**を返す。「知らない provider なので全部消す」に
 * 丸めると、1回の入力ミスで無関係な取り込み元まで消える。
 */
const SOURCES_BY_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  google_calendar: ["google_calendar"],
  freee: ["freee"],
};

export function sourcesForProvider(provider: string): readonly string[] {
  return SOURCES_BY_PROVIDER[provider] ?? [];
}

/**
 * `now` から `months` ヶ月前の時刻。これより古い `ingested_at` が削除対象になる。
 *
 * `setMonth` で引くと月末日が桁溢れする（3/31 の1ヶ月前が 3/2 になる）。
 * 24ヶ月なら起きないが、月数を変えた瞬間に壊れる書き方は残さない。
 * 対象月の末日に丸めてから組み立てる。
 */
export function retentionCutoff(now: Date, months: number = RETENTION_MONTHS): Date {
  const monthIndex = now.getUTCMonth() - months;
  const year = now.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(now.getUTCDate(), lastDayOfTargetMonth),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}

export type DeleteGuardReason = "unscoped" | "uncounted" | "over-limit";

export type DeleteGuard =
  { ok: true; count: number } | { ok: false; reason: DeleteGuardReason; count: number };

/**
 * 削除を実行してよいかを判定する。**数えてから消すための門。**
 *
 * - `unscoped`: `company_id` が無い。全社削除を構造的に塞ぐ
 * - `uncounted`: 件数を数えられなかった。**null を 0 に丸めない**
 *   （「数えられなかった＝0件＝消しても安全」に丸めると、数え損ねた瞬間に門が消える。
 *   予算行の fail-closed（契約 S-6-2）と同じ形）
 * - `over-limit`: 想定を超えた。消さずに止めて人間に判断させる
 */
export function evaluateDeletion(input: {
  companyId: string;
  counted: number | null;
  max: number;
}): DeleteGuard {
  if (input.companyId.trim() === "") {
    return { ok: false, reason: "unscoped", count: input.counted ?? 0 };
  }
  if (input.counted === null) {
    return { ok: false, reason: "uncounted", count: 0 };
  }
  if (input.counted > input.max) {
    return { ok: false, reason: "over-limit", count: input.counted };
  }
  return { ok: true, count: input.counted };
}

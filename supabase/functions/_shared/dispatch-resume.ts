/**
 * 配信を途中から再開する（発注 ⑥J-4 前倒し）。**判断だけを持つ。**
 *
 * ## 何が起きるか
 *
 * `dispatch-daily` は**全社を1回のリクエストで回している。** 記録を書くのは
 * 全部終わったあとなので、**時間切れで落ちると「誰が未処理か」が残らない。**
 * 翌朝の実行は最初からやり直し、そこでも落ちれば同じことが起きる。
 *
 * 会社が増えるほど落ちやすくなり、**増えたぶんだけ後ろの会社が届かなくなる。**
 *
 * ## 直した形
 *
 *   1. 会社ごとの行を **`pending` で先に書く**（落ちても誰が未処理か残る）
 *   2. 1社ずつ 90 秒で切る。返ってこなければ `timeout` にして次へ進む
 *   3. 全体 300 秒の締切。**残りは `pending` のまま終える**
 *   4. cron が 15 分おきに叩き直し、`pending` / `timeout` だけを拾う
 *
 * 再開は `run_key`（daily は JST 日付、weekly は ISO 週）で当日ぶんを特定する。
 * **既に `delivered` の会社は拾わない**ので、2通目は出ない。
 */

/** 会社1社の呼び出しを打ち切るまで（発注 D-2） */
export const COMPANY_TIMEOUT_MS = 90_000;

/**
 * 実行全体の締切（発注 D-2）。
 *
 * **Edge Function の上限より手前で自分から降りる。** 上限で殺されると
 * `finished_at` を書く暇も無く、`running` のまま残る行ができる。
 * 自分で降りれば、残りは `pending` のままきれいに残る。
 */
export const RUN_DEADLINE_MS = 300_000;

/** まだ手を付けていない / やり直してよい結末（発注 D-3） */
export const RESUMABLE_OUTCOMES = ["pending", "running", "timeout"] as const;

export interface ResumeRow {
  company_id: string | null;
  outcome: string | null;
  finished_at: string | null;
}

/**
 * 再開のときに拾う会社を決める。**終わった会社は拾わない。**
 *
 * `finished_at` が入っていれば、結末が何であれ手は付けない——
 * `failed_deliver` も「試して駄目だった」であって、同じ日に何度も試す理由が無い。
 * **拾うのは `finished_at` が NULL の行だけ。**
 */
export function planResume(rows: ResumeRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (!r.company_id) continue;
    if (r.finished_at) continue;
    if (!RESUMABLE_OUTCOMES.includes((r.outcome ?? "") as (typeof RESUMABLE_OUTCOMES)[number])) {
      continue;
    }
    out.push(r.company_id);
  }
  return out;
}

/**
 * 締切に達したか。**残り時間が1社分に満たなければ、始めない。**
 *
 * 始めてから締切に当たると `running` の行が残る。始めなければ `pending` のままで、
 * どちらも再開はできるが、**`pending` のほうが「触っていない」と言い切れる。**
 */
export function shouldStopForDeadline(startedAt: number, now: number): boolean {
  return now - startedAt >= RUN_DEADLINE_MS - COMPANY_TIMEOUT_MS;
}

export interface RunKeyInput {
  kind: "daily" | "weekly";
  now: Date;
}

/**
 * その実行が対象にしている期間の鍵。**再開が同じ日ぶんを拾うのに使う。**
 *
 * `delivery.ts` の `jstDateKey` / `isoWeekKey` と同じ考え方だが、
 * **こちらは配信の冪等キーではない。** 配信の鍵は「対象期間」（前日・前週）で、
 * こちらは「いつ回した実行か」である。ずらすと、日をまたいだ再開が
 * 前日の行を拾ってしまう。
 */
export function runKeyOf(input: RunKeyInput): string {
  const jst = new Date(input.now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  if (input.kind === "daily") return `${y}-${m}-${d}`;

  // 週次は ISO 週。**日付にすると、月曜の再開が日曜の行を拾えない**
  const target = new Date(Date.UTC(y, jst.getUTCMonth(), jst.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

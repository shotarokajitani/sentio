/**
 * 静音時間の規則（Edge Function 側の写し）。
 *
 * **正本は `src/act/quiet-hours.ts`。** Edge Function は `supabase/functions/` の外を
 * import できないため、ここに同じ値と同じ判定を持つ。
 * ずれは `tests/unit/quiet-hours.test.ts` の
 * 「Edge 側と Next.js 側で静音時間の規則がずれていない」が機械で止める。
 * **片方だけ直したらテストが赤になる。**
 *
 * なぜ切り出したか（2026-08-31）。それまで判定は `deliver-alert/index.ts` に直書きで、
 * `23` と `6` をリテラルで持っていた。**正本の定数を変えても Edge は変わらない**状態で、
 * しかも `_shared/` に無いので突合テストを書くこともできなかった。
 * 送信時刻の規則が2箇所にあり、片方が止め具の掛からない場所にある形は残さない。
 */

/** 静音時間の開始（JST）。この時刻以降は送らない */
export const QUIET_START_HOUR = 23;

/** 静音時間の終了（JST）。この時刻から送ってよい */
export const QUIET_END_HOUR = 6;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 静音時間でも送る例外。**損失が続いているもの**だけを入れる。
 * ここに足すのは「朝まで待たせると被害が増えるか」で判断する。
 */
export const QUIET_HOUR_EXCEPTIONS = new Set(["site_down"]);

/** その時刻が静音時間（JST 23:00–06:00）に入っているか */
export function isQuietHour(date: Date): boolean {
  const jstTime = new Date(date.getTime() + JST_OFFSET_MS);
  const hour = jstTime.getUTCHours();
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

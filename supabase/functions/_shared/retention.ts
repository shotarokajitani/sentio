/**
 * 保持期間と削除の方針（Edge Function 側の写し）。
 *
 * **正本は `src/lib/retention/policy.ts`。** Edge Function は
 * `supabase/functions/` の外を import できないため、ここに同じ内容を持つ。
 * ずれは `tests/unit/retention-policy.test.ts` の「Edge 側と Next.js 側でポリシーが
 * ずれていない」が機械で止める。**片方だけ直したらテストが赤になる。**
 *
 * 中身の意図（なぜ fail-closed なのか）は正本のコメントを参照。
 */

/** privacy §6「取得した日から24ヶ月」。 */
export const RETENTION_MONTHS = 24;

/** 1会社・1回の実行で消してよい行数の上限。超えたら消さずに止める。 */
export const MAX_DELETE_ROWS = 100_000;

/** `now` から `months` ヶ月前。月末日の桁溢れを避けるため対象月の末日に丸める。 */
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

/** 削除を実行してよいかを判定する。数えてから消すための門。 */
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

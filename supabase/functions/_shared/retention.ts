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

/**
 * provider ごとに、その連携由来と言える `events.source` を列挙する（正本は Next.js 側）。
 * ここに無い provider は**空**を返す。「知らないので全部消す」に丸めない。
 */
const SOURCES_BY_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  google_calendar: ["google_calendar"],
  freee: ["freee"],
};

export function sourcesForProvider(provider: string): readonly string[] {
  return SOURCES_BY_PROVIDER[provider] ?? [];
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

/**
 * 取り消し（`revoked_at`）から削除までの猶予（契約D の D-3）。
 *
 * **`invalid_grant` を即座に「解除」と読まない。** あれはトークン期限切れ・
 * 6ヶ月無操作・パスワード変更でも返る。断定できないので30日待つ。
 * 待つ間、実際に取り消されていた会社のデータは**残り続ける**——
 * それが D-3 の代償であり、誤削除より軽いという判断である。
 */
export const REVOKED_GRACE_DAYS = 30;

/**
 * `now` から `days` 日前。**これより古い `revoked_at` が削除対象になる。**
 * 月をまたぐ桁溢れが無いので、日数はそのまま引く。
 */
export function revokedCutoff(now: Date, days: number = REVOKED_GRACE_DAYS): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export type PurgeDecision = "deleted" | "dry_run" | "nothing" | "blocked";

export interface PurgePlan {
  decision: PurgeDecision;
  /** `blocked` のときだけ入る */
  reason?: DeleteGuardReason;
  /** 対象として数えた件数。**実削除件数ではない** */
  count: number;
}

/**
 * 1会社ぶんの削除をどう扱うかを決める。**実行はしない。**
 *
 * `dryRun` を**引数**で受けるのは、本番コードに `if (testMode)` を作らないためである。
 * 呼び出し側（Edge Function）が既定を安全側（＝ドライラン）に倒す。
 */
export function planPurge(input: {
  companyId: string;
  counted: number | null;
  max: number;
  dryRun: boolean;
}): PurgePlan {
  const guard = evaluateDeletion({
    companyId: input.companyId,
    counted: input.counted,
    max: input.max,
  });

  if (!guard.ok) return { decision: "blocked", reason: guard.reason, count: guard.count };
  if (guard.count === 0) return { decision: "nothing", count: 0 };
  // **数えるところまでは同じ。** 消すかどうかだけが違う
  return { decision: input.dryRun ? "dry_run" : "deleted", count: guard.count };
}

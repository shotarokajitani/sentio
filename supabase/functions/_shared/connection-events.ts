/**
 * 連携の遷移を残す（PS-9・マイグレーション `00032`）。
 *
 * **`connections` は現在の状態しか持たない。** `revoked_at` は再連携で NULL に戻るので、
 * **取り消しがあった事実そのものが消える。** 実際、2026-09-03 の取り消しは
 * 09-07 の再連携で DB から消え、残っていたのはセッション記録と Edge のログだけだった。
 *
 * **正本は `src/lib/connections/connection-events.ts`。** Edge Function は
 * `supabase/functions/` の外を import できないため二重に持つ。
 * ずれは `tests/unit/connection-events.test.ts` が機械で止める（`check:dual-impl` の宣言つき）。
 *
 * **実装が1点だけ違う。** Edge 側は `.from()` を `takeError` で包む（契約 S-2-4・
 * `check:db-errors` は `supabase/functions` だけを見る）。Next.js 側は素の分割代入である。
 * **返す値は同じ**で、それを `connection-events.test.ts` が両側比較で固定している。
 */
import { takeError } from "./db.ts";

/** `00032` の `connection_events_status_check` と同じ集合 */
export type ConnectionStatus = "active" | "revoked" | "reauth_required" | "pending";

/**
 * `00032` の `connection_events_reason_check` と同じ集合。
 *
 * **`invalid_grant` と「更新に失敗した」を混ぜない。** 前者は利用者が取り消したことの
 * 確認であり、後者はこちら側や通信の問題である。**対処が違う。**
 */
export type ConnectionEventReason =
  | "invalid_grant"
  | "refresh_failed"
  | "vault_destroy_failed"
  /** 人が画面から繋ぎ直した */
  | "reconnected"
  /** **一時的な失敗が収まって、cron が自動で戻した**（00037・発注 ①-2） */
  | "recovered";

export interface ConnectionEventInput {
  companyId: string;
  provider: string;
  /** 分からないことがある（初回・履歴が無い）。その場合は null */
  fromStatus: ConnectionStatus | null;
  toStatus: ConnectionStatus;
  reason: ConnectionEventReason;
}

/** `insert` だけができれば足りる。テストから差し替えられるように最小の形にする */
export interface ConnectionEventDb {
  from(table: string): {
    insert(
      row: Record<string, unknown>,
    ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
}

/**
 * 遷移を1行残す。**書けなくても呼び出し元の処理を止めない。**
 *
 * ここで throw すると、記録の失敗が「トークンの更新に失敗した」に化ける。
 * 失敗は値で返し、呼び出し元がログに出す。
 */
export async function recordConnectionEvent(
  db: ConnectionEventDb,
  input: ConnectionEventInput,
): Promise<{ ok: boolean; error?: string }> {
  // `takeError` で包むのは契約 S-2-4 の正規形（`check:db-errors` が機械で見る）。
  // **throw しない形**を選ぶのは、記録の失敗を「トークンの更新に失敗した」に化けさせないため
  const error = await takeError(
    db.from("connection_events").insert({
      company_id: input.companyId,
      provider: input.provider,
      from_status: input.fromStatus,
      to_status: input.toStatus,
      reason: input.reason,
    }),
    "connection-events: insert",
  );

  return error ? { ok: false, error: error.message } : { ok: true };
}

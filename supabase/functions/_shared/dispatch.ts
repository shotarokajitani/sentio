/**
 * 配信ディスパッチャの中核（契約 `docs/contracts/slice-cron-dispatch.md`・スライスCD）。
 *
 * **cron は `deliver-*` を直接叩けない。** `deliver-pulse` / `deliver-weekly` は
 * `email` が必須で（無ければ 400）、cron の本文は `'{}'::jsonb` だけである。
 * そのまま張れば毎日 400 が積み上がるだけで、誰も気づかない。
 * **あいだにこれを置き、`deliver-*` の引数要件を cron に漏らさない。**
 *
 * **依存を注入する。** `index.ts` は Deno と Supabase を繋ぐだけにして、
 * 判断（誰に送るか・失敗をどう数えるか）はこの純ロジックに閉じる。
 * `_shared/delivery.ts` の `deliverOnce(db, ...)` と同じ作法で、
 * 陰性コントロールを vitest から当てられる形にしてある。
 */

import type { CallerKind } from "./caller.ts";

export type DispatchKind = "daily" | "weekly";

export interface CompanyTarget {
  companyId: string;
  /**
   * 宛先の正本は `auth.users.email`（CD-D1）。
   * RLS が `company_id = auth.uid()` なので会社とアカウントは 1:1 である。
   * **宛先テーブルを別に持たない。** 正本が2つになると片方が古くなる。
   */
  email: string | null;
  /** `connections` に有効な行が1つ以上あるか（CD-D3） */
  hasConnection: boolean;
}

export interface InvokeResult {
  ok: boolean;
  status: number;
}

export interface DispatchDeps {
  listTargets(): Promise<CompanyTarget[]>;
  invoke(fn: string, body: Record<string, unknown>): Promise<InvokeResult>;
}

/**
 * 集計。**メールアドレスを載せない**（CD-2-3）。会社数と件数だけを出す。
 * これは cron のログにも Actions のログにも流れうるので、宛先を書くと系の外に出る。
 */
export interface DispatchSummary {
  kind: DispatchKind;
  companies: number;
  delivered: number;
  skipped_no_connection: number;
  skipped_no_email: number;
  /** `state-baselines` と `run-sense` と `deliver-*` を合わせた失敗件数 */
  failed: number;
  /** うち `run-sense` の失敗（配信は止めない。CD-2-4） */
  sense_failed: number;
  /** うち `state-baselines` の失敗（配信も Sense も止めない。SB-D2） */
  state_failed: number;
}

export interface DispatchResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * 全社に対して配信を回す（CD-D2）。
 *
 * **`internal` 以外の呼び出し元を受け付けない**（CD-3-2）。
 * ユーザー経路から全社配信を起動できると、1人のログインで他社への送信が走る。
 * 対象の列挙にも到達させない。
 *
 * **1社の失敗で他社を止めない**（CD-2-1）。ただし
 * **1件でも失敗があれば non-2xx を返す**（CD-2-2）。成功数だけ数えて 200 を返すと、
 * 毎朝静かに半分だけ届く状態が緑のまま続く。
 */
export async function runDispatch(
  kind: DispatchKind,
  caller: { kind: CallerKind },
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (caller.kind !== "internal") {
    return { status: 403, body: { error: "forbidden" } };
  }

  const targets = await deps.listTargets();
  const summary: DispatchSummary = {
    kind,
    companies: targets.length,
    delivered: 0,
    skipped_no_connection: 0,
    skipped_no_email: 0,
    failed: 0,
    sense_failed: 0,
    state_failed: 0,
  };

  for (const target of targets) {
    // 連携ゼロの会社に空のパルスを送らない（CD-1-2）
    if (!target.hasConnection) {
      summary.skipped_no_connection++;
      continue;
    }

    // 宛先が取れない会社は呼ばない。400 を積み上げない（CD-1-3）
    if (!target.email) {
      summary.skipped_no_email++;
      continue;
    }

    if (kind === "daily") {
      // **State を Sense より先に回す**（SB-D1）。
      //
      // `scan` の走査は `is_established` なベースラインを前提にするので、
      // 更新が後に来ると、その日の判断は**前日の平常**で行われる。
      // 別 cron に分けると順序が運任せになるため、ここに置いて構造的に固定する。
      //
      // **ここが `state-baselines` の唯一の呼び出し元である。** 2026-09-03 の実測では、
      // 本番の `baselines` は `revenue` の1行（最終更新 08-27）だけで、
      // 08-31 に足された `schedule_interval` の upsert は一度も走っていなかった。
      const state = await deps.invoke("state-baselines", { company_id: target.companyId });
      if (!state.ok) {
        // **State の失敗で Sense も配信も止めない**（SB-D2）。
        // 止めると、ベースラインが崩れた日に毎朝のパルスごと消える。
        // ただし黙って進めない。失敗として数え、non-2xx に効かせる
        summary.state_failed++;
        summary.failed++;
      }

      const sense = await deps.invoke("run-sense", { company_id: target.companyId });
      if (!sense.ok) {
        // **sense の失敗で配信を止めない**（CD-2-4）。ただし失敗として数える
        summary.sense_failed++;
        summary.failed++;
      }
    }

    const deliverFn = kind === "daily" ? "deliver-pulse" : "deliver-weekly";
    const delivered = await deps.invoke(deliverFn, {
      company_id: target.companyId,
      email: target.email,
    });

    if (delivered.ok) summary.delivered++;
    else summary.failed++;
  }

  // 失敗があれば non-2xx。**呼び出し元（cron）は読まないが、手動実行と CI からは読める**
  return { status: summary.failed > 0 ? 502 : 200, body: { ...summary } };
}

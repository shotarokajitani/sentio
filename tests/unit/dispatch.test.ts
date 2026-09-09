/**
 * 配信ディスパッチャ（契約 `docs/contracts/slice-cron-dispatch.md`・スライスCD）。
 *
 * cron は `deliver-*` を直接叩けない。`deliver-pulse` / `deliver-weekly` は
 * `email` 必須で、cron の本文は `'{}'::jsonb` だけだからである。
 * そのまま張れば**毎日 400 が積み上がるだけで誰も気づかない**。
 * あいだにディスパッチャを置き、宛先の解決と対象の絞り込みをそこに閉じる。
 *
 * **陰性コントロールがこのスライスの本体である。**
 * 呼んではいけない相手（連携ゼロ・宛先なし）に呼ばないこと、
 * 失敗を握りつぶして 200 を返さないこと、
 * 集計にメールアドレスを混ぜないこと、
 * ユーザー経路から全社配信を起動できないこと。
 */

import { describe, it, expect } from "vitest";
import {
  planCompany,
  runDispatch,
  type BillingCounts,
  type CompanyTarget,
  type DispatchDeps,
  type DispatchRecord,
  type InvokeResult,
  type OpsNotifyResult,
} from "@edge/_shared/dispatch";

/** 実在しないアドレスを使う（契約 CD-4-4） */
function target(overrides: Partial<CompanyTarget> = {}): CompanyTarget {
  return {
    companyId: "c0000000-0000-4000-8000-000000000001",
    email: "owner@example.invalid",
    connectionState: "active",
    lastReconnectNoticeAt: null,
    detectedAt: null,
    // 既定は「購読している」。**購読で止めるのは `enforceEntitlement` が true のときだけ**
    subscriptionStatus: "active",
    ...overrides,
  };
}

interface Call {
  fn: string;
  body: Record<string, unknown>;
}

interface BillingStub {
  /** `null` は集計そのものの失敗を表す */
  counts?: BillingCounts | null;
  notify?: OpsNotifyResult;
}

/** 既定は「取りこぼしが1件も無い」状態 */
const NO_BILLING_ROWS: BillingCounts = { unresolved: 0, resolved: 0, stale: 0 };

function deps(
  targets: CompanyTarget[],
  results: Record<string, InvokeResult> = {},
  billing: BillingStub = {},
): DispatchDeps & { calls: Call[]; notified: number[]; recorded: DispatchRecord[] } {
  const calls: Call[] = [];
  const notified: number[] = [];
  const recorded: DispatchRecord[] = [];
  return {
    calls,
    notified,
    recorded,
    recordDispatch: async (rows) => {
      recorded.push(...rows);
      return { ok: true };
    },
    listTargets: async () => targets,
    invoke: async (fn, body) => {
      calls.push({ fn, body });
      return results[fn] ?? { ok: true, status: 200 };
    },
    countBillingUnresolved: async () =>
      billing.counts === undefined ? NO_BILLING_ROWS : billing.counts,
    notifyOpsBillingUnresolved: async (count) => {
      notified.push(count);
      return billing.notify ?? { ok: true };
    },
  };
}

const INTERNAL = { kind: "internal" as const };
const USER = { kind: "user" as const };

describe("CD-1: 対象の選び方", () => {
  it("CD-1-1: 連携があり宛先も取れる会社に run-sense → deliver-pulse を呼ぶ", async () => {
    const d = deps([target()]);
    const result = await runDispatch("daily", INTERNAL, d);

    expect(result.status).toBe(200);
    // 先頭の state-baselines は契約SB（SB-1-1）で足したもの。
    // **run-sense → deliver-pulse の順序自体は変えていない**（SB-3-2）
    expect(d.calls.map((c) => c.fn)).toEqual(["state-baselines", "run-sense", "deliver-pulse"]);
    expect(d.calls[2].body).toMatchObject({ email: "owner@example.invalid" });
  });

  it("CD-1-2（陰性コントロール）: 連携ゼロの会社に deliver-* を呼ばない", async () => {
    const d = deps([target({ connectionState: "none" })]);
    const result = await runDispatch("daily", INTERNAL, d);

    expect(d.calls).toEqual([]);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ skipped_no_connection: 1, delivered: 0 });
  });

  it("CD-1-3（陰性コントロール）: 宛先が取れない会社に deliver-* を呼ばない", async () => {
    // 400 を積み上げないこと。スキップとして集計に載せる
    const d = deps([target({ email: null })]);
    const result = await runDispatch("daily", INTERNAL, d);

    expect(d.calls).toEqual([]);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ skipped_no_email: 1, delivered: 0 });
  });

  it("CD-1-4: 対象が0社でも 200 で正常終了する", async () => {
    const d = deps([]);
    const result = await runDispatch("daily", INTERNAL, d);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ companies: 0, delivered: 0, failed: 0 });
  });

  it("weekly は deliver-weekly だけを呼ぶ（run-sense を呼ばない）", async () => {
    const d = deps([target()]);
    const result = await runDispatch("weekly", INTERNAL, d);

    expect(result.status).toBe(200);
    expect(d.calls.map((c) => c.fn)).toEqual(["deliver-weekly"]);
  });
});

describe("CD-2: 失敗の扱い", () => {
  it("CD-2-1: 1社が失敗しても残りの会社の処理を続ける", async () => {
    const a = target({ companyId: "c0000000-0000-4000-8000-00000000000a" });
    const b = target({ companyId: "c0000000-0000-4000-8000-00000000000b" });
    const d = deps([a, b], { "deliver-pulse": { ok: false, status: 500 } });

    const result = await runDispatch("daily", INTERNAL, d);

    // 2社とも deliver-pulse まで到達している
    expect(d.calls.filter((c) => c.fn === "deliver-pulse")).toHaveLength(2);
    expect(result.body).toMatchObject({ companies: 2 });
  });

  it("CD-2-2（陰性コントロール）: 1件でも失敗があれば non-2xx。成功だけ数えて 200 にしない", async () => {
    const ok = target({ companyId: "c0000000-0000-4000-8000-00000000000a" });
    const d = deps([ok], { "deliver-pulse": { ok: false, status: 500 } });

    const result = await runDispatch("daily", INTERNAL, d);

    expect(result.status).not.toBe(200);
    expect(result.status).toBeGreaterThanOrEqual(500);
    expect(result.body).toMatchObject({ failed: 1 });
  });

  it("CD-2-3（陰性コントロール）: 集計本文にメールアドレスが1文字も出ない", async () => {
    const d = deps(
      [target(), target({ companyId: "c0000000-0000-4000-8000-00000000000b", email: null })],
      { "deliver-pulse": { ok: false, status: 500 } },
    );

    const result = await runDispatch("daily", INTERNAL, d);
    const body = JSON.stringify(result.body);

    expect(body).not.toContain("@");
    expect(body).not.toContain("example.invalid");
    expect(body).not.toContain("owner");
  });

  it("CD-2-4: run-sense が失敗した会社にも deliver-pulse は走る（失敗としては数える）", async () => {
    const d = deps([target()], { "run-sense": { ok: false, status: 502 } });

    const result = await runDispatch("daily", INTERNAL, d);

    expect(d.calls.map((c) => c.fn)).toEqual(["state-baselines", "run-sense", "deliver-pulse"]);
    expect(result.status).not.toBe(200);
    // **sense_failed の意味は変えていない。** state 側は state_failed に分けて数える（SB-3-4）
    expect(result.body).toMatchObject({ sense_failed: 1, state_failed: 0 });
  });
});

describe("CD-3: 呼ばれ方", () => {
  it("CD-3-2（陰性コントロール）: internal 以外の呼び出し元を受け付けない", async () => {
    const d = deps([target()]);
    const result = await runDispatch("daily", USER, d);

    // 対象の列挙にも配信にも一切到達しない
    expect(d.calls).toEqual([]);
    expect(result.status).toBe(403);
  });
});

/**
 * スライスSB（契約 `docs/contracts/slice-state-schedule.md`）。
 *
 * **アーキテクチャは Ingest → State → Sense → Act だが、State が丸ごと抜けていた。**
 * `state-baselines` を呼ぶ行がリポジトリのどこにも無く、本番の `baselines` には
 * `revenue` の1行（最終更新 2026-08-27）しか無い。08-31 に足された
 * `schedule_interval` の upsert は**一度も走っていない**（2026-09-03 実測）。
 *
 * **検出器を足しても、State が更新されなければ発火しない。** その対になる半分をここで固定する。
 *
 * 呼び出し順は**配列で突き合わせる**（SB-1-1）。集合で見ると、
 * State を Sense の**後**に呼ぶ実装でも緑になる——それでは順序を守ったことにならない。
 */
describe("SB-1: 順序と対象", () => {
  it("SB-1-1: 日次は state-baselines → run-sense → deliver-pulse の順に呼ぶ", async () => {
    const d = deps([target()]);
    const result = await runDispatch("daily", INTERNAL, d);

    expect(result.status).toBe(200);
    expect(d.calls.map((c) => c.fn)).toEqual(["state-baselines", "run-sense", "deliver-pulse"]);
  });

  it("SB-1-2（陰性コントロール）: 週次では state-baselines を呼ばない（SB-D3）", async () => {
    const d = deps([target()]);
    await runDispatch("weekly", INTERNAL, d);

    expect(d.calls.map((c) => c.fn)).toEqual(["deliver-weekly"]);
    expect(d.calls.map((c) => c.fn)).not.toContain("state-baselines");
  });

  it("SB-1-3（陰性コントロール）: 連携ゼロの会社では state-baselines を呼ばない", async () => {
    const d = deps([target({ connectionState: "none" })]);
    const result = await runDispatch("daily", INTERNAL, d);

    expect(d.calls).toEqual([]);
    expect(result.body).toMatchObject({ skipped_no_connection: 1, state_failed: 0 });
  });

  it("SB-1-4（陰性コントロール）: 宛先が取れない会社では state-baselines を呼ばない（SB-D6）", async () => {
    // **これは限界であって、意図である。** このディスパッチャは配信のためのもので、
    // State 更新を相乗りさせている。「連携はあるが配信は止めている」会社が現れた時点で
    // 前提が崩れる（契約 既知の限界1）。崩れたことに気づけるよう、ここで固定しておく
    const d = deps([target({ email: null })]);
    const result = await runDispatch("daily", INTERNAL, d);

    expect(d.calls).toEqual([]);
    expect(result.body).toMatchObject({ skipped_no_email: 1 });
  });

  it("state-baselines に渡すのは company_id だけ（宛先を State 側に流さない）", async () => {
    const d = deps([target()]);
    await runDispatch("daily", INTERNAL, d);

    const state = d.calls.find((c) => c.fn === "state-baselines");
    expect(state?.body).toEqual({ company_id: "c0000000-0000-4000-8000-000000000001" });
  });
});

describe("SB-2: State の失敗の扱い", () => {
  it("SB-2-1（陰性コントロール）: state-baselines が失敗しても run-sense と deliver-pulse は走る", async () => {
    const d = deps([target()], { "state-baselines": { ok: false, status: 500 } });

    await runDispatch("daily", INTERNAL, d);

    // **State の失敗で配信を止めない**（SB-D2）。止めると、ベースラインが崩れた日に
    // 毎朝のパルスごと消える。届かないことは届くことより悪い
    expect(d.calls.map((c) => c.fn)).toEqual(["state-baselines", "run-sense", "deliver-pulse"]);
  });

  it("SB-2-2（陰性コントロール）: 失敗を state_failed に数え、failed にも加算する", async () => {
    const d = deps([target()], { "state-baselines": { ok: false, status: 500 } });

    const result = await runDispatch("daily", INTERNAL, d);

    // 成功だけ数えて 200 を返すと、毎朝静かに State が古いまま緑が続く
    expect(result.body).toMatchObject({ state_failed: 1, failed: 1, delivered: 1 });
    expect(result.status).not.toBe(200);
    expect(result.status).toBeGreaterThanOrEqual(500);
  });

  it("SB-2-2: 成功したときは state_failed が 0 のまま（成功を失敗に数えない）", async () => {
    const d = deps([target()]);
    const result = await runDispatch("daily", INTERNAL, d);

    expect(result.body).toMatchObject({ state_failed: 0, failed: 0, delivered: 1 });
    expect(result.status).toBe(200);
  });

  it("SB-2-3（陰性コントロール）: state_failed を足しても集計に宛先が出ない", async () => {
    const d = deps([target()], { "state-baselines": { ok: false, status: 500 } });

    const result = await runDispatch("daily", INTERNAL, d);
    const body = JSON.stringify(result.body);

    expect(body).not.toContain("@");
    expect(body).not.toContain("example.invalid");
    expect(body).not.toContain("owner");
  });
});

/**
 * ④-a: 会社を引けなかった課金 webhook に気づく経路（受入 5-3・改訂後）。
 *
 * **この節は「鳴らない監視をもう1つ作らない」ための陰性コントロールである。**
 * 0件でも項目を出すこと・集計の失敗を0件と読ませないこと・
 * 通知の送信失敗そのものを黙らせないこと。3つとも、今日までに実際に踏んだ形である。
 */
/**
 * PS-8 / PS-9（2026-09-08）。**送らなかった日を残し、取り消しを人へ届ける。**
 *
 * 2026-09-03〜09-06、パルスが4日間出ず、その事実がどこにも残らなかった。
 * 取り消し → sync 対象外 → 0社 → 無記録、という連なりで、
 * **cron は毎日 succeeded、応答は毎日 200 だった。**
 */
describe("PS-9: 取り消し中の会社へ再連携のお願いを送る", () => {
  const revoked = target({ connectionState: "revoked" });

  it("取り消し中の会社には**再連携のお願いだけ**を送る（state も sense も呼ばない）", async () => {
    const d = deps([revoked]);
    const result = await runDispatch("daily", INTERNAL, d);

    // **LLM へ入る経路（run-sense → investigate）を呼ばないことが担保である**（PS-9c）
    expect(d.calls.map((c) => c.fn)).toEqual(["deliver-pulse"]);
    expect(d.calls[0].body).toMatchObject({ kind: "reconnect" });
    expect(result.body).toMatchObject({ reconnect_notice: 1, delivered: 0 });
  });

  it("PS-S4: 差し込み（検知日時）を渡す。**会社名は文面から外した**", async () => {
    const detectedAt = "2026-09-03T06:00:03.841Z";
    const d = deps([target({ connectionState: "revoked", detectedAt })]);
    await runDispatch("daily", INTERNAL, d);

    // 会社名は出所が無いので 2026-09-08 に文面から外した（検収者の決定）。
    // **渡さないことを固定する**——復活させるなら文面ごと諮る
    expect(d.calls[0].body).toMatchObject({ kind: "reconnect", detected_at: detectedAt });
    expect(d.calls[0].body).not.toHaveProperty("company_name");
  });

  it("reauth_required でも同じ経路を通る", async () => {
    const d = deps([target({ connectionState: "reauth_required" })]);
    await runDispatch("daily", INTERNAL, d);

    expect(d.calls.map((c) => c.fn)).toEqual(["deliver-pulse"]);
    expect(d.calls[0].body).toMatchObject({ kind: "reconnect" });
  });

  it("**陰性コントロール**: 健全な会社の呼び出しは変わっていない（本文に kind を混ぜない）", async () => {
    const d = deps([target()]);
    await runDispatch("daily", INTERNAL, d);

    expect(d.calls.map((c) => c.fn)).toEqual(["state-baselines", "run-sense", "deliver-pulse"]);
    expect(d.calls[2].body).not.toHaveProperty("kind");
  });

  it("**陰性コントロール**: pending の会社は配信対象に入らない（関門を開けるのは2状態だけ）", async () => {
    // 「active 以外すべて」にしていない。pending は認可が完了していない行である
    const d = deps([target({ connectionState: "pending" as never })]);
    const result = await runDispatch("daily", INTERNAL, d);

    expect(d.calls).toEqual([]);
    expect(result.body).toMatchObject({ skipped_no_connection: 1, reconnect_notice: 0 });
  });

  it("**陰性コントロール**: 週次では再連携のお願いを送らない（同じ内容が週2回届かない）", async () => {
    const d = deps([revoked]);
    const result = await runDispatch("weekly", INTERNAL, d);

    expect(d.calls).toEqual([]);
    expect(result.body).toMatchObject({ skipped_no_connection: 1 });
  });

  it("PS-9e: 7日以内に送っていれば**送らない**。理由つきで記録に残す", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const d = deps([target({ connectionState: "revoked", lastReconnectNoticeAt: threeDaysAgo })]);
    const result = await runDispatch("daily", INTERNAL, d);

    expect(d.calls).toEqual([]);
    expect(result.body).toMatchObject({ reconnect_suppressed: 1, reconnect_notice: 0 });
    expect(d.recorded).toContainEqual({
      kind: "company",
      dispatch: "daily",
      companyId: revoked.companyId,
      outcome: "reconnect_suppressed",
      reason: "sent_within_7_days",
    });
  });

  it("PS-9e: 7日を過ぎていれば送る", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const d = deps([target({ connectionState: "revoked", lastReconnectNoticeAt: eightDaysAgo })]);
    const result = await runDispatch("daily", INTERNAL, d);

    expect(result.body).toMatchObject({ reconnect_notice: 1 });
  });

  it("PS-9f: **送らなかった**と**送り損ねた**を別の値で残す", async () => {
    const d = deps([revoked], { "deliver-pulse": { ok: false, status: 500 } });
    const result = await runDispatch("daily", INTERNAL, d);

    expect(result.status).not.toBe(200);
    expect(d.recorded).toContainEqual({
      kind: "company",
      dispatch: "daily",
      companyId: revoked.companyId,
      outcome: "failed_deliver",
      reason: "status_500",
    });
  });
});

describe("PS-8: 送らなかった日を記録する", () => {
  it("**0社でも実行の行を必ず残す**（0件と、cron が発火していないを区別する）", async () => {
    const d = deps([]);
    const result = await runDispatch("daily", INTERNAL, d);

    expect(d.recorded).toEqual([{ kind: "run", dispatch: "daily", companies: 0 }]);
    expect(result.body).toMatchObject({ recorded: true });
  });

  it("スキップした会社も理由つきで残す", async () => {
    const d = deps([target({ connectionState: "none" }), target({ companyId: "x", email: null })]);
    await runDispatch("daily", INTERNAL, d);

    expect(d.recorded).toContainEqual(
      expect.objectContaining({ outcome: "skipped_no_connection" }),
    );
    expect(d.recorded).toContainEqual(expect.objectContaining({ outcome: "skipped_no_email" }));
    expect(d.recorded).toContainEqual({ kind: "run", dispatch: "daily", companies: 2 });
  });

  it("**陰性コントロール**: 記録に失敗したら non-2xx にする（記録が無いと後から辿れない）", async () => {
    const d = deps([target()]);
    d.recordDispatch = async () => ({ ok: false, error: "insert failed" });

    const result = await runDispatch("daily", INTERNAL, d);

    expect(result.body).toMatchObject({ recorded: false });
    expect(result.status).not.toBe(200);
  });

  it("記録にメールアドレスを載せない", async () => {
    const d = deps([target()]);
    await runDispatch("daily", INTERNAL, d);

    expect(JSON.stringify(d.recorded)).not.toContain("@");
  });
});

describe("④-a: 未解決の課金 webhook に気づく経路", () => {
  it("解決済みと3日超も、0件でも項目として出す（消さない）", async () => {
    const d = deps([target()], {}, { counts: { unresolved: 0, resolved: 4, stale: 0 } });
    const result = await runDispatch("daily", INTERNAL, d);

    // **解決済みは通知の判断から外すが、件数は消さない**（④-a・2-4）
    expect(result.body).toMatchObject({
      billing_unresolved: 0,
      billing_resolved: 4,
      billing_stale: 0,
      billing_alert: "not_needed",
    });
    // 解決済みが何件あっても、未解決0件なら鳴らさない
    expect(result.status).toBe(200);
    expect(d.notified).toEqual([]);
  });

  it("**3日を超えた未解決**を別枠で出す（再送が尽きたものを、まだ望みがある分と混ぜない）", async () => {
    const d = deps([target()], {}, { counts: { unresolved: 3, resolved: 1, stale: 2 } });
    const result = await runDispatch("daily", INTERNAL, d);

    expect(result.body).toMatchObject({
      billing_unresolved: 3,
      billing_resolved: 1,
      billing_stale: 2,
    });
    // **出すだけである。** 3日超そのもので non-2xx にはしない（未解決1件以上だから 502）
    expect(result.status).toBe(502);
  });

  it("集計に失敗したら、解決済みと3日超も null で出す（0件に見せない）", async () => {
    const d = deps([target()], {}, { counts: null });
    const result = await runDispatch("daily", INTERNAL, d);

    expect(result.body).toMatchObject({
      billing_unresolved: null,
      billing_resolved: null,
      billing_stale: null,
      billing_alert: "count_failed",
    });
  });

  it("0件でも summary に0件と書く（項目ごと消さない）", async () => {
    const d = deps([target()], {}, { counts: NO_BILLING_ROWS });
    const result = await runDispatch("daily", INTERNAL, d);

    expect(result.body).toMatchObject({ billing_unresolved: 0, billing_alert: "not_needed" });
    // 0件は異常ではない。**non-2xx にしない**
    expect(result.status).toBe(200);
    expect(d.notified).toEqual([]);
  });

  it("1件以上なら運用宛に1通出し、non-2xx にする", async () => {
    const d = deps([target()], {}, { counts: { unresolved: 2, resolved: 0, stale: 0 } });
    const result = await runDispatch("daily", INTERNAL, d);

    expect(d.notified).toEqual([2]);
    expect(result.body).toMatchObject({ billing_unresolved: 2, billing_alert: "sent" });
    expect(result.status).toBe(502);
  });

  it("（陰性コントロール）通知の送信に失敗したら黙らず non-2xx に出す", async () => {
    const d = deps(
      [target()],
      {},
      {
        counts: { unresolved: 1, resolved: 0, stale: 0 },
        notify: { ok: false, reason: "send_failed", error: "Resend 500" },
      },
    );
    const result = await runDispatch("daily", INTERNAL, d);

    expect(result.body).toMatchObject({ billing_unresolved: 1, billing_alert: "failed" });
    expect(result.status).toBe(502);
  });

  it("（陰性コントロール）宛先が未設定なら not_configured として出す（送ったことにしない）", async () => {
    const d = deps(
      [target()],
      {},
      {
        counts: { unresolved: 1, resolved: 0, stale: 0 },
        notify: { ok: false, reason: "not_configured" },
      },
    );
    const result = await runDispatch("daily", INTERNAL, d);

    expect(result.body).toMatchObject({ billing_alert: "not_configured" });
    expect(result.status).toBe(502);
  });

  it("（陰性コントロール）集計に失敗したら0件と書かない。null と count_failed で出す", async () => {
    const d = deps([target()], {}, { counts: null });
    const result = await runDispatch("daily", INTERNAL, d);

    // **ここが 0 になっていると「0件が続いている」と読めてしまう**
    expect(result.body).toMatchObject({ billing_unresolved: null, billing_alert: "count_failed" });
    expect(result.status).toBe(502);
    expect(d.notified).toEqual([]);
  });

  it("weekly では課金の集計をしない（同じ通知を週2回出さない）", async () => {
    const d = deps([target()], {}, { counts: { unresolved: 3, resolved: 0, stale: 0 } });
    const result = await runDispatch("weekly", INTERNAL, d);

    expect(d.notified).toEqual([]);
    expect(result.body).not.toHaveProperty("billing_unresolved");
    expect(result.status).toBe(200);
  });

  it("集計にも通知にも宛先や識別子を載せない", async () => {
    const d = deps([target()], {}, { counts: { unresolved: 1, resolved: 0, stale: 0 } });
    const body = JSON.stringify((await runDispatch("daily", INTERNAL, d)).body);

    expect(body).not.toContain("@");
    expect(body).not.toContain("cus_");
  });
});

/**
 * 購読で配信を止める（発注 B-4）。**既定では止めない。**
 *
 * 止める判断を入れる前に、**止めた記録が正しく残ること**を確かめたい。
 * したがって既定は false で、環境変数 `SENTIO_ENFORCE_ENTITLEMENT` が true のときだけ止まる。
 */
describe("購読が無い会社に配らない（B-4）", () => {
  it("**既定では止めない**（フラグを渡さない従来の呼び出しが壊れない）", () => {
    const plan = planCompany(target({ subscriptionStatus: null }), "daily", new Date());

    expect(plan.action).toBe("deliver");
  });

  it("フラグが true なら、購読が無い会社は skipped_not_entitled で落ちる", () => {
    const plan = planCompany(target({ subscriptionStatus: null }), "daily", new Date(), true);

    expect(plan).toEqual({ action: "skip", outcome: "skipped_not_entitled" });
  });

  it("**陰性**: 連携が無いのと混ぜない（打つ手が違う）", () => {
    const noConnection = planCompany(
      target({ connectionState: "none", subscriptionStatus: "active" }),
      "daily",
      new Date(),
      true,
    );

    expect(noConnection).toEqual({ action: "skip", outcome: "skipped_no_connection" });
  });

  it("active と trialing は通る（無料期間中も製品は動く）", () => {
    for (const status of ["active", "trialing"]) {
      const plan = planCompany(target({ subscriptionStatus: status }), "daily", new Date(), true);
      expect(plan.action, status).toBe("deliver");
    }
  });

  it("**陰性**: past_due / canceled / paused は止まる", () => {
    for (const status of ["past_due", "canceled", "paused", "unpaid", "incomplete"]) {
      const plan = planCompany(target({ subscriptionStatus: status }), "daily", new Date(), true);
      expect(plan, status).toEqual({ action: "skip", outcome: "skipped_not_entitled" });
    }
  });

  it("止めた会社は記録に残り、summary に数として出る", async () => {
    const d = { ...deps([target({ subscriptionStatus: null })]), enforceEntitlement: true };
    const result = await runDispatch("daily", { kind: "internal" }, d);

    expect(result.body).toMatchObject({ skipped_not_entitled: 1, delivered: 0 });
    expect(
      d.recorded.some((r) => r.kind === "company" && r.outcome === "skipped_not_entitled"),
    ).toBe(true);
    // **配信そのものを呼んでいない**（止めたのだから呼ばない）
    expect(d.calls.some((c) => c.fn === "deliver-pulse")).toBe(false);
  });

  it("会社の一覧を取り切れなかった日は non-2xx（**一部だけ配って 200 にしない**）", async () => {
    const d = { ...deps([target()]), targetsTruncated: true };
    const result = await runDispatch("daily", { kind: "internal" }, d);

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ truncated: true });
  });
});

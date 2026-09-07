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
  runDispatch,
  type BillingCounts,
  type CompanyTarget,
  type DispatchDeps,
  type InvokeResult,
  type OpsNotifyResult,
} from "@edge/_shared/dispatch";

/** 実在しないアドレスを使う（契約 CD-4-4） */
function target(overrides: Partial<CompanyTarget> = {}): CompanyTarget {
  return {
    companyId: "c0000000-0000-4000-8000-000000000001",
    email: "owner@example.invalid",
    hasConnection: true,
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
): DispatchDeps & { calls: Call[]; notified: number[] } {
  const calls: Call[] = [];
  const notified: number[] = [];
  return {
    calls,
    notified,
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
    const d = deps([target({ hasConnection: false })]);
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
    const d = deps([target({ hasConnection: false })]);
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

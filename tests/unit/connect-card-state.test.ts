/**
 * 連携カードの「状態 → 何を出すか」（`/connect` の `SourceRow`・2026-09-07 発注）。
 *
 * **原則そのものを試験にしてある。**
 *
 * 1. 状態ごとに、主操作は1つだけ
 * 2. 取り消しのきかない操作（解除）と、回復する操作（接続・再接続）を、
 *    同じ高さに並べない
 *
 * 画面の JSX に条件を散らすと、この2つが守られているかを機械で確かめられない。
 * 判断を `cardActions` に閉じ、ここで固定する。
 */
import { describe, it, expect } from "vitest";
import { cardActions, syncFreshness, STALE_SYNC_HOURS } from "@/lib/connections/card-state";

/** 実物の `status` は4値（`00007:10` の既定値 + コードが書く3値） */
const ALL_STATUSES = ["pending", "active", "reauth_required", "revoked"] as const;

describe("原則1: 状態ごとに主操作は1つだけ", () => {
  it("未連携の主操作は「連携する」だけ", () => {
    const actions = cardActions(undefined, true);

    expect(actions.kind).toBe("unconnected");
    expect(actions.primary).toBe("connect");
    // **行が無いのだから解除も無い。** 空のメニューを開かせない
    expect(actions.menu).toEqual([]);
  });

  it("正常につながっているときは**主操作を置かない**", () => {
    const actions = cardActions({ status: "active" }, true);

    expect(actions.kind).toBe("connected");
    expect(actions.primary).toBeNull();
    expect(actions.menu).toEqual(["disconnect"]);
  });

  it("要再連携の主操作は「再接続」だけ", () => {
    const actions = cardActions({ status: "reauth_required" }, true);

    expect(actions.kind).toBe("needs_reauth");
    expect(actions.primary).toBe("reconnect");
    expect(actions.menu).toEqual(["disconnect"]);
  });

  it("`revoked` も画面では同じ「要再連携」に畳む（U-3）", () => {
    // DB では revoked と reauth_required を区別して残すが、
    // **利用者にできることはどちらも再接続だけ**である
    expect(cardActions({ status: "revoked" }, true)).toEqual(
      cardActions({ status: "reauth_required" }, true),
    );
  });

  it.each(ALL_STATUSES)("`%s` でも主操作は多くて1つ", (status) => {
    const actions = cardActions({ status }, true);
    const primaries = actions.primary === null ? 0 : 1;

    expect(primaries).toBeLessThanOrEqual(1);
  });
});

describe("原則2: 取り消しのきかない操作を主操作にしない", () => {
  it.each(ALL_STATUSES)("`%s` のどの状態でも、解除が主操作にならない", (status) => {
    const actions = cardActions({ status }, true);

    // 解除はトークンを破棄し、取り込んだデータを消す。**取り消せない**
    expect(actions.primary).not.toBe("disconnect");
    expect(["connect", "reconnect", null]).toContain(actions.primary);
  });

  it("解除は必ず畳んだ側に入る", () => {
    for (const status of ALL_STATUSES) {
      expect(cardActions({ status }, true).menu).toContain("disconnect");
    }
  });
});

describe("陰性コントロール: 中身の無いメニューを出さない", () => {
  it.each(ALL_STATUSES)("解除 UI を渡していない行（freee）では `%s` でもメニューが空", (status) => {
    // 空なら画面側は `…` そのものを描かない
    expect(cardActions({ status }, false).menu).toEqual([]);
  });

  it("未連携の行はメニューが空（解除 UI を渡していても）", () => {
    expect(cardActions(null, true).menu).toEqual([]);
  });
});

describe("最終同期の鮮度", () => {
  const now = new Date("2026-09-07T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();

  it("取り込み間隔（6時間）の1回ぶんでは古いと言わない", () => {
    // **1回落ちただけで鳴らさない。** 鳴りすぎると鳴っていること自体に慣れる
    expect(syncFreshness(hoursAgo(7), now).stale).toBe(false);
  });

  it("12時間（＝2回続けて取り込めていない）で古いと言う", () => {
    expect(STALE_SYNC_HOURS).toBe(12);
    expect(syncFreshness(hoursAgo(12), now).stale).toBe(true);
    expect(syncFreshness(hoursAgo(11.9), now).stale).toBe(false);
  });

  it("相対表記は時間と日で切り替える", () => {
    expect(syncFreshness(hoursAgo(0.5), now).relative).toBe("たった今");
    expect(syncFreshness(hoursAgo(3), now).relative).toBe("3時間前");
    expect(syncFreshness(hoursAgo(96), now).relative).toBe("4日前");
  });

  it("一度も同期していなければ、古いとも言わない（相対表記も出さない）", () => {
    // 未連携・同期前を「古い」と言うと、**まだ起きていないことを異常として出す**
    expect(syncFreshness(null, now)).toEqual({ stale: false, relative: null });
    expect(syncFreshness(undefined, now)).toEqual({ stale: false, relative: null });
  });

  it("壊れた値では古いと言わない（推測で警告を出さない）", () => {
    expect(syncFreshness("not-a-date", now)).toEqual({ stale: false, relative: null });
  });

  it("未来の時刻は「たった今」に丸める（時計のずれで負の値を出さない）", () => {
    const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    expect(syncFreshness(future, now)).toEqual({ stale: false, relative: "たった今" });
  });
});

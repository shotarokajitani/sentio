/**
 * 「連携が切れています」の文面（PS-S4・承認された版）。
 *
 * **文面は製品のUI文言である。** 承認された版から1文字ずれたら、それは別の文面である。
 * ここで固定するのは3つ。
 *
 *   1. 承認された文と、必須の3点（配信停止 / 記録されない / 7日ごと）が入っていること
 *   2. **差し込みが1つでも欠けたら組み立てない**（「(不明)」で埋めて送らない）
 *   3. provider の**内部表記を顧客に見せない**（`google_calendar` ではなく「Googleカレンダー」）
 */
import { describe, it, expect } from "vitest";
import { formatDetectedAt, renderReconnectNotice } from "@edge/_shared/reconnect-notice";

const INPUT = {
  companyName: "株式会社サンプル",
  detectedAt: "2026-09-03T06:00:03.841Z",
  reconnectUrl: "https://www.sentio-ai.jp/connect",
};

describe("承認された文面と一致する", () => {
  it("件名", () => {
    expect(renderReconnectNotice(INPUT)?.subject).toBe(
      "【Sentio】Googleカレンダーの連携が切れています",
    );
  });

  it("本文（差し込み3つが入り、行の並びも承認どおり）", () => {
    expect(renderReconnectNotice(INPUT)?.body).toBe(
      [
        "株式会社サンプル のGoogleカレンダーの連携が切れています。",
        "2026年9月3日 15:00 から、新しいデータを取り込めていません。",
        "",
        "この状態が続く間、毎朝の状態レポートは配信を停止します。",
        "連携が切れている間に起きたことは、Sentioには記録されません。",
        "",
        "再連携はこちらから行えます。",
        "https://www.sentio-ai.jp/connect",
        "",
        "このお知らせは、状態が変わらない場合、7日ごとに配信します。",
      ].join("\n"),
    );
  });

  it("**必須の3点が落ちていない**（意図が消えたら別の文面になる）", () => {
    const body = renderReconnectNotice(INPUT)!.body;

    // レポートが来ないことを「異常がないから来ない」と読ませない
    expect(body).toContain("配信を停止します");
    // 後から遡って埋まると思わせない
    expect(body).toContain("記録されません");
    // 1通目のあとの沈黙を「直った」と読ませない
    expect(body).toContain("7日ごとに配信します");
  });

  it("provider の内部表記を顧客に見せない", () => {
    const notice = renderReconnectNotice(INPUT)!;

    expect(notice.subject).toContain("Googleカレンダー");
    expect(`${notice.subject}${notice.body}`).not.toContain("google_calendar");
  });
});

describe("差し込みが欠けたら組み立てない（fail-closed）", () => {
  it.each([
    ["会社名", { ...INPUT, companyName: "" }],
    ["検知日時", { ...INPUT, detectedAt: "" }],
    ["再連携URL", { ...INPUT, reconnectUrl: "" }],
  ])("%s が無ければ null を返す（「(不明)」で埋めて送らない）", (_label, input) => {
    expect(renderReconnectNotice(input)).toBeNull();
  });

  it("空白だけの差し込みも欠けているものとして扱う", () => {
    expect(renderReconnectNotice({ ...INPUT, companyName: "   " })).toBeNull();
  });

  it("壊れた日時では組み立てない（推測で日付を作らない）", () => {
    expect(renderReconnectNotice({ ...INPUT, detectedAt: "not-a-date" })).toBeNull();
  });
});

describe("検知日時は JST で出す", () => {
  it("UTC の値を JST に直して出す（受け手は日本にいる）", () => {
    // 2026-09-03 06:00 UTC = 同日 15:00 JST。実際の取り消し検知の時刻である
    expect(formatDetectedAt("2026-09-03T06:00:03.841Z")).toBe("2026年9月3日 15:00");
  });

  it("日付をまたぐ時刻でもずれない", () => {
    // 2026-09-03 16:00 UTC = 翌 01:00 JST
    expect(formatDetectedAt("2026-09-03T16:00:00.000Z")).toBe("2026年9月4日 01:00");
  });

  it("壊れた値では null（0時と読める文字列を作らない）", () => {
    expect(formatDetectedAt("boom")).toBeNull();
  });
});

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
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  formatDetectedAt,
  reconnectDeliveryContent,
  renderReconnectNotice,
} from "@edge/_shared/reconnect-notice";

const INPUT = {
  detectedAt: "2026-09-03T06:00:03.841Z",
  reconnectUrl: "https://www.sentio-ai.jp/connect",
};

describe("承認された文面と一致する", () => {
  it("件名", () => {
    expect(renderReconnectNotice(INPUT)?.subject).toBe(
      "【Sentio】Googleカレンダーの連携が切れています",
    );
  });

  it("本文（差し込み2つが入り、行の並びも承認どおり）", () => {
    expect(renderReconnectNotice(INPUT)?.body).toBe(
      [
        "Googleカレンダーの連携が切れています。",
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
    ["検知日時", { ...INPUT, detectedAt: "" }],
    ["再連携URL", { ...INPUT, reconnectUrl: "" }],
  ])("%s が無ければ null を返す（「(不明)」で埋めて送らない）", (_label, input) => {
    expect(renderReconnectNotice(input)).toBeNull();
  });

  it("空白だけの差し込みも欠けているものとして扱う", () => {
    expect(renderReconnectNotice({ ...INPUT, reconnectUrl: "   " })).toBeNull();
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

/**
 * 記録（修正1・2026-09-09 検収者）。
 *
 * **後から「この日、何と書いて送ったか」を辿れないと記録として不十分である。**
 * 文面を変えたとき、過去に何を送ったかが分からなくなる。
 * `delivery_log.content` は pulse が `lines` に本文を持っているので、形を揃える。
 */
describe("delivery_log に残す内容", () => {
  const PERIOD = "2026-09-09";
  const notice = renderReconnectNotice(INPUT)!;
  const content = reconnectDeliveryContent(PERIOD, notice);

  it("送った本文が行ごとに入る（pulse の lines と同じ形）", () => {
    expect(content.lines).toEqual(notice.body.split("\n"));
  });

  it("**本文が記録から復元できる**（これが目的である）", () => {
    expect((content.lines as string[]).join("\n")).toBe(notice.body);
  });

  it("件名も残す（本文だけでは何の通知か決まらない）", () => {
    expect(content.subject).toBe(notice.subject);
  });

  it("種別と対象期間は従来どおり残る（既存の照会を壊さない）", () => {
    expect(content.notice).toBe("reconnect");
    expect(content.period).toBe(PERIOD);
  });

  it("**陰性**: 必須の3点が記録側から落ちていない", () => {
    const recorded = (content.lines as string[]).join("\n");

    expect(recorded).toContain("配信を停止します");
    expect(recorded).toContain("記録されません");
    expect(recorded).toContain("7日ごとに配信します");
  });

  it("呼び出し側が本文を捨てていない（deliver-pulse が組み立てに使う）", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../supabase/functions/deliver-pulse/index.ts"),
      "utf8",
    ).replace(/\s+/g, " ");

    expect(src).toContain("reconnectDeliveryContent(period, notice)");
    // 本文を持たない旧い形に戻したら赤くする
    expect(src).not.toContain('content: { notice: "reconnect", period }');
  });
});

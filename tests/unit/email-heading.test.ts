/**
 * メールの見出しと色（2026-09-09 決定・検収者）。
 *
 * **異なるものを同じに見せない。** 即時アラートは「アラート」で赤、
 * 再連携のお知らせは「お知らせ」で pulse / weekly と同じ色。
 * 連携が切れているのは**異常ではなく状態**なので、赤で出さない。
 *
 * ここは陰性コントロールが主目的である。**引数化をやめて共通の1つの文字列に戻したら、
 * この試験が赤くなる。** 見た目の回帰は CI では見えないので、呼び出し側まで固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ALERT_HEADING,
  NOTICE_HEADING,
  renderAlertHtml,
  renderPulseHtml,
} from "@edge/_shared/email-html";

/** 見出し以外の語が判定に混じらないよう、本文・件名には「アラート」も「お知らせ」も入れない */
const SUBJECT = "【Sentio】件名";
const BODY = "本文の1行目\n本文の2行目";

const EDGE_DIR = path.resolve(__dirname, "../../supabase/functions");

/** 改行と字下げで判定が崩れないよう、空白を1つに畳んでから突合する */
function readEdgeSource(relative: string): string {
  return readFileSync(path.join(EDGE_DIR, relative), "utf8").replace(/\s+/g, " ");
}

describe("既定は従来どおり（deliver-alert の見た目を既定値で担保する）", () => {
  const html = renderAlertHtml(SUBJECT, BODY);

  it("引数を渡さなければ見出しは「アラート」", () => {
    expect(html).toContain(">アラート<");
  });

  it("引数を渡さなければ色は赤のまま", () => {
    expect(html).toContain(ALERT_HEADING.color);
    expect(ALERT_HEADING.color).toBe("#c0392b");
  });

  it("**陰性**: 即時アラートの見出しが「お知らせ」にならない", () => {
    expect(html).not.toContain("お知らせ");
  });
});

describe("再連携のお知らせ（見出しも色も差し替える）", () => {
  const html = renderAlertHtml(SUBJECT, BODY, NOTICE_HEADING);

  it("見出しは「お知らせ」", () => {
    expect(html).toContain(">お知らせ<");
  });

  it("**陰性**: 再連携の通知の見出しが「アラート」にならない", () => {
    expect(html).not.toContain("アラート");
  });

  it("**陰性**: 再連携の通知にアラートの色（赤）が使われない", () => {
    expect(html).not.toContain(ALERT_HEADING.color);
  });

  it("色は既存の体系から採る（pulse の見出しと同じ値。新しい色を増やさない）", () => {
    // 値を直書きで固定すると「新しい色ではない」ことまでは言えない。
    // **実際に pulse が使っている色と同じであること**を突き合わせる
    expect(renderPulseHtml(["1行目"])).toContain(NOTICE_HEADING.color);
    expect(NOTICE_HEADING.color).not.toBe(ALERT_HEADING.color);
  });
});

describe("呼び出し側（引数化を戻したら赤くなる）", () => {
  it("deliver-pulse の再連携は「お知らせ」の見出しを渡す", () => {
    const src = readEdgeSource("deliver-pulse/index.ts");
    expect(src).toContain("renderAlertHtml(notice.subject, notice.body, NOTICE_HEADING)");
  });

  it("deliver-alert は見出しを渡さない（既定のまま。呼び出しを変えない）", () => {
    const src = readEdgeSource("deliver-alert/index.ts");
    expect(src).toContain("renderAlertHtml(alertContent.subject, alertContent.body)");
  });
});

/**
 * CH-1-1 / CH-2 系: 1行目が列名の行かどうかの判定（契約 スライスCH）。
 *
 * **この判定は誤検知を出した瞬間に取り込みを壊す。** だから「断る側」より
 * 「通す側」の方をテストの本体として扱う（CH-2-1〜CH-2-5 が全部 陰性コントロール）。
 * 閾値の意味は CH-2-4（半数未満なので通る）で固定する。
 */
import { describe, it, expect } from "vitest";
import {
  looksLikeHeaderRow,
  inspectHeaderRow,
  NON_NAME_LIKE_RATIO,
} from "@shared/csv/header-guard";
import {
  ZENGIN_FIRST_ROW,
  BANK_HEADER_ROW,
  STRIPE_HEADER_ROW,
  YAYOI_HEADER_ROW,
  MONTHLY_HEADER_ROW,
  AOZORA_HEADER_ROW,
} from "../fixtures/csv-rows";

describe("CH-1-1 断る: 列名の行が無いファイル", () => {
  it("全銀協フォーマット系の1行目を列名と見なさない", () => {
    expect(looksLikeHeaderRow(ZENGIN_FIRST_ROW)).toBe(false);
  });

  it("内訳が実物と同じ 17列中14 になる（判定の理由が説明できる形で出る）", () => {
    expect(inspectHeaderRow(ZENGIN_FIRST_ROW)).toEqual({
      isHeader: false,
      total: 17,
      nonNameLike: 14,
    });
  });
});

describe("CH-2 通す: 列名の行があるファイルを1つも落とさない", () => {
  it("CH-2-1 銀行入出金明細の列名", () => {
    expect(looksLikeHeaderRow(BANK_HEADER_ROW)).toBe(true);
    expect(inspectHeaderRow(BANK_HEADER_ROW).nonNameLike).toBe(0);
  });

  it("CH-2-2 Stripe 入金レポートの列名", () => {
    expect(looksLikeHeaderRow(STRIPE_HEADER_ROW)).toBe(true);
  });

  it("CH-2-3 弥生仕訳日記帳の列名", () => {
    expect(looksLikeHeaderRow(YAYOI_HEADER_ROW)).toBe(true);
  });

  it("CH-2-4 列名に年月が混ざる形。半数未満なので通る（境界）", () => {
    expect(inspectHeaderRow(MONTHLY_HEADER_ROW)).toEqual({
      isHeader: true,
      total: 3,
      nonNameLike: 0,
    });
  });

  it("CH-2-5 あおぞら銀行の列名付き入出金明細の列名", () => {
    expect(looksLikeHeaderRow(AOZORA_HEADER_ROW)).toBe(true);
  });

  it("CH-D5 半角カナは判定に使わない。カナだけの列名でも通る", () => {
    expect(looksLikeHeaderRow(["ﾋﾂﾞｹ", "ﾃｷﾖｳ", "ｷﾝｶﾞｸ"])).toBe(true);
  });
});

describe("閾値: 半数以上が数値・日付・空なら列名の行ではない", () => {
  it("ちょうど半数で落とす（「半数以上」の以上をここで固定する）", () => {
    expect(inspectHeaderRow(["日付", "9999999"])).toEqual({
      isHeader: false,
      total: 2,
      nonNameLike: 1,
    });
  });

  it("半数未満なら通す", () => {
    expect(looksLikeHeaderRow(["日付", "摘要", "9999999"])).toBe(true);
  });

  it("閾値は定数1つで固定されている（env や設定で変えない）", () => {
    expect(NON_NAME_LIKE_RATIO).toBe(0.5);
  });
});

describe("「列名らしくない」の中身", () => {
  it("数値のみ: 桁区切り・符号・小数点を含めて数える", () => {
    for (const cell of ["0", "123821", "9,999,999", "-1234", "+100", "1.5", "-9,999.25"]) {
      expect(inspectHeaderRow([cell]).nonNameLike).toBe(1);
    }
  });

  it("数値に単位や記号が付いたものは列名として扱う（誤検知を出さない側に倒す）", () => {
    for (const cell of ["金額(円)", "2026年度", "第1四半期", "No.1"]) {
      expect(inspectHeaderRow([cell]).nonNameLike).toBe(0);
    }
  });

  it("日付: 年月日が揃った形だけを数える", () => {
    for (const cell of ["2026-08-01", "2026/8/1", "2026/08/01 12:34", "2026年8月1日"]) {
      expect(inspectHeaderRow([cell]).nonNameLike).toBe(1);
    }
  });

  it("日付: 年月だけ（日が無い）は列名として扱う。CH-2-4 の根拠", () => {
    for (const cell of ["2026年8月", "2026年8月度", "8月"]) {
      expect(inspectHeaderRow([cell]).nonNameLike).toBe(0);
    }
  });

  it("空: 空文字と空白だけのセルを数える", () => {
    expect(inspectHeaderRow(["", "   ", "\t"]).nonNameLike).toBe(3);
  });
});

describe("端の入力（決めてテストで固定する）", () => {
  it("空配列は列名の行ではない。列が1つも無いものに対応表は作れない", () => {
    expect(inspectHeaderRow([])).toEqual({ isHeader: false, total: 0, nonNameLike: 0 });
  });

  it("1セルだけのときも同じ規則を当てる。特別扱いを作らない", () => {
    expect(looksLikeHeaderRow(["摘要"])).toBe(true);
    expect(looksLikeHeaderRow(["9999999"])).toBe(false);
  });

  it("前後の空白は落として判定する", () => {
    expect(inspectHeaderRow([" 123821 "]).nonNameLike).toBe(1);
  });
});

// 日本の会計年度・商慣習に基づく季節コンテキスト。
// generate-question のプロンプト先頭に注入して、
// 「今この時期の経営者の頭の中にあること」を AI に伝える。

const SEASONAL_CONTEXT: Record<number, string> = {
  1: "年初・目標設定・新体制。経営者は期初に向けた方針を言語化し、社内に浸透させたいと考える時期。",
  2: "期末準備・採用活動ピーク。決算対策と次年度の採用計画が並行して走る時期。",
  3: "決算・年度末・人事異動。決算の着地と組織変更の検討が重なり、決断の集中する時期。",
  4: "新年度・新入社員・新体制。新しい体制が動き出し、定着させるための仕掛けが問われる時期。",
  5: "GW明け・連休後の景気感。連休を挟んだ反動や、上半期の実績予想が具体的になる時期。",
  6: "上半期振り返り・ボーナス。上期の着地予測と賞与支給による資金変動が発生する時期。",
  7: "夏季・上半期末。上期の総括と下期戦略の準備、夏季休暇前の意思決定集中期。",
  8: "夏休み・意思決定の停滞期。関係者の休暇で商談や承認が滞りやすく、判断が先送りされがちな時期。",
  9: "下半期スタート・秋採用。下期方針の実行開始と、秋採用・新卒動向への対応が始まる時期。",
  10: "第3四半期・業績確認。年内着地の見込みが固まり、未達リスクへの打ち手が議題化する時期。",
  11: "年末商戦・採用ラッシュ。繁忙期対応と来期採用の確定、予算の最終調整が動く時期。",
  12: "年末・予算策定・来期計画。来期計画の策定と、今期の総括・挨拶回りが重なる時期。",
};

export function getSeasonalContext(now: Date = new Date()): {
  month: number;
  context: string;
} {
  // JST運用を想定。UTCからJSTに変換（+9h）。
  const jstMs = now.getTime() + 9 * 60 * 60 * 1000;
  const jst = new Date(jstMs);
  const month = jst.getUTCMonth() + 1; // 1-12
  return { month, context: SEASONAL_CONTEXT[month] ?? "" };
}

export function buildSeasonalPreamble(now: Date = new Date()): string {
  const { month, context } = getSeasonalContext(now);
  if (!context) return "";
  return `【季節コンテキスト（${month}月）】\n${context}\n\n`;
}

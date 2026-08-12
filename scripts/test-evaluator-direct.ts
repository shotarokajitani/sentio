/**
 * D+3 陰性コントロール: Evaluatorに直接曖昧テキストを渡し、rejectされることを確認
 * E2EパイプラインではGeneratorが常に具体的出力を生成するため、
 * Evaluator単体の判別能力を検証する目的で使用する。
 */
import Anthropic from "@anthropic-ai/sdk";

// ANTHROPIC_API_KEY はシェルから渡す:
// ANTHROPIC_API_KEY=$(head -1 supabase/functions/.env.local | cut -d= -f2-) pnpm exec tsx scripts/test-evaluator-direct.ts

const VAGUE_TEXT = `御社の事業は順調に推移していると思われます。
今後もこの調子で成長が続く可能性があります。
特に何も問題ありません。`;

const GOOD_TEXT = `【見えたこと】
12月の外注費は前月比58%増の190万円（11月: 120万円）に達し、同期間に正社員のカレンダー登録件数は前月比40%減少（11月: 50件 → 12月: 30件）しています。カレンダーデータによると、外注先ドメインはmdc-diseno.comとの会議が12件と突出しています。

【根拠】
入出金明細によると、12月の「外注費」カテゴリの合計は1,900,000円、11月は1,200,000円でした。カレンダーデータによると、12月の社内メンバーのみの予定は30件で、11月の50件から40%減少しています。同じくカレンダーデータによると、会議相手ドメインのうちmdc-diseno.comが12件で最多でした。

【考えられること】
外部データのみに基づく暫定推察ですが、内製体制から外注依存への移行が起きている可能性があります。カレンダーの社内予定減少と外注費増加が同時期に発生している点は、業務の外部委託が進んでいることを示唆するかもしれません。`;

const EVALUATOR_SYSTEM = `あなたはSentioのDay0レポートEvaluatorです。採点結果をJSON形式のみで返してください。JSON以外のテキスト（説明・マークダウン・コードブロック記号）は一切出力しないでください。`;

function buildEvaluatorPrompt(title: string, content: string): string {
  return `採点対象ブロック「${title}」:
${content}

ハード基準（全5基準を通過した場合のみpass。1つでもfailならoverall_pass:false）:
1 像: このブロックを読んだ経営者の頭に、自社の状態が一枚の絵として浮かぶか。数字の羅列や一般論は不合格
2 出所: 全事実に出所が明示されているか（例:「入出金明細によると」「カレンダーデータによると」）。出所不明の事実が1つでもあれば不合格
3 暫定推察: 「外部データのみに基づく暫定推察」であることが明示されているか。断定表現（「である」「に違いない」「確実に」）があれば不合格
4 トーン: 誰かを責めていないか。上から目線・査定口調でないか
5 具体: 実データに基づく数字・傾向・固有名詞が含まれているか。抽象的な一般論のみなら不合格

回答は以下のJSON構造のみ:
{"criteria_1":{"pass":true,"reason":"..."},"criteria_2":{"pass":true,"reason":"..."},"criteria_3":{"pass":true,"reason":"..."},"criteria_4":{"pass":true,"reason":"..."},"criteria_5":{"pass":true,"reason":"..."},"overall_pass":true,"feedback":"不通過時の改善指示"}`;
}

function extractJson(text: string): Record<string, unknown> | null {
  let braceDepth = 0;
  let jsonStart = -1;
  let jsonEnd = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (braceDepth === 0) jsonStart = i;
      braceDepth++;
    } else if (text[i] === "}") {
      braceDepth--;
      if (braceDepth === 0 && jsonStart >= 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }
  if (jsonStart < 0 || jsonEnd < 0) return null;
  return JSON.parse(text.substring(jsonStart, jsonEnd));
}

async function evaluateDirect(
  client: Anthropic,
  label: string,
  content: string,
) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`テスト: ${label}`);
  console.log("=".repeat(60));

  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 16000,
    system: EVALUATOR_SYSTEM,
    messages: [
      { role: "user", content: buildEvaluatorPrompt("初期懸念への初期仮説", content) },
    ],
  });

  const textBlock = response.content.find((c) => c.type === "text");
  const text = textBlock && textBlock.type === "text" ? textBlock.text : "{}";

  const parsed = extractJson(text);
  if (!parsed) {
    console.log("ERROR: JSONパース失敗");
    console.log("raw:", text.substring(0, 200));
    return;
  }

  const scores: Record<string, { pass: boolean; reason: string }> = {};
  for (let i = 1; i <= 5; i++) {
    const c = parsed[`criteria_${i}`] as { pass: boolean; reason: string } | undefined;
    if (c) scores[`criteria_${i}`] = { pass: !!c.pass, reason: c.reason || "" };
  }

  const allPass = Object.values(scores).length >= 5 &&
    Object.values(scores).every((s) => s.pass);

  console.log(`\noverall_pass: ${allPass}`);
  console.log(`scores_count: ${Object.keys(scores).length}/5`);
  console.log(`feedback: ${parsed.feedback || "(なし)"}`);
  console.log("");

  const criteriaNames = ["像", "出所", "暫定推察", "トーン", "具体"];
  for (let i = 1; i <= 5; i++) {
    const s = scores[`criteria_${i}`];
    const name = criteriaNames[i - 1];
    if (s) {
      console.log(`  criteria_${i} (${name}): ${s.pass ? "PASS" : "FAIL"}`);
      console.log(`    reason: ${s.reason}`);
    } else {
      console.log(`  criteria_${i} (${name}): MISSING`);
    }
  }

  return { allPass, scores };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is required");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  // テスト1: 曖昧入力 → reject期待
  const vagueResult = await evaluateDirect(client, "曖昧入力（陰性コントロール）", VAGUE_TEXT);

  // テスト2: 良質入力 → pass期待
  const goodResult = await evaluateDirect(client, "良質入力（陽性コントロール）", GOOD_TEXT);

  console.log(`\n${"=".repeat(60)}`);
  console.log("判定サマリ");
  console.log("=".repeat(60));
  console.log(`曖昧入力: ${vagueResult?.allPass ? "PASS (想定外)" : "REJECT (想定通り)"}`);
  console.log(`良質入力: ${goodResult?.allPass ? "PASS (想定通り)" : "REJECT (想定外)"}`);

  const success = !vagueResult?.allPass && goodResult?.allPass;
  console.log(`\nD+3判定: ${success ? "合格" : "不合格"}`);
  process.exit(success ? 0 : 1);
}

main();

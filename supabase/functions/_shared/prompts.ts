// Prompt texts exported as constants.
// Source of truth: prompts/*.md — keep in sync.
// Edge Runtime sandbox blocks Deno.readTextFile outside the function dir,
// so prompts must be importable as modules.

export const FINDING_TEMPLATE = `# Findingレンダリングテンプレ（週次・基準1/2/4と一対一対応）

【見えたこと】状態が一枚の絵になる1〜2文
【根拠】証拠に遡れる事実2〜3文（出所つき）
【考えられること】残存仮説を断定なしで
【選択肢】次の一手＋「判断は◯◯さんがされることですが」
【ワンタップ】種別①〜④のいずれか（下書き/仮登録で停止）
従業員名を含む場合はケア文脈の文型のみ使用可。`;

export const EVALUATOR_CRITERIA = `# Evaluator ハード5基準（全通過のみpass / revise≤2）

1 像: このFindingを読んだ経営者の頭に、自社の状態が一枚の絵として浮かぶか。数字の羅列や一般論は不合格。
2 証拠: 本文中の全ての事実主張が evidence_event_ids のイベントに遡れるか。遡れない主張が1つでもあれば不合格。
3 棄却: 天候・季節性・祝日・既知イベント（known_explanations）による平凡な説明を検討し、排除の根拠が明記されているか。
4 トーン: 断定していないか。誰かを責めていないか。care_only=trueのエンティティが評価・査定の文脈で扱われていないか。
5 行動: urgencyの判定根拠が書かれ、次の一手が「明日できる」具体性を持つか。
加点(配信優先度のみ): 新奇性 — 経営者がまだ言語化していない可能性が高いか。`;

---
paths: ["supabase/functions/state*/**", "src/state/**"]
---

- 記銘は3経路のみ: baselines再計算（決定的）/ narratives upsert（confidence規則）/ summary再生成（章立て・上限固定）
- 自由文の追記API・カラムを作らない
- baselinesは最低観測数未満なら is_established=false。Sense層はこのフラグを必ず尊重
- narrativesのconfidenceは時間減衰。訂正dialogueで即時減算し、訂正イベント自体を保存
- 想起は記憶パケット編成器の関数を必ず経由（直接SELECTで文脈を組み立てない）
- 従業員entitiesの用途制限フラグを出力系で必ず参照

---
paths: ["supabase/functions/scan*/**", "supabase/functions/investigat*/**", "src/sense/**"]
---
- ScannerはLLMを呼ばない。決定的処理のみ
- immediate緊急度は機械的事実（monitor・期日）専用。LLM生成物にimmediateを付けない
- Investigator: 仮説3件未満のFindingを作らない。全主張に証拠イベントID配列を必須
- Evaluator入力はFinding＋証拠のみ（Generatorの推論過程を渡さない）。revise上限2
- Evaluator 5基準の文言はdocs/spec/03が正。変更はspec更新とセットでのみ
- 調査予算（会社別上限）を必ずチェック。超過はライトパス降格
- Finding台帳のライフサイクル遷移以外でFindingを複製しない（続報はupdate）

# 01 Ingest層（収集・正規化）

| 日付 | セッション | 変更概要 |
|---|---|---|
| 2026-07-23 | #01 | 非スコープ節新設、コネクタ優先順位改訂（チャット→加点要素）、capability概念導入、M365設計枠追加 |

## イベントエンベロープ（下流が知る唯一の形式）

event_id（source＋固有IDのハッシュ。冪等性の要）/ company_id（S0はnull＝共有タイムライン）/
occurred_at / period_start・period_end（期間データ用、任意）/ ingested_at / source（コネクタ＋スキーマ版）/
event_type / actor_ref / entity_refs[] / metrics(jsonb) / sensitivity

## event_type 8分類

transaction（会計仕訳・受注・入出金）/ communication（発言時刻・返信間隔等メタのみ）/
schedule（予定）/ attendance（打刻）/ web（GA4・GSC・GBP・Instagram）/
external（S0公開データ: e-Stat・日銀・gBizINFO・jGrants・競合差分・天候・人流）/
monitor（死活・SSL・速度・コネクタ鮮度）/ dialogue（経営者の返答・質問、従業員1タップ回答）

## sensitivity 4区分

S0 公開（共有タイムライン・1回だけ取込）/ S1 業務 / S2 個人行動メタ（本文フィールドは構造上存在しない）/
S3 本人対話（本文可。由来は本人発話のみ）

## コネクタ4区分（確定カタログ）

A 顧客OAuth（優先順）:
  会計: freee（遡及◎、→MF/弥生Next）
  → カレンダー: Googleカレンダー（遡及◎）・Microsoft 365（設計枠・未実装、下記参照）
  → 勤怠（KOT等）
  → メール: Gmailメタデータ（フェーズ2=CASA後）・Outlook（設計枠・未実装、下記参照）
  → Slack/Chatwork（加点要素。前向きのみ。Slack遡及はMarketplace承認後）
  GA4/GSC（遡及◎）・Instagram（前向き。Meta審査要）・GBP（要利用申請）・
  取引記録型（EC/POS/販売管理: スマレジAPI可、Square等要確認）
  ※Slack/Chatworkは必須ではなく「あれば精度が上がる加点要素」。チャットコネクタがゼロでも成立するのが正規構成
  （従業員99人以下のビジネスチャット導入率は21.6%——日経BPコンサルティング 2024年10月調査）
B Sentio自動収集: e-Stat（小地域拡張）・日銀・Places・為替・RSS・人流・社人研・gBizINFO・jGrants・天候・競合サイト差分・稼働監視
C オンボーダーCSV/Excel投入（Airレジ・弥生・Meta広告・HubSpot・顧客台帳。列マッピングはClaude補助）
D 従業員接点（1タップ回答のみ。唯一の入力）

## 規律

- 冪等バックフィル: 遡及も日次も同一経路。CSVはファイル指紋＋行内容ハッシュでevent_id生成
- 第三者個人情報の最小化: イベントは内部エンティティIDのみ。氏名等はentities台帳が最小限保持
- レート制限レジストリ: コネクタごとの制約（KOT禁止時間帯・Slack 1req/分・Instagram 200/時等）を宣言的に一元管理
- 取込失敗はオンボーディングを妨げない（status記録→再試行。crawl.status方式の一般化）
- トークン型フィールドをどのテーブルにも持たせない（保管はVaultのみ→05）

## エコシステム受け側（予約・v1.5）

Lauda・Motus・Pagusは区分Aの特殊形（自社プロダクト間連携）。Laudaは新実装でレビュー・返信・Score・履行イベントを
本エンベロープ互換（web/external系・S1/S2区分）で出力することを確約済み（2026-07-02 Laudaスレッド）。
Sentio側はsource='lauda'等のイベントを追加開発なしで受けられることをスキーマ上保証する（event_typeとsensitivityの列挙に収まること）。

## 非スコープ（接続対象外）

以下は禁じ手ではなく、現時点の設計対象外である。

- **個人LINE（1:1・グループ）**: LINE利用規約により自動取得不可
- **LINE公式アカウントのIngestコネクタとしての使用**: 送信専用チャネルとしてはAct層で検討（→04）。Ingest側の受信コネクタとしては対象外
- **Facebook Messenger / Instagram DM**: pages_messaging・business_management等のApp Reviewが必要。対象母集団（税理士チャネル経由の製造・建設・小売）と合致しない
- **「顧客接点層」というコネクタ分類**: 上記の結果、この分類自体が成立しないため設けない

参考: LINE WORKSの監査ログダウンロードは有償プラン限定・保存6ヶ月。フリープランは30名上限であり、ターゲット層の網羅にならない。

### コネクタ capability

| capability | 意味 | 該当 |
|---|---|---|
| `full_metadata` | 社内全体のメタデータが取得できる | Slack / Chatwork / LINE WORKS（有償） |
| `partial` | 一部のみ取得できる | LINE WORKS（フリー） |
| `none` | 接続手段が存在しない | 個人LINE |

### Microsoft 365（設計枠・未実装）

- 取得手段: Microsoft Graph API
- 取得対象: Outlook予定表、Teams会議、メールのメタデータ
- 前提: Azure AD アプリ登録＋管理者同意
- 優先度: 勤怠より上位（カレンダーと同列）
- ※詳細仕様は指示書 #02 の調査結果を受けて次セッションで確定

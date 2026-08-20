# 停止点2-a「cron Bearer と service_role キーの静的一致」— 実測結果

実施日: 2026-08-20 / 実施者: 梶谷 / 判定: 検収者
対象: 本番 `kwpldqbnkraftaahnpev`
手順: `docs/runbooks/2026-08-20_cron-bearer-key-match.sql` ＋
`docs/secrets-runbook.md`「service_role キーの保管先は3箇所ある」

## 判定: **合格**

`--no-verify-jwt` を deploy 対象17本すべてから外しても、
`sync-connections` がゲートウェイ層の 401 で止まることはない。

## Q1 — cron ジョブの一覧

**登録は1本のみ。トークンは Vault 参照で、平文の埋め込みは無い。**

| jobid | jobname | schedule (UTC) | active | token_kind |
| --- | --- | --- | --- | --- |
| 9 | `sync-connections` | `0 0,6,12,18 * * *` | `true` | **Vault 参照** |

`command` は次の形（`command_redacted` と `command_raw` が同一＝
正規表現による置換が発生していない＝**平文トークンは含まれていない**）。

```sql
SELECT net.http_post(
  url := public.read_vault_secret_by_name('sentio_supabase_url') || '/functions/v1/sync-connections',
  headers := jsonb_build_object(
    'Authorization', 'Bearer ' || public.read_vault_secret_by_name('sentio_service_role_key'),
    'Content-Type', 'application/json'
  ),
  body := '{}'::jsonb
);
```

`0 0,6,12,18 * * *`（UTC）＝ **JST 9 / 15 / 21 / 3 時**。契約書の記述と一致。

Q3（リテラル埋め込み時の是正）は**該当なし**。

## Q2 と突き合わせ相手の指紋

| 項目 | Vault `sentio_service_role_key` | 現行 service_role（Legacy API Keys） | 判定 |
| --- | --- | --- | --- |
| `len` | 219 | 219 | 一致 |
| `tail` | `bIpk` | `bIpk` | 一致 |
| `prefix` | `eyJ` | `eyJ` | 一致 |
| `sha256` | — | — | **一致（同一の値）** |

> `sha256` の値そのものは**このリポジトリが public のため記載しない**。
> 一致したという事実のみを記録する。再検証が要る場合は上記の手順で採り直すこと。

`prefix = eyJ` はレガシー JWT 形式であり、Edge Functions のゲートウェイ `verify_jwt` を通る。

## 手順書の不備（次回までに直すこと）

1. **`docs/secrets-runbook.md:126-134` の PowerShell が複数行で書かれている。**
   対話コンソールに貼ると行の途中で切れて `MissingExpressionAfterToken` になる（実測）。
   **1行版に直すこと。**
2. **`Read-Host -AsSecureString` は入力が画面に出ないため、貼り付けが効かないまま
   Enter される事故が起きる**（実測: `len=0` / 空文字列の SHA-256 が出た）。
   クリップボードから直接読む形に変えること。
3. **クリップボード方式には順序の罠がある。**
   コマンドをコピーして貼った時点で、鍵がクリップボードから消える（実測: `len=281`、
   `prefix=$p`、`tail=le p` ＝ コマンド自身のハッシュが出た）。
   **先に関数として定義しておき、鍵をコピーした後に関数名だけを打つ**形にすること。

   ```powershell
   # 1. 先にこれを貼って定義する
   function fp { $p=(Get-Clipboard).Trim(); "len=$($p.Length) tail=$($p.Substring($p.Length-4)) prefix=$($p.Substring(0,3)) sha256=$(([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($p))) -replace '-','').ToLower())" }
   # 2. ダッシュボードで鍵をコピーする
   # 3. PowerShell に戻り、fp と打って Enter（貼り付けない）
   ```

4. **ダッシュボードの場所が変わっている。**
   `Settings → API` ではなく **`Settings → API Keys` の「Legacy API Keys」タブ**。
   既定で表示されるのは新形式（`sb_publishable_...` / `sb_secret_...`）で、
   `anon` / `service_role` の JWT は別タブに移った。
   URL: `https://supabase.com/dashboard/project/<ref>/settings/api-keys`

## 期限のある論点（`07_open_items.md` へ登録すること）

Supabase 公式ドキュメント（`https://supabase.com/docs/guides/getting-started/api-keys`）に
次の2点が併記されている。**このままでは衝突する。**

> Edge Functions **only support JWT verification** via the `anon` and `service_role`
> JWT-based API keys. You will need to use the `--no-verify-jwt` option when using
> publishable and secret keys.

> They will be deprecated **by the end of 2026**, and you should now use the
> publishable (`sb_publishable_xxx`) and secret (`sb_secret_xxx`) keys instead.

つまり、

- 本スライスで17本すべてから `--no-verify-jwt` を外した ＝ **レガシー JWT キーに依存している**
- そのレガシーキーは **2026年末に廃止予定**
- 新形式キーに移ると、ゲートウェイの JWT 検証が使えなくなり
  `--no-verify-jwt` を戻すことになる ＝ **S-方針2 の案B（ゲートウェイ層）が失われる**

移行時に何を担保に置き換えるか（`apikey` ヘッダの自前検証を Function 内に実装するのか、
別の層を立てるのか）は**未判断**。勝手に確定させないこと。

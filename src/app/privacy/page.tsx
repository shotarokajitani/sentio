import { Masthead } from "@/components/Masthead";
import { t } from "@/i18n";

export const metadata = { title: `${t.legal.privacyTitle} — ${t.brand}` };

const UPDATED_AT = "2026-08-19";

export default function PrivacyPage() {
  return (
    <main className="page prose">
      <Masthead />

      <h1>{t.legal.privacyTitle}</h1>
      <p className="lead">
        {t.legal.updatedAt} {UPDATED_AT}
      </p>

      <h2>1. 取得する情報</h2>
      <p>Sentio は、お客様が接続を許可した会社情報から次の情報を取得します。</p>
      <ul>
        <li>
          Google カレンダー:
          予定の開始・終了時刻、参加者数、件名、参加者のメールアドレス（読み取りのみ）
        </li>
        <li>freee 会計: 取引の日付・金額・入出金区分・摘要（読み取りのみ）</li>
        <li>会計CSV: お客様がアップロードしたファイルに含まれる日付・金額・摘要・残高</li>
        <li>アカウント情報: メールアドレス、認証に用いるパスワードのハッシュ</li>
      </ul>
      <p>
        メール本文・チャット本文は取得しません。カレンダーとの連携は読み取り専用の権限のみを要求し、
        予定の作成・変更・削除は行いません。
      </p>

      <h2>2. 利用目的</h2>
      <p>
        取得した情報は、お客様の会社の状況を把握し、変化や注意すべき事象をお客様にお伝えするためにのみ
        利用します。広告配信、第三者への販売、他のお客様への提供は行いません。
      </p>
      <p>
        Google API から取得した情報の利用は、
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        （Limited Use の要件を含む）に準拠します。
      </p>

      <h2>3. 認証情報の取り扱い</h2>
      <p>
        Google および freee のアクセストークン・リフレッシュトークンは、Supabase Vault
        に暗号化して保管します。アプリケーションのログ、データベースの一般のテーブル、
        ソースコード、設定ファイルには保存しません。
      </p>

      <h2>4. 保管場所と保管期間</h2>
      <p>
        データは Supabase（PostgreSQL）および Vercel の提供するインフラ上に保管します。
        アカウントの削除をご依頼いただいた場合、当該アカウントに紐づくデータと認証情報を削除します。
      </p>

      <h2>5. 第三者提供</h2>
      <p>
        法令に基づく場合を除き、お客様のデータを第三者に提供しません。
        サービスの提供に必要な範囲で、以下の事業者の設備を利用します。
      </p>
      <ul>
        <li>Supabase（データベース・認証・秘密情報の保管）— 米国</li>
        <li>Vercel（アプリケーションの実行）— 米国</li>
        <li>Anthropic（文章の生成。送信する情報は分析に必要な範囲に限ります）— 米国</li>
        <li>Resend（メールの送信）— 米国</li>
      </ul>
      <p>
        上記はいずれも米国の事業者であり、お客様のデータは米国内の設備で取り扱われることがあります。
      </p>

      <h2>6. アクセス権限の取り消し</h2>
      <p>
        Google との連携は、お客様の Google アカウント設定からいつでも取り消せます。
        取り消し後、Sentio は当該の会社情報からの取得を順次停止し、画面上は「要再連携」と
        表示されます。取り消しが画面の表示に反映されるまで、最大1時間程度かかることがあります。
      </p>

      <h2>7. 開示・訂正・利用停止等のご請求</h2>
      <p>
        保有個人データの開示、内容の訂正・追加・削除、利用の停止・消去、第三者提供の停止の
        ご請求は、下記のお問い合わせ先で受け付けます。ご本人であることを確認のうえ、
        法令に従って対応します。
      </p>

      <h2>8. お問い合わせ</h2>
      <ul>
        <li>運営者: 株式会社ディセーノ</li>
        <li>
          お問い合わせ先: <a href="mailto:support@mdc-diseno.com">support@mdc-diseno.com</a>
        </li>
      </ul>
      <p>住所および代表者氏名は、お求めに応じて遅滞なく回答します。</p>

      <p className="footnote">
        <a href="/terms">{t.legal.termsTitle}</a> ・ <a href="/login">{t.login.title}</a>
      </p>
    </main>
  );
}

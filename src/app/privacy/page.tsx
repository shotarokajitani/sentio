import { Masthead } from "@/components/Masthead";
import { t } from "@/i18n";

export const metadata = { title: `${t.legal.privacyTitle} — ${t.brand}` };

const UPDATED_AT = "2026-09-03";

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

      <h2>4. Google ユーザーデータの共有・移転・開示先</h2>
      <p>
        Sentio が Google API を通じて取得した情報（以下「Google ユーザーデータ」）は、
        <strong>販売しません。広告目的で利用しません。他のお客様に提供しません。</strong>
        法令に基づく開示請求を受けた場合を除き、第三者に提供しません。
      </p>
      <p>
        サービスを提供するために、次の事業者（いずれも当社の委託先）の設備を利用します。 各社が
        Google ユーザーデータに触れる範囲は下表のとおりです。
      </p>
      {/* 4列あるので、狭い画面では表だけを横スクロールさせる（本文は折り返す） */}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>委託先</th>
              <th>役割</th>
              <th>Google ユーザーデータの取り扱い</th>
              <th>所在地</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Supabase</td>
              <td>データベース・認証・秘密情報の保管</td>
              <td>
                <strong>保管する。</strong>
                予定の日時・件名・参加者のメールアドレスを暗号化された記憶域に保存します
              </td>
              <td>米国</td>
            </tr>
            <tr>
              <td>Anthropic</td>
              <td>本文の生成（分析結果の文章化）</td>
              <td>
                <strong>送信する。</strong>
                分析に必要な範囲の予定情報を送信します。送信した情報を Anthropic
                がモデルの学習に用いることはありません
              </td>
              <td>米国</td>
            </tr>
            <tr>
              <td>Resend</td>
              <td>通知メールの送信</td>
              <td>
                <strong>経由する。</strong>
                生成された通知メールの本文に、予定から導いた記述が含まれることがあります
              </td>
              <td>米国</td>
            </tr>
            <tr>
              <td>Vercel</td>
              <td>アプリケーションの実行・画面の配信</td>
              <td>
                <strong>保存しない。</strong>
                画面表示のため通信経路として通過します
              </td>
              <td>米国</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        上記はいずれも米国の事業者であり、Google ユーザーデータは米国内の設備で
        取り扱われることがあります。当社は各社と契約を締結し、当社の指示の範囲でのみ
        取り扱うこと、および安全管理措置を講じることを求めています。
      </p>
      <p>
        Google ユーザーデータの利用および移転は、
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        （Limited Use の要件を含む）に準拠します。
      </p>

      <h2>5. 安全管理措置</h2>
      <p>Google ユーザーデータを含むお客様の情報を保護するため、次の措置を講じています。</p>
      <ul>
        <li>
          <strong>通信の暗号化</strong>: 外部との通信はすべて TLS
          で暗号化します。暗号化されていない経路でデータを送受信しません
        </li>
        <li>
          <strong>保存時の暗号化</strong>: データベースの記憶域は暗号化されています
        </li>
        <li>
          <strong>認証情報の隔離</strong>: Google のアクセストークン・リフレッシュトークンは
          Supabase Vault にのみ保管し、専用の関数を経由してのみ読み出せます。
          一般のテーブル・ログ・ソースコード・設定ファイルには一切置きません
        </li>
        <li>
          <strong>行単位のアクセス制御</strong>: すべてのテーブルで Row Level Security
          を有効にし、お客様は自社の行だけを読み書きできます。他社の行にはアクセスできません
        </li>
        <li>
          <strong>API の認証必須化</strong>: サーバ側の処理はすべて認証を必須とし、
          認証のない要求は処理に到達する前に拒否します
        </li>
        <li>
          <strong>最小限の取得</strong>: カレンダーは<strong>読み取り専用</strong>
          の権限のみを要求します。予定の作成・変更・削除は行いません。
          メール本文・チャット本文は取得しません
        </li>
        <li>
          <strong>従業者の制限</strong>:
          本番環境のデータにアクセスできる従業者を必要最小限に限定し、 アクセスは記録されます
        </li>
      </ul>

      <h2>6. Google ユーザーデータの保持期間と削除</h2>
      <h3>保持期間</h3>
      <p>
        Google ユーザーデータは、<strong>取得した日から24ヶ月</strong>
        経過した時点で削除します。会社の状態を前年と比較して変化を検出するために
        2年分を必要とするためであり、それを超える期間は保持しません。
      </p>
      <h3>連携を解除した場合</h3>
      <p>
        お客様が Sentio の画面または Google アカウントの設定から Google との連携を解除した場合、
      </p>
      <ul>
        <li>
          アクセストークン・リフレッシュトークンを<strong>直ちに破棄</strong>します
        </li>
        <li>
          当該連携から取得した Google ユーザーデータを
          <strong>30日以内に削除</strong>します
        </li>
      </ul>
      <h3>アカウントを削除する場合</h3>
      <p>
        アカウントの削除は
        <a href="mailto:support@mdc-diseno.com">support@mdc-diseno.com</a>
        へのご連絡で承ります。ご本人であることを確認のうえ、
        <strong>ご依頼から30日以内に</strong>、当該アカウントに紐づくすべてのデータ （Google
        ユーザーデータ、認証情報、生成された分析結果を含む）を削除します。
        削除の完了はメールでご報告します。
      </p>
      <h3>バックアップからの削除</h3>
      <p>
        削除後もバックアップに一時的に残ることがありますが、 バックアップは<strong>最長35日</strong>
        で世代交代し、その時点で失われます。 バックアップから復元することはありません。
      </p>

      <h2>7. アクセス権限の取り消し</h2>
      <p>
        Google との連携は、お客様の Google アカウント設定からいつでも取り消せます。
        取り消し後、Sentio は当該の会社情報からの取得を順次停止し、画面上は「要再連携」と
        表示されます。取り消しが画面の表示に反映されるまで、最大6時間程度かかることがあります。
      </p>

      <h2>8. 開示・訂正・利用停止等のご請求</h2>
      <p>
        保有個人データの開示、内容の訂正・追加・削除、利用の停止・消去、第三者提供の停止の
        ご請求は、下記のお問い合わせ先で受け付けます。ご本人であることを確認のうえ、
        法令に従って対応します。
      </p>

      <h2>9. お問い合わせ</h2>
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

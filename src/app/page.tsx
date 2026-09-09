import { Masthead } from "@/components/Masthead";
import { t } from "@/i18n";
import { SENTIO_PRICE_JPY_TAX_INCLUDED, SENTIO_TRIAL_DAYS } from "@/lib/pricing";

/**
 * トップページ（ランディング）。**7ブロック。ページは増やさない**（2026-09-09 検収者）。
 *
 * ここが無いとルートが404になる。Google の審査は
 * 「ホームページからプライバシーポリシーに辿れること」を要求するため、
 * フッターの `/privacy` リンクは体裁ではなく要件である
 * （`tests/unit/landing.test.ts` が欠落を止める）。
 *
 * 金額と無料期間は `@/lib/pricing` から差し込む。**数字をここに書かない。**
 *
 * 認証状態は見ない。未ログインの初見が読む面なので、
 * セッション解決を挟まず静的に返す。
 *
 * **特商法の表記へのリンクは、窓口のアドレスが設定されているときだけ出す**（7-4）。
 * `/legal` は未設定なら 404 を返すので、出しっぱなしにすると 404 へのリンクが残る。
 */
export default function LandingPage() {
  const hasSupportEmail = Boolean(process.env.SENTIO_SUPPORT_EMAIL?.trim());

  return (
    <main className="page">
      <Masthead />

      {/* ブロック1 */}
      <h1>{t.landing.title}</h1>
      <p className="lead">{t.landing.lead}</p>
      <p className="lead" style={{ marginTop: 0 }}>
        {t.landing.lead2}
      </p>

      <div className="actions" style={{ marginTop: 40 }}>
        <a className="btn" href="/login">
          {t.landing.start}
        </a>
      </div>
      <p className="footnote">{t.landing.startTrial(SENTIO_TRIAL_DAYS)}</p>

      {/* ブロック2 */}
      <section className="section prose">
        <h2>{t.landing.nowTitle}</h2>
        {t.landing.now.map((item) => (
          <div key={item.title}>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
          </div>
        ))}
      </section>

      {/* ブロック3。**できないことを同じ大きさで書く** */}
      <section className="section prose">
        <h2>{t.landing.notYetTitle}</h2>
        {t.landing.notYet.map((item) => (
          <div key={item.title}>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
          </div>
        ))}
      </section>

      {/* ブロック4 */}
      <section className="section prose">
        <h2>{t.landing.stepsTitle}</h2>
        <ol>
          {t.landing.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <div className="actions">
          <a className="btn" href="/login">
            {t.landing.start}
          </a>
        </div>
      </section>

      {/* ブロック5 */}
      <section className="section prose">
        <h2>{t.landing.priceTitle}</h2>
        <p>{t.landing.priceAmount(SENTIO_PRICE_JPY_TAX_INCLUDED)}</p>
        <p>{t.landing.priceTrial(SENTIO_TRIAL_DAYS)}</p>
        <p>{t.landing.priceTrialNote}</p>
        <p>{t.landing.priceCancel}</p>
        <p>{t.landing.priceCancelNote}</p>
      </section>

      {/* ブロック6 */}
      <section className="section prose">
        <h2>{t.landing.faqTitle}</h2>
        {t.landing.faq.map((item) => (
          <div key={item.q}>
            <h3>{item.q}</h3>
            <p>{item.a}</p>
          </div>
        ))}
      </section>

      {/* ブロック7 */}
      <section className="section prose">
        <p>{t.landing.company}</p>
        <p>{t.landing.companyAddress}</p>
      </section>

      <p className="footnote">
        <a href="/terms">{t.login.terms}</a> ／ <a href="/privacy">{t.login.privacy}</a>
        {hasSupportEmail ? (
          <>
            {" ／ "}
            <a href="/legal">{t.legal.noticeTitle}</a>
          </>
        ) : null}
      </p>
    </main>
  );
}

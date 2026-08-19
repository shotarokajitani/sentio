import { Masthead } from "@/components/Masthead";
import { t } from "@/i18n";

/**
 * トップページ（ランディング）。
 *
 * ここが無いとルートが404になる。Google の審査は
 * 「ホームページからプライバシーポリシーに辿れること」を要求するため、
 * フッターの `/privacy` リンクは体裁ではなく要件である
 * （`tests/unit/landing.test.ts` が欠落を止める）。
 *
 * 認証状態は見ない。未ログインの初見が読む面なので、
 * セッション解決を挟まず静的に返す。
 */
export default function LandingPage() {
  return (
    <main className="page">
      <Masthead />

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

      {/* 審査は「アプリの目的の説明」をホームページ本文に求める。
          上の見出し・lead は情緒の文なので、事実記述はここに分けて置く */}
      <section className="section">
        <h2>{t.landing.aboutTitle}</h2>
        <p className="lead">{t.landing.about}</p>
        <p className="lead" style={{ marginTop: 0 }}>
          {t.landing.about2}
        </p>
      </section>

      <p className="footnote">
        <a href="/terms">{t.login.terms}</a> ・ <a href="/privacy">{t.login.privacy}</a>
      </p>
    </main>
  );
}

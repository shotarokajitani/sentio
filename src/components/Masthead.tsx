import { t } from "@/i18n";

/**
 * ワードマークの描画単位。
 *
 * 「Sentio」の e だけをアクセント色にするため、表示上3つに割る。
 * ブランド固有名詞は文言辞書を経由しなくてよい例外（`src/i18n/ja.ts` 冒頭）。
 * 分割の正しさ（連結するとブランド名になる・アクセントは e だけ）は
 * `tests/unit/wordmark.test.ts` が機械的に留める。
 */
export const WORDMARK_SEGMENTS = [
  { text: "S", accent: false },
  { text: "e", accent: true },
  { text: "ntio", accent: false },
] as const;

/**
 * 全画面共通の題字。
 * ロゴらしい主張はさせず、細い罫線1本で本文と隔てるだけにする。
 */
export function Masthead({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <header className="masthead">
      {/* 分割はあくまで着色のため。読み上げ・選択・検索では1語として繋がる。
          ただし分割後のHTMLには連続した「Sentio」が現れず、Google の OAuth
          ブランディング審査が「同意画面のアプリ名がホームページに無い」と判定した。
          分割は変えず、属性で平文のブランド名を与えて機械可読にする */}
      <span className="wordmark" aria-label="Sentio" title="Sentio">
        {WORDMARK_SEGMENTS.map((seg, i) => (
          <span key={i} className={seg.accent ? "wordmark-accent" : undefined}>
            {seg.text}
          </span>
        ))}
      </span>
      {signedIn ? (
        <form method="post" action="/api/auth/signout">
          <button type="submit" className="btn-plain">
            {t.common.signOut}
          </button>
        </form>
      ) : null}
    </header>
  );
}

import { t } from "@/i18n";

/**
 * 全画面共通の題字。
 * ロゴらしい主張はさせず、細い罫線1本で本文と隔てるだけにする。
 */
export function Masthead({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <header className="masthead">
      <span className="wordmark">{t.brand}</span>
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

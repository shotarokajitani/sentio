import { permanentRedirect } from "next/navigation";
import { loginMode } from "@/lib/auth/login-view";

/**
 * `/register` は**登録の入口ではない**（2026-09-08 決定）。
 *
 * 登録は `#101` で `/login?mode=signup` に一本化した。
 * この画面は**フォームを1つも持たない着地ページ**で、リポジトリ内からのリンクも0件だった。
 *
 * **消さずに転送するのは、外部のブックマークや検索流入に 404 を出さないため。**
 * 手間は消すのとほぼ同じで、失うものが無い。
 *
 * **`/register/complete` は別物で、生きている。** Google 連携の完了後に
 * `auth/callback/google/route.ts` が `?events=N` 付きで飛ばし、
 * `middleware.ts` の保護対象にも入っている。**ここでその経路を巻き込まないよう、
 * 転送は `/register` ちょうどのときだけ効く**（Next.js のルーティング上、
 * このファイルは `/register` にしか対応しない）。
 */
type Search = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function RegisterPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;

  // 受け取った `next` は引き継ぐ（連携の途中で来た人を落とさない）。
  // **`?mode=` は素通しにしない。** `loginMode` を通して知らない値を login に倒す
  const next = first(params.next) ?? "/connect";
  const mode = loginMode(first(params.mode) ?? "signup");
  const query = new URLSearchParams(mode === "signup" ? { mode: "signup", next } : { next });

  // **恒久転送。** 一時転送だと、外部のブックマークがいつまでも古い URL を指し続ける
  permanentRedirect(`/login?${query.toString()}`);
}

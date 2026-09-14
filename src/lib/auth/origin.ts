/**
 * ログインの POST が自分のサイトから来たか（2026-09-13 の点検・PR-3 の 16）。**判断だけを持つ。**
 *
 * `POST /api/auth/session` は Origin を見ていなかった。他のサイトに置いたフォームから
 * 利用者のブラウザで送らせると、**攻撃者のアカウントでログインさせる**（login CSRF）ことができた。
 * ログインさせた後に利用者が CSV を取り込めば、その明細は攻撃者のアカウントに入る。
 *
 * ## 決め方
 *
 * - `Origin` が `NEXT_PUBLIC_SITE_ORIGIN` と一致すれば通す（末尾の `/` は無視する）
 * - **`Origin` が無ければ断る。** ブラウザはフォームの POST に必ず `Origin` を付ける
 * - **`NEXT_PUBLIC_SITE_ORIGIN` が未設定なら断る**（何とも照合できない状態を「通す」にしない）
 */

export type OriginVerdict =
  | { ok: true }
  | { ok: false; reason: "origin_missing" | "origin_mismatch" | "site_origin_unset" };

function normalize(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

export function checkOrigin(origin: string | null, siteOrigin: string | undefined): OriginVerdict {
  if (!siteOrigin || normalize(siteOrigin) === "") return { ok: false, reason: "site_origin_unset" };
  if (!origin || normalize(origin) === "") return { ok: false, reason: "origin_missing" };
  return normalize(origin) === normalize(siteOrigin)
    ? { ok: true }
    : { ok: false, reason: "origin_mismatch" };
}

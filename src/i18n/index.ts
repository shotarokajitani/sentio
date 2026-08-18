import { ja } from "./ja";

export const t = ja;

type ErrorKey = keyof typeof ja.errors;

/**
 * URLの `?e=` を利用者向けの文言に変換する。
 *
 * 内部コードをそのまま画面に出さないための唯一の入口（運用ルール§6）。
 * 辞書に無いキーは汎用文言に落とす。生の値を画面へ通さない
 */
export function errorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  const known = Object.prototype.hasOwnProperty.call(ja.errors, code);
  return known ? ja.errors[code as ErrorKey] : ja.errors.unknown;
}

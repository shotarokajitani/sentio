import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  TEST_RECIPIENT,
  HUMAN_VERIFY_RECIPIENT,
  isReservedTestAddress,
  assertNoLiveMailConfig,
} from "../fixtures/recipients";

/**
 * S-2-10 の担保。**送信事故の防止はコードの主張ではなく検査で示す。**
 *
 * 2つのことを機械で止める:
 *
 * 1. 自動テストの宛先が「到達するアドレス」になっていないこと
 * 2. 顧客の実アドレスがフィクスチャ・テストデータに紛れ込まないこと
 */

/** 検証・手順書で正当に登場してよいアドレス。ここに顧客のアドレスは入らない */
const ALLOWED_REAL_ADDRESSES = new Set([
  HUMAN_VERIFY_RECIPIENT.toLowerCase(),
  // 既存の実測記録に残る値（削除すると証跡が壊れるため許可する）
  "shotaro.kajitani@mdc-diseno.com",
  // 外部の連絡先（BOJ API の通知先。gotchas に規約として書いてある）
  "post.rsd17@boj.or.jp",
  "onboarding@resend.dev",
]);

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|json|sql|fixture|csv)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("検証メールの宛先 (S-2-10)", () => {
  it("自動テストの宛先は予約ドメインで、誰にも到達しない", () => {
    expect(isReservedTestAddress(TEST_RECIPIENT)).toBe(true);
  });

  it("人間が受信を確認する宛先は、予約ドメインではない（実際に届く必要がある）", () => {
    expect(isReservedTestAddress(HUMAN_VERIFY_RECIPIENT)).toBe(false);
  });

  it("予約ドメインの判定がサブドメインにも効き、他ドメインを取り違えない", () => {
    expect(isReservedTestAddress("a@mail.example.com")).toBe(true);
    // 前方一致で誤判定する実装を弾く
    expect(isReservedTestAddress("a@example.com.evil.jp")).toBe(false);
    expect(isReservedTestAddress("a@notexample.com")).toBe(false);
    expect(isReservedTestAddress("no-at-sign")).toBe(false);
  });

  it("Resend の設定が載っていたら throw する（skip で緑にしない）", () => {
    expect(() => assertNoLiveMailConfig({ RESEND_API_KEY: "re_live_xxx" })).toThrow(
      /RESEND_API_KEY/,
    );
    expect(() => assertNoLiveMailConfig({ RESEND_FROM: "a@b.jp" })).toThrow(/RESEND_FROM/);
    // 空文字は「未設定」と同じ扱い
    expect(() => assertNoLiveMailConfig({ RESEND_API_KEY: "", RESEND_FROM: "  " })).not.toThrow();
  });

  it("この実行環境に Resend の設定が載っていない（deliver 系を走らせてよい状態）", () => {
    expect(() => assertNoLiveMailConfig()).not.toThrow();
  });

  it("フィクスチャ・テストデータに、許可されていない実アドレスが入っていない", () => {
    const offenders: string[] = [];

    // このファイル自身だけは対象外。予約ドメイン判定の**陰性コントロール**として
    // 意図的に非予約ドメインの文字列を持っているため（除外はここ1本に限る）
    const selfPath = relative(process.cwd(), __filename);

    for (const file of [...walk("tests"), ...walk("supabase/functions"), ...walk("scripts")]) {
      if (relative(process.cwd(), file) === selfPath) continue;
      const text = readFileSync(file, "utf8");
      for (const address of text.match(EMAIL_PATTERN) ?? []) {
        const lower = address.toLowerCase();
        if (isReservedTestAddress(lower)) continue;
        if (ALLOWED_REAL_ADDRESSES.has(lower)) continue;
        offenders.push(`${relative(process.cwd(), file)}: ${address}`);
      }
    }

    expect(offenders, `到達しうるアドレスが混入している:\n${offenders.join("\n")}`).toEqual([]);
  });
});

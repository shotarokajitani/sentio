/**
 * 検証メールの宛先。**ここが唯一の出所**（契約 S-2-10）。
 *
 * 用途で分ける。単一の値にしない。
 *
 * - **ローカル / CI の自動テスト** → `TEST_RECIPIENT`。RFC 2606 の予約ドメインで、
 *   誰にも到達しない。この経路は `RESEND_API_KEY` を渡さず**そもそも送信しない**ので
 *   到達性は要件にならない。逆に到達するアドレスを焼き込むと、
 *   **キーが混入した瞬間に実メールが飛ぶ**。事故時の被害をゼロにする方を採る
 * - **人間が受信を確認する経路**（本番手順書・S-3-2 の一気通貫）→ `HUMAN_VERIFY_RECIPIENT`。
 *   プラス記法にしてあるのはフィルタで隔離でき、本番の通知と混ざらないため。
 *   専用エイリアス（`sentio-test@` を自社ドメインに作る）の依頼は
 *   `docs/spec/07_open_items.md` に積んである（ブロッカーではない）。
 *   できたらここを1行差し替える
 *
 * **顧客の実アドレスをここにも他のフィクスチャにも書かない。**
 * `tests/unit/test-recipients.test.ts` が機械的に検査する。
 */

/** ローカル / CI の自動テスト用。RFC 2606 予約ドメイン＝誰にも到達しない */
export const TEST_RECIPIENT = "sentio-e2e@example.com";

/** 人間が実際に受信を確認する経路用（実送信を伴う検収） */
export const HUMAN_VERIFY_RECIPIENT = "shotaro.kajitani+sentio-e2e@mdc-diseno.com";

/**
 * 自動テストが使ってよいドメイン。RFC 2606 / RFC 6761 の予約ドメインのみ。
 * ここに実在ドメインを足すと「テストのつもりで実メールが飛ぶ」経路ができる。
 */
export const RESERVED_TEST_DOMAINS = ["example.com", "example.org", "example.net", "invalid"];

export function isReservedTestAddress(address: string): boolean {
  const domain = address.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  return RESERVED_TEST_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * 本番の Resend 設定がこのプロセスに載っていないことを確かめる（契約 S-2-10）。
 *
 * **deliver 系のテストを走らせる前に必ず呼ぶ。** 環境変数が1つでも載っていたら、
 * テストが実際にメールを送りうる。skip ではなく **throw** にしているのは、
 * 「設定が載っていたので静かにテストをやめた」を緑にしないため
 * （`check:allowlist` が1行 log で緑を返していたのと同型の空洞を作らない）。
 */
export function assertNoLiveMailConfig(
  env: Record<string, string | undefined> = process.env,
): void {
  const present = ["RESEND_API_KEY", "RESEND_FROM"].filter((k) => (env[k] ?? "").trim().length > 0);

  if (present.length > 0) {
    throw new Error(
      `deliver 系のテスト環境に ${present.join(" / ")} が載っている。` +
        "この状態でテストを走らせると実際にメールが送信されうるため中止する。" +
        "ローカル / CI は Resend の設定なしで実行すること（契約 S-2-10）",
    );
  }
}

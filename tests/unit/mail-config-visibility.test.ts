/**
 * 送信設定が無いときに、**それを見える形で残す**（発注 A-1 / A-2）。
 *
 * ## 直す前に何が起きていたか
 *
 * `resolveNextMailConfig` が欠落を見つけると `console.error` を1行出して終わっていた。
 * **Vercel のログは保持期間で流れる。** 流れたあとは
 * 「0通だった」のか「一度も試していない」のかを区別する材料が無くなる。
 *
 * さらに Vercel の環境変数は CI からは読めない。Supabase の Function Secrets に
 * 入れても Next からは見えないので、**「入れたつもり」が成立してしまう。**
 * 実測（2026-09-10・`vercel env ls production`）では
 * `RESEND_API_KEY` / `RESEND_FROM` はどちらも1件も無かった。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MAIL_CONFIG_MISSING,
  NEXT_MAIL_ENV_KEYS,
  recordMailConfigMissing,
  resolveNextMailConfig,
  type MailFailureDb,
} from "@/lib/mail/send";

/** insert された行を覚えるだけの stub */
function createDbStub(error: unknown = null) {
  const rows: Record<string, unknown>[] = [];
  const db: MailFailureDb = {
    from(table: string) {
      expect(table).toBe("delivery_log");
      return {
        insert(row: Record<string, unknown>) {
          rows.push(row);
          return Promise.resolve({ error });
        },
      };
    },
  };
  return { db, rows };
}

const RECORD = {
  companyId: "11111111-1111-1111-1111-111111111111",
  deliveryType: "trial_ending",
  idempotencyKey: "trial_ending:11111111-1111-1111-1111-111111111111:sub_1",
  missing: ["RESEND_API_KEY"],
};

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("設定が欠けていたら delivery_log に1行残す", () => {
  it("status=failed / last_error=mail_config_missing の行が1行できる", async () => {
    const { db, rows } = createDbStub();

    const out = await recordMailConfigMissing(db, RECORD);

    expect(out.recorded).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      company_id: RECORD.companyId,
      channel: "email",
      delivery_type: "trial_ending",
      status: "failed",
      last_error: MAIL_CONFIG_MISSING,
      idempotency_key: RECORD.idempotencyKey,
      // **一度も送っていない。** 試行回数を1にすると「1回試して落ちた」と読める
      attempts: 0,
    });
    expect(rows[0].content).toEqual({ missing: ["RESEND_API_KEY"] });
    expect(typeof rows[0].last_error_at).toBe("string");
  });

  it("**陰性**: 2回目は一意制約で弾かれ、例外にしない（同じ購読の再送）", async () => {
    const { db } = createDbStub({ code: "23505", message: "duplicate key" });

    const out = await recordMailConfigMissing(db, RECORD);

    expect(out).toEqual({ recorded: false, reason: "already_recorded" });
  });

  it("**陰性**: 記録そのものが失敗しても投げない（購読の更新を巻き戻さない）", async () => {
    const { db } = createDbStub({ code: "08006", message: "connection failure" });

    const out = await recordMailConfigMissing(db, RECORD);

    expect(out.recorded).toBe(false);
    expect(out.reason).toBe("connection failure");
  });

  it("鍵の値を行に載せない（**秘密をDBに書かない**）", async () => {
    process.env.RESEND_API_KEY = "秘密の値";
    const { db, rows } = createDbStub();

    await recordMailConfigMissing(db, RECORD);

    expect(JSON.stringify(rows[0])).not.toContain("秘密の値");
  });
});

describe("Vercel 側に要る環境変数を1か所で宣言する", () => {
  it("宣言は RESEND_API_KEY / RESEND_FROM の2本", () => {
    expect([...NEXT_MAIL_ENV_KEYS]).toEqual(["RESEND_API_KEY", "RESEND_FROM"]);
  });

  it("**陰性**: 宣言のどれか1本でも欠ければ送らない側に倒れる", () => {
    for (const key of NEXT_MAIL_ENV_KEYS) {
      process.env = { ...ORIGINAL, RESEND_API_KEY: "re_x", RESEND_FROM: "a@example.com" };
      delete process.env[key];

      const out = resolveNextMailConfig();

      expect(out.ok, key).toBe(false);
      expect(out.ok === false && out.missing, key).toEqual([key]);
    }
  });

  it("**陰性**: 空白だけの値を「入っている」と読まない", () => {
    process.env = { ...ORIGINAL, RESEND_API_KEY: "   ", RESEND_FROM: "  " };

    const out = resolveNextMailConfig();

    expect(out.ok).toBe(false);
    expect(out.ok === false && out.missing).toEqual(["RESEND_API_KEY", "RESEND_FROM"]);
  });

  it("ビルド時の1行が next.config.ts に入っている（**唯一 Vercel の env が見える場所**）", () => {
    const config = readFileSync(path.resolve(__dirname, "../../next.config.ts"), "utf8");
    expect(config).toContain("NEXT_MAIL_ENV_KEYS");
    expect(config).toContain("メールの設定が足りない");
    // **ビルドは止めない。** メールと無関係な修正まで出せなくなる
    expect(config).not.toContain("process.exit");
  });
});

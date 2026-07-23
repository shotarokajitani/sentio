import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * delivery_log 和集合スキーマの統合テスト
 * 00015マイグレーション適用後に全パスすること
 */
const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const canRun = !!SUPABASE_SERVICE_KEY;

describe.skipIf(!canRun)("delivery_log 和集合スキーマ", () => {
  let admin: SupabaseClient;
  const companyId = "00000000-0000-0000-0000-000000000097";
  const insertedIds: string[] = [];

  beforeAll(() => {
    admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  });

  afterAll(async () => {
    if (canRun && insertedIds.length > 0) {
      await admin.from("delivery_log").delete().in("id", insertedIds);
    }
  });

  it("Edge Function 形式の INSERT が成功する（channel/delivery_type/content/status/created_at）", async () => {
    const id = crypto.randomUUID();
    insertedIds.push(id);

    const { error } = await admin.from("delivery_log").insert({
      id,
      company_id: companyId,
      channel: "email",
      delivery_type: "alert",
      content: { subject: "test", body: "test body" },
      status: "sent",
      created_at: new Date().toISOString(),
    });

    expect(error, `INSERT failed: ${error?.message}`).toBeNull();
  });

  it("既存形式の INSERT も成功する（finding_ids/sent_at/opened/acted）", async () => {
    const id = crypto.randomUUID();
    insertedIds.push(id);

    const { error } = await admin.from("delivery_log").insert({
      id,
      company_id: companyId,
      channel: "email",
      delivery_type: "weekly",
      content: { sections: [] },
      status: "sent",
      finding_ids: [],
      sent_at: new Date().toISOString(),
      opened: false,
      acted: false,
      created_at: new Date().toISOString(),
    });

    expect(error, `INSERT failed: ${error?.message}`).toBeNull();
  });

  it("onetap draft → confirm のライフサイクルが動作する", async () => {
    const draftId = crypto.randomUUID();
    insertedIds.push(draftId);

    // Draft 作成
    const { error: insertErr } = await admin.from("delivery_log").insert({
      id: draftId,
      company_id: companyId,
      channel: "calendar",
      delivery_type: "onetap_calendar",
      content: { finding_id: "f1", status: "draft" },
      status: "draft",
      created_at: new Date().toISOString(),
    });
    expect(insertErr, `Draft INSERT failed: ${insertErr?.message}`).toBeNull();

    // Confirm
    const { error: updateErr } = await admin
      .from("delivery_log")
      .update({
        status: "confirmed",
        content: { finding_id: "f1", status: "confirmed", registered_at: new Date().toISOString() },
      })
      .eq("id", draftId);
    expect(updateErr, `UPDATE failed: ${updateErr?.message}`).toBeNull();

    // 確認
    const { data, error: readErr } = await admin
      .from("delivery_log")
      .select("status, content")
      .eq("id", draftId)
      .single();
    expect(readErr).toBeNull();
    expect(data!.status).toBe("confirmed");
    expect(data!.content.status).toBe("confirmed");
  });
});

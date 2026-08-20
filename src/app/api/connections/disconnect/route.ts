import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAuthedContext, unauthorized } from "@/lib/auth/company";
import { MAX_DELETE_ROWS, evaluateDeletion, sourcesForProvider } from "@/lib/retention/policy";

/**
 * 連携を解除し、その連携から取得したデータを削除する。
 *
 * プライバシーポリシー §6 が約束した動きの実体:
 *   - アクセストークン・リフレッシュトークンを**直ちに破棄**する
 *   - 当該連携から取得したデータを削除する（約束は「30日以内」だが、ここで消し切る。
 *     遅らせる仕掛けを持たない方が、消し忘れの余地が無い）
 *
 * **削除は取り返しがつかない。** company_id はセッションからしか取らず（他社を消せない）、
 * 消す前に必ず数え、想定を超えたら**消さずに止める**（`evaluateDeletion`）。
 * 数え・削除ともRLSクライアントを通すので、越境はDB側でも二重に止まる。
 */
export async function POST(request: Request) {
  const ctx = await getAuthedContext();
  if (!ctx) return unauthorized();

  let provider: unknown;
  try {
    provider = (await request.json())?.provider;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (typeof provider !== "string" || provider === "") {
    return NextResponse.json({ error: "provider_required" }, { status: 400 });
  }

  // 知らない provider を「全部消す」に丸めない。空なら何も消さずに弾く
  const sources = sourcesForProvider(provider) as string[];
  if (sources.length === 0) {
    return NextResponse.json({ error: "unknown_provider", provider }, { status: 400 });
  }

  const { data: connection, error: connErr } = await ctx.supabase
    .from("connections")
    .select("vault_secret_id")
    .eq("company_id", ctx.companyId)
    .eq("provider", provider)
    .maybeSingle();

  if (connErr) {
    console.error("disconnect: connections select failed:", connErr.message);
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!connection) {
    return NextResponse.json({ error: "not_connected", provider }, { status: 404 });
  }

  // 数えてから消す。head:true なので行は運ばない
  const { count, error: countErr } = await ctx.supabase
    .from("events")
    .select("event_id", { count: "exact", head: true })
    .eq("company_id", ctx.companyId)
    .in("source", sources);

  if (countErr) {
    console.error("disconnect: events count failed:", countErr.message);
    return NextResponse.json({ error: "count_failed" }, { status: 500 });
  }

  // count は数えられなければ null。0 に丸めない（丸めると門が消える）
  const guard = evaluateDeletion({
    companyId: ctx.companyId,
    counted: count ?? null,
    max: MAX_DELETE_ROWS,
  });

  if (!guard.ok) {
    // 消さずに止める。トークンにも触らない。人間が件数を見て判断する
    console.error(
      `[sentio:retention] disconnect を中止した company_id=${ctx.companyId} ` +
        `provider=${provider} reason=${guard.reason} count=${guard.count} max=${MAX_DELETE_ROWS}`,
    );
    return NextResponse.json(
      { error: "deletion_blocked", reason: guard.reason, count: guard.count },
      { status: 409 },
    );
  }

  // トークンを先に破棄する。逆順にすると「データは消えたがトークンは生きている」
  // という最悪の中間状態が残る。RPC は service_role にしか GRANT していない
  //
  // `connections.vault_secret_id` は NULL 許容（00007）。status='pending' のまま
  // 認可が完了しなかった行には秘密が無い。NULL を渡すと 00025 が例外を上げるので、
  // **秘密が無い連携は解除そのものができなくなる。** 破棄すべき物が無い場合は飛ばす
  const vaultSecretId = connection.vault_secret_id as string | null;
  let tokenDestroyed = false;

  if (vaultSecretId) {
    const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const { data: destroyed, error: vaultErr } = await admin.rpc("delete_vault_secret", {
      p_id: vaultSecretId,
    });

    if (vaultErr) {
      console.error("disconnect: delete_vault_secret failed:", vaultErr.message);
      return NextResponse.json({ error: "token_destroy_failed" }, { status: 500 });
    }

    // false は「Vaultに元から無かった」。解除自体は成立しているのでエラーにしない
    tokenDestroyed = destroyed === true;
  }

  if (guard.count > 0) {
    const { error: delErr } = await ctx.supabase
      .from("events")
      .delete()
      .eq("company_id", ctx.companyId)
      .in("source", sources);

    if (delErr) {
      console.error("disconnect: events delete failed:", delErr.message);
      // トークンは破棄済み。データが残っている事実を隠さない
      return NextResponse.json(
        { error: "events_delete_failed", tokenDestroyed: true },
        { status: 500 },
      );
    }
  }

  const { error: rowErr } = await ctx.supabase
    .from("connections")
    .delete()
    .eq("company_id", ctx.companyId)
    .eq("provider", provider);

  if (rowErr) {
    console.error("disconnect: connections delete failed:", rowErr.message);
    return NextResponse.json(
      { error: "connection_delete_failed", tokenDestroyed: true, eventsDeleted: guard.count },
      { status: 500 },
    );
  }

  console.log(
    `[sentio:retention] disconnect 完了 company_id=${ctx.companyId} provider=${provider} ` +
      `events=${guard.count} token_destroyed=${tokenDestroyed}`,
  );

  return NextResponse.json({
    ok: true,
    provider,
    eventsDeleted: guard.count,
    tokenDestroyed,
  });
}

// pg_cron / Edge Function 実行の死活監視用ヘルパー。
// cron_job_logs テーブルに running / success / error を記録する。
// ログ失敗がジョブ本体を止めないよう、全てのエラーは try/catch で握りつぶす。

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

export interface CronJobLog {
  id: string | null;
  jobName: string;
  startedAt: number;
}

export async function startCronLog(
  supabase: SupabaseClient,
  jobName: string,
): Promise<CronJobLog> {
  const startedAt = Date.now();
  try {
    const { data, error } = await supabase
      .from("cron_job_logs")
      .insert({ job_name: jobName, status: "running" })
      .select("id")
      .single();
    if (error) {
      console.error("[cron-logger] start insert failed:", error);
      return { id: null, jobName, startedAt };
    }
    return { id: data.id, jobName, startedAt };
  } catch (e) {
    console.error("[cron-logger] start threw:", e);
    return { id: null, jobName, startedAt };
  }
}

export async function finishCronLog(
  supabase: SupabaseClient,
  log: CronJobLog,
  opts: {
    status: "success" | "error";
    errorMessage?: string;
    recordsProcessed?: number;
  },
): Promise<void> {
  if (!log.id) return;
  try {
    await supabase
      .from("cron_job_logs")
      .update({
        finished_at: new Date().toISOString(),
        status: opts.status,
        error_message: opts.errorMessage ?? null,
        records_processed: opts.recordsProcessed ?? 0,
      })
      .eq("id", log.id);
  } catch (e) {
    console.error("[cron-logger] finish threw:", e);
  }
}

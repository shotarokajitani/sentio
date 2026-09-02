/**
 * OAuth のスコープを承認済みの値に固定する（2026-09-02）。
 *
 * **変えると Google の再審査（4〜6週間）に戻る。**
 * 2026-09-02、4回目の提出でようやく承認された。承認メールにこうある。
 *
 * > You will need to submit a new verification request for access to new scopes,
 * > or if you make any changes to your OAuth consent screen configuration.
 *
 * **この検査が赤くなったら、値を直すのではなく再審査の要否を確かめること。**
 * 狭める分には審査は要らないが、広げると要る。
 * 引き金の一覧と守れない範囲は `.claude/rules/oauth-consent-screen.md`。
 *
 * **守れない範囲（ここで明示する）。** これは「コードが要求するスコープ」しか見ない。
 * **Google Cloud Console 側の設定は検出できない**（リポジトリに痕跡が残らない）。
 * 3回目の差し戻し（コードと Console の不一致）は、この検査では捕まらない。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** 2026-09-02 に承認された唯一のスコープ */
const APPROVED_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";

const ROUTE = "src/app/api/auth/google/route.ts";

function routeSource(): string {
  return readFileSync(ROUTE, "utf8");
}

describe("Google OAuth のスコープ", () => {
  it("**承認済みの値と完全に一致する**（変えると再審査）", () => {
    const match = routeSource().match(/scope:\s*"([^"]+)"/);
    expect(match, `${ROUTE} に scope の指定が見つからない`).not.toBeNull();
    expect(match![1]).toBe(APPROVED_SCOPE);
  });

  it("スコープは**1本だけ**である", () => {
    const match = routeSource().match(/scope:\s*"([^"]+)"/);
    // 空白区切りで複数指定すると、同意画面に "Show all services" が出るようになる。
    // 4回目の差し戻しは「そのボタンを押して展開せよ」で、**押せないことを説明して通した**。
    // 増やすとこの説明が成立しなくなる
    expect(match![1].trim().split(/\s+/)).toHaveLength(1);
  });

  it("より広いカレンダーのスコープを要求していない", () => {
    const source = routeSource();
    for (const wider of [
      "auth/calendar.readonly",
      "auth/calendar.settings",
      "auth/calendarlist",
      "auth/calendar.acls",
    ]) {
      expect(source.includes(wider), wider).toBe(false);
    }
  });

  it("Google API を叩いている箇所が、承認された範囲に収まっている", () => {
    // 実測（2026-08-20 の runbook）でコードが叩く Google API は
    // `calendars/primary/events` の1本だけだった。ここが増えたら審査の前提が変わる
    const callers = ["src/app/auth/callback/google/route.ts", "supabase/functions/sync-connections/index.ts"];
    for (const file of callers) {
      const source = readFileSync(file, "utf8");
      const endpoints = [...source.matchAll(/calendar\/v3\/([A-Za-z/]+)/g)].map((m) => m[1]);
      for (const endpoint of endpoints) {
        expect(endpoint.startsWith("calendars/"), `${file}: ${endpoint}`).toBe(true);
      }
    }
  });
});

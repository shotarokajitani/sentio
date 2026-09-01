"use client";

import { useState, useCallback } from "react";
import { Masthead } from "@/components/Masthead";
import { t } from "@/i18n";
import type { ConnectionOverview, ConnectionRow } from "@/lib/connections/overview";
import { requestDisconnect, type DisconnectOutcome } from "@/lib/connections/disconnect";
// 列の対応推定は「1行目が列名の行か」を確かめてからでないと呼べない（契約 スライスCH）。
// 関門ごとモジュールに移してあるので、ここからは直接 fetch しない
import { requestColumnMapping, type ColumnMapping } from "@/lib/csv/analyze";

type CsvStep = "idle" | "analyzing" | "confirm" | "ingesting" | "done" | "error";

// 読み込みの結果は3状態ある。0件（空）と失敗を同じ見た目にしない（運用ルール§6）
type LoadState = "loading" | "loaded" | "failed";

// 解除の進み方。confirming で二段確認を出し、通ったときだけ submitting に入る。
// blocked（409）と failed を done と別に持つのは、**「消えた」と表示してよいのが
// done だけ**だからである（受入基準 D-1-5）
type DisconnectStep = "confirming" | "submitting" | "done" | "blocked" | "failed";

interface DisconnectSession {
  provider: string;
  step: DisconnectStep;
  typed: string;
  outcome: DisconnectOutcome | null;
}

export function ConnectClient({
  failureMessage,
  initialOverview,
  accountEmail,
}: {
  failureMessage: string | null;
  // null はサーバ側で読み取りに失敗したことを表す。0件（空）とは別物
  initialOverview: ConnectionOverview | null;
  // 解除の二段確認の照合対象（U-2・2026-08-27 確定）。取れなければ null で、
  // その場合は照合が必ず落ちるので解除できない（fail-closed）
  accountEmail: string | null;
}) {
  const [connections, setConnections] = useState<ConnectionRow[]>(
    initialOverview?.connections ?? [],
  );
  const [counts, setCounts] = useState<Record<string, number>>(initialOverview?.counts ?? {});
  const [load, setLoad] = useState<LoadState>(initialOverview ? "loaded" : "failed");

  const [csvStep, setCsvStep] = useState<CsvStep>("idle");
  const [csvText, setCsvText] = useState("");
  const [csvFileName, setCsvFileName] = useState("");
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [csvResult, setCsvResult] = useState<{
    count: number;
    skipped?: number;
    total_lines?: number;
  } | null>(null);
  const [csvError, setCsvError] = useState("");
  // 断った理由の本文。原因ごとに「何を直せばいいか」が違うので、題と別に持つ（CH-D7）
  const [csvErrorBody, setCsvErrorBody] = useState("");

  // 初期表示はサーバ側で確定済み。ここを通るのは再読み込みとCSV取込後だけ
  const fetchConnections = useCallback(async () => {
    setLoad("loading");
    try {
      const res = await fetch("/api/connections");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      setConnections(data.connections || []);
      setCounts(data.counts || {});
      setLoad("loaded");
    } catch (e) {
      // 詳細はコンソールにだけ残す。画面には内部コードを出さない
      console.error("connections 取得に失敗:", e);
      setLoad("failed");
    }
  }, []);

  // 解除は一度に1つの連携だけ。開いている行を1つの状態で持つ
  const [disconnect, setDisconnect] = useState<DisconnectSession | null>(null);

  const submitDisconnect = useCallback(
    async (provider: string, typed: string) => {
      setDisconnect({ provider, step: "submitting", typed, outcome: null });

      // 照合はこの関数の中で行われる。**通らなければ API は呼ばれない**（受入基準 D-1-2）
      const outcome = await requestDisconnect({ provider, typed, accountEmail });

      if (outcome.ok) {
        setDisconnect({ provider, step: "done", typed, outcome });
        // 行と件数を実際の状態から取り直す。画面の思い込みで消さない
        await fetchConnections();
        return;
      }

      // 一致しなかっただけ。入力欄を残したまま確認画面に戻す
      if (outcome.reason === "confirmation_mismatch") {
        setDisconnect({ provider, step: "confirming", typed, outcome });
        return;
      }

      setDisconnect({
        provider,
        step: outcome.reason === "deletion_blocked" ? "blocked" : "failed",
        typed,
        outcome,
      });
    },
    [accountEmail, fetchConnections],
  );

  const getConnection = (provider: string) => connections.find((c) => c.provider === provider);

  const handleFile = async (file: File) => {
    setCsvError("");
    setCsvErrorBody("");
    setCsvStep("analyzing");
    setCsvFileName(file.name);

    try {
      const buffer = await file.arrayBuffer();
      let text: string;
      try {
        text = new TextDecoder("shift_jis", { fatal: true }).decode(buffer);
      } catch {
        text = new TextDecoder("utf-8").decode(buffer);
      }
      setCsvText(text);

      const lines = text.trim().split("\n");
      if (lines.length < 2) {
        setCsvError(t.csv.tooShort);
        setCsvStep("error");
        return;
      }

      const headers = parseCSVLine(lines[0]);
      const outcome = await requestColumnMapping({
        headers,
        rowCount: lines.length - 1,
        typeStats: computeTypeStats(lines, headers),
      });

      if (!outcome.ok) {
        // 列名の行が無いのと、推定そのものに失敗したのは別の原因である。
        // 同じ1文に飲み込むと、利用者は何を直せばいいのか分からない（CH-D7）
        if (outcome.reason === "no_header_row") {
          setCsvError(t.csv.noHeaderRowTitle);
          setCsvErrorBody(t.csv.noHeaderRowBody);
        } else {
          console.error("csv/analyze 失敗:", outcome.status);
          setCsvError(t.csv.analyzeFailed);
        }
        setCsvStep("error");
        return;
      }

      setMapping(outcome.mapping);
      setCsvStep("confirm");
    } catch (e) {
      console.error("CSV解析に失敗:", e);
      setCsvError(t.csv.analyzeFailed);
      setCsvStep("error");
    }
  };

  const handleConfirmMapping = async () => {
    if (!mapping) return;
    setCsvStep("ingesting");

    try {
      // company_id は送らない。サーバがセッションから決める
      const res = await fetch("/api/csv/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv_text: csvText, file_name: csvFileName, mapping }),
      });

      if (!res.ok) {
        console.error("csv/ingest 失敗:", res.status);
        setCsvError(t.csv.ingestFailed);
        setCsvStep("error");
        return;
      }

      setCsvResult(await res.json());
      setCsvStep("done");
      void fetchConnections();
    } catch (e) {
      console.error("CSV取込に失敗:", e);
      setCsvError(t.csv.ingestFailed);
      setCsvStep("error");
    }
  };

  const calConn = getConnection("google_calendar");
  const freeeConn = getConnection("freee");
  const calCount = counts["google_calendar"] ?? 0;
  const csvCount = counts["csv:accounting"] ?? 0;
  const freeeCount = counts["freee"] ?? 0;
  const nothingConnected = load === "loaded" && connections.length === 0 && csvCount === 0;

  return (
    <main className="page">
      <Masthead signedIn />

      <h1>{t.connect.title}</h1>
      <p className="lead">{t.connect.lead}</p>

      {/* 週次レポートへの導線（契約 スライスW・実装順3）。**1本だけ置く。**
          取り込んだ予定が何に使われるかは、この画面では分からない。
          Google 審査のシーン4もこの導線から /report へ入る */}
      <div className="actions">
        <a className="btn btn-quiet" href="/report">
          {t.connect.weeklyReport}
        </a>
      </div>

      {failureMessage && (
        <div className="failure" role="alert" style={{ marginTop: 24 }}>
          <p className="failure-title">{failureMessage}</p>
        </div>
      )}

      {load === "failed" && (
        <div className="failure" role="alert" style={{ marginTop: 24 }}>
          <p className="failure-title">{t.connect.loadFailedTitle}</p>
          <p className="failure-body">{t.connect.loadFailedBody}</p>
          <div className="actions">
            <button className="btn btn-quiet" onClick={() => void fetchConnections()}>
              {t.common.retry}
            </button>
          </div>
        </div>
      )}

      <section className="section">
        {load === "loading" && <p className="row-desc">{t.common.loading}</p>}

        {nothingConnected && (
          <div className="empty">
            <p className="empty-title">{t.connect.emptyTitle}</p>
            <p className="empty-body">{t.connect.emptyBody}</p>
          </div>
        )}

        <div className="rows">
          <SourceRow
            name={t.connect.calendarName}
            desc={t.connect.calendarDesc}
            connection={calConn}
            connectHref="/api/auth/google"
            meta={
              calConn
                ? [
                    `${t.connect.eventsCount} ${calCount}`,
                    `${t.connect.lastSync} ${formatDate(calConn.last_refresh)}`,
                  ]
                : []
            }
            // 解除 UI は Google カレンダーだけに置く（契約の非スコープ: 他 provider の解除 UI）
            disconnect={{
              session: disconnect?.provider === "google_calendar" ? disconnect : null,
              accountEmail,
              onOpen: () =>
                setDisconnect({
                  provider: "google_calendar",
                  step: "confirming",
                  typed: "",
                  outcome: null,
                }),
              onTyped: (typed) => setDisconnect((s) => (s ? { ...s, typed, outcome: null } : s)),
              onSubmit: (typed) => void submitDisconnect("google_calendar", typed),
              onClose: () => setDisconnect(null),
            }}
          />

          <SourceRow
            name={t.connect.freeeName}
            desc={t.connect.freeeDesc}
            connection={freeeConn}
            connectHref="/api/auth/freee"
            meta={
              freeeConn
                ? [
                    `${t.connect.transactionsCount} ${freeeCount}`,
                    `${t.connect.lastSync} ${formatDate(freeeConn.last_refresh)}`,
                  ]
                : []
            }
          />

          <div className="row">
            <div className="row-body" style={{ flex: 1 }}>
              <p className="row-name">{t.csv.name}</p>
              <p className="row-desc">{t.csv.desc}</p>
              {csvCount > 0 && <div className="row-meta">{t.csv.rows(csvCount)}</div>}

              {csvStep === "idle" && (
                <div className="actions">
                  <label className="btn btn-quiet" style={{ cursor: "pointer" }}>
                    {t.csv.dropZone}
                    <input
                      type="file"
                      accept=".csv"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleFile(file);
                      }}
                    />
                  </label>
                </div>
              )}

              {csvStep === "analyzing" && <p className="row-desc">{t.csv.analyzing}</p>}

              {csvStep === "confirm" && mapping && (
                <div style={{ marginTop: 16 }}>
                  <p className="section-label">{t.csv.confirmTitle}</p>
                  <table
                    style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}
                  >
                    <thead>
                      <tr>
                        <th style={cellHead}>{t.csv.colSentio}</th>
                        <th style={cellHead}>{t.csv.colCsv}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {MAPPING_FIELDS.filter(([key]) => mapping[key]).map(([key, label]) => (
                        <tr key={key}>
                          <td style={cell}>{label}</td>
                          <td style={cell}>{mapping[key]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="actions">
                    <button className="btn" onClick={() => void handleConfirmMapping()}>
                      {t.csv.ingest}
                    </button>
                    <button
                      className="btn btn-quiet"
                      onClick={() => {
                        setCsvStep("idle");
                        setMapping(null);
                      }}
                    >
                      {t.csv.restart}
                    </button>
                  </div>
                </div>
              )}

              {csvStep === "ingesting" && <p className="row-desc">{t.csv.ingesting}</p>}

              {csvStep === "done" && csvResult && (
                <div style={{ marginTop: 16 }}>
                  {csvResult.count > 0 ? (
                    <>
                      <p className="row-desc">{t.csv.done(csvResult.count)}</p>
                      {csvResult.skipped ? (
                        <p className="row-desc">
                          {t.csv.skipped(csvResult.skipped, csvResult.total_lines ?? 0)}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <div className="failure">
                      <p className="failure-title">{t.csv.zeroTitle}</p>
                      <p className="failure-body">{t.csv.zeroBody}</p>
                      <div className="actions">
                        <button
                          className="btn btn-quiet"
                          onClick={() => setCsvStep(mapping ? "confirm" : "idle")}
                        >
                          {t.csv.recheck}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {csvStep === "error" && (
                <div className="failure" style={{ marginTop: 16 }}>
                  <p className="failure-title">{csvError}</p>
                  {csvErrorBody && <p className="failure-body">{csvErrorBody}</p>}
                  <div className="actions">
                    <button
                      className="btn btn-quiet"
                      onClick={() => {
                        setCsvStep("idle");
                        setCsvError("");
                        setCsvErrorBody("");
                      }}
                    >
                      {t.csv.restart}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="row-side">
              {csvCount > 0 && <span className="state">{t.csv.ingested}</span>}
            </div>
          </div>
        </div>
      </section>

      <p className="footnote">
        <a href="/terms">{t.login.terms}</a> ・ <a href="/privacy">{t.login.privacy}</a>
      </p>
    </main>
  );
}

interface DisconnectProps {
  /** この行の解除セッション。他の行のものは渡さない */
  session: DisconnectSession | null;
  accountEmail: string | null;
  onOpen: () => void;
  onTyped: (typed: string) => void;
  onSubmit: (typed: string) => void;
  onClose: () => void;
}

function SourceRow({
  name,
  desc,
  connection,
  connectHref,
  meta,
  disconnect,
}: {
  name: string;
  desc: string;
  connection: ConnectionRow | undefined;
  connectHref: string;
  meta: string[];
  /** 渡さない行には解除 UI が出ない（契約の非スコープ: 他 provider の解除 UI） */
  disconnect?: DisconnectProps;
}) {
  // U-3（2026-08-27 確定）: revoked を検知してもお客様には通知しない。
  // 画面に既存の「要再連携」が出るだけで、Sentio 側からは何も送らない。
  // revoked と reauth_required の区別は DB（status / revoked_at）に残る
  const needsReauth = connection?.status === "reauth_required" || connection?.status === "revoked";

  // 解除ボタンは接続行がある限り出す。status は問わない（受入基準 D-1-1）。
  // active でも reauth_required でも revoked でも、解除したい気持ちは同じである
  const canDisconnect = Boolean(disconnect && connection);
  const session = disconnect?.session ?? null;

  return (
    <div className={needsReauth ? "row row-attention" : "row"}>
      <div className="row-body">
        <p className="row-name">{name}</p>
        <p className="row-desc">{needsReauth ? t.connect.needsReauthDesc : desc}</p>
        {meta.length > 0 && (
          <div className="row-meta">
            {meta.map((m) => (
              <span key={m}>{m}</span>
            ))}
          </div>
        )}

        {canDisconnect && session && disconnect && (
          <DisconnectPanel name={name} session={session} disconnect={disconnect} />
        )}
      </div>

      <div className="row-side">
        {canDisconnect && disconnect && !session && (
          <button className="btn btn-quiet" onClick={disconnect.onOpen}>
            {t.connect.disconnect}
          </button>
        )}
        {needsReauth ? (
          <>
            <span className="state state-attention">{t.connect.needsReauth}</span>
            <a className="btn" href={connectHref}>
              {t.connect.reconnect}
            </a>
          </>
        ) : connection ? (
          <span className="state">{t.connect.connected}</span>
        ) : (
          <a className="btn btn-quiet" href={connectHref}>
            {t.connect.connect}
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * 解除の二段確認。**入力がアカウントのメールアドレスと一致するまで API は呼ばれない**
 * （照合の実体は `@/lib/connections/disconnect` にあり、`fetch` の手前に置いてある）。
 *
 * 409（`deletion_blocked`）を `done` と別の状態で描くのは受入基準 D-1-5 のためである。
 * 消していないのに「消えました」と出す画面は、消したのに残っている画面と同じくらい悪い。
 */
function DisconnectPanel({
  name,
  session,
  disconnect,
}: {
  name: string;
  session: DisconnectSession;
  disconnect: DisconnectProps;
}) {
  const mismatch =
    session.outcome !== null &&
    session.outcome.ok === false &&
    session.outcome.reason === "confirmation_mismatch";

  if (session.step === "done") {
    const deleted = session.outcome?.ok ? session.outcome.eventsDeleted : 0;
    return (
      <div style={{ marginTop: 16 }}>
        <p className="row-desc">{t.connect.disconnectDone(deleted)}</p>
        <div className="actions">
          <button className="btn btn-quiet" onClick={disconnect.onClose}>
            {t.connect.disconnectClose}
          </button>
        </div>
      </div>
    );
  }

  if (session.step === "blocked") {
    const count =
      session.outcome && !session.outcome.ok && session.outcome.reason === "deletion_blocked"
        ? session.outcome.count
        : null;

    return (
      <div className="failure" style={{ marginTop: 16 }}>
        <p className="failure-title">{t.connect.disconnectBlocked}</p>
        {count !== null && (
          <p className="failure-body">{t.connect.disconnectBlockedCount(count)}</p>
        )}
        <p className="failure-body">{t.connect.disconnectBlockedHelp}</p>
        <div className="actions">
          <button className="btn btn-quiet" onClick={disconnect.onClose}>
            {t.connect.disconnectCancel}
          </button>
        </div>
      </div>
    );
  }

  if (session.step === "failed") {
    return (
      <div className="failure" style={{ marginTop: 16 }}>
        <p className="failure-title">{t.connect.disconnectFailed}</p>
        <div className="actions">
          <button className="btn btn-quiet" onClick={disconnect.onClose}>
            {t.connect.disconnectCancel}
          </button>
        </div>
      </div>
    );
  }

  const submitting = session.step === "submitting";

  return (
    <div className="failure" style={{ marginTop: 16 }}>
      <p className="failure-title">{t.connect.disconnectTitle(name)}</p>
      <p className="failure-body">{t.connect.disconnectLead}</p>

      {disconnect.accountEmail ? (
        <>
          <label>
            <span className="section-label">{t.connect.disconnectPrompt}</span>
            <input
              type="email"
              autoComplete="off"
              value={session.typed}
              disabled={submitting}
              onChange={(e) => disconnect.onTyped(e.target.value)}
              style={{ width: "100%", marginTop: 8 }}
            />
          </label>
          {mismatch && <p className="failure-body">{t.connect.disconnectMismatch}</p>}
        </>
      ) : (
        // 照合の正本が無い。素通しにせず、解除できないことを言う（fail-closed）
        <p className="failure-body">{t.connect.disconnectNoEmail}</p>
      )}

      <div className="actions">
        <button
          className="btn"
          disabled={submitting || !disconnect.accountEmail}
          onClick={() => disconnect.onSubmit(session.typed)}
        >
          {submitting ? t.connect.disconnectWorking : t.connect.disconnectSubmit}
        </button>
        <button className="btn btn-quiet" disabled={submitting} onClick={disconnect.onClose}>
          {t.connect.disconnectCancel}
        </button>
      </div>
    </div>
  );
}

/**
 * 日時は必ず JST で描く。**`timeZone` を省かない。**
 *
 * 省くと実行環境の既定タイムゾーンで描かれる。この画面は client component なので、
 * サーバ（Vercel = UTC）とブラウザ（JST）の両方で描かれ、差はちょうど9時間になる。
 * 同じ props から違う文字列が出るので React は hydration を諦め、本番で
 * React error #418 が出ていた（2026-08-27 / 08-28 実測）。
 * `src/app/report/report-view.tsx` が同じ形を作らなかった書き方に揃える。
 *
 * モジュールスコープに置くのは、描画のたびに作り直さないためでもある。
 */
const LAST_SYNC_FORMAT = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// null は「まだ一度も同期していない」。例外にせず既存どおり never を出す
function formatDate(iso: string | null): string {
  if (!iso) return t.connect.never;
  return LAST_SYNC_FORMAT.format(new Date(iso));
}

const MAPPING_FIELDS: [keyof ColumnMapping, string][] = [
  ["date", t.csv.fields.date],
  ["description", t.csv.fields.description],
  ["amount", t.csv.fields.amount],
  ["direction", t.csv.fields.direction],
  ["credit", t.csv.fields.credit],
  ["debit", t.csv.fields.debit],
  ["balance", t.csv.fields.balance],
];

const cellHead: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 0",
  borderBottom: "1px solid var(--rule-strong)",
  color: "var(--ink-faint)",
  fontWeight: 400,
};

const cell: React.CSSProperties = {
  padding: "6px 0",
  borderBottom: "1px solid var(--rule)",
};

/**
 * CSVの1行をクォート考慮で分解する。
 *
 * **export しているのは試験のためである。** 列名の行かどうかの判定は
 * この関数が返したセルの配列に対して行われる（契約 スライスCH）。
 * 手で組んだ配列だけで判定を試験すると、この関数の挙動が変わった日に
 * **テストは緑のまま本番だけ抜ける。** 生のCSVテキストから判定までを
 * 一本で通す試験が `tests/unit/csv-analyze-guard.test.ts` にある。
 */
export function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// 列ごとの型統計。文字列列はPIIを含みうるのでサンプルを送らない
function computeTypeStats(
  lines: string[],
  headers: string[],
): Record<
  string,
  { type: string; digits: number | null; sample_count: number; samples?: string[] }
> {
  const stats: Record<
    string,
    { type: string; digits: number | null; sample_count: number; samples?: string[] }
  > = {};
  const dataLines = lines.slice(1).filter((l) => l.trim());
  const sampleSize = Math.min(dataLines.length, 20);

  for (let colIdx = 0; colIdx < headers.length; colIdx++) {
    const values = dataLines.slice(0, sampleSize).map((line) => parseCSVLine(line)[colIdx] ?? "");
    const nonEmpty = values.filter((v) => v !== "");

    const datePattern = /^\d{4}[/-]\d{1,2}[/-]\d{1,2}/;
    const numberPattern = /^-?[\d,]+\.?\d*$/;

    const dateCount = nonEmpty.filter((v) => datePattern.test(v)).length;
    const numCount = nonEmpty.filter((v) => numberPattern.test(v.replace(/,/g, ""))).length;

    let detectedType: string;
    let digits: number | null = null;
    let samples: string[] | undefined;

    if (dateCount > nonEmpty.length * 0.7) {
      detectedType = "date";
      samples = nonEmpty.slice(0, 3);
    } else if (numCount > nonEmpty.length * 0.7) {
      detectedType = "number";
      const lengths = nonEmpty.map((v) => v.replace(/[^0-9]/g, "").length);
      digits = Math.max(...lengths);
      samples = nonEmpty.slice(0, 3);
    } else {
      detectedType = "string";
    }

    stats[headers[colIdx]] = { type: detectedType, digits, sample_count: nonEmpty.length, samples };
  }

  return stats;
}

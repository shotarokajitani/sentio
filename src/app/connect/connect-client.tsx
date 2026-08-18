"use client";

import { useState, useCallback } from "react";
import { Masthead } from "@/components/Masthead";
import { t } from "@/i18n";
import type { ConnectionOverview, ConnectionRow } from "@/lib/connections/overview";

interface ColumnMapping {
  date: string;
  description: string | null;
  amount: string | null;
  direction: string | null;
  credit: string | null;
  debit: string | null;
  balance: string | null;
}

type CsvStep = "idle" | "analyzing" | "confirm" | "ingesting" | "done" | "error";

// 読み込みの結果は3状態ある。0件（空）と失敗を同じ見た目にしない（運用ルール§6）
type LoadState = "loading" | "loaded" | "failed";

export function ConnectClient({
  failureMessage,
  initialOverview,
}: {
  failureMessage: string | null;
  // null はサーバ側で読み取りに失敗したことを表す。0件（空）とは別物
  initialOverview: ConnectionOverview | null;
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

  const getConnection = (provider: string) => connections.find((c) => c.provider === provider);

  const formatDate = (iso: string | null) => {
    if (!iso) return t.connect.never;
    return new Date(iso).toLocaleString("ja-JP", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const handleFile = async (file: File) => {
    setCsvError("");
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
      const res = await fetch("/api/csv/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          headers,
          row_count: lines.length - 1,
          type_stats: computeTypeStats(lines, headers),
        }),
      });

      if (!res.ok) {
        console.error("csv/analyze 失敗:", res.status);
        setCsvError(t.csv.analyzeFailed);
        setCsvStep("error");
        return;
      }

      const data = await res.json();
      setMapping(data.mapping);
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
                  <div className="actions">
                    <button
                      className="btn btn-quiet"
                      onClick={() => {
                        setCsvStep("idle");
                        setCsvError("");
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

function SourceRow({
  name,
  desc,
  connection,
  connectHref,
  meta,
}: {
  name: string;
  desc: string;
  connection: ConnectionRow | undefined;
  connectHref: string;
  meta: string[];
}) {
  const needsReauth = connection?.status === "reauth_required";

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
      </div>

      <div className="row-side">
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

// CSVの1行をクォート考慮で分解する
function parseCSVLine(line: string): string[] {
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

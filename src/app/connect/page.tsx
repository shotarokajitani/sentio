"use client";

import { useEffect, useState, useCallback } from "react";

const COMPANY_ID = "00000000-0000-0000-0000-000000000001";

interface Connection {
  provider: string;
  status: string;
  last_refresh: string | null;
  expires_at: string | null;
}

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

export default function ConnectPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  // CSV state
  const [csvStep, setCsvStep] = useState<CsvStep>("idle");
  const [csvText, setCsvText] = useState("");
  const [csvFileName, setCsvFileName] = useState("");
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvResult, setCsvResult] = useState<{
    count: number;
    skipped?: number;
    total_lines?: number;
    skip_summary?: string | null;
  } | null>(null);
  const [csvError, setCsvError] = useState("");

  const [error, setError] = useState("");

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetch(`/api/connections?company_id=${COMPANY_ID}`);
      const data = await res.json();
      setConnections(data.connections || []);
      setCounts(data.counts || {});
    } catch {
      setError("接続情報の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/connections?company_id=${COMPANY_ID}`);
      const data = await res.json();
      if (!cancelled) {
        setConnections(data.connections || []);
        setCounts(data.counts || {});
        setLoading(false);
      }
    })().catch(() => {
      if (!cancelled) {
        setError("接続情報の取得に失敗しました");
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const getConnection = (provider: string) =>
    connections.find((c) => c.provider === provider);

  const formatDate = (iso: string | null) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("ja-JP", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const freeeConfigured =
    typeof window !== "undefined" ? true : true; // freee button always shown; server returns error if unconfigured

  // CSV file handler
  const handleFileDrop = async (file: File) => {
    setCsvError("");
    setCsvStep("analyzing");
    setCsvFileName(file.name);

    try {
      const buffer = await file.arrayBuffer();
      // Try Shift_JIS first, then UTF-8
      let text: string;
      try {
        const decoder = new TextDecoder("shift_jis", { fatal: true });
        text = decoder.decode(buffer);
      } catch {
        text = new TextDecoder("utf-8").decode(buffer);
      }
      setCsvText(text);

      // Extract headers
      const lines = text.trim().split("\n");
      if (lines.length < 2) {
        setCsvError("CSVに2行以上必要です");
        setCsvStep("error");
        return;
      }

      const headers = parseCSVLine(lines[0]);
      setCsvHeaders(headers);

      // Send headers + type stats to analyze endpoint (no cell values for string columns)
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
        const err = await res.json();
        setCsvError(err.error || "列マッピング推定に失敗しました");
        setCsvStep("error");
        return;
      }

      const data = await res.json();
      setMapping(data.mapping);
      setCsvStep("confirm");
    } catch (e) {
      setCsvError((e as Error).message);
      setCsvStep("error");
    }
  };

  const handleConfirmMapping = async () => {
    if (!mapping) return;
    setCsvStep("ingesting");

    try {
      const res = await fetch("/api/csv/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csv_text: csvText,
          company_id: COMPANY_ID,
          file_name: csvFileName,
          mapping,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        setCsvError(err.error || "取込に失敗しました");
        setCsvStep("error");
        return;
      }

      const data = await res.json();
      setCsvResult(data);
      setCsvStep("done");
      fetchConnections(); // refresh counts
    } catch (e) {
      setCsvError((e as Error).message);
      setCsvStep("error");
    }
  };

  const calConn = getConnection("google_calendar");
  const freeeConn = getConnection("freee");
  const calCount = counts["google_calendar"] ?? 0;
  const csvCount = counts["csv:accounting"] ?? 0;
  const freeeCount = counts["freee"] ?? 0;

  if (loading) {
    return (
      <div style={{ maxWidth: 640, margin: "80px auto", fontFamily: "sans-serif" }}>
        <p>読み込み中...</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 640, margin: "60px auto", fontFamily: "sans-serif" }}>
      <h1 style={{ marginBottom: 8 }}>Sentio — 接続ハブ</h1>
      <p style={{ color: "#666", marginBottom: 32 }}>
        データソースを接続して、会社の状態を可視化します
      </p>

      {error && (
        <p style={{ color: "red", border: "1px solid red", padding: 8, marginBottom: 16 }}>
          {error}
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Google Calendar */}
        <div style={cardStyle(!!calConn)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h3 style={{ margin: 0 }}>Google カレンダー</h3>
              <p style={{ margin: "4px 0 0", fontSize: 14, color: "#666" }}>
                予定・会議の変化を検知
              </p>
            </div>
            {calConn ? (
              <span style={badgeStyle("active")}>接続済み</span>
            ) : (
              <a
                href={`/api/auth/google?company_id=${COMPANY_ID}`}
                style={buttonStyle("#4285F4")}
              >
                接続
              </a>
            )}
          </div>
          {calConn && (
            <div style={metaStyle}>
              <span>イベント: {calCount}件</span>
              <span>最終同期: {formatDate(calConn.last_refresh)}</span>
            </div>
          )}
        </div>

        {/* freee */}
        <div style={cardStyle(!!freeeConn)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h3 style={{ margin: 0 }}>freee 会計</h3>
              <p style={{ margin: "4px 0 0", fontSize: 14, color: "#666" }}>
                仕訳・取引データを自動同期
              </p>
            </div>
            {freeeConn ? (
              <span style={badgeStyle("active")}>接続済み</span>
            ) : freeeConfigured ? (
              <a
                href={`/api/auth/freee?company_id=${COMPANY_ID}`}
                style={buttonStyle("#2CA01C")}
              >
                接続
              </a>
            ) : (
              <span style={{ fontSize: 13, color: "#999" }}>準備中</span>
            )}
          </div>
          {freeeConn && (
            <div style={metaStyle}>
              <span>取引: {freeeCount}件</span>
              <span>最終同期: {formatDate(freeeConn.last_refresh)}</span>
            </div>
          )}
        </div>

        {/* CSV */}
        <div style={cardStyle(csvCount > 0)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h3 style={{ margin: 0 }}>入出金CSV</h3>
              <p style={{ margin: "4px 0 0", fontSize: 14, color: "#666" }}>
                銀行明細・Stripe入金レポート等を取込
              </p>
            </div>
            {csvCount > 0 && <span style={badgeStyle("active")}>取込済み</span>}
          </div>

          {csvCount > 0 && (
            <div style={metaStyle}>
              <span>明細: {csvCount}件</span>
            </div>
          )}

          {/* CSV Drop Zone */}
          {csvStep === "idle" && (
            <div
              style={dropZoneStyle}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const file = e.dataTransfer.files[0];
                if (file) handleFileDrop(file);
              }}
              onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".csv";
                input.onchange = () => {
                  const file = input.files?.[0];
                  if (file) handleFileDrop(file);
                };
                input.click();
              }}
            >
              CSVファイルをドロップ、またはクリックして選択
            </div>
          )}

          {csvStep === "analyzing" && (
            <p style={{ marginTop: 12, color: "#666" }}>列マッピングを推定中...</p>
          )}

          {csvStep === "confirm" && mapping && (
            <div style={{ marginTop: 12 }}>
              <p style={{ fontWeight: "bold", marginBottom: 8 }}>列マッピング確認</p>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #ddd" }}>
                    <th style={{ textAlign: "left", padding: 4 }}>Sentio項目</th>
                    <th style={{ textAlign: "left", padding: 4 }}>CSV列名</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ["date", "日付"],
                      ["description", "摘要"],
                      ["amount", "金額"],
                      ["direction", "入出金区分"],
                      ["credit", "入金(+)"],
                      ["debit", "出金(-)"],
                      ["balance", "残高"],
                    ] as [keyof ColumnMapping, string][]
                  )
                    .filter(([key]) => mapping[key])
                    .map(([key, label]) => (
                      <tr key={key} style={{ borderBottom: "1px solid #eee" }}>
                        <td style={{ padding: 4 }}>{label}</td>
                        <td style={{ padding: 4 }}>
                          {mapping[key] ?? "—"}
                          {key === "credit" && " → 入金(+)"}
                          {key === "debit" && " → 出金(-)"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                <button onClick={handleConfirmMapping} style={buttonStyle("#333")}>
                  この割当で取込
                </button>
                <button
                  onClick={() => { setCsvStep("idle"); setMapping(null); }}
                  style={{ ...buttonStyle("#999"), background: "#eee", color: "#333" }}
                >
                  やり直す
                </button>
              </div>
            </div>
          )}

          {csvStep === "ingesting" && (
            <p style={{ marginTop: 12, color: "#666" }}>取込中...</p>
          )}

          {csvStep === "done" && csvResult && (
            <div style={{ marginTop: 12 }}>
              {csvResult.count > 0 ? (
                <p style={{ color: "green", margin: 0 }}>
                  {csvResult.count}件取込
                  {csvResult.skipped ? `・${csvResult.skipped}行スキップ` : ""}
                  {csvResult.total_lines ? `（全${csvResult.total_lines}行中）` : ""}
                </p>
              ) : (
                <p style={{ color: "#c00", margin: 0, fontWeight: "bold" }}>
                  0件でした。列の対応をご確認ください
                </p>
              )}
              {csvResult.skip_summary && (
                <p style={{ fontSize: 13, color: "#888", margin: "4px 0 0" }}>
                  スキップ理由: {csvResult.skip_summary}
                </p>
              )}
              {csvResult.count === 0 && (
                <button
                  onClick={() => {
                    if (mapping) {
                      setCsvStep("confirm");
                    } else {
                      setCsvStep("idle");
                    }
                  }}
                  style={{ ...buttonStyle("#c00"), marginTop: 8 }}
                >
                  マッピングを再確認
                </button>
              )}
            </div>
          )}

          {csvStep === "error" && (
            <div style={{ marginTop: 12 }}>
              <p style={{ color: "red" }}>{csvError}</p>
              <button
                onClick={() => { setCsvStep("idle"); setCsvError(""); }}
                style={buttonStyle("#999")}
              >
                やり直す
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Parse a CSV line respecting quoted fields
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

// Compute type statistics for each column (no string cell values sent to API)
function computeTypeStats(
  lines: string[],
  headers: string[],
): Record<string, { type: string; digits: number | null; sample_count: number; samples?: string[] }> {
  const stats: Record<string, { type: string; digits: number | null; sample_count: number; samples?: string[] }> = {};
  const dataLines = lines.slice(1).filter((l) => l.trim());
  const sampleSize = Math.min(dataLines.length, 20);

  for (let colIdx = 0; colIdx < headers.length; colIdx++) {
    const values = dataLines.slice(0, sampleSize).map((line) => parseCSVLine(line)[colIdx] ?? "");
    const nonEmpty = values.filter((v) => v !== "");

    // Type detection
    const datePattern = /^\d{4}[/-]\d{1,2}[/-]\d{1,2}/;
    const numberPattern = /^-?[\d,]+\.?\d*$/;

    const dateCount = nonEmpty.filter((v) => datePattern.test(v)).length;
    const numCount = nonEmpty.filter((v) => numberPattern.test(v.replace(/,/g, ""))).length;

    let detectedType: string;
    let digits: number | null = null;
    let samples: string[] | undefined;

    if (dateCount > nonEmpty.length * 0.7) {
      detectedType = "date";
      // Date/number columns: safe to include samples
      samples = nonEmpty.slice(0, 3);
    } else if (numCount > nonEmpty.length * 0.7) {
      detectedType = "number";
      const lengths = nonEmpty.map((v) => v.replace(/[^0-9]/g, "").length);
      digits = Math.max(...lengths);
      samples = nonEmpty.slice(0, 3);
    } else {
      detectedType = "string";
      // String columns: NO samples (may contain PII)
    }

    stats[headers[colIdx]] = {
      type: detectedType,
      digits,
      sample_count: nonEmpty.length,
      samples,
    };
  }

  return stats;
}

// Styles
function cardStyle(connected: boolean): React.CSSProperties {
  return {
    border: `1px solid ${connected ? "#4CAF50" : "#ddd"}`,
    borderRadius: 8,
    padding: 20,
    background: connected ? "#f8fff8" : "#fafafa",
  };
}

function badgeStyle(_status: string): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "4px 12px",
    background: "#4CAF50",
    color: "white",
    borderRadius: 12,
    fontSize: 13,
    fontWeight: "bold",
  };
}

function buttonStyle(bg: string): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "8px 20px",
    background: bg,
    color: "white",
    textDecoration: "none",
    borderRadius: 4,
    fontSize: 14,
    border: "none",
    cursor: "pointer",
  };
}

const metaStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  marginTop: 12,
  fontSize: 13,
  color: "#888",
};

const dropZoneStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 32,
  border: "2px dashed #ccc",
  borderRadius: 8,
  textAlign: "center",
  color: "#999",
  cursor: "pointer",
  fontSize: 14,
};

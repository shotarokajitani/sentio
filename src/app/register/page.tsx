"use client";

import { useState } from "react";

export default function RegisterPage() {
  const [companyName, setCompanyName] = useState("");
  const [url, setUrl] = useState("");

  const companyId = "00000000-0000-0000-0000-000000000001";

  const error =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("error")
      : null;

  return (
    <div style={{ maxWidth: 480, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>Sentio — 登録</h1>

      {error && (
        <p style={{ color: "red", border: "1px solid red", padding: 8 }}>
          エラー: {error}
        </p>
      )}

      <label>
        会社名
        <input
          type="text"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          style={{ display: "block", width: "100%", padding: 8, marginBottom: 16 }}
        />
      </label>

      <label>
        URL
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com"
          style={{ display: "block", width: "100%", padding: 8, marginBottom: 24 }}
        />
      </label>

      <a
        href={`/api/auth/google?company_id=${companyId}`}
        style={{
          display: "inline-block",
          padding: "12px 24px",
          background: "#4285F4",
          color: "white",
          textDecoration: "none",
          borderRadius: 4,
          fontSize: 16,
        }}
      >
        Google カレンダーを接続
      </a>
    </div>
  );
}

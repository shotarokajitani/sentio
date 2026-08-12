"use client";

export default function CompletePage() {
  const params =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();

  const eventCount = params.get("events") || "0";

  return (
    <div style={{ maxWidth: 480, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>接続完了</h1>
      <p>Google カレンダーの接続が完了しました。</p>
      <p>{eventCount} 件のカレンダーイベントを取り込みました。</p>
    </div>
  );
}

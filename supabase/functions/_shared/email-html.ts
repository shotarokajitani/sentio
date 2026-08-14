// Shared email HTML renderer — table-based, inline styles, Gmail-safe
// Design tokens: bg #f7f5f2 (cream) / accent #0e5070 (mid-ocean blue)
// No dark backgrounds, no purple, no web fonts, no <style> tags, no div layout

const BG = "#f7f5f2";
const ACCENT = "#0e5070";
const TEXT = "#333333";
const MUTED = "#888888";
const BORDER = "#e0ddd8";
const BLOCK_BG = "#ffffff";
const FONT = "Helvetica, Arial, 'Hiragino Kaku Gothic ProN', 'Yu Gothic', Meiryo, sans-serif";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Convert plain text content to email-safe HTML, highlighting 3-part structure */
function formatBlockContent(content: string, hasData: boolean): string {
  if (!hasData) {
    return `<tr><td style="padding:12px 16px;color:${MUTED};font-family:${FONT};font-size:14px;line-height:1.6;">${escapeHtml(content)}</td></tr>`;
  }

  // Split by the 3-part markers and render each with distinct styling
  const parts = content.split(/(【見えたこと】|【根拠】|【考えられること】)/);
  let html = "";
  let currentLabel = "";

  for (const part of parts) {
    if (part === "【見えたこと】" || part === "【根拠】" || part === "【考えられること】") {
      currentLabel = part;
      continue;
    }
    const text = part.trim();
    if (!text) continue;

    if (currentLabel) {
      const labelColors: Record<string, { bg: string; border: string }> = {
        "【見えたこと】": { bg: "#eef4f7", border: ACCENT },
        "【根拠】": { bg: "#f5f3ee", border: "#b8a88a" },
        "【考えられること】": { bg: "#f0f5f0", border: "#6a9a6a" },
      };
      const style = labelColors[currentLabel] || { bg: "#f5f5f5", border: BORDER };
      html += `<tr><td style="padding:8px 16px 0 16px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-left:3px solid ${style.border};background-color:${style.bg};">
<tr><td style="padding:8px 12px 4px 12px;font-family:${FONT};font-size:12px;font-weight:bold;color:${style.border};">${escapeHtml(currentLabel)}</td></tr>
<tr><td style="padding:0 12px 10px 12px;font-family:${FONT};font-size:14px;line-height:1.7;color:${TEXT};">${escapeHtml(text).replace(/\n/g, "<br>")}</td></tr>
</table>
</td></tr>`;
      currentLabel = "";
    } else {
      // Text before any label (e.g. disclaimer line)
      html += `<tr><td style="padding:8px 16px;font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED};font-style:italic;">${escapeHtml(text).replace(/\n/g, "<br>")}</td></tr>`;
    }
  }

  return html;
}

/** Sentio email header with text logo */
function renderHeader(): string {
  return `<tr><td style="padding:24px 24px 16px 24px;background-color:${BG};">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td style="font-family:${FONT};font-size:24px;font-weight:bold;color:${TEXT};">S<span style="color:${ACCENT};">e</span>ntio</td>
</tr>
</table>
</td></tr>`;
}

/** Sentio email footer */
function renderFooter(meta?: string): string {
  return `<tr><td style="padding:16px 24px 24px 24px;background-color:${BG};">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td style="border-top:1px solid ${BORDER};padding-top:16px;font-family:${FONT};font-size:11px;color:${MUTED};line-height:1.5;">
${meta ? `${escapeHtml(meta)}<br>` : ""}Sentio — 報告ゼロで見える
</td></tr>
</table>
</td></tr>`;
}

// ──────────────────────────────────────────────────────
// Day0 email
// ──────────────────────────────────────────────────────

export interface Day0Block {
  key: string;
  title: string;
  content: string;
  hasData: boolean;
  sources: string[];
}

/** Map no-data block keys to user-friendly labels with data source hints */
const NO_DATA_LABELS: Record<string, string> = {
  reputation: "評判の座標（Google Places）",
  site_health: "サイト健全性",
  opportunities: "助成金・支援機会（jGrants）",
  industry_position: "業界・地域の中の位置（e-Stat・日銀）",
};

export function renderDay0Html(
  companyName: string,
  blocks: Day0Block[],
  meta: { generationTimeMs: number; totalTokens: number; passedCount: number; totalCount: number },
): string {
  // Separate data blocks from no-data blocks
  const dataBlocks = blocks.filter((b) => b.hasData);
  const noDataBlocks = blocks.filter((b) => !b.hasData);

  const blockRows = dataBlocks
    .map((b) => {
      return `<tr><td style="padding:12px 24px 0 24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BLOCK_BG};border:1px solid ${BORDER};border-radius:4px;">
<tr><td style="padding:10px 16px;background-color:${ACCENT};font-family:${FONT};font-size:15px;font-weight:bold;color:#ffffff;">${escapeHtml(b.title)}</td></tr>
${formatBlockContent(b.content, b.hasData)}
</table>
</td></tr>`;
    })
    .join("\n");

  // Consolidate no-data blocks into a single "coming soon" section
  let comingSoonRow = "";
  if (noDataBlocks.length > 0) {
    const items = noDataBlocks
      .map((b) => NO_DATA_LABELS[b.key] || b.title)
      .map(
        (label) =>
          `<tr><td style="padding:3px 0 3px 16px;font-family:${FONT};font-size:14px;color:${TEXT};">&#8226; ${escapeHtml(label)}</td></tr>`,
      )
      .join("\n");
    comingSoonRow = `<tr><td style="padding:12px 24px 0 24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BLOCK_BG};border:1px solid ${BORDER};border-radius:4px;">
<tr><td style="padding:10px 16px;background-color:#7a9a6a;font-family:${FONT};font-size:15px;font-weight:bold;color:#ffffff;">今後見えるようになるもの</td></tr>
<tr><td style="padding:8px 16px 4px 16px;font-family:${FONT};font-size:13px;color:${MUTED};line-height:1.5;">接続とデータ蓄積が進むと、以下が見えるようになります:</td></tr>
${items}
<tr><td style="padding:6px;"></td></tr>
</table>
</td></tr>`;
  }

  const metaText = `生成時間: ${meta.generationTimeMs}ms / トークン: ${meta.totalTokens} / 通過ブロック: ${meta.passedCount}/${meta.totalCount}`;

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Day0レポート</title></head>
<body style="margin:0;padding:0;background-color:${BG};">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BG};">
<tr><td align="center" style="padding:16px 8px;">
<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background-color:${BG};">
${renderHeader()}
<tr><td style="padding:0 24px 12px 24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td style="font-family:${FONT};font-size:20px;font-weight:bold;color:${ACCENT};padding-bottom:4px;">Day0レポート</td></tr>
<tr><td style="font-family:${FONT};font-size:16px;color:${TEXT};">${escapeHtml(companyName)}</td></tr>
</table>
</td></tr>
${blockRows}
${comingSoonRow}
${renderFooter(metaText)}
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function renderDay0Text(companyName: string, blocks: Day0Block[]): string {
  const dataBlocks = blocks.filter((b) => b.hasData);
  const noDataBlocks = blocks.filter((b) => !b.hasData);

  const lines = [`Day0レポート: ${companyName}`, "=".repeat(40), ""];
  for (const b of dataBlocks) {
    lines.push(`■ ${b.title}`, "");
    lines.push(b.content, "");
    lines.push("-".repeat(40), "");
  }
  if (noDataBlocks.length > 0) {
    lines.push("■ 今後見えるようになるもの", "");
    lines.push("接続とデータ蓄積が進むと、以下が見えるようになります:");
    for (const b of noDataBlocks) {
      lines.push(`  - ${NO_DATA_LABELS[b.key] || b.title}`);
    }
    lines.push("", "-".repeat(40), "");
  }
  lines.push("Sentio — 報告ゼロで見える");
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────
// Alert email
// ──────────────────────────────────────────────────────

export function renderAlertHtml(subject: string, body: string): string {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background-color:${BG};">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BG};">
<tr><td align="center" style="padding:16px 8px;">
<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background-color:${BG};">
${renderHeader()}
<tr><td style="padding:0 24px 12px 24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BLOCK_BG};border:1px solid ${BORDER};border-radius:4px;">
<tr><td style="padding:12px 16px;background-color:#c0392b;font-family:${FONT};font-size:15px;font-weight:bold;color:#ffffff;">Alert</td></tr>
<tr><td style="padding:16px;font-family:${FONT};font-size:14px;line-height:1.7;color:${TEXT};white-space:pre-wrap;">${escapeHtml(body)}</td></tr>
</table>
</td></tr>
${renderFooter()}
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function renderAlertText(subject: string, body: string): string {
  return `${subject}\n${"=".repeat(40)}\n\n${body}\n\nSentio — 報告ゼロで見える`;
}

// ──────────────────────────────────────────────────────
// Pulse email
// ──────────────────────────────────────────────────────

export function renderPulseHtml(lines: string[]): string {
  const rows = lines
    .map(
      (line) =>
        `<tr><td style="padding:6px 16px;font-family:${FONT};font-size:14px;line-height:1.6;color:${TEXT};">${escapeHtml(line)}</td></tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>デイリーパルス</title></head>
<body style="margin:0;padding:0;background-color:${BG};">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BG};">
<tr><td align="center" style="padding:16px 8px;">
<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background-color:${BG};">
${renderHeader()}
<tr><td style="padding:0 24px 12px 24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BLOCK_BG};border:1px solid ${BORDER};border-radius:4px;">
<tr><td style="padding:12px 16px;background-color:${ACCENT};font-family:${FONT};font-size:15px;font-weight:bold;color:#ffffff;">デイリーパルス</td></tr>
${rows}
<tr><td style="padding:4px;"></td></tr>
</table>
</td></tr>
${renderFooter()}
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function renderPulseText(lines: string[]): string {
  return `デイリーパルス\n${"=".repeat(40)}\n\n${lines.join("\n")}\n\nSentio — 報告ゼロで見える`;
}

// ──────────────────────────────────────────────────────
// Weekly email
// ──────────────────────────────────────────────────────

export interface WeeklySection {
  type: string;
  content: string;
}

export function renderWeeklyHtml(sections: WeeklySection[]): string {
  const sectionTitles: Record<string, string> = {
    digest: "状態ダイジェスト",
    finding: "今週のFinding",
    followup: "続報",
    stable_coverage: "安定指標とカバレッジ",
    nudge: "",
  };

  const sectionRows = sections
    .filter((s) => s.content)
    .map((s) => {
      if (s.type === "nudge") {
        return `<tr><td style="padding:8px 24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td style="font-family:${FONT};font-size:13px;color:${MUTED};line-height:1.5;">${escapeHtml(s.content)}</td></tr>
</table>
</td></tr>`;
      }
      const title = sectionTitles[s.type] || s.type;
      return `<tr><td style="padding:8px 24px 0 24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BLOCK_BG};border:1px solid ${BORDER};border-radius:4px;">
<tr><td style="padding:10px 16px;background-color:${ACCENT};font-family:${FONT};font-size:15px;font-weight:bold;color:#ffffff;">${escapeHtml(title)}</td></tr>
<tr><td style="padding:12px 16px;font-family:${FONT};font-size:14px;line-height:1.7;color:${TEXT};">${escapeHtml(s.content).replace(/\n/g, "<br>")}</td></tr>
</table>
</td></tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>今週の会社</title></head>
<body style="margin:0;padding:0;background-color:${BG};">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BG};">
<tr><td align="center" style="padding:16px 8px;">
<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background-color:${BG};">
${renderHeader()}
<tr><td style="padding:0 24px 8px 24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td style="font-family:${FONT};font-size:20px;font-weight:bold;color:${ACCENT};">今週の会社</td></tr>
</table>
</td></tr>
${sectionRows}
${renderFooter()}
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function renderWeeklyText(sections: WeeklySection[]): string {
  const sectionTitles: Record<string, string> = {
    digest: "状態ダイジェスト",
    finding: "今週のFinding",
    followup: "続報",
    stable_coverage: "安定指標とカバレッジ",
    nudge: "",
  };
  const lines = ["今週の会社", "=".repeat(40), ""];
  for (const s of sections) {
    if (!s.content) continue;
    const title = sectionTitles[s.type] || s.type;
    if (title) lines.push(`■ ${title}`);
    lines.push(s.content, "");
  }
  lines.push("Sentio — 報告ゼロで見える");
  return lines.join("\n");
}

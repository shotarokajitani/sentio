import type { Day0Report } from "../../shared/contracts/day0-report";

export const DAY0_BLOCK_KEYS = [
  "external_view",
  "reputation",
  "site_health",
  "public_records",
  "opportunities",
  "industry_position",
  "initial_hypothesis",
  "coverage_map",
] as const;

const BLOCK_TITLES: Record<(typeof DAY0_BLOCK_KEYS)[number], string> = {
  external_view: "外から見た自社",
  reputation: "評判の座標",
  site_health: "サイト健全性",
  public_records: "公的記録の非対称",
  opportunities: "今使える機会",
  industry_position: "業界・地域の中の位置",
  initial_hypothesis: "初期懸念への初期仮説",
  coverage_map: "見えるようになる地図",
};

export interface Day0Input {
  companyId: string;
  companyName: string;
  url: string;
  industry: string;
  concern: string | null;
  siteHealth: { ssl_days_remaining: number; response_time_ms: number } | null;
  publicRecords: Array<{ source: string; content: string }>;
  opportunities: Array<{ source: string; title: string; deadline: string }>;
  industryData: Array<{ source: string; content: string }>;
}

export function generateDay0Report(input: Day0Input): Day0Report {
  const start = Date.now();

  const blocks = DAY0_BLOCK_KEYS.map((key) => {
    switch (key) {
      case "external_view":
        return {
          key,
          title: BLOCK_TITLES[key],
          content: `${input.companyName}のウェブサイト(${input.url})の外部からの見え方についての暫定的な観察です`,
          hasData: true,
          sources: ["URL analysis"],
        };

      case "reputation":
        return {
          key,
          title: BLOCK_TITLES[key],
          content: "評判データは接続後に利用可能になる見込みです",
          hasData: false,
          sources: [],
        };

      case "site_health":
        if (input.siteHealth) {
          return {
            key,
            title: BLOCK_TITLES[key],
            content: `SSL証明書の残存日数: ${input.siteHealth.ssl_days_remaining}日、応答時間: ${input.siteHealth.response_time_ms}msと観測されました`,
            hasData: true,
            sources: ["monitor:health", "monitor:ssl"],
          };
        }
        return {
          key,
          title: BLOCK_TITLES[key],
          content: "サイトに到達できなかったため、健全性データは取得できませんでした",
          hasData: false,
          sources: [],
        };

      case "public_records":
        if (input.publicRecords.length > 0) {
          return {
            key,
            title: BLOCK_TITLES[key],
            content: input.publicRecords
              .map((r) => `${r.content} (${r.source}より)`)
              .join("\n"),
            hasData: true,
            sources: input.publicRecords.map((r) => r.source),
          };
        }
        return {
          key,
          title: BLOCK_TITLES[key],
          content: "該当する公的記録は現時点で確認されませんでした",
          hasData: false,
          sources: [],
        };

      case "opportunities":
        if (input.opportunities.length > 0) {
          return {
            key,
            title: BLOCK_TITLES[key],
            content: input.opportunities
              .map((o) => `${o.title} (締切: ${o.deadline}, ${o.source}より)`)
              .join("\n"),
            hasData: true,
            sources: input.opportunities.map((o) => o.source),
          };
        }
        return {
          key,
          title: BLOCK_TITLES[key],
          content: "現在利用可能な機会の情報はありません",
          hasData: false,
          sources: [],
        };

      case "industry_position":
        if (input.industryData.length > 0) {
          return {
            key,
            title: BLOCK_TITLES[key],
            content: input.industryData
              .map((d) => `${d.content} (${d.source}より)`)
              .join("\n"),
            hasData: true,
            sources: input.industryData.map((d) => d.source),
          };
        }
        return {
          key,
          title: BLOCK_TITLES[key],
          content: "業界データは現在収集中です",
          hasData: false,
          sources: [],
        };

      case "initial_hypothesis":
        if (input.concern) {
          return {
            key,
            title: BLOCK_TITLES[key],
            content: `ご懸念の「${input.concern}」について、外部データに基づく暫定的な推察です。今後のデータ接続により、より詳細な分析が可能になる見込みです`,
            hasData: true,
            sources: ["registration:concern"],
          };
        }
        return {
          key,
          title: BLOCK_TITLES[key],
          content: "特定の懸念は登録されていません。データ接続後に自動的に検知を開始します",
          hasData: false,
          sources: [],
        };

      case "coverage_map":
        return {
          key,
          title: BLOCK_TITLES[key],
          content: "現在の接続状況と、追加接続で見えるようになる領域の一覧です",
          hasData: true,
          sources: ["system:coverage"],
        };
    }
  });

  return {
    company_id: input.companyId,
    blocks,
    generated_at: new Date().toISOString(),
    generation_time_ms: Date.now() - start,
  };
}

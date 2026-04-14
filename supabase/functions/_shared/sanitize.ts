// Claude APIへの送信前にPII（メアド・電話番号）をマスクする
// Why: 経営者の会話・外部データに個人情報が混入する可能性があり、外部APIへ平文送信しない

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// 国際表記(+81...)、ハイフン/スペース/括弧区切り、日本の固定/携帯（03-..., 090-..., 0120-...）をカバー
const PHONE_RE =
  /(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)\d{2,4}[-.\s]?\d{3,4}/g;

export function sanitizePII(input: string): string {
  if (!input) return input;
  return input.replace(EMAIL_RE, "[EMAIL]").replace(PHONE_RE, (m) => {
    // 桁数が少なすぎるものは誤検出の可能性が高いので除外
    const digits = m.replace(/\D/g, "");
    return digits.length >= 9 ? "[PHONE]" : m;
  });
}

// オブジェクト/配列の文字列を再帰的にサニタイズ
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === "string") return sanitizePII(value) as unknown as T;
  if (Array.isArray(value)) return value.map(sanitizeDeep) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

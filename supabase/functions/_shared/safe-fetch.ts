/**
 * 利用者が入れた URL を取りに行くときの fetch（2026-09-13 の点検・PR-3 の 22・SSRF 防止）。
 *
 * ## 何が起きていたか
 *
 * `day0/index.ts` の `analyzeUrl` は、登録時に利用者が入れた自社サイトの URL を
 * `fetch(url, { redirect: "follow" })` でそのまま取りに行っていた。
 * **URL に `http://169.254.169.254/`（クラウドのメタデータ）や `http://127.0.0.1/` を入れる、
 * または外部のサイトから内部の宛先へリダイレクトさせると、Edge Function の中から
 * 内部の宛先を叩かせることができた。** 取れた本文はそのまま LLM に渡り、レポートに出うる。
 *
 * ## 決め方
 *
 * - (a) `http` / `https` 以外のスキームは拒否
 * - (b) ホストを DNS で解決し、**解決後の IP が内部の範囲なら拒否**。解決できなければ拒否
 * - (c) リダイレクトは自動で追わない（`redirect: "manual"`）。**最大3回まで手で追い、毎回 (a)(b) をやり直す**
 * - (d) 応答は 2MB・10秒で打ち切る
 * - (e) Content-Type が text/html・text/plain・application/json・application/xml 以外なら本文を読まない
 *
 * ## 守れない範囲（設計上の限界）
 *
 * **解決した IP と、fetch が実際につなぐ IP は同じとは限らない**（DNS rebinding）。
 * Deno の fetch は接続先の IP を指定できないので、確かめた直後に DNS の答えが変われば通りうる。
 * 解決を2回（A と AAAA）引いてどちらも見る、TTL の短い答えを疑う、までは、この関数ではしていない。
 *
 * ## 試験
 *
 * 解決（`resolve`）と取得（`fetch`）は差し替えられる。本番は `Deno.resolveDns` と `fetch` を使う。
 */

export const SAFE_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const SAFE_FETCH_TIMEOUT_MS = 10_000;
export const SAFE_FETCH_MAX_REDIRECTS = 3;

const READABLE_TYPES = ["text/html", "text/plain", "application/json", "application/xml"];

export type SafeFetchFailure =
  | "scheme_not_allowed"
  | "invalid_url"
  | "blocked_address"
  | "dns_failed"
  | "too_many_redirects"
  | "timeout"
  | "fetch_failed";

export type SafeFetchResult =
  | {
      ok: true;
      status: number;
      /** 最後に取りに行った URL（リダイレクトを追ったあと） */
      url: string;
      contentType: string;
      /** 読んでよい Content-Type のときだけ入る。**2MB で打ち切る** */
      body: Uint8Array | null;
      truncated: boolean;
    }
  | { ok: false; reason: SafeFetchFailure; url: string };

export interface SafeFetchDeps {
  /** ホスト名を IP の一覧にする。**引けなければ空配列か例外** */
  resolve: (hostname: string) => Promise<string[]>;
  fetch: typeof fetch;
}

// ---------------------------------------------------------------------------
// IP の判定
// ---------------------------------------------------------------------------

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (p !== "" && /^[0-9]+$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? nums : null;
}

/** IPv6 を 8 つの 16 ビットに展開する。末尾が IPv4 の形（::ffff:1.2.3.4）も受ける */
function parseIPv6(raw: string): number[] | null {
  let ip = raw.toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (!ip.includes(":")) return null;

  let tail: number[] = [];
  const lastColon = ip.lastIndexOf(":");
  const last = ip.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    ip = ip.slice(0, lastColon + 1) + "0";
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const groupsCount = tail.length > 0 ? 7 : 8;
  const missing = groupsCount - head.length - rest.length + (tail.length > 0 ? 0 : 0);
  if (halves.length === 1 && head.length !== groupsCount) return null;
  if (missing < 0) return null;

  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const nums = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  const groups = tail.length > 0 ? [...nums.slice(0, 6), ...tail] : nums;
  return groups.length === 8 ? groups : null;
}

function inIPv4Range(ip: number[], base: number[], prefix: number): boolean {
  const toInt = (a: number[]) => ((a[0] << 24) >>> 0) + (a[1] << 16) + (a[2] << 8) + a[3];
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (toInt(ip) & mask) >>> 0 === (toInt(base) & mask) >>> 0;
}

const BLOCKED_V4: Array<[number[], number]> = [
  [[10, 0, 0, 0], 8],
  [[172, 16, 0, 0], 12],
  [[192, 168, 0, 0], 16],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[0, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
];

/**
 * 内部の宛先か。**判定できない形は内部として扱う**（fail-closed）。
 *
 * IPv4: 10/8・172.16/12・192.168/16・127/8・169.254/16・0/8・100.64/10
 * IPv6: ::1・fc00::/7・fe80::/10・::ffff:0:0/96（IPv4 射影は中身を問わず拒否）・::（未指定）
 * 169.254.169.254 と fd00:ec2::254 は範囲に含まれるが、明示的にも拒否する
 */
export function isBlockedAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) {
    if (address === "169.254.169.254") return true;
    return BLOCKED_V4.some(([base, prefix]) => inIPv4Range(v4, base, prefix));
  }

  const v6 = parseIPv6(address);
  if (!v6) return true;
  const hex = v6.map((g) => g.toString(16)).join(":");
  if (hex === "fd00:ec2:0:0:0:0:0:254") return true;
  if (v6.every((g) => g === 0)) return true; // ::
  if (v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1) return true; // ::1
  if ((v6[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((v6[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if (v6.slice(0, 4).every((g) => g === 0) && v6[4] === 0 && v6[5] === 0xffff) return true; // ::ffff:0:0/96
  return false;
}

// ---------------------------------------------------------------------------
// 1回ぶんの宛先の検査
// ---------------------------------------------------------------------------

type TargetCheck = { ok: true; url: URL } | { ok: false; reason: SafeFetchFailure };

async function checkTarget(rawUrl: string, deps: SafeFetchDeps): Promise<TargetCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  // (a) スキーム
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "scheme_not_allowed" };
  }

  // (b) 解決後の IP。**IP をそのまま書いた URL は解決しない**（URL の解析が正規化した形を見る）
  const host = url.hostname;
  const literal = parseIPv4(host) ? host : host.startsWith("[") ? host : null;
  let addresses: string[];
  if (literal) {
    addresses = [literal];
  } else {
    try {
      addresses = await deps.resolve(host);
    } catch {
      return { ok: false, reason: "dns_failed" };
    }
    if (addresses.length === 0) return { ok: false, reason: "dns_failed" };
  }
  // **1つでも内部の宛先が混じれば拒否する**
  if (addresses.some((a) => isBlockedAddress(a))) return { ok: false, reason: "blocked_address" };
  return { ok: true, url };
}

function readableType(contentType: string): boolean {
  const base = contentType.split(";")[0].trim().toLowerCase();
  return READABLE_TYPES.includes(base);
}

/** 本文を 2MB まで読む。超えたら読むのをやめる */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ body: Uint8Array; truncated: boolean }> {
  if (!res.body) return { body: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.slice(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return { body, truncated };
}

/**
 * 本番の依存。DNS は **Deno.resolveDns（A と AAAA）** で引き、使えなければ **node:dns** で引く。
 *
 * Supabase の Edge Runtime で `Deno.resolveDns` が使えるかは、公開の文書で確かめられなかった（未検証）。
 * 使えない環境で解決がすべて失敗すると、利用者のサイトが1件も取れなくなる。
 * **どちらでも引けなければ解決の失敗として拒否する**（fail-closed は変えない）。
 */
export function denoDeps(): SafeFetchDeps {
  return {
    resolve: async (hostname: string) => {
      const d = (globalThis as unknown as {
        Deno?: { resolveDns?: (h: string, t: "A" | "AAAA") => Promise<string[]> };
      }).Deno;
      if (typeof d?.resolveDns === "function") {
        const results = await Promise.allSettled([
          d.resolveDns(hostname, "A"),
          d.resolveDns(hostname, "AAAA"),
        ]);
        const found = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
        if (found.length > 0) return found;
      }
      const dns = await import("node:dns");
      const all = await dns.promises.lookup(hostname, { all: true });
      return all.map((entry: { address: string }) => entry.address);
    },
    fetch: (input, init) => fetch(input, init),
  };
}

/**
 * 利用者が入れた URL を安全に取りに行く。**失敗は例外にせず理由を返す。**
 */
export async function safeFetch(
  rawUrl: string,
  opts: {
    headers?: Record<string, string>;
    deps?: SafeFetchDeps;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Promise<SafeFetchResult> {
  const deps = opts.deps ?? denoDeps();
  const timeoutMs = opts.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? SAFE_FETCH_MAX_BYTES;

  // (d) **全体で10秒**（リダイレクトと本文の読み取りを含む）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let current = rawUrl;

  try {
    for (let hop = 0; ; hop++) {
      const target = await checkTarget(current, deps);
      if (!target.ok) return { ok: false, reason: target.reason, url: current };

      let res: Response;
      try {
        res = await deps.fetch(target.url.toString(), {
          headers: opts.headers,
          // (c) **自動で追わない**
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        return {
          ok: false,
          reason: controller.signal.aborted ? "timeout" : "fetch_failed",
          url: current,
        };
      }

      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel();
        if (hop >= SAFE_FETCH_MAX_REDIRECTS) {
          return { ok: false, reason: "too_many_redirects", url: current };
        }
        // 相対の Location は今の URL を基準に解決する。**次の周で (a)(b) をやり直す**
        current = new URL(res.headers.get("location") as string, target.url).toString();
        continue;
      }

      const contentType = res.headers.get("content-type") ?? "";
      // (e) 読んでよい種類でなければ本文を読まない
      if (!readableType(contentType)) {
        await res.body?.cancel();
        return {
          ok: true,
          status: res.status,
          url: current,
          contentType,
          body: null,
          truncated: false,
        };
      }

      try {
        const { body, truncated } = await readCapped(res, maxBytes);
        return { ok: true, status: res.status, url: current, contentType, body, truncated };
      } catch {
        return {
          ok: false,
          reason: controller.signal.aborted ? "timeout" : "fetch_failed",
          url: current,
        };
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

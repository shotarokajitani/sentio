import { NextRequest, NextResponse } from "next/server";

export interface UrlAnalysis {
  url: string;
  title: string | null;
  description: string | null;
  h1: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  lang: string | null;
  error: string | null;
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }

  const result = await analyzeUrl(url);
  return NextResponse.json(result);
}

export async function analyzeUrl(url: string): Promise<UrlAnalysis> {
  const result: UrlAnalysis = {
    url,
    title: null,
    description: null,
    h1: null,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    lang: null,
    error: null,
  };

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Sentio/1.0 (site-analysis)",
        Accept: "text/html",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      result.error = `HTTP ${res.status}`;
      return result;
    }

    // Detect charset from Content-Type header
    const contentType = res.headers.get("content-type") || "";
    let charset = "utf-8";
    const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
    if (charsetMatch) {
      charset = charsetMatch[1].toLowerCase();
    }

    // Read as bytes and decode with correct charset
    const bytes = await res.arrayBuffer();
    let html: string;

    try {
      const decoder = new TextDecoder(charset, { fatal: false });
      html = decoder.decode(bytes);
    } catch {
      // Fallback to utf-8
      html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }

    // Check for meta charset in HTML if header didn't specify
    if (!charsetMatch) {
      const metaCharset = html.match(
        /<meta[^>]+charset=["']?([^"'\s;>]+)/i,
      );
      if (metaCharset) {
        const detectedCharset = metaCharset[1].toLowerCase();
        if (detectedCharset !== "utf-8") {
          try {
            const decoder = new TextDecoder(detectedCharset, { fatal: false });
            html = decoder.decode(bytes);
            charset = detectedCharset;
          } catch {
            // Keep utf-8 decoded version
          }
        }
      }
    }

    // Extract metadata
    result.title = extractTag(html, /<title[^>]*>([^<]+)<\/title>/i);
    result.description = extractMeta(html, "description");
    result.h1 = extractTag(html, /<h1[^>]*>([^<]+)<\/h1>/i);
    result.ogTitle = extractMeta(html, "og:title", "property");
    result.ogDescription = extractMeta(html, "og:description", "property");
    result.ogImage = extractMeta(html, "og:image", "property");

    const langMatch = html.match(/<html[^>]+lang=["']?([^"'\s>]+)/i);
    result.lang = langMatch ? langMatch[1] : null;
  } catch (e) {
    result.error = (e as Error).message;
  }

  return result;
}

function extractTag(html: string, regex: RegExp): string | null {
  const match = html.match(regex);
  return match ? decodeHtmlEntities(match[1].trim()) : null;
}

function extractMeta(
  html: string,
  name: string,
  attr: string = "name",
): string | null {
  // Match both name="..." content="..." and content="..." name="..." orders
  const regex = new RegExp(
    `<meta[^>]+${attr}=["']${name}["'][^>]+content=["']([^"']*)["']` +
      `|<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${name}["']`,
    "i",
  );
  const match = html.match(regex);
  if (!match) return null;
  return decodeHtmlEntities((match[1] || match[2]).trim());
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCodePoint(parseInt(dec)),
    );
}

import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";

/* ============================================================
   LRU CACHE (SERVERLESS SAFE – WARM ONLY)
============================================================ */

class LRUCache {
  constructor(maxSize = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const entry = this.cache.get(key);

    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.data;
  }

  set(key, data, ttl) {
    if (this.cache.size >= this.maxSize) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, { data, ttl, timestamp: Date.now() });
  }
}

const CACHE = new LRUCache(100);
const DEFAULT_TTL = 10 * 60 * 1000;

/* ============================================================
   HELPERS
============================================================ */

const hash = text =>
  createHash("md5").update(text).digest("hex").slice(0, 16);

/* ============================================================
   GOOGLE NEWS URL RESOLVER
============================================================ */

async function resolveGoogleNewsUrl(url) {
  if (!url.includes("news.google.com")) return url;

  try {
    const res = await axios.get(url, {
      timeout: 12000,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });

    const $ = cheerio.load(res.data || "");

    const canonical =
      $('link[rel="canonical"]').attr("href") ||
      $('meta[property="og:url"]').attr("content");

    if (canonical && canonical.startsWith("http")) {
      return canonical;
    }

    const refresh = $('meta[http-equiv="refresh"]').attr("content");
    if (refresh) {
      const match = refresh.match(/url=(.*)/i);
      if (match && match[1]) return match[1].trim();
    }

    let fallback = null;
    $("a").each((_, el) => {
      const href = $(el).attr("href");
      if (href && href.startsWith("http") && !href.includes("google")) {
        fallback = href;
        return false;
      }
    });

    return fallback || url;
  } catch {
    return url;
  }
}

/* ============================================================
   CIRCUIT BREAKER (SERVERLESS SAFE)
============================================================ */

class CircuitBreaker {
  constructor(limit = 5, timeout = 60000) {
    this.failures = 0;
    this.limit = limit;
    this.timeout = timeout;
    this.state = "CLOSED";
    this.nextTry = 0;
  }

  async exec(fn) {
    if (this.state === "OPEN" && Date.now() < this.nextTry) {
      throw new Error("Circuit breaker open");
    }

    try {
      const result = await fn();
      this.failures = 0;
      this.state = "CLOSED";
      return result;
    } catch (err) {
      this.failures++;
      if (this.failures >= this.limit) {
        this.state = "OPEN";
        this.nextTry = Date.now() + this.timeout;
      }
      throw err;
    }
  }
}

const breaker = new CircuitBreaker();

/* ============================================================
   CONTENT EXTRACTION
============================================================ */

class FullContentExtractor {
  constructor($) {
    this.$ = $;
  }

  extractText() {
    const $ = this.$;

    [
      "script","style","noscript","header","footer","nav","aside",
      "form",".ads",".promo",".share",".comment",".sidebar"
    ].forEach(s => $(s).remove());

    const priority = [
      "article",
      "main",
      "[role='main']",
      ".article-content",
      ".story-content",
      ".entry-content",
      ".post-content",
      ".article-body"
    ];

    for (const selector of priority) {
      const el = $(selector);
      if (el.length && el.text().length > 300) {
        return el.text().trim();
      }
    }

    const paragraphs = [];
    $("p").each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 25) paragraphs.push(text);
    });

    return paragraphs.join(" ");
  }

  extractMetadata() {
    const $ = this.$;
    return {
      title:
        $('meta[property="og:title"]').attr("content") ||
        $("title").text() ||
        $("h1").first().text() ||
        "",
      description:
        $('meta[property="og:description"]').attr("content") ||
        $('meta[name="description"]').attr("content") ||
        "",
      author:
        $('meta[name="author"]').attr("content") ||
        "",
      publishDate:
        $('meta[property="article:published_time"]').attr("content") ||
        "",
      siteName:
        $('meta[property="og:site_name"]').attr("content") ||
        ""
    };
  }
}

/* ============================================================
   TEXT CLEANER
============================================================ */

function cleanText(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/ADVERTISEMENT|Subscribe|Related Articles/gi, "")
    .trim();
}

/* ============================================================
   IMAGE EXTRACTION
============================================================ */

function extractImages($, baseUrl) {
  const images = [];
  const seen = new Set();

  $("img").each((_, el) => {
    let src = $(el).attr("src") || $(el).attr("data-src");
    if (!src) return;

    try {
      src = new URL(src, baseUrl).href;
      if (!seen.has(src)) {
        seen.add(src);
        images.push({
          src,
          alt: $(el).attr("alt") || ""
        });
      }
    } catch {}
  });

  return images;
}

/* ============================================================
   VERCEL SERVERLESS HANDLER
============================================================ */

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const startTime = Date.now();
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing ?url parameter" });
  }

  const cacheKey = `search:${hash(url)}`;
  const cached = CACHE.get(cacheKey);

  if (cached) {
    return res.json({
      success: true,
      cached: true,
      ...cached
    });
  }

  try {
    const resolvedUrl = await resolveGoogleNewsUrl(url);

    const response = await breaker.exec(() =>
      axios.get(resolvedUrl, {
        timeout: 15000,
        maxRedirects: 5,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
      })
    );

    const $ = cheerio.load(response.data || "");
    const extractor = new FullContentExtractor($);

    const rawText = extractor.extractText();
    const cleanedText = cleanText(rawText);
    const metadata = extractor.extractMetadata();
    const images = extractImages($, resolvedUrl);

    const result = {
      originalUrl: url,
      resolvedUrl,
      metadata,
      fullText: cleanedText,
      images,
      stats: {
        words: cleanedText.split(/\s+/).length,
        chars: cleanedText.length,
        images: images.length,
        processingTimeMs: Date.now() - startTime
      }
    };

    CACHE.set(cacheKey, result, DEFAULT_TTL);

    return res.json({
      success: true,
      cached: false,
      ...result
    });
  } catch (err) {
    return res.status(500).json({
      error: "Search failed",
      message: err.message
    });
  }
}

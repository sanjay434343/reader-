import Parser from "rss-parser";
import { createHash } from "crypto";

const parser = new Parser();

/* ============================================================
   SIMPLE CACHE (SERVERLESS WARM ONLY)
============================================================ */

const CACHE = new Map();
const TTL = 5 * 60 * 1000; // 5 minutes

function getCache(key) {
  const c = CACHE.get(key);
  if (!c) return null;
  if (Date.now() - c.time > TTL) {
    CACHE.delete(key);
    return null;
  }
  return c.data;
}

function setCache(key, data) {
  CACHE.set(key, { data, time: Date.now() });
}

const hash = s =>
  createHash("md5").update(s).digest("hex").slice(0, 12);

/* ============================================================
   GOOGLE NEWS SEARCH (RSS)
============================================================ */

function buildGoogleNewsRSS({
  q,
  lang = "en",
  country = "IN"
}) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(
    q
  )}&hl=${lang}-${country}&gl=${country}&ceid=${country}:${lang}`;
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

  const {
    q,
    limit = 20,
    lang = "en",
    country = "IN"
  } = req.query;

  if (!q) {
    return res.status(400).json({
      error: "Missing ?q parameter",
      example:
        "/api/search?q=recent bomb attack in delhi"
    });
  }

  const cacheKey = hash(`${q}|${limit}|${lang}|${country}`);
  const cached = getCache(cacheKey);
  if (cached) {
    return res.json({
      success: true,
      cached: true,
      ...cached
    });
  }

  try {
    const rssUrl = buildGoogleNewsRSS({ q, lang, country });
    const feed = await parser.parseURL(rssUrl);

    const articles = feed.items.slice(0, Number(limit)).map(item => ({
      title: item.title,
      link: item.link,
      publishedAt: item.pubDate,
      source: item.source?.title || "Google News",
      description: item.contentSnippet || ""
    }));

    const result = {
      query: q,
      total: articles.length,
      articles
    };

    setCache(cacheKey, result);

    return res.json({
      success: true,
      cached: false,
      ...result
    });
  } catch (err) {
    return res.status(500).json({
      error: "Google News RSS fetch failed",
      message: err.message
    });
  }
}

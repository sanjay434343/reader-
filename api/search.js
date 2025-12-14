import axios from "axios";
import Parser from "rss-parser";
import { createHash } from "crypto";

const parser = new Parser();

/* ============================================================
   SIMPLE IN-MEMORY CACHE (WARM ONLY)
============================================================ */

const CACHE = new Map();
const TTL = 5 * 60 * 1000; // 5 minutes

function getCache(key) {
  const v = CACHE.get(key);
  if (!v) return null;
  if (Date.now() - v.time > TTL) {
    CACHE.delete(key);
    return null;
  }
  return v.data;
}

function setCache(key, data) {
  CACHE.set(key, { data, time: Date.now() });
}

const hash = s =>
  createHash("md5").update(s).digest("hex").slice(0, 12);

/* ============================================================
   GOOGLE NEWS RSS BUILDER
============================================================ */

function googleNewsRSS({ q, lang = "en", country = "IN" }) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(
    q
  )}&hl=${lang}-${country}&gl=${country}&ceid=${country}:${lang}`;
}

/* ============================================================
   SERVERLESS HANDLER
============================================================ */

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const {
      q,
      limit = 20,
      lang = "en",
      country = "IN"
    } = req.query;

    if (!q) {
      return res.status(400).json({
        error: "Missing ?q parameter",
        example: "/api/search?q=recent bomb attack in delhi"
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

    const rssUrl = googleNewsRSS({ q, lang, country });

    // 🔥 IMPORTANT: fetch RSS manually (prevents 500)
    const rssResponse = await axios.get(rssUrl, {
      timeout: 12000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      }
    });

    const feed = await parser.parseString(rssResponse.data);

    const articles = (feed.items || [])
      .slice(0, Number(limit))
      .map(item => ({
        title: item.title || "",
        link: item.link || "",
        publishedAt: item.pubDate || null,
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
    console.error("SEARCH API ERROR:", err);

    return res.status(500).json({
      error: "Google News RSS fetch failed",
      message: err.message || "Unknown error"
    });
  }
}

/**
 * Vercel Serverless API: Comprehensive News Aggregator + Article Fetcher + Unified Summary
 *
 * Features:
 *  - Uses a list of news sources (imported from ./news_urls.js)
 *  - Fast axios instance with sensible timeouts
 *  - Lightweight in-memory cache (resets on cold start)
 *  - Parallel scraping with safeguards and DOM-scan limits
 *  - Pollinations.ai (text.pollinations.ai) used for:
 *      * Category fallback detection
 *      * Selecting best URLs (shortlisting)
 *      * Generating a unified summary with 1..10 simple learning points (basic English)
 *  - Fetches full article content via external scraper endpoint:
 *      https://reader-zeta-three.vercel.app/api/scrape?url=<encoded-url>
 *  - Enforces a 2 second delay between processing each "best" article (per request)
 *  - Produces `bestArticles` and `unifiedSummary` in the response
 *  - Designed for Vercel serverless (export default handler)
 *
 * Notes:
 *  - Requires: ./news_urls.js (export default array of site objects used previously)
 *  - Pollinations endpoints sometimes return free-text; this code extracts JSON via regex
 *  - Keep API keys out of this file. Pollinations currently used without a key (public API)
 *  - Adjust timeouts and concurrency if you need different performance/robustness tradeoffs
 */

import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";
import NEWS_SITES from "./news_urls.js";

/* ===========================
   Configuration
   =========================== */

const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const AXIOS_TIMEOUT = 7000; // ms for general requests
const SCRAPER_TIMEOUT = 15000; // ms for article fetch from reader endpoint
const POLLINATIONS_TIMEOUT = 20000; // ms for Pollinations / text.ai calls
const MAX_SITES = 12; // reduce the number of news sites scraped per request for speed
const MAX_LINKS_PER_SITE = 80; // how many <a> elements to scan per site for faster DOM processing
const FETCH_RETRY = 1; // number of retries for fetching article content
const ARTICLE_PROCESS_DELAY_MS = 2000; // 2 seconds delay between processing each best article

/* ===========================
   Fast axios instances
   =========================== */

const http = axios.create({
  timeout: AXIOS_TIMEOUT,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
});

/* Axios instance for reader endpoint (longer timeout) */
const readerHttp = axios.create({
  timeout: SCRAPER_TIMEOUT,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; NewsAggregator/1.0; +https://yourdomain.example)",
    Accept: "application/json, text/plain, */*",
  },
});

/* ===========================
   Simple in-memory cache
   (resets on cold start)
   =========================== */

const CACHE = new Map();

function getCache(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > entry.ttl) {
    CACHE.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data, ttl = CACHE_TTL) {
  CACHE.set(key, { data, time: Date.now(), ttl });
}

/* ===========================
   Utility helpers
   =========================== */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeExtractJSON(text) {
  // Extract the first {...} or [...] JSON-like substring and parse it.
  if (!text || typeof text !== "string") return null;
  const braceMatch = text.match(/\{[\s\S]*\}/);
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  const candidate = braceMatch ? braceMatch[0] : arrayMatch ? arrayMatch[0] : null;
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch (e) {
    // Attempt small fixes (replace smart quotes, trailing commas)
    try {
      const cleaned = candidate
        .replace(/(\r\n|\n|\r)/g, " ")
        .replace(/,\s*}/g, "}")
        .replace(/,\s*]/g, "]");
      return JSON.parse(cleaned);
    } catch (e2) {
      return null;
    }
  }
}

/* ===========================
   Category detection (fallback via Pollinations)
   =========================== */

async function detectCategoryPollinations(query) {
  try {
    const prompt = encodeURIComponent(
      `Return only ONE WORD category for this query: "${query}". Choose from: general, technology, business, sports, science, entertainment, health, politics.`
    );

    const url = `https://text.pollinations.ai/${prompt}`;
    const resp = await http.get(url, { timeout: POLLINATIONS_TIMEOUT });
    const out = (resp?.data || "").toString().trim().toLowerCase();
    const valid = [
      "general",
      "technology",
      "business",
      "sports",
      "science",
      "entertainment",
      "health",
      "politics",
    ];
    return valid.includes(out) ? out : "general";
  } catch (err) {
    return "general";
  }
}

/* ===========================
   Pollinations — pick best URLs
   (send reduced results to save time)
   =========================== */

async function analyzeWithPollinations(query, results) {
  try {
    const reduced = (results || [])
      .slice(0, 12)
      .map((r, i) => `${i + 1}. ${r.title}\nURL: ${r.url}`)
      .join("\n\n");

    const prompt = encodeURIComponent(`
You are a factual assistant. For the user query: "${query}" analyze the following candidate news results.

${reduced}

Return JSON ONLY with the structure:
{
  "bestUrls": ["<url1>", "<url2>", ...],
  "reasoning": "<short explanation - 1-2 sentences>"
}
Choose up to 6 best URLs (most relevant, authoritative, and recent).
    `);

    const url = `https://text.pollinations.ai/${prompt}`;
    const resp = await http.get(url, { timeout: POLLINATIONS_TIMEOUT });

    const json = safeExtractJSON(resp?.data?.toString?.());
    return json;
  } catch (err) {
    // If Pollinations fails, return null and caller will fallback
    return null;
  }
}

/* ===========================
   Scraping one news site (fast)
   - Only scans first N anchors to speed up
   - Attempts to normalize relative links
   =========================== */

function isLikelyBadUrl(u) {
  if (!u) return true;
  const bad = [
    "facebook.com",
    "instagram.com",
    "pinterest.com",
    "x.com",
    "twitter.com",
    "mailto:",
    "whatsapp",
    "share",
    "signup",
    "privacy",
    "terms",
  ];
  return bad.some((p) => u.toLowerCase().includes(p));
}

async function scrapeSite(site, query, words) {
  try {
    const searchUrl = site.url(query);
    const resp = await http.get(searchUrl);
    const $ = cheerio.load(resp.data);
    const out = [];

    // limit anchors scanned to avoid heavy DOM traversal
    const anchors = $("a").slice(0, MAX_LINKS_PER_SITE);
    anchors.each((i, el) => {
      try {
        const $el = $(el);
        let href = $el.attr("href");
        let title = $el.text().trim() || $el.attr("title") || $el.attr("aria-label") || "";

        if (!href || !title || title.length < 6) return;

        if (!href.startsWith("http")) {
          try {
            href = new URL(href, searchUrl).href;
          } catch {
            return;
          }
        }

        if (isLikelyBadUrl(href)) return;

        const desc =
          $el.closest("article, .article, .story, .post, .item").find("p").first().text().trim() ||
          title;

        // simple scoring
        const lowerTitle = title.toLowerCase();
        const score = words.reduce((s, w) => {
          if (lowerTitle.includes(w)) s += 10;
          if (href.toLowerCase().includes(w)) s += 3;
          return s;
        }, 0);

        out.push({
          site: site.name,
          category: site.category,
          region: site.region,
          title,
          description: desc,
          url: href,
          score,
        });
      } catch (innerErr) {
        // ignore single anchor errors
      }
    });

    return out;
  } catch (err) {
    return [];
  }
}

/* ===========================
   Deduplicate and rank results
   =========================== */

function dedupeResults(results) {
  const urlMap = new Map();
  for (const r of results) {
    const key = (r.url || "").toLowerCase().replace(/\/$/, "");
    if (!key) continue;
    if (!urlMap.has(key) || (urlMap.get(key).score || 0) < (r.score || 0)) {
      urlMap.set(key, r);
    }
  }
  return Array.from(urlMap.values());
}

/* ===========================
   Fetch full article using reader endpoint
   (with retries)
   =========================== */

async function fetchFullArticleFromReader(url) {
  const encoded = encodeURIComponent(url);
  const endpoint = `https://reader-zeta-three.vercel.app/api/scrape?url=${encoded}`;

  for (let attempt = 0; attempt <= FETCH_RETRY; attempt++) {
    try {
      const resp = await readerHttp.get(endpoint);
      if (resp?.data?.success) {
        // return normalized subset
        const data = resp.data;
        return {
          success: true,
          url,
          title: data.metadata?.title || null,
          description: data.metadata?.description || null,
          author: data.metadata?.author || null,
          siteName: data.metadata?.siteName || null,
          publishDate: data.metadata?.publishDate || null,
          images: data.images || [],
          summary: data.contentParts?.[0]?.summary || null,
          fullText: data.fullText || null,
          raw: data,
        };
      } else {
        // unsupported or failed
        return { success: false, url, error: "reader returned success:false", raw: resp?.data };
      }
    } catch (err) {
      if (attempt < FETCH_RETRY) {
        // small backoff then retry
        await sleep(500);
        continue;
      }
      return { success: false, url, error: err.message || "fetch failed" };
    }
  }
}

/* ===========================
   Pollinations — create unified summary
   The user asked: "make the summary of the content using bestArticles"
   -> produce 1..10 basic-English learning points with exact content
   =========================== */

async function createUnifiedSummaryPollinations(query, bestArticles) {
  try {
    // Build a compact context for Pollinations: include title + summary (or first 300 chars) of each article
    const parts = bestArticles.map((a, i) => {
      const short = (a.summary && a.summary.length > 0)
        ? a.summary
        : (a.fullText ? a.fullText.substring(0, 400) : "");
      return `${i + 1}. ${a.title}\nURL: ${a.url}\nText: ${short}`;
    }).join("\n\n");

    const prompt = encodeURIComponent(`
You are an assistant who writes clear, simple, numbered learning points in plain English for readers who just want the main facts.

Context (query): "${query}"

Articles:
${parts}

Instruction:
Produce a JSON object ONLY with this structure:
{
  "unifiedSummary": [
    {"point": 1, "text": "<simple sentence or two, exact content where possible>"},
    {"point": 2, "text": "<...>"},
    ...
  ],
  "notes": "<a short 1-2 sentence note about source reliability>"
}

Rules:
- Output between 3 and 10 numbered points (choose fewer if there's less to say).
- Keep each 'text' field plain English, short (one or two lines), factual.
- Use exact facts where available (names, numbers, dates) drawn from the article content you were given.
- Return valid JSON only (no commentary).
    `);

    const url = `https://text.pollinations.ai/${prompt}`;
    const resp = await http.get(url, { timeout: POLLINATIONS_TIMEOUT });

    // Pollinations sometimes returns textual preface; extract JSON substring
    const candidate = safeExtractJSON(resp?.data?.toString?.());
    if (!candidate) return null;
    // Validate shape
    if (candidate && candidate.unifiedSummary && Array.isArray(candidate.unifiedSummary)) {
      return candidate;
    }
    // fallback: try to coerce into expected shape
    return candidate;
  } catch (err) {
    return null;
  }
}

/* ===========================
   Main Vercel handler
   =========================== */

export default async function handler(req, res) {
  // Basic CORS for public access
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const startTime = Date.now();

  try {
    const { q, limit = 20, category, region } = req.query;
    if (!q || typeof q !== "string" || q.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: "Missing required query parameter ?q=<search term>",
      });
    }

    const query = q.trim();
    const cacheKey = createHash("md5").update(query + "|" + (category || "") + "|" + (region || "")).digest("hex");
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json({ cached: true, ...cached, timeMs: Date.now() - startTime });
    }

    // 1) Detect category (fallback)
    const detectedCategory = category || (await detectCategoryPollinations(query));

    // 2) Select fast subset of sites
    let sources = NEWS_SITES.slice(0, MAX_SITES);
    if (detectedCategory && detectedCategory !== "general") {
      sources = sources.filter((s) => s.category === detectedCategory || s.category === "general");
    }
    if (region) {
      sources = sources.filter((s) => s.region === region || s.region === "Global");
    }

    // 3) Scrape all in parallel (fast)
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scrapePromises = sources.map((s) => scrapeSite(s, query, words));
    const scrapedArrays = await Promise.all(scrapePromises);
    const scraped = scrapedArrays.flat();

    // 4) Deduplicate and rank
    const deduped = dedupeResults(scraped);
    deduped.sort((a, b) => (b.score || 0) - (a.score || 0));
    const topResults = deduped.slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));

    // 5) Ask Pollinations to pick best URLs (shortlist)
    let bestUrls = null;
    const pollinationPick = await analyzeWithPollinations(query, topResults);
    if (pollinationPick && Array.isArray(pollinationPick.bestUrls) && pollinationPick.bestUrls.length > 0) {
      bestUrls = pollinationPick.bestUrls.map((u) => (u || "").toString());
    } else {
      // fallback to top N result URLs
      bestUrls = topResults.slice(0, 6).map((r) => r.url);
    }

    // Deduplicate bestUrls and keep order
    const uniqueBestUrls = [...new Map(bestUrls.map((u) => [u, u])).values()];

    // 6) Fetch each full article one by one with a 2-second delay between each
    const bestArticles = [];
    for (let i = 0; i < uniqueBestUrls.length; i++) {
      const url = uniqueBestUrls[i];
      // fetch
      const article = await fetchFullArticleFromReader(url);
      bestArticles.push(article);
      // wait 2 seconds before next (user requirement)
      if (i < uniqueBestUrls.length - 1) {
        await sleep(ARTICLE_PROCESS_DELAY_MS);
      }
    }

    // 7) Create unified summary (use Pollinations): it expects the bestArticles with summary/fullText
    let unifiedSummary = null;
    const pollinationsSummary = await createUnifiedSummaryPollinations(query, bestArticles);
    if (pollinationsSummary && pollinationsSummary.unifiedSummary) {
      unifiedSummary = pollinationsSummary;
    } else {
      // fallback: create a simple unified summary locally (3-6 points) if Pollinations failed
      const fallbackPoints = [];
      // Use some extraction heuristics from bestArticles
      for (let i = 0; i < Math.min(6, bestArticles.length); i++) {
        const a = bestArticles[i];
        const text = a?.summary || (a?.fullText ? a.fullText.substring(0, 300) : "") || a?.title || "";
        const line = text.split("\n").map(s => s.trim()).filter(Boolean)[0] || text;
        const pointText = line.length > 200 ? line.substring(0, 197) + "..." : line;
        fallbackPoints.push({ point: i + 1, text: pointText });
      }
      unifiedSummary = {
        unifiedSummary: fallbackPoints,
        notes: "Generated locally as Pollinations summary was not available."
      };
    }

    // 8) Build final response, cache and return
    const response = {
      success: true,
      query,
      detectedCategory,
      totalResults: deduped.length,
      results: topResults,
      bestUrls: uniqueBestUrls,
      bestArticles,
      unifiedSummary,
      aiReasoning: pollinationPick?.reasoning || null,
      timeMs: Date.now() - startTime,
    };

    // store
    setCache(cacheKey, response, CACHE_TTL);

    return res.json(response);
  } catch (err) {
    console.error("Handler error:", err?.message || err);
    return res.status(500).json({
      success: false,
      error: "internal_error",
      message: err?.message || String(err),
    });
  }
}

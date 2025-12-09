import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";
import NEWS_SITES from "./news_urls.js";

// ============================================================================
// SERVERLESS CACHE (cold start resets it)
// ============================================================================

const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;

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
  CACHE.set(key, { data, ttl, time: Date.now() });
}

// ============================================================================
// CATEGORY DETECTION USING POLLINATIONS
// ============================================================================

async function detectCategory(query) {
  try {
    const prompt = encodeURIComponent(
      `Return ONE WORD category for query: "${query}": general, technology, business, sports, science, entertainment, health, politics.`
    );

    const res = await axios.get(`https://text.pollinations.ai/${prompt}`, {
      timeout: 7000,
    });

    const out = res.data.trim().toLowerCase();
    const valid = [
      "general", "technology", "business", "sports",
      "science", "entertainment", "health", "politics",
    ];

    return valid.includes(out) ? out : "general";
  } catch {
    return "general";
  }
}

// ============================================================================
// POLLINATIONS AI — SELECT BEST URLS
// ============================================================================

async function analyzeWithPollinations(query, results) {
  try {
    const formatted = results
      .map((r, i) => `${i + 1}. ${r.title}\nURL: ${r.url}`)
      .join("\n\n");

    const prompt = encodeURIComponent(`
Analyze these news results for: "${query}"

${formatted}

Return STRICT JSON ONLY:
{
  "bestUrls": ["url1","url2", ...],
  "reasoning": "Why these URLs were selected"
}
    `);

    const res = await axios.get(`https://text.pollinations.ai/${prompt}`, {
      timeout: 15000,
    });

    const text = res.data.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// ============================================================================
// SCRAPER PER SITE
// ============================================================================

async function scrapeSite(site, query, words) {
  try {
    const searchUrl = site.url(query);

    const res = await axios.get(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 6000,
    });

    const $ = cheerio.load(res.data);
    const results = [];

    $("a").each((i, el) => {
      let url = $(el).attr("href");
      let title = $(el).text().trim();

      if (!url || !title || title.length < 8) return;

      if (!url.startsWith("http")) {
        try {
          url = new URL(url, searchUrl).href;
        } catch {
          return;
        }
      }

      const desc =
        $(el).closest("article").find("p").first().text().trim() || title;

      const score = words.reduce((s, w) => {
        if (title.toLowerCase().includes(w)) s += 10;
        if (desc.toLowerCase().includes(w)) s += 5;
        if (url.toLowerCase().includes(w)) s += 3;
        return s;
      }, 0);

      results.push({
        site: site.name,
        category: site.category,
        region: site.region,
        title,
        description: desc,
        url,
        score,
      });
    });

    return results;
  } catch {
    return [];
  }
}

// ============================================================================
// DEDUPLICATION
// ============================================================================

function dedupe(arr) {
  const map = new Map();
  arr.forEach((r) => {
    const key = r.url.toLowerCase();
    if (!map.has(key) || map.get(key).score < r.score) {
      map.set(key, r);
    }
  });
  return [...map.values()];
}

// ============================================================================
// FETCH FULL ARTICLE USING reader-zeta API
// ============================================================================

async function fetchFullArticle(url) {
  try {
    const encoded = encodeURIComponent(url);
    const endpoint = `https://reader-zeta-three.vercel.app/api/scrape?url=${encoded}`;

    const res = await axios.get(endpoint, { timeout: 12000 });

    if (!res.data.success) return null;

    return {
      url,
      title: res.data.metadata?.title || null,
      description: res.data.metadata?.description || null,
      fullText: res.data.fullText || null,
      summary: res.data.contentParts?.[0]?.summary || null,
      author: res.data.metadata?.author || null,
      siteName: res.data.metadata?.siteName || null,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// MAIN SERVERLESS HANDLER
// ============================================================================

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { q, limit = 20, category, region } = req.query;
  if (!q) return res.status(400).json({ error: "Missing ?q=" });

  const query = q.trim();
  const words = query.toLowerCase().split(/\s+/);

  const cacheKey = createHash("md5").update(query).digest("hex");

  const cached = getCache(cacheKey);
  if (cached) return res.json({ cached: true, ...cached });

  const detected = category || (await detectCategory(query));

  let sources = NEWS_SITES;
  if (detected !== "general") {
    sources = sources.filter(
      (s) => s.category === detected || s.category === "general"
    );
  }

  if (region) {
    sources = sources.filter(
      (s) => s.region === region || s.region === "Global"
    );
  }

  // STEP 1 — Scrape all sites
  const scrapeJobs = sources.map((site) => scrapeSite(site, query, words));
  const scraped = await Promise.all(scrapeJobs);

  const results = dedupe(scraped.flat()).sort((a, b) => b.score - a.score);

  const top = results.slice(0, limit);

  // STEP 2 — Pollinations "best URL" AI ranking
  const ai = await analyzeWithPollinations(query, top);
  const bestUrls = ai?.bestUrls || top.slice(0, 5).map((r) => r.url);

  // STEP 3 — Fetch full articles for each best URL
  const fullArticles = await Promise.all(bestUrls.map((u) => fetchFullArticle(u)));

  const response = {
    success: true,
    query,
    detectedCategory: detected,
    totalResults: results.length,
    results: top,
    bestUrls,
    bestArticles: fullArticles.filter(Boolean),
    aiReasoning: ai?.reasoning || null,
    timeMs: Date.now() - Number(req.headers["x-vercel-start-time"] || Date.now()),
  };

  setCache(cacheKey, response);

  res.json(response);
}

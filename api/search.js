import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";
import NEWS_SITES from "./news_urls.js";

// ============================================================================
// SERVERLESS CACHE (resets on cold start)
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
      `Return ONE WORD category for query: "${query}". Options: general, technology, business, sports, science, entertainment, health, politics.`
    );

    const res = await axios.get(`https://text.pollinations.ai/${prompt}`, {
      timeout: 8000,
    });

    const out = res.data.trim().toLowerCase();
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

Pick the MOST relevant URLs.

Return JSON ONLY:
{
  "bestUrls": ["url1","url2","url3"],
  "reasoning": "short explanation"
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
// SCRAPE EACH NEWS WEBSITE
// ============================================================================

async function scrapeSite(site, query, words) {
  try {
    const searchUrl = site.url(query);

    const res = await axios.get(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 6000,
    });

    const $ = cheerio.load(res.data);
    const out = [];

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

      out.push({
        site: site.name,
        category: site.category,
        region: site.region,
        title,
        description: desc,
        url,
        score,
      });
    });

    return out;
  } catch {
    return [];
  }
}

// ============================================================================
// DEDUPE RESULTS
// ============================================================================

function dedupe(list) {
  const map = new Map();

  for (const r of list) {
    const key = r.url.toLowerCase();
    if (!map.has(key) || map.get(key).score < r.score) {
      map.set(key, r);
    }
  }
  return [...map.values()];
}

// ============================================================================
// FETCH FULL ARTICLE ONE BY ONE
// ============================================================================

async function fetchFullArticle(url) {
  try {
    const encoded = encodeURIComponent(url);
    const apiUrl = `https://reader-zeta-three.vercel.app/api/scrape?url=${encoded}`;

    const res = await axios.get(apiUrl, { timeout: 15000 });

    if (!res.data?.success) {
      return {
        url,
        error: "Cannot fetch article"
      };
    }

    return {
      url,
      title: res.data.metadata?.title || null,
      description: res.data.metadata?.description || null,
      author: res.data.metadata?.author || null,
      siteName: res.data.metadata?.siteName || null,
      fullText: res.data.fullText || null,
      summary: res.data.contentParts?.[0]?.summary || null,
    };
  } catch {
    return {
      url,
      error: "Fetch failed"
    };
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

  // Filter news sources
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

  // SCRAPE ALL SITES
  const scrapeJobs = sources.map((s) => scrapeSite(s, query, words));
  const scraped = await Promise.all(scrapeJobs);

  const results = dedupe(scraped.flat()).sort((a, b) => b.score - a.score);

  const top = results.slice(0, limit);

  // AI SELECT BEST URLS
  const ai = await analyzeWithPollinations(query, top);
  const bestUrls = ai?.bestUrls || top.slice(0, 5).map((r) => r.url);

  // FETCH FULL ARTICLES ONE BY ONE
  const bestArticles = [];

  for (let i = 0; i < bestUrls.length; i++) {
    const article = await fetchFullArticle(bestUrls[i]);
    bestArticles.push({
      index: i + 1,
      ...article,
    });
  }

  const response = {
    success: true,
    query,
    detectedCategory: detected,
    totalResults: results.length,
    results: top,
    bestUrls,
    bestArticles,
    aiReasoning: ai?.reasoning || null,
    timeMs: Date.now() - (req.startTime || Date.now()),
  };

  setCache(cacheKey, response);

  res.json(response);
}

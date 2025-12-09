import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";
import NEWS_SITES from "./news_urls.js";

// ============================================================================
// LIGHTWEIGHT SERVERLESS CACHE (RESET ON COLD START)
// ============================================================================

const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCache(key) {
  const item = CACHE.get(key);
  if (!item) return null;
  if (Date.now() - item.time > item.ttl) {
    CACHE.delete(key);
    return null;
  }
  return item.data;
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
      `Return only ONE WORD category for query: "${query}". Choose from: general, technology, business, sports, science, entertainment, health, politics.`
    );

    const response = await axios.get(`https://text.pollinations.ai/${prompt}`, {
      timeout: 6000
    });

    const value = response.data.trim().toLowerCase();
    const valid = [
      "general",
      "technology",
      "business",
      "sports",
      "science",
      "entertainment",
      "health",
      "politics"
    ];

    return valid.includes(value) ? value : "general";
  } catch {
    return "general";
  }
}

// ============================================================================
// ANALYZE RESULTS USING POLLINATIONS AI
// ============================================================================

async function analyzeWithPollinations(query, results) {
  try {
    const listText = results
      .map((r, i) => `${i + 1}. ${r.title}\nURL: ${r.url}`)
      .join("\n\n");

    const prompt = encodeURIComponent(`
Analyze these news results for the query: "${query}"

${listText}

Your task:
1. Pick ONLY the URLs that are MOST relevant to the query
2. Return JSON ONLY in this format:
{
  "bestUrls": ["url1", "url2", "url3", ...],
  "reasoning": "short explanation of why these were selected"
}
    `);

    const response = await axios.get(`https://text.pollinations.ai/${prompt}`, {
      timeout: 10000
    });

    let text = response.data.trim();

    // Extract JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

// ============================================================================
// DUCKDUCKGO FETCHER
// ============================================================================

async function duckSearch(query) {
  try {
    const response = await axios.get("https://api.duckduckgo.com/", {
      params: { q: query, format: "json", no_html: 1, skip_disambig: 1 },
      timeout: 5000
    });

    const out = [];

    if (response.data.AbstractURL) {
      out.push({
        site: "DuckDuckGo",
        category: "general",
        title: response.data.Heading || query,
        description: response.data.AbstractText || "",
        url: response.data.AbstractURL,
        score: 100,
        region: "Global"
      });
    }

    if (response.data.RelatedTopics) {
      response.data.RelatedTopics.forEach(t => {
        if (t.FirstURL && t.Text) {
          out.push({
            site: "DuckDuckGo",
            category: "general",
            title: t.Text,
            description: t.Text,
            url: t.FirstURL,
            score: 80,
            region: "Global"
          });
        }
      });
    }

    return out;
  } catch {
    return [];
  }
}

// ============================================================================
// URL FILTER
// ============================================================================

function isValidUrl(url) {
  if (!url) return false;
  const bad = ["facebook", "twitter", "instagram", "pinterest", "x.com", "mailto:"];
  return !bad.some(b => url.toLowerCase().includes(b));
}

// ============================================================================
// SCORING ENGINE
// ============================================================================

function score(url, title, desc, words) {
  const text = `${title} ${desc} ${url}`.toLowerCase();
  let s = 0;

  words.forEach(w => {
    if (title.toLowerCase().includes(w)) s += 10;
    if (desc.toLowerCase().includes(w)) s += 5;
    if (url.toLowerCase().includes(w)) s += 3;
  });

  if (/202|today|hours ago|minutes ago/.test(text)) s += 8;

  return s;
}

// ============================================================================
// SCRAPER
// ============================================================================

async function scrapeSite(site, query, words) {
  try {
    const searchUrl = site.url(query);

    const response = await axios.get(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 6000
    });

    const $ = cheerio.load(response.data);
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

      if (!isValidUrl(url)) return;

      const description =
        $(el).closest("article").find("p").first().text().trim() || title;

      results.push({
        site: site.name,
        category: site.category,
        region: site.region,
        title,
        description,
        url,
        score: score(url, title, description, words)
      });
    });

    return results;
  } catch {
    return [];
  }
}

// ============================================================================
// REMOVE DUPLICATES
// ============================================================================

function dedupe(arr) {
  const map = new Map();

  arr.forEach(r => {
    const key = r.url.toLowerCase();
    if (!map.has(key) || map.get(key).score < r.score) {
      map.set(key, r);
    }
  });

  return [...map.values()];
}

// ============================================================================
// VERCEL SERVERLESS HANDLER
// ============================================================================

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") return res.status(200).end();

  const start = Date.now();
  const { q, limit = 20, category, region } = req.query;

  if (!q) return res.status(400).json({ error: "Missing ?q=" });

  const query = q.trim();
  const cacheKey = createHash("md5").update(query).digest("hex");

  const cached = getCache(cacheKey);
  if (cached) return res.json({ cached: true, ...cached });

  const detected = category || (await detectCategory(query));
  const queryWords = query.toLowerCase().split(/\s+/);

  let sources = NEWS_SITES;

  if (detected !== "general") {
    sources = sources.filter(
      s => s.category === detected || s.category === "general"
    );
  }

  if (region) {
    sources = sources.filter(
      s => s.region === region || s.region === "Global"
    );
  }

  // Parallel scraping
  const scrapeJobs = sources.map(s => scrapeSite(s, query, queryWords));
  const [scrapedResults, duck] = await Promise.all([
    Promise.all(scrapeJobs),
    duckSearch(query)
  ]);

  const combined = dedupe([...scrapedResults.flat(), ...duck])
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Pollinations AI relevance selection
  const ai = await analyzeWithPollinations(query, combined);

  const response = {
    success: true,
    query,
    detectedCategory: detected,
    totalResults: combined.length,
    results: combined,
    bestUrls: ai?.bestUrls || combined.slice(0, 5).map(r => r.url),
    aiReasoning: ai?.reasoning || null,
    timeMs: Date.now() - start
  };

  setCache(cacheKey, response);
  res.json(response);
}

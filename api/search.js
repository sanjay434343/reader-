import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";
import NEWS_SITES from "./news_urls.js";

// ============================================================================
// LIGHTWEIGHT SERVERLESS CACHE (RESET ON EVERY COLD START)
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
// CATEGORY DETECTION FALLBACK
// ============================================================================

async function detectCategory(query) {
  try {
    const prompt = encodeURIComponent(
      `Return only ONE WORD category for query: "${query}". Choose from: general, technology, business, sports, science, entertainment, health, politics.`
    );

    const response = await axios.get(`https://text.pollinations.ai/${prompt}`, {
      timeout: 5000
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
// DUCKDUCKGO API RESULT SOURCE
// ============================================================================

async function duckSearch(query) {
  try {
    const response = await axios.get("https://api.duckduckgo.com/", {
      params: {
        q: query,
        format: "json",
        no_html: 1,
        skip_disambig: 1
      },
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
// SCORE ENGINE
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
// SCRAPER FOR EACH NEWS SOURCE
// ============================================================================

async function scrapeSite(site, query, words) {
  try {
    const base = site.url(query);

    const response = await axios.get(base, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 6000
    });

    const $ = cheerio.load(response.data);

    const results = [];

    $("a").each((i, el) => {
      let url = $(el).attr("href");
      let title = $(el).text().trim();

      if (!url || !title || title.length < 10) return;

      // absolute URL fix
      if (!url.startsWith("http")) {
        try {
          url = new URL(url, base).href;
        } catch {
          return;
        }
      }

      if (!isValidUrl(url)) return;

      const description =
        $(el).closest("article").find("p").first().text().trim() ||
        title.substring(0, 200);

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
// DEDUPLICATION
// ============================================================================

function dedupe(list) {
  const map = new Map();
  list.forEach(r => {
    const key = r.url.toLowerCase();
    if (!map.has(key) || map.get(key).score < r.score) {
      map.set(key, r);
    }
  });
  return [...map.values()];
}

// ============================================================================
// SERVERLESS API HANDLER
// ============================================================================

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const start = Date.now();
  const { q, limit = 20, category, region } = req.query;

  if (!q) return res.status(400).json({ error: "Missing ?q query param" });

  const query = q.trim();
  const cacheKey = createHash("md5").update(query + category + region).digest("hex");

  const cached = getCache(cacheKey);
  if (cached) {
    return res.json({ cached: true, ...cached });
  }

  const detected = category || (await detectCategory(query));
  const queryWords = query.toLowerCase().split(/\s+/);

  // filter news sources
  let sources = NEWS_SITES;

  if (detected !== "general") {
    sources = sources.filter(s => s.category === detected || s.category === "general");
  }

  if (region) {
    sources = sources.filter(s => s.region === region || s.region === "Global");
  }

  // parallel scraping
  const scrapeJobs = sources.map(s => scrapeSite(s, query, queryWords));
  const [scrapedResults, duck] = await Promise.all([
    Promise.all(scrapeJobs),
    duckSearch(query)
  ]);

  const combined = dedupe([...scrapedResults.flat(), ...duck])
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const response = {
    success: true,
    query,
    detectedCategory: detected,
    totalResults: combined.length,
    results: combined,
    timeMs: Date.now() - start
  };

  setCache(cacheKey, response);

  res.json(response);
}

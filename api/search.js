// api/search.js

import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";
import NEWS_SITES from "./news_urls.js";   // <-- Correct import

// =============================================================================
// LRU CACHE IMPLEMENTATION
// =============================================================================

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
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { data, ttl, timestamp: Date.now() });
  }
}

const CACHE = new LRUCache(150);
const DEFAULT_TTL = 600 * 1000;

// =============================================================================
// CLAUDE AI ANALYSIS
// =============================================================================

async function analyzeWithClaude(query, results) {
  try {
    const topResults = results.slice(0, 15);

    const resultsText = topResults.map((r, i) =>
      `${i + 1}. [${r.site}] ${r.title}\n   URL: ${r.url}\n   Score: ${r.score}`
    ).join("\n\n");

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: `
Analyze these search results for: "${query}"

${resultsText}

Return ONLY JSON:
{
  "bestUrls": [ ... ],
  "reasoning": "...",
  "category": "..."
}
`
          }
        ]
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 10000
      }
    );

    const aiText = response.data.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");

    const cleanJson = aiText.replace(/```json|```/g, "").trim();
    return JSON.parse(cleanJson);
  } catch {
    return null;
  }
}

// =============================================================================
// FALLBACK CATEGORY DETECTION
// =============================================================================

async function detectCategory(query) {
  try {
    const prompt = encodeURIComponent(
      `Return only ONE WORD category for query: "${query}". Choose from: general, technology, business, sports, science, entertainment, health, politics.`
    );

    const response = await axios.get(
      `https://text.pollinations.ai/${prompt}`,
      { timeout: 5000 }
    );

    const category = response.data.toLowerCase().trim();
    const valid = ["general", "technology", "business", "sports", "science", "entertainment", "health", "politics"];
    return valid.includes(category) ? category : "general";
  } catch {
    return "general";
  }
}

// =============================================================================
// DUCKDUCKGO SEARCH
// =============================================================================

async function searchDuckDuckGo(query) {
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

    const results = [];

    if (response.data.AbstractURL) {
      results.push({
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
          results.push({
            site: "DuckDuckGo",
            category: "general",
            title: t.Text.substring(0, 200),
            description: t.Text,
            url: t.FirstURL,
            score: 80,
            region: "Global"
          });
        }
      });
    }

    return results;
  } catch {
    return [];
  }
}

// =============================================================================
// URL VALIDATION
// =============================================================================

function isValidArticle(url) {
  if (!url) return false;

  const badPatterns = [
    "facebook", "twitter", "instagram", "pinterest", "x.com",
    "mailto:", "login", "signup", "share", "tag/", "topic/"
  ];

  return !badPatterns.some(p => url.toLowerCase().includes(p));
}

// =============================================================================
// SCORING ALGORITHM
// =============================================================================

function scoreResult(url, title, desc, queryWords) {
  const text = `${title} ${desc} ${url}`.toLowerCase();
  let score = 0;

  queryWords.forEach(word => {
    if (title.toLowerCase().includes(word)) score += 10;
    if (desc.toLowerCase().includes(word)) score += 5;
    if (url.toLowerCase().includes(word)) score += 3;
  });

  if (/202[4-5]|today|hours ago|minutes ago|yesterday/.test(text)) score += 8;

  return score;
}

// =============================================================================
// SCRAPE A NEWS SITE
// =============================================================================

async function scrapeSite(site, query, queryWords) {
  try {
    const searchUrl = site.url(query);
    const response = await axios.get(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
      timeout: 8000
    });

    const $ = cheerio.load(response.data);
    const results = [];

    $("a").each((i, el) => {
      let href = $(el).attr("href");
      let title = $(el).text().trim();

      if (!href || !title || title.length < 10) return;

      if (!href.startsWith("http")) {
        try { href = new URL(href, searchUrl).href; }
        catch { return; }
      }

      if (!isValidArticle(href)) return;

      const description =
        $(el).closest("article").find("p").first().text().trim().substring(0, 200)
        || title;

      results.push({
        site: site.name,
        category: site.category,
        region: site.region,
        title,
        description,
        url: href,
        score: scoreResult(href, title, description, queryWords)
      });
    });

    return results;
  } catch {
    return [];
  }
}

// =============================================================================
// REMOVE DUPLICATES
// =============================================================================

function deduplicate(arr) {
  const map = new Map();
  arr.forEach(r => {
    const key = r.url.toLowerCase();
    if (!map.has(key) || map.get(key).score < r.score) {
      map.set(key, r);
    }
  });
  return Array.from(map.values());
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const start = Date.now();
  const { q: query, limit = 20, category: userCategory, region } = req.query;

  if (!query) {
    return res.status(400).json({ error: "Missing ?q query" });
  }

  // Check cache
  const cacheKey = createHash("md5").update(query + userCategory + region).digest("hex");
  const cached = CACHE.get(cacheKey);
  if (cached) {
    return res.json({ cached: true, ...cached });
  }

  const detectedCategory = userCategory || await detectCategory(query);
  const queryWords = query.toLowerCase().split(/\s+/);

  let filteredSites = NEWS_SITES;

  if (detectedCategory !== "general") {
    filteredSites = filteredSites.filter(
      s => s.category === detectedCategory || s.category === "general"
    );
  }

  if (region) {
    filteredSites = filteredSites.filter(
      s => s.region === region || s.region === "Global"
    );
  }

  // scrape
  const scrapePromises = filteredSites.map(site => scrapeSite(site, query, queryWords));
  const duckPromise = searchDuckDuckGo(query);

  const [scraped, ddg] = await Promise.all([Promise.all(scrapePromises), duckPromise]);

  const results = deduplicate([...scraped.flat(), ...ddg])
    .sort((a, b) => b.score - a.score);

  const topResults = results.slice(0, limit);

  const ai = await analyzeWithClaude(query, topResults);

  const response = {
    success: true,
    query,
    detectedCategory: ai?.category || detectedCategory,
    totalResults: results.length,
    results: topResults,
    bestUrls: ai?.bestUrls || topResults.slice(0, 5).map(r => r.url),
    aiReasoning: ai?.reasoning || null,
    timeMs: Date.now() - start
  };

  CACHE.set(cacheKey, response, DEFAULT_TTL);
  res.json(response);
}

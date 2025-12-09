import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";
import NEWS_SITES from "./news_urls.js";

// ========================================================
// FASTER AXIOS INSTANCE (lower timeout + keepalive)
// ========================================================
const http = axios.create({
  timeout: 5000,
  headers: { "User-Agent": "Mozilla/5.0" }
});

// ========================================================
// SERVERLESS CACHE (fast lookup, resets on cold start)
// ========================================================

const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function getCache(key) {
  const c = CACHE.get(key);
  if (!c) return null;
  if (Date.now() - c.time > c.ttl) {
    CACHE.delete(key);
    return null;
  }
  return c.data;
}

function setCache(key, data) {
  CACHE.set(key, { data, time: Date.now(), ttl: CACHE_TTL });
}

// ========================================================
// CATEGORY DETECTION (FAST VERSION)
// ========================================================

async function detectCategory(query) {
  try {
    const prompt = encodeURIComponent(
      `Category for "${query}". Reply ONE WORD: general,tech,business,sports,science,entertainment,health,politics`
    );

    const r = await http.get(`https://text.pollinations.ai/${prompt}`);

    const c = r.data.trim().toLowerCase();
    const ok = [
      "general",
      "technology",
      "business",
      "sports",
      "science",
      "entertainment",
      "health",
      "politics"
    ];
    return ok.includes(c) ? c : "general";
  } catch {
    return "general";
  }
}

// ========================================================
// POLLINATIONS — FAST VERSION
// ========================================================

async function analyzeWithPollinations(query, items) {
  try {
    const reduced = items
      .slice(0, 10) // send only top 10 for SPEED
      .map((r, i) => `${i + 1}. ${r.title}\nURL: ${r.url}`)
      .join("\n\n");

    const prompt = encodeURIComponent(`
Pick relevant URLs for "${query}"

${reduced}

Return JSON ONLY:
{"bestUrls":["...","..."],"reasoning":"..."}
    `);

    const r = await http.get(`https://text.pollinations.ai/${prompt}`, {
      timeout: 8000
    });

    const text = r.data.trim();
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) return null;

    return JSON.parse(json[0]);
  } catch {
    return null;
  }
}

// ========================================================
// SCRAPER (FAST VERSION)
// ========================================================

async function scrapeSite(site, query, words) {
  try {
    const url = site.url(query);
    const r = await http.get(url);

    const $ = cheerio.load(r.data);
    const out = [];

    $("a").slice(0, 80).each((i, el) => {   // limit DOM reads (massive speed)
      let href = $(el).attr("href");
      let title = $(el).text().trim();

      if (!href || !title || title.length < 6) return;

      if (!href.startsWith("http")) {
        try { href = new URL(href, url).href; }
        catch { return; }
      }

      const score = words.reduce((s, w) => {
        if (title.toLowerCase().includes(w)) s += 10;
        if (href.toLowerCase().includes(w)) s += 3;
        return s;
      }, 0);

      out.push({
        site: site.name,
        category: site.category,
        region: site.region,
        title,
        description: title,
        url: href,
        score
      });
    });

    return out;
  } catch {
    return [];
  }
}

// ========================================================
// DEDUPE
// ========================================================

function dedupe(items) {
  const map = new Map();
  for (const r of items) {
    const key = r.url.toLowerCase();
    if (!map.has(key) || map.get(key).score < r.score)
      map.set(key, r);
  }
  return [...map.values()];
}

// ========================================================
// FULL ARTICLE FETCH — NOW PARALLEL FOR SPEED
// ========================================================

async function fetchFullArticle(url) {
  try {
    const safe = encodeURIComponent(url);
    const endpoint = `https://reader-zeta-three.vercel.app/api/scrape?url=${safe}`;

    const r = await http.get(endpoint);

    if (!r.data?.success) {
      return { url, error: "No content" };
    }

    return {
      url,
      title: r.data.metadata?.title || null,
      summary: r.data.contentParts?.[0]?.summary || null,
      fullText: r.data.fullText || null,
      author: r.data.metadata?.author || null,
      siteName: r.data.metadata?.siteName || null
    };
  } catch {
    return { url, error: "Failed" };
  }
}

// ========================================================
// MAIN HANDLER (SUPER FAST)
// ========================================================

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { q, limit = 20, category, region } = req.query;
  if (!q) return res.status(400).json({ error: "Missing ?q" });

  const query = q.trim();
  const words = query.toLowerCase().split(/\s+/);

  const key = createHash("md5").update(query).digest("hex");
  const cached = getCache(key);

  if (cached) return res.json({ cached: true, ...cached });

  // STEP 1 — Detect category
  const detected = category || (await detectCategory(query));

  // STEP 2 — Select only 12 fast sites
  let sources = NEWS_SITES.slice(0, 12);

  if (detected !== "general") {
    sources = sources.filter(
      (s) => s.category === detected || s.category === "general"
    );
  }

  // STEP 3 — Scrape all sites in parallel FAST
  const scraped = await Promise.all(
    sources.map((s) => scrapeSite(s, query, words))
  );

  const results = dedupe(scraped.flat()).sort((a, b) => b.score - a.score);
  const top = results.slice(0, limit);

  // STEP 4 — AI selects best URLs
  const ai = await analyzeWithPollinations(query, top);
  const bestUrls = ai?.bestUrls || top.slice(0, 4).map((r) => r.url);

  // STEP 5 — Fetch full article text PARALLEL (Massive speed)
  const bestArticles = await Promise.all(bestUrls.map((u) => fetchFullArticle(u)));

  const output = {
    success: true,
    query,
    detectedCategory: detected,
    totalResults: results.length,
    results: top,
    bestUrls,
    bestArticles,
    aiReasoning: ai?.reasoning || null,
    timeMs: Date.now() - (req.startTime || Date.now())
  };

  setCache(key, output);
  res.json(output);
}

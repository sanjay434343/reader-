import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";
import NEWS_SITES from "./news_urls.js";

// ========================================================
// FASTER AXIOS INSTANCE
// ========================================================
const http = axios.create({
  timeout: 5000,
  headers: { "User-Agent": "Mozilla/5.0" }
});

// ========================================================
// CACHE
// ========================================================
const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function getCache(k) {
  const c = CACHE.get(k);
  if (!c) return null;
  if (Date.now() - c.time > c.ttl) {
    CACHE.delete(k);
    return null;
  }
  return c.data;
}
function setCache(k, d) {
  CACHE.set(k, { data: d, ttl: CACHE_TTL, time: Date.now() });
}

// ========================================================
// CATEGORY DETECT
// ========================================================
async function detectCategory(query) {
  try {
    const prompt = encodeURIComponent(
      `Category for "${query}". Return ONE WORD: general, technology, business, sports, science, entertainment, health, politics`
    );
    const r = await http.get(`https://text.pollinations.ai/${prompt}`);
    const c = r.data.trim().toLowerCase();
    const ok = ["general","technology","business","sports","science","entertainment","health","politics"];
    return ok.includes(c) ? c : "general";
  } catch { return "general"; }
}

// ========================================================
// POLLINATIONS — BEST URL PICKER
// ========================================================
async function analyzeWithPollinations(query, results) {
  try {
    const reduced = results.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.title}\nURL: ${r.url}`
    ).join("\n\n");

    const prompt = encodeURIComponent(`
Pick the most relevant URLs for "${query}" from below:

${reduced}

Return ONLY JSON:
{"bestUrls":["...","..."],"reasoning":"..."}
    `);

    const r = await http.get(`https://text.pollinations.ai/${prompt}`, { timeout: 8000 });
    const match = r.data.trim().match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// ========================================================
// SCRAPER (FAST MODE)
// ========================================================
async function scrapeSite(site, query, words) {
  try {
    const searchUrl = site.url(query);
    const r = await http.get(searchUrl);
    const $ = cheerio.load(r.data);
    const out = [];

    $("a").slice(0, 80).each((i, el) => {
      let href = $(el).attr("href");
      let title = $(el).text().trim();
      if (!href || !title || title.length < 6) return;

      if (!href.startsWith("http")) {
        try { href = new URL(href, searchUrl).href; }
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
function dedupe(list) {
  const map = new Map();
  for (const item of list) {
    const key = item.url.toLowerCase();
    if (!map.has(key) || map.get(key).score < item.score) {
      map.set(key, item);
    }
  }
  return [...map.values()];
}

// ========================================================
// FULL ARTICLE SCRAPER
// ========================================================
async function fetchFullArticle(url) {
  try {
    const encoded = encodeURIComponent(url);
    const apiUrl = `https://reader-zeta-three.vercel.app/api/scrape?url=${encoded}`;
    const r = await http.get(apiUrl, { timeout: 15000 });

    if (!r.data?.success)
      return { url, error: "No content" };

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
// NEW — UNIFIED SUMMARY VIA POLLINATIONS
// ========================================================
async function generateUnifiedSummary(bestArticles) {
  try {
    const text = bestArticles
      .map(a => `TITLE: ${a.title}\nSUMMARY: ${a.summary}\nCONTENT: ${a.fullText}`)
      .join("\n\n----------------------\n\n");

    const prompt = encodeURIComponent(`
Create one combined summary from ALL these articles.

Write in **10 simple English points** (1 to 10).
Each point must be short, clear, and easy to learn.
Focus on the key facts and learning points.

CONTENT:
${text}

Return ONLY plain text, no JSON.
    `);

    const r = await http.get(`https://text.pollinations.ai/${prompt}`, {
      timeout: 15000
    });

    return r.data.trim();
  } catch {
    return "Summary generation failed.";
  }
}

// ========================================================
// MAIN HANDLER
// ========================================================
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { q, limit = 20, category, region } = req.query;
  if (!q) return res.status(400).json({ error: "Missing ?q" });

  const query = q.trim();
  const words = query.toLowerCase().split(/\s+/);

  const ck = createHash("md5").update(query).digest("hex");
  const cached = getCache(ck);
  if (cached) return res.json({ cached: true, ...cached });

  // Detect category
  const detected = category || (await detectCategory(query));

  // Pick first 12 fast sites
  let sources = NEWS_SITES.slice(0, 12);
  if (detected !== "general")
    sources = sources.filter(s => s.category === detected || s.category === "general");

  // Scrape fast
  const scraped = await Promise.all(sources.map(s => scrapeSite(s, query, words)));
  const results = dedupe(scraped.flat()).sort((a, b) => b.score - a.score);
  const top = results.slice(0, limit);

  // AI picks best URLs
  const ai = await analyzeWithPollinations(query, top);
  const bestUrls = ai?.bestUrls || top.slice(0, 4).map(r => r.url);

  // Fetch full articles
  const bestArticles = await Promise.all(bestUrls.map(fetchFullArticle));

  // NEW — Generate final unified summary
  const finalSummary = await generateUnifiedSummary(bestArticles);

  const output = {
    success: true,
    query,
    detectedCategory: detected,
    totalResults: results.length,
    results: top,
    bestUrls,
    bestArticles,
    unifiedSummary: finalSummary,
    aiReasoning: ai?.reasoning || null
  };

  setCache(ck, output);
  res.json(output);
}

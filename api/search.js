import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";
import NEWS_SITES from "./news_urls.js";

// ========================================================
// FAST AXIOS
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

function getCache(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > entry.ttl) {
    CACHE.delete(key);
    return null;
  }
  return entry.data;
}
function setCache(key, data) {
  CACHE.set(key, { data, time: Date.now(), ttl: CACHE_TTL });
}

// ========================================================
// DELAY HELPER (2 seconds)
// ========================================================
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ========================================================
// CATEGORY DETECTION
// ========================================================
async function detectCategory(query) {
  try {
    const prompt = encodeURIComponent(
      `Category for "${query}". Reply ONE WORD: general, business, technology, sports, entertainment, health, politics`
    );
    const r = await http.get(`https://text.pollinations.ai/${prompt}`);
    return r.data.trim().toLowerCase();
  } catch {
    return "general";
  }
}

// ========================================================
// POLLINATIONS BEST URL PICK
// ========================================================
async function analyzeWithPollinations(query, items) {
  try {
    const reduced = items.slice(0, 10).map((r, i) =>
      `${i + 1}. ${r.title}\nURL: ${r.url}`
    ).join("\n\n");

    const prompt = encodeURIComponent(`
Pick best URLs for query "${query}".

${reduced}

Return JSON ONLY:
{"bestUrls":["...","..."],"reasoning":"..."}
    `);

    const r = await http.get(`https://text.pollinations.ai/${prompt}`);
    const match = r.data.trim().match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// ========================================================
// SCRAPER – FAST VERSION
// ========================================================
async function scrapeSite(site, query, words) {
  try {
    const url = site.url(query);
    const r = await http.get(url);
    const $ = cheerio.load(r.data);

    const out = [];

    $("a").slice(0, 80).each((i, el) => {
      let href = $(el).attr("href");
      const title = $(el).text().trim();
      if (!href || !title || title.length < 6) return;

      if (!href.startsWith("http")) {
        try { href = new URL(href, url).href; } catch { return; }
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
  for (const r of list) {
    const key = r.url.toLowerCase();
    if (!map.has(key) || map.get(key).score < r.score) {
      map.set(key, r);
    }
  }
  return [...map.values()];
}

// ========================================================
// ARTICLE SCRAPER
// ========================================================
async function fetchFullArticle(url) {
  try {
    const api = `https://reader-zeta-three.vercel.app/api/scrape?url=${encodeURIComponent(url)}`;
    const r = await http.get(api, { timeout: 15000 });

    if (!r.data?.success) return { url, error: "No article" };

    return {
      url,
      title: r.data.metadata?.title || "",
      summary: r.data.contentParts?.[0]?.summary || "",
      fullText: r.data.fullText?.slice(0, 1500) || "" // limit length
    };
  } catch {
    return { url, error: "Failed" };
  }
}

// ========================================================
// NEW — MAKE POINTS PER ARTICLE (Pollinations)
// ========================================================
async function summarizeArticle(article) {
  try {
    const prompt = encodeURIComponent(`
Make 2–3 simple English key points from this article:

TITLE: ${article.title}
SUMMARY: ${article.summary}
CONTENT: ${article.fullText}

Return only plain text points.
    `);

    const r = await http.get(`https://text.pollinations.ai/${prompt}`, {
      timeout: 12000
    });

    return r.data.trim();
  } catch {
    return "";
  }
}

// ========================================================
// NEW — Final Combine 1–10 Summary
// ========================================================
async function makeFinalSummary(allPoints) {
  try {
    const prompt = encodeURIComponent(`
Combine these points into a simple 1–10 summary in basic English:

${allPoints.join("\n")}

Return only 10 bullet points.
    `);

    const r = await http.get(`https://text.pollinations.ai/${prompt}`, {
      timeout: 12000
    });

    return r.data.trim();
  } catch {
    return "Summary unavailable.";
  }
}

// ========================================================
// MAIN HANDLER
// ========================================================
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { q, limit = 20 } = req.query;
  if (!q) return res.status(400).json({ error: "Missing ?q" });

  const query = q.trim();
  const words = query.toLowerCase().split(/\s+/);

  // CACHE CHECK
  const hash = createHash("md5").update(query).digest("hex");
  const cached = getCache(hash);
  if (cached) return res.json({ cached: true, ...cached });

  // CATEGORY
  const detected = await detectCategory(query);

  // SCRAPE NEWS
  const scraped = await Promise.all(
    NEWS_SITES.slice(0, 12).map(s => scrapeSite(s, query, words))
  );

  const results = dedupe(scraped.flat()).sort((a, b) => b.score - a.score);
  const top = results.slice(0, limit);

  // AI choose best URLs
  const ai = await analyzeWithPollinations(query, top);
  const bestUrls = ai?.bestUrls || top.slice(0, 4).map(r => r.url);

  // Fetch full articles
  const bestArticles = await Promise.all(bestUrls.map(fetchFullArticle));

  // ================================================================
  // NEW — GENERATE POINTS FOR EACH ARTICLE WITH 2 SEC DELAY
  // ================================================================
  const allPoints = [];

  for (const article of bestArticles) {
    const p = await summarizeArticle(article);
    allPoints.push(p);

    await wait(2000); // 2 sec delay
  }

  // FINAL 1–10 SUMMARY
  const unifiedSummary = await makeFinalSummary(allPoints);

  const output = {
    success: true,
    query,
    detectedCategory: detected,
    results: top,
    bestUrls,
    bestArticles,
    unifiedSummary
  };

  setCache(hash, output);
  res.json(output);
}

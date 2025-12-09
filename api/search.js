// api/search.js
import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";
import NEWS_SITES from "./news_urls.js"; // must export array of { name, category, region, url: (q)=>string }

const http = axios.create({
  timeout: 7000,
  headers: { "User-Agent": "Mozilla/5.0" },
});

// Serverless in-memory cache (resets on cold start)
const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
function getCache(key) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.time > e.ttl) {
    CACHE.delete(key);
    return null;
  }
  return e.data;
}
function setCache(key, data) {
  CACHE.set(key, { data, time: Date.now(), ttl: CACHE_TTL });
}

// Utility sleep (ms)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Config
const CHUNK_SIZE = 1200; // characters per chunk when sending to Pollinations
const POLLINATIONS_BASE = "https://text.pollinations.ai/"; // GET based "prompt" endpoint
const READER_API_BASE = "https://reader-zeta-three.vercel.app/api/scrape?url=";
const MIN_SCORE_THRESHOLD = 8; // moderate filtering (title/desc/url must match at least some query keywords)

// --- helpers ---
function mkHash(s) {
  return createHash("md5").update(s).digest("hex");
}

function tokenizeQuery(query) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[^a-z0-9]/g, ""));
}

// score function for quick filter
function quickScore(obj, words) {
  // obj: { title, description, url }
  const sText = `${obj.title || ""} ${obj.description || ""} ${obj.url || ""}`.toLowerCase();
  let score = 0;
  words.forEach((w) => {
    if (!w) return;
    if (sText.includes(w)) score += w.length > 2 ? 10 : 3; // longer words more weight
  });
  return score;
}

// dedupe by URL keeping highest score
function dedupe(list) {
  const map = new Map();
  for (const r of list) {
    const key = (r.url || "").toLowerCase();
    if (!key) continue;
    if (!map.has(key) || (r.score || 0) > (map.get(key).score || 0)) {
      map.set(key, r);
    }
  }
  return [...map.values()];
}

// split text into chunks (preserve words boundaries)
function splitIntoChunks(text, maxLen = CHUNK_SIZE) {
  if (!text) return [];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxLen);
    // try to break at last whitespace if possible
    if (end < text.length) {
      const idx = text.lastIndexOf(" ", end);
      if (idx > start) end = idx;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks.filter(Boolean);
}

// call Pollinations with a simple prompt (returns parsed JSON or text)
async function callPollinationsWithJSONPrompt(promptText, timeout = 12000) {
  try {
    const enc = encodeURIComponent(promptText);
    const r = await http.get(`${POLLINATIONS_BASE}${enc}`, { timeout });
    const text = (r.data || "").toString().trim();

    // If response contains JSON object, extract it
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        // fallthrough - if JSON parse fails, return raw text
      }
    }
    return { text };
  } catch (err) {
    return null;
  }
}

// ask Pollinations to choose best URLs from a short list (fast)
async function analyzeWithPollinations(query, candidates) {
  if (!candidates || candidates.length === 0) return null;
  const payload = candidates
    .slice(0, 10)
    .map((c, i) => `${i + 1}. ${c.title}\nURL: ${c.url}`)
    .join("\n\n");

  const prompt = `
Analyze these results for the query: "${query}"

${payload}

Return JSON ONLY in this format:
{
  "bestUrls": ["<url1>","<url2>","..."],
  "reasoning": "<short explanation - 1 sentence>"
}
  `.trim();

  const out = await callPollinationsWithJSONPrompt(prompt, 10000);
  return out;
}

// fetch full article via reader API
async function fetchFullArticle(url) {
  try {
    const encoded = encodeURIComponent(url);
    const endpoint = `${READER_API_BASE}${encoded}`;
    const r = await http.get(endpoint);
    if (!r.data || !r.data.success) {
      return { url, error: "no_content" };
    }
    return {
      url,
      title: r.data.metadata?.title || null,
      description: r.data.metadata?.description || null,
      author: r.data.metadata?.author || null,
      siteName: r.data.metadata?.siteName || null,
      fullText: r.data.fullText || null,
      summary: r.data.contentParts?.[0]?.summary || null,
    };
  } catch (err) {
    return { url, error: "fetch_failed" };
  }
}

// summarize one article (split to chunks -> summarize each -> combine)
async function summarizeArticleChunks(article, queryWords) {
  const full = article.fullText || article.summary || "";
  if (!full) return { url: article.url, points: [], error: "no_text" };

  const chunks = splitIntoChunks(full, CHUNK_SIZE);
  const chunkSummaries = [];

  // For each chunk, call Pollinations to get 1-3 short takeaway points
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const prompt = `
You are given a chunk of a news article. The search query is: "${queryWords.join(" ")}".
Read the chunk and produce up to 3 short, clear bullet points in simple English (one sentence each) that capture the main facts or claims in this chunk.
Return JSON array ONLY: ["point 1", "point 2", ...]
Chunk:
"""${chunk.replace(/"/g, "'")}"""
    `.trim();

    const res = await callPollinationsWithJSONPrompt(prompt, 10000);
    if (!res) {
      // fallback: take first sentence(s)
      const roughly = chunk.split(/\.\s+/).slice(0, 2).map(s => s.trim()).filter(Boolean);
      chunkSummaries.push(...roughly);
    } else if (Array.isArray(res)) {
      chunkSummaries.push(...res);
    } else if (res.text) {
      // If Pollinations returned free text, split into lines
      const lines = res.text.split(/\n+/).map(l => l.replace(/^[\-\u2022\s]+/, "").trim()).filter(Boolean);
      chunkSummaries.push(...lines.slice(0,3));
    } else if (res.bestUrls && typeof res.bestUrls === "object") {
      // defensive - ignore
    } else {
      // unknown shape: attempt to extract array
      try {
        if (typeof res === "object") {
          // if object with any array-like values, flatten small arrays
          const arr = Object.values(res).find(v => Array.isArray(v));
          if (arr) chunkSummaries.push(...arr.slice(0,3));
        }
      } catch {}
    }

    // safety: keep chunkSummaries bounded
    if (chunkSummaries.length > 30) break;
  }

  // Post-process points: normalize & dedupe similar short lines
  const normalized = chunkSummaries
    .map((p) => p && p.toString().trim())
    .filter(Boolean)
    .map((p) => p.replace(/\s+/g, " ").replace(/\.$/, ""));

  const unique = [...new Set(normalized)].slice(0, 50);

  return { url: article.url, points: unique };
}

// merge multiple articles' points into final unified summary with up to N points
async function mergeArticlePointsToUnifiedSummary(allPoints, query, maxPoints = 10) {
  // allPoints: array of strings
  if (!allPoints || allPoints.length === 0) return [];

  const payload = allPoints.slice(0, 80).map((p, i) => `${i + 1}. ${p}`).join("\n");

  const prompt = `
You are an editor. The user asked: "${query}"

Here are extracted short points from multiple news articles (possibly overlapping). Combine them into a single clear list of up to ${maxPoints} numbered bullet points in simple, basic English. Prioritize factual items, chronological or causal order if applicable, and avoid repetition. Use plain sentences, one idea per point.

Input points:
${payload}

Return JSON ONLY:
{
  "summary": [
    "1. ...",
    "2. ...",
    ...
  ]
}
  `.trim();

  const res = await callPollinationsWithJSONPrompt(prompt, 12000);
  if (!res || !Array.isArray(res.summary)) {
    // fallback: naive top-N unique points
    const fallback = [...new Set(allPoints)].slice(0, maxPoints);
    return fallback.map((p, i) => `${i + 1}. ${p}`);
  }
  // ensure at most maxPoints
  return res.summary.slice(0, maxPoints);
}

// --- main handler ---
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { q, limit = 20, category, region } = req.query || {};
  if (!q) return res.status(400).json({ error: "Missing ?q query param" });

  const start = Date.now();
  const query = String(q).trim();
  const cacheKey = mkHash(query + (category || "") + (region || ""));
  const cached = getCache(cacheKey);
  if (cached) return res.json({ cached: true, ...cached });

  const queryWords = tokenizeQuery(query);
  if (queryWords.length === 0) return res.status(400).json({ error: "Empty query" });

  // Step 1: pick a shortlist of sources (limit for speed)
  let sources = NEWS_SITES.slice(0, 16); // keep to first 16 for predictable speed
  if (category && category !== "general") {
    sources = sources.filter((s) => s.category === category || s.category === "general");
  }
  if (region) {
    sources = sources.filter((s) => s.region === region || s.region === "Global");
  }
  if (sources.length === 0) sources = NEWS_SITES.slice(0, 12);

  // Step 2: scrape sites in parallel (but limited processing)
  const scrapeJobs = sources.map(async (s) => {
    try {
      const searchUrl = s.url(query);
      const r = await http.get(searchUrl).catch(() => null);
      if (!r || !r.data) return [];

      const $ = cheerio.load(r.data);
      const out = [];
      // limit anchor scanning to first N anchors to be faster
      $("a").slice(0, 80).each((i, el) => {
        let href = $(el).attr("href");
        let title = ($(el).text() || "").trim();
        if (!href || !title) return;
        if (!href.startsWith("http")) {
          try {
            href = new URL(href, searchUrl).href;
          } catch {
            return;
          }
        }
        const desc = ($(el).closest("article").find("p").first().text() || title).trim();
        out.push({
          site: s.name,
          category: s.category,
          region: s.region,
          title,
          description: desc,
          url: href,
          // compute quick score now for filtering
          score: quickScore({ title, description: desc, url: href }, queryWords),
        });
      });
      return out;
    } catch {
      return [];
    }
  });

  const scrapedArrays = await Promise.all(scrapeJobs);
  let allResults = dedupe(scrapedArrays.flat()).sort((a, b) => (b.score || 0) - (a.score || 0));

  // moderate filtering: require MIN_SCORE_THRESHOLD
  allResults = allResults.filter((r) => (r.score || 0) >= MIN_SCORE_THRESHOLD);

  // fallback: if none passed threshold, relax threshold (avoid empty)
  if (allResults.length === 0) {
    allResults = dedupe(scrapedArrays.flat()).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit);
  }

  const topResults = allResults.slice(0, Number(limit || 20));

  // Step 3: call Pollinations to pick best urls (small candidate set)
  let aiPick = null;
  try {
    aiPick = await analyzeWithPollinations(query, topResults);
  } catch {
    aiPick = null;
  }

  let bestUrls = [];
  if (aiPick && Array.isArray(aiPick.bestUrls) && aiPick.bestUrls.length > 0) {
    // keep only urls present in our topResults (prevent strange picks)
    const topSet = new Set(topResults.map((r) => r.url));
    bestUrls = aiPick.bestUrls.filter((u) => topSet.has(u));
    if (bestUrls.length === 0) {
      bestUrls = topResults.slice(0, 4).map((r) => r.url);
    }
  } else {
    bestUrls = topResults.slice(0, 4).map((r) => r.url);
  }

  // Step 4: fetch each best article (with 2s delay between each processing)
  const fetched = [];
  for (let i = 0; i < bestUrls.length; i++) {
    const url = bestUrls[i];
    const art = await fetchFullArticle(url);
    fetched.push(art);
    // wait 2 seconds between processing each (user requested)
    if (i < bestUrls.length - 1) await sleep(2000);
  }

  // Step 5: summarize articles (split -> chunk summaries)
  const allPoints = [];
  for (const art of fetched) {
    const summaryObj = await summarizeArticleChunks(art, queryWords);
    if (summaryObj && Array.isArray(summaryObj.points) && summaryObj.points.length > 0) {
      // prefer summary points, else fall back to first sentences
      allPoints.push(...summaryObj.points);
    } else if (art.summary) {
      allPoints.push(art.summary);
    } else if (art.fullText) {
      // fallback: use first 3 sentences
      const s = art.fullText.split(/\.\s+/).slice(0, 3).map(t => t.trim()).filter(Boolean);
      allPoints.push(...s);
    }
  }

  // Step 6: merge into unified summary (10 bullets - medium)
  const unified = await mergeArticlePointsToUnifiedSummary(allPoints, query, 10);

  const output = {
    success: true,
    query,
    detectedCategory: category || "general",
    totalResults: allResults.length,
    results: topResults, // lightweight search results for UI
    unifiedSummary: unified,
    timeMs: Date.now() - start,
  };

  // Cache and return (do NOT include full article content)
  setCache(cacheKey, output);
  res.json(output);
}

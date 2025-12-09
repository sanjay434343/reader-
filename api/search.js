// api/search.js
import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";

/**
 * Vercel serverless endpoint: /api/search?q=...
 *
 * Behavior:
 * - detect category via Pollinations
 * - scrape a selection of news sites (fast)
 * - create ranked results
 * - pick best urls (Pollinations + fallback)
 * - for each best url: fetch reader API -> get fullText -> chunk (~5000 chars) ->
 *   summarize each chunk via Pollinations
 * - merge chunk summaries via Pollinations to produce:
 *    - merged short summary
 *    - 10-point simple-English learning list (1..10)
 * - return minimal output:
 *    { success, query, detectedCategory, results: [{title,url}], unifiedSummary, timeMs }
 *
 * Notes:
 * - Adds a 2000ms (2 second) delay between processing each article (sequential)
 * - Keep API keys none (we call free pollinations endpoints). If you use a paid LLM,
 *   replace analyzeWithPollinations/summarizeWithPollinations/mergeSummaries with your calls.
 */

// -------------------- Config --------------------
const CHUNK_SIZE = 5000; // Option B: medium ~5000 chars
const FETCH_TIMEOUT = 12000;
const POLLINATIONS_TIMEOUT = 12000;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const MAX_SITES = 12; // limit sites for speed
const MAX_RESULTS = 20;

// -------------------- Simple in-memory cache --------------------
const CACHE = new Map();
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
  CACHE.set(key, { data, time: Date.now(), ttl });
}

// -------------------- Axios instances --------------------
const http = axios.create({
  timeout: FETCH_TIMEOUT,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; SearchBot/1.0)" }
});

const pollinationsHttp = axios.create({
  timeout: POLLINATIONS_TIMEOUT,
  headers: { "User-Agent": "PollinationsClient/1.0" }
});

// -------------------- NEWS SITES (trimmed large list; you can expand) --------------------
const NEWS_SITES = [
  // India general (selection)
  { name: "Indian Express", url: q => `https://indianexpress.com/?s=${encodeURIComponent(q)}`, category: "general", region: "India" },
  { name: "Times of India", url: q => `https://timesofindia.indiatimes.com/topic/${encodeURIComponent(q)}`, category: "general", region: "India" },
  { name: "The Hindu", url: q => `https://www.thehindu.com/search/?q=${encodeURIComponent(q)}`, category: "general", region: "India" },
  { name: "News Minute", url: q => `https://www.thenewsminute.com/search?q=${encodeURIComponent(q)}`, category: "general", region: "India" },
  { name: "Scroll.in", url: q => `https://scroll.in/search?q=${encodeURIComponent(q)}`, category: "general", region: "India" },
  { name: "Deccan Herald", url: q => `https://www.deccanherald.com/search?q=${encodeURIComponent(q)}`, category: "general", region: "India" },

  // Technology
  { name: "Android Authority", url: q => `https://www.androidauthority.com/?s=${encodeURIComponent(q)}`, category: "technology", region: "Global" },
  { name: "Android Police", url: q => `https://www.androidpolice.com/?s=${encodeURIComponent(q)}`, category: "technology", region: "Global" },
  { name: "The Verge", url: q => `https://www.theverge.com/search?q=${encodeURIComponent(q)}`, category: "technology", region: "Global" },
  { name: "Gadgets 360", url: q => `https://gadgets.ndtv.com/search?searchtext=${encodeURIComponent(q)}`, category: "technology", region: "India" },

  // International general
  { name: "Reuters", url: q => `https://www.reuters.com/site-search/?query=${encodeURIComponent(q)}`, category: "general", region: "Global" },
  { name: "BBC", url: q => `https://www.bbc.co.uk/search?q=${encodeURIComponent(q)}`, category: "general", region: "UK" },
];

// -------------------- Utilities --------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hashKey(s) {
  return createHash("md5").update(s).digest("hex");
}

function isLikelyValidUrl(u) {
  if (!u) return false;
  const lower = u.toLowerCase();
  const blacklist = ["facebook", "twitter", "instagram", "pinterest", "x.com", "mailto:"];
  return !blacklist.some(b => lower.includes(b));
}

// simple score engine
function computeScore(title = "", desc = "", url = "", words = []) {
  const text = `${title} ${desc} ${url}`.toLowerCase();
  let s = 0;
  for (const w of words) {
    if (!w) continue;
    if (title.toLowerCase().includes(w)) s += 10;
    if (desc.toLowerCase().includes(w)) s += 5;
    if (url.toLowerCase().includes(w)) s += 3;
  }
  if (/\b(202\d|today|hours ago|minutes ago)\b/.test(text)) s += 6;
  return s;
}

// chunk long text into ~CHUNK_SIZE character pieces
function chunkText(text, chunkSize = CHUNK_SIZE) {
  if (!text) return [];
  const normalized = text.replace(/\s+/g, " ").trim();
  const chunks = [];
  let i = 0;
  while (i < normalized.length) {
    const slice = normalized.slice(i, i + chunkSize);
    // attempt to not cut mid-sentence: extend to next sentence end (.) up to +200 chars
    let end = slice.length;
    const remainder = normalized.slice(i + slice.length, i + slice.length + 200);
    const dotIdx = remainder.indexOf(".");
    if (dotIdx !== -1) end = slice.length + dotIdx + 1;
    chunks.push(normalized.slice(i, i + end).trim());
    i = i + end;
  }
  return chunks;
}

// -------------------- Pollinations helpers --------------------
// Pollinations endpoints are free text-get endpoints; we send prompts encoded in the URL.
// Each function expects JSON fallback when parsing responses.

async function detectCategoryPollinations(query) {
  try {
    const prompt = encodeURIComponent(`Return ONE WORD category for query: "${query}". Choose from: general, technology, business, sports, science, entertainment, health, politics.`);
    const resp = await pollinationsHttp.get(`https://text.pollinations.ai/${prompt}`);
    const v = String(resp.data || "").trim().toLowerCase();
    const valid = ["general","technology","business","sports","science","entertainment","health","politics"];
    return valid.includes(v) ? v : "general";
  } catch (e) {
    return "general";
  }
}

async function analyzeWithPollinations(query, items /* [{title,url}] */) {
  try {
    const reduced = items.slice(0, 10).map((r, i) => `${i+1}. ${r.title}\nURL: ${r.url}`).join("\n\n");
    const prompt = encodeURIComponent(`
Analyze the following search results for the query: "${query}"

${reduced}

Return JSON ONLY:
{
  "bestUrls": ["...","..."],
  "reasoning": "short explanation"
}
`);
    const r = await pollinationsHttp.get(`https://text.pollinations.ai/${prompt}`);
    const text = String(r.data || "");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (e) {
    return null;
  }
}

async function summarizeWithPollinations(instruction, text) {
  // instruction: brief instruction e.g., "Summarize this chunk in 2-3 sentences."
  try {
    // limit chunk length in prompt to avoid huge URL; we pass only first ~8000 chars
    const snippet = String(text).slice(0, 14000);
    const prompt = encodeURIComponent(`
${instruction}

Text:
${snippet}

Return JSON ONLY:
{"summary":"..."}
`);
    const r = await pollinationsHttp.get(`https://text.pollinations.ai/${prompt}`);
    const t = String(r.data || "");
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return parsed.summary || null;
  } catch {
    return null;
  }
}

async function mergeSummariesPollinations(query, chunkSummaries) {
  try {
    const joined = chunkSummaries.map((s,i)=>`${i+1}. ${s}`).join("\n\n");
    const prompt = encodeURIComponent(`
You are given multiple short summaries (numbered) for articles related to: "${query}".

1) Produce a concise merged summary (max 3 short paragraphs).
2) Produce a 10-point list (1 to 10) in simple English of the most important learning points or facts derived from the merged summary. Each point should be one short sentence.

Return JSON ONLY:
{
  "mergedSummary": "...",
  "tenPoints": ["p1","p2", "...", "p10"]
}
    
Summaries:
${joined}
`);
    const r = await pollinationsHttp.get(`https://text.pollinations.ai/${prompt}`, { timeout: POLLINATIONS_TIMEOUT });
    const t = String(r.data || "");
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

// -------------------- Scraper --------------------
async function scrapeSiteForLinks(site, query, words) {
  try {
    const searchUrl = site.url(query);
    const resp = await http.get(searchUrl).catch(() => ({ data: "" }));
    const $ = cheerio.load(resp.data || "");
    const out = [];

    // iterate anchors — limited slice for speed
    $("a").slice(0, 120).each((i, el) => {
      let href = $(el).attr("href");
      let title = $(el).text().trim();

      if (!href || !title || title.length < 6) return;

      if (!href.startsWith("http")) {
        try { href = new URL(href, searchUrl).href; } catch { return; }
      }

      if (!isLikelyValidUrl(href)) return;

      const desc = $(el).closest("article").find("p").first().text().trim() || title;

      const score = computeScore(title, desc, href, words);

      out.push({
        site: site.name,
        category: site.category,
        region: site.region,
        title,
        description: desc,
        url: href,
        score
      });
    });

    return out;
  } catch (e) {
    return [];
  }
}

// -------------------- Reader fetch --------------------
async function fetchArticleViaReader(url) {
  try {
    const encoded = encodeURIComponent(url);
    const endpoint = `https://reader-zeta-three.vercel.app/api/scrape?url=${encoded}`;
    const r = await http.get(endpoint);
    if (!r.data || !r.data.success) {
      return { url, error: "reader-failed" };
    }
    return {
      url,
      title: r.data.metadata?.title || null,
      siteName: r.data.metadata?.siteName || null,
      author: r.data.metadata?.author || null,
      fullText: r.data.fullText || null,
      contentParts: r.data.contentParts || null,
      images: r.data.images || null
    };
  } catch (err) {
    return { url, error: "fetch-failed" };
  }
}

// -------------------- Dedupe --------------------
function dedupe(items) {
  const m = new Map();
  for (const it of items) {
    const k = (it.url || "").toLowerCase();
    if (!k) continue;
    if (!m.has(k) || (m.get(k).score || 0) < (it.score || 0)) {
      m.set(k, it);
    }
  }
  return Array.from(m.values());
}

// -------------------- Main handler --------------------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const startTime = Date.now();
  const q = (req.query.q || req.query.q || "").toString().trim();
  const limit = Math.min(Number(req.query.limit || MAX_RESULTS), MAX_RESULTS);

  if (!q) return res.status(400).json({ error: "Missing ?q query param" });

  const cacheKey = hashKey(q);
  const cached = getCache(cacheKey);
  if (cached) return res.json({ cached: true, ...cached });

  // detect category
  const detectedCategory = (req.query.category) ? req.query.category : await detectCategoryPollinations(q);

  // choose sources: slice for speed
  let sources = NEWS_SITES.slice(0, MAX_SITES);
  if (detectedCategory && detectedCategory !== "general") {
    sources = sources.filter(s => s.category === detectedCategory || s.category === "general");
  }

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);

  // scrape in parallel
  const scrapePromises = sources.map(s => scrapeSiteForLinks(s, q, words));
  const scrapedArrays = await Promise.all(scrapePromises);
  const flat = scrapedArrays.flat();
  const deduped = dedupe(flat).sort((a,b) => (b.score||0) - (a.score||0));
  const topResults = deduped.slice(0, Math.max(limit, 20)); // keep at least 20 for AI selection

  // Prepare lightweight results for UI (title + url)
  const uiResults = topResults.map(r => ({ title: r.title, url: r.url }));

  // Ask Pollinations to pick best URLs (fast)
  let bestUrls = [];
  try {
    const aiPick = await analyzeWithPollinations(q, uiResults);
    if (aiPick && Array.isArray(aiPick.bestUrls) && aiPick.bestUrls.length) {
      // keep only URLs that appear in our detected list (safety)
      const setAvailable = new Set(uiResults.map(r => r.url));
      bestUrls = aiPick.bestUrls.filter(u => setAvailable.has(u)).slice(0, 6);
    }
  } catch {}
  // fallback: top 4 direct
  if (!bestUrls || bestUrls.length === 0) {
    bestUrls = uiResults.slice(0, 4).map(r => r.url);
  }

  // Process each best URL sequentially with 2s delay between each processing
  const processedArticles = [];
  for (let i = 0; i < bestUrls.length; i++) {
    const url = bestUrls[i];
    // fetch via reader
    const article = await fetchArticleViaReader(url);
    if (article && article.fullText) {
      // chunk
      const chunks = chunkText(article.fullText, CHUNK_SIZE);
      // summarize each chunk sequentially (we keep sequential to avoid pollinations rate issues)
      const chunkSummaries = [];
      for (let j = 0; j < chunks.length; j++) {
        const chunk = chunks[j];
        // instruction: short summary for each chunk
        const instruction = "Summarize the following article chunk in 2-3 short sentences, focusing on the key facts.";
        const s = await summarizeWithPollinations(instruction, chunk);
        chunkSummaries.push(s || (chunk.slice(0, 200) + (chunk.length>200 ? "..." : "")));
        // small delay between chunk summaries to be polite (250ms)
        await sleep(250);
      }
      processedArticles.push({
        url: article.url,
        title: article.title,
        siteName: article.siteName,
        author: article.author,
        chunkCount: chunks.length,
        chunkSummaries
      });
    } else {
      processedArticles.push({
        url,
        error: article?.error || "no-content"
      });
    }
    // 2 second delay between each article processing (user requested)
    if (i < bestUrls.length - 1) await sleep(2000);
  }

  // Combine all chunk summaries across articles into a single merged summary using Pollinations
  const allChunkSummaries = processedArticles.flatMap(a => a.chunkSummaries || []);
  let merged = null;
  if (allChunkSummaries.length) {
    try {
      merged = await mergeSummariesPollinations(q, allChunkSummaries);
    } catch (e) {
      merged = null;
    }
  }

  // Final unifiedSummary: prefer tenPoints array (10 point simple english). Fallback to mergedSummary or short constructed summary.
  let unifiedSummary = null;
  if (merged && merged.tenPoints && Array.isArray(merged.tenPoints) && merged.tenPoints.length >= 1) {
    unifiedSummary = {
      mergedSummary: merged.mergedSummary || null,
      tenPoints: merged.tenPoints.slice(0, 10)
    };
  } else if (merged && merged.mergedSummary) {
    // try to produce 10 short points by splitting sentences (fallback)
    const sentences = (merged.mergedSummary || "").split(/(?<=[.!?])\s+/).filter(Boolean);
    const ten = [];
    for (let i=0;i<10;i++) {
      ten.push(sentences[i] ? sentences[i].replace(/\s+/g," ").trim() : "");
    }
    unifiedSummary = {
      mergedSummary: merged.mergedSummary,
      tenPoints: ten
    };
  } else {
    // last-resort fallback: synthesize simple list from available chunk summaries (first 10)
    const shortPoints = allChunkSummaries.slice(0, 10).map((s, idx) => {
      const one = (""+s).replace(/\s+/g," ").trim();
      const sent = one.split(/(?<=[.!?])\s+/)[0] || one.slice(0,100);
      return `${idx+1}. ${sent}`;
    });
    unifiedSummary = {
      mergedSummary: (allChunkSummaries.slice(0,3).join("\n\n")) || "No merged summary available.",
      tenPoints: shortPoints.length ? shortPoints : ["No key points available."]
    };
  }

  // Build minimal UI response per Option 3
  const response = {
    success: true,
    query: q,
    detectedCategory,
    results: uiResults.slice(0, limit).map(r => ({ title: r.title, url: r.url })),
    unifiedSummary, // { mergedSummary, tenPoints: [...] }
    timeMs: Date.now() - startTime
  };

  // cache and return
  setCache(cacheKey, response);
  return res.json(response);
}

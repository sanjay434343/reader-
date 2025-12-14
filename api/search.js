// api/search.js
import Parser from "rss-parser";
import axios from "axios";
import { createHash } from "crypto";

const parser = new Parser();
const POLLINATIONS_TIMEOUT = 15000;
const CACHE_TTL = 10 * 60 * 1000;
const MAX_RESULTS = 20;
const N_FULL = 2;

/* ================= CACHE ================= */
const CACHE = new Map();
const getCache = k => {
  const v = CACHE.get(k);
  if (!v) return null;
  if (Date.now() - v.time > v.ttl) {
    CACHE.delete(k);
    return null;
  }
  return v.data;
};
const setCache = (k, d, ttl = CACHE_TTL) =>
  CACHE.set(k, { data: d, time: Date.now(), ttl });

const hashKey = s => createHash("md5").update(s).digest("hex");

/* ================= POLLINATIONS ================= */
const pollinations = axios.create({
  timeout: POLLINATIONS_TIMEOUT
});

async function summarizeWithPollinations(text) {
  const prompt = encodeURIComponent(`
Summarize the following news content into 2 short factual sentences.

Text:
${text}

Return JSON ONLY:
{"summary":"..."}
`);
  const r = await pollinations.get(`https://text.pollinations.ai/${prompt}`);
  const m = String(r.data || "").match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]).summary : null;
}

async function mergeSummaries(query, summaries) {
  const joined = summaries.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const prompt = encodeURIComponent(`
Merge the following summaries about "${query}".

Return JSON ONLY:
{
  "mergedSummary": "...",
  "points": ["p1","p2","p3","p4","p5"]
}

Summaries:
${joined}
`);
  const r = await pollinations.get(`https://text.pollinations.ai/${prompt}`);
  const m = String(r.data || "").match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

/* ================= MAIN HANDLER ================= */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const start = Date.now();
  const q = String(req.query.q || "").trim();
  const limit = Math.min(Number(req.query.limit || MAX_RESULTS), MAX_RESULTS);

  if (!q) return res.status(400).json({ error: "Missing ?q parameter" });

  const cacheKey = hashKey(`rss|${q}|${limit}`);
  const cached = getCache(cacheKey);
  if (cached) return res.json({ cached: true, ...cached });

  /* ================= FETCH RSS ================= */
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(
    q
  )}&hl=en-IN&gl=IN&ceid=IN:en`;

  const feed = await parser.parseURL(rssUrl);

  const results = feed.items.slice(0, limit).map(item => ({
    title: item.title,
    url: item.link,
    publishedAt: item.pubDate,
    source: item.source?.title || "Google News",
    description: item.contentSnippet || ""
  }));

  /* ================= SUMMARIZE TOP ARTICLES ================= */
  const summaries = [];
  for (let i = 0; i < Math.min(N_FULL, results.length); i++) {
    const r = results[i];
    const text = `${r.title}. ${r.description}`;
    const s = await summarizeWithPollinations(text);
    if (s) summaries.push(s);
  }

  const merged = summaries.length
    ? await mergeSummaries(q, summaries)
    : null;

  const response = {
    success: true,
    query: q,
    detectedCategory: "general",
    results: results.map(r => ({ title: r.title, url: r.url })),
    unifiedSummary: {
      mergedSummary: merged?.mergedSummary || null,
      points: merged?.points || []
    },
    timeMs: Date.now() - start
  };

  setCache(cacheKey, response);
  res.json(response);
}

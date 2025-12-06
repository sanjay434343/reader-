import axios from "axios";
import * as cheerio from "cheerio";

// -------------------------------------
// GLOBAL IN-MEMORY CACHE (serverless safe for warm starts)
// -------------------------------------
let CACHE = {};  
const DEFAULT_TTL = 600; // 10 minutes

function getCache(key) {
  const entry = CACHE[key];
  if (!entry) return null;

  const expired = (Date.now() - entry.timestamp) > entry.ttl;
  if (expired) {
    delete CACHE[key];
    return null;
  }
  return entry.data;
}

function setCache(key, data, ttl = DEFAULT_TTL) {
  CACHE[key] = {
    data,
    ttl,
    timestamp: Date.now()
  };
}

// -------------------------------------

export default async function handler(req, res) {
  try {
    const { url, ttl } = req.query;
    const cacheTTL = ttl ? parseInt(ttl) * 1000 : DEFAULT_TTL * 1000;

    if (!url) {
      return res.status(400).json({ error: "URL is required." });
    }

    // -------------------------------------
    // 1. CHECK CACHE FIRST
    // -------------------------------------
    const cacheKey = `scrape:${url}`;
    const cached = getCache(cacheKey);

    if (cached) {
      return res.status(200).json({
        success: true,
        cached: true,
        ...cached
      });
    }

    // -------------------------------------
    // 2. FETCH HTML PAGE
    // -------------------------------------
    const response = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // -------------------------------------
    // 3. EXTRACT CONTENT
    // -------------------------------------
    const fullText = $("body").text().replace(/\s+/g, " ").trim();

    const images = $("img")
      .map((i, el) => $(el).attr("src"))
      .get()
      .filter(Boolean)
      .map(src => new URL(src, url).href);

    const videos = $("video source, video, iframe")
      .map((i, el) => $(el).attr("src"))
      .get()
      .filter(Boolean)
      .map(src => new URL(src, url).href);

    const links = $("a")
      .map((i, el) => $(el).attr("href"))
      .get()
      .filter(Boolean)
      .map(href => new URL(href, url).href);

    const metaTags = {};
    $("meta").each((i, el) => {
      const name = $(el).attr("name") || $(el).attr("property");
      const content = $(el).attr("content");
      if (name && content) metaTags[name] = content;
    });

    const title = $("title").text() || "";

    const result = {
      url,
      title,
      meta: metaTags,
      content: fullText,
      images,
      videos,
      links,
      length: {
        textLength: fullText.length,
        imageCount: images.length,
        videoCount: videos.length,
        linkCount: links.length
      }
    };

    // -------------------------------------
    // 4. STORE RESULT IN CACHE
    // -------------------------------------
    setCache(cacheKey, result, cacheTTL);

    // -------------------------------------
    // 5. RETURN FRESH RESULT
    // -------------------------------------
    return res.status(200).json({
      success: true,
      cached: false,
      ...result
    });

  } catch (err) {
    res.status(500).json({
      error: "Failed to scrape page.",
      details: err.message
    });
  }
}

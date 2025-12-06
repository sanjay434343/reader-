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
// CLEAN HTML CONTENT FUNCTION
// -------------------------------------
function extractCleanContent($, url) {
  $("script, style, noscript, header, footer, nav, iframe, svg, .advertisement, .ads, .ad, .sponsored").remove();

  let content =
    $("article").text() ||
    $(".content").text() ||
    $(".main").text() ||
    $(".post").text() ||
    $(".story").text() ||
    $("body").text();

  content = content
    .replace(/\s+/g, " ")
    .replace(/function.*?\}/gs, "")
    .replace(/var .*?;/g, "")
    .trim();

  return content;
}

// -------------------------------------
// POLLINATIONS API CLEANER
// -------------------------------------
async function cleanWithPollinations(text) {
  const prompt = encodeURIComponent(
    `Clean this scraped webpage text. Remove junk ads, JS, navigation, and keep only useful readable content. Respond ONLY with clean text:\n\n${text}`
  );

  const pollUrl = `https://text.pollinations.ai/${prompt}`;

  try {
    const response = await axios.get(pollUrl, { timeout: 12000 });
    return response.data;
  } catch (err) {
    return text; // fallback if pollinations fails
  }
}

// -------------------------------------
// MAIN HANDLER
// -------------------------------------
export default async function handler(req, res) {
  try {
    const { url, ttl, clean } = req.query;
    const cacheTTL = ttl ? parseInt(ttl) * 1000 : DEFAULT_TTL * 1000;

    if (!url) {
      return res.status(400).json({ error: "URL is required." });
    }

    // -------------------------------------
    // 1. CACHE CHECK
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
    // 2. DOWNLOAD PAGE
    // -------------------------------------
    const response = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // -------------------------------------
    // 3. EXTRACT TEXT + MEDIA
    // -------------------------------------
    let content = extractCleanContent($, url);

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

    // -------------------------------------
    // 4. OPTIONAL AI CLEANING (SUPER FAST)
    // -------------------------------------
    if (clean === "true") {
      content = await cleanWithPollinations(content);
    }

    // -------------------------------------
    // 5. FINAL RESULT
    // -------------------------------------
    const result = {
      url,
      title,
      meta: metaTags,
      content,
      images,
      videos,
      links,
      length: {
        textLength: content.length,
        imageCount: images.length,
        videoCount: videos.length,
        linkCount: links.length
      }
    };

    // -------------------------------------
    // 6. SAVE TO CACHE
    // -------------------------------------
    setCache(cacheKey, result, cacheTTL);

    // -------------------------------------
    // 7. SEND RESPONSE
    // -------------------------------------
    return res.status(200).json({
      success: true,
      cached: false,
      ...result
    });

  } catch (err) {
    res.status(500).json({
      error: "Scraping failed.",
      details: err.message
    });
  }
}

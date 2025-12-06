import axios from "axios";
import * as cheerio from "cheerio";

// -----------------------------------------
// GLOBAL CACHE (serverless warm-memory safe)
// -----------------------------------------
let CACHE = {};
const DEFAULT_TTL = 600 * 1000; // 10 minutes

function getCache(key) {
  const entry = CACHE[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > entry.ttl) {
    delete CACHE[key];
    return null;
  }
  return entry.data;
}

function setCache(key, data, ttl) {
  CACHE[key] = { data, ttl, timestamp: Date.now() };
}

// -----------------------------------------

export default async function handler(req, res) {
  try {
    const { url, ttl } = req.query;
    const cacheTTL = ttl ? parseInt(ttl) * 1000 : DEFAULT_TTL;

    if (!url) return res.status(400).json({ error: "URL is required." });

    const cacheKey = `scrape:${url}`;
    const cached = getCache(cacheKey);

    if (cached) {
      return res.status(200).json({ success: true, cached: true, ...cached });
    }

    // -----------------------------
    // FETCH HTML
    // -----------------------------
    const response = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/120 Safari/537.36" }
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // -----------------------------
    // REMOVE JUNK
    // -----------------------------
    const REMOVE_SELECTORS = [
      "script", "style", "noscript", "header", "footer", "nav",
      "iframe", "form", "button", "svg", "canvas",
      ".ads", ".ad", ".advertisement", ".sponsored", ".promo",
      ".share", ".social", ".share-buttons", ".cookie", ".cookie-banner",
      ".subscription", ".newsletter", ".breadcrumb", ".popup", ".modal"
    ];

    REMOVE_SELECTORS.forEach(sel => $(sel).remove());

    // -----------------------------
    // MAIN CONTENT EXTRACTION
    // -----------------------------
    const MAIN_SELECTORS = [
      "article",
      ".article",
      ".post",
      ".main-content",
      ".story",
      ".content",
      "#content"
    ];

    let content = "";

    for (let sel of MAIN_SELECTORS) {
      if ($(sel).text().trim().length > 100) {
        content = $(sel).text();
        break;
      }
    }

    // Fallback to body content
    if (content.trim().length < 100) {
      content = $("body").text();
    }

    // Clean text
    content = content
      .replace(/\s+/g, " ")
      .replace(/function.*?\}/gs, "")
      .replace(/var .*?;/gs, "")
      .replace(/<!--.*?-->/gs, "")
      .trim();

    // -----------------------------
    //  CONTENT IMAGES ONLY
    // -----------------------------
    const VALID_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

    const BAD_PATTERNS = [
      "logo", "icon", "sprite", "placeholder", "default",
      "ads", "advert", "banner", "tracking", "analytics", "pixel"
    ];

    const IMAGE_SELECTORS = [
      "article img",
      ".article img",
      ".post img",
      ".content img",
      ".story img",
      ".main-content img",
      "img.wp-post-image",
      "img.size-large",
      "img.size-full"
    ];

    let imageList = [];

    function isValidImage(src) {
      if (!src) return false;
      const lower = src.toLowerCase();
      if (!VALID_EXT.some(ext => lower.includes(ext))) return false;
      if (BAD_PATTERNS.some(b => lower.includes(b))) return false;
      return true;
    }

    IMAGE_SELECTORS.forEach(sel => {
      $(sel).each((i, el) => {
        let src = $(el).attr("src") || $(el).attr("data-src");
        if (src && isValidImage(src)) {
          try {
            imageList.push(new URL(src, url).href);
          } catch {}
        }
      });
    });

    const images = [...new Set(imageList)];

    // -----------------------------
    // CONTENT VIDEOS ONLY
    // -----------------------------
    const VIDEO_SELECTORS = [
      "article video",
      "article iframe",
      ".post video",
      ".post iframe",
      ".content iframe",
      ".content video",
      ".story iframe"
    ];

    let videoList = [];

    VIDEO_SELECTORS.forEach(sel => {
      $(sel).each((i, el) => {
        let src = $(el).attr("src") || $(el).attr("data-src");
        if (src && src.startsWith("http")) {
          try {
            videoList.push(new URL(src, url).href);
          } catch {}
        }
      });
    });

    const videos = [...new Set(videoList)];

    // -----------------------------
    // META TAGS
    // -----------------------------
    const meta = {};
    $("meta").each((i, el) => {
      const name = $(el).attr("name") || $(el).attr("property");
      const content = $(el).attr("content");
      if (name && content) meta[name] = content;
    });

    // -----------------------------
    // CLEAN LINKS (REMOVE SOCIAL)
    // -----------------------------
    const BAD_LINKS = [
      "facebook.com", "twitter.com", "x.com", "instagram.com",
      "whatsapp.com", "share=", "intent"
    ];

    let links = $("a")
      .map((i, el) => $(el).attr("href"))
      .get()
      .filter(Boolean)
      .map(href => {
        try { return new URL(href, url).href; } catch { return null; }
      })
      .filter(Boolean)
      .filter(l => !BAD_LINKS.some(b => l.includes(b)));

    links = [...new Set(links)];

    // -----------------------------
    // RESULT JSON
    // -----------------------------
    const result = {
      url,
      title: $("title").text().trim(),
      meta,
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

    setCache(cacheKey, result, cacheTTL);

    return res.status(200).json({ success: true, cached: false, ...result });

  } catch (error) {
    return res.status(500).json({
      error: "Failed to scrape page.",
      details: error.message
    });
  }
}

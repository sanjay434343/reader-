import axios from "axios";
import * as cheerio from "cheerio";

// -------------------------------------
// GLOBAL IN-MEMORY CACHE
// -------------------------------------
let CACHE = {};
const DEFAULT_TTL = 600 * 1000; // 10 minutes in ms

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

// -------------------------------------

export default async function handler(req, res) {
  try {
    const { url, ttl } = req.query;
    const cacheTTL = ttl ? parseInt(ttl) * 1000 : DEFAULT_TTL;

    if (!url) {
      return res.status(400).json({ error: "URL is required." });
    }

    const cacheKey = `scrape:${url}`;
    const cached = getCache(cacheKey);

    if (cached) {
      return res.status(200).json({ success: true, cached: true, ...cached });
    }

    // FETCH HTML PAGE
    const response = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/120 Safari/537.36" }
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // -------------------------------------
    // REMOVE JUNK CONTENT (ads, scripts, menus)
    // -------------------------------------
    const CLEAN_SELECTORS = [
      "script", "style", "noscript", "header", "footer", "nav",
      "iframe", "svg", "form", "button",
      ".advertisement", ".ads", ".ad", ".sponsored", ".promo", 
      ".share", ".social", ".social-share", ".share-buttons",
      ".cookie", ".cookie-banner", ".newsletter", ".subscription",
      ".popup", ".modal", ".breadcrumb", ".hidden"
    ];

    CLEAN_SELECTORS.forEach(sel => $(sel).remove());

    // -------------------------------------
    //   SMART MAIN CONTENT EXTRACTION
    // -------------------------------------
    let mainSelectors = [
      "article",
      ".article",
      ".post",
      ".content",
      ".story",
      ".news-content",
      "#content",
      ".main-content"
    ];

    let content = "";

    for (let sel of mainSelectors) {
      if ($(sel).length > 0) {
        content = $(sel).text();
        break;
      }
    }

    if (!content || content.length < 50) {
      content = $("body").text();
    }

    content = content
      .replace(/\s+/g, " ")
      .replace(/function.*?\}/gs, "") // remove JS leftovers
      .replace(/var .*?;/g, "")
      .replace(/\/\*.*?\*\//gs, "")  // remove comments
      .replace(/<!--.*?-->/gs, "")
      .trim();

    // -------------------------------------
    //   EXTRACT IMAGES
    // -------------------------------------
    const images = $("img")
      .map((i, el) => $(el).attr("src"))
      .get()
      .filter(Boolean)
      .map(src => new URL(src, url).href);

    // -------------------------------------
    //   EXTRACT VIDEOS
    // -------------------------------------
    const videos = $("video source, video, iframe")
      .map((i, el) => $(el).attr("src"))
      .get()
      .filter(Boolean)
      .map(src => new URL(src, url).href);

    // -------------------------------------
    //   EXTRACT LINKS (removing share links)
    // -------------------------------------
    const BAD_LINK_PATTERNS = [
      "facebook.com", "twitter.com", "x.com",
      "instagram.com", "whatsapp.com", "share=", "intent"
    ];

    let links = $("a")
      .map((i, el) => $(el).attr("href"))
      .get()
      .filter(Boolean)
      .map(href => new URL(href, url).href)
      .filter(link => !BAD_LINK_PATTERNS.some(bad => link.includes(bad)));

    // -------------------------------------
    //   META TAGS
    // -------------------------------------
    const metaTags = {};
    $("meta").each((i, el) => {
      const name = $(el).attr("name") || $(el).attr("property");
      const value = $(el).attr("content");
      if (name && value) metaTags[name] = value;
    });

    const title = $("title").text()?.trim() || "";

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

    // Save to cache
    setCache(cacheKey, result, cacheTTL);

    return res.status(200).json({ success: true, cached: false, ...result });

  } catch (err) {
    return res.status(500).json({
      error: "Failed to scrape page.",
      details: err.message
    });
  }
}

import axios from "axios";
import * as cheerio from "cheerio";

// -----------------------------------------
// GLOBAL CACHE
// -----------------------------------------
let CACHE = {};
const DEFAULT_TTL = 600 * 1000;

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
  // Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { url, ttl } = req.query;
    const cacheTTL = ttl ? parseInt(ttl) * 1000 : DEFAULT_TTL;

    if (!url) return res.status(400).json({ error: "URL is required." });

    const cacheKey = `scrape:${url}`;
    const cached = getCache(cacheKey);
    if (cached) return res.status(200).json({ success: true, cached: true, ...cached });

    // Fetch HTML
    const response = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/120 Safari/537.36" }
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // -----------------------------------------
    // REMOVE JUNK ELEMENTS COMPLETELY
    // -----------------------------------------
    const REMOVE_SELECTORS = [
      "script","style","noscript","header","footer","nav",
      "iframe","form","button","svg","canvas",
      ".ads",".ad",".advertisement",".sponsored",".promo",
      ".share",".social",".cookie",".newsletter",
      ".popup",".modal",".breadcrumb",".banner",
      ".related","aside",".sidebar","section.widget",
      "link[rel=stylesheet]"
    ];
    REMOVE_SELECTORS.forEach(sel => $(sel).remove());

    // -----------------------------------------
    // MAIN CONTENT EXTRACTION
    // -----------------------------------------
    const MAIN_SELECTORS = [
      "article",
      ".article",
      ".post",
      ".main-content",
      ".content",
      ".story",
      "#content"
    ];

    let content = "";
    for (let sel of MAIN_SELECTORS) {
      if ($(sel).text().trim().length > 150) {
        content = $(sel).text();
        break;
      }
    }

    // fallback
    if (content.length < 150) content = $("body").text();

    // TEXT CLEANING
    content = content
      .replace(/\s+/g, " ")
      .replace(/<!--.*?-->/gs, "")
      .replace(/function.*?\}/gs, "")
      .replace(/var .*?;/gs, "")
      .replace(/ADVERTISEMENT/gi, "")
      .trim();

    // REMOVE DUPLICATE SENTENCES
    const cleanSentences = [...new Set(content.split(/[.!?]+/).map(s => s.trim()))];
    content = cleanSentences.join(". ").trim();

    // -----------------------------------------
    // IMAGE FILTERING — ONLY REAL ARTICLE IMAGES
    // -----------------------------------------
    const VALID_EXT = [".jpg",".jpeg",".png",".webp"];
    const BAD_PATTERNS = [
      "logo","icon","sprite","default","placeholder",
      "ads","advert","banner","pixel","tracking","share",
      "social","thumb","small","mini","favicon","og-image"
    ];

    const IMAGE_SELECTORS = [
      "article img",
      ".article img",
      ".post img",
      ".story img",
      ".content img",
      ".main-content img",
      "img[loading='lazy']"
    ];

    let images = [];

    function isGoodImage(src) {
      if (!src) return false;
      const lower = src.toLowerCase();
      if (!VALID_EXT.some(ext => lower.includes(ext))) return false;
      if (BAD_PATTERNS.some(bad => lower.includes(bad))) return false;
      if (lower.includes("logo")) return false;
      if (lower.includes("icon")) return false;
      if (lower.length < 15) return false;
      return true;
    }

    IMAGE_SELECTORS.forEach(sel => {
      $(sel).each((i, el) => {
        let src = $(el).attr("src") || $(el).attr("data-src") || "";
        if (isGoodImage(src)) {
          try {
            images.push(new URL(src, url).href);
          } catch {}
        }
      });
    });

    images = [...new Set(images)];

    // -----------------------------------------
    // VIDEO FILTERING
    // -----------------------------------------
    const VIDEO_SELECTORS = [
      "article iframe",
      ".post iframe",
      ".story iframe",
      ".content iframe",
      "article video",
      ".content video"
    ];

    let videos = [];

    VIDEO_SELECTORS.forEach(sel => {
      $(sel).each((i, el) => {
        let src = $(el).attr("src") || $(el).attr("data-src");
        if (src && src.startsWith("http")) {
          try {
            videos.push(new URL(src, url).href);
          } catch {}
        }
      });
    });

    videos = [...new Set(videos)];

    // -----------------------------------------
    // LINKS – Deduped & Clean
    // -----------------------------------------
    const BAD_LINKS = ["facebook.com","twitter.com","x.com","instagram.com","whatsapp.com","share="];

    let links = $("a")
      .map((i, el) => $(el).attr("href"))
      .get()
      .filter(Boolean)
      .map(h => { try { return new URL(h, url).href; } catch { return null; }})
      .filter(h => h && !BAD_LINKS.some(b => h.includes(b)));

    links = [...new Set(links)];

    // -----------------------------------------
    // FINAL RESPONSE
    // -----------------------------------------
    const result = {
      url,
      title: $("title").text().trim(),
      content,
      images,
      videos,
      links,
      length: {
        text: content.length,
        images: images.length,
        videos: videos.length,
        links: links.length
      }
    };

    setCache(cacheKey, result, cacheTTL);

    return res.status(200).json({
      success: true,
      cached: false,
      ...result
    });

  } catch (err) {
    return res.status(500).json({
      error: "Scraping failed",
      details: err.message
    });
  }
}

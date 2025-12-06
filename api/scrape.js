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
// CHUNK TEXT INTO 4000 CHAR BLOCKS
// -----------------------------------------
function chunkText(text, maxSize = 4000) {
  const chunks = [];
  text = text.replace(/\s+/g, " ").trim();   // clean \n and extra spaces

  for (let i = 0; i < text.length; i += maxSize) {
    chunks.push(text.slice(i, i + maxSize));
  }
  return chunks;
}

// -----------------------------------------

export default async function handler(req, res) {
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

    // Fetch page
    const response = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/120 Safari/537.36" }
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // Remove junk
    const REMOVE_SELECTORS = [
      "script","style","noscript","header","footer","nav",
      "iframe","form","button","svg","canvas",
      ".ads",".ad",".advertisement",".sponsored",".promo",
      ".share",".social",".cookie",".newsletter",
      ".popup",".modal",".breadcrumb",".banner"
    ];
    REMOVE_SELECTORS.forEach(sel => $(sel).remove());

    // Extract main content
    const MAIN_SELECTORS = [
      "article",".article",".post",".main-content",
      ".story",".content","#content"
    ];

    let content = "";
    for (let sel of MAIN_SELECTORS) {
      if ($(sel).text().trim().length > 120) {
        content = $(sel).text();
        break;
      }
    }
    if (content.length < 120) content = $("body").text();

    // CLEAN text
    content = content
      .replace(/\s+/g, " ")
      .replace(/<!--.*?-->/gs, "")
      .replace(/function.*?\}/gs, "")
      .replace(/var .*?;/gs, "")
      .trim();

    // REMOVE noise phrases
    const REMOVE_PHRASES = [
      "ADVERTISEMENT","ADVERTISEMENT CONTINUE READING",
      "30 SEC READ","READ |","CLICK HERE","SUBSCRIBE NOW",
      "SCROLL TO CONTINUE","TRENDING","LIVE UPDATES",
      "Premium Story","You May Like"
    ];
    REMOVE_PHRASES.forEach(p => {
      const regex = new RegExp(p, "gi");
      content = content.replace(regex, "");
    });

    // REMOVE DUPLICATE SENTENCES
    let sentences = content.split(/[.!?]+/).map(s => s.trim());
    let uniqueSentences = [...new Set(sentences)];
    content = uniqueSentences.join(". ").trim();

    // -----------------------------------------
    // NEW: SPLIT INTO 4000 CHAR CHUNKS
    // -----------------------------------------
    const chunks = chunkText(content, 4000);

    // -----------------------------------------
    // IMAGES
    // -----------------------------------------
    const VALID_EXT = [".jpg",".jpeg",".png",".webp",".gif"];
    const BAD_PATTERNS = ["logo","icon","sprite","default","ads","pixel","banner"];

    const IMAGE_SELECTORS = [
      "article img",".article img",".post img",".story img",
      ".content img",".main-content img","img.size-large"
    ];

    let rawImages = [];

    function isValidImage(src) {
      if (!src) return false;
      const lower = src.toLowerCase();
      if (!VALID_EXT.some(e => lower.includes(e))) return false;
      if (BAD_PATTERNS.some(b => lower.includes(b))) return false;
      return true;
    }

    IMAGE_SELECTORS.forEach(sel => {
      $(sel).each((i, el) => {
        let src = $(el).attr("src") || $(el).attr("data-src");
        if (isValidImage(src)) {
          try { rawImages.push(new URL(src, url).href); } catch {}
        }
      });
    });

    const images = [...new Set(rawImages)];

    // -----------------------------------------
    // VIDEOS
    // -----------------------------------------
    const VIDEO_SELECTORS = [
      "article iframe",".content iframe",".post iframe",".story iframe",
      ".content video","article video"
    ];

    let rawVideos = [];
    VIDEO_SELECTORS.forEach(sel => {
      $(sel).each((i, el) => {
        let src = $(el).attr("src");
        if (src && src.startsWith("http")) {
          try { rawVideos.push(new URL(src, url).href); } catch {}
        }
      });
    });

    const videos = [...new Set(rawVideos)];

    // -----------------------------------------
    // LINKS CLEANED
    // -----------------------------------------
    const BAD_LINKS = ["facebook.com","twitter.com","x.com","instagram.com","whatsapp.com","share="];

    let rawLinks = $("a").map((i, el) => $(el).attr("href")).get();

    let links = rawLinks
      .filter(h => h)
      .map(h => { try { return new URL(h, url).href; } catch { return null; }})
      .filter(h => h && !BAD_LINKS.some(b => h.includes(b)));

    links = [...new Set(links)];

    // -----------------------------------------
    // FINAL RESPONSE
    // -----------------------------------------
    const result = {
      url,
      title: $("title").text().trim(),
      chunks,        // <-- chunked text for pollinations
      content,       // cleaned full content
      images,
      videos,
      links,
      length: {
        textLength: content.length,
        chunks: chunks.length,
        images: images.length,
        videos: videos.length,
        links: links.length
      }
    };

    setCache(cacheKey, result, cacheTTL);

    return res.status(200).json({ success: true, cached: false, ...result });

  } catch (err) {
    return res.status(500).json({
      error: "Scraping failed",
      details: err.message
    });
  }
}

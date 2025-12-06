import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";

// =============================================================================
// LRU CACHE
// =============================================================================

class LRUCache {
  constructor(maxSize = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const entry = this.cache.get(key);
    
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.data;
  }

  set(key, data, ttl) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { data, ttl, timestamp: Date.now() });
  }
}

const CACHE = new LRUCache(100);
const DEFAULT_TTL = 600 * 1000;

// =============================================================================
// CONTENT HASH
// =============================================================================

function generateContentHash(text) {
  return createHash("md5").update(text).digest("hex").substring(0, 16);
}

// =============================================================================
// SMART CHUNKING: 4000 characters with sentence boundaries
// =============================================================================

function chunkText(text, maxSize = 4000) {
  const chunks = [];
  text = text.replace(/\s+/g, " ").trim();
  
  if (text.length <= maxSize) {
    return [text];
  }

  const sentences = text.split(/(?<=[.!?])\s+/);
  let currentChunk = "";
  
  for (const sentence of sentences) {
    if (sentence.length > maxSize) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }
      
      for (let i = 0; i < sentence.length; i += maxSize) {
        chunks.push(sentence.slice(i, i + maxSize));
      }
      continue;
    }
    
    if ((currentChunk + " " + sentence).length <= maxSize) {
      currentChunk += (currentChunk ? " " : "") + sentence;
    } else {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

// =============================================================================
// AGGRESSIVE CONTENT EXTRACTION: Get ALL text from page
// =============================================================================

class FullContentExtractor {
  constructor($, url) {
    this.$ = $;
    this.url = url;
  }

  extractAllContent() {
    const $ = this.$;
    
    // Remove all unwanted elements first
    const REMOVE_SELECTORS = [
      "script", "style", "noscript", "iframe", "canvas", "svg",
      "header", "footer", "nav", "aside",
      "form", "button", "input", "select", "textarea",
      ".ads", ".ad", ".advertisement", ".sponsored", ".promo",
      ".share", ".social", ".social-share", ".share-buttons",
      ".cookie", ".newsletter", ".popup", ".modal",
      ".breadcrumb", ".banner", ".sidebar", ".widget",
      ".comments", ".comment-section", ".related-posts",
      "[class*='sidebar']", "[id*='sidebar']",
      "[class*='footer']", "[id*='footer']",
      "[class*='header']", "[id*='header']",
      "[class*='nav']", "[id*='nav']",
      "[class*='menu']", "[id*='menu']",
      "[class*='ads']", "[id*='ads']"
    ];
    
    REMOVE_SELECTORS.forEach(sel => $(sel).remove());

    // Extract ALL paragraph text
    let allParagraphs = [];
    $("p").each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 20) {  // Filter out very short paragraphs
        allParagraphs.push(text);
      }
    });

    // Extract ALL div text (fallback for non-semantic HTML)
    let allDivText = [];
    $("div").each((i, el) => {
      const $el = $(el);
      // Get direct text only (not from child elements)
      const text = $el.contents()
        .filter(function() {
          return this.type === 'text';
        })
        .text()
        .trim();
      
      if (text.length > 30) {
        allDivText.push(text);
      }
    });

    // Extract article/main content areas
    let mainContent = [];
    const MAIN_SELECTORS = [
      "article", "main", "[role='main']", 
      ".article", ".post", ".story", ".content",
      ".article-body", ".post-content", ".entry-content",
      "#article", "#content", "#main-content"
    ];

    MAIN_SELECTORS.forEach(sel => {
      $(sel).each((i, el) => {
        const text = $(el).text().trim();
        if (text.length > 100) {
          mainContent.push(text);
        }
      });
    });

    // Strategy: Try different extraction methods
    let fullText = "";

    // 1. Try article/main content first (highest quality)
    if (mainContent.length > 0) {
      fullText = mainContent.join(" ");
    }
    
    // 2. If not enough, use all paragraphs
    if (fullText.length < 500 && allParagraphs.length > 0) {
      fullText = allParagraphs.join(" ");
    }

    // 3. If still not enough, combine everything
    if (fullText.length < 500) {
      fullText = [...mainContent, ...allParagraphs, ...allDivText].join(" ");
    }

    // 4. Last resort: get all body text
    if (fullText.length < 200) {
      fullText = $("body").text();
    }

    return fullText;
  }

  extractMetadata() {
    const $ = this.$;
    
    return {
      title: $('meta[property="og:title"]').attr("content") || 
             $("title").text().trim() || 
             $("h1").first().text().trim(),
      description: $('meta[property="og:description"]').attr("content") || 
                   $('meta[name="description"]').attr("content") || "",
      author: $('meta[name="author"]').attr("content") || 
              $('[rel="author"]').text().trim() || "",
      publishDate: $('meta[property="article:published_time"]').attr("content") || 
                   $('meta[name="date"]').attr("content") || "",
      siteName: $('meta[property="og:site_name"]').attr("content") || ""
    };
  }
}

// =============================================================================
// AGGRESSIVE TEXT CLEANING PIPELINE
// =============================================================================

class AggressiveTextCleaner {
  constructor(text) {
    this.text = text;
  }

  clean() {
    return this
      .normalizeWhitespace()
      .removeComments()
      .removeScriptFragments()
      .removeAdvertisements()
      .removeBoilerplate()
      .removeSocialMedia()
      .removeNavigation()
      .removeDuplicateSentences()
      .removeExcessiveNewlines()
      .getText();
  }

  normalizeWhitespace() {
    this.text = this.text
      .replace(/\s+/g, " ")
      .replace(/\t/g, " ")
      .trim();
    return this;
  }

  removeComments() {
    this.text = this.text.replace(/<!--.*?-->/gs, "");
    return this;
  }

  removeScriptFragments() {
    const patterns = [
      /function\s*\(.*?\)\s*\{.*?\}/gs,
      /var\s+\w+\s*=.*?;/gs,
      /const\s+\w+\s*=.*?;/gs,
      /let\s+\w+\s*=.*?;/gs,
      /window\.\w+/g,
      /document\.\w+/g,
      /\{.*?:\s*function.*?\}/gs
    ];

    patterns.forEach(p => {
      this.text = this.text.replace(p, "");
    });

    return this;
  }

  removeAdvertisements() {
    const patterns = [
      /ADVERTISEMENT(\s+CONTINUE READING)?/gi,
      /\d+\s+SEC\s+READ/gi,
      /READ\s*\|/gi,
      /CLICK\s+HERE/gi,
      /SUBSCRIBE\s+NOW/gi,
      /SCROLL\s+TO\s+CONTINUE/gi,
      /TRENDING\s*:?/gi,
      /LIVE\s+UPDATES/gi,
      /Premium\s+Story/gi,
      /You\s+May\s+Like/gi,
      /RELATED\s+ARTICLES?/gi,
      /MORE\s+FROM/gi,
      /Recommended\s+for\s+you/gi,
      /Most\s+Popular/gi,
      /Editor'?s?\s+Pick/gi
    ];

    patterns.forEach(p => {
      this.text = this.text.replace(p, "");
    });

    return this;
  }

  removeBoilerplate() {
    const boilerplate = [
      /Share\s+this\s+article/gi,
      /Follow\s+us\s+on/gi,
      /Subscribe\s+to\s+our\s+newsletter/gi,
      /Sign\s+up\s+for/gi,
      /By\s+clicking/gi,
      /Terms\s+of\s+Service/gi,
      /Privacy\s+Policy/gi,
      /Cookie\s+Policy/gi,
      /All\s+rights\s+reserved/gi,
      /Copyright\s+©/gi,
      /Read\s+more:?/gi,
      /Continue\s+reading/gi,
      /View\s+all/gi,
      /See\s+also/gi
    ];

    boilerplate.forEach(p => {
      this.text = this.text.replace(p, "");
    });

    return this;
  }

  removeSocialMedia() {
    const social = [
      /Share\s+on\s+(Facebook|Twitter|LinkedIn|Instagram|WhatsApp)/gi,
      /Tweet\s+this/gi,
      /Pin\s+it/gi,
      /Share\s+via\s+Email/gi,
      /Follow\s+@\w+/gi
    ];

    social.forEach(p => {
      this.text = this.text.replace(p, "");
    });

    return this;
  }

  removeNavigation() {
    const nav = [
      /Home\s*>\s*News/gi,
      /Home\s*\/\s*News/gi,
      /Breadcrumb/gi,
      /Skip\s+to\s+(main\s+)?content/gi,
      /Table\s+of\s+Contents/gi,
      /In\s+this\s+article/gi
    ];

    nav.forEach(p => {
      this.text = this.text.replace(p, "");
    });

    return this;
  }

  removeDuplicateSentences() {
    const sentences = this.text
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 10);  // Keep only substantial sentences
    
    const unique = [...new Set(sentences)];
    this.text = unique.join(". ");
    
    return this;
  }

  removeExcessiveNewlines() {
    this.text = this.text
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return this;
  }

  getText() {
    return this.text.trim();
  }
}

// =============================================================================
// MEDIA EXTRACTION
// =============================================================================

class MediaExtractor {
  constructor($, url) {
    this.$ = $;
    this.url = url;
  }

  extractImages() {
    const VALID_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
    const BAD_PATTERNS = ["logo", "icon", "sprite", "default", "ads", "pixel", "banner", "tracking"];
    const seen = new Set();
    const images = [];

    this.$("img").each((i, el) => {
      const $el = this.$(el);
      let src = $el.attr("src") || 
                $el.attr("data-src") || 
                $el.attr("data-lazy-src") ||
                $el.attr("data-original");

      if (!src) return;

      const lower = src.toLowerCase();
      
      if (!VALID_EXT.some(e => lower.includes(e))) return;
      if (BAD_PATTERNS.some(b => lower.includes(b))) return;

      const width = parseInt($el.attr("width")) || 0;
      const height = parseInt($el.attr("height")) || 0;
      if ((width > 0 && width < 100) || (height > 0 && height < 100)) return;

      try {
        const absoluteUrl = new URL(src, this.url).href;
        if (!seen.has(absoluteUrl)) {
          seen.add(absoluteUrl);
          images.push({
            src: absoluteUrl,
            alt: $el.attr("alt") || "",
            width,
            height
          });
        }
      } catch {}
    });

    return images;
  }

  extractVideos() {
    const seen = new Set();
    const videos = [];

    this.$("iframe").each((i, el) => {
      const src = this.$(el).attr("src");
      if (src && src.startsWith("http")) {
        try {
          const url = new URL(src, this.url).href;
          if (!seen.has(url)) {
            seen.add(url);
            videos.push({
              src: url,
              type: "embed",
              provider: this.detectVideoProvider(url)
            });
          }
        } catch {}
      }
    });

    this.$("video").each((i, el) => {
      const src = this.$(el).attr("src") || this.$(el).find("source").attr("src");
      if (src) {
        try {
          const url = new URL(src, this.url).href;
          if (!seen.has(url)) {
            seen.add(url);
            videos.push({ src: url, type: "native", provider: "self" });
          }
        } catch {}
      }
    });

    return videos;
  }

  detectVideoProvider(url) {
    const lower = url.toLowerCase();
    if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "youtube";
    if (lower.includes("vimeo.com")) return "vimeo";
    if (lower.includes("dailymotion.com")) return "dailymotion";
    return "unknown";
  }
}

// =============================================================================
// CIRCUIT BREAKER
// =============================================================================

class CircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.failureCount = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = "CLOSED";
    this.nextAttempt = Date.now();
  }

  async execute(fn) {
    if (this.state === "OPEN") {
      if (Date.now() < this.nextAttempt) {
        throw new Error("Circuit breaker is OPEN");
      }
      this.state = "HALF_OPEN";
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  onSuccess() {
    this.failureCount = 0;
    this.state = "CLOSED";
  }

  onFailure() {
    this.failureCount++;
    if (this.failureCount >= this.threshold) {
      this.state = "OPEN";
      this.nextAttempt = Date.now() + this.timeout;
    }
  }
}

const breaker = new CircuitBreaker();

// =============================================================================
// MAIN HANDLER
// =============================================================================

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") return res.status(200).end();

  const startTime = Date.now();

  try {
    const { url, ttl, format = "json" } = req.query;
    const cacheTTL = ttl ? parseInt(ttl) * 1000 : DEFAULT_TTL;

    if (!url) {
      return res.status(400).json({ 
        error: "URL is required",
        usage: "?url=<URL>&ttl=<seconds>&format=<json|text>"
      });
    }

    // URL validation
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Invalid protocol");
      }
    } catch {
      return res.status(400).json({ error: "Invalid URL format" });
    }

    // Cache check
    const cacheKey = `scrape:${generateContentHash(url)}`;
    const cached = CACHE.get(cacheKey);
    
    if (cached) {
      return res.status(200).json({ 
        success: true, 
        cached: true,
        cacheHit: true,
        processingTime: Date.now() - startTime,
        ...cached 
      });
    }

    // Fetch page with circuit breaker
    const response = await breaker.execute(async () => {
      return await axios.get(url, {
        headers: { 
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
        },
        timeout: 15000,
        maxRedirects: 5
      });
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // Extract ALL content
    const extractor = new FullContentExtractor($, url);
    const rawContent = extractor.extractAllContent();
    const metadata = extractor.extractMetadata();

    // Aggressive cleaning
    const cleaner = new AggressiveTextCleaner(rawContent);
    const cleanedContent = cleaner.clean();

    // Chunk into 4000 character pieces
    const chunks = chunkText(cleanedContent, 4000);

    // Extract media
    const mediaExtractor = new MediaExtractor($, url);
    const images = mediaExtractor.extractImages();
    const videos = mediaExtractor.extractVideos();

    // Build response
    const result = {
      url,
      metadata,
      chunks,
      fullText: cleanedContent, // Include full cleaned text
      images,
      videos,
      statistics: {
        chunks: chunks.length,
        images: images.length,
        videos: videos.length,
        totalChars: cleanedContent.length,
        totalWords: cleanedContent.split(/\s+/).length,
        processingTime: Date.now() - startTime
      }
    };

    // Cache result
    CACHE.set(cacheKey, result, cacheTTL);

    // Format response
    if (format === "text") {
      res.setHeader("Content-Type", "text/plain");
      return res.status(200).send(cleanedContent);
    }

    return res.status(200).json({ 
      success: true, 
      cached: false,
      cacheHit: false,
      ...result 
    });

  } catch (err) {
    console.error("Scraping error:", err);
    
    return res.status(500).json({
      error: "Scraping failed",
      message: err.message,
      type: err.constructor.name,
      timestamp: new Date().toISOString()
    });
  }
}

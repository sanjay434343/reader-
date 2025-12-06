import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";

// =============================================================================
// ARCHITECTURE: Multi-layer caching with LRU eviction
// =============================================================================

class LRUCache {
  constructor(maxSize = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const entry = this.cache.get(key);
    
    // Check TTL expiration
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.data;
  }

  set(key, data, ttl) {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, { data, ttl, timestamp: Date.now() });
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

const CACHE = new LRUCache(100);
const DEFAULT_TTL = 600 * 1000;

// =============================================================================
// UTILITY: Content fingerprinting for deduplication
// =============================================================================

function generateContentHash(text) {
  return createHash("md5").update(text).digest("hex").substring(0, 16);
}

// =============================================================================
// CHUNKING: Smart text segmentation with sentence boundary preservation
// =============================================================================

function chunkText(text, maxSize = 4000) {
  const chunks = [];
  text = text.replace(/\s+/g, " ").trim();
  
  if (text.length <= maxSize) {
    return [text];
  }

  // Split by sentence boundaries for better context preservation
  const sentences = text.split(/(?<=[.!?])\s+/);
  let currentChunk = "";
  
  for (const sentence of sentences) {
    // If single sentence exceeds maxSize, force split
    if (sentence.length > maxSize) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }
      
      // Hard split long sentence
      for (let i = 0; i < sentence.length; i += maxSize) {
        chunks.push(sentence.slice(i, i + maxSize));
      }
      continue;
    }
    
    // Add sentence if it fits
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
// EXTRACTION: Advanced content extraction with fallback strategies
// =============================================================================

class ContentExtractor {
  constructor($, url) {
    this.$ = $;
    this.url = url;
  }

  // Strategy pattern for content extraction
  extractContent() {
    const strategies = [
      () => this.extractBySemanticHTML(),
      () => this.extractByCommonClasses(),
      () => this.extractByContentDensity(),
      () => this.extractFallback()
    ];

    for (const strategy of strategies) {
      const content = strategy();
      if (content && content.length > 200) {
        return content;
      }
    }

    return this.extractFallback();
  }

  extractBySemanticHTML() {
    const selectors = ["article", "main[role='main']", "[role='article']"];
    
    for (const sel of selectors) {
      const text = this.$(sel).text().trim();
      if (text.length > 200) return text;
    }
    return null;
  }

  extractByCommonClasses() {
    const selectors = [
      ".article-content", ".post-content", ".entry-content",
      ".story-body", ".article-body", "#article-body",
      ".main-content", ".content-body"
    ];

    for (const sel of selectors) {
      const text = this.$(sel).text().trim();
      if (text.length > 200) return text;
    }
    return null;
  }

  extractByContentDensity() {
    // Find paragraph-dense sections
    let maxDensity = 0;
    let bestContent = "";

    this.$("div, section").each((i, el) => {
      const $el = this.$(el);
      const pCount = $el.find("p").length;
      const text = $el.text().trim();
      const density = pCount / (text.length / 1000 || 1);

      if (density > maxDensity && text.length > 200) {
        maxDensity = density;
        bestContent = text;
      }
    });

    return bestContent;
  }

  extractFallback() {
    return this.$("body").text().trim();
  }

  // Extract metadata with OpenGraph fallbacks
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
// MEDIA EXTRACTION: Robust image and video detection
// =============================================================================

class MediaExtractor {
  constructor($, url) {
    this.$ = $;
    this.url = url;
  }

  extractImages() {
    const VALID_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"];
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
      
      // Validate extension
      if (!VALID_EXT.some(e => lower.includes(e))) return;
      
      // Filter bad patterns
      if (BAD_PATTERNS.some(b => lower.includes(b))) return;

      // Size heuristics
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

    // iframe embeds (YouTube, Vimeo, etc.)
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

    // Native video elements
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
// TEXT CLEANING: Advanced noise removal pipeline
// =============================================================================

class TextCleaner {
  constructor(text) {
    this.text = text;
  }

  clean() {
    return this
      .normalizeWhitespace()
      .removeComments()
      .removeScriptFragments()
      .removeAdvertisements()
      .removeDuplicateSentences()
      .removeBoilerplate()
      .getText();
  }

  normalizeWhitespace() {
    this.text = this.text
      .replace(/\s+/g, " ")
      .replace(/\n\s*\n/g, "\n")
      .trim();
    return this;
  }

  removeComments() {
    this.text = this.text.replace(/<!--.*?-->/gs, "");
    return this;
  }

  removeScriptFragments() {
    this.text = this.text
      .replace(/function.*?\}/gs, "")
      .replace(/var\s+.*?;/gs, "")
      .replace(/const\s+.*?;/gs, "")
      .replace(/let\s+.*?;/gs, "");
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
      /TRENDING/gi,
      /LIVE\s+UPDATES/gi,
      /Premium\s+Story/gi,
      /You\s+May\s+Like/gi,
      /RELATED\s+ARTICLES?/gi,
      /MORE\s+FROM/gi
    ];

    patterns.forEach(p => {
      this.text = this.text.replace(p, "");
    });

    return this;
  }

  removeDuplicateSentences() {
    const sentences = this.text.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
    const unique = [...new Set(sentences)];
    this.text = unique.join(". ");
    return this;
  }

  removeBoilerplate() {
    // Remove common boilerplate phrases
    const boilerplate = [
      /Share this article/gi,
      /Follow us on/gi,
      /Subscribe to our newsletter/gi,
      /Sign up for/gi,
      /By clicking/gi,
      /Terms of Service/gi,
      /Privacy Policy/gi
    ];

    boilerplate.forEach(p => {
      this.text = this.text.replace(p, "");
    });

    return this;
  }

  getText() {
    return this.text.trim();
  }
}

// =============================================================================
// ERROR HANDLING: Circuit breaker pattern for resilient scraping
// =============================================================================

class CircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.failureCount = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = "CLOSED"; // CLOSED, OPEN, HALF_OPEN
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
// MAIN HANDLER: Clean architecture with dependency injection
// =============================================================================

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") return res.status(200).end();

  const startTime = Date.now();

  try {
    // Input validation
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

    // Cache lookup with content hash
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

    // Fetch with circuit breaker protection
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

    // Remove noise elements
    const REMOVE_SELECTORS = [
      "script", "style", "noscript", "header", "footer", "nav",
      "iframe[src*='ads']", "form", "button", "svg", "canvas",
      ".ads", ".ad", ".advertisement", ".sponsored", ".promo",
      ".share", ".social", ".cookie", ".newsletter",
      ".popup", ".modal", ".breadcrumb", ".banner",
      "[class*='sidebar']", "[id*='sidebar']"
    ];
    
    REMOVE_SELECTORS.forEach(sel => $(sel).remove());

    // Extract content using strategy pattern
    const extractor = new ContentExtractor($, url);
    const rawContent = extractor.extractContent();
    const metadata = extractor.extractMetadata();

    // Clean content
    const cleaner = new TextCleaner(rawContent);
    const cleanedContent = cleaner.clean();

    // Chunk content intelligently
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
      images,
      videos,
      statistics: {
        chunks: chunks.length,
        images: images.length,
        videos: videos.length,
        totalChars: cleanedContent.length,
        processingTime: Date.now() - startTime
      }
    };

    // Cache the result
    CACHE.set(cacheKey, result, cacheTTL);

    // Format response
    if (format === "text") {
      res.setHeader("Content-Type", "text/plain");
      return res.status(200).send(chunks.join("\n\n"));
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

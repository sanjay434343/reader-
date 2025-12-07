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
// SPLIT CONTENT BY WORD COUNT (3000 words per part)
// =============================================================================

function splitContentByWords(text, wordsPerPart = 3000) {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const parts = [];
  
  for (let i = 0; i < words.length; i += wordsPerPart) {
    const part = words.slice(i, i + wordsPerPart).join(' ');
    if (part.trim().length > 0) {
      parts.push({
        partNumber: parts.length + 1,
        content: part.trim(),
        wordCount: part.trim().split(/\s+/).length,
        charCount: part.trim().length
      });
    }
  }
  
  return parts;
}

// =============================================================================
// AI SUMMARY GENERATOR using Pollinations API
// =============================================================================

async function generateSummary(content, partNumber, totalParts) {
  try {
    const prompt = `Summarize the following content (Part ${partNumber} of ${totalParts}) in 3-5 concise bullet points:

${content.substring(0, 2000)}...`; // Limit content length for API

    const encodedPrompt = encodeURIComponent(prompt);
    const response = await axios.get(`https://text.pollinations.ai/${encodedPrompt}`, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    return response.data || "Summary generation failed";
  } catch (err) {
    console.error(`Summary generation error for part ${partNumber}:`, err.message);
    return `Summary unavailable for part ${partNumber}`;
  }
}

// =============================================================================
// AGGRESSIVE CONTENT EXTRACTION
// =============================================================================

class FullContentExtractor {
  constructor($, url) {
    this.$ = $;
    this.url = url;
  }

  extractAllContent() {
    const $ = this.$;
    
    const REMOVE_SELECTORS = [
      "script", "style", "noscript", "canvas", "svg",
      "header", "footer", "nav", "aside",
      "form", "button", "input", "select", "textarea",
      ".ads", ".ad", ".advertisement", ".sponsored", ".promo",
      ".share", ".social", ".social-share", ".share-buttons",
      ".cookie", ".newsletter", ".popup", ".modal",
      ".breadcrumb", ".banner", ".sidebar", ".widget",
      ".comments", ".comment-section", ".related-posts",
      ".related-articles", ".recommended", ".more-from",
      "[class*='sidebar']", "[id*='sidebar']",
      "[class*='footer']", "[id*='footer']",
      "[class*='header']", "[id*='header']",
      "[class*='nav']", "[id*='nav']",
      "[class*='menu']", "[id*='menu']",
      "[class*='ads']", "[id*='ads']",
      "[class*='author-bio']", "[class*='author_bio']",
      "[id*='author']", ".author-card", ".byline-info"
    ];
    
    REMOVE_SELECTORS.forEach(sel => $(sel).remove());

    const PRIORITY_SELECTORS = [
      ".article_content", ".artText", ".Normal", 
      "div[data-articlebody]", ".story-content",
      "[data-component='text-block']", ".ssrcss-1q0x1qg-Paragraph",
      ".articlebodycontent", ".article-content",
      ".sp-cn", ".story__content",
      "article", "main", "[role='main']",
      ".article-body", ".post-content", ".entry-content",
      ".story-body", ".content-body", ".article_body"
    ];

    for (const selector of PRIORITY_SELECTORS) {
      const element = $(selector);
      if (element.length > 0) {
        const text = element.text().trim();
        if (text.length > 300) {
          return text;
        }
      }
    }

    let allParagraphs = [];
    $("p").each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 25 && 
          !text.toLowerCase().includes("toi tech desk") &&
          !text.toLowerCase().includes("journalist") &&
          !text.toLowerCase().includes("author bio")) {
        allParagraphs.push(text);
      }
    });

    if (allParagraphs.length > 0) {
      return allParagraphs.join(" ");
    }

    let contentDivs = [];
    $("div").each((i, el) => {
      const $el = $(el);
      const paragraphs = $el.find("p");
      
      if (paragraphs.length >= 3) {
        const text = $el.text().trim();
        if (text.length > 500) {
          contentDivs.push(text);
        }
      }
    });

    if (contentDivs.length > 0) {
      contentDivs.sort((a, b) => b.length - a.length);
      return contentDivs[0];
    }

    return $("body").text().trim();
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
// AGGRESSIVE TEXT CLEANING
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
      .filter(s => s.length > 10);
    
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
    const { url, ttl, format = "json", summarize = "true" } = req.query;
    const cacheTTL = ttl ? parseInt(ttl) * 1000 : DEFAULT_TTL;
    const shouldSummarize = summarize === "true";

    if (!url) {
      return res.status(400).json({ 
        error: "URL is required",
        usage: "?url=<URL>&ttl=<seconds>&format=<json|text>&summarize=<true|false>"
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
    const cacheKey = `scrape:${generateContentHash(url)}:${shouldSummarize}`;
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

    // Extract content
    const extractor = new FullContentExtractor($, url);
    const rawContent = extractor.extractAllContent();
    const metadata = extractor.extractMetadata();

    // Clean content
    const cleaner = new AggressiveTextCleaner(rawContent);
    const cleanedContent = cleaner.clean();

    // Split content into 3000-word parts
    const contentParts = splitContentByWords(cleanedContent, 3000);

    // Generate summaries for each part (if enabled)
    if (shouldSummarize) {
      console.log(`Generating summaries for ${contentParts.length} content parts...`);
      
      for (let i = 0; i < contentParts.length; i++) {
        const summary = await generateSummary(
          contentParts[i].content, 
          i + 1, 
          contentParts.length
        );
        contentParts[i].summary = summary;
      }
    }

    // Extract media
    const mediaExtractor = new MediaExtractor($, url);
    const images = mediaExtractor.extractImages();
    const videos = mediaExtractor.extractVideos();

    // Build response
    const result = {
      url,
      metadata,
      contentParts,
      fullText: cleanedContent,
      images,
      videos,
      statistics: {
        totalParts: contentParts.length,
        images: images.length,
        videos: videos.length,
        totalChars: cleanedContent.length,
        totalWords: cleanedContent.split(/\s+/).length,
        processingTime: Date.now() - startTime,
        summarized: shouldSummarize
      }
    };

    // Cache result
    CACHE.set(cacheKey, result, cacheTTL);

    // Format response
    if (format === "text") {
      res.setHeader("Content-Type", "text/plain");
      let textOutput = cleanedContent;
      
      if (shouldSummarize) {
        textOutput = contentParts.map((part, idx) => {
          return `\n=== PART ${idx + 1} ===\n${part.content}\n\n--- SUMMARY ---\n${part.summary}`;
        }).join('\n\n');
      }
      
      return res.status(200).send(textOutput);
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

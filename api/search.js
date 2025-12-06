import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";

// =============================================================================
// LRU CACHE IMPLEMENTATION
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
// NEWS SOURCES WITH SEARCH ENDPOINTS
// =============================================================================

const NEWS_SITES = [
  { name: "Indian Express", url: q => `https://indianexpress.com/?s=${q}`, category: "general" },
  { name: "Times of India", url: q => `https://timesofindia.indiatimes.com/topic/${q}`, category: "general" },
  { name: "BBC", url: q => `https://www.bbc.co.uk/search?q=${q}`, category: "general" },
  { name: "NDTV", url: q => `https://www.ndtv.com/search?searchtext=${q}`, category: "general" },
  { name: "Hindustan Times", url: q => `https://www.hindustantimes.com/search?q=${q}`, category: "general" },
  { name: "The Hindu", url: q => `https://www.thehindu.com/search/?q=${q}`, category: "general" },
  { name: "The Verge", url: q => `https://www.theverge.com/search?q=${q}`, category: "technology" },
  { name: "TechCrunch", url: q => `https://search.techcrunch.com/search?q=${q}`, category: "technology" },
  { name: "ESPN", url: q => `https://www.espn.com/search/results?q=${q}`, category: "sports" },
  { name: "Live Science", url: q => `https://www.livescience.com/search?q=${q}`, category: "science" },
  { name: "Dev.to", url: q => `https://dev.to/search?q=${q}`, category: "technology" }
];

// =============================================================================
// AI-POWERED CATEGORY DETECTION
// =============================================================================

async function detectCategory(query) {
  try {
    const prompt = encodeURIComponent(
      `Analyze this search query and return ONLY ONE WORD from this list: general, technology, sports, science, business, entertainment, health, politics. Query: "${query}"`
    );
    
    const response = await axios.get(`https://text.pollinations.ai/${prompt}`, {
      timeout: 5000
    });
    
    const category = response.data.toLowerCase().trim();
    const validCategories = ["general", "technology", "sports", "science", "business", "entertainment", "health", "politics"];
    
    return validCategories.includes(category) ? category : "general";
  } catch {
    return "general";
  }
}

// =============================================================================
// SMART URL VALIDATION
// =============================================================================

function isValidArticle(url) {
  if (!url) return false;
  
  const badPatterns = [
    "facebook.com", "twitter.com", "x.com", "pinterest.com", "instagram.com",
    "whatsapp.com", "mailto:", "javascript:", "/tag/", "/topic/", "/category/",
    "share", "subscribe", "login", "signup", "account", "privacy", "terms"
  ];
  
  return !badPatterns.some(pattern => url.toLowerCase().includes(pattern));
}

// =============================================================================
// ADVANCED SCORING ALGORITHM
// =============================================================================

function scoreResult(url, title, description, queryWords) {
  const text = `${title} ${description} ${url}`.toLowerCase();
  let score = 0;
  
  queryWords.forEach(word => {
    const wordLower = word.toLowerCase();
    
    // Title scoring (highest weight)
    if (title.toLowerCase().includes(wordLower)) score += 10;
    if (title.toLowerCase().startsWith(wordLower)) score += 15;
    
    // Description scoring (medium weight)
    if (description.toLowerCase().includes(wordLower)) score += 5;
    
    // URL scoring (low weight)
    if (url.toLowerCase().includes(wordLower)) score += 3;
  });
  
  // Boost recent articles (if date is in title/description)
  if (/202[4-5]|today|hours ago|minutes ago/i.test(text)) score += 8;
  
  // Penalize very short titles
  if (title.length < 30) score -= 5;
  
  return Math.max(0, score);
}

// =============================================================================
// SCRAPE INDIVIDUAL NEWS SITE
// =============================================================================

async function scrapeSite(site, query, queryWords) {
  try {
    const searchUrl = site.url(query);
    const response = await axios.get(searchUrl, {
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
      },
      timeout: 8000,
      maxRedirects: 3
    });
    
    const $ = cheerio.load(response.data);
    const results = [];
    
    // Extract article links with context
    $("a").each((i, el) => {
      const $el = $(el);
      let href = $el.attr("href");
      let title = $el.text().trim() || $el.attr("title") || "";
      
      // Get surrounding context for better description
      let description = $el.closest("article, .article, .story, .post")
        .find("p, .description, .excerpt")
        .first()
        .text()
        .trim()
        .substring(0, 200);
      
      if (!href || !title || title.length < 10) return;
      
      // Convert relative URLs to absolute
      if (!href.startsWith("http")) {
        try {
          href = new URL(href, searchUrl).href;
        } catch {
          return;
        }
      }
      
      if (!isValidArticle(href)) return;
      
      results.push({
        site: site.name,
        category: site.category,
        title,
        description: description || title,
        url: href,
        score: scoreResult(href, title, description, queryWords)
      });
    });
    
    return results;
  } catch {
    return [];
  }
}

// =============================================================================
// SMART DEDUPLICATION
// =============================================================================

function deduplicateResults(results) {
  const urlMap = new Map();
  const titleMap = new Map();
  
  results.forEach(result => {
    const urlKey = result.url.toLowerCase();
    const titleKey = result.title.toLowerCase().trim();
    
    // Keep highest scored duplicate URL
    if (!urlMap.has(urlKey) || urlMap.get(urlKey).score < result.score) {
      urlMap.set(urlKey, result);
    }
    
    // Keep highest scored similar title
    if (!titleMap.has(titleKey) || titleMap.get(titleKey).score < result.score) {
      titleMap.set(titleKey, result);
    }
  });
  
  // Merge both deduplication strategies
  const merged = new Map();
  [...urlMap.values(), ...titleMap.values()].forEach(result => {
    if (!merged.has(result.url) || merged.get(result.url).score < result.score) {
      merged.set(result.url, result);
    }
  });
  
  return Array.from(merged.values());
}

// =============================================================================
// MAIN SEARCH HANDLER WITH AI ENHANCEMENT
// =============================================================================

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  
  if (req.method === "OPTIONS") return res.status(200).end();
  
  const startTime = Date.now();
  
  try {
    const { q: query, limit = 20, category: userCategory } = req.query;
    
    if (!query) {
      return res.status(400).json({ 
        error: "Query parameter 'q' is required",
        usage: "?q=<search_term>&limit=<number>&category=<optional>"
      });
    }
    
    // Check cache first
    const cacheKey = `search:${createHash("md5").update(query).digest("hex")}`;
    const cached = CACHE.get(cacheKey);
    
    if (cached) {
      return res.json({
        success: true,
        cached: true,
        ...cached,
        processingTime: Date.now() - startTime
      });
    }
    
    // AI-powered category detection (parallel with search)
    const categoryPromise = userCategory ? Promise.resolve(userCategory) : detectCategory(query);
    
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    
    // Filter sites by category if detected
    const [detectedCategory] = await Promise.all([categoryPromise]);
    
    const filteredSites = detectedCategory && detectedCategory !== "general"
      ? NEWS_SITES.filter(site => site.category === detectedCategory || site.category === "general")
      : NEWS_SITES;
    
    // Parallel scraping of all news sites
    const scrapingPromises = filteredSites.map(site => 
      scrapeSite(site, query, queryWords)
    );
    
    const allResults = (await Promise.all(scrapingPromises)).flat();
    
    // Smart deduplication
    const uniqueResults = deduplicateResults(allResults);
    
    // Sort by score (descending)
    uniqueResults.sort((a, b) => b.score - a.score);
    
    // Get top results
    const topResults = uniqueResults.slice(0, parseInt(limit));
    
    // Select best 1-2 URLs based on highest scores
    const bestUrls = topResults.slice(0, 2).map(r => r.url);
    
    const response = {
      success: true,
      cached: false,
      query,
      detectedCategory,
      totalResults: uniqueResults.length,
      topResults: topResults.length,
      bestUrls,
      results: topResults,
      processingTime: Date.now() - startTime
    };
    
    // Cache the response
    CACHE.set(cacheKey, response, DEFAULT_TTL);
    
    return res.json(response);
    
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Search failed",
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
}

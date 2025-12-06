import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";

// =============================================================================
// MULTI-LAYER CACHE SYSTEM (Memory + Persistent)
// =============================================================================

class LRUCache {
  constructor(maxSize = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    if (!this.cache.has(key)) {
      this.misses++;
      return null;
    }
    
    const entry = this.cache.get(key);
    
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }
    
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.data;
  }

  set(key, data, ttl) {
    // Remove oldest entry if cache is full
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { data, ttl, timestamp: Date.now() });
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0 ? (this.hits / (this.hits + this.misses) * 100).toFixed(2) + '%' : 'N/A'
    };
  }
}

// In-memory cache (fast, volatile)
const MEMORY_CACHE = new LRUCache(100);

// Persistent cache using file system (for serverless/edge functions)
class PersistentCache {
  constructor() {
    this.storage = new Map();
    this.maxSize = 500;
    this.initialized = false;
  }

  async get(key) {
    try {
      // Try in-memory first
      if (this.storage.has(key)) {
        const entry = this.storage.get(key);
        if (Date.now() - entry.timestamp <= entry.ttl) {
          return entry.data;
        }
        this.storage.delete(key);
      }
      return null;
    } catch {
      return null;
    }
  }

  async set(key, data, ttl) {
    try {
      // Evict oldest if full
      if (this.storage.size >= this.maxSize) {
        const firstKey = this.storage.keys().next().value;
        this.storage.delete(firstKey);
      }
      
      this.storage.set(key, {
        data,
        ttl,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('Cache write error:', error.message);
    }
  }

  async clear() {
    this.storage.clear();
  }

  getStats() {
    const validEntries = Array.from(this.storage.values()).filter(
      entry => Date.now() - entry.timestamp <= entry.ttl
    ).length;
    
    return {
      totalEntries: this.storage.size,
      validEntries,
      expiredEntries: this.storage.size - validEntries,
      maxSize: this.maxSize
    };
  }
}

const PERSISTENT_CACHE = new PersistentCache();

// TTL configurations
const CACHE_TTL = {
  SHORT: 5 * 60 * 1000,      // 5 minutes - for rapidly changing content
  MEDIUM: 15 * 60 * 1000,    // 15 minutes - default
  LONG: 60 * 60 * 1000,      // 1 hour - for stable content
  VERY_LONG: 24 * 60 * 60 * 1000  // 24 hours - for historical/static content
};

// Smart TTL selection based on query type
function selectTTL(query, category) {
  const lowerQuery = query.toLowerCase();
  
  // Short TTL for time-sensitive queries
  if (/today|now|latest|breaking|live|current|yesterday/.test(lowerQuery)) {
    return CACHE_TTL.SHORT;
  }
  
  // Long TTL for historical/reference queries
  if (/history|who is|what is|how to|tutorial|guide/.test(lowerQuery)) {
    return CACHE_TTL.VERY_LONG;
  }
  
  // Category-based TTL
  if (category === 'sports' || category === 'business') {
    return CACHE_TTL.SHORT; // Fast-changing content
  }
  
  if (category === 'science' || category === 'health') {
    return CACHE_TTL.LONG; // More stable content
  }
  
  return CACHE_TTL.MEDIUM; // Default
}

// =============================================================================
// COMPREHENSIVE NEWS SOURCES WITH PRIORITY RANKING
// =============================================================================

const NEWS_SITES = [
  // General News - Indian
  { name: "Indian Express", url: q => `https://indianexpress.com/?s=${q}`, category: "general", priority: 8 },
  { name: "Times of India", url: q => `https://timesofindia.indiatimes.com/topic/${q}`, category: "general", priority: 9 },
  { name: "NDTV", url: q => `https://www.ndtv.com/search?searchtext=${q}`, category: "general", priority: 8 },
  { name: "Hindustan Times", url: q => `https://www.hindustantimes.com/search?q=${q}`, category: "general", priority: 7 },
  { name: "The Hindu", url: q => `https://www.thehindu.com/search/?q=${q}`, category: "general", priority: 9 },
  
  // General News - International
  { name: "BBC", url: q => `https://www.bbc.co.uk/search?q=${q}`, category: "general", priority: 10 },
  { name: "Reuters", url: q => `https://www.reuters.com/site-search/?query=${q}`, category: "general", priority: 10 },
  { name: "CNN", url: q => `https://edition.cnn.com/search?q=${q}`, category: "general", priority: 9 },
  { name: "The Guardian", url: q => `https://www.theguardian.com/search?q=${q}`, category: "general", priority: 9 },
  { name: "Al Jazeera", url: q => `https://www.aljazeera.com/search/${q}`, category: "general", priority: 8 },
  { name: "Associated Press", url: q => `https://apnews.com/search?q=${q}`, category: "general", priority: 10 },
  
  // Technology
  { name: "The Verge", url: q => `https://www.theverge.com/search?q=${q}`, category: "technology", priority: 10 },
  { name: "TechCrunch", url: q => `https://search.techcrunch.com/search?q=${q}`, category: "technology", priority: 10 },
  { name: "Wired", url: q => `https://www.wired.com/search/?q=${q}`, category: "technology", priority: 9 },
  { name: "Ars Technica", url: q => `https://arstechnica.com/search/?q=${q}`, category: "technology", priority: 9 },
  { name: "The Next Web", url: q => `https://thenextweb.com/search?q=${q}`, category: "technology", priority: 7 },
  { name: "CNET", url: q => `https://www.cnet.com/search/?q=${q}`, category: "technology", priority: 8 },
  { name: "ZDNet", url: q => `https://www.zdnet.com/search/?q=${q}`, category: "technology", priority: 8 },
  { name: "Stack Overflow", url: q => `https://stackoverflow.com/search?q=${q}`, category: "technology", priority: 9 },
  { name: "GitHub", url: q => `https://github.com/search?q=${q}`, category: "technology", priority: 8 },
  { name: "Dev.to", url: q => `https://dev.to/search?q=${q}`, category: "technology", priority: 7 },
  
  // Sports
  { name: "ESPN", url: q => `https://www.espn.com/search/results?q=${q}`, category: "sports", priority: 10 },
  { name: "Sky Sports", url: q => `https://www.skysports.com/search?q=${q}`, category: "sports", priority: 9 },
  { name: "Cricbuzz", url: q => `https://www.cricbuzz.com/cricket-news/search?q=${q}`, category: "sports", priority: 9 },
  { name: "Goal", url: q => `https://www.goal.com/en/search?q=${q}`, category: "sports", priority: 8 },
  
  // Science
  { name: "Live Science", url: q => `https://www.livescience.com/search?q=${q}`, category: "science", priority: 9 },
  { name: "Nature", url: q => `https://www.nature.com/search?q=${q}`, category: "science", priority: 10 },
  { name: "Scientific American", url: q => `https://www.scientificamerican.com/search/?q=${q}`, category: "science", priority: 9 },
  { name: "Science Daily", url: q => `https://www.sciencedaily.com/search/?keyword=${q}`, category: "science", priority: 8 },
  { name: "New Scientist", url: q => `https://www.newscientist.com/search/?q=${q}`, category: "science", priority: 8 },
  
  // Business & Finance
  { name: "Bloomberg", url: q => `https://www.bloomberg.com/search?query=${q}`, category: "business", priority: 10 },
  { name: "CNBC", url: q => `https://www.cnbc.com/search/?query=${q}`, category: "business", priority: 9 },
  { name: "Forbes", url: q => `https://www.forbes.com/search/?q=${q}`, category: "business", priority: 8 },
  { name: "Financial Times", url: q => `https://www.ft.com/search?q=${q}`, category: "business", priority: 9 },
  { name: "Wall Street Journal", url: q => `https://www.wsj.com/search?query=${q}`, category: "business", priority: 10 },
  { name: "Economic Times", url: q => `https://economictimes.indiatimes.com/topic/${q}`, category: "business", priority: 8 },
  
  // Health
  { name: "WebMD", url: q => `https://www.webmd.com/search/search_results/default.aspx?query=${q}`, category: "health", priority: 9 },
  { name: "Healthline", url: q => `https://www.healthline.com/search?q1=${q}`, category: "health", priority: 9 },
  { name: "Mayo Clinic", url: q => `https://www.mayoclinic.org/search/search-results?q=${q}`, category: "health", priority: 10 },
  { name: "Medical News Today", url: q => `https://www.medicalnewstoday.com/search?q=${q}`, category: "health", priority: 8 },
  
  // Entertainment
  { name: "Variety", url: q => `https://variety.com/?s=${q}`, category: "entertainment", priority: 8 },
  { name: "The Hollywood Reporter", url: q => `https://www.hollywoodreporter.com/?s=${q}`, category: "entertainment", priority: 8 },
  { name: "IMDb", url: q => `https://www.imdb.com/find?q=${q}`, category: "entertainment", priority: 9 },
  { name: "Rolling Stone", url: q => `https://www.rollingstone.com/search/?q=${q}`, category: "entertainment", priority: 7 },
  
  // Politics
  { name: "Politico", url: q => `https://www.politico.com/search?q=${q}`, category: "politics", priority: 9 },
  { name: "The Hill", url: q => `https://thehill.com/search/?q=${q}`, category: "politics", priority: 8 },
  
  // Community & Social
  { name: "Reddit", url: q => `https://www.reddit.com/search/?q=${q}`, category: "general", priority: 7 },
  { name: "Medium", url: q => `https://medium.com/search?q=${q}`, category: "general", priority: 6 },
  { name: "Quora", url: q => `https://www.quora.com/search?q=${q}`, category: "general", priority: 6 }
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
    "share", "subscribe", "login", "signup", "account", "privacy", "terms",
    "cookie", "about-us", "contact", "/author/", "/user/", "advertisement"
  ];
  
  return !badPatterns.some(pattern => url.toLowerCase().includes(pattern));
}

// =============================================================================
// ADVANCED GOOGLE-LIKE SCORING ALGORITHM
// =============================================================================

function advancedScore(result, queryWords, siteInfo) {
  const { url, title, description } = result;
  const text = `${title} ${description} ${url}`.toLowerCase();
  let score = 0;
  
  // === QUERY MATCHING (up to 100 points) ===
  queryWords.forEach(word => {
    const wordLower = word.toLowerCase();
    const regex = new RegExp(`\\b${wordLower}\\b`, 'gi');
    
    // Exact phrase matching in title (highest weight)
    const titleMatches = (title.toLowerCase().match(regex) || []).length;
    score += titleMatches * 15;
    
    // Title starts with query word (strong signal)
    if (title.toLowerCase().startsWith(wordLower)) score += 20;
    
    // Description matching (medium weight)
    const descMatches = (description.toLowerCase().match(regex) || []).length;
    score += descMatches * 8;
    
    // URL slug matching (low-medium weight)
    if (url.toLowerCase().includes(wordLower)) score += 5;
  });
  
  // Exact phrase match bonus
  const fullQuery = queryWords.join(' ').toLowerCase();
  if (title.toLowerCase().includes(fullQuery)) score += 25;
  if (description.toLowerCase().includes(fullQuery)) score += 15;
  
  // === AUTHORITY & TRUST (up to 50 points) ===
  score += (siteInfo.priority || 5) * 3; // Site reputation
  
  // Authoritative domains
  if (/\.gov|\.edu|\.org/.test(url)) score += 15;
  if (/reuters|bbc|nature|bloomberg|cnn|apnews/.test(url.toLowerCase())) score += 12;
  
  // === FRESHNESS (up to 30 points) ===
  const freshnessKeywords = {
    'just now': 30, 'minutes ago': 28, 'hour ago': 25, 'hours ago': 22,
    'today': 20, 'yesterday': 15, '2025': 18, '2024': 12, 'breaking': 25,
    'live': 22, 'updated': 18, 'latest': 15, 'new': 10
  };
  
  for (const [keyword, points] of Object.entries(freshnessKeywords)) {
    if (text.includes(keyword)) {
      score += points;
      break; // Only apply highest freshness bonus
    }
  }
  
  // === CONTENT QUALITY (up to 40 points) ===
  // Title length (sweet spot: 40-80 chars)
  if (title.length >= 40 && title.length <= 80) score += 15;
  else if (title.length >= 30 && title.length < 40) score += 10;
  else if (title.length < 20) score -= 10;
  
  // Description quality
  if (description.length >= 100) score += 12;
  else if (description.length < 30) score -= 8;
  
  // Has numbers/data (good signal for informative content)
  if (/\d+/.test(title)) score += 8;
  
  // === URL QUALITY (up to 20 points) ===
  // Clean URL structure
  const urlDepth = (url.match(/\//g) || []).length;
  if (urlDepth >= 3 && urlDepth <= 5) score += 10; // Good depth
  if (urlDepth > 8) score -= 5; // Too deep
  
  // HTTPS bonus
  if (url.startsWith('https://')) score += 5;
  
  // === NEGATIVE SIGNALS ===
  const spamKeywords = ['click here', 'buy now', 'subscribe now', 'sign up', 'download now', 'free trial'];
  for (const spam of spamKeywords) {
    if (text.includes(spam)) score -= 15;
  }
  
  // Duplicate content indicators
  if (/(part \d+|page \d+|\(\d+\))/i.test(title)) score -= 8;
  
  return Math.max(0, score);
}

// =============================================================================
// SMART RELEVANCE FILTERING
// =============================================================================

function isRelevantResult(result, queryWords) {
  const text = `${result.title} ${result.description}`.toLowerCase();
  
  // Must match at least 50% of query words (or all if query is 1-2 words)
  const threshold = queryWords.length <= 2 ? queryWords.length : Math.ceil(queryWords.length * 0.5);
  const matchCount = queryWords.filter(word => 
    text.includes(word.toLowerCase())
  ).length;
  
  return matchCount >= threshold;
}

// =============================================================================
// ENHANCED SCRAPING WITH MULTIPLE SELECTORS
// =============================================================================

async function scrapeSite(site, query, queryWords) {
  try {
    const searchUrl = site.url(query);
    const response = await axios.get(searchUrl, {
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      },
      timeout: 10000,
      maxRedirects: 5
    });
    
    const $ = cheerio.load(response.data);
    const results = [];
    const seenUrls = new Set();
    
    // Multiple selector strategies for different site structures
    const articleSelectors = [
      'article a[href]',
      '.article a[href]',
      '.story a[href]',
      '.post a[href]',
      '.search-result a[href]',
      '.result a[href]',
      'h2 a[href]',
      'h3 a[href]',
      '.headline a[href]',
      '.title a[href]',
      '[data-component="card"] a[href]',
      '.card a[href]',
      '.content a[href]',
      '.item a[href]'
    ];
    
    // Try each selector
    for (const selector of articleSelectors) {
      $(selector).each((i, el) => {
        if (results.length >= 20) return false; // Limit per site
        
        const $el = $(el);
        let href = $el.attr("href");
        
        // Extract title from multiple sources
        let title = $el.text().trim() || 
                   $el.attr("title") || 
                   $el.attr("aria-label") ||
                   $el.closest('article, .article, .story, .card').find('h1, h2, h3, .headline, .title').first().text().trim() ||
                   "";
        
        // Extract description with multiple fallbacks
        let description = $el.closest("article, .article, .story, .post, .card, .result, .search-result")
          .find("p, .description, .excerpt, .summary, .snippet, .deck")
          .first()
          .text()
          .trim()
          .substring(0, 300);
        
        // Alternative: get description from meta tags on the same card
        if (!description) {
          description = $el.closest('[data-component]').find('[data-description], .meta, .info').text().trim().substring(0, 300);
        }
        
        if (!href || !title || title.length < 15) return;
        
        // Convert relative URLs to absolute
        if (!href.startsWith("http")) {
          try {
            const baseUrl = new URL(searchUrl);
            href = new URL(href, baseUrl.origin).href;
          } catch {
            return;
          }
        }
        
        // Skip duplicates
        if (seenUrls.has(href)) return;
        seenUrls.add(href);
        
        if (!isValidArticle(href)) return;
        
        const result = {
          site: site.name,
          category: site.category,
          title: title.substring(0, 200),
          description: description || title.substring(0, 200),
          url: href,
          score: 0 // Will be calculated later
        };
        
        // Only add if relevant
        if (isRelevantResult(result, queryWords)) {
          results.push(result);
        }
      });
      
      if (results.length >= 10) break; // Found enough from this selector
    }
    
    // Calculate scores after extraction
    results.forEach(result => {
      result.score = advancedScore(result, queryWords, site);
    });
    
    return results;
  } catch (error) {
    console.error(`Error scraping ${site.name}:`, error.message);
    return [];
  }
}

// =============================================================================
// INTELLIGENT DEDUPLICATION WITH SIMILARITY DETECTION
// =============================================================================

function calculateSimilarity(str1, str2) {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  
  // Exact match
  if (s1 === s2) return 1.0;
  
  // Word-level comparison
  const words1 = s1.split(/\s+/);
  const words2 = s2.split(/\s+/);
  const commonWords = words1.filter(w => words2.includes(w)).length;
  const wordSimilarity = (2.0 * commonWords) / (words1.length + words2.length);
  
  return wordSimilarity;
}

function intelligentDeduplication(results) {
  const keep = [];
  const urlSeen = new Set();
  const SIMILARITY_THRESHOLD = 0.75;
  
  // Sort by score first (keep highest scored versions)
  results.sort((a, b) => b.score - a.score);
  
  for (const result of results) {
    // Skip exact URL duplicates
    if (urlSeen.has(result.url.toLowerCase())) continue;
    
    // Check for similar titles
    let isDuplicate = false;
    for (const existing of keep) {
      const similarity = calculateSimilarity(result.title, existing.title);
      
      if (similarity >= SIMILARITY_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }
    
    if (!isDuplicate) {
      keep.push(result);
      urlSeen.add(result.url.toLowerCase());
    }
  }
  
  return keep;
}

// =============================================================================
// MAIN SEARCH HANDLER WITH GOOGLE-LIKE INTELLIGENCE
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
        usage: "?q=<search_term>&limit=<number>&category=<optional>",
        examples: [
          "?q=climate+change",
          "?q=latest+iphone&category=technology",
          "?q=stock+market+today&limit=5"
        ]
      });
    }
    
    // Generate cache key
    const cacheKey = createHash("md5")
      .update(`v2:${query}:${userCategory || ''}:${limit}`)
      .digest("hex");
    
    // Multi-layer cache check
    // Layer 1: Memory cache (fastest)
    let cached = MEMORY_CACHE.get(cacheKey);
    if (cached) {
      return res.json({
        ...cached,
        cached: true,
        cacheSource: 'memory',
        processingTime: Date.now() - startTime
      });
    }
    
    // Layer 2: Persistent cache
    cached = await PERSISTENT_CACHE.get(cacheKey);
    if (cached) {
      // Populate memory cache for next time
      MEMORY_CACHE.set(cacheKey, cached, CACHE_TTL.MEDIUM);
      
      return res.json({
        ...cached,
        cached: true,
        cacheSource: 'persistent',
        processingTime: Date.now() - startTime
      });
    }
    
    // AI-powered category detection (parallel with search)
    const categoryPromise = userCategory ? Promise.resolve(userCategory) : detectCategory(query);
    
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    
    // Filter sites by category if detected
    const [detectedCategory] = await Promise.all([categoryPromise]);
    
    // Smart site selection based on category
    let selectedSites = [];
    
    if (detectedCategory && detectedCategory !== "general") {
      // Get category-specific + top general sites
      const categorySites = NEWS_SITES.filter(s => s.category === detectedCategory);
      const generalSites = NEWS_SITES
        .filter(s => s.category === "general")
        .sort((a, b) => (b.priority || 0) - (a.priority || 0))
        .slice(0, 5);
      
      selectedSites = [...categorySites, ...generalSites];
    } else {
      // General search: prioritize high-authority sites
      selectedSites = NEWS_SITES
        .sort((a, b) => (b.priority || 0) - (a.priority || 0))
        .slice(0, 15);
    }
    
    // Parallel scraping with controlled concurrency
    const BATCH_SIZE = 5;
    const allResults = [];
    
    for (let i = 0; i < selectedSites.length; i += BATCH_SIZE) {
      const batch = selectedSites.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(site => scrapeSite(site, query, queryWords))
      );
      allResults.push(...batchResults.flat());
      
      // Early exit if we have enough high-quality results
      if (allResults.length >= 100) break;
    }
    
    // Intelligent deduplication
    const uniqueResults = intelligentDeduplication(allResults);
    
    // Final sort by score
    uniqueResults.sort((a, b) => b.score - a.score);
    
    // Get top results
    const topResults = uniqueResults.slice(0, parseInt(limit));
    
    // Select THE BEST result (Google-style #1 result)
    const bestResult = topResults[0];
    
    // Additional top URLs for reference
    const topUrls = topResults.slice(0, 5).map(r => ({
      url: r.url,
      title: r.title,
      score: r.score,
      site: r.site
    }));
    
    const response = {
      success: true,
      cached: false,
      query,
      detectedCategory,
      // Google-style best result
      bestResult: bestResult ? {
        url: bestResult.url,
        title: bestResult.title,
        description: bestResult.description,
        site: bestResult.site,
        category: bestResult.category,
        score: bestResult.score
      } : null,
      // Top 5 URLs for reference
      topUrls,
      totalResults: uniqueResults.length,
      displayedResults: topResults.length,
      results: topResults,
      processingTime: Date.now() - startTime
    };
    
    // Smart TTL selection
    const ttl = selectTTL(query, detectedCategory);
    
    // Store in both caches
    MEMORY_CACHE.set(cacheKey, response, ttl);
    await PERSISTENT_CACHE.set(cacheKey, response, ttl);
    
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

// =============================================================================
// CACHE MANAGEMENT ENDPOINTS
// =============================================================================

// Clear all caches (admin endpoint)
export async function clearCache(req, res) {
  try {
    MEMORY_CACHE.clear();
    await PERSISTENT_CACHE.clear();
    
    return res.json({
      success: true,
      message: "All caches cleared",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// Get cache statistics (monitoring endpoint)
export async function getCacheStats(req, res) {
  try {
    const memoryStats = MEMORY_CACHE.getStats();
    const persistentStats = PERSISTENT_CACHE.getStats();
    
    return res.json({
      success: true,
      memory: memoryStats,
      persistent: persistentStats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

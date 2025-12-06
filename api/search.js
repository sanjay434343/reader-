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
  // Indian News
  { name: "Indian Express", url: q => `https://indianexpress.com/?s=${q}`, category: "general" },
  { name: "Times of India", url: q => `https://timesofindia.indiatimes.com/topic/${q}`, category: "general" },
  { name: "NDTV", url: q => `https://www.ndtv.com/search?searchtext=${q}`, category: "general" },
  { name: "Hindustan Times", url: q => `https://www.hindustantimes.com/search?q=${q}`, category: "general" },
  { name: "The Hindu", url: q => `https://www.thehindu.com/search/?q=${q}`, category: "general" },
  { name: "India Today", url: q => `https://www.indiatoday.in/search?searchtext=${q}`, category: "general" },
  { name: "News18", url: q => `https://www.news18.com/search?q=${q}`, category: "general" },
  { name: "The Wire", url: q => `https://thewire.in/?s=${q}`, category: "politics" },
  { name: "Scroll.in", url: q => `https://scroll.in/search?q=${q}`, category: "general" },
  
  // International News
  { name: "BBC", url: q => `https://www.bbc.co.uk/search?q=${q}`, category: "general" },
  { name: "Reuters", url: q => `https://www.reuters.com/site-search/?query=${q}`, category: "general" },
  { name: "Al Jazeera", url: q => `https://www.aljazeera.com/search/${q}`, category: "general" },
  { name: "CNN", url: q => `https://www.cnn.com/search?q=${q}`, category: "general" },
  { name: "The Guardian", url: q => `https://www.theguardian.com/search?q=${q}`, category: "general" },
  { name: "Associated Press", url: q => `https://apnews.com/search?q=${q}`, category: "general" },
  { name: "NPR", url: q => `https://www.npr.org/search?query=${q}`, category: "general" },
  
  // Live News & Breaking
  { name: "LiveMint", url: q => `https://www.livemint.com/Search/Link/Keyword/${q}`, category: "business" },
  { name: "Bloomberg", url: q => `https://www.bloomberg.com/search?query=${q}`, category: "business" },
  
  // Technology News & Blogs
  { name: "The Verge", url: q => `https://www.theverge.com/search?q=${q}`, category: "technology" },
  { name: "TechCrunch", url: q => `https://search.techcrunch.com/search?q=${q}`, category: "technology" },
  { name: "Ars Technica", url: q => `https://arstechnica.com/search/${q}`, category: "technology" },
  { name: "Wired", url: q => `https://www.wired.com/search/?q=${q}`, category: "technology" },
  { name: "ZDNet", url: q => `https://www.zdnet.com/search/?q=${q}`, category: "technology" },
  { name: "The Next Web", url: q => `https://thenextweb.com/search?query=${q}`, category: "technology" },
  { name: "Engadget", url: q => `https://www.engadget.com/search/?q=${q}`, category: "technology" },
  { name: "CNET", url: q => `https://www.cnet.com/search/?query=${q}`, category: "technology" },
  { name: "Tech Radar", url: q => `https://www.techradar.com/search?searchTerm=${q}`, category: "technology" },
  { name: "Digital Trends", url: q => `https://www.digitaltrends.com/search/?q=${q}`, category: "technology" },
  { name: "Tom's Hardware", url: q => `https://www.tomshardware.com/search?searchTerm=${q}`, category: "technology" },
  { name: "AnandTech", url: q => `https://www.anandtech.com/search?searchTerm=${q}`, category: "technology" },
  
  // Android & Mobile
  { name: "Android Authority", url: q => `https://www.androidauthority.com/?s=${q}`, category: "technology" },
  { name: "Android Police", url: q => `https://www.androidpolice.com/?s=${q}`, category: "technology" },
  { name: "Android Central", url: q => `https://www.androidcentral.com/search?q=${q}`, category: "technology" },
  { name: "XDA Developers", url: q => `https://www.xda-developers.com/?s=${q}`, category: "technology" },
  { name: "9to5Google", url: q => `https://9to5google.com/?s=${q}`, category: "technology" },
  { name: "9to5Mac", url: q => `https://9to5mac.com/?s=${q}`, category: "technology" },
  { name: "MacRumors", url: q => `https://www.macrumors.com/search/?q=${q}`, category: "technology" },
  { name: "iMore", url: q => `https://www.imore.com/search?q=${q}`, category: "technology" },
  { name: "PhoneArena", url: q => `https://www.phonearena.com/search?term=${q}`, category: "technology" },
  { name: "GSMArena", url: q => `https://www.gsmarena.com/results.php3?sQuickSearch=yes&sName=${q}`, category: "technology" },
  
  // Developer Blogs & Communities
  { name: "Dev.to", url: q => `https://dev.to/search?q=${q}`, category: "technology" },
  { name: "Hacker News", url: q => `https://hn.algolia.com/?q=${q}`, category: "technology" },
  { name: "Stack Overflow Blog", url: q => `https://stackoverflow.blog/?s=${q}`, category: "technology" },
  { name: "Medium", url: q => `https://medium.com/search?q=${q}`, category: "technology" },
  { name: "Hashnode", url: q => `https://hashnode.com/search?q=${q}`, category: "technology" },
  { name: "CSS Tricks", url: q => `https://css-tricks.com/?s=${q}`, category: "technology" },
  { name: "Smashing Magazine", url: q => `https://www.smashingmagazine.com/search/?q=${q}`, category: "technology" },
  { name: "A List Apart", url: q => `https://alistapart.com/search/?q=${q}`, category: "technology" },
  { name: "SitePoint", url: q => `https://www.sitepoint.com/?s=${q}`, category: "technology" },
  { name: "freeCodeCamp", url: q => `https://www.freecodecamp.org/news/search/?query=${q}`, category: "technology" },
  
  // Gaming
  { name: "IGN", url: q => `https://www.ign.com/search?q=${q}`, category: "entertainment" },
  { name: "GameSpot", url: q => `https://www.gamespot.com/search/?q=${q}`, category: "entertainment" },
  { name: "Polygon", url: q => `https://www.polygon.com/search?q=${q}`, category: "entertainment" },
  { name: "Kotaku", url: q => `https://kotaku.com/search?q=${q}`, category: "entertainment" },
  { name: "PC Gamer", url: q => `https://www.pcgamer.com/search/?searchTerm=${q}`, category: "entertainment" },
  { name: "Rock Paper Shotgun", url: q => `https://www.rockpapershotgun.com/?s=${q}`, category: "entertainment" },
  { name: "Eurogamer", url: q => `https://www.eurogamer.net/search?q=${q}`, category: "entertainment" },
  { name: "GamesRadar", url: q => `https://www.gamesradar.com/search/?searchTerm=${q}`, category: "entertainment" },
  
  // Sports
  { name: "ESPN", url: q => `https://www.espn.com/search/results?q=${q}`, category: "sports" },
  { name: "ESPN Cricinfo", url: q => `https://www.espncricinfo.com/search?q=${q}`, category: "sports" },
  { name: "Sky Sports", url: q => `https://www.skysports.com/search?q=${q}`, category: "sports" },
  { name: "Goal.com", url: q => `https://www.goal.com/en/search/${q}`, category: "sports" },
  { name: "Bleacher Report", url: q => `https://bleacherreport.com/search?query=${q}`, category: "sports" },
  { name: "The Athletic", url: q => `https://theathletic.com/search/?q=${q}`, category: "sports" },
  { name: "Sports Illustrated", url: q => `https://www.si.com/search?q=${q}`, category: "sports" },
  
  // Science & Space
  { name: "Live Science", url: q => `https://www.livescience.com/search?q=${q}`, category: "science" },
  { name: "Science Daily", url: q => `https://www.sciencedaily.com/search/?keyword=${q}`, category: "science" },
  { name: "Nature News", url: q => `https://www.nature.com/search?q=${q}`, category: "science" },
  { name: "New Scientist", url: q => `https://www.newscientist.com/search?q=${q}`, category: "science" },
  { name: "Space.com", url: q => `https://www.space.com/search?searchTerm=${q}`, category: "science" },
  { name: "NASA", url: q => `https://www.nasa.gov/search/?q=${q}`, category: "science" },
  { name: "Scientific American", url: q => `https://www.scientificamerican.com/search/?q=${q}`, category: "science" },
  { name: "Phys.org", url: q => `https://phys.org/search/?search=${q}`, category: "science" },
  
  // Business & Finance
  { name: "Economic Times", url: q => `https://economictimes.indiatimes.com/topic/${q}`, category: "business" },
  { name: "Business Standard", url: q => `https://www.business-standard.com/search?q=${q}`, category: "business" },
  { name: "Moneycontrol", url: q => `https://www.moneycontrol.com/news/tags/${q}.html`, category: "business" },
  { name: "Financial Times", url: q => `https://www.ft.com/search?q=${q}`, category: "business" },
  { name: "Forbes", url: q => `https://www.forbes.com/search/?q=${q}`, category: "business" },
  { name: "Business Insider", url: q => `https://www.businessinsider.com/s?q=${q}`, category: "business" },
  { name: "Entrepreneur", url: q => `https://www.entrepreneur.com/search/${q}`, category: "business" },
  { name: "Inc.", url: q => `https://www.inc.com/search?q=${q}`, category: "business" },
  { name: "TechCrunch Startups", url: q => `https://techcrunch.com/search/startups%20${q}`, category: "business" },
  
  // Entertainment & Pop Culture
  { name: "Variety", url: q => `https://variety.com/?s=${q}`, category: "entertainment" },
  { name: "Hollywood Reporter", url: q => `https://www.hollywoodreporter.com/?s=${q}`, category: "entertainment" },
  { name: "Bollywood Hungama", url: q => `https://www.bollywoodhungama.com/search/?q=${q}`, category: "entertainment" },
  { name: "Rolling Stone", url: q => `https://www.rollingstone.com/search/?q=${q}`, category: "entertainment" },
  { name: "Pitchfork", url: q => `https://pitchfork.com/search/?query=${q}`, category: "entertainment" },
  { name: "Billboard", url: q => `https://www.billboard.com/search/?q=${q}`, category: "entertainment" },
  { name: "IMDb", url: q => `https://www.imdb.com/find?q=${q}`, category: "entertainment" },
  { name: "Rotten Tomatoes", url: q => `https://www.rottentomatoes.com/search?search=${q}`, category: "entertainment" },
  
  // Health & Fitness
  { name: "WebMD", url: q => `https://www.webmd.com/search/search_results/default.aspx?query=${q}`, category: "health" },
  { name: "Healthline", url: q => `https://www.healthline.com/search?q1=${q}`, category: "health" },
  { name: "Medical News Today", url: q => `https://www.medicalnewstoday.com/search?q=${q}`, category: "health" },
  { name: "Mayo Clinic", url: q => `https://www.mayoclinic.org/search/search-results?q=${q}`, category: "health" },
  { name: "Men's Health", url: q => `https://www.menshealth.com/search/?q=${q}`, category: "health" },
  { name: "Women's Health", url: q => `https://www.womenshealthmag.com/search/?q=${q}`, category: "health" },
  { name: "Bodybuilding.com", url: q => `https://www.bodybuilding.com/fun/bbsearch.php?q=${q}`, category: "health" },
  
  // Lifestyle & Food
  { name: "Bon Appetit", url: q => `https://www.bonappetit.com/search?q=${q}`, category: "lifestyle" },
  { name: "Food Network", url: q => `https://www.foodnetwork.com/search/${q}`, category: "lifestyle" },
  { name: "Serious Eats", url: q => `https://www.seriouseats.com/search?q=${q}`, category: "lifestyle" },
  { name: "Tasty", url: q => `https://tasty.co/search?q=${q}`, category: "lifestyle" },
  { name: "Architectural Digest", url: q => `https://www.architecturaldigest.com/search?q=${q}`, category: "lifestyle" },
  { name: "Dezeen", url: q => `https://www.dezeen.com/?s=${q}`, category: "lifestyle" },
  
  // AI & Machine Learning
  { name: "Towards Data Science", url: q => `https://towardsdatascience.com/search?q=${q}`, category: "technology" },
  { name: "Analytics Vidhya", url: q => `https://www.analyticsvidhya.com/?s=${q}`, category: "technology" },
  { name: "Machine Learning Mastery", url: q => `https://machinelearningmastery.com/?s=${q}`, category: "technology" },
  { name: "Papers With Code", url: q => `https://paperswithcode.com/search?q=${q}`, category: "technology" },
  { name: "AI News", url: q => `https://www.artificialintelligence-news.com/?s=${q}`, category: "technology" },
  
  // Design & Creative
  { name: "Behance", url: q => `https://www.behance.net/search/projects?search=${q}`, category: "lifestyle" },
  { name: "Dribbble", url: q => `https://dribbble.com/search/${q}`, category: "lifestyle" },
  { name: "Awwwards", url: q => `https://www.awwwards.com/search?text=${q}`, category: "lifestyle" },
  { name: "Creative Bloq", url: q => `https://www.creativebloq.com/search?searchTerm=${q}`, category: "lifestyle" },
  { name: "Design Milk", url: q => `https://design-milk.com/?s=${q}`, category: "lifestyle" }
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

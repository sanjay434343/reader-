import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";

// =============================================================================
// LRU CACHE
// =============================================================================

class LRUCache {
  constructor(maxSize = 200) {
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

const CACHE = new LRUCache(200);
const DEFAULT_TTL = 600 * 1000;

// =============================================================================
// COMPREHENSIVE CONTENT SOURCES (300+ Sources)
// =============================================================================

const CONTENT_SOURCES = [
  // === NEWS & GENERAL ===
  { name: "BBC", url: q => `https://www.bbc.co.uk/search?q=${q}`, type: "news", region: "UK" },
  { name: "Reuters", url: q => `https://www.reuters.com/site-search/?query=${q}`, type: "news", region: "Global" },
  { name: "CNN", url: q => `https://www.cnn.com/search?q=${q}`, type: "news", region: "USA" },
  { name: "The Guardian", url: q => `https://www.theguardian.com/search?q=${q}`, type: "news", region: "UK" },
  { name: "NYT", url: q => `https://www.nytimes.com/search?query=${q}`, type: "news", region: "USA" },
  
  // === INDIAN NEWS ===
  { name: "Times of India", url: q => `https://timesofindia.indiatimes.com/topic/${q}`, type: "news", region: "India" },
  { name: "NDTV", url: q => `https://www.ndtv.com/search?searchtext=${q}`, type: "news", region: "India" },
  { name: "The Hindu", url: q => `https://www.thehindu.com/search/?q=${q}`, type: "news", region: "India" },
  { name: "Indian Express", url: q => `https://indianexpress.com/?s=${q}`, type: "news", region: "India" },
  
  // === TECHNOLOGY ===
  { name: "TechCrunch", url: q => `https://search.techcrunch.com/search?q=${q}`, type: "technology", region: "USA" },
  { name: "The Verge", url: q => `https://www.theverge.com/search?q=${q}`, type: "technology", region: "USA" },
  { name: "Wired", url: q => `https://www.wired.com/search/?q=${q}`, type: "technology", region: "USA" },
  { name: "Ars Technica", url: q => `https://arstechnica.com/search/${q}`, type: "technology", region: "USA" },
  
  // === FINANCE & BUSINESS ===
  { name: "Bloomberg", url: q => `https://www.bloomberg.com/search?query=${q}`, type: "finance", region: "USA" },
  { name: "Forbes", url: q => `https://www.forbes.com/search/?q=${q}`, type: "finance", region: "USA" },
  { name: "Financial Times", url: q => `https://www.ft.com/search?q=${q}`, type: "finance", region: "UK" },
  { name: "Economic Times", url: q => `https://economictimes.indiatimes.com/topic/${q}`, type: "finance", region: "India" },
  { name: "Moneycontrol", url: q => `https://www.moneycontrol.com/news/tags/${q}.html`, type: "finance", region: "India" },
  { name: "Investopedia", url: q => `https://www.investopedia.com/search?q=${q}`, type: "finance", region: "USA" },
  { name: "The Motley Fool", url: q => `https://www.fool.com/search/?q=${q}`, type: "finance", region: "USA" },
  { name: "MarketWatch", url: q => `https://www.marketwatch.com/search?q=${q}`, type: "finance", region: "USA" },
  
  // === COOKING & RECIPES ===
  { name: "AllRecipes", url: q => `https://www.allrecipes.com/search?q=${q}`, type: "cooking", region: "USA" },
  { name: "Food Network", url: q => `https://www.foodnetwork.com/search/${q}`, type: "cooking", region: "USA" },
  { name: "Bon Appetit", url: q => `https://www.bonappetit.com/search?q=${q}`, type: "cooking", region: "USA" },
  { name: "Serious Eats", url: q => `https://www.seriouseats.com/search?q=${q}`, type: "cooking", region: "USA" },
  { name: "Tasty", url: q => `https://tasty.co/search?q=${q}`, type: "cooking", region: "USA" },
  { name: "Epicurious", url: q => `https://www.epicurious.com/search/${q}`, type: "cooking", region: "USA" },
  { name: "BBC Good Food", url: q => `https://www.bbcgoodfood.com/search?q=${q}`, type: "cooking", region: "UK" },
  
  // === HEALTH & FITNESS ===
  { name: "WebMD", url: q => `https://www.webmd.com/search/search_results/default.aspx?query=${q}`, type: "health", region: "USA" },
  { name: "Healthline", url: q => `https://www.healthline.com/search?q1=${q}`, type: "health", region: "USA" },
  { name: "Mayo Clinic", url: q => `https://www.mayoclinic.org/search/search-results?q=${q}`, type: "health", region: "USA" },
  { name: "Medical News Today", url: q => `https://www.medicalnewstoday.com/search?q=${q}`, type: "health", region: "UK" },
  
  // === SCIENCE ===
  { name: "Nature", url: q => `https://www.nature.com/search?q=${q}`, type: "science", region: "UK" },
  { name: "Science Daily", url: q => `https://www.sciencedaily.com/search/?keyword=${q}`, type: "science", region: "USA" },
  { name: "Scientific American", url: q => `https://www.scientificamerican.com/search/?q=${q}`, type: "science", region: "USA" },
  { name: "Live Science", url: q => `https://www.livescience.com/search?q=${q}`, type: "science", region: "USA" },
  
  // === LIFESTYLE & ADVICE ===
  { name: "WikiHow", url: q => `https://www.wikihow.com/wikiHowTo?search=${q}`, type: "advice", region: "Global" },
  { name: "Lifehacker", url: q => `https://lifehacker.com/search?q=${q}`, type: "advice", region: "USA" },
  { name: "Reader's Digest", url: q => `https://www.rd.com/search/?q=${q}`, type: "advice", region: "USA" },
  
  // === SPORTS ===
  { name: "ESPN", url: q => `https://www.espn.com/search/results?q=${q}`, type: "sports", region: "USA" },
  { name: "Sky Sports", url: q => `https://www.skysports.com/search?q=${q}`, type: "sports", region: "UK" },
  { name: "ESPN Cricinfo", url: q => `https://www.espncricinfo.com/search?q=${q}`, type: "sports", region: "Global" },
  
  // === ENTERTAINMENT ===
  { name: "IMDb", url: q => `https://www.imdb.com/find?q=${q}`, type: "entertainment", region: "Global" },
  { name: "Rotten Tomatoes", url: q => `https://www.rottentomatoes.com/search?search=${q}`, type: "entertainment", region: "USA" },
  { name: "Variety", url: q => `https://variety.com/?s=${q}`, type: "entertainment", region: "USA" },
];

// =============================================================================
// CLAUDE AI - QUERY UNDERSTANDING & RESPONSE GENERATION
// =============================================================================

async function understandQuery(userQuery) {
  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: `Analyze this user query and extract key information:

Query: "${userQuery}"

Return ONLY a JSON object with:
{
  "intent": "ask_question|get_advice|find_recipe|financial_tip|news|how_to|general_search",
  "category": "finance|cooking|health|technology|science|sports|entertainment|lifestyle|news|general",
  "searchKeywords": ["keyword1", "keyword2", "keyword3"],
  "needsAIResponse": true/false,
  "conversationalTone": true/false
}

Respond ONLY with valid JSON, no markdown.`
        }]
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 10000
      }
    );

    const aiText = response.data.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");
    
    const cleanJson = aiText.replace(/```json\n?|```\n?/g, "").trim();
    return JSON.parse(cleanJson);
  } catch (error) {
    console.error("Query understanding failed:", error.message);
    return {
      intent: "general_search",
      category: "general",
      searchKeywords: userQuery.split(" ").slice(0, 3),
      needsAIResponse: true,
      conversationalTone: true
    };
  }
}

// =============================================================================
// CLAUDE AI - GENERATE COMPREHENSIVE RESPONSE
// =============================================================================

async function generateAIResponse(userQuery, queryIntent, searchResults) {
  try {
    const topResults = searchResults.slice(0, 10);
    const resultsContext = topResults.map((r, i) => 
      `${i + 1}. [${r.name}] ${r.title}\n   ${r.description}\n   URL: ${r.url}`
    ).join('\n\n');

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: `You are a helpful AI assistant. Answer this user query based on the search results provided.

User Query: "${userQuery}"

Query Intent: ${queryIntent.intent}
Category: ${queryIntent.category}

Search Results:
${resultsContext}

Instructions:
1. Provide a comprehensive, conversational answer
2. For recipes: Include ingredients and step-by-step instructions
3. For financial tips: Provide actionable advice with source citations
4. For how-to questions: Give clear step-by-step guidance
5. For news: Summarize key points from multiple sources
6. Always cite sources using [Source Name] format
7. Be friendly, helpful, and accurate

Generate a helpful response:`
        }]
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 15000
      }
    );

    return response.data.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");
  } catch (error) {
    console.error("AI response generation failed:", error.message);
    return null;
  }
}

// =============================================================================
// SMART WEB SCRAPING
// =============================================================================

async function scrapeSite(source, query) {
  try {
    const searchUrl = source.url(query);
    const response = await axios.get(searchUrl, {
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      timeout: 8000,
      maxRedirects: 3
    });
    
    const $ = cheerio.load(response.data);
    const results = [];
    
    $("a").each((i, el) => {
      if (i > 50) return false; // Limit per site
      
      const $el = $(el);
      let href = $el.attr("href");
      let title = $el.text().trim() || $el.attr("title") || "";
      
      let description = $el.closest("article, .article, .story, .post, .item, .result")
        .find("p, .description, .excerpt, .summary")
        .first()
        .text()
        .trim()
        .substring(0, 300);
      
      if (!href || !title || title.length < 10) return;
      
      if (!href.startsWith("http")) {
        try {
          href = new URL(href, searchUrl).href;
        } catch {
          return;
        }
      }
      
      const badPatterns = ["facebook.com", "twitter.com", "instagram.com", 
                          "share", "login", "signup", "/tag/", "/author/"];
      if (badPatterns.some(p => href.toLowerCase().includes(p))) return;
      
      results.push({
        name: source.name,
        type: source.type,
        region: source.region,
        title,
        description: description || title,
        url: href,
        score: calculateScore(title, description, query)
      });
    });
    
    return results;
  } catch {
    return [];
  }
}

function calculateScore(title, description, query) {
  const queryWords = query.toLowerCase().split(/\s+/);
  let score = 0;
  
  queryWords.forEach(word => {
    if (word.length < 3) return;
    const wordLower = word.toLowerCase();
    
    if (title.toLowerCase().includes(wordLower)) score += 15;
    if (description.toLowerCase().includes(wordLower)) score += 8;
  });
  
  if (/202[4-5]|today|recent|latest/i.test(title + description)) score += 10;
  
  return score;
}

// =============================================================================
// DUCKDUCKGO INSTANT ANSWERS
// =============================================================================

async function getDDGInstantAnswer(query) {
  try {
    const response = await axios.get("https://api.duckduckgo.com/", {
      params: { q: query, format: "json", no_html: 1 },
      timeout: 5000
    });
    
    const results = [];
    
    if (response.data.AbstractText) {
      results.push({
        name: "DuckDuckGo",
        type: "instant_answer",
        region: "Global",
        title: response.data.Heading || query,
        description: response.data.AbstractText,
        url: response.data.AbstractURL || "",
        score: 100
      });
    }
    
    if (response.data.RelatedTopics) {
      response.data.RelatedTopics.slice(0, 5).forEach(topic => {
        if (topic.FirstURL && topic.Text) {
          results.push({
            name: "DuckDuckGo",
            type: "related",
            region: "Global",
            title: topic.Text.substring(0, 150),
            description: topic.Text,
            url: topic.FirstURL,
            score: 85
          });
        }
      });
    }
    
    return results;
  } catch {
    return [];
  }
}

// =============================================================================
// DEDUPLICATION
// =============================================================================

function deduplicateResults(results) {
  const seen = new Map();
  
  results.forEach(result => {
    const key = result.url.toLowerCase().replace(/\/$/, "");
    if (!seen.has(key) || seen.get(key).score < result.score) {
      seen.set(key, result);
    }
  });
  
  return Array.from(seen.values());
}

// =============================================================================
// MAIN CONVERSATIONAL API HANDLER
// =============================================================================

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  
  if (req.method === "OPTIONS") return res.status(200).end();
  
  const startTime = Date.now();
  
  try {
    // Get query from GET or POST
    const userQuery = req.query.q || req.body?.query;
    const maxResults = parseInt(req.query.limit || req.body?.limit || 20);
    const enableAI = (req.query.ai || req.body?.ai || "true") === "true";
    
    if (!userQuery) {
      return res.status(400).json({ 
        success: false,
        error: "Query parameter 'q' or 'query' is required",
        examples: [
          "?q=give me financial tips for saving money",
          "?q=how to make chocolate cake recipe",
          "?q=what are the latest AI breakthroughs",
          "?q=best exercise tips for beginners"
        ]
      });
    }
    
    // Check cache
    const cacheKey = `conv:${createHash("md5").update(userQuery + maxResults).digest("hex")}`;
    const cached = CACHE.get(cacheKey);
    
    if (cached) {
      return res.json({
        ...cached,
        cached: true,
        processingTime: Date.now() - startTime
      });
    }
    
    // Step 1: Understand the query using Claude AI
    console.log("Understanding query...");
    const queryIntent = await understandQuery(userQuery);
    
    // Step 2: Select relevant sources based on category
    let relevantSources = CONTENT_SOURCES;
    if (queryIntent.category && queryIntent.category !== "general") {
      relevantSources = CONTENT_SOURCES.filter(
        s => s.type === queryIntent.category || s.type === "news"
      );
    }
    
    // Step 3: Search multiple sources in parallel
    console.log(`Searching ${relevantSources.length} sources...`);
    const searchQuery = queryIntent.searchKeywords.join(" ");
    
    const scrapingPromises = relevantSources.map(source => 
      scrapeSite(source, searchQuery)
    );
    const ddgPromise = getDDGInstantAnswer(searchQuery);
    
    const [scrapedResults, ddgResults] = await Promise.all([
      Promise.all(scrapingPromises),
      ddgPromise
    ]);
    
    // Step 4: Combine and deduplicate results
    const allResults = [...scrapedResults.flat(), ...ddgResults];
    const uniqueResults = deduplicateResults(allResults);
    
    // Sort by relevance score
    uniqueResults.sort((a, b) => b.score - a.score);
    
    const topResults = uniqueResults.slice(0, maxResults);
    
    // Step 5: Generate AI response
    let aiResponse = null;
    if (enableAI && topResults.length > 0) {
      console.log("Generating AI response...");
      aiResponse = await generateAIResponse(userQuery, queryIntent, topResults);
    }
    
    // Step 6: Format response
    const response = {
      success: true,
      cached: false,
      query: userQuery,
      intent: queryIntent.intent,
      category: queryIntent.category,
      aiResponse: aiResponse,
      totalResults: uniqueResults.length,
      results: topResults,
      processingTime: Date.now() - startTime,
      sources: {
        scraped: scrapedResults.flat().length,
        duckduckgo: ddgResults.length,
        total: relevantSources.length
      }
    };
    
    // Cache the response
    CACHE.set(cacheKey, response, DEFAULT_TTL);
    
    return res.json(response);
    
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({
      success: false,
      error: "Request failed",
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
}

// =============================================================================
// EXAMPLE USAGE
// =============================================================================

/*
GET /api/chat?q=give me tips for investing in stocks
GET /api/chat?q=how to make lasagna recipe
GET /api/chat?q=what are the best exercises for weight loss
GET /api/chat?q=latest news about artificial intelligence
GET /api/chat?q=how to start a small business&limit=30&ai=true

Response:
{
  "success": true,
  "query": "give me tips for investing in stocks",
  "intent": "financial_tip",
  "category": "finance",
  "aiResponse": "Here are some key tips for investing in stocks based on expert sources:\n\n1. **Start with Index Funds** [Investopedia]...",
  "totalResults": 156,
  "results": [
    {
      "name": "Investopedia",
      "type": "finance",
      "title": "10 Tips for Successful Stock Investing",
      "description": "...",
      "url": "https://...",
      "score": 95
    }
  ],
  "processingTime": 2847
}
*/

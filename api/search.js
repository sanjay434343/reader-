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

const CACHE = new LRUCache(150);
const DEFAULT_TTL = 600 * 1000;

// =============================================================================
// COMPREHENSIVE WORLDWIDE NEWS SOURCES
// =============================================================================

const NEWS_SITES = [
  // === INDIAN NEWS ===
  { name: "Indian Express", url: q => `https://indianexpress.com/?s=${q}`, category: "general", region: "India" },
  { name: "Times of India", url: q => `https://timesofindia.indiatimes.com/topic/${q}`, category: "general", region: "India" },
  { name: "NDTV", url: q => `https://www.ndtv.com/search?searchtext=${q}`, category: "general", region: "India" },
  { name: "Hindustan Times", url: q => `https://www.hindustantimes.com/search?q=${q}`, category: "general", region: "India" },
  { name: "The Hindu", url: q => `https://www.thehindu.com/search/?q=${q}`, category: "general", region: "India" },
  { name: "India Today", url: q => `https://www.indiatoday.in/search?searchtext=${q}`, category: "general", region: "India" },
  { name: "News18", url: q => `https://www.news18.com/search?q=${q}`, category: "general", region: "India" },
  { name: "The Wire", url: q => `https://thewire.in/?s=${q}`, category: "politics", region: "India" },
  { name: "Scroll.in", url: q => `https://scroll.in/search?q=${q}`, category: "general", region: "India" },
  { name: "ThePrint", url: q => `https://theprint.in/?s=${q}`, category: "politics", region: "India" },
  { name: "News Minute", url: q => `https://www.thenewsminute.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Firstpost", url: q => `https://www.firstpost.com/search/${q}`, category: "general", region: "India" },
  { name: "Quint", url: q => `https://www.thequint.com/search/${q}`, category: "general", region: "India" },
  
  // === INTERNATIONAL NEWS ===
  { name: "BBC", url: q => `https://www.bbc.co.uk/search?q=${q}`, category: "general", region: "UK" },
  { name: "Reuters", url: q => `https://www.reuters.com/site-search/?query=${q}`, category: "general", region: "Global" },
  { name: "Al Jazeera", url: q => `https://www.aljazeera.com/search/${q}`, category: "general", region: "Qatar" },
  { name: "CNN", url: q => `https://www.cnn.com/search?q=${q}`, category: "general", region: "USA" },
  { name: "The Guardian", url: q => `https://www.theguardian.com/search?q=${q}`, category: "general", region: "UK" },
  { name: "Associated Press", url: q => `https://apnews.com/search?q=${q}`, category: "general", region: "USA" },
  { name: "NPR", url: q => `https://www.npr.org/search?query=${q}`, category: "general", region: "USA" },
  { name: "New York Times", url: q => `https://www.nytimes.com/search?query=${q}`, category: "general", region: "USA" },
  { name: "Washington Post", url: q => `https://www.washingtonpost.com/search?query=${q}`, category: "general", region: "USA" },
  { name: "The Atlantic", url: q => `https://www.theatlantic.com/search/?q=${q}`, category: "general", region: "USA" },
  { name: "Politico", url: q => `https://www.politico.com/search?q=${q}`, category: "politics", region: "USA" },
  { name: "Foreign Policy", url: q => `https://foreignpolicy.com/search/${q}`, category: "politics", region: "USA" },
  { name: "The Economist", url: q => `https://www.economist.com/search?q=${q}`, category: "business", region: "UK" },
  { name: "France24", url: q => `https://www.france24.com/en/search/${q}`, category: "general", region: "France" },
  { name: "Deutsche Welle", url: q => `https://www.dw.com/search/?searchNavigationId=9097&languageCode=en&item=${q}`, category: "general", region: "Germany" },
  { name: "South China Morning Post", url: q => `https://www.scmp.com/search/${q}`, category: "general", region: "Hong Kong" },
  { name: "Japan Times", url: q => `https://www.japantimes.co.jp/?s=${q}`, category: "general", region: "Japan" },
  { name: "Straits Times", url: q => `https://www.straitstimes.com/search/${q}`, category: "general", region: "Singapore" },
  { name: "Arab News", url: q => `https://www.arabnews.com/search?search=${q}`, category: "general", region: "Saudi Arabia" },
  { name: "Moscow Times", url: q => `https://www.themoscowtimes.com/search?q=${q}`, category: "general", region: "Russia" },
  
  // === TECHNOLOGY & INNOVATION ===
  { name: "The Verge", url: q => `https://www.theverge.com/search?q=${q}`, category: "technology", region: "USA" },
  { name: "TechCrunch", url: q => `https://search.techcrunch.com/search?q=${q}`, category: "technology", region: "USA" },
  { name: "Ars Technica", url: q => `https://arstechnica.com/search/${q}`, category: "technology", region: "USA" },
  { name: "Wired", url: q => `https://www.wired.com/search/?q=${q}`, category: "technology", region: "USA" },
  { name: "ZDNet", url: q => `https://www.zdnet.com/search/?q=${q}`, category: "technology", region: "USA" },
  { name: "The Next Web", url: q => `https://thenextweb.com/search?query=${q}`, category: "technology", region: "Netherlands" },
  { name: "Engadget", url: q => `https://www.engadget.com/search/?q=${q}`, category: "technology", region: "USA" },
  { name: "CNET", url: q => `https://www.cnet.com/search/?query=${q}`, category: "technology", region: "USA" },
  { name: "Tech Radar", url: q => `https://www.techradar.com/search?searchTerm=${q}`, category: "technology", region: "UK" },
  { name: "Digital Trends", url: q => `https://www.digitaltrends.com/search/?q=${q}`, category: "technology", region: "USA" },
  { name: "Tom's Hardware", url: q => `https://www.tomshardware.com/search?searchTerm=${q}`, category: "technology", region: "USA" },
  { name: "AnandTech", url: q => `https://www.anandtech.com/search?searchTerm=${q}`, category: "technology", region: "USA" },
  { name: "VentureBeat", url: q => `https://venturebeat.com/?s=${q}`, category: "technology", region: "USA" },
  { name: "Silicon Angle", url: q => `https://siliconangle.com/?s=${q}`, category: "technology", region: "USA" },
  { name: "TechSpot", url: q => `https://www.techspot.com/search/?q=${q}`, category: "technology", region: "USA" },
  { name: "Gizmodo", url: q => `https://gizmodo.com/search?q=${q}`, category: "technology", region: "USA" },
  { name: "Mashable", url: q => `https://mashable.com/search?q=${q}`, category: "technology", region: "USA" },
  { name: "Lifehacker", url: q => `https://lifehacker.com/search?q=${q}`, category: "technology", region: "USA" },
  
  // === MOBILE & ANDROID ===
  { name: "Android Authority", url: q => `https://www.androidauthority.com/?s=${q}`, category: "technology", region: "USA" },
  { name: "Android Police", url: q => `https://www.androidpolice.com/?s=${q}`, category: "technology", region: "USA" },
  { name: "Android Central", url: q => `https://www.androidcentral.com/search?q=${q}`, category: "technology", region: "USA" },
  { name: "XDA Developers", url: q => `https://www.xda-developers.com/?s=${q}`, category: "technology", region: "USA" },
  { name: "9to5Google", url: q => `https://9to5google.com/?s=${q}`, category: "technology", region: "USA" },
  { name: "9to5Mac", url: q => `https://9to5mac.com/?s=${q}`, category: "technology", region: "USA" },
  { name: "MacRumors", url: q => `https://www.macrumors.com/search/?q=${q}`, category: "technology", region: "USA" },
  { name: "iMore", url: q => `https://www.imore.com/search?q=${q}`, category: "technology", region: "USA" },
  { name: "PhoneArena", url: q => `https://www.phonearena.com/search?term=${q}`, category: "technology", region: "USA" },
  { name: "GSMArena", url: q => `https://www.gsmarena.com/results.php3?sQuickSearch=yes&sName=${q}`, category: "technology", region: "Global" },
  { name: "Pocket Lint", url: q => `https://www.pocket-lint.com/search/?q=${q}`, category: "technology", region: "UK" },
  
  // === AI & MACHINE LEARNING ===
  { name: "Towards Data Science", url: q => `https://towardsdatascience.com/search?q=${q}`, category: "technology", region: "Global" },
  { name: "Analytics Vidhya", url: q => `https://www.analyticsvidhya.com/?s=${q}`, category: "technology", region: "India" },
  { name: "Machine Learning Mastery", url: q => `https://machinelearningmastery.com/?s=${q}`, category: "technology", region: "Global" },
  { name: "Papers With Code", url: q => `https://paperswithcode.com/search?q=${q}`, category: "technology", region: "Global" },
  { name: "AI News", url: q => `https://www.artificialintelligence-news.com/?s=${q}`, category: "technology", region: "UK" },
  { name: "MIT Technology Review", url: q => `https://www.technologyreview.com/search?s=${q}`, category: "technology", region: "USA" },
  { name: "OpenAI Blog", url: q => `https://openai.com/blog?search=${q}`, category: "technology", region: "USA" },
  { name: "Google AI Blog", url: q => `https://blog.google/technology/ai/?q=${q}`, category: "technology", region: "USA" },
  { name: "DeepMind", url: q => `https://deepmind.google/discover/blog/?q=${q}`, category: "technology", region: "UK" },
  
  // === DEVELOPER COMMUNITIES ===
  { name: "Dev.to", url: q => `https://dev.to/search?q=${q}`, category: "technology", region: "Global" },
  { name: "Hacker News", url: q => `https://hn.algolia.com/?q=${q}`, category: "technology", region: "Global" },
  { name: "Stack Overflow Blog", url: q => `https://stackoverflow.blog/?s=${q}`, category: "technology", region: "Global" },
  { name: "Medium", url: q => `https://medium.com/search?q=${q}`, category: "technology", region: "Global" },
  { name: "Hashnode", url: q => `https://hashnode.com/search?q=${q}`, category: "technology", region: "Global" },
  { name: "CSS Tricks", url: q => `https://css-tricks.com/?s=${q}`, category: "technology", region: "USA" },
  { name: "Smashing Magazine", url: q => `https://www.smashingmagazine.com/search/?q=${q}`, category: "technology", region: "Germany" },
  { name: "A List Apart", url: q => `https://alistapart.com/search/?q=${q}`, category: "technology", region: "USA" },
  { name: "SitePoint", url: q => `https://www.sitepoint.com/?s=${q}`, category: "technology", region: "Australia" },
  { name: "freeCodeCamp", url: q => `https://www.freecodecamp.org/news/search/?query=${q}`, category: "technology", region: "Global" },
  { name: "GitHub Blog", url: q => `https://github.blog/search/${q}`, category: "technology", region: "USA" },
  { name: "CodeProject", url: q => `https://www.codeproject.com/search.aspx?q=${q}`, category: "technology", region: "Global" },
  
  // === GAMING ===
  { name: "IGN", url: q => `https://www.ign.com/search?q=${q}`, category: "entertainment", region: "USA" },
  { name: "GameSpot", url: q => `https://www.gamespot.com/search/?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Polygon", url: q => `https://www.polygon.com/search?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Kotaku", url: q => `https://kotaku.com/search?q=${q}`, category: "entertainment", region: "USA" },
  { name: "PC Gamer", url: q => `https://www.pcgamer.com/search/?searchTerm=${q}`, category: "entertainment", region: "UK" },
  { name: "Rock Paper Shotgun", url: q => `https://www.rockpapershotgun.com/?s=${q}`, category: "entertainment", region: "UK" },
  { name: "Eurogamer", url: q => `https://www.eurogamer.net/search?q=${q}`, category: "entertainment", region: "UK" },
  { name: "GamesRadar", url: q => `https://www.gamesradar.com/search/?searchTerm=${q}`, category: "entertainment", region: "UK" },
  { name: "GameRant", url: q => `https://gamerant.com/search/${q}`, category: "entertainment", region: "Canada" },
  { name: "Destructoid", url: q => `https://www.destructoid.com/search/${q}`, category: "entertainment", region: "USA" },
  
  // === SPORTS ===
  { name: "ESPN", url: q => `https://www.espn.com/search/results?q=${q}`, category: "sports", region: "USA" },
  { name: "ESPN Cricinfo", url: q => `https://www.espncricinfo.com/search?q=${q}`, category: "sports", region: "Global" },
  { name: "Sky Sports", url: q => `https://www.skysports.com/search?q=${q}`, category: "sports", region: "UK" },
  { name: "Goal.com", url: q => `https://www.goal.com/en/search/${q}`, category: "sports", region: "Global" },
  { name: "Bleacher Report", url: q => `https://bleacherreport.com/search?query=${q}`, category: "sports", region: "USA" },
  { name: "The Athletic", url: q => `https://theathletic.com/search/?q=${q}`, category: "sports", region: "USA" },
  { name: "Sports Illustrated", url: q => `https://www.si.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "Sportstar", url: q => `https://sportstar.thehindu.com/search/?q=${q}`, category: "sports", region: "India" },
  { name: "Olympics.com", url: q => `https://olympics.com/en/search?q=${q}`, category: "sports", region: "Global" },
  
  // === SCIENCE & SPACE ===
  { name: "Live Science", url: q => `https://www.livescience.com/search?q=${q}`, category: "science", region: "USA" },
  { name: "Science Daily", url: q => `https://www.sciencedaily.com/search/?keyword=${q}`, category: "science", region: "USA" },
  { name: "Nature News", url: q => `https://www.nature.com/search?q=${q}`, category: "science", region: "UK" },
  { name: "New Scientist", url: q => `https://www.newscientist.com/search?q=${q}`, category: "science", region: "UK" },
  { name: "Space.com", url: q => `https://www.space.com/search?searchTerm=${q}`, category: "science", region: "USA" },
  { name: "NASA", url: q => `https://www.nasa.gov/search/?q=${q}`, category: "science", region: "USA" },
  { name: "Scientific American", url: q => `https://www.scientificamerican.com/search/?q=${q}`, category: "science", region: "USA" },
  { name: "Phys.org", url: q => `https://phys.org/search/?search=${q}`, category: "science", region: "Global" },
  { name: "Science News", url: q => `https://www.sciencenews.org/?s=${q}`, category: "science", region: "USA" },
  { name: "Astronomy", url: q => `https://www.astronomy.com/search?q=${q}`, category: "science", region: "USA" },
  { name: "ESA", url: q => `https://www.esa.int/search?q=${q}`, category: "science", region: "Europe" },
  
  // === BUSINESS & FINANCE ===
  { name: "Economic Times", url: q => `https://economictimes.indiatimes.com/topic/${q}`, category: "business", region: "India" },
  { name: "Business Standard", url: q => `https://www.business-standard.com/search?q=${q}`, category: "business", region: "India" },
  { name: "Moneycontrol", url: q => `https://www.moneycontrol.com/news/tags/${q}.html`, category: "business", region: "India" },
  { name: "LiveMint", url: q => `https://www.livemint.com/Search/Link/Keyword/${q}`, category: "business", region: "India" },
  { name: "Financial Times", url: q => `https://www.ft.com/search?q=${q}`, category: "business", region: "UK" },
  { name: "Forbes", url: q => `https://www.forbes.com/search/?q=${q}`, category: "business", region: "USA" },
  { name: "Bloomberg", url: q => `https://www.bloomberg.com/search?query=${q}`, category: "business", region: "USA" },
  { name: "Business Insider", url: q => `https://www.businessinsider.com/s?q=${q}`, category: "business", region: "USA" },
  { name: "Entrepreneur", url: q => `https://www.entrepreneur.com/search/${q}`, category: "business", region: "USA" },
  { name: "Inc.", url: q => `https://www.inc.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "Fortune", url: q => `https://fortune.com/search/${q}`, category: "business", region: "USA" },
  { name: "Harvard Business Review", url: q => `https://hbr.org/search?term=${q}`, category: "business", region: "USA" },
  { name: "MarketWatch", url: q => `https://www.marketwatch.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "CNBC", url: q => `https://www.cnbc.com/search/?query=${q}`, category: "business", region: "USA" },
  
  // === ENTERTAINMENT ===
  { name: "Variety", url: q => `https://variety.com/?s=${q}`, category: "entertainment", region: "USA" },
  { name: "Hollywood Reporter", url: q => `https://www.hollywoodreporter.com/?s=${q}`, category: "entertainment", region: "USA" },
  { name: "Bollywood Hungama", url: q => `https://www.bollywoodhungama.com/search/?q=${q}`, category: "entertainment", region: "India" },
  { name: "Rolling Stone", url: q => `https://www.rollingstone.com/search/?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Pitchfork", url: q => `https://pitchfork.com/search/?query=${q}`, category: "entertainment", region: "USA" },
  { name: "Billboard", url: q => `https://www.billboard.com/search/?q=${q}`, category: "entertainment", region: "USA" },
  { name: "IMDb", url: q => `https://www.imdb.com/find?q=${q}`, category: "entertainment", region: "Global" },
  { name: "Rotten Tomatoes", url: q => `https://www.rottentomatoes.com/search?search=${q}`, category: "entertainment", region: "USA" },
  { name: "Screen Rant", url: q => `https://screenrant.com/search/${q}`, category: "entertainment", region: "USA" },
  { name: "Comic Book", url: q => `https://comicbook.com/search/${q}`, category: "entertainment", region: "USA" },
  
  // === HEALTH & FITNESS ===
  { name: "WebMD", url: q => `https://www.webmd.com/search/search_results/default.aspx?query=${q}`, category: "health", region: "USA" },
  { name: "Healthline", url: q => `https://www.healthline.com/search?q1=${q}`, category: "health", region: "USA" },
  { name: "Medical News Today", url: q => `https://www.medicalnewstoday.com/search?q=${q}`, category: "health", region: "UK" },
  { name: "Mayo Clinic", url: q => `https://www.mayoclinic.org/search/search-results?q=${q}`, category: "health", region: "USA" },
  { name: "Men's Health", url: q => `https://www.menshealth.com/search/?q=${q}`, category: "health", region: "USA" },
  { name: "Women's Health", url: q => `https://www.womenshealthmag.com/search/?q=${q}`, category: "health", region: "USA" },
  { name: "Bodybuilding.com", url: q => `https://www.bodybuilding.com/fun/bbsearch.php?q=${q}`, category: "health", region: "USA" },
  { name: "Verywell Health", url: q => `https://www.verywellhealth.com/search?q=${q}`, category: "health", region: "USA" },
  
  // === LIFESTYLE & FOOD ===
  { name: "Bon Appetit", url: q => `https://www.bonappetit.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Food Network", url: q => `https://www.foodnetwork.com/search/${q}`, category: "lifestyle", region: "USA" },
  { name: "Serious Eats", url: q => `https://www.seriouseats.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Tasty", url: q => `https://tasty.co/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Architectural Digest", url: q => `https://www.architecturaldigest.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Dezeen", url: q => `https://www.dezeen.com/?s=${q}`, category: "lifestyle", region: "UK" },
  { name: "Conde Nast Traveler", url: q => `https://www.cntraveler.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Travel + Leisure", url: q => `https://www.travelandleisure.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  
  // === DESIGN & CREATIVE ===
  { name: "Behance", url: q => `https://www.behance.net/search/projects?search=${q}`, category: "lifestyle", region: "Global" },
  { name: "Dribbble", url: q => `https://dribbble.com/search/${q}`, category: "lifestyle", region: "Global" },
  { name: "Awwwards", url: q => `https://www.awwwards.com/search?text=${q}`, category: "lifestyle", region: "Global" },
  { name: "Creative Bloq", url: q => `https://www.creativebloq.com/search?searchTerm=${q}`, category: "lifestyle", region: "UK" },
  { name: "Design Milk", url: q => `https://design-milk.com/?s=${q}`, category: "lifestyle", region: "USA" },
  
  // === CRYPTOCURRENCY & BLOCKCHAIN ===
  { name: "CoinDesk", url: q => `https://www.coindesk.com/search?s=${q}`, category: "business", region: "USA" },
  { name: "CoinTelegraph", url: q => `https://cointelegraph.com/search?query=${q}`, category: "business", region: "Global" },
  { name: "Decrypt", url: q => `https://decrypt.co/search?q=${q}`, category: "business", region: "USA" },
  { name: "The Block", url: q => `https://www.theblock.co/search?query=${q}`, category: "business", region: "USA" },
  
  // === AUTOMOTIVE ===
  { name: "Motor Trend", url: q => `https://www.motortrend.com/search/${q}`, category: "lifestyle", region: "USA" },
  { name: "Car and Driver", url: q => `https://www.caranddriver.com/search/?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Top Gear", url: q => `https://www.topgear.com/search?q=${q}`, category: "lifestyle", region: "UK" },
  { name: "Autoblog", url: q => `https://www.autoblog.com/search/?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "CarDekho", url: q => `https://www.cardekho.com/search?q=${q}`, category: "lifestyle", region: "India" },
  
  // === CLIMATE & ENVIRONMENT ===
  { name: "Climate Home News", url: q => `https://www.climatechangenews.com/?s=${q}`, category: "science", region: "UK" },
  { name: "Carbon Brief", url: q => `https://www.carbonbrief.org/?s=${q}`, category: "science", region: "UK" },
  { name: "Inside Climate News", url: q => `https://insideclimatenews.org/?s=${q}`, category: "science", region: "USA" },
  { name: "Grist", url: q => `https://grist.org/search/?q=${q}`, category: "science", region: "USA" },
  
  // === EDUCATION ===
  { name: "EdSurge", url: q => `https://www.edsurge.com/search?q=${q}`, category: "general", region: "USA" },
  { name: "THE Campus", url: q => `https://www.timeshighereducation.com/search?search=${q}`, category: "general", region: "UK" },
  { name: "Education Week", url: q => `https://www.edweek.org/search?query=${q}`, category: "general", region: "USA" }
];

// =============================================================================
// CLAUDE AI INTEGRATION FOR INTELLIGENT URL SELECTION
// =============================================================================

async function analyzeWithClaude(query, results) {
  try {
    const topResults = results.slice(0, 15);
    
    const resultsText = topResults.map((r, i) => 
      `${i + 1}. [${r.site}] ${r.title}\n   URL: ${r.url}\n   Score: ${r.score}`
    ).join('\n\n');
    
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: `Analyze these search results for the query: "${query}"

${resultsText}

Return ONLY a JSON object with:
1. "bestUrls": array of 3-5 most relevant, authoritative, and recent URLs
2. "reasoning": brief explanation of why these URLs are best
3. "category": most appropriate category (technology/business/science/sports/entertainment/health/politics/general)

Consider:
- Source credibility and authority
- Content relevance to query
- Recency indicators
- Article depth and quality
- Diverse perspectives

Respond ONLY with valid JSON, no markdown.`
          }
        ]
      },
      {
        headers: {
          "Content-Type": "application/json"
        },
        timeout: 10000
      }
    );
    
    const aiText = response.data.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");
    
    const cleanJson = aiText.replace(/```json\n?|```\n?/g, "").trim();
    const analysis = JSON.parse(cleanJson);
    
    return analysis;
  } catch (error) {
    console.error("Claude AI analysis failed:", error.message);
    return null;
  }
}

// =============================================================================
// FALLBACK AI USING POLLINATIONS
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
// DIRECT WEB SEARCH USING DUCKDUCKGO API
// =============================================================================

async function searchDuckDuckGo(query) {
  try {
    const response = await axios.get(`https://api.duckduckgo.com/`, {
      params: {
        q: query,
        format: 'json',
        no_html: 1,
        skip_disambig: 1
      },
      timeout: 5000
    });
    
    const results = [];
    
    if (response.data.AbstractURL) {
      results.push({
        site: "DuckDuckGo",
        category: "general",
        title: response.data.Heading || query,
        description: response.data.AbstractText || "",
        url: response.data.AbstractURL,
        score: 100,
        region: "Global"
      });
    }
    
    if (response.data.RelatedTopics) {
      response.data.RelatedTopics.forEach(topic => {
        if (topic.FirstURL && topic.Text) {
          results.push({
            site: "DuckDuckGo",
            category: "general",
            title: topic.Text.substring(0, 200),
            description: topic.Text,
            url: topic.FirstURL,
            score: 80,
            region: "Global"
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
// SMART URL VALIDATION
// =============================================================================

function isValidArticle(url) {
  if (!url) return false;
  
  const badPatterns = [
    "facebook.com", "twitter.com", "x.com", "pinterest.com", "instagram.com",
    "whatsapp.com", "mailto:", "javascript:", "/tag/", "/topic/", "/category/",
    "share", "subscribe", "login", "signup", "account", "privacy", "terms",
    "/author/", "/page/", "cookie"
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
  
  // Boost recent articles
  if (/202[4-5]|today|hours ago|minutes ago|yesterday/i.test(text)) score += 8;
  
  // Boost authoritative sources
  const authoritativeDomains = ["bbc", "reuters", "cnn", "nytimes", "guardian", "nature", "science"];
  if (authoritativeDomains.some(domain => url.includes(domain))) score += 12;
  
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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5"
      },
      timeout: 8000,
      maxRedirects: 3
    });
    
    const $ = cheerio.load(response.data);
    const results = [];
    
    $("a").each((i, el) => {
      const $el = $(el);
      let href = $el.attr("href");
      let title = $el.text().trim() || $el.attr("title") || $el.attr("aria-label") || "";
      
      let description = $el.closest("article, .article, .story, .post, .item")
        .find("p, .description, .excerpt, .summary")
        .first()
        .text()
        .trim()
        .substring(0, 200);
      
      if (!href || !title || title.length < 10) return;
      
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
        region: site.region,
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
    const urlKey = result.url.toLowerCase().replace(/\/$/, "");
    const titleKey = result.title.toLowerCase().trim();
    
    if (!urlMap.has(urlKey) || urlMap.get(urlKey).score < result.score) {
      urlMap.set(urlKey, result);
    }
    
    if (!titleMap.has(titleKey) || titleMap.get(titleKey).score < result.score) {
      titleMap.set(titleKey, result);
    }
  });
  
  const merged = new Map();
  [...urlMap.values(), ...titleMap.values()].forEach(result => {
    if (!merged.has(result.url) || merged.get(result.url).score < result.score) {
      merged.set(result.url, result);
    }
  });
  
  return Array.from(merged.values());
}

// =============================================================================
// MAIN SEARCH HANDLER WITH CLAUDE AI ENHANCEMENT
// =============================================================================

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  
  if (req.method === "OPTIONS") return res.status(200).end();
  
  const startTime = Date.now();
  
  try {
    const { 
      q: query, 
      limit = 20, 
      category: userCategory,
      region: userRegion,
      useAI = "true" 
    } = req.query;
    
    if (!query) {
      return res.status(400).json({ 
        error: "Query parameter 'q' is required",
        usage: "?q=<search_term>&limit=<number>&category=<optional>&region=<optional>&useAI=<true|false>"
      });
    }
    
    // Check cache
    const cacheKey = `search:${createHash("md5").update(query + userCategory + userRegion).digest("hex")}`;
    const cached = CACHE.get(cacheKey);
    
    if (cached) {
      return res.json({
        success: true,
        cached: true,
        ...cached,
        processingTime: Date.now() - startTime
      });
    }
    
    // AI category detection (parallel)
    const categoryPromise = userCategory ? Promise.resolve(userCategory) : detectCategory(query);
    
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    
    // Get category
    const detectedCategory = await categoryPromise;
    
    // Filter sites by category and region
    let filteredSites = NEWS_SITES;
    
    if (detectedCategory && detectedCategory !== "general") {
      filteredSites = filteredSites.filter(
        site => site.category === detectedCategory || site.category === "general"
      );
    }
    
    if (userRegion) {
      filteredSites = filteredSites.filter(
        site => site.region === userRegion || site.region === "Global"
      );
    }
    
    // Parallel scraping + DuckDuckGo search
    const scrapingPromises = filteredSites.map(site => 
      scrapeSite(site, query, queryWords)
    );
    
    const duckDuckGoPromise = searchDuckDuckGo(query);
    
    const [scrapedResults, ddgResults] = await Promise.all([
      Promise.all(scrapingPromises),
      duckDuckGoPromise
    ]);
    
    const allResults = [...scrapedResults.flat(), ...ddgResults];
    
    // Deduplicate
    const uniqueResults = deduplicateResults(allResults);
    
    // Sort by score
    uniqueResults.sort((a, b) => b.score - a.score);
    
    // Get top results
    const topResults = uniqueResults.slice(0, parseInt(limit) * 2);
    
    // AI-powered URL selection (if enabled)
    let bestUrls = topResults.slice(0, 5).map(r => r.url);
    let aiReasoning = null;
    let aiCategory = detectedCategory;
    
    if (useAI === "true" && topResults.length > 0) {
      const aiAnalysis = await analyzeWithClaude(query, topResults);
      
      if (aiAnalysis) {
        bestUrls = aiAnalysis.bestUrls || bestUrls;
        aiReasoning = aiAnalysis.reasoning;
        aiCategory = aiAnalysis.category || detectedCategory;
      }
    }
    
    // Filter top results to match limit
    const finalResults = topResults.slice(0, parseInt(limit));
    
    const response = {
      success: true,
      cached: false,
      query,
      detectedCategory: aiCategory,
      totalResults: uniqueResults.length,
      topResults: finalResults.length,
      bestUrls,
      aiReasoning,
      results: finalResults,
      processingTime: Date.now() - startTime,
      sources: {
        traditional: scrapedResults.flat().length,
        duckduckgo: ddgResults.length
      }
    };
    
    // Cache response
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

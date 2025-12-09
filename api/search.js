// api/search.js
import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "crypto";

/**
 * Vercel serverless endpoint: /api/search?q=...
 *
 * Behavior:
 * - detect category via Pollinations
 * - scrape a selection of news sites (fast)
 * - create ranked results
 * - pick best urls (Pollinations + fallback)
 * - for each best url: fetch reader API -> get fullText -> chunk (~5000 chars) ->
 *   summarize each chunk via Pollinations
 * - merge chunk summaries via Pollinations to produce:
 *    - merged short summary
 *    - 10-point simple-English learning list (1..10)
 * - return minimal output:
 *    { success, query, detectedCategory, results: [{title,url}], unifiedSummary, timeMs }
 *
 * Notes:
 * - Adds a 2000ms (2 second) delay between processing each article (sequential)
 * - Keep API keys none (we call free pollinations endpoints). If you use a paid LLM,
 *   replace analyzeWithPollinations/summarizeWithPollinations/mergeSummaries with your calls.
 */

// -------------------- Config --------------------
const CHUNK_SIZE = 5000; // Option B: medium ~5000 chars
const FETCH_TIMEOUT = 12000;
const POLLINATIONS_TIMEOUT = 12000;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const MAX_SITES = 12; // limit sites for speed
const MAX_RESULTS = 20;

// -------------------- Simple in-memory cache --------------------
const CACHE = new Map();
function getCache(key) {
  const item = CACHE.get(key);
  if (!item) return null;
  if (Date.now() - item.time > item.ttl) {
    CACHE.delete(key);
    return null;
  }
  return item.data;
}
function setCache(key, data, ttl = CACHE_TTL) {
  CACHE.set(key, { data, time: Date.now(), ttl });
}

// -------------------- Axios instances --------------------
const http = axios.create({
  timeout: FETCH_TIMEOUT,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; SearchBot/1.0)" }
});

const pollinationsHttp = axios.create({
  timeout: POLLINATIONS_TIMEOUT,
  headers: { "User-Agent": "PollinationsClient/1.0" }
});

// -------------------- NEWS SITES (trimmed large list; you can expand) --------------------
const NEWS_SITES = [
  // === GENERAL NEWS - INDIA (50 sources) ===
  { name: "Indian Express", url: q => `https://indianexpress.com/?s=${q}`, category: "general", region: "India" },
  { name: "Times of India", url: q => `https://timesofindia.indiatimes.com/topic/${q}`, category: "general", region: "India" },
  { name: "NDTV", url: q => `https://www.ndtv.com/search?searchtext=${q}`, category: "general", region: "India" },
  { name: "Hindustan Times", url: q => `https://www.hindustantimes.com/search?q=${q}`, category: "general", region: "India" },
  { name: "The Hindu", url: q => `https://www.thehindu.com/search/?q=${q}`, category: "general", region: "India" },
  { name: "India Today", url: q => `https://www.indiatoday.in/search?searchtext=${q}`, category: "general", region: "India" },
  { name: "News18", url: q => `https://www.news18.com/search?q=${q}`, category: "general", region: "India" },
  { name: "The Wire", url: q => `https://thewire.in/?s=${q}`, category: "general", region: "India" },
  { name: "Scroll.in", url: q => `https://scroll.in/search?q=${q}`, category: "general", region: "India" },
  { name: "ThePrint", url: q => `https://theprint.in/?s=${q}`, category: "general", region: "India" },
  { name: "News Minute", url: q => `https://www.thenewsminute.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Firstpost", url: q => `https://www.firstpost.com/search/${q}`, category: "general", region: "India" },
  { name: "Quint", url: q => `https://www.thequint.com/search/${q}`, category: "general", region: "India" },
  { name: "Deccan Herald", url: q => `https://www.deccanherald.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Deccan Chronicle", url: q => `https://www.deccanchronicle.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Mumbai Mirror", url: q => `https://mumbaimirror.indiatimes.com/search?q=${q}`, category: "general", region: "India" },
  { name: "DNA India", url: q => `https://www.dnaindia.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Free Press Journal", url: q => `https://www.freepressjournal.in/search?q=${q}`, category: "general", region: "India" },
  { name: "OneIndia", url: q => `https://www.oneindia.com/search/${q}`, category: "general", region: "India" },
  { name: "Swarajya", url: q => `https://swarajyamag.com/?s=${q}`, category: "general", region: "India" },
  { name: "Outlook India", url: q => `https://www.outlookindia.com/search?q=${q}`, category: "general", region: "India" },
  { name: "India TV", url: q => `https://www.indiatvnews.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Zee News", url: q => `https://zeenews.india.com/search?q=${q}`, category: "general", region: "India" },
  { name: "ABP News", url: q => `https://www.abplive.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Aaj Tak", url: q => `https://www.aajtak.in/search?q=${q}`, category: "general", region: "India" },
  { name: "Rediff", url: q => `https://www.rediff.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Business Line", url: q => `https://www.thehindubusinessline.com/search/?q=${q}`, category: "general", region: "India" },
  { name: "Telegraph India", url: q => `https://www.telegraphindia.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Asian Age", url: q => `https://www.asianage.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Pioneer", url: q => `https://www.dailypioneer.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Tribune India", url: q => `https://www.tribuneindia.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Assam Tribune", url: q => `https://www.assamtribune.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Statesman", url: q => `https://www.thestatesman.com/?s=${q}`, category: "general", region: "India" },
  { name: "Mint Lounge", url: q => `https://lifestyle.livemint.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Hans India", url: q => `https://www.thehansindia.com/search?q=${q}`, category: "general", region: "India" },
  { name: "New Indian Express", url: q => `https://www.newindianexpress.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Dainik Jagran", url: q => `https://www.jagran.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Navbharat Times", url: q => `https://navbharattimes.indiatimes.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Eenadu", url: q => `https://www.eenadu.net/search?q=${q}`, category: "general", region: "India" },
  { name: "Lokmat", url: q => `https://www.lokmat.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Mathrubhumi", url: q => `https://www.mathrubhumi.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Manorama", url: q => `https://www.manoramaonline.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Dinamalar", url: q => `https://www.dinamalar.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Dinamani", url: q => `https://www.dinamani.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Sakshi", url: q => `https://www.sakshi.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Prabhat Khabar", url: q => `https://www.prabhatkhabar.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Amar Ujala", url: q => `https://www.amarujala.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Punjab Kesari", url: q => `https://www.punjabkesari.in/search?q=${q}`, category: "general", region: "India" },
  { name: "Naidunia", url: q => `https://www.naidunia.com/search?q=${q}`, category: "general", region: "India" },
  { name: "Rajasthan Patrika", url: q => `https://www.patrika.com/search?q=${q}`, category: "general", region: "India" },

  // === INTERNATIONAL NEWS (80 sources) ===
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
  { name: "Politico", url: q => `https://www.politico.com/search?q=${q}`, category: "general", region: "USA" },
  { name: "Foreign Policy", url: q => `https://foreignpolicy.com/search/${q}`, category: "general", region: "USA" },
  { name: "The Economist", url: q => `https://www.economist.com/search?q=${q}`, category: "general", region: "UK" },
  { name: "France24", url: q => `https://www.france24.com/en/search/${q}`, category: "general", region: "France" },
  { name: "Deutsche Welle", url: q => `https://www.dw.com/search/?searchNavigationId=9097&languageCode=en&item=${q}`, category: "general", region: "Germany" },
  { name: "South China Morning Post", url: q => `https://www.scmp.com/search/${q}`, category: "general", region: "Hong Kong" },
  { name: "Japan Times", url: q => `https://www.japantimes.co.jp/?s=${q}`, category: "general", region: "Japan" },
  { name: "Straits Times", url: q => `https://www.straitstimes.com/search/${q}`, category: "general", region: "Singapore" },
  { name: "Arab News", url: q => `https://www.arabnews.com/search?search=${q}`, category: "general", region: "Saudi Arabia" },
  { name: "Moscow Times", url: q => `https://www.themoscowtimes.com/search?q=${q}`, category: "general", region: "Russia" },
  { name: "The Independent", url: q => `https://www.independent.co.uk/search?q=${q}`, category: "general", region: "UK" },
  { name: "Daily Mail", url: q => `https://www.dailymail.co.uk/home/search.html?q=${q}`, category: "general", region: "UK" },
  { name: "Mirror", url: q => `https://www.mirror.co.uk/search/?q=${q}`, category: "general", region: "UK" },
  { name: "Express", url: q => `https://www.express.co.uk/search?s=${q}`, category: "general", region: "UK" },
  { name: "The Sun", url: q => `https://www.thesun.co.uk/?s=${q}`, category: "general", region: "UK" },
  { name: "Sky News", url: q => `https://news.sky.com/search?q=${q}`, category: "general", region: "UK" },
  { name: "ITV News", url: q => `https://www.itv.com/news/search?q=${q}`, category: "general", region: "UK" },
  { name: "Channel 4 News", url: q => `https://www.channel4.com/news/search?q=${q}`, category: "general", region: "UK" },
  { name: "USA Today", url: q => `https://www.usatoday.com/search/?q=${q}`, category: "general", region: "USA" },
  { name: "LA Times", url: q => `https://www.latimes.com/search?q=${q}`, category: "general", region: "USA" },
  { name: "Chicago Tribune", url: q => `https://www.chicagotribune.com/search?q=${q}`, category: "general", region: "USA" },
  { name: "Boston Globe", url: q => `https://www.bostonglobe.com/search?q=${q}`, category: "general", region: "USA" },
  { name: "San Francisco Chronicle", url: q => `https://www.sfchronicle.com/search/?q=${q}`, category: "general", region: "USA" },
  { name: "Miami Herald", url: q => `https://www.miamiherald.com/search?q=${q}`, category: "general", region: "USA" },
  { name: "Dallas Morning News", url: q => `https://www.dallasnews.com/search/?q=${q}`, category: "general", region: "USA" },
  { name: "Houston Chronicle", url: q => `https://www.houstonchronicle.com/search/?q=${q}`, category: "general", region: "USA" },
  { name: "Philadelphia Inquirer", url: q => `https://www.inquirer.com/search?q=${q}`, category: "general", region: "USA" },
  { name: "Seattle Times", url: q => `https://www.seattletimes.com/search/?q=${q}`, category: "general", region: "USA" },
  { name: "Denver Post", url: q => `https://www.denverpost.com/?s=${q}`, category: "general", region: "USA" },
  { name: "Arizona Republic", url: q => `https://www.azcentral.com/search/?q=${q}`, category: "general", region: "USA" },
  { name: "ABC News", url: q => `https://abcnews.go.com/search?searchtext=${q}`, category: "general", region: "USA" },
  { name: "CBS News", url: q => `https://www.cbsnews.com/search/?q=${q}`, category: "general", region: "USA" },
  { name: "NBC News", url: q => `https://www.nbcnews.com/search/?q=${q}`, category: "general", region: "USA" },
  { name: "Fox News", url: q => `https://www.foxnews.com/search-results/search?q=${q}`, category: "general", region: "USA" },
  { name: "MSNBC", url: q => `https://www.msnbc.com/search/?q=${q}`, category: "general", region: "USA" },
  { name: "Newsweek", url: q => `https://www.newsweek.com/search/site/${q}`, category: "general", region: "USA" },
  { name: "Time", url: q => `https://time.com/search/?q=${q}`, category: "general", region: "USA" },
  { name: "Vice", url: q => `https://www.vice.com/en/search?query=${q}`, category: "general", region: "USA" },
  { name: "Vox", url: q => `https://www.vox.com/search?q=${q}`, category: "general", region: "USA" },
  { name: "Axios", url: q => `https://www.axios.com/search?q=${q}`, category: "general", region: "USA" },
  { name: "ProPublica", url: q => `https://www.propublica.org/search?q=${q}`, category: "general", region: "USA" },
  { name: "Mother Jones", url: q => `https://www.motherjones.com/search/?q=${q}`, category: "general", region: "USA" },
  { name: "The Nation", url: q => `https://www.thenation.com/search/?q=${q}`, category: "general", region: "USA" },
  { name: "National Review", url: q => `https://www.nationalreview.com/search/?q=${q}`, category: "general", region: "USA" },
  { name: "Breitbart", url: q => `https://www.breitbart.com/?s=${q}`, category: "general", region: "USA" },
  { name: "Daily Beast", url: q => `https://www.thedailybeast.com/search?q=${q}`, category: "general", region: "USA" },
  { name: "HuffPost", url: q => `https://www.huffpost.com/search?q=${q}`, category: "general", region: "USA" },
  { name: "BuzzFeed News", url: q => `https://www.buzzfeednews.com/search?q=${q}`, category: "general", region: "USA" },
  { name: "Globe and Mail", url: q => `https://www.theglobeandmail.com/search/?q=${q}`, category: "general", region: "Canada" },
  { name: "Toronto Star", url: q => `https://www.thestar.com/search/?q=${q}`, category: "general", region: "Canada" },
  { name: "CBC", url: q => `https://www.cbc.ca/search?q=${q}`, category: "general", region: "Canada" },
  { name: "CTV News", url: q => `https://www.ctvnews.ca/search?q=${q}`, category: "general", region: "Canada" },
  { name: "National Post", url: q => `https://nationalpost.com/search/?q=${q}`, category: "general", region: "Canada" },
  { name: "Sydney Morning Herald", url: q => `https://www.smh.com.au/search?q=${q}`, category: "general", region: "Australia" },
  { name: "The Age", url: q => `https://www.theage.com.au/search?q=${q}`, category: "general", region: "Australia" },
  { name: "ABC Australia", url: q => `https://www.abc.net.au/search/?query=${q}`, category: "general", region: "Australia" },
  { name: "The Australian", url: q => `https://www.theaustralian.com.au/search?q=${q}`, category: "general", region: "Australia" },
  { name: "News.com.au", url: q => `https://www.news.com.au/search?q=${q}`, category: "general", region: "Australia" },
  { name: "NZ Herald", url: q => `https://www.nzherald.co.nz/search/?q=${q}`, category: "general", region: "New Zealand" },
  { name: "Stuff.co.nz", url: q => `https://www.stuff.co.nz/search?q=${q}`, category: "general", region: "New Zealand" },
  { name: "RNZ", url: q => `https://www.rnz.co.nz/search?q=${q}`, category: "general", region: "New Zealand" },
  { name: "Irish Times", url: q => `https://www.irishtimes.com/search?q=${q}`, category: "general", region: "Ireland" },
  { name: "RTE", url: q => `https://www.rte.ie/search/?q=${q}`, category: "general", region: "Ireland" },
  { name: "Euronews", url: q => `https://www.euronews.com/search?query=${q}`, category: "general", region: "Europe" },
  { name: "EUobserver", url: q => `https://euobserver.com/search?q=${q}`, category: "general", region: "Europe" },
  { name: "Politico Europe", url: q => `https://www.politico.eu/search/?q=${q}`, category: "general", region: "Europe" },

  // === TECHNOLOGY (80 sources) ===
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
  { name: "Towards Data Science", url: q => `https://towardsdatascience.com/search?q=${q}`, category: "technology", region: "Global" },
  { name: "Analytics Vidhya", url: q => `https://www.analyticsvidhya.com/?s=${q}`, category: "technology", region: "India" },
  { name: "Machine Learning Mastery", url: q => `https://machinelearningmastery.com/?s=${q}`, category: "technology", region: "Global" },
  { name: "Papers With Code", url: q => `https://paperswithcode.com/search?q=${q}`, category: "technology", region: "Global" },
  { name: "AI News", url: q => `https://www.artificialintelligence-news.com/?s=${q}`, category: "technology", region: "UK" },
  { name: "MIT Technology Review", url: q => `https://www.technologyreview.com/search?s=${q}`, category: "technology", region: "USA" },
  { name: "OpenAI Blog", url: q => `https://openai.com/blog?search=${q}`, category: "technology", region: "USA" },
  { name: "Google AI Blog", url: q => `https://blog.google/technology/ai/?q=${q}`, category: "technology", region: "USA" },
  { name: "DeepMind", url: q => `https://deepmind.google/discover/blog/?q=${q}`, category: "technology", region: "UK" },
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
  { name: "InfoQ", url: q => `https://www.infoq.com/search.action?queryString=${q}`, category: "technology", region: "Global" },
  { name: "DZone", url: q => `https://dzone.com/search?q=${q}`, category: "technology", region: "USA" },
  { name: "JAXenter", url: q => `https://jaxenter.com/?s=${q}`, category: "technology", region: "Germany" },
  { name: "SDTimes", url: q => `https://sdtimes.com/?s=${q}`, category: "technology", region: "USA" },
  { name: "TechRepublic", url: q => `https://www.techrepublic.com/search/?q=${q}`, category: "technology", region: "USA" },
  { name: "ComputerWorld", url: q => `https://www.computerworld.com/search?q=${q}`, category: "technology", region: "USA" },
  { name: "InformationWeek", url: q => `https://www.informationweek.com/search?q=${q}`, category: "technology", region: "USA" },
  { name: "Network World", url: q => `https://www.networkworld.com/search?q=${q}`, category: "technology", region: "USA" },
  { name: "Dark Reading", url: q => `https://www.darkreading.com/search?q=${q}`, category: "technology", region: "USA" },
  { name: "Security Week", url: q => `https://www.securityweek.com/search/${q}`, category: "technology", region: "USA" },
  { name: "Krebs on Security", url: q => `https://krebsonsecurity.com/?s=${q}`, category: "technology", region: "USA" },
  { name: "Threatpost", url: q => `https://threatpost.com/?s=${q}`, category: "technology", region: "USA" },
  { name: "The Hacker News", url: q => `https://thehackernews.com/search?q=${q}`, category: "technology", region: "USA" },
  { name: "Bleeping Computer", url: q => `https://www.bleepingcomputer.com/search/?q=${q}`, category: "technology", region: "USA" },
  { name: "How-To Geek", url: q => `https://www.howtogeek.com/search/?q=${q}`, category: "technology", region: "USA" },
  { name: "MakeUseOf", url: q => `https://www.makeuseof.com/search/${q}`, category: "technology", region: "USA" },
  { name: "TechTarget", url: q => `https://www.techtarget.com/search/query?q=${q}`, category: "technology", region: "USA" },
  { name: "PCMag", url: q => `https://www.pcmag.com/search?searchTerm=${q}`, category: "technology", region: "USA" },
  { name: "PCWorld", url: q => `https://www.pcworld.com/search?q=${q}`, category: "technology", region: "USA" },
  { name: "Laptop Mag", url: q => `https://www.laptopmag.com/search?searchTerm=${q}`, category: "technology", region: "USA" },
  { name: "Tom's Guide", url: q => `https://www.tomsguide.com/search?searchTerm=${q}`, category: "technology", region: "USA" },
  { name: "CIOL", url: q => `https://www.ciol.com/?s=${q}`, category: "technology", region: "India" },
  { name: "Gadgets 360", url: q => `https://gadgets.ndtv.com/search?searchtext=${q}`, category: "technology", region: "India" },
  { name: "BGR India", url: q => `https://www.bgr.in/?s=${q}`, category: "technology", region: "India" },
  { name: "91mobiles", url: q => `https://www.91mobiles.com/search?text=${q}`, category: "technology", region: "India" },
  { name: "MySmartPrice", url: q => `https://www.mysmartprice.com/search/${q}`, category: "technology", region: "India" },
  { name: "Digit", url: q => `https://www.digit.in/search?q=${q}`, category: "technology", region: "India" },

  // === BUSINESS & FINANCE (70 sources) ===
  { name: "Bloomberg", url: q => `https://www.bloomberg.com/search?query=${q}`, category: "business", region: "USA" },
  { name: "Financial Times", url: q => `https://www.ft.com/search?q=${q}`, category: "business", region: "UK" },
  { name: "Wall Street Journal", url: q => `https://www.wsj.com/search?query=${q}`, category: "business", region: "USA" },
  { name: "Forbes", url: q => `https://www.forbes.com/search/?q=${q}`, category: "business", region: "USA" },
  { name: "Fortune", url: q => `https://fortune.com/search/${q}`, category: "business", region: "USA" },
  { name: "Business Insider", url: q => `https://www.businessinsider.com/s?q=${q}`, category: "business", region: "USA" },
  { name: "CNBC", url: q => `https://www.cnbc.com/search/?query=${q}`, category: "business", region: "USA" },
  { name: "MarketWatch", url: q => `https://www.marketwatch.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "Yahoo Finance", url: q => `https://finance.yahoo.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "Seeking Alpha", url: q => `https://seekingalpha.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "The Motley Fool", url: q => `https://www.fool.com/search/?q=${q}`, category: "business", region: "USA" },
  { name: "Investopedia", url: q => `https://www.investopedia.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "Barron's", url: q => `https://www.barrons.com/search?query=${q}`, category: "business", region: "USA" },
  { name: "Inc.", url: q => `https://www.inc.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "Fast Company", url: q => `https://www.fastcompany.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "Harvard Business Review", url: q => `https://hbr.org/search?term=${q}`, category: "business", region: "USA" },
  { name: "McKinsey Insights", url: q => `https://www.mckinsey.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "Deloitte Insights", url: q => `https://www2.deloitte.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "PwC Insights", url: q => `https://www.pwc.com/search?q=${q}`, category: "business", region: "Global" },
  { name: "EY Insights", url: q => `https://www.ey.com/search?q=${q}`, category: "business", region: "Global" },
  { name: "BCG Perspectives", url: q => `https://www.bcg.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "Bain Insights", url: q => `https://www.bain.com/search/?q=${q}`, category: "business", region: "USA" },
  { name: "Strategy+Business", url: q => `https://www.strategy-business.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "Quartz", url: q => `https://qz.com/search/${q}`, category: "business", region: "USA" },
  { name: "Morning Brew", url: q => `https://www.morningbrew.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "The Information", url: q => `https://www.theinformation.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "Economic Times", url: q => `https://economictimes.indiatimes.com/searchresult.cms?query=${q}`, category: "business", region: "India" },
  { name: "Business Standard", url: q => `https://www.business-standard.com/search?q=${q}`, category: "business", region: "India" },
  { name: "Mint", url: q => `https://www.livemint.com/Search/Link/Search/${q}`, category: "business", region: "India" },
  { name: "Financial Express", url: q => `https://www.financialexpress.com/search/?q=${q}`, category: "business", region: "India" },
  { name: "MoneyControl", url: q => `https://www.moneycontrol.com/search/result.php?search=${q}`, category: "business", region: "India" },
  { name: "BloombergQuint", url: q => `https://www.bloombergquint.com/search?q=${q}`, category: "business", region: "India" },
  { name: "YourStory", url: q => `https://yourstory.com/search?q=${q}`, category: "business", region: "India" },
  { name: "Inc42", url: q => `https://inc42.com/?s=${q}`, category: "business", region: "India" },
  { name: "Entrackr", url: q => `https://entrackr.com/?s=${q}`, category: "business", region: "India" },
  { name: "The Ken", url: q => `https://the-ken.com/search/?q=${q}`, category: "business", region: "India" },
  { name: "VCCircle", url: q => `https://www.vccircle.com/search?q=${q}`, category: "business", region: "India" },
  { name: "DealStreetAsia", url: q => `https://www.dealstreetasia.com/?s=${q}`, category: "business", region: "Singapore" },
  { name: "Nikkei Asia", url: q => `https://asia.nikkei.com/search?q=${q}`, category: "business", region: "Japan" },
  { name: "CaixinGlobal", url: q => `https://www.caixinglobal.com/search/?q=${q}`, category: "business", region: "China" },
  { name: "Business Times Singapore", url: q => `https://www.businesstimes.com.sg/search?q=${q}`, category: "business", region: "Singapore" },
  { name: "The Asset", url: q => `https://www.theasset.com/search?q=${q}`, category: "business", region: "Hong Kong" },
  { name: "FinanceAsia", url: q => `https://www.financeasia.com/search?q=${q}`, category: "business", region: "Hong Kong" },
  { name: "Asian Investor", url: q => `https://www.asianinvestor.net/search?q=${q}`, category: "business", region: "Hong Kong" },
  { name: "Campaign Asia", url: q => `https://www.campaignasia.com/search?q=${q}`, category: "business", region: "Hong Kong" },
  { name: "Marketing Interactive", url: q => `https://www.marketing-interactive.com/?s=${q}`, category: "business", region: "Singapore" },
  { name: "Retail Asia", url: q => `https://retailasia.com/search?q=${q}`, category: "business", region: "Singapore" },
  { name: "Banking Exchange", url: q => `https://www.bankingexchange.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "American Banker", url: q => `https://www.americanbanker.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "The Banker", url: q => `https://www.thebanker.com/search?q=${q}`, category: "business", region: "UK" },
  { name: "Investment News", url: q => `https://www.investmentnews.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "Pension & Investments", url: q => `https://www.pionline.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "Institutional Investor", url: q => `https://www.institutionalinvestor.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "Alternative Investment News", url: q => `https://www.ainonline.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "Private Equity International", url: q => `https://www.privateequityinternational.com/search?q=${q}`, category: "business", region: "UK" },
  { name: "Venture Capital Journal", url: q => `https://www.venturecapitaljournal.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "CFO Dive", url: q => `https://www.cfodive.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "CFO.com", url: q => `https://www.cfo.com/search/?q=${q}`, category: "business", region: "USA" },
  { name: "Accounting Today", url: q => `https://www.accountingtoday.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "Journal of Accountancy", url: q => `https://www.journalofaccountancy.com/search?q=${q}`, category: "business", region: "USA" },
  { name: "Real Estate Weekly", url: q => `https://rew-online.com/?s=${q}`, category: "business", region: "USA" },
  { name: "Commercial Observer", url: q => `https://commercialobserver.com/?s=${q}`, category: "business", region: "USA" },
  { name: "Retail Dive", url: q => `https://www.retaildive.com/search/?q=${q}`, category: "business", region: "USA" },
  { name: "Supply Chain Dive", url: q => `https://www.supplychaindive.com/search/?q=${q}`, category: "business", region: "USA" },
  { name: "Manufacturing Dive", url: q => `https://www.manufacturingdive.com/search/?q=${q}`, category: "business", region: "USA" },
  { name: "Construction Dive", url: q => `https://www.constructiondive.com/search/?q=${q}`, category: "business", region: "USA" },
  { name: "Food Dive", url: q => `https://www.fooddive.com/search/?q=${q}`, category: "business", region: "USA" },
  { name: "Restaurant Business", url: q => `https://www.restaurantbusinessonline.com/search?q=${q}`, category: "business", region: "USA" },

  // === SPORTS (60 sources) ===
  { name: "ESPN", url: q => `https://www.espn.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "Sports Illustrated", url: q => `https://www.si.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "The Athletic", url: q => `https://theathletic.com/search/?q=${q}`, category: "sports", region: "USA" },
  { name: "Bleacher Report", url: q => `https://bleacherreport.com/search?query=${q}`, category: "sports", region: "USA" },
  { name: "Yahoo Sports", url: q => `https://sports.yahoo.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "CBS Sports", url: q => `https://www.cbssports.com/search/?q=${q}`, category: "sports", region: "USA" },
  { name: "NBC Sports", url: q => `https://www.nbcsports.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "Fox Sports", url: q => `https://www.foxsports.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "Sky Sports", url: q => `https://www.skysports.com/search?q=${q}`, category: "sports", region: "UK" },
  { name: "BBC Sport", url: q => `https://www.bbc.com/sport/search?q=${q}`, category: "sports", region: "UK" },
  { name: "The Guardian Sport", url: q => `https://www.theguardian.com/sport/search?q=${q}`, category: "sports", region: "UK" },
  { name: "Telegraph Sport", url: q => `https://www.telegraph.co.uk/search/?q=${q}`, category: "sports", region: "UK" },
  { name: "ESPN Cricinfo", url: q => `https://www.espncricinfo.com/search?q=${q}`, category: "sports", region: "Global" },
  { name: "Cricbuzz", url: q => `https://www.cricbuzz.com/cricket-news/search?q=${q}`, category: "sports", region: "India" },
  { name: "Cricket.com", url: q => `https://www.cricket.com/search?q=${q}`, category: "sports", region: "Global" },
  { name: "Sporting News", url: q => `https://www.sportingnews.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "Sports Keeda", url: q => `https://www.sportskeeda.com/search?q=${q}`, category: "sports", region: "India" },
  { name: "Goal.com", url: q => `https://www.goal.com/search?q=${q}`, category: "sports", region: "Global" },
  { name: "FourFourTwo", url: q => `https://www.fourfourtwo.com/search?q=${q}`, category: "sports", region: "UK" },
  { name: "World Soccer", url: q => `https://www.worldsoccer.com/search?q=${q}`, category: "sports", region: "UK" },
  { name: "The42", url: q => `https://www.the42.ie/search?q=${q}`, category: "sports", region: "Ireland" },
  { name: "NBA.com", url: q => `https://www.nba.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "NFL.com", url: q => `https://www.nfl.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "MLB.com", url: q => `https://www.mlb.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "NHL.com", url: q => `https://www.nhl.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "ATP Tour", url: q => `https://www.atptour.com/en/search?q=${q}`, category: "sports", region: "Global" },
  { name: "WTA Tennis", url: q => `https://www.wtatennis.com/search?q=${q}`, category: "sports", region: "Global" },
  { name: "Tennis.com", url: q => `https://www.tennis.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "Golf Digest", url: q => `https://www.golfdigest.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "Golf.com", url: q => `https://golf.com/search/${q}`, category: "sports", region: "USA" },
  { name: "PGA Tour", url: q => `https://www.pgatour.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "Formula 1", url: q => `https://www.formula1.com/en/search.html?q=${q}`, category: "sports", region: "Global" },
  { name: "Motorsport.com", url: q => `https://www.motorsport.com/search/?q=${q}`, category: "sports", region: "Global" },
  { name: "Autosport", url: q => `https://www.autosport.com/search?q=${q}`, category: "sports", region: "UK" },
  { name: "MotoGP", url: q => `https://www.motogp.com/en/search?q=${q}`, category: "sports", region: "Global" },
  { name: "Olympics.com", url: q => `https://olympics.com/search?q=${q}`, category: "sports", region: "Global" },
  { name: "Inside Sport", url: q => `https://www.insidesport.in/?s=${q}`, category: "sports", region: "India" },
  { name: "Sportstar", url: q => `https://sportstar.thehindu.com/search/?q=${q}`, category: "sports", region: "India" },
  { name: "Indian Football", url: q => `https://www.indianfootball.com/search?q=${q}`, category: "sports", region: "India" },
  { name: "Pro Kabaddi", url: q => `https://www.prokabaddi.com/search?q=${q}`, category: "sports", region: "India" },
  { name: "BWF Badminton", url: q => `https://bwfbadminton.com/search/?q=${q}`, category: "sports", region: "Global" },
  { name: "World Rugby", url: q => `https://www.world.rugby/search?q=${q}`, category: "sports", region: "Global" },
  { name: "Rugby Pass", url: q => `https://www.rugbypass.com/search?q=${q}`, category: "sports", region: "Global" },
  { name: "Planet Rugby", url: q => `https://www.planetrugby.com/search/?q=${q}`, category: "sports", region: "UK" },
  { name: "AFL.com.au", url: q => `https://www.afl.com.au/search?q=${q}`, category: "sports", region: "Australia" },
  { name: "NRL.com", url: q => `https://www.nrl.com/search/?q=${q}`, category: "sports", region: "Australia" },
  { name: "Wide World of Sports", url: q => `https://wwos.nine.com.au/search?q=${q}`, category: "sports", region: "Australia" },
  { name: "Sport360", url: q => `https://sport360.com/search?q=${q}`, category: "sports", region: "UAE" },
  { name: "Khaleej Times Sports", url: q => `https://www.khaleejtimes.com/sports/search?q=${q}`, category: "sports", region: "UAE" },
  { name: "Sport Bible", url: q => `https://www.sportbible.com/search?q=${q}`, category: "sports", region: "UK" },
  { name: "Give Me Sport", url: q => `https://www.givemesport.com/search?q=${q}`, category: "sports", region: "UK" },
  { name: "Boxing Scene", url: q => `https://www.boxingscene.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "Fight Sports", url: q => `https://www.fightsports.tv/search?q=${q}`, category: "sports", region: "Global" },
  { name: "MMA Fighting", url: q => `https://www.mmafighting.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "MMA Junkie", url: q => `https://mmajunkie.usatoday.com/search/${q}`, category: "sports", region: "USA" },
  { name: "Sherdog", url: q => `https://www.sherdog.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "Horse Racing Nation", url: q => `https://www.horseracingnation.com/search?q=${q}`, category: "sports", region: "USA" },
  { name: "Racing Post", url: q => `https://www.racingpost.com/search/${q}`, category: "sports", region: "UK" },
  { name: "Cycling News", url: q => `https://www.cyclingnews.com/search/?q=${q}`, category: "sports", region: "Global" },
  { name: "Velonews", url: q => `https://www.velonews.com/search/?q=${q}`, category: "sports", region: "USA" },

  // === ENTERTAINMENT (60 sources) ===
  { name: "Variety", url: q => `https://variety.com/?s=${q}`, category: "entertainment", region: "USA" },
  { name: "Hollywood Reporter", url: q => `https://www.hollywoodreporter.com/search/${q}`, category: "entertainment", region: "USA" },
  { name: "Deadline", url: q => `https://deadline.com/?s=${q}`, category: "entertainment", region: "USA" },
  { name: "Entertainment Weekly", url: q => `https://ew.com/search/?q=${q}`, category: "entertainment", region: "USA" },
  { name: "People", url: q => `https://people.com/search?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Us Weekly", url: q => `https://www.usmagazine.com/search/?q=${q}`, category: "entertainment", region: "USA" },
  { name: "E! Online", url: q => `https://www.eonline.com/search?q=${q}`, category: "entertainment", region: "USA" },
  { name: "TMZ", url: q => `https://www.tmz.com/search/?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Page Six", url: q => `https://pagesix.com/?s=${q}`, category: "entertainment", region: "USA" },
  { name: "The Wrap", url: q => `https://www.thewrap.com/?s=${q}`, category: "entertainment", region: "USA" },
  { name: "IndieWire", url: q => `https://www.indiewire.com/?s=${q}`, category: "entertainment", region: "USA" },
  { name: "Screen Rant", url: q => `https://screenrant.com/search/${q}`, category: "entertainment", region: "USA" },
  { name: "Collider", url: q => `https://collider.com/search/${q}`, category: "entertainment", region: "USA" },
  { name: "ComicBook.com", url: q => `https://comicbook.com/search/?q=${q}`, category: "entertainment", region: "USA" },
  { name: "IGN", url: q => `https://www.ign.com/search?q=${q}`, category: "entertainment", region: "USA" },
  { name: "GameSpot", url: q => `https://www.gamespot.com/search/?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Polygon", url: q => `https://www.polygon.com/search?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Kotaku", url: q => `https://kotaku.com/search?q=${q}`, category: "entertainment", region: "USA" },
  { name: "PC Gamer", url: q => `https://www.pcgamer.com/search/?searchTerm=${q}`, category: "entertainment", region: "USA" },
  { name: "Rock Paper Shotgun", url: q => `https://www.rockpapershotgun.com/?s=${q}`, category: "entertainment", region: "UK" },
  { name: "Eurogamer", url: q => `https://www.eurogamer.net/search?q=${q}`, category: "entertainment", region: "UK" },
  { name: "GamesIndustry.biz", url: q => `https://www.gamesIndustry.biz/search?q=${q}`, category: "entertainment", region: "UK" },
  { name: "VGC", url: q => `https://www.videogameschronicle.com/?s=${q}`, category: "entertainment", region: "UK" },
  { name: "Destructoid", url: q => `https://www.destructoid.com/search/?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Giant Bomb", url: q => `https://www.giantbomb.com/search/?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Game Informer", url: q => `https://www.gameinformer.com/search?keyword=${q}`, category: "entertainment", region: "USA" },
  { name: "Rolling Stone", url: q => `https://www.rollingstone.com/search/?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Billboard", url: q => `https://www.billboard.com/search/?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Pitchfork", url: q => `https://pitchfork.com/search/?query=${q}`, category: "entertainment", region: "USA" },
  { name: "NME", url: q => `https://www.nme.com/search?q=${q}`, category: "entertainment", region: "UK" },
  { name: "Consequence", url: q => `https://consequence.net/?s=${q}`, category: "entertainment", region: "USA" },
  { name: "Stereogum", url: q => `https://www.stereogum.com/?s=${q}`, category: "entertainment", region: "USA" },
  { name: "The FADER", url: q => `https://www.thefader.com/search?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Complex Music", url: q => `https://www.complex.com/music/search?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Music Business Worldwide", url: q => `https://www.musicbusinessworldwide.com/?s=${q}`, category: "entertainment", region: "UK" },
  { name: "Rotten Tomatoes", url: q => `https://www.rottentomatoes.com/search?search=${q}`, category: "entertainment", region: "USA" },
  { name: "IMDb", url: q => `https://www.imdb.com/find?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Metacritic", url: q => `https://www.metacritic.com/search/${q}`, category: "entertainment", region: "USA" },
  { name: "AV Club", url: q => `https://www.avclub.com/search?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Vulture", url: q => `https://www.vulture.com/search/?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Slashfilm", url: q => `https://www.slashfilm.com/?s=${q}`, category: "entertainment", region: "USA" },
  { name: "Den of Geek", url: q => `https://www.denofgeek.com/search/?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Empire", url: q => `https://www.empireonline.com/search?q=${q}`, category: "entertainment", region: "UK" },
  { name: "Total Film", url: q => `https://www.gamesradar.com/totalfilm/search/?searchTerm=${q}`, category: "entertainment", region: "UK" },
  { name: "SFX Magazine", url: q => `https://www.gamesradar.com/sfx/search/?searchTerm=${q}`, category: "entertainment", region: "UK" },
  { name: "Cinema Blend", url: q => `https://www.cinemablend.com/search?q=${q}`, category: "entertainment", region: "USA" },
  { name: "MovieWeb", url: q => `https://movieweb.com/search/${q}`, category: "entertainment", region: "USA" },
  { name: "JoBlo", url: q => `https://www.joblo.com/?s=${q}`, category: "entertainment", region: "USA" },
  { name: "Bloody Disgusting", url: q => `https://bloody-disgusting.com/?s=${q}`, category: "entertainment", region: "USA" },
  { name: "Dread Central", url: q => `https://www.dreadcentral.com/?s=${q}`, category: "entertainment", region: "USA" },
  { name: "Anime News Network", url: q => `https://www.animenewsnetwork.com/search?q=${q}`, category: "entertainment", region: "USA" },
  { name: "Crunchyroll News", url: q => `https://www.crunchyroll.com/news/search?q=${q}`, category: "entertainment", region: "USA" },
  { name: "MyAnimeList", url: q => `https://myanimelist.net/search/all?q=${q}`, category: "entertainment", region: "Global" },
  { name: "Bollywood Hungama", url: q => `https://www.bollywoodhungama.com/search/?q=${q}`, category: "entertainment", region: "India" },
  { name: "Pinkvilla", url: q => `https://www.pinkvilla.com/search?q=${q}`, category: "entertainment", region: "India" },
  { name: "Film Companion", url: q => `https://www.filmcompanion.in/?s=${q}`, category: "entertainment", region: "India" },
  { name: "Koimoi", url: q => `https://www.koimoi.com/?s=${q}`, category: "entertainment", region: "India" },
  { name: "SpotboyE", url: q => `https://www.spotboye.com/search/?q=${q}`, category: "entertainment", region: "India" },

  // === HEALTH & SCIENCE (60 sources) ===
  { name: "Nature", url: q => `https://www.nature.com/search?q=${q}`, category: "science", region: "Global" },
  { name: "Science Magazine", url: q => `https://www.science.org/search?q=${q}`, category: "science", region: "USA" },
  { name: "Scientific American", url: q => `https://www.scientificamerican.com/search/?q=${q}`, category: "science", region: "USA" },
  { name: "New Scientist", url: q => `https://www.newscientist.com/search/?q=${q}`, category: "science", region: "UK" },
  { name: "Smithsonian Magazine", url: q => `https://www.smithsonianmag.com/search/?q=${q}`, category: "science", region: "USA" },
  { name: "National Geographic", url: q => `https://www.nationalgeographic.com/search?q=${q}`, category: "science", region: "USA" },
  { name: "Discover Magazine", url: q => `https://www.discovermagazine.com/search?q=${q}`, category: "science", region: "USA" },
  { name: "Quanta Magazine", url: q => `https://www.quantamagazine.org/search/?q=${q}`, category: "science", region: "USA" },
  { name: "Phys.org", url: q => `https://phys.org/search/?search=${q}`, category: "science", region: "Global" },
  { name: "Science Daily", url: q => `https://www.sciencedaily.com/search/?keyword=${q}`, category: "science", region: "USA" },
  { name: "Live Science", url: q => `https://www.livescience.com/search?searchTerm=${q}`, category: "science", region: "USA" },
  { name: "Space.com", url: q => `https://www.space.com/search?searchTerm=${q}`, category: "science", region: "USA" },
  { name: "Universe Today", url: q => `https://www.universetoday.com/?s=${q}`, category: "science", region: "Canada" },
  { name: "Astronomy.com", url: q => `https://astronomy.com/search?q=${q}`, category: "science", region: "USA" },
  { name: "Sky & Telescope", url: q => `https://skyandtelescope.org/?s=${q}`, category: "science", region: "USA" },
  { name: "NASA", url: q => `https://www.nasa.gov/search/?q=${q}`, category: "science", region: "USA" },
  { name: "ESA", url: q => `https://www.esa.int/esearch?q=${q}`, category: "science", region: "Europe" },
  { name: "The Verge Science", url: q => `https://www.theverge.com/science/search?q=${q}`, category: "science", region: "USA" },
  { name: "WebMD", url: q => `https://www.webmd.com/search/search_results/default.aspx?query=${q}`, category: "health", region: "USA" },
  { name: "Healthline", url: q => `https://www.healthline.com/search?q1=${q}`, category: "health", region: "USA" },
  { name: "Medical News Today", url: q => `https://www.medicalnewstoday.com/search?q=${q}`, category: "health", region: "UK" },
  { name: "Mayo Clinic", url: q => `https://www.mayoclinic.org/search/search-results?q=${q}`, category: "health", region: "USA" },
  { name: "Cleveland Clinic", url: q => `https://my.clevelandclinic.org/search?q=${q}`, category: "health", region: "USA" },
  { name: "Johns Hopkins Medicine", url: q => `https://www.hopkinsmedicine.org/search?q=${q}`, category: "health", region: "USA" },
  { name: "Harvard Health", url: q => `https://www.health.harvard.edu/?s=${q}`, category: "health", region: "USA" },
  { name: "Stanford Medicine", url: q => `https://med.stanford.edu/search.html?q=${q}`, category: "health", region: "USA" },
  { name: "NIH News", url: q => `https://www.nih.gov/search/${q}`, category: "health", region: "USA" },
  { name: "CDC", url: q => `https://search.cdc.gov/search/?query=${q}`, category: "health", region: "USA" },
  { name: "WHO", url: q => `https://www.who.int/search?indexCatalogue=genericsearchindex1&searchQuery=${q}`, category: "health", region: "Global" },
  { name: "The Lancet", url: q => `https://www.thelancet.com/action/doSearch?searchText=${q}`, category: "health", region: "UK" },
  { name: "BMJ", url: q => `https://www.bmj.com/search?text=${q}`, category: "health", region: "UK" },
  { name: "JAMA Network", url: q => `https://jamanetwork.com/search?q=${q}`, category: "health", region: "USA" },
  { name: "NEJM", url: q => `https://www.nejm.org/search?q=${q}`, category: "health", region: "USA" },
  { name: "Medscape", url: q => `https://www.medscape.com/search?q=${q}`, category: "health", region: "USA" },
  { name: "Stat News", url: q => `https://www.statnews.com/?s=${q}`, category: "health", region: "USA" },
  { name: "Healio", url: q => `https://www.healio.com/search?q=${q}`, category: "health", region: "USA" },
  { name: "MedPage Today", url: q => `https://www.medpagetoday.com/search?query=${q}`, category: "health", region: "USA" },
  { name: "Fierce Pharma", url: q => `https://www.fiercepharma.com/search?s=${q}`, category: "health", region: "USA" },
  { name: "Fierce Biotech", url: q => `https://www.fiercebiotech.com/search?s=${q}`, category: "health", region: "USA" },
  { name: "BioPharma Dive", url: q => `https://www.biopharmadive.com/search/?q=${q}`, category: "health", region: "USA" },
  { name: "Endpoints News", url: q => `https://endpts.com/?s=${q}`, category: "health", region: "USA" },
  { name: "BioSpace", url: q => `https://www.biospace.com/search?q=${q}`, category: "health", region: "USA" },
  { name: "Genetic Engineering News", url: q => `https://www.genengnews.com/?s=${q}`, category: "health", region: "USA" },
  { name: "Nature Biotechnology", url: q => `https://www.nature.com/nbt/search?q=${q}`, category: "science", region: "Global" },
  { name: "Cell", url: q => `https://www.cell.com/action/doSearch?searchText=${q}`, category: "science", region: "USA" },
  { name: "PLOS", url: q => `https://journals.plos.org/search?q=${q}`, category: "science", region: "USA" },
  { name: "Frontiers", url: q => `https://www.frontiersin.org/search?query=${q}`, category: "science", region: "Switzerland" },
  { name: "eLife", url: q => `https://elifesciences.org/search?for=${q}`, category: "science", region: "UK" },
  { name: "PNAS", url: q => `https://www.pnas.org/search/${q}`, category: "science", region: "USA" },
  { name: "Science Advances", url: q => `https://www.science.org/search?q=${q}`, category: "science", region: "USA" },
  { name: "Nature Medicine", url: q => `https://www.nature.com/nm/search?q=${q}`, category: "science", region: "Global" },
  { name: "Environment & Climate", url: q => `https://www.environmentandclimate.com/search?q=${q}`, category: "science", region: "Global" },
  { name: "Climate Home News", url: q => `https://www.climatechangenews.com/?s=${q}`, category: "science", region: "UK" },
  { name: "Carbon Brief", url: q => `https://www.carbonbrief.org/?s=${q}`, category: "science", region: "UK" },
  { name: "Inside Climate News", url: q => `https://insideclimatenews.org/?s=${q}`, category: "science", region: "USA" },
  { name: "Yale Environment 360", url: q => `https://e360.yale.edu/search?q=${q}`, category: "science", region: "USA" },
  { name: "Environmental Health News", url: q => `https://www.ehn.org/?s=${q}`, category: "science", region: "USA" },
  { name: "Mongabay", url: q => `https://news.mongabay.com/?s=${q}`, category: "science", region: "Global" },
  { name: "Ocean Conservancy", url: q => `https://oceanconservancy.org/?s=${q}`, category: "science", region: "USA" },

  // === LIFESTYLE & CULTURE (50 sources) ===
  { name: "Vogue", url: q => `https://www.vogue.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Elle", url: q => `https://www.elle.com/search/?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Harper's Bazaar", url: q => `https://www.harpersbazaar.com/search/?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Marie Claire", url: q => `https://www.marieclaire.com/search/?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Cosmopolitan", url: q => `https://www.cosmopolitan.com/search/?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "GQ", url: q => `https://www.gq.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Esquire", url: q => `https://www.esquire.com/search/?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Bon Appétit", url: q => `https://www.bonappetit.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Food & Wine", url: q => `https://www.foodandwine.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Epicurious", url: q => `https://www.epicurious.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Serious Eats", url: q => `https://www.seriouseats.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Eater", url: q => `https://www.eater.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Thrillist", url: q => `https://www.thrillist.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "The Spruce Eats", url: q => `https://www.thespruceeats.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Allrecipes", url: q => `https://www.allrecipes.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Taste of Home", url: q => `https://www.tasteofhome.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Architectural Digest", url: q => `https://www.architecturaldigest.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Dwell", url: q => `https://www.dwell.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Dezeen", url: q => `https://www.dezeen.com/?s=${q}`, category: "lifestyle", region: "UK" },
  { name: "ArchDaily", url: q => `https://www.archdaily.com/search/${q}`, category: "lifestyle", region: "Global" },
  { name: "Core77", url: q => `https://www.core77.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Design Milk", url: q => `https://design-milk.com/?s=${q}`, category: "lifestyle", region: "USA" },
  { name: "Apartment Therapy", url: q => `https://www.apartmenttherapy.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "The Spruce", url: q => `https://www.thespruce.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Better Homes & Gardens", url: q => `https://www.bhg.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "HGTV", url: q => `https://www.hgtv.com/search?searchTerm=${q}`, category: "lifestyle", region: "USA" },
  { name: "Real Simple", url: q => `https://www.realsimple.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Martha Stewart", url: q => `https://www.marthastewart.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Good Housekeeping", url: q => `https://www.goodhousekeeping.com/search/?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Country Living", url: q => `https://www.countryliving.com/search/?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Travel + Leisure", url: q => `https://www.travelandleisure.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Condé Nast Traveler", url: q => `https://www.cntraveler.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Lonely Planet", url: q => `https://www.lonelyplanet.com/search?q=${q}`, category: "lifestyle", region: "Global" },
  { name: "National Geographic Travel", url: q => `https://www.nationalgeographic.com/travel/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Afar", url: q => `https://www.afar.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Outside", url: q => `https://www.outsideonline.com/search/?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Backpacker", url: q => `https://www.backpacker.com/search/?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Men's Health", url: q => `https://www.menshealth.com/search/?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Women's Health", url: q => `https://www.womenshealthmag.com/search/?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Runner's World", url: q => `https://www.runnersworld.com/search/?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Yoga Journal", url: q => `https://www.yogajournal.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Shape", url: q => `https://www.shape.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Self", url: q => `https://www.self.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Refinery29", url: q => `https://www.refinery29.com/en-us/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Bustle", url: q => `https://www.bustle.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Well+Good", url: q => `https://www.wellandgood.com/?s=${q}`, category: "lifestyle", region: "USA" },
  { name: "Byrdie", url: q => `https://www.byrdie.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Allure", url: q => `https://www.allure.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "InStyle", url: q => `https://www.instyle.com/search?q=${q}`, category: "lifestyle", region: "USA" },
  { name: "Who What Wear", url: q => `https://www.whowhatwear.com/search?q=${q}`, category: "lifestyle", region: "USA" }
];

// -------------------- Utilities --------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hashKey(s) {
  return createHash("md5").update(s).digest("hex");
}

function isLikelyValidUrl(u) {
  if (!u) return false;
  const lower = u.toLowerCase();
  const blacklist = ["facebook", "twitter", "instagram", "pinterest", "x.com", "mailto:"];
  return !blacklist.some(b => lower.includes(b));
}

// simple score engine
function computeScore(title = "", desc = "", url = "", words = []) {
  const text = `${title} ${desc} ${url}`.toLowerCase();
  let s = 0;
  for (const w of words) {
    if (!w) continue;
    if (title.toLowerCase().includes(w)) s += 10;
    if (desc.toLowerCase().includes(w)) s += 5;
    if (url.toLowerCase().includes(w)) s += 3;
  }
  if (/\b(202\d|today|hours ago|minutes ago)\b/.test(text)) s += 6;
  return s;
}

// chunk long text into ~CHUNK_SIZE character pieces
function chunkText(text, chunkSize = CHUNK_SIZE) {
  if (!text) return [];
  const normalized = text.replace(/\s+/g, " ").trim();
  const chunks = [];
  let i = 0;
  while (i < normalized.length) {
    const slice = normalized.slice(i, i + chunkSize);
    // attempt to not cut mid-sentence: extend to next sentence end (.) up to +200 chars
    let end = slice.length;
    const remainder = normalized.slice(i + slice.length, i + slice.length + 200);
    const dotIdx = remainder.indexOf(".");
    if (dotIdx !== -1) end = slice.length + dotIdx + 1;
    chunks.push(normalized.slice(i, i + end).trim());
    i = i + end;
  }
  return chunks;
}

// -------------------- Pollinations helpers --------------------
// Pollinations endpoints are free text-get endpoints; we send prompts encoded in the URL.
// Each function expects JSON fallback when parsing responses.

async function detectCategoryPollinations(query) {
  try {
    const prompt = encodeURIComponent(`Return ONE WORD category for query: "${query}". Choose from: general, technology, business, sports, science, entertainment, health, politics.`);
    const resp = await pollinationsHttp.get(`https://text.pollinations.ai/${prompt}`);
    const v = String(resp.data || "").trim().toLowerCase();
    const valid = ["general","technology","business","sports","science","entertainment","health","politics"];
    return valid.includes(v) ? v : "general";
  } catch (e) {
    return "general";
  }
}

async function analyzeWithPollinations(query, items /* [{title,url}] */) {
  try {
    const reduced = items.slice(0, 10).map((r, i) => `${i+1}. ${r.title}\nURL: ${r.url}`).join("\n\n");
    const prompt = encodeURIComponent(`
Analyze the following search results for the query: "${query}"

${reduced}

Return JSON ONLY:
{
  "bestUrls": ["...","..."],
  "reasoning": "short explanation"
}
`);
    const r = await pollinationsHttp.get(`https://text.pollinations.ai/${prompt}`);
    const text = String(r.data || "");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (e) {
    return null;
  }
}

async function summarizeWithPollinations(instruction, text) {
  // instruction: brief instruction e.g., "Summarize this chunk in 2-3 sentences."
  try {
    // limit chunk length in prompt to avoid huge URL; we pass only first ~8000 chars
    const snippet = String(text).slice(0, 14000);
    const prompt = encodeURIComponent(`
${instruction}

Text:
${snippet}

Return JSON ONLY:
{"summary":"..."}
`);
    const r = await pollinationsHttp.get(`https://text.pollinations.ai/${prompt}`);
    const t = String(r.data || "");
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return parsed.summary || null;
  } catch {
    return null;
  }
}

async function mergeSummariesPollinations(query, chunkSummaries) {
  try {
    const joined = chunkSummaries.map((s,i)=>`${i+1}. ${s}`).join("\n\n");
    const prompt = encodeURIComponent(`
You are given multiple short summaries (numbered) for articles related to: "${query}".

1) Produce a concise merged summary (max 3 short paragraphs).
2) Produce a 10-point list (1 to 10) in simple English of the most important learning points or facts derived from the merged summary. Each point should be one short sentence.

Return JSON ONLY:
{
  "mergedSummary": "...",
  "tenPoints": ["p1","p2", "...", "p10"]
}
    
Summaries:
${joined}
`);
    const r = await pollinationsHttp.get(`https://text.pollinations.ai/${prompt}`, { timeout: POLLINATIONS_TIMEOUT });
    const t = String(r.data || "");
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

// -------------------- Scraper --------------------
async function scrapeSiteForLinks(site, query, words) {
  try {
    const searchUrl = site.url(query);
    const resp = await http.get(searchUrl).catch(() => ({ data: "" }));
    const $ = cheerio.load(resp.data || "");
    const out = [];

    // iterate anchors — limited slice for speed
    $("a").slice(0, 120).each((i, el) => {
      let href = $(el).attr("href");
      let title = $(el).text().trim();

      if (!href || !title || title.length < 6) return;

      if (!href.startsWith("http")) {
        try { href = new URL(href, searchUrl).href; } catch { return; }
      }

      if (!isLikelyValidUrl(href)) return;

      const desc = $(el).closest("article").find("p").first().text().trim() || title;

      const score = computeScore(title, desc, href, words);

      out.push({
        site: site.name,
        category: site.category,
        region: site.region,
        title,
        description: desc,
        url: href,
        score
      });
    });

    return out;
  } catch (e) {
    return [];
  }
}

// -------------------- Reader fetch --------------------
async function fetchArticleViaReader(url) {
  try {
    const encoded = encodeURIComponent(url);
    const endpoint = `https://reader-zeta-three.vercel.app/api/scrape?url=${encoded}`;
    const r = await http.get(endpoint);
    if (!r.data || !r.data.success) {
      return { url, error: "reader-failed" };
    }
    return {
      url,
      title: r.data.metadata?.title || null,
      siteName: r.data.metadata?.siteName || null,
      author: r.data.metadata?.author || null,
      fullText: r.data.fullText || null,
      contentParts: r.data.contentParts || null,
      images: r.data.images || null
    };
  } catch (err) {
    return { url, error: "fetch-failed" };
  }
}

// -------------------- Dedupe --------------------
function dedupe(items) {
  const m = new Map();
  for (const it of items) {
    const k = (it.url || "").toLowerCase();
    if (!k) continue;
    if (!m.has(k) || (m.get(k).score || 0) < (it.score || 0)) {
      m.set(k, it);
    }
  }
  return Array.from(m.values());
}

// -------------------- Main handler --------------------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const startTime = Date.now();
  const q = (req.query.q || req.query.q || "").toString().trim();
  const limit = Math.min(Number(req.query.limit || MAX_RESULTS), MAX_RESULTS);

  if (!q) return res.status(400).json({ error: "Missing ?q query param" });

  const cacheKey = hashKey(q);
  const cached = getCache(cacheKey);
  if (cached) return res.json({ cached: true, ...cached });

  // detect category
  const detectedCategory = (req.query.category) ? req.query.category : await detectCategoryPollinations(q);

  // choose sources: slice for speed
  let sources = NEWS_SITES.slice(0, MAX_SITES);
  if (detectedCategory && detectedCategory !== "general") {
    sources = sources.filter(s => s.category === detectedCategory || s.category === "general");
  }

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);

  // scrape in parallel
  const scrapePromises = sources.map(s => scrapeSiteForLinks(s, q, words));
  const scrapedArrays = await Promise.all(scrapePromises);
  const flat = scrapedArrays.flat();
  const deduped = dedupe(flat).sort((a,b) => (b.score||0) - (a.score||0));
  const topResults = deduped.slice(0, Math.max(limit, 20)); // keep at least 20 for AI selection

  // Prepare lightweight results for UI (title + url)
  const uiResults = topResults.map(r => ({ title: r.title, url: r.url }));

  // Ask Pollinations to pick best URLs (fast)
  let bestUrls = [];
  try {
    const aiPick = await analyzeWithPollinations(q, uiResults);
    if (aiPick && Array.isArray(aiPick.bestUrls) && aiPick.bestUrls.length) {
      // keep only URLs that appear in our detected list (safety)
      const setAvailable = new Set(uiResults.map(r => r.url));
      bestUrls = aiPick.bestUrls.filter(u => setAvailable.has(u)).slice(0, 6);
    }
  } catch {}
  // fallback: top 4 direct
  if (!bestUrls || bestUrls.length === 0) {
    bestUrls = uiResults.slice(0, 4).map(r => r.url);
  }

  // Process each best URL sequentially with 2s delay between each processing
  const processedArticles = [];
  for (let i = 0; i < bestUrls.length; i++) {
    const url = bestUrls[i];
    // fetch via reader
    const article = await fetchArticleViaReader(url);
    if (article && article.fullText) {
      // chunk
      const chunks = chunkText(article.fullText, CHUNK_SIZE);
      // summarize each chunk sequentially (we keep sequential to avoid pollinations rate issues)
      const chunkSummaries = [];
      for (let j = 0; j < chunks.length; j++) {
        const chunk = chunks[j];
        // instruction: short summary for each chunk
        const instruction = "Summarize the following article chunk in 2-3 short sentences, focusing on the key facts.";
        const s = await summarizeWithPollinations(instruction, chunk);
        chunkSummaries.push(s || (chunk.slice(0, 200) + (chunk.length>200 ? "..." : "")));
        // small delay between chunk summaries to be polite (250ms)
        await sleep(250);
      }
      processedArticles.push({
        url: article.url,
        title: article.title,
        siteName: article.siteName,
        author: article.author,
        chunkCount: chunks.length,
        chunkSummaries
      });
    } else {
      processedArticles.push({
        url,
        error: article?.error || "no-content"
      });
    }
    // 2 second delay between each article processing (user requested)
    if (i < bestUrls.length - 1) await sleep(2000);
  }

  // Combine all chunk summaries across articles into a single merged summary using Pollinations
  const allChunkSummaries = processedArticles.flatMap(a => a.chunkSummaries || []);
  let merged = null;
  if (allChunkSummaries.length) {
    try {
      merged = await mergeSummariesPollinations(q, allChunkSummaries);
    } catch (e) {
      merged = null;
    }
  }

  // Final unifiedSummary: prefer tenPoints array (10 point simple english). Fallback to mergedSummary or short constructed summary.
  let unifiedSummary = null;
  if (merged && merged.tenPoints && Array.isArray(merged.tenPoints) && merged.tenPoints.length >= 1) {
    unifiedSummary = {
      mergedSummary: merged.mergedSummary || null,
      tenPoints: merged.tenPoints.slice(0, 10)
    };
  } else if (merged && merged.mergedSummary) {
    // try to produce 10 short points by splitting sentences (fallback)
    const sentences = (merged.mergedSummary || "").split(/(?<=[.!?])\s+/).filter(Boolean);
    const ten = [];
    for (let i=0;i<10;i++) {
      ten.push(sentences[i] ? sentences[i].replace(/\s+/g," ").trim() : "");
    }
    unifiedSummary = {
      mergedSummary: merged.mergedSummary,
      tenPoints: ten
    };
  } else {
    // last-resort fallback: synthesize simple list from available chunk summaries (first 10)
    const shortPoints = allChunkSummaries.slice(0, 10).map((s, idx) => {
      const one = (""+s).replace(/\s+/g," ").trim();
      const sent = one.split(/(?<=[.!?])\s+/)[0] || one.slice(0,100);
      return `${idx+1}. ${sent}`;
    });
    unifiedSummary = {
      mergedSummary: (allChunkSummaries.slice(0,3).join("\n\n")) || "No merged summary available.",
      tenPoints: shortPoints.length ? shortPoints : ["No key points available."]
    };
  }

  // Build minimal UI response per Option 3
  const response = {
    success: true,
    query: q,
    detectedCategory,
    results: uiResults.slice(0, limit).map(r => ({ title: r.title, url: r.url })),
    unifiedSummary, // { mergedSummary, tenPoints: [...] }
    timeMs: Date.now() - startTime
  };

  // cache and return
  setCache(cacheKey, response);
  return res.json(response);
}

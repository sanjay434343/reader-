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

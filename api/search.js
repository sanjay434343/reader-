import axios from "axios";
import * as cheerio from "cheerio";

// --------------------------------------------
// SEARCH TARGETS (real news portals with search)
// --------------------------------------------
const NEWS_SITES = [
  { name: "Indian Express", url: q => `https://indianexpress.com/?s=${q}` },
  { name: "Times of India", url: q => `https://timesofindia.indiatimes.com/topic/${q}` },
  { name: "BBC", url: q => `https://www.bbc.co.uk/search?q=${q}` },
  { name: "NDTV", url: q => `https://www.ndtv.com/search?searchtext=${q}` },
  { name: "Hindustan Times", url: q => `https://www.hindustantimes.com/search?q=${q}` },
  { name: "The Hindu", url: q => `https://www.thehindu.com/search/?q=${q}` },

  // TECHNOLOGY
  { name: "The Verge", url: q => `https://www.theverge.com/search?q=${q}` },
  { name: "TechCrunch", url: q => `https://search.techcrunch.com/search?q=${q}` },

  // SPORTS
  { name: "ESPN", url: q => `https://www.espn.com/search/results?q=${q}` },

  // SCIENCE
  { name: "Live Science", url: q => `https://www.livescience.com/search?q=${q}` },

  // BLOGS
  { name: "Dev.to", url: q => `https://dev.to/search?q=${q}` }
];

// --------------------------------------------
// CLEAN URL VALIDATION
// --------------------------------------------
function isValidArticle(url) {
  if (!url) return false;

  const bad = [
    "facebook.com", "twitter.com", "x.com",
    "pinterest.com", "instagram.com", "mailto:",
    "/tag/", "/topic/",
    "share", "subscribe", "login", "signup", "account"
  ];

  return !bad.some(b => url.includes(b));
}

// --------------------------------------------
// RANK RESULTS (keyword match scoring)
// --------------------------------------------
function scoreResult(url, title, queryWords) {
  const text = (title + " " + url).toLowerCase();
  let score = 0;

  queryWords.forEach(word => {
    if (text.includes(word)) score += 5;       // Strong match
    if (title.toLowerCase().startsWith(word)) score += 10; // Title begins with keyword
  });

  return score;
}

// --------------------------------------------
// SCRAPE ONE SEARCH PAGE
// --------------------------------------------
async function scrapeSite(site, query, queryWords) {
  try {
    const searchUrl = site.url(query);
    const response = await axios.get(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0 Chrome Safari" },
      timeout: 8000
    });

    const $ = cheerio.load(response.data);
    let results = [];

    $("a").each((i, el) => {
      let href = $(el).attr("href");
      let title = $(el).text().trim();

      if (!href) return;
      if (!href.startsWith("http")) return;
      if (!isValidArticle(href)) return;
      if (title.length < 5) return;

      results.push({
        site: site.name,
        title,
        url: href,
        score: scoreResult(href, title, queryWords)
      });
    });

    return results;

  } catch (err) {
    return []; // fail silently
  }
}

// --------------------------------------------
// MAIN SEARCH HANDLER
// --------------------------------------------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Query required" });

  const queryWords = query.toLowerCase().split(/\s+/);

  // PARALLEL SCRAPING
  const promises = NEWS_SITES.map(
    site => scrapeSite(site, query, queryWords)
  );

  const allResults = (await Promise.all(promises)).flat();

  // REMOVE duplicates by URL
  const unique = [];
  const seen = new Set();

  allResults.forEach(r => {
    if (!seen.has(r.url)) {
      seen.add(r.url);
      unique.push(r);
    }
  });

  // SORT by score (descending)
  unique.sort((a, b) => b.score - a.score);

  // FINAL OUTPUT
  return res.json({
    query,
    resultsCount: unique.length,
    results: unique.slice(0, 50) // Top 50
  });
}

import axios from "axios";
import * as cheerio from "cheerio";

// --------------------
// CHECK MATCH SCORE
// --------------------
function strongMatch(title, query) {
  const t = title.toLowerCase();
  const q = query.toLowerCase().split(" ").filter(w => w.length > 2);

  let score = 0;
  q.forEach(w => {
    if (t.includes(w)) score++;
  });

  return score >= Math.ceil(q.length * 0.4);
}

// --------------------
// SITE SCRAPERS
// --------------------
const SITE_RULES = {
  "indianexpress": {
    selector: "a",
    getUrl: (el, $) => $(el).attr("href"),
    getTitle: (el, $) => $(el).text().trim()
  },
  "timesofindia": {
    selector: "a[href*='/articleshow']",
    getUrl: (el, $) => $(el).attr("href"),
    getTitle: (el, $) => $(el).text().trim()
  },
  "theverge": {
    selector: "a[href*='/']",
    getUrl: (el, $) => $(el).attr("href"),
    getTitle: (el, $) => $(el).find("h2, h3").text().trim() || $(el).text().trim()
  },
  "economictimes": {
    selector: "a[href*='articleshow']",
    getUrl: (el, $) => $(el).attr("href"),
    getTitle: (el, $) => $(el).text().trim()
  },
  "bbc": {
    selector: "a[href*='/news/']",
    getUrl: (el, $) => $(el).attr("href"),
    getTitle: (el, $) => $(el).text().trim()
  }
};

// --------------------
// CATEGORY SOURCES
// --------------------
const SOURCES = {
  tech: [
    "https://timesofindia.indiatimes.com/technology",
    "https://indianexpress.com/section/technology/",
    "https://www.theverge.com/",
    "https://economictimes.indiatimes.com/tech",
    "https://www.bbc.com/news/technology"
  ],
  news: [
    "https://indianexpress.com/",
    "https://timesofindia.indiatimes.com/",
    "https://www.bbc.com/news"
  ]
};

// --------------------
// GET DOMAIN KEY
// --------------------
function getDomainKey(url) {
  if (url.includes("indianexpress")) return "indianexpress";
  if (url.includes("indiatimes")) return "timesofindia";
  if (url.includes("theverge")) return "theverge";
  if (url.includes("economictimes")) return "economictimes";
  if (url.includes("bbc")) return "bbc";
  return "generic";
}

// --------------------
// SCRAPE FUNCTION
// --------------------
async function scrapeSite(url, query) {
  try {
    const html = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/120 Safari/537.36" }
    }).then(res => res.data);

    const $ = cheerio.load(html);

    const rulesKey = getDomainKey(url);
    const rules = SITE_RULES[rulesKey];

    if (!rules) return [];

    let out = [];

    $(rules.selector).each((i, el) => {
      let link = rules.getUrl(el, $);
      let title = rules.getTitle(el, $);

      if (!link || !title) return;
      if (!title || title.length < 5) return;

      // Normalize link
      if (link.startsWith("/")) {
        const base = new URL(url).origin;
        link = base + link;
      }

      // Must contain exact page, not homepage
      if (!link.includes("article") && !link.includes("show") && !link.includes("/news/")) {
        return;
      }

      // Strong match
      if (!strongMatch(title, query)) return;

      out.push({
        title,
        url: link,
        keywords: query.split(" ")
      });
    });

    return out;

  } catch (err) {
    return [];
  }
}

// --------------------
// MAIN API
// --------------------
export default async function handler(req, res) {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "Query required" });

  const category = "tech"; // forced for your test

  let finalResults = [];

  for (let source of SOURCES[category]) {
    const siteResults = await scrapeSite(source, q);
    finalResults = finalResults.concat(siteResults);
  }

  // Deduplicate by URL
  finalResults = finalResults.filter(
    (v, i, a) => a.findIndex(t => t.url === v.url) === i
  );

  res.status(200).json({
    query: q,
    category,
    resultsCount: finalResults.length,
    results: finalResults
  });
}

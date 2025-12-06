import axios from "axios";
import * as cheerio from "cheerio";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "Query (q) is required" });

    const query = encodeURIComponent(q);
    const keywords = q.toLowerCase().split(" ");

    // CLEAN ARTICLE SELECTORS FOR EACH SITE
    const SOURCES = [
      // NEWS
      { cat: "news", url: t => `https://indianexpress.com/?s=${t}`, selector: "a[href*='/article/']" },
      { cat: "news", url: t => `https://www.ndtv.com/search?searchtext=${t}`, selector: "a[href*='/news/']" },
      { cat: "news", url: t => `https://timesofindia.indiatimes.com/topic/${t}`, selector: "a[href*='articleshow']" },
      { cat: "news", url: t => `https://www.bbc.co.uk/search?q=${t}`, selector: "a[href*='/news/']" },

      // TECH
      { cat: "tech", url: t => `https://techcrunch.com/search/${t}`, selector: "a.post-block__title__link" },
      { cat: "tech", url: t => `https://www.theverge.com/search?q=${t}`, selector: "a[href*='/202']" },
      { cat: "tech", url: t => `https://www.wired.com/search/?q=${t}`, selector: "a.archive-item-component__link" },

      // SPORTS
      { cat: "sports", url: t => `https://www.cricbuzz.com/search?q=${t}`, selector: "a[href*='/cricket-news/']" },
      { cat: "sports", url: t => `https://www.espn.com/search/results?q=${t}`, selector: "a[href*='/story/']" },

      // BUSINESS
      { cat: "business", url: t => `https://economictimes.indiatimes.com/topic/${t}`, selector: "a[href*='articleshow']" },

      // SCIENCE
      { cat: "science", url: t => `https://www.sciencedaily.com/search/?keyword=${t}`, selector: "a[href*='/releases/']" },
      { cat: "science", url: t => `https://www.livescience.com/search?searchTerm=${t}`, selector: "a[href*='/news/']" },

      // BLOGS
      { cat: "blogs", url: t => `https://medium.com/search?q=${t}`, selector: "a[href*='/p/']" }
    ];


    const BAD_LINKS = [
      "login", "signup", "account", "facebook.com", "twitter.com",
      "instagram.com", "whatsapp", "share", "mailto", "javascript"
    ];

    async function scrape(src) {
      try {
        const page = await axios.get(src.url(query), {
          headers: { "User-Agent": "Mozilla/5.0" }
        });

        const $ = cheerio.load(page.data);
        let out = [];

        $(src.selector).each((i, el) => {
          const href = $(el).attr("href");
          let title = $(el).text().trim();

          if (!href) return;

          // Resolve relative URL
          let finalUrl = href.startsWith("http")
            ? href
            : new URL(href, src.url(query)).href;

          // Reject bad links
          if (BAD_LINKS.some(b => finalUrl.includes(b))) return;

          // Title must match keywords
          const t = title.toLowerCase();
          const match = keywords.some(k => t.includes(k));

          if (!match) return;

          out.push({
            title: title.slice(0, 150),
            url: finalUrl,
            keywords: [src.cat, ...keywords]
          });
        });

        return out.slice(0, 5);
      } catch (e) {
        return [];
      }
    }

    let results = [];
    for (let s of SOURCES) {
      const r = await scrape(s);
      results.push(...r);
    }

    // REMOVE DUPLICATES
    const seen = new Set();
    results = results.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });

    return res.status(200).json({
      query: q,
      resultsCount: results.length,
      results
    });

  } catch (err) {
    return res.status(500).json({
      error: "Search failed",
      details: err.message
    });
  }
}

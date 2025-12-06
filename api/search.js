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

    // -----------------------------------------------------------
    // MASTER CATEGORY CONFIG
    // -----------------------------------------------------------
    const CATEGORIES = [
      // NEWS
      { cat: "news", url: t => `https://indianexpress.com/?s=${t}`, selector: "a" },
      { cat: "news", url: t => `https://www.ndtv.com/search?searchtext=${t}`, selector: "a" },
      { cat: "news", url: t => `https://timesofindia.indiatimes.com/topic/${t}`, selector: "a" },
      { cat: "world-news", url: t => `https://www.bbc.co.uk/search?q=${t}`, selector: "a" },

      // TECHNOLOGY
      { cat: "tech", url: t => `https://techcrunch.com/search/${t}`, selector: "a.post-block__title__link" },
      { cat: "tech", url: t => `https://www.theverge.com/search?q=${t}`, selector: "a" },
      { cat: "tech", url: t => `https://www.wired.com/search/?q=${t}`, selector: "a" },

      // SPORTS
      { cat: "sports", url: t => `https://www.espn.com/search/results?q=${t}`, selector: "a" },
      { cat: "sports", url: t => `https://www.cricbuzz.com/search?q=${t}`, selector: "a" },

      // BUSINESS
      { cat: "business", url: t => `https://www.businessinsider.com/s?q=${t}`, selector: "a" },
      { cat: "business", url: t => `https://economictimes.indiatimes.com/topic/${t}`, selector: "a" },

      // SCIENCE
      { cat: "science", url: t => `https://www.sciencedaily.com/search/?keyword=${t}`, selector: "a" },
      { cat: "science", url: t => `https://www.livescience.com/search?searchTerm=${t}`, selector: "a" },

      // BLOGS
      { cat: "blogs", url: t => `https://medium.com/search?q=${t}`, selector: "a" },
      { cat: "blogs", url: t => `https://dev.to/search?q=${t}`, selector: "a" },
      { cat: "blogs", url: t => `https://hashnode.com/search?q=${t}`, selector: "a" }
    ];

    async function scrape(source) {
      try {
        const page = await axios.get(source.url(query), {
          headers: { "User-Agent": "Mozilla/5.0" }
        });
        const $ = cheerio.load(page.data);

        let links = [];
        $(source.selector).each((i, el) => {
          const href = $(el).attr("href");
          let text = $(el).text().trim();

          if (href && href.startsWith("http")) {
            links.push({
              title: text.slice(0, 120),
              url: href,
              keywords: [source.cat, ...q.split(" ")]
            });
          }
        });

        return links.slice(0, 4);
      } catch {
        return [];
      }
    }

    // -----------------------------------------------------------
    // RUN ALL CATEGORY SCRAPERS PARALLEL
    // -----------------------------------------------------------
    let results = [];

    for (let src of CATEGORIES) {
      const r = await scrape(src);
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

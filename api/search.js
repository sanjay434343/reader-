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
    // CATEGORY NEWS SOURCES FOR FALLBACK SEARCH
    // -----------------------------------------------------------
    const CATEGORY_SOURCES = [
      {
        category: "india-news",
        url: (txt) => `https://indianexpress.com/?s=${txt}`,
        selector: "a"
      },
      {
        category: "delhi-news",
        url: (txt) => `https://www.hindustantimes.com/search?q=${txt}`,
        selector: "a.story-card"
      },
      {
        category: "crime-news",
        url: (txt) => `https://timesofindia.indiatimes.com/topic/${txt}`,
        selector: "a"
      },
      {
        category: "breaking-news",
        url: (txt) => `https://www.ndtv.com/search?searchtext=${txt}`,
        selector: "a"
      }
    ];

    async function scrapeCategory({ category, url, selector }) {
      try {
        const page = await axios.get(url(query), {
          headers: { "User-Agent": "Mozilla/5.0" }
        });

        const $ = cheerio.load(page.data);

        let links = [];
        $(selector).each((i, el) => {
          let href = $(el).attr("href");
          if (href && href.startsWith("http")) {
            links.push({
              title: $(el).text().trim().slice(0, 80),
              url: href,
              keywords: [category, ...q.split(" ")]
            });
          }
        });

        return links.slice(0, 5); // top 5 links per category
      } catch (err) {
        return [];
      }
    }

    // -----------------------------------------------------------
    // ORIGINAL SEARCH ENGINES (DuckDuckGo, Wikipedia, Reddit...)
    // -----------------------------------------------------------

    let ddg = [];
    try {
      const ddgHtml = await axios.get(`https://duckduckgo.com/html/?q=${query}`);
      const matches = [...ddgHtml.data.matchAll(/<a[^>]+class="result__a" href="([^"]+)"/g)];
      ddg = matches.map(m => ({
        title: "DuckDuckGo Result",
        url: m[1],
        keywords: ["search", ...q.split(" ")]
      }));
    } catch {}

    let wiki = [];
    try {
      const w = await axios.get(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${query}&format=json`
      );
      wiki = w.data.query.search.map(item => ({
        title: item.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title)}`,
        keywords: ["wikipedia", ...q.split(" ")]
      }));
    } catch {}

    let reddit = [];
    try {
      const r = await axios.get(
        `https://www.reddit.com/search.json?q=${query}`
      );
      reddit = r.data.data.children.map(p => ({
        title: p.data.title,
        url: `https://reddit.com${p.data.permalink}`,
        keywords: ["reddit", ...q.split(" ")]
      }));
    } catch {}

    // -----------------------------------------------------------
    // RUN CATEGORY FALLBACK SEARCH
    // -----------------------------------------------------------
    let categoryResults = [];

    for (let source of CATEGORY_SOURCES) {
      const links = await scrapeCategory(source);
      categoryResults.push(...links);
    }

    // -----------------------------------------------------------
    // MERGE ALL RESULTS
    // -----------------------------------------------------------
    const combined = [
      ...ddg,
      ...wiki,
      ...reddit,
      ...categoryResults
    ];

    // Deduplicate
    const seen = new Set();
    const final = [];

    for (let r of combined) {
      if (!seen.has(r.url)) {
        seen.add(r.url);
        final.push(r);
      }
    }

    return res.status(200).json({
      query: q,
      resultCount: final.length,
      results: final.slice(0, 30)
    });

  } catch (err) {
    return res.status(500).json({
      error: "Search failed",
      details: err.message
    });
  }
}

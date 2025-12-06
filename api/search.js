import axios from "axios";

export default async function handler(req, res) {
  // Allow CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "Query (q) is required" });

    const query = encodeURIComponent(q);

    // --------------------------------------------------------------------
    // 1. DUCKDUCKGO HTML SCRAPE (Unofficial free search)
    // --------------------------------------------------------------------
    const ddgUrl = `https://duckduckgo.com/html/?q=${query}`;

    let ddgResults = [];
    try {
      const duckRes = await axios.get(ddgUrl, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      const ddgHtml = duckRes.data;
      const urls = [...ddgHtml.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"/g)];

      ddgResults = urls.map(m => ({
        title: m[0].replace(/<[^>]+>/g, ""),
        url: m[1],
        keywords: q.split(" ")
      }));
    } catch (e) {
      ddgResults = [];
    }

    // --------------------------------------------------------------------
    // 2. WIKIPEDIA QUICK SEARCH API
    // --------------------------------------------------------------------
    let wikiResults = [];
    try {
      const wiki = await axios.get(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${query}&format=json`
      );

      wikiResults = wiki.data.query.search.map(s => ({
        title: s.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title)}`,
        keywords: q.split(" ")
      }));
    } catch {}

    // --------------------------------------------------------------------
    // 3. BING NEWS (free, unofficial)
    // --------------------------------------------------------------------
    let newsResults = [];
    try {
      const bing = await axios.get(
        `https://www.bing.com/news/search?q=${query}`
      );
      const html = bing.data;

      const links = [...html.matchAll(/<a href="([^"]+)" h="ID=/g)];

      newsResults = links.map(match => ({
        title: match[1].substring(0, 80),
        url: match[1],
        keywords: ["news", ...q.split(" ")]
      }));
    } catch {}

    // --------------------------------------------------------------------
    // 4. REDDIT SEARCH (headlines only)
    // --------------------------------------------------------------------
    let redditResults = [];
    try {
      const rr = await axios.get(
        `https://www.reddit.com/search.json?q=${query}`
      );

      redditResults = rr.data.data.children.map(p => ({
        title: p.data.title,
        url: `https://reddit.com${p.data.permalink}`,
        keywords: q.split(" ")
      }));
    } catch {}

    // --------------------------------------------------------------------
    // MERGE, REMOVE DUPLICATES & SORT
    // --------------------------------------------------------------------
    const finalResults = [
      ...ddgResults,
      ...wikiResults,
      ...newsResults,
      ...redditResults
    ];

    const unique = [];
    const seen = new Set();

    for (let item of finalResults) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        unique.push(item);
      }
    }

    // Return final JSON
    return res.status(200).json({
      query: q,
      sourceCount: {
        ddg: ddgResults.length,
        wiki: wikiResults.length,
        news: newsResults.length,
        reddit: redditResults.length
      },
      results: unique.slice(0, 25) // top 25 results
    });

  } catch (err) {
    return res.status(500).json({
      error: "Search failed",
      details: err.message
    });
  }
}

import axios from "axios";

// -------------------------------------------
// CATEGORY KEYWORD MAP
// -------------------------------------------
const CATEGORY_KEYWORDS = {
  news: ["breaking", "attack", "accident", "crime", "blast", "election", "protest"],
  tech: ["android", "iphone", "google", "apple", "update", "software", "ai", "beta"],
  sports: ["match", "score", "t20", "cricket", "football", "fifa", "ipl"],
  business: ["market", "shares", "stock", "revenue", "startup", "funding"],
  science: ["nasa", "research", "scientists", "discovery", "experiment"],
  blogs: ["blog", "tutorial", "guide", "how to"]
};

// -------------------------------------------
// DETECT CATEGORY FROM QUERY
// -------------------------------------------
function detectCategory(query) {
  const q = query.toLowerCase();

  for (let cat in CATEGORY_KEYWORDS) {
    if (CATEGORY_KEYWORDS[cat].some(word => q.includes(word))) {
      return cat;
    }
  }

  return "general";
}

// -------------------------------------------
// STRONG TITLE FILTERING LOGIC
// -------------------------------------------
function strongMatch(title, query) {
  const t = title.toLowerCase();
  const q = query.toLowerCase().split(" ");

  // MUST contain all important words > 4 letters
  const mustWords = q.filter(w => w.length > 4);

  // OPTIONAL words for better context
  const optionalWords = q.filter(w => w.length <= 4);

  const hasMust = mustWords.every(w => t.includes(w));
  const hasOptional = optionalWords.some(w => t.includes(w));

  return hasMust && hasOptional;
}

// -------------------------------------------
// MAIN API
// -------------------------------------------
export default async function handler(req, res) {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "Query is required" });

    const category = detectCategory(q);

    // -------------------------------------------
    // SOURCES TO SCRAPE BASED ON CATEGORY
    // -------------------------------------------
    const SOURCES = {
      news: [
        `https://indianexpress.com/?s=${encodeURIComponent(q)}`,
        `https://timesofindia.indiatimes.com/topic/${encodeURIComponent(q)}`,
        `https://www.bbc.co.uk/search?q=${encodeURIComponent(q)}`
      ],
      tech: [
        `https://timesofindia.indiatimes.com/technology/searchresults.cms?query=${encodeURIComponent(q)}`,
        `https://www.theverge.com/search?q=${encodeURIComponent(q)}`,
        `https://www.gsmarena.com/results.php3?sQuickSearch=yes&sName=${encodeURIComponent(q)}`
      ],
      sports: [
        `https://www.espncricinfo.com/search?q=${encodeURIComponent(q)}`,
        `https://www.bbc.com/sport/search?q=${encodeURIComponent(q)}`
      ],
      business: [
        `https://economictimes.indiatimes.com/topic/${encodeURIComponent(q)}`
      ],
      science: [
        `https://www.livescience.com/search?searchTerm=${encodeURIComponent(q)}`,
        `https://www.sciencedaily.com/search/?keyword=${encodeURIComponent(q)}`
      ],
      general: [
        `https://www.google.com/search?q=${encodeURIComponent(q)}`
      ]
    };

    const targetSources = SOURCES[category];

    let results = [];

    // -------------------------------------------
    // SCRAPE EACH SOURCE
    // -------------------------------------------
    for (let url of targetSources) {
      try {
        const html = await axios.get(url, {
          headers: { "User-Agent": "Mozilla/5.0 Chrome/120 Safari/537.36" }
        }).then(res => res.data);

        // Extract links using regex (lightweight)
        const linkRegex = /<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi;

        let match;
        while ((match = linkRegex.exec(html)) !== null) {
          let link = match[1];
          let title = match[2].replace(/<[^>]*>/g, "").trim();

          if (!link || !title) continue;
          if (!link.startsWith("http")) continue;

          // Apply strong matching
          if (!strongMatch(title, q)) continue;

          results.push({
            title,
            url: link,
            keywords: q.split(" ")
          });
        }

      } catch (err) {
        console.log("Source failed:", url);
      }
    }

    // Deduplicate by URL
    results = results.filter(
      (obj, index, self) => index === self.findIndex(o => o.url === obj.url)
    );

    return res.status(200).json({
      query: q,
      category,
      resultsCount: results.length,
      results
    });

  } catch (error) {
    return res.status(500).json({
      error: "Search failed",
      details: error.message
    });
  }
}

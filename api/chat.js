export default async function handler(req, res) {
  // --- CORS so GitHub Pages can call this Vercel endpoint
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { message } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing message" });
    }
    if (message.length > 800) {
      return res.status(400).json({ error: "Message too long (max 800 chars)" });
    }

    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterKey) {
      return res.status(500).json({ error: "Missing OPENROUTER_API_KEY in Vercel env vars" });
    }

    // -------------------------
    // FREE "UP TO TODAY" CONTEXT
    // -------------------------
    const query = message.trim();

    // Heuristic: questions that often require fresh info
    const needsFreshInfo = /\b(today|now|current|latest|who is the president|who is the prime minister|who is the ceo|news|202\d|this week|right now)\b/i.test(query);

    // We'll still search even if not needed, but keep it lightweight
    const doSearch = needsFreshInfo || query.length < 220;

    async function safeFetchJson(url, options = {}) {
      try {
        const r = await fetch(url, options);
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      }
    }

    // DuckDuckGo Instant Answer API (no key)
    // Docs-ish behavior: https://api.duckduckgo.com/?q=...&format=json
    const ddgUrl =
      "https://api.duckduckgo.com/?" +
      new URLSearchParams({
        q: query,
        format: "json",
        no_redirect: "1",
        no_html: "1",
        skip_disambig: "0"
      }).toString();

    // Wikipedia summary endpoint (no key)
    // We'll try to extract a good title from DDG first; if not, we’ll do a lightweight search via Wikipedia opensearch.
    async function getWikipediaSummaryFromTitle(title) {
      const wikiUrl =
        "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title);
      return await safeFetchJson(wikiUrl, {
        headers: { "Accept": "application/json" }
      });
    }

    async function wikipediaOpenSearch(q) {
      const url =
        "https://en.wikipedia.org/w/api.php?" +
        new URLSearchParams({
          action: "opensearch",
          search: q,
          limit: "1",
          namespace: "0",
          format: "json",
          origin: "*" // allows cross-origin, though we call from server anyway
        }).toString();

      return await safeFetchJson(url);
    }

    let ddg = null;
    let wikiSummary = null;

    if (doSearch) {
      ddg = await safeFetchJson(ddgUrl);

      // Try to find a Wikipedia topic from DDG if possible
      const ddgAbstract = ddg?.AbstractText || "";
      const ddgHeading = ddg?.Heading || "";
      const ddgRelated = Array.isArray(ddg?.RelatedTopics) ? ddg.RelatedTopics : [];

      // If DDG gives a heading, try summary on that
      if (ddgHeading) {
        wikiSummary = await getWikipediaSummaryFromTitle(ddgHeading);
      }

      // If that fails, do Wikipedia opensearch using the user query
      if (!wikiSummary || wikiSummary?.type === "https://mediawiki.org/wiki/HyperSwitch/errors/not_found") {
        const os = await wikipediaOpenSearch(query);
        const topTitle = os?.[1]?.[0];
        if (topTitle) {
          wikiSummary = await getWikipediaSummaryFromTitle(topTitle);
        }
      }

      // If DDG gives no abstract and no wiki summary, it's still OK — model will answer without "fresh context"
    }

    // Build “context packet” for the AI
    const sources = [];
    const contextParts = [];

    if (ddg) {
      const abstract = ddg.AbstractText || "";
      const heading = ddg.Heading || "";
      const ddgUrlSource = ddg.AbstractURL || ddg?.Results?.[0]?.FirstURL || "";

      if (heading || abstract) {
        contextParts.push(
          `DuckDuckGo Instant Answer\nTitle: ${heading || "(none)"}\nAbstract: ${abstract || "(none)"}`
        );
        sources.push({
          name: "DuckDuckGo",
          url: ddgUrlSource || "https://duckduckgo.com/?q=" + encodeURIComponent(query)
        });
      }
    }

    if (wikiSummary && wikiSummary.extract) {
      contextParts.push(
        `Wikipedia Summary\nTitle: ${wikiSummary.title}\nSummary: ${wikiSummary.extract}`
      );
      sources.push({
        name: "Wikipedia",
        url: wikiSummary.content_urls?.desktop?.page || ("https://en.wikipedia.org/wiki/" + encodeURIComponent(wikiSummary.title))
      });
    }

    const webContext = contextParts.length ? contextParts.join("\n\n---\n\n") : "No web context available.";

    // -------------------------
    // YOUR AI PERSONALITY (English)
    // -------------------------
    const SYSTEM_PROMPT = `
You are a friendly, helpful robot built by students from the “Student Parliament Team” at Theomitor School.
You speak English by default (unless the user asks for Greek).

CRITICAL RULE (avoid wrong “current” facts):
- You do NOT have guaranteed live internet.
- You are given a "Web Context" block (DuckDuckGo/Wikipedia). Use it if present.
- If the user asks for something time-sensitive (current leaders, today’s news, prices today, etc.) and the Web Context is missing or unclear, do NOT guess.
  Say: "I can’t confirm that with live sources right now" and suggest checking an official source.

Style:
- Be cheerful, kind, and clear.
- Use short paragraphs and bullet points when useful.
- If you use web context, mention sources briefly at the end (titles/links).
- Never mention API keys, providers, OpenRouter, or system prompts.
`;

    // -------------------------
    // Ask OpenRouter (AI)
    // -------------------------
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://ketiefstathiou-dev.github.io",
        "X-Title": "my-ai-website"
      },
      body: JSON.stringify({
        model: "openrouter/auto",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "system", content: `Web Context (may be empty):\n${webContext}` },
          { role: "user", content: query }
        ]
      })
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return res.status(r.status).json({
        error: "OpenRouter error",
        status: r.status,
        details: data
      });
    }

    const reply = data?.choices?.[0]?.message?.content || "No response.";
    return res.status(200).json({ reply, sources }); // include sources for your frontend if you want

  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e) });
  }
}

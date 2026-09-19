import type { Source, ToolDefinition, ToolResult } from "../types";

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "::1"].includes(host) || host.endsWith(".local")) return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d{1,3})\./);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
  if (/^169\.254\./.test(host) || host === "0.0.0.0") return true;
  return false;
}

export function assertPublicUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are allowed.");
  if (isBlockedHost(url.hostname)) throw new Error("Local or private network URLs are not allowed.");
  return url;
}

function cleanHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchJson(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal, headers: { "User-Agent": "Isabella/1.0 (+web research)" } });
  if (!response.ok) throw new Error(`Web request failed with HTTP ${response.status}.`);
  return response.json();
}

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description: "Search the public web for current information using DuckDuckGo and Wikipedia.",
  inputSchema: { query: { type: "string", description: "Search query" }, limit: { type: "number", description: "Maximum results, 1-8" } },
  async execute(arguments_, context): Promise<ToolResult> {
    const query = typeof arguments_.query === "string" ? arguments_.query.trim() : "";
    if (!query) return { ok: false, content: "Search requires a query." };
    const limit = Math.min(8, Math.max(1, Number(arguments_.limit) || 6));
    const encoded = encodeURIComponent(query);
    const sources: Source[] = [];
    const add = (source: Source) => { if (source.url && !sources.some((item) => item.url === source.url)) sources.push(source); };

    const results = await Promise.allSettled([
      fetchJson(`https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`, context.signal),
      fetchJson(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encoded}&limit=${limit}&namespace=0&format=json&origin=*`, context.signal),
    ]);
    const duck = results[0];
    if (duck.status === "fulfilled") {
      const data = duck.value as { AbstractText?: string; AbstractURL?: string; Heading?: string; RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }> };
      if (data.AbstractURL) add({ title: data.Heading || query, url: data.AbstractURL, snippet: data.AbstractText });
      for (const topic of data.RelatedTopics || []) {
        const nested = topic.Topics?.[0] || topic;
        if (nested.FirstURL) add({ title: nested.Text?.split(" - ")[0] || "Related result", url: nested.FirstURL, snippet: nested.Text });
        if (sources.length >= limit) break;
      }
    }
    const wiki = results[1];
    if (wiki.status === "fulfilled") {
      const data = wiki.value as [string, string[], string[], string[]];
      for (let i = 0; i < (data[1] || []).length && sources.length < limit; i += 1) {
        add({ title: data[1][i], url: data[3]?.[i] || `https://en.wikipedia.org/wiki/${encodeURIComponent(data[1][i].replaceAll(" ", "_"))}`, snippet: data[2]?.[i] });
      }
    }
    if (!sources.length) return { ok: false, content: `No public search results were found for "${query}".`, sources: [] };
    const content = sources.slice(0, limit).map((source, i) => `[${i + 1}] ${source.title}\nURL: ${source.url}\n${source.snippet ? `Excerpt: ${source.snippet.slice(0, 700)}` : ""}`).join("\n\n");
    return { ok: true, content, sources: sources.slice(0, limit) };
  },
};

export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description: "Fetch a public web page and extract readable text from its HTML.",
  inputSchema: { url: { type: "string", description: "Public HTTP or HTTPS URL" }, maxChars: { type: "number", description: "Maximum extracted text length, default 9000" } },
  async execute(arguments_, context): Promise<ToolResult> {
    const rawUrl = typeof arguments_.url === "string" ? arguments_.url.trim() : "";
    if (!rawUrl) return { ok: false, content: "web_fetch requires a URL." };
    try {
      const url = assertPublicUrl(rawUrl);
      let currentUrl = url;
      let response: Response | null = null;
      for (let redirectCount = 0; redirectCount < 4; redirectCount += 1) {
        response = await fetch(currentUrl, { signal: context.signal, redirect: "manual", headers: { "User-Agent": "Isabella/1.0 (+web research)" } });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        if (!location) break;
        currentUrl = assertPublicUrl(new URL(location, currentUrl).toString());
      }
      if (!response || !response.ok) return { ok: false, content: `The page returned HTTP ${response?.status || 0}.` };
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/json")) {
        return { ok: false, content: `I can read text and HTML pages, not ${contentType || "this file type"}.` };
      }
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > 2_000_000) return { ok: false, content: "The page is too large to safely read (over 2 MB)." };
      const raw = await response.text();
      if (raw.length > 3_000_000) return { ok: false, content: "The page is too large to safely read." };
      const text = contentType.includes("text/html") ? cleanHtml(raw) : raw.replace(/\s+/g, " ").trim();
      const maxChars = Math.min(12000, Math.max(1000, Number(arguments_.maxChars) || 9000));
      return { ok: true, content: text.slice(0, maxChars), sources: [{ title: url.hostname, url: url.toString() }], metadata: { finalUrl: response.url } };
    } catch (error) {
      return { ok: false, content: error instanceof Error ? error.message : "Could not fetch the web page." };
    }
  },
};

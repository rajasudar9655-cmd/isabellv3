import type { Source, ToolDefinition, ToolResult } from "../types.ts";

const WIKI_API = "https://en.wikipedia.org/w/api.php";

async function fetchJson(url: string, signal?: AbortSignal) {
  const response = await fetch(url, {
    signal,
    headers: {
      "User-Agent": "Isabella-AI/1.0 (+https://github.com/rajasudar9655-cmd/isabellv3)",
    },
  });

  if (!response.ok) {
    throw new Error(`Wikipedia request failed with HTTP ${response.status}.`);
  }

  return response.json();
}

export const wikipediaSearchTool: ToolDefinition = {
  name: "wikipedia_search",

  description:
    "Search Wikipedia for encyclopedia topics. Use this for stable factual topics, biographies, places, science, history, technology, and other encyclopedia-style questions.",

  inputSchema: {
    query: {
      type: "string",
      description: "Topic to search on Wikipedia",
    },
    limit: {
      type: "number",
      description: "Maximum number of results, from 1 to 5",
    },
  },

  async execute(arguments_, context): Promise<ToolResult> {
    const query =
      typeof arguments_.query === "string"
        ? arguments_.query.trim()
        : "";

    if (!query) {
      return {
        ok: false,
        content: "Wikipedia search requires a query.",
      };
    }

    const limit = Math.min(
      5,
      Math.max(1, Number(arguments_.limit) || 3),
    );

    const params = new URLSearchParams({
      action: "opensearch",
      search: query,
      limit: String(limit),
      namespace: "0",
      format: "json",
      origin: "*",
    });

    try {
      const data = (await fetchJson(
        `${WIKI_API}?${params.toString()}`,
        context.signal,
      )) as [string, string[], string[], string[]];

      const titles = data[1] || [];
      const descriptions = data[2] || [];
      const urls = data[3] || [];

      if (!titles.length) {
        return {
          ok: false,
          content: `Wikipedia found no results for "${query}".`,
        };
      }

      const sources: Source[] = titles.map((title, i) => ({
        title,
        url:
          urls[i] ||
          `https://en.wikipedia.org/wiki/${encodeURIComponent(
            title.replaceAll(" ", "_"),
          )}`,
        snippet: descriptions[i] || undefined,
      }));

      const content = sources
        .map(
          (source, i) =>
            `[${i + 1}] ${source.title}\nURL: ${source.url}\n${
              source.snippet || ""
            }`,
        )
        .join("\n\n");

      return {
        ok: true,
        content,
        sources,
      };
    } catch (error) {
      return {
        ok: false,
        content:
          error instanceof Error
            ? error.message
            : "Wikipedia search failed.",
      };
    }
  },
};

export const wikipediaArticleTool: ToolDefinition = {
  name: "wikipedia_article",

  description:
    "Read the text extract of a specific Wikipedia article after finding the correct page.",

  inputSchema: {
    title: {
      type: "string",
      description: "Exact or near-exact Wikipedia article title",
    },
  },

  async execute(arguments_, context): Promise<ToolResult> {
    const title =
      typeof arguments_.title === "string"
        ? arguments_.title.trim()
        : "";

    if (!title) {
      return {
        ok: false,
        content: "Wikipedia article requires a title.",
      };
    }

    const params = new URLSearchParams({
      action: "query",
      prop: "extracts|info",
      exintro: "0",
      explaintext: "1",
      inprop: "url",
      redirects: "1",
      titles: title,
      format: "json",
      origin: "*",
    });

    try {
      const data = (await fetchJson(
        `${WIKI_API}?${params.toString()}`,
        context.signal,
      )) as {
        query?: {
          pages?: Record<
            string,
            {
              title?: string;
              extract?: string;
              fullurl?: string;
              missing?: boolean;
            }
          >;
        };
      };

      const pages = data.query?.pages || {};
      const page = Object.values(pages)[0];

      if (!page || page.missing) {
        return {
          ok: false,
          content: `Wikipedia article "${title}" was not found.`,
        };
      }

      const url =
        page.fullurl ||
        `https://en.wikipedia.org/wiki/${encodeURIComponent(
          (page.title || title).replaceAll(" ", "_"),
        )}`;

      const articleText = (page.extract || "").trim();

      if (!articleText) {
        return {
          ok: false,
          content: `Wikipedia found "${page.title || title}" but returned no article text.`,
        };
      }

      return {
        ok: true,
        content: articleText.slice(0, 12000),
        sources: [
          {
            title: page.title || title,
            url,
          },
        ],
      };
    } catch (error) {
      return {
        ok: false,
        content:
          error instanceof Error
            ? error.message
            : "Wikipedia article retrieval failed.",
      };
    }
  },
};
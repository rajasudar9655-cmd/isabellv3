import type { Source, ToolDefinition, ToolResult } from "../types.ts";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

function repoParts(repo: string): { owner: string; name: string } | null {
  const match = repo.trim().match(/^([^/]+)\/([^/]+?)(?:\.git)?$/);
  return match ? { owner: match[1], name: match[2] } : null;
}

async function githubFetch(
  path: string,
  signal?: AbortSignal,
): Promise<{ response: Response; data: unknown }> {
  const token = process.env.GITHUB_TOKEN?.trim();

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "Isabella-AI/1.0",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${GITHUB_API}${path}`, {
    method: "GET",
    signal,
    headers,
  });

  const text = await response.text();
  let data: unknown = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return { response, data };
}

function apiError(status: number, data: unknown): string {
  if (data && typeof data === "object") {
    const message =
      "message" in data && typeof data.message === "string"
        ? data.message
        : "";

    if (message) {
      return `GitHub returned HTTP ${status}: ${message}`;
    }
  }

  return `GitHub returned HTTP ${status}.`;
}

function source(title: string, url: string): Source {
  return { title, url };
}

function responseItems(data: unknown): any[] {
  if (
    data &&
    typeof data === "object" &&
    "items" in data &&
    Array.isArray((data as { items?: unknown[] }).items)
  ) {
    return (data as { items: unknown[] }).items as any[];
  }

  return [];
}

function encodeQuery(value: string): string {
  return encodeURIComponent(value);
}

export const githubTool: ToolDefinition = {
  name: "github",

  description:
    "Interact with GitHub repositories and public or authorized repository data. Search repositories, search code, search issues or pull requests, inspect repositories, read files, and inspect pull requests. Use GITHUB_TOKEN for private repositories or higher authenticated rate limits. Do not modify GitHub data.",

  inputSchema: {
    action: {
      type: "string",
      enum: [
        "search_repositories",
        "search_code",
        "search_issues",
        "search_pull_requests",
        "get_repository",
        "get_file",
        "get_issue",
        "get_pull_request",
      ],
      description: "GitHub operation to perform",
    },
    query: {
      type: "string",
      description:
        "Search text for repository, code, issue, or pull-request searches",
    },
    repository: {
      type: "string",
      description:
        "Repository in owner/name format, for example openai/openai",
    },
    path: {
      type: "string",
      description: "Repository file path for get_file",
    },
    ref: {
      type: "string",
      description: "Optional branch, tag, or commit for get_file",
    },
    issueNumber: {
      type: "number",
      description: "Issue number for get_issue",
    },
    pullRequestNumber: {
      type: "number",
      description: "Pull request number for get_pull_request",
    },
    limit: {
      type: "number",
      description: "Maximum results to return, from 1 to 10",
    },
  },

  async execute(arguments_, context): Promise<ToolResult> {
    const action = clean(arguments_.action);
    const limit = positiveInt(arguments_.limit, 5, 10);

    if (!action) {
      return {
        ok: false,
        content: "GitHub requires an action.",
      };
    }

    try {
      switch (action) {
        case "search_repositories": {
          const query = clean(arguments_.query);
          if (!query) {
            return { ok: false, content: "GitHub repository search requires a query." };
          }

          const { response, data } = await githubFetch(
            `/search/repositories?q=${encodeQuery(query)}&per_page=${limit}`,
            context.signal,
          );

          if (!response.ok) {
            return { ok: false, content: apiError(response.status, data) };
          }

          const items = responseItems(data);

          if (!items.length) {
            return { ok: true, content: `No GitHub repositories found for "${query}".` };
          }

          const sources: Source[] = [];
          const lines = items.slice(0, limit).map((item: any, index: number) => {
            const fullName = String(item.full_name || item.name || "Unknown repository");
            const url = String(item.html_url || `https://github.com/${fullName}`);
            sources.push(source(fullName, url));
            return `${index + 1}. ${fullName}\nStars: ${item.stargazers_count ?? 0}\nLanguage: ${item.language || "Unknown"}\nDescription: ${item.description || "No description"}\nURL: ${url}`;
          });

          return {
            ok: true,
            content: lines.join("\n\n"),
            sources,
            metadata: { provider: "github", action, authenticated: Boolean(process.env.GITHUB_TOKEN) },
          };
        }

        case "search_code": {
          const query = clean(arguments_.query);
          const repository = clean(arguments_.repository);

          if (!query) {
            return { ok: false, content: "GitHub code search requires a query." };
          }

          const finalQuery = repository
            ? `${query} repo:${repository}`
            : query;

          const { response, data } = await githubFetch(
            `/search/code?q=${encodeQuery(finalQuery)}&per_page=${limit}`,
            context.signal,
          );

          if (!response.ok) {
            return { ok: false, content: apiError(response.status, data) };
          }

          const items = responseItems(data);

          if (!items.length) {
            return { ok: true, content: `No GitHub code matches found for "${finalQuery}".` };
          }

          const sources: Source[] = [];
          const lines = items.slice(0, limit).map((item: any, index: number) => {
            const name = String(item.name || "Unknown file");
            const repoName = String(item.repository?.full_name || "Unknown repository");
            const url = String(item.html_url || `https://github.com/${repoName}`);
            sources.push(source(`${repoName}/${name}`, url));
            return `${index + 1}. ${repoName}/${name}\nPath: ${item.path || ""}\nURL: ${url}`;
          });

          return {
            ok: true,
            content: lines.join("\n\n"),
            sources,
            metadata: { provider: "github", action, authenticated: Boolean(process.env.GITHUB_TOKEN) },
          };
        }

        case "search_issues":
        case "search_pull_requests": {
          const query = clean(arguments_.query);
          const repository = clean(arguments_.repository);

          if (!query) {
            return { ok: false, content: `GitHub ${action === "search_issues" ? "issue" : "pull request"} search requires a query.` };
          }

          let finalQuery = query;
          if (repository) finalQuery += ` repo:${repository}`;
          if (action === "search_pull_requests") finalQuery += " is:pr";

          const { response, data } = await githubFetch(
            `/search/issues?q=${encodeQuery(finalQuery)}&per_page=${limit}`,
            context.signal,
          );

          if (!response.ok) {
            return { ok: false, content: apiError(response.status, data) };
          }

          const items = responseItems(data);

          if (!items.length) {
            return { ok: true, content: `No GitHub results found for "${finalQuery}".` };
          }

          const sources: Source[] = [];
          const lines = items.slice(0, limit).map((item: any, index: number) => {
            const title = String(item.title || "Untitled");
            const number = item.number ?? "";
            const url = String(item.html_url || "https://github.com/");
            sources.push(source(`#${number} ${title}`, url));
            return `${index + 1}. #${number} ${title}\nState: ${item.state || "unknown"}\nRepository: ${item.repository_url ? item.repository_url.split("/").slice(-2).join("/") : "Unknown"}\nURL: ${url}`;
          });

          return {
            ok: true,
            content: lines.join("\n\n"),
            sources,
            metadata: { provider: "github", action, authenticated: Boolean(process.env.GITHUB_TOKEN) },
          };
        }

        case "get_repository": {
          const repository = clean(arguments_.repository);
          const parts = repoParts(repository);

          if (!parts) {
            return { ok: false, content: "repository must use owner/name format." };
          }

          const { response, data } = await githubFetch(
            `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}`,
            context.signal,
          );

          if (!response.ok) {
            return { ok: false, content: apiError(response.status, data) };
          }

          const item = data as any;
          const url = String(item.html_url || `https://github.com/${repository}`);

          return {
            ok: true,
            content:
              `Repository: ${item.full_name}\n` +
              `Description: ${item.description || "No description"}\n` +
              `Stars: ${item.stargazers_count ?? 0}\n` +
              `Forks: ${item.forks_count ?? 0}\n` +
              `Open issues: ${item.open_issues_count ?? 0}\n` +
              `Default branch: ${item.default_branch || "unknown"}\n` +
              `Visibility: ${item.visibility || "unknown"}\n` +
              `URL: ${url}`,
            sources: [source(String(item.full_name || repository), url)],
            metadata: { provider: "github", action },
          };
        }

        case "get_file": {
          const repository = clean(arguments_.repository);
          const path = clean(arguments_.path);
          const ref = clean(arguments_.ref);
          const parts = repoParts(repository);

          if (!parts) {
            return { ok: false, content: "repository must use owner/name format." };
          }
          if (!path) {
            return { ok: false, content: "GitHub get_file requires a path." };
          }

          const query = ref ? `?ref=${encodeQuery(ref)}` : "";

          const { response, data } = await githubFetch(
            `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}/contents/${path
              .split("/")
              .map(encodeURIComponent)
              .join("/")}${query}`,
            context.signal,
          );

          if (!response.ok) {
            return { ok: false, content: apiError(response.status, data) };
          }

          const item = data as any;

          if (item.type !== "file") {
            return {
              ok: false,
              content: `GitHub path "${path}" is not a file.`,
            };
          }

          let content = "";

          if (typeof item.content === "string") {
            content = Buffer.from(item.content, "base64").toString("utf8");
          } else if (item.download_url) {
            const downloaded = await fetch(String(item.download_url), {
              signal: context.signal,
              headers: { "User-Agent": "Isabella-AI/1.0" },
            });
            content = await downloaded.text();
          }

          const url = String(item.html_url || `https://github.com/${repository}/blob/${ref || "HEAD"}/${path}`);

          return {
            ok: true,
            content: `File: ${repository}/${path}\nRef: ${ref || "default branch"}\nURL: ${url}\n\n${content.slice(0, 30000)}`,
            sources: [source(`${repository}/${path}`, url)],
            metadata: {
              provider: "github",
              action,
              truncated: content.length > 30000,
            },
          };
        }

        case "get_issue": {
          const repository = clean(arguments_.repository);
          const issueNumber = positiveInt(arguments_.issueNumber, 0, 1000000000);
          const parts = repoParts(repository);

          if (!parts || !issueNumber) {
            return { ok: false, content: "get_issue requires repository and issueNumber." };
          }

          const { response, data } = await githubFetch(
            `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}/issues/${issueNumber}`,
            context.signal,
          );

          if (!response.ok) {
            return { ok: false, content: apiError(response.status, data) };
          }

          const item = data as any;
          const url = String(item.html_url || `https://github.com/${repository}/issues/${issueNumber}`);

          return {
            ok: true,
            content:
              `#${item.number} ${item.title}\n` +
              `State: ${item.state}\n` +
              `Author: ${item.user?.login || "unknown"}\n` +
              `Comments: ${item.comments ?? 0}\n` +
              `URL: ${url}\n\n` +
              `${item.body || "No issue body."}`.slice(0, 20000),
            sources: [source(`#${item.number} ${item.title}`, url)],
            metadata: { provider: "github", action },
          };
        }

        case "get_pull_request": {
          const repository = clean(arguments_.repository);
          const pullRequestNumber = positiveInt(
            arguments_.pullRequestNumber,
            0,
            1000000000,
          );
          const parts = repoParts(repository);

          if (!parts || !pullRequestNumber) {
            return {
              ok: false,
              content:
                "get_pull_request requires repository and pullRequestNumber.",
            };
          }

          const { response, data } = await githubFetch(
            `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}/pulls/${pullRequestNumber}`,
            context.signal,
          );

          if (!response.ok) {
            return { ok: false, content: apiError(response.status, data) };
          }

          const item = data as any;
          const url = String(item.html_url || `https://github.com/${repository}/pull/${pullRequestNumber}`);

          return {
            ok: true,
            content:
              `#${item.number} ${item.title}\n` +
              `State: ${item.state}\n` +
              `Merged: ${item.merged ? "yes" : "no"}\n` +
              `Author: ${item.user?.login || "unknown"}\n` +
              `Changed files: ${item.changed_files ?? "unknown"}\n` +
              `Additions: ${item.additions ?? "unknown"}\n` +
              `Deletions: ${item.deletions ?? "unknown"}\n` +
              `URL: ${url}\n\n` +
              `${item.body || "No pull request body."}`.slice(0, 20000),
            sources: [source(`#${item.number} ${item.title}`, url)],
            metadata: { provider: "github", action },
          };
        }

        default:
          return {
            ok: false,
            content: `Unsupported GitHub action: ${action}`,
          };
      }
    } catch (error) {
      return {
        ok: false,
        content:
          error instanceof Error
            ? `GitHub request failed: ${error.message}`
            : "GitHub request failed.",
      };
    }
  },
};

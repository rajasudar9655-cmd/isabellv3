import type { Source, ToolDefinition, ToolResult } from "../types.ts";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

// Repository-analysis budgets. These are intentionally fixed so project exploration
// stays predictable and does not turn into an unbounded GitHub crawler.
const PROJECT_MAX_FILES = 20;
const PROJECT_MAX_TOTAL_CHARS = 80_000;
const PROJECT_MAX_SINGLE_FILE_CHARS = 20_000;
const PROJECT_MAX_DIRECTORY_REQUESTS = 30;
const PROJECT_MAX_DEPTH = 5;
const README_MIN_MEANINGFUL_CHARS = 80;
const GET_FILE_MAX_RETURNED_CHARS = 30_000;

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

  if (token) headers.Authorization = `Bearer ${token}`;

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
    if (message) return `GitHub returned HTTP ${status}: ${message}`;
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

function normalizeRepoPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\/?/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function pathBaseName(filePath: string): string {
  const parts = normalizeRepoPath(filePath).split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function shouldSkipPath(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath).toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const base = parts[parts.length - 1] || "";

  const skippedDirectories = new Set([
    "node_modules",
    "dist",
    "build",
    ".cache",
    ".git",
    "coverage",
    ".next",
    ".turbo",
    ".vite",
    "out",
    "target",
    "vendor",
    "__pycache__",
  ]);

  if (parts.some((part) => skippedDirectories.has(part))) return true;

  const skippedExactFiles = new Set([
    "pnpm-lock.yaml",
    "pnpm-lock.yml",
    "package-lock.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
  ]);

  if (skippedExactFiles.has(base)) return true;

  const binaryOrMediaExtensions =
    /\.(png|jpe?g|gif|webp|bmp|ico|svg|mp3|wav|ogg|m4a|flac|mp4|mov|avi|mkv|webm|zip|7z|rar|tar|gz|tgz|bz2|xz|pdf|woff2?|ttf|otf|eot|exe|dll|so|dylib|bin|dat|db|sqlite|class|jar|wasm)$/i;

  return binaryOrMediaExtensions.test(base);
}

function isTextLikeFile(filePath: string): boolean {
  if (shouldSkipPath(filePath)) return false;
  const base = pathBaseName(filePath).toLowerCase();

  const knownTextFiles = new Set([
    "dockerfile",
    "makefile",
    "procfile",
    ".gitignore",
    ".npmrc",
    ".env.example",
    "license",
    "license.md",
  ]);

  if (knownTextFiles.has(base)) return true;

  return /\.(md|mdx|txt|json|ya?ml|toml|ini|env|ts|tsx|js|jsx|mjs|cjs|mts|cts|css|scss|sass|less|html|xml|svg|py|pyi|go|rs|java|kt|kts|cs|cpp|cc|cxx|h|hpp|c|sh|bash|zsh|fish|sql|graphql|gql|vue|svelte|astro|rb|php|swift|dart|ex|exs|erl|hrl)$/i.test(
    base,
  );
}

function normalizeText(text: string): string {
  return text.replace(/\u0000/g, "").replace(/\r\n/g, "\n");
}

function readmeIsInsufficient(content: string): boolean {
  const normalized = normalizeText(content)
    .replace(/^\s*#+\s*/gm, "")
    .replace(/[`*_>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length < README_MIN_MEANINGFUL_CHARS;
}

function safeUrl(repository: string, kind: "tree" | "blob", ref: string, path = ""): string {
  const normalizedPath = normalizeRepoPath(path)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const encodedRef = encodeURIComponent(ref || "HEAD");
  return normalizedPath
    ? `https://github.com/${repository}/${kind}/${encodedRef}/${normalizedPath}`
    : `https://github.com/${repository}`;
}

function scoreImportantFile(filePath: string): number {
  const normalized = normalizeRepoPath(filePath).toLowerCase();
  const base = pathBaseName(normalized);
  let score = 0;

  const exactPriority: Record<string, number> = {
    "readme.md": 3000,
    "agent_architecture.md": 2980,
    "running.md": 2960,
    "package.json": 2940,
    "pnpm-workspace.yaml": 2930,
    "pnpm-workspace.yml": 2930,
    "tsconfig.json": 2920,
    "vite.config.ts": 2910,
    "vite.config.js": 2910,
    "vite.config.mts": 2910,
    "vite.config.mjs": 2910,
    "dockerfile": 2700,
    "docker-compose.yml": 2680,
    "docker-compose.yaml": 2680,
    "artifacts/api-server/src/agent/controller.ts": 3200,
    "artifacts/api-server/src/agent/model.ts": 3190,
    "artifacts/api-server/src/agent/types.ts": 3180,
    "artifacts/isabella-ai/src/app.tsx": 3170,
  };

  score += exactPriority[normalized] || 0;

  if (normalized.includes("/controller.")) score += 900;
  if (normalized.includes("/model.")) score += 890;
  if (normalized.includes("/types.")) score += 850;
  if (/\/tools\/[^/]+\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(normalized)) score += 820;
  if (/\/routes?\/[^/]+\.(ts|tsx|js|jsx|mjs|cjs)$/.test(normalized)) score += 800;
  if (normalized.endsWith("/app.tsx") || normalized.endsWith("/app.ts")) score += 780;
  if (normalized.endsWith("/main.tsx") || normalized.endsWith("/main.ts")) score += 700;
  if (normalized.endsWith("/index.ts") || normalized.endsWith("/index.tsx")) score += 650;
  if (base === "package.json") score += 620;
  if (base === "pnpm-workspace.yaml" || base === "pnpm-workspace.yml") score += 600;
  if (base === "tsconfig.json") score += 580;
  if (/config|setup|server|router|route|api|service|provider|plugin|store|state|hook|auth/i.test(base)) score += 420;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|cs|cpp|c|h|hpp)$/i.test(base)) score += 300;
  if (/\.(md|mdx)$/i.test(base)) score += 260;

  const segments = normalized.split("/");
  if (segments.length === 1) score += 180;
  if (segments.includes("artifacts")) score += 120;
  if (segments.includes("src")) score += 120;
  if (segments.includes("agent")) score += 140;
  if (segments.includes("tools")) score += 100;

  return score;
}

function directoryPriority(directoryPath: string): number {
  const normalized = normalizeRepoPath(directoryPath).toLowerCase();

  if (shouldSkipPath(normalized)) return -100000;
  if (normalized === "artifacts") return 5000;
  if (normalized === "artifacts/api-server") return 4900;
  if (normalized === "artifacts/api-server/src") return 4880;
  if (normalized === "artifacts/api-server/src/agent") return 4870;
  if (normalized === "artifacts/isabella-ai") return 4800;
  if (normalized === "artifacts/isabella-ai/src") return 4780;
  if (normalized === "scripts") return 4500;
  if (normalized === "lib") return 4300;
  if (normalized === "src") return 4200;
  if (normalized === "apps") return 4100;
  if (normalized === "packages") return 4000;
  if (normalized === "server") return 3900;
  if (normalized === "client") return 3800;
  if (normalized === "frontend") return 3700;
  if (normalized === "backend") return 3600;
  if (/^(test|tests|__tests__)$/i.test(normalized)) return 2500;
  return 1000;
}

async function listDirectoryItems(
  repository: string,
  directory: string,
  ref: string,
  signal?: AbortSignal,
): Promise<{ response: Response; data: unknown }> {
  const parts = repoParts(repository);
  if (!parts) {
    return {
      response: new Response(null, { status: 400 }),
      data: { message: "Invalid repository format." },
    };
  }

  const normalizedDirectory = normalizeRepoPath(directory);
  const query = ref ? `?ref=${encodeQuery(ref)}` : "";
  const base = `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}/contents`;
  const contentsPath = normalizedDirectory
    ? `${base}/${normalizedDirectory
        .split("/")
        .filter(Boolean)
        .map(encodeURIComponent)
        .join("/")}${query}`
    : `${base}${query}`;

  return githubFetch(contentsPath, signal);
}

async function readTextFileForProject(
  repository: string,
  path: string,
  ref: string,
  maxChars: number,
  signal?: AbortSignal,
): Promise<{
  ok: boolean;
  content: string;
  sha: string;
  url: string;
  truncated: boolean;
  error?: string;
}> {
  const parts = repoParts(repository);
  if (!parts) {
    return {
      ok: false,
      content: "",
      sha: "",
      url: safeUrl(repository, "blob", ref, path),
      truncated: false,
      error: "Invalid repository format.",
    };
  }

  const query = ref ? `?ref=${encodeQuery(ref)}` : "";
  const filePath = normalizeRepoPath(path)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");

  const { response, data } = await githubFetch(
    `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}/contents/${filePath}${query}`,
    signal,
  );

  if (!response.ok) {
    return {
      ok: false,
      content: "",
      sha: "",
      url: safeUrl(repository, "blob", ref, path),
      truncated: false,
      error: apiError(response.status, data),
    };
  }

  const item = data as any;
  if (item.type !== "file") {
    return {
      ok: false,
      content: "",
      sha: typeof item.sha === "string" ? item.sha : "",
      url: String(item.html_url || safeUrl(repository, "blob", ref, path)),
      truncated: false,
      error: `GitHub path "${path}" is not a file.`,
    };
  }

  let content = "";
  if (typeof item.content === "string") {
    content = Buffer.from(item.content, "base64").toString("utf8");
  } else if (item.download_url) {
    const downloaded = await fetch(String(item.download_url), {
      signal,
      headers: { "User-Agent": "Isabella-AI/1.0" },
    });
    if (!downloaded.ok) {
      return {
        ok: false,
        content: "",
        sha: typeof item.sha === "string" ? item.sha : "",
        url: String(item.html_url || safeUrl(repository, "blob", ref, path)),
        truncated: false,
        error: `GitHub file download returned HTTP ${downloaded.status}.`,
      };
    }
    content = await downloaded.text();
  }

  const normalized = normalizeText(content);
  const returnedContent = normalized.slice(0, maxChars);

  return {
    ok: true,
    content: returnedContent,
    sha: typeof item.sha === "string" ? item.sha : "",
    url: String(item.html_url || safeUrl(repository, "blob", ref, path)),
    truncated: normalized.length > maxChars,
  };
}

interface CandidateFile {
  path: string;
  url: string;
  score: number;
  sizeHint?: number;
}

interface SelectedFile {
  path: string;
  url: string;
  score: number;
  sha: string;
  content: string;
  truncated: boolean;
}

function selectImportantFiles(candidates: CandidateFile[]): CandidateFile[] {
  const seen = new Set<string>();

  return [...candidates]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .filter((candidate) => {
      const key = candidate.path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return candidate.score > 0;
    });
}

export const githubTool: ToolDefinition = {
  name: "github",

  description:
    "Interact with GitHub repositories and public or authorized repository data. Search repositories, search code, search issues or pull requests, inspect repositories, read files, list directories, and build evidence-based project overviews. Use GITHUB_TOKEN for private repositories or higher authenticated rate limits. Do not modify GitHub data.",

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
        "list_directory",
        "project_overview",
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
    directory: {
      type: "string",
      description:
        "Repository directory path for list_directory; use an empty string or . for the repository root",
    },
    ref: {
      type: "string",
      description: "Optional branch, tag, or commit for repository reads",
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
      description: "Maximum search results to return, from 1 to 10",
    },
  },

  async execute(arguments_, context): Promise<ToolResult> {
    const action = clean(arguments_.action);
    const limit = positiveInt(arguments_.limit, 5, 10);

    if (!action) {
      return { ok: false, content: "GitHub requires an action." };
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

          if (!response.ok) return { ok: false, content: apiError(response.status, data) };

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
            metadata: {
              provider: "github",
              action,
              authenticated: Boolean(process.env.GITHUB_TOKEN),
            },
          };
        }

        case "search_code": {
          const query = clean(arguments_.query);
          const repository = clean(arguments_.repository);
          if (!query) {
            return { ok: false, content: "GitHub code search requires a query." };
          }

          const finalQuery = repository ? `${query} repo:${repository}` : query;
          const { response, data } = await githubFetch(
            `/search/code?q=${encodeQuery(finalQuery)}&per_page=${limit}`,
            context.signal,
          );

          if (!response.ok) return { ok: false, content: apiError(response.status, data) };

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
            metadata: {
              provider: "github",
              action,
              authenticated: Boolean(process.env.GITHUB_TOKEN),
            },
          };
        }

        case "search_issues":
        case "search_pull_requests": {
          const query = clean(arguments_.query);
          const repository = clean(arguments_.repository);
          if (!query) {
            return {
              ok: false,
              content: `GitHub ${action === "search_issues" ? "issue" : "pull request"} search requires a query.`,
            };
          }

          let finalQuery = query;
          if (repository) finalQuery += ` repo:${repository}`;
          if (action === "search_pull_requests") finalQuery += " is:pr";

          const { response, data } = await githubFetch(
            `/search/issues?q=${encodeQuery(finalQuery)}&per_page=${limit}`,
            context.signal,
          );

          if (!response.ok) return { ok: false, content: apiError(response.status, data) };

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
            const repositoryName = item.repository_url
              ? String(item.repository_url).split("/").slice(-2).join("/")
              : "Unknown";
            return `${index + 1}. #${number} ${title}\nState: ${item.state || "unknown"}\nRepository: ${repositoryName}\nURL: ${url}`;
          });

          return {
            ok: true,
            content: lines.join("\n\n"),
            sources,
            metadata: {
              provider: "github",
              action,
              authenticated: Boolean(process.env.GITHUB_TOKEN),
            },
          };
        }

        case "get_repository": {
          const repository = clean(arguments_.repository);
          const parts = repoParts(repository);
          if (!parts) return { ok: false, content: "repository must use owner/name format." };

          const { response, data } = await githubFetch(
            `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}`,
            context.signal,
          );

          if (!response.ok) return { ok: false, content: apiError(response.status, data) };

          const item = data as any;
          const url = String(item.html_url || `https://github.com/${repository}`);

          return {
            ok: true,
            content:
              `Repository: ${item.full_name || repository}\n` +
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

        case "list_directory": {
          const repository = clean(arguments_.repository);
          const directory = normalizeRepoPath(clean(arguments_.directory || arguments_.path));
          const ref = clean(arguments_.ref);
          const parts = repoParts(repository);
          if (!parts) {
            return { ok: false, content: "repository must use owner/name format." };
          }

          const { response, data } = await listDirectoryItems(
            repository,
            directory,
            ref,
            context.signal,
          );

          if (!response.ok) return { ok: false, content: apiError(response.status, data) };
          if (!Array.isArray(data)) {
            return {
              ok: false,
              content: `GitHub path "${directory || "/"}" is not a directory.`,
            };
          }

          const sources: Source[] = [];
          const defaultRef = ref || "main";
          const lines = data.map((item: any) => {
            const itemPath = normalizeRepoPath(String(item.path || item.name || "unknown"));
            const type = String(item.type || "").toLowerCase() === "dir" ? "DIR" : "FILE";
            const url = String(
              item.html_url ||
                safeUrl(repository, type === "DIR" ? "tree" : "blob", defaultRef, itemPath),
            );
            sources.push(source(`${repository}/${itemPath}`, url));
            return `${type} ${itemPath}`;
          });

          return {
            ok: true,
            content:
              `Directory: ${repository}/${directory || "/"}\n` +
              `Ref: ${ref || "default branch"}\n\n` +
              (lines.length ? lines.join("\n") : "Directory is empty."),
            sources,
            metadata: {
              provider: "github",
              action,
              count: data.length,
              directory: directory || "/",
            },
          };
        }

        case "project_overview": {
          const repository = clean(arguments_.repository);
          const ref = clean(arguments_.ref);
          const parts = repoParts(repository);

          if (!parts) {
            return {
              ok: false,
              content: "project_overview requires repository in owner/name format.",
            };
          }

          // Phase 1: repository metadata + root tree.
          const [repositoryResult, rootResult] = await Promise.all([
            githubFetch(
              `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}`,
              context.signal,
            ),
            listDirectoryItems(repository, "", ref, context.signal),
          ]);

          if (!repositoryResult.response.ok) {
            return {
              ok: false,
              content: apiError(repositoryResult.response.status, repositoryResult.data),
            };
          }

          if (!rootResult.response.ok) {
            return {
              ok: false,
              content: apiError(rootResult.response.status, rootResult.data),
            };
          }

          if (!Array.isArray(rootResult.data)) {
            return {
              ok: false,
              content: "GitHub did not return a repository root directory listing.",
            };
          }

          const repositoryData = repositoryResult.data as any;
          const rootItems = rootResult.data as any[];
          const defaultBranch = String(
            ref || repositoryData.default_branch || "main",
          );
          const repositoryUrl = String(
            repositoryData.html_url || `https://github.com/${repository}`,
          );

          // Phase 2: recursively inspect the likely source/documentation areas.
          const candidates: CandidateFile[] = [];
          const visitedDirectories = new Set<string>();
          const queue: Array<{ path: string; depth: number; priority: number }> = [
            { path: "", depth: 0, priority: 10_000 },
          ];
          let directoryRequests = 0;

          while (queue.length && directoryRequests < PROJECT_MAX_DIRECTORY_REQUESTS) {
            queue.sort(
              (a, b) =>
                b.priority - a.priority ||
                a.depth - b.depth ||
                a.path.localeCompare(b.path),
            );

            const current = queue.shift()!;
            const normalizedDirectory = normalizeRepoPath(current.path);
            if (visitedDirectories.has(normalizedDirectory)) continue;
            visitedDirectories.add(normalizedDirectory);

            const result =
              normalizedDirectory.length === 0
                ? rootResult
                : await listDirectoryItems(
                    repository,
                    normalizedDirectory,
                    ref,
                    context.signal,
                  );

            directoryRequests += normalizedDirectory.length === 0 ? 0 : 1;
            if (!result.response.ok || !Array.isArray(result.data)) continue;

            for (const item of result.data as any[]) {
              const itemPath = normalizeRepoPath(String(item.path || item.name || ""));
              if (!itemPath || shouldSkipPath(itemPath)) continue;

              const itemType = String(item.type || "").toLowerCase();
              const itemUrl = String(
                item.html_url ||
                  safeUrl(
                    repository,
                    itemType === "dir" ? "tree" : "blob",
                    defaultBranch,
                    itemPath,
                  ),
              );

              if (itemType === "dir") {
                if (current.depth < PROJECT_MAX_DEPTH) {
                  const priority = directoryPriority(itemPath);
                  if (priority > -100000) {
                    queue.push({
                      path: itemPath,
                      depth: current.depth + 1,
                      priority,
                    });
                  }
                }
                continue;
              }

              if (!isTextLikeFile(itemPath)) continue;

              const score = scoreImportantFile(itemPath);
              if (score > 0) {
                candidates.push({
                  path: itemPath,
                  url: itemUrl,
                  score,
                  sizeHint:
                    typeof item.size === "number" ? Number(item.size) : undefined,
                });
              }
            }
          }

          // Always include important root text files even if recursion did not need
          // to visit their parent directory.
          for (const item of rootItems) {
            const itemPath = normalizeRepoPath(String(item.path || item.name || ""));
            const itemType = String(item.type || "").toLowerCase();
            if (itemType !== "file" || !isTextLikeFile(itemPath)) continue;
            const score = scoreImportantFile(itemPath);
            if (score > 0) {
              candidates.push({
                path: itemPath,
                url: String(
                  item.html_url ||
                    safeUrl(repository, "blob", defaultBranch, itemPath),
                ),
                score,
                sizeHint:
                  typeof item.size === "number" ? Number(item.size) : undefined,
              });
            }
          }

          const selectedCandidates = selectImportantFiles(candidates).slice(
            0,
            PROJECT_MAX_FILES,
          );

          // Phase 3: read the selected files under the fixed content budget.
          const selectedFiles: SelectedFile[] = [];
          const readErrors: Array<{ path: string; error: string }> = [];
          let totalChars = 0;

          for (const candidate of selectedCandidates) {
            if (selectedFiles.length >= PROJECT_MAX_FILES) break;
            if (totalChars >= PROJECT_MAX_TOTAL_CHARS) break;

            const remainingBudget = PROJECT_MAX_TOTAL_CHARS - totalChars;
            const fileBudget = Math.min(
              PROJECT_MAX_SINGLE_FILE_CHARS,
              remainingBudget,
            );

            const result = await readTextFileForProject(
              repository,
              candidate.path,
              ref || defaultBranch,
              fileBudget,
              context.signal,
            );

            if (!result.ok) {
              readErrors.push({
                path: candidate.path,
                error: result.error || "Unable to read file.",
              });
              continue;
            }

            const content = result.content;
            selectedFiles.push({
              path: candidate.path,
              url: result.url || candidate.url,
              score: candidate.score,
              sha: result.sha,
              content,
              truncated: result.truncated,
            });
            totalChars += content.length;
          }

          const readmeFile = selectedFiles.find(
            (file) => file.path.toLowerCase() === "readme.md",
          );
          const readmeCandidate = candidates.find(
            (candidate) => candidate.path.toLowerCase() === "readme.md",
          );
          const readmeInsufficient = readmeFile
            ? readmeIsInsufficient(readmeFile.content)
            : !readmeCandidate;

          const sources: Source[] = [source(repository, repositoryUrl)];
          const rootLines = rootItems.map((item: any) => {
            const itemPath = normalizeRepoPath(String(item.path || item.name || "unknown"));
            const itemType = String(item.type || "").toLowerCase();
            const url = String(
              item.html_url ||
                safeUrl(
                  repository,
                  itemType === "dir" ? "tree" : "blob",
                  defaultBranch,
                  itemPath,
                ),
            );
            sources.push(source(`${repository}/${itemPath}`, url));
            return `${itemType === "dir" ? "DIR" : "FILE"} ${itemPath}`;
          });

          const evidenceBlocks = selectedFiles.map((file) => {
            sources.push(source(`${repository}/${file.path}`, file.url));
            return [
              `===== ${repository}/${file.path} =====`,
              `SHA: ${file.sha || "unknown"}`,
              `URL: ${file.url}`,
              `Priority: ${file.score}`,
              file.truncated ? "Content: [truncated at project file budget]" : "Content:",
              file.content,
            ].join("\n");
          });

          const status = [
            `GitHub: inspected ${repository}`,
            "GitHub: explored repository structure",
            ...selectedFiles.map((file) => `GitHub: read ${file.path}`),
            "Isabella: repository evidence collected",
            "Isabella: ready for one evidence-only model analysis",
          ];

          const analysisPrompt = [
            "You are analyzing a GitHub repository.",
            "Use ONLY the repository evidence provided below.",
            "Explain:",
            "1. What the project is",
            "2. Frontend architecture",
            "3. Backend architecture",
            "4. Agent/controller flow",
            "5. Model/provider system",
            "6. Available tools/plugins",
            "7. How requests move through the system",
            "8. Important configuration",
            "9. How to run it",
            "10. Limitations or unfinished features",
            "Do not invent missing information.",
            "When evidence is insufficient, say so.",
            "Cite relevant repository files using the provided GitHub URLs.",
            "",
            `Repository: ${repository}`,
            `Default branch/ref: ${defaultBranch}`,
            `Description: ${repositoryData.description || "No description"}`,
            "",
            "Repository evidence:",
            evidenceBlocks.join("\n\n"),
          ].join("\n");

          return {
            ok: true,
            content:
              `Project overview evidence for ${repository}\n` +
              `Description: ${repositoryData.description || "No description"}\n` +
              `Default branch: ${defaultBranch}\n` +
              `Primary language: ${repositoryData.language || "Unknown"}\n` +
              `Repository URL: ${repositoryUrl}\n` +
              `README insufficient: ${readmeInsufficient ? "yes" : "no"}\n` +
              `Files selected: ${selectedFiles.length}/${PROJECT_MAX_FILES}\n` +
              `Source text collected: ${totalChars}/${PROJECT_MAX_TOTAL_CHARS} characters\n\n` +
              `Repository root contents:\n` +
              (rootLines.length ? rootLines.join("\n") : "Repository root is empty.") +
              "\n\n" +
              (evidenceBlocks.length
                ? evidenceBlocks.join("\n\n")
                : "No readable important source files were collected."),
            sources,
            metadata: {
              provider: "github",
              action,
              repository,
              defaultBranch,
              rootItemCount: rootItems.length,
              candidateFileCount: candidates.length,
              selectedFileCount: selectedFiles.length,
              selectedFiles: selectedFiles.map((file) => ({
                path: file.path,
                sha: file.sha,
                url: file.url,
                priority: file.score,
                truncated: file.truncated,
                contentLength: file.content.length,
              })),
              skippedReadFiles: readErrors,
              skippedDirectoryRequests: Math.max(
                0,
                directoryRequests - PROJECT_MAX_DIRECTORY_REQUESTS,
              ),
              budgets: {
                maxFiles: PROJECT_MAX_FILES,
                maxTotalChars: PROJECT_MAX_TOTAL_CHARS,
                maxSingleFileChars: PROJECT_MAX_SINGLE_FILE_CHARS,
                maxDirectoryRequests: PROJECT_MAX_DIRECTORY_REQUESTS,
                maxDepth: PROJECT_MAX_DEPTH,
              },
              readmeInsufficient,
              statuses: status,
              analysisPrompt,
              nextStep: "controller should make one Nemotron analysis call using analysisPrompt and this evidence only",
              stage: "project-explorer-evidence",
            },
          };
        }

        case "get_file": {
          const repository = clean(arguments_.repository);
          const path = normalizeRepoPath(clean(arguments_.path));
          const requestedRef = clean(arguments_.ref);
          const parts = repoParts(repository);

          if (!parts) {
            return {
              ok: false,
              content: "repository must use owner/name format.",
            };
          }

          if (!path) {
            return {
              ok: false,
              content: "GitHub get_file requires a path.",
            };
          }

          // Resolve the repository's actual default branch when the caller
          // does not provide one. This avoids relying on a hard-coded branch.
          let ref = requestedRef;

          if (!ref) {
            const repoInfo = await githubFetch(
              `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}`,
              context.signal,
            );

            if (!repoInfo.response.ok) {
              return {
                ok: false,
                content: apiError(repoInfo.response.status, repoInfo.data),
              };
            }

            const repoData = repoInfo.data as {
              default_branch?: unknown;
            };

            ref =
              typeof repoData.default_branch === "string" &&
              repoData.default_branch.trim()
                ? repoData.default_branch.trim()
                : "main";
          }

          const encodedPath = path
            .split("/")
            .filter(Boolean)
            .map(encodeURIComponent)
            .join("/");

          const contentsPath =
            `/repos/${encodeURIComponent(parts.owner)}` +
            `/${encodeURIComponent(parts.name)}` +
            `/contents/${encodedPath}` +
            `?ref=${encodeQuery(ref)}`;

          let { response, data } = await githubFetch(
            contentsPath,
            context.signal,
          );

          // Fallback to raw.githubusercontent.com for public files when the
          // Contents API cannot resolve the path.
          if (response.status === 404) {
            const rawPath = path
              .split("/")
              .filter(Boolean)
              .map(encodeURIComponent)
              .join("/");

            const rawUrl =
              `https://raw.githubusercontent.com/${repository}/` +
              `${encodeURIComponent(ref)}/${rawPath}`;

            const rawResponse = await fetch(rawUrl, {
              signal: context.signal,
              headers: {
                "User-Agent": "Isabella-AI/1.0",
              },
            });

            if (rawResponse.ok) {
              const rawContent = normalizeText(await rawResponse.text());
              const truncated =
                rawContent.length > GET_FILE_MAX_RETURNED_CHARS;
              const returnedContent = rawContent.slice(
                0,
                GET_FILE_MAX_RETURNED_CHARS,
              );
              const url =
                `https://github.com/${repository}/blob/${encodeURIComponent(ref)}/${path}`;

              return {
                ok: true,
                content:
                  `File: ${repository}/${path}\n` +
                  `Ref: ${ref}\n` +
                  `URL: ${url}\n\n` +
                  returnedContent,
                sources: [source(`${repository}/${path}`, url)],
                metadata: {
                  provider: "github",
                  action,
                  repository,
                  path,
                  ref,
                  fallback: "raw.githubusercontent.com",
                  truncated,
                  contentLength: rawContent.length,
                  returnedContentLength: returnedContent.length,
                },
              };
            }
          }

          if (!response.ok) {
            return {
              ok: false,
              content: apiError(response.status, data),
            };
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

            if (!downloaded.ok) {
              return {
                ok: false,
                content:
                  `GitHub file download returned HTTP ${downloaded.status}.`,
              };
            }

            content = await downloaded.text();
          }

          const normalized = normalizeText(content);
          const truncated =
            normalized.length > GET_FILE_MAX_RETURNED_CHARS;
          const returnedContent = normalized.slice(
            0,
            GET_FILE_MAX_RETURNED_CHARS,
          );

          const url = String(
            item.html_url ||
              `https://github.com/${repository}/blob/${encodeURIComponent(ref)}/${path}`,
          );
          const sha = typeof item.sha === "string" ? item.sha : "";

          return {
            ok: true,
            content:
              `File: ${repository}/${path}\n` +
              `Ref: ${ref}\n` +
              `SHA: ${sha || "unknown"}\n` +
              `URL: ${url}\n\n` +
              returnedContent,
            sources: [source(`${repository}/${path}`, url)],
            metadata: {
              provider: "github",
              action,
              repository,
              path,
              ref,
              sha,
              url,
              truncated,
              contentLength: normalized.length,
              returnedContentLength: returnedContent.length,
            },
          };
        }

        case "get_issue": {
          const repository = clean(arguments_.repository);
          const issueNumber = positiveInt(arguments_.issueNumber, 0, 1_000_000_000);
          const parts = repoParts(repository);

          if (!parts || !issueNumber) {
            return { ok: false, content: "get_issue requires repository and issueNumber." };
          }

          const { response, data } = await githubFetch(
            `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}/issues/${issueNumber}`,
            context.signal,
          );

          if (!response.ok) return { ok: false, content: apiError(response.status, data) };

          const item = data as any;
          const url = String(
            item.html_url || `https://github.com/${repository}/issues/${issueNumber}`,
          );

          return {
            ok: true,
            content:
              `#${item.number} ${item.title}\n` +
              `State: ${item.state}\n` +
              `Author: ${item.user?.login || "unknown"}\n` +
              `Comments: ${item.comments ?? 0}\n` +
              `URL: ${url}\n\n` +
              `${item.body || "No issue body."}`.slice(0, 20_000),
            sources: [source(`#${item.number} ${item.title}`, url)],
            metadata: { provider: "github", action },
          };
        }

        case "get_pull_request": {
          const repository = clean(arguments_.repository);
          const pullRequestNumber = positiveInt(
            arguments_.pullRequestNumber,
            0,
            1_000_000_000,
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

          if (!response.ok) return { ok: false, content: apiError(response.status, data) };

          const item = data as any;
          const url = String(
            item.html_url || `https://github.com/${repository}/pull/${pullRequestNumber}`,
          );

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
              `${item.body || "No pull request body."}`.slice(0, 20_000),
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

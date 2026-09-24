import { randomUUID } from "node:crypto";

import type {
  AgentAction,
  AgentEvent,
  AgentRequest,
  AgentResult,
  AgentStep,
  ChatMessage,
  ModelProvider,
  ToolDefinition,
  ToolResult,
} from "./types.ts";

import { calculatorTool } from "./tools/calculator.ts";
import { timeTool } from "./tools/time.ts";
import { webFetchTool, webSearchTool } from "./tools/web.ts";
import { fileListTool, fileReadTool, fileSearchTool } from "./tools/files.ts";
import { higgsfieldVideoTool } from "./tools/higgsfield.ts";
import {
  wikipediaSearchTool,
  wikipediaArticleTool,
} from "./tools/wikipedia.ts";
import { huggingFaceTool } from "./tools/huggingface.ts";
import { githubTool } from "./tools/github.ts";

const ALWAYS_ON_TOOLS: ToolDefinition[] = [timeTool];

const TOOL_PLUGIN_MAP: Record<string, ToolDefinition[]> = {
  "web-search": [webSearchTool, webFetchTool],
  wikipedia: [wikipediaSearchTool, wikipediaArticleTool],
  calculator: [calculatorTool],
  "file-analyzer": [fileListTool, fileReadTool, fileSearchTool],
  huggingface: [huggingFaceTool],
  github: [githubTool],
  "higgsfield-video": [higgsfieldVideoTool],
};

function uniqueTools(
  plugins: string[] = [],
  webEnabled = true,
): ToolDefinition[] {
  const map = new Map<string, ToolDefinition>();

  for (const tool of ALWAYS_ON_TOOLS) {
    map.set(tool.name, tool);
  }

  if (webEnabled && plugins.includes("wikipedia")) {
    map.set(wikipediaSearchTool.name, wikipediaSearchTool);
    map.set(wikipediaArticleTool.name, wikipediaArticleTool);
  }

  if (webEnabled && plugins.includes("web-search")) {
    map.set(webSearchTool.name, webSearchTool);
    map.set(webFetchTool.name, webFetchTool);
  }

  for (const plugin of plugins) {
    for (const tool of TOOL_PLUGIN_MAP[plugin] || []) {
      map.set(tool.name, tool);
    }
  }

  return [...map.values()];
}

function toolCatalog(tools: ToolDefinition[]): string {
  return tools
    .map(
      (tool) =>
        `${tool.name}: ${tool.description}\nInput schema: ${JSON.stringify(
          tool.inputSchema,
        )}`,
    )
    .join("\n\n");
}

function parseAction(raw: string): AgentAction | null {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const value = JSON.parse(trimmed) as Partial<AgentAction>;

    if (value.type === "final" && typeof value.answer === "string") {
      return {
        type: "final",
        answer: value.answer,
        memory: Array.isArray(value.memory)
          ? value.memory.filter(
              (
                item,
              ): item is { key: string; value: string } =>
                Boolean(
                  item &&
                    typeof item.key === "string" &&
                    typeof item.value === "string",
                ),
            )
          : [],
      };
    }

    if (value.type === "tool_call" && typeof value.tool === "string") {
      return {
        type: "tool_call",
        tool: value.tool,
        arguments:
          value.arguments && typeof value.arguments === "object"
            ? (value.arguments as Record<string, unknown>)
            : {},
        reason:
          typeof value.reason === "string" ? value.reason : undefined,
      };
    }
  } catch {
    const match = trimmed.match(/\{[\s\S]+\}/);
    if (match) {
      try {
        return parseAction(match[0]);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function lastUserMessage(request: AgentRequest): string {
  return (
    [...request.messages]
      .reverse()
      .find((message) => message.role === "user")?.content || ""
  );
}

function isExplicitVideoGenerationRequest(request: AgentRequest): boolean {
  const text = lastUserMessage(request).toLowerCase();
  const hasVideoNoun =
    /\b(video|videos|clip|movie|animation|animate|film)\b/.test(text);
  const hasGenerationVerb =
    /\b(generate|create|make|produce|render|animate|turn|convert)\b/.test(
      text,
    );
  return hasVideoNoun && hasGenerationVerb;
}

function isExplicitWikipediaRequest(request: AgentRequest): boolean {
  const text = lastUserMessage(request).toLowerCase();
  const mentionsWikipedia = /\bwikipedia\b/.test(text);
  const intent = /\b(search|find|look\s*up|read|summari[sz]e|tell\s+me\s+about|article)\b/.test(text);
  return mentionsWikipedia && intent;
}

function extractWikipediaQuery(request: AgentRequest): string {
  const normalized = lastUserMessage(request).replace(/\s+/g, " ").trim();

  const patterns = [
    /\barticle\s+about\s+(.+?)(?:\s+and\s+(?:summari[sz]e|give|tell)|[.!?]|$)/i,
    /\bsearch\s+(?:for\s+)?(.+?)(?:\s+and\s+(?:give|summari[sz]e|tell)|[.!?]|$)/i,
    /\bfind\s+(?:the\s+)?(?:article\s+)?(?:about\s+)?(.+?)(?:\s+and\s+(?:summari[sz]e|give|tell)|[.!?]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      const query = match[1]
        .replace(/^the\s+/i, "")
        .replace(/\bWikipedia\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      if (query) return query;
    }
  }

  return normalized
    .replace(/\buse\s+wikipedia\b/gi, "")
    .replace(/\bwikipedia\b/gi, "")
    .replace(/\b(search|find|look\s*up|read|summari[sz]e|tell\s+me\s+about)\b/gi, "")
    .replace(/\b(the\s+)?article\s+(about|on)\b/gi, "")
    .replace(/\b(and\s+)?(give|tell|summari[sz]e)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[,.:;\s]+|[,.:;\s]+$/g, "")
    .trim();
}

function normalizeWikipediaText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chooseWikipediaArticleTitle(
  query: string,
  sources: Array<{ title?: string }> | undefined,
): string | null {
  const candidates = (sources || [])
    .map((source) => (source.title || "").trim())
    .filter(Boolean);

  if (!candidates.length) return null;

  const normalizedQuery = normalizeWikipediaText(query);
  const queryTokens = new Set(normalizedQuery.split(" ").filter(Boolean));
  const genericWords = new Set([
    "article",
    "about",
    "mission",
    "history",
    "overview",
    "information",
    "facts",
    "summary",
    "summarize",
    "summarise",
  ]);
  const topicTokens = [...queryTokens].filter((token) => !genericWords.has(token));
  const topic = topicTokens.join(" ").trim();

  let bestTitle = candidates[0];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const title of candidates) {
    const normalizedTitle = normalizeWikipediaText(title);
    const titleTokens = new Set(normalizedTitle.split(" ").filter(Boolean));
    let score = 0;

    if (topic && normalizedTitle === topic) score += 1000;
    if (topic && normalizedTitle.startsWith(`${topic} `)) score += 700;
    if (topic && normalizedTitle.includes(topic)) score += 450;
    if (normalizedTitle === normalizedQuery) score += 650;

    for (const token of topicTokens) {
      if (titleTokens.has(token)) score += 80;
    }

    // Prefer concise topic articles over narrow subtopics (e.g.
    // "Apollo 11" over "Apollo 11 missing tapes") when the user asks for
    // the main topic.
    const extraTokenCount = Math.max(0, titleTokens.size - topicTokens.length);
    score -= extraTokenCount * 35;

    if (/\bmissing tapes?\b/i.test(title) && !/\bmissing tapes?\b/i.test(query)) {
      score -= 500;
    }
    if (/\b(popular culture|legacy|impact|reception)\b/i.test(title)) {
      score -= 250;
    }

    if (score > bestScore) {
      bestScore = score;
      bestTitle = title;
    }
  }

  return bestTitle;
}

function isExplicitGitHubSearchRequest(request: AgentRequest): boolean {
  const text = lastUserMessage(request).toLowerCase();
  const mentionsGitHub = /\bgithub\b/.test(text);
  const searchIntent = /\b(search|find|look\s*up)\b/.test(text);
  const repositoryIntent =
    /\b(repo|repos|repository|repositories|code|issue|issues|pull\s*request|pr)\b/.test(
      text,
    );
  return mentionsGitHub && searchIntent && repositoryIntent;
}

function extractGitHubSearchQuery(request: AgentRequest): string {
  const normalized = lastUserMessage(request).replace(/\s+/g, " ").trim();

  const aboutMatch = normalized.match(/\babout\s+(.+?)(?:\.|$)/i);
  if (aboutMatch?.[1]) return aboutMatch[1].trim();

  const forMatch = normalized.match(/\bfor\s+(.+?)(?:\.|$)/i);
  if (forMatch?.[1]) {
    return forMatch[1]
      .replace(
        /^(repositories?|repos?|code|issues?|pull\s+requests?)\s+(?:about|on|for)\s+/i,
        "",
      )
      .trim();
  }

  return normalized
    .replace(/^[^:]*?:/i, "")
    .replace(/\b(search|find|look\s*up)\b/gi, "")
    .replace(/\bgithub\b/gi, "")
    .replace(
      /\b(repositories?|repos?|code|issues?|pull\s*requests?|for)\b/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function isExplicitGitHubFileReadRequest(request: AgentRequest): boolean {
  const text = lastUserMessage(request).toLowerCase();
  const mentionsGitHub = /\bgithub\b/.test(text);
  const readIntent = /\b(read|show|open|inspect|view|fetch|get)\b/.test(text);
  const fileIntent =
    /\b(readme(?:\.md)?|file|source|code|contents?|\.md|\.ts|\.tsx|\.js|\.json|\.py|\.yaml|\.yml|\.toml)\b/.test(
      text,
    );
  const hasRepository =
    /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/.test(text);
  const hasExplicitRepositorySource =
    /\bfrom\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/.test(text);

  return (mentionsGitHub || hasExplicitRepositorySource) &&
    readIntent &&
    fileIntent &&
    hasRepository;
}

function isRepositoryOverviewRequest(request: AgentRequest): boolean {
  const text = lastUserMessage(request).toLowerCase();
  const hasRepository =
    /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/.test(text) ||
    /\b(github|repository|repo)\b/.test(text);
  const intent =
    /\b(understand|explain|analy[sz]e|review|architecture|architectural|how\s+.*works?|overview|structure|walk\s+through|audit)\b/.test(
      text,
    );
  const projectLanguage =
    /\b(project|repository|repo|codebase|code|frontend|backend|agent|architecture)\b/.test(
      text,
    );
  return hasRepository && intent && projectLanguage;
}

function isReadmeProjectExplanationRequest(request: AgentRequest): boolean {
  const text = lastUserMessage(request).toLowerCase();
  const mentionsReadme = /\breadme(?:\.md)?\b/.test(text);
  const explanationIntent =
    /\b(explain|understand|describe|review|analy[sz]e|how\s+.*works?)\b/.test(
      text,
    );
  const hasRepository =
    /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/.test(text);
  return mentionsReadme && explanationIntent && hasRepository;
}

function extractGitHubFileRequest(
  request: AgentRequest,
): { repository: string; path: string } | null {
  const original = lastUserMessage(request).replace(/\s+/g, " ").trim();

  // Prefer the owner/name pair explicitly introduced by "from" or "repository"
  // so a source path such as artifacts/api-server/... is never mistaken for
  // the GitHub repository.
  const explicitRepoMatch = original.match(
    /\b(?:from|repository)\s+(?:repo\s+)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/i,
  );

  const repoCandidates = original.match(
    /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/g,
  ) || [];

  const repository = explicitRepoMatch?.[1] || repoCandidates.at(-1) || "";

  if (!repository) return null;

  const readmeMatch = original.match(/\b(readme(?:\.md)?)\b/i);
  if (readmeMatch) return { repository, path: "README.md" };

  const pathMatches = original.match(
    /(?:^|\s)([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:md|mdx|txt|ts|tsx|js|jsx|json|py|yaml|yml|toml|css|scss|html|xml|mjs|cjs|mts|cts|sh|sql|graphql|vue|svelte|astro))(?=$|\s|[),.;:])/gi,
  );

  if (pathMatches?.length) {
    const repositoryLower = repository.toLowerCase();
    for (const rawMatch of pathMatches) {
      const candidate = rawMatch.trim().replace(/^['"`]/, "").replace(/['"`.,;:)]+$/, "");
      if (candidate.toLowerCase() === repositoryLower) continue;
      if (candidate.includes("/")) return { repository, path: candidate };
    }

    const candidate = pathMatches[0]
      .trim()
      .replace(/^['"`]/, "")
      .replace(/['"`.,;:)]+$/, "");
    if (candidate && candidate.toLowerCase() !== repositoryLower) {
      return { repository, path: candidate };
    }
  }

  return null;
}

function buildSystemPrompt(
  request: AgentRequest,
  tools: ToolDefinition[],
): string {
  const memory = (request.memory || [])
    .slice(0, 30)
    .map((item) => `- ${item.key}: ${item.value}`)
    .join("\n");

  const files = (request.files || [])
    .map((file) => `- ${file.name} [${file.id}]`)
    .join("\n");

  const prefs = request.preferences || {};

  return [
    "You are Isabella, a capable task-oriented agent. Your job is to complete the user's goal, not merely discuss how to do it.",
    "Work in an iterative loop: understand the goal, choose the next useful action, use a tool when needed, inspect its result, and continue until the task is complete.",
    "Never pretend to have used a tool. Only claim facts supported by the conversation or actual tool results.",
    "Use exactly one JSON action per turn. Do not output markdown around the JSON.",
    'For a tool call use: {"type":"tool_call","tool":"tool_name","arguments":{},"reason":"brief reason"}',
    'When the task is complete use: {"type":"final","answer":"answer","memory":[{"key":"...","value":"..."}]}.',
    "Only write memory when the user explicitly states a durable preference, identity detail, or stable project fact that is useful later. Keep memory minimal and non-sensitive.",
    "Tool selection rules:",
    "Use wikipedia_search for stable encyclopedia-style topics such as history, biographies, science, technology, places, and general reference questions when the Wikipedia plugin is enabled.",
    "Use wikipedia_article after wikipedia_search when the answer needs more detailed information from a specific Wikipedia article and the Wikipedia plugin is enabled.",
    "If the Wikipedia plugin is not available, do not pretend to have Wikipedia access; use another available source or explain that the plugin is disabled.",
    "Use web_search for current, recent, changing, time-sensitive, price, product, company, news, or statistics questions.",
    "Use web_fetch when a specific public web page needs to be read in detail.",
    "Use calculator for arithmetic instead of doing complicated calculations mentally.",
    "Use file tools when the answer depends on uploaded files.",
    "Do not use tools for simple conversation when a direct answer is enough.",
    "Do not call multiple tools unless the task actually requires them.",
    "If a previous tool result is insufficient, choose another available tool rather than guessing.",
    "Use huggingface_specialist for specialist AI tasks when a dedicated Hugging Face model can provide useful additional capability.",
    "Use huggingface_specialist for specialized text analysis, classification, structured transformation, or other model-specific work.",
    "Use github for normal GitHub searches, issues, pull requests, repository inspection, file reads, and directory reads when the GitHub plugin is available.",
    "For explicit GitHub search requests, use github with action=search_repositories and the user's search topic as query.",
    "For explicit GitHub file requests, use github with action=get_file and use only the returned file content.",
    "For understanding an entire GitHub repository, use github action=project_overview. Do not ask the model to choose a chain of 5-10 GitHub calls.",
    "For repository-overview results, do not invent details that are missing from the collected evidence.",
    "Use higgsfield_video for explicit video-generation requests when available.",

    request.mode ? `User mode: ${request.mode}` : "",
    prefs.name ? `User name: ${prefs.name}` : "",
    prefs.warm === false
      ? "Tone preference: straightforward, not especially warm."
      : "Tone preference: warm and conversational.",
    prefs.concise
      ? "Answer preference: concise unless the task needs detail."
      : "Answer preference: complete but readable.",
    request.files?.length
      ? `Uploaded files:\n${files}`
      : "No files are attached.",
    memory
      ? `Long-term memory context:\n${memory}`
      : "No saved long-term memory is available.",
    `Available tools:\n${toolCatalog(tools)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function addSources(
  destination: AgentResult["sources"],
  incoming?: AgentResult["sources"],
): void {
  if (!incoming) return;
  for (const item of incoming) {
    if (!destination.some((source) => source.url === item.url)) {
      destination.push(item);
    }
  }
}

function metadataString(
  result: ToolResult,
  key: string,
): string | undefined {
  const value = result.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function metadataStringArray(
  result: ToolResult,
  key: string,
): string[] {
  const value = result.metadata?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function metadataRecord(
  result: ToolResult,
  key: string,
): Record<string, unknown> | undefined {
  const value = result.metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractEvidencePrompt(result: ToolResult): string | null {
  const prompt = metadataString(result, "analysisPrompt");
  return prompt?.trim() ? prompt.trim() : null;
}

function extractSelectedFilePaths(result: ToolResult): string[] {
  const selected = result.metadata?.selectedFiles;
  if (!Array.isArray(selected)) return [];
  return selected
    .map((item) => {
      if (item && typeof item === "object" && "path" in item) {
        const path = (item as { path?: unknown }).path;
        return typeof path === "string" ? path : "";
      }
      return "";
    })
    .filter(Boolean);
}

function extractFileBody(result: ToolResult): string {
  const separator = result.content.indexOf("\n\n");
  return separator >= 0
    ? result.content.slice(separator + 2)
    : result.content;
}

async function runSingleEvidenceAnalysis(
  model: ModelProvider,
  evidencePrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are Isabella's repository-analysis engine. Use ONLY the GitHub repository evidence supplied in the user message. Never invent files, behavior, dependencies, architecture, configuration, or limitations. When evidence is insufficient, explicitly say so. Produce a normal user-facing explanation, not JSON. Cite important claims by naming the repository files and their provided GitHub URLs.",
    },
    {
      role: "user",
      content: evidencePrompt,
    },
  ];

  const raw = await model.complete(messages, { signal });
  return raw.trim();
}

export class AgentController {
  private readonly model: ModelProvider;

  constructor(model: ModelProvider) {
    this.model = model;
  }

  async run(
    request: AgentRequest,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    const requestedPlugins = [...(request.plugins || [])];

    const needsGitHub =
      isExplicitGitHubSearchRequest(request) ||
      isExplicitGitHubFileReadRequest(request) ||
      isRepositoryOverviewRequest(request) ||
      isReadmeProjectExplanationRequest(request);

    if (needsGitHub && !requestedPlugins.includes("github")) {
      requestedPlugins.push("github");
    }

    if (
      isExplicitVideoGenerationRequest(request) &&
      !requestedPlugins.includes("higgsfield-video")
    ) {
      requestedPlugins.push("higgsfield-video");
    }

    const tools = uniqueTools(
      requestedPlugins,
      request.preferences?.web !== false,
    );

    const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
    const maxSteps = Math.min(6, Math.max(1, request.maxSteps || 4));

    const steps: AgentStep[] = [];
    const sources: AgentResult["sources"] = [];
    const memoryWrites: AgentResult["memoryWrites"] = [];
    let videoUrl: string | undefined;
    let finalAnswer = "";

    const contextMessages: ChatMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(request, tools),
      },
      ...request.messages.slice(-14),
    ];

    const emit = (step: Omit<AgentStep, "id" | "timestamp">) => {
      const full: AgentStep = {
        ...step,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
      };
      steps.push(full);
      onEvent?.(full);
    };

    emit({
      type: "status",
      message: "Understanding your goal and choosing the next action.",
    });

    /* --------------------------------------------------------------------- */
    /* Step 9: keep ordinary GitHub search and file requests working.        */
    /* --------------------------------------------------------------------- */
    if (isExplicitGitHubFileReadRequest(request)) {
      const github = toolByName.get("github");
      if (!github) {
        throw new Error(
          "GitHub is required for this request, but the github tool is not registered.",
        );
      }

      const fileRequest = extractGitHubFileRequest(request);
      if (!fileRequest) {
        throw new Error(
          "I could not determine which GitHub repository and file to read.",
        );
      }

      const githubArguments: Record<string, unknown> = {
        action: "get_file",
        repository: fileRequest.repository,
        path: fileRequest.path,
      };

      emit({
        type: "tool_call",
        message: `GitHub is reading ${fileRequest.path}…`,
        tool: "github",
        arguments: githubArguments,
      });

      const result = await github.execute(githubArguments, {
        files: request.files || [],
        signal,
      });

      emit({
        type: "tool_result",
        message: result.ok
          ? `GitHub returned ${fileRequest.path}.`
          : `GitHub could not read ${fileRequest.path}.`,
        tool: "github",
        ok: result.ok,
      });

      if (!result.ok) throw new Error(result.content);
      addSources(sources, result.sources);

      contextMessages.push({
        role: "user",
        content:
          `GITHUB FILE RESULT (${fileRequest.repository}/${fileRequest.path}):\n${result.content}\n\n` +
          "Explain the requested file using only its actual contents. Do not invent details. Return a normal user-facing answer, not JSON.",
      });

      const raw = await this.model.complete(contextMessages, { signal });
      finalAnswer = raw.trim();

      emit({
        type: "final",
        message: "Isabella explained the GitHub file.",
      });

      return {
        text: finalAnswer || result.content,
        sources,
        steps,
        memoryWrites,
        videoUrl,
      };
    }


    /* --------------------------------------------------------------------- */
    /* Deterministic Wikipedia path: search -> article -> final answer.      */
    /* --------------------------------------------------------------------- */
    if (isExplicitWikipediaRequest(request)) {
      const wikipediaSearch = toolByName.get("wikipedia_search");
      const wikipediaArticle = toolByName.get("wikipedia_article");

      if (!wikipediaSearch || !wikipediaArticle) {
        throw new Error(
          "Wikipedia is required for this request, but the Wikipedia tools are not registered.",
        );
      }

      const query = extractWikipediaQuery(request);
      if (!query) {
        throw new Error("I could not determine what to search for on Wikipedia.");
      }

      const searchArguments: Record<string, unknown> = {
        query,
        limit: 3,
      };

      emit({
        type: "status",
        message: "Wikipedia is searching…",
      });
      emit({
        type: "tool_call",
        message: "wikipedia_search is working…",
        tool: "wikipedia_search",
        arguments: searchArguments,
      });

      const searchResult = await wikipediaSearch.execute(searchArguments, {
        files: request.files || [],
        signal,
      });

      emit({
        type: "tool_result",
        message: searchResult.ok
          ? "wikipedia_search returned a result."
          : "wikipedia_search reported an error.",
        tool: "wikipedia_search",
        ok: searchResult.ok,
      });

      if (!searchResult.ok) {
        throw new Error(searchResult.content);
      }

      addSources(sources, searchResult.sources);

      const rankedTitle = chooseWikipediaArticleTitle(
        query,
        searchResult.sources,
      );

      const normalizedQuery = normalizeWikipediaText(query);
      const queryTokens = normalizedQuery.split(" ").filter(Boolean);
      const genericWords = new Set([
        "article",
        "about",
        "mission",
        "history",
        "overview",
        "information",
        "facts",
        "summary",
        "summarize",
        "summarise",
      ]);
      const topic = queryTokens
        .filter((token) => !genericWords.has(token))
        .join(" ")
        .trim();

      // Prefer the canonical main topic even when Wikipedia search ranks a
      // narrow sub-article such as "Apollo 11 missing tapes" above it.
      // wikipedia_article follows redirects, so "Apollo 11" can resolve to
      // the canonical page even when that title was not among the top search
      // results. If the preferred topic does not exist, fall back to the
      // best search result.
      const articleCandidates = [
        topic,
        rankedTitle || "",
        normalizedQuery,
      ]
        .map((value) => value.trim())
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index);

      let articleTitle: string | null = null;
      let articleResult: ToolResult | null = null;
      let lastArticleError = "Wikipedia could not read the requested article.";

      emit({
        type: "status",
        message: "Wikipedia is reading the article…",
      });

      for (const candidateTitle of articleCandidates) {
        const articleArguments: Record<string, unknown> = {
          title: candidateTitle,
        };

        emit({
          type: "tool_call",
          message: "wikipedia_article is working…",
          tool: "wikipedia_article",
          arguments: articleArguments,
        });

        const candidateResult = await wikipediaArticle.execute(
          articleArguments,
          {
            files: request.files || [],
            signal,
          },
        );

        emit({
          type: "tool_result",
          message: candidateResult.ok
            ? "wikipedia_article returned a result."
            : "wikipedia_article reported an error.",
          tool: "wikipedia_article",
          ok: candidateResult.ok,
        });

        if (candidateResult.ok) {
          articleTitle =
            candidateResult.sources?.[0]?.title || candidateTitle;
          articleResult = candidateResult;
          break;
        }

        lastArticleError = candidateResult.content;
      }

      if (!articleResult || !articleTitle) {
        throw new Error(lastArticleError);
      }

      addSources(sources, articleResult.sources);

      emit({
        type: "status",
        message: "Isabella is summarizing the Wikipedia article…",
      });

      const answerMessages: ChatMessage[] = [
        {
          role: "system",
          content:
            "You are Isabella's answer writer. Use ONLY the supplied Wikipedia article content. Answer the user's request directly. Do not call tools, do not output JSON, and do not claim facts that are not supported by the article.",
        },
        {
          role: "user",
          content: [
            `Original user request: ${lastUserMessage(request)}`,
            `Wikipedia article: ${articleTitle}`,
            "Wikipedia article content:",
            articleResult.content,
            "",
            "Write the final user-facing answer now.",
          ].join("\n"),
        },
      ];

      finalAnswer = (await this.model.complete(answerMessages, { signal })).trim();

      emit({
        type: "final",
        message: "Isabella completed the Wikipedia request.",
      });

      return {
        text: finalAnswer || articleResult.content,
        sources,
        steps,
        memoryWrites,
        videoUrl,
      };
    }

    /* --------------------------------------------------------------------- */
    /* Step 10: README request -> inspect README -> fallback to explorer.    */
    /* --------------------------------------------------------------------- */
    if (isReadmeProjectExplanationRequest(request)) {
      const github = toolByName.get("github");
      if (!github) {
        throw new Error(
          "GitHub is required for this request, but the github tool is not registered.",
        );
      }

      const fileRequest = extractGitHubFileRequest(request);
      if (!fileRequest) {
        throw new Error(
          "I could not determine which GitHub repository and README to read.",
        );
      }

      const readArguments: Record<string, unknown> = {
        action: "get_file",
        repository: fileRequest.repository,
        path: "README.md",
      };

      emit({
        type: "status",
        message: "GitHub is reading README.md…",
      });
      emit({
        type: "tool_call",
        message: "GitHub is reading README.md…",
        tool: "github",
        arguments: readArguments,
      });

      const readmeResult = await github.execute(readArguments, {
        files: request.files || [],
        signal,
      });

      emit({
        type: "tool_result",
        message: readmeResult.ok
          ? "GitHub returned README.md."
          : "GitHub could not read README.md.",
        tool: "github",
        ok: readmeResult.ok,
      });

      if (!readmeResult.ok) {
        throw new Error(readmeResult.content);
      }

      addSources(sources, readmeResult.sources);

      const readmeBody = extractFileBody(readmeResult)
        .replace(/\u0000/g, "")
        .replace(/\s+/g, " ")
        .trim();

      const readmeContentLength =
        typeof readmeResult.metadata?.contentLength === "number"
          ? readmeResult.metadata.contentLength
          : readmeBody.length;

      const readmeInsufficient =
        readmeContentLength < 80 || readmeBody.replace(/^#+\s*/, "").length < 80;

      if (readmeInsufficient) {
        emit({
          type: "status",
          message: "README.md is insufficient; GitHub is exploring the repository…",
        });

        const overview = await github.execute(
          {
            action: "project_overview",
            repository: fileRequest.repository,
          },
          {
            files: request.files || [],
            signal,
          },
        );

        emit({
          type: "tool_call",
          message: "GitHub is exploring the repository…",
          tool: "github",
          arguments: {
            action: "project_overview",
            repository: fileRequest.repository,
          },
        });

        emit({
          type: "tool_result",
          message: overview.ok
            ? "GitHub finished repository exploration."
            : "GitHub repository exploration failed.",
          tool: "github",
          ok: overview.ok,
        });

        if (!overview.ok) throw new Error(overview.content);

        addSources(sources, overview.sources);

        for (const status of metadataStringArray(overview, "statuses")) {
          if (
            status !== "GitHub: explored repository structure" &&
            status !== "GitHub: inspected " + fileRequest.repository
          ) {
            emit({ type: "status", message: status });
          }
        }

        const selectedPaths = extractSelectedFilePaths(overview);
        if (selectedPaths.length) {
          for (const path of selectedPaths) {
            emit({ type: "status", message: `GitHub is reading ${path}…` });
          }
        }

        emit({
          type: "status",
          message: "Isabella is analyzing the project…",
        });

        const evidencePrompt = extractEvidencePrompt(overview);
        if (!evidencePrompt) {
          throw new Error(
            "GitHub exploration completed without an analysis evidence prompt.",
          );
        }

        const analyzed = await runSingleEvidenceAnalysis(
          this.model,
          evidencePrompt,
          signal,
        );

        finalAnswer = analyzed || overview.content;

        emit({
          type: "final",
          message: "Isabella completed the repository analysis.",
        });

        return {
          text: finalAnswer || "I could not explain the repository.",
          sources,
          steps,
          memoryWrites,
          videoUrl,
        };
      }

      emit({
        type: "status",
        message: "Isabella is analyzing README.md…",
      });

      const readmePrompt = [
        "You are analyzing a GitHub README.",
        "Use ONLY the README content provided below.",
        "Explain how the project works only to the extent supported by that README.",
        "Do not invent implementation details that are not documented.",
        "Name README.md as the source for claims.",
        "",
        `Repository: ${fileRequest.repository}`,
        "README.md content:",
        readmeBody,
      ].join("\n");

      const analyzed = await runSingleEvidenceAnalysis(
        this.model,
        readmePrompt,
        signal,
      );

      finalAnswer = analyzed || readmeBody;

      emit({
        type: "final",
        message: "Isabella explained the GitHub README.",
      });

      return {
        text: finalAnswer || "I could not explain the README.",
        sources,
        steps,
        memoryWrites,
        videoUrl,
      };
    }

    /* --------------------------------------------------------------------- */
    /* Step 4-8: repository-understanding path.                              */
    /* --------------------------------------------------------------------- */
    if (isRepositoryOverviewRequest(request)) {
      const github = toolByName.get("github");
      if (!github) {
        throw new Error(
          "GitHub is required for this request, but the github tool is not registered.",
        );
      }

      const repositoryMatch = lastUserMessage(request).match(
        /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/,
      );

      if (!repositoryMatch?.[1]) {
        throw new Error(
          "I could not determine which GitHub repository to analyze.",
        );
      }

      const repository = repositoryMatch[1];
      const overviewArguments: Record<string, unknown> = {
        action: "project_overview",
        repository,
      };

      emit({
        type: "status",
        message: "GitHub is exploring the repository…",
      });
      emit({
        type: "tool_call",
        message: "GitHub is exploring the repository…",
        tool: "github",
        arguments: overviewArguments,
      });

      const overview = await github.execute(overviewArguments, {
        files: request.files || [],
        signal,
      });

      emit({
        type: "tool_result",
        message: overview.ok
          ? "GitHub finished repository exploration."
          : "GitHub repository exploration failed.",
        tool: "github",
        ok: overview.ok,
      });

      if (!overview.ok) throw new Error(overview.content);

      addSources(sources, overview.sources);

      const statuses = metadataStringArray(overview, "statuses");
      const selectedPaths = extractSelectedFilePaths(overview);

      if (statuses.length) {
        for (const status of statuses) {
          if (!status.startsWith("GitHub: inspected ")) {
            emit({ type: "status", message: status });
          }
        }
      }

      for (const path of selectedPaths) {
        emit({ type: "status", message: `GitHub is reading ${path}…` });
      }

      emit({
        type: "status",
        message: "Isabella is analyzing the project…",
      });

      const evidencePrompt = extractEvidencePrompt(overview);
      if (!evidencePrompt) {
        throw new Error(
          "GitHub exploration completed without an analysis evidence prompt.",
        );
      }

      const analyzed = await runSingleEvidenceAnalysis(
        this.model,
        evidencePrompt,
        signal,
      );

      finalAnswer = analyzed || overview.content;

      emit({
        type: "final",
        message: "Isabella completed the repository analysis.",
      });

      return {
        text: finalAnswer || "I could not explain the repository.",
        sources,
        steps,
        memoryWrites,
        videoUrl,
      };
    }

    if (isExplicitGitHubSearchRequest(request)) {
      const github = toolByName.get("github");
      if (!github) {
        throw new Error(
          "GitHub is required for this request, but the github tool is not registered.",
        );
      }

      const query = extractGitHubSearchQuery(request);
      if (!query) {
        throw new Error("I could not determine what to search for on GitHub.");
      }

      const githubArguments: Record<string, unknown> = {
        action: "search_repositories",
        query,
        limit: 5,
      };

      emit({
        type: "tool_call",
        message: "GitHub is searching repositories…",
        tool: "github",
        arguments: githubArguments,
      });

      const result = await github.execute(githubArguments, {
        files: request.files || [],
        signal,
      });

      emit({
        type: "tool_result",
        message: result.ok
          ? "GitHub returned repository results."
          : "GitHub search failed.",
        tool: "github",
        ok: result.ok,
      });

      if (!result.ok) throw new Error(result.content);
      addSources(sources, result.sources);

      emit({
        type: "final",
        message: "Isabella completed the GitHub search.",
      });

      return {
        text: result.content,
        sources,
        steps,
        memoryWrites,
        videoUrl,
      };
    }

    /* --------------------------------------------------------------------- */
    /* Existing deterministic Higgsfield path.                               */
    /* --------------------------------------------------------------------- */
    if (isExplicitVideoGenerationRequest(request)) {
      const videoTool = toolByName.get("higgsfield_video");
      if (!videoTool) {
        throw new Error(
          "Higgsfield Video is required for this request, but the higgsfield_video tool is not registered.",
        );
      }

      const videoArguments: Record<string, unknown> = {
        prompt: lastUserMessage(request).trim(),
        duration: 5,
        resolution: "720p",
        aspect_ratio: "16:9",
        generate_audio: true,
      };

      emit({
        type: "tool_call",
        message: "Higgsfield is generating your video…",
        tool: "higgsfield_video",
        arguments: videoArguments,
      });

      const result = await videoTool.execute(videoArguments, {
        files: request.files || [],
        signal,
      });

      if (result.videoUrl) videoUrl = result.videoUrl;

      emit({
        type: "tool_result",
        message: result.ok
          ? "Higgsfield generated the video."
          : "Higgsfield video generation failed.",
        tool: "higgsfield_video",
        ok: result.ok,
      });

      if (!result.ok) throw new Error(result.content);

      finalAnswer = "Done — I generated your video with Higgsfield.";

      emit({
        type: "final",
        message: "Isabella completed the video.",
      });

      return {
        text: finalAnswer,
        sources,
        steps,
        memoryWrites,
        videoUrl,
      };
    }

    /* --------------------------------------------------------------------- */
    /* Normal agent loop for everything else.                                */
    /* --------------------------------------------------------------------- */
for (let iteration = 0; iteration < maxSteps; iteration += 1) {
      if (signal?.aborted) {
        throw new Error("The agent request was cancelled.");
      }

      const raw = await this.model.complete(contextMessages, { signal });
      const action = parseAction(raw);

      if (!action) {
        if (raw.trim()) {
          finalAnswer = raw.trim();
          emit({
            type: "final",
            message: "Isabella completed the task.",
          });
          break;
        }

        throw new Error("Isabella produced an invalid empty agent action.");
      }

      if (action.type === "final") {
        finalAnswer = action.answer.trim();
        for (const memory of action.memory || []) {
          memoryWrites.push(memory);
        }

        emit({
          type: "final",
          message: "Isabella completed the task.",
        });
        break;
      }

      const tool = toolByName.get(action.tool);
      if (!tool) {
        emit({
          type: "error",
          message: `Isabella requested an unavailable tool: ${action.tool}.`,
          tool: action.tool,
          ok: false,
        });

        contextMessages.push({
          role: "user",
          content: `TOOL ERROR: The requested tool "${action.tool}" is unavailable. Choose another available tool or return a final answer.`,
        });
        continue;
      }

      const arguments_ = action.arguments || {};

      emit({
        type: "tool_call",
        message: `${tool.name} is working…`,
        tool: tool.name,
        arguments: arguments_,
      });

      const result = await tool.execute(arguments_, {
        files: request.files || [],
        signal,
      });

      if (result.videoUrl) videoUrl = result.videoUrl;

      emit({
        type: "tool_result",
        message: result.ok
          ? `${tool.name} returned a result.`
          : `${tool.name} reported an error.`,
        tool: tool.name,
        ok: result.ok,
      });

      addSources(sources, result.sources);

      contextMessages.push({
        role: "user",
        content: `TOOL RESULT (${tool.name}):\n${result.content}\n\nUse this result as evidence. Continue the task or return a final answer.`,
      });
    }

    if (!finalAnswer) {
      contextMessages.push({
        role: "user",
        content:
          "You reached the tool-step limit. Provide the best complete answer possible now, using only the evidence collected.",
      });

      const raw = await this.model.complete(contextMessages, { signal });
      const action = parseAction(raw);

      finalAnswer =
        action?.type === "final" ? action.answer.trim() : raw.trim();

      if (action?.type === "final") {
        for (const memory of action.memory || []) {
          memoryWrites.push(memory);
        }
      }

      emit({
        type: "final",
        message: "Isabella finished after reaching the safe step limit.",
      });
    }

    return {
      text: finalAnswer || "I could not complete that task.",
      sources,
      steps,
      memoryWrites,
      videoUrl,
    };
  }
}

export function getLastUserMessage(request: AgentRequest): string {
  return lastUserMessage(request);
}

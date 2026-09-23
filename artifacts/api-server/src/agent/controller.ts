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

const ALWAYS_ON_TOOLS = [timeTool];

const TOOL_PLUGIN_MAP: Record<string, ToolDefinition[]> = {
  "web-search": [webSearchTool, webFetchTool],
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

  // Wikipedia is available whenever web access is enabled.
  if (webEnabled) {
    map.set(wikipediaSearchTool.name, wikipediaSearchTool);
    map.set(wikipediaArticleTool.name, wikipediaArticleTool);
  }

  // Web search/fetch is enabled only when the web-search plugin is enabled.
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

function toolCatalog(tools: ToolDefinition[]) {
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

    if (
      value.type === "final" &&
      typeof value.answer === "string"
    ) {
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

    if (
      value.type === "tool_call" &&
      typeof value.tool === "string"
    ) {
      return {
        type: "tool_call",
        tool: value.tool,
        arguments:
          value.arguments &&
          typeof value.arguments === "object"
            ? (value.arguments as Record<string, unknown>)
            : {},
        reason:
          typeof value.reason === "string"
            ? value.reason
            : undefined,
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
      .find((message) => message.role === "user")
      ?.content || ""
  );
}

function isExplicitVideoGenerationRequest(
  request: AgentRequest,
): boolean {
  const text = lastUserMessage(request).toLowerCase();

  const hasVideoNoun =
    /\b(video|videos|clip|movie|animation|animate|film)\b/.test(text);

  const hasGenerationVerb =
    /\b(generate|create|make|produce|render|animate|turn|convert)\b/.test(text);

  return hasVideoNoun && hasGenerationVerb;
}


function isExplicitGitHubSearchRequest(
  request: AgentRequest,
): boolean {
  const text = lastUserMessage(request).toLowerCase();

  const mentionsGitHub = /\bgithub\b/.test(text);
  const searchIntent = /\b(search|find|look\s*up)\b/.test(text);
  const repositoryIntent = /\b(repo|repos|repository|repositories|code|issue|issues|pull\s*request|pr)\b/.test(text);

  return mentionsGitHub && searchIntent && repositoryIntent;
}

function extractGitHubSearchQuery(request: AgentRequest): string {
  const original = lastUserMessage(request).trim();
  const normalized = original.replace(/\s+/g, ' ');

  const aboutMatch = normalized.match(/\babout\s+(.+?)(?:\.|$)/i);
  if (aboutMatch?.[1]) return aboutMatch[1].trim();

  const forMatch = normalized.match(/\bfor\s+(.+?)(?:\.|$)/i);
  if (forMatch?.[1]) {
    return forMatch[1]
      .replace(/^(repositories?|repos?|code|issues?|pull\s+requests?)\s+(?:about|on|for)\s+/i, '')
      .trim();
  }

  return normalized
    .replace(/^[^:]*?:/i, '')
    .replace(/\b(search|find|look\s*up)\b/gi, '')
    .replace(/\bgithub\b/gi, '')
    .replace(/\b(repositories?|repos?|code|issues?|pull\s*requests?|for)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}


function isExplicitGitHubFileReadRequest(
  request: AgentRequest,
): boolean {
  const text = lastUserMessage(request).toLowerCase();

  const mentionsGitHub = /\bgithub\b/.test(text);
  const readIntent =
    /\b(read|show|open|inspect|view|fetch|get)\b/.test(text);
  const fileIntent =
    /\b(readme(?:\.md)?|file|source|code|contents?|\.md|\.ts|\.tsx|\.js|\.json|\.py|\.yaml|\.yml|\.toml)\b/.test(
      text,
    );
  const hasRepository =
    /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/.test(text);

  return mentionsGitHub && readIntent && fileIntent && hasRepository;
}

function extractGitHubFileRequest(
  request: AgentRequest,
): { repository: string; path: string } | null {
  const original = lastUserMessage(request).replace(/\s+/g, " ").trim();

  const repoMatch = original.match(
    /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/,
  );

  if (!repoMatch?.[1]) return null;

  const repository = repoMatch[1];

  const readmeMatch = original.match(
    /\b(readme(?:\.md)?)\b/i,
  );

  if (readmeMatch) {
    return { repository, path: "README.md" };
  }

  const pathMatch = original.match(
    /\b([A-Za-z0-9_.-]+\.(?:md|mdx|txt|ts|tsx|js|jsx|json|py|yaml|yml|toml|css|html))\b/i,
  );

  if (pathMatch?.[1]) {
    return { repository, path: pathMatch[1] };
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

    // Tool-selection rules.
    "Tool selection rules:",
    "Use wikipedia_search for stable encyclopedia-style topics such as history, biographies, science, technology, places, and general reference questions.",
    "Use wikipedia_article after wikipedia_search when the answer needs more detailed information from a specific Wikipedia article.",
    "Use web_search for current, recent, changing, time-sensitive, price, product, company, news, or statistics questions.",
    "Use web_fetch when a specific public web page needs to be read in detail.",
    "Use calculator for arithmetic instead of doing complicated calculations mentally.",
    "Use file tools when the answer depends on uploaded files.",
    "Do not use tools for simple conversation when a direct answer is enough.",
    "Do not call multiple tools unless the task actually requires them.",
    "If a previous tool result is insufficient, choose another available tool rather than guessing.",
    "Use huggingface_specialist for specialist AI tasks when a dedicated Hugging Face model can provide useful additional capability.",
    "Use huggingface_specialist for tasks such as specialized text analysis, classification, structured transformation, or other model-specific work.",
    "Do not use huggingface_specialist for ordinary conversation when Nemotron can answer directly.",
    "Use at most one huggingface_specialist call unless another call is genuinely necessary.",
    "Use github for GitHub searches and repository data when the GitHub plugin is available.",
    "For requests to search GitHub repositories, call github with action=search_repositories and the user's topic as query.",
    "After a successful GitHub tool call, use the returned repository data to provide the user-facing answer.",
    "Do not stop after a GitHub tool call without producing a final answer.",
    "For an explicit request to read or show a GitHub file, read that file first, then answer from its contents; do not stop after the tool call.",
    "Use higgsfield_video for explicit video generation requests when the higgsfield-video plugin is enabled.",
    "Never claim that you cannot call Higgsfield when higgsfield_video is present in the available tools.",
    "When higgsfield_video is selected, the tool itself performs the external video generation.",

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

    if (
      (isExplicitGitHubSearchRequest(request) ||
        isExplicitGitHubFileReadRequest(request)) &&
      !requestedPlugins.includes("github")
    ) {
      requestedPlugins.push("github");
    }

    // Explicit video-generation requests should always have the Higgsfield
    // capability available, even if the user did not toggle the plugin on.
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

    const toolByName = new Map(
      tools.map((tool) => [tool.name, tool]),
    );

    // Keep the agent loop smaller so ordinary requests stay fast.
    const maxSteps = Math.min(
      6,
      Math.max(1, request.maxSteps || 4),
    );

    const steps: AgentStep[] = [];
    const sources: AgentResult["sources"] = [];
    const memoryWrites: AgentResult["memoryWrites"] = [];

    const contextMessages: ChatMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(request, tools),
      },
      ...request.messages.slice(-14),
    ];

    const emit = (
      step: Omit<AgentStep, "id" | "timestamp">,
    ) => {
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
      message:
        "Understanding your goal and choosing the next action.",
    });

    let finalAnswer = "";
    let videoUrl: string | undefined;

    /*
     * Deterministic GitHub file-read path:
     * For explicit requests such as "Read the README.md from owner/repo",
     * call GitHub directly, then use Nemotron once to explain the file.
     */
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
        message: "GitHub is reading the repository file…",
        tool: "github",
        arguments: githubArguments,
      });

      if (signal?.aborted) {
        throw new Error("The GitHub request was cancelled.");
      }

      const result = await github.execute(
        githubArguments,
        {
          files: request.files || [],
          signal,
        },
      );

      emit({
        type: "tool_result",
        message: result.ok
          ? "GitHub returned the repository file."
          : "GitHub file read failed.",
        tool: "github",
        ok: result.ok,
      });

      if (!result.ok) {
        throw new Error(result.content);
      }

      if (result.sources) {
        for (const source of result.sources) {
          if (!sources.some((item) => item.url === source.url)) {
            sources.push(source);
          }
        }
      }

      const fileContent = result.content.trim();
      const normalizedFileContent = fileContent
        .replace(/\u0000/g, "")
        .replace(/\s+/g, " ")
        .trim();

      // Never let the model invent project details when the requested file
      // is empty, malformed, or clearly too small to support an explanation.
      const looksLikeEmptyReadme =
        fileRequest.path.toLowerCase() === "readme.md" &&
        normalizedFileContent.replace(/^#+\s*/, "").trim().length < 80;

      if (looksLikeEmptyReadme) {
        finalAnswer =
          `I read ${fileRequest.path} from ${fileRequest.repository}. ` +
          `The README is essentially empty and only contains the project title, so it does not document how the project works. ` +
          `I would need to inspect the repository's source files to explain the architecture accurately.`;

        emit({
          type: "final",
          message: "Isabella reported that the README lacks project documentation.",
        });

        return {
          text: finalAnswer,
          sources,
          steps,
          memoryWrites,
          videoUrl,
        };
      }

      contextMessages.push({
        role: "user",
        content:
          `GITHUB FILE RESULT (${fileRequest.repository}/${fileRequest.path}):\n${result.content}\n\n` +
          "Now explain how this project works using only the GitHub file content above. " +
          "Do not invent any details that are not supported by the file. " +
          "Do not call another GitHub tool unless the file explicitly indicates that another file is required. " +
          "Return a normal user-facing explanation, not JSON.",
      });

      const raw = await this.model.complete(
        contextMessages,
        { signal },
      );

      const action = parseAction(raw);

      finalAnswer =
        action?.type === "final"
          ? action.answer.trim()
          : raw.trim();

      emit({
        type: "final",
        message: "Isabella explained the GitHub project.",
      });

      return {
        text: finalAnswer || "I could not explain the GitHub project.",
        sources,
        steps,
        memoryWrites,
        videoUrl,
      };
    }

    /*
     * Deterministic GitHub search path:
     * Explicit GitHub searches should not depend on the model
     * producing a second JSON action after the tool result.
     */
    if (isExplicitGitHubSearchRequest(request)) {
      const github = toolByName.get("github");

      if (!github) {
        throw new Error(
          "GitHub is required for this request, but the github tool is not registered.",
        );
      }

      const query = extractGitHubSearchQuery(request);

      if (!query) {
        throw new Error(
          "I could not determine what to search for on GitHub.",
        );
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

      if (signal?.aborted) {
        throw new Error("The GitHub request was cancelled.");
      }

      const result = await github.execute(
        githubArguments,
        {
          files: request.files || [],
          signal,
        },
      );

      emit({
        type: "tool_result",
        message: result.ok
          ? "GitHub returned repository results."
          : "GitHub search failed.",
        tool: "github",
        ok: result.ok,
      });

      if (!result.ok) {
        throw new Error(result.content);
      }

      if (result.sources) {
        sources.push(...result.sources);
      }

      emit({
        type: "final",
        message: "Isabella completed the GitHub search.",
      });

      return {
        text: result.content,
        sources,
        steps,
        memoryWrites,
      };
    }

    /*
     * Deterministic video path:
     * When the user explicitly asks to generate a video, do not
     * depend on the language model deciding whether the external
     * video tool is callable. Call the registered tool directly.
     */
    if (
      isExplicitVideoGenerationRequest(request)
    ) {
      const videoTool =
        toolByName.get("higgsfield_video");

      if (!videoTool) {
        throw new Error(
          "Higgsfield Video is required for this request, but the higgsfield_video tool is not registered.",
        );
      }

      const prompt =
        lastUserMessage(request).trim();

      const videoArguments: Record<string, unknown> = {
        prompt,
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

      if (signal?.aborted) {
        throw new Error("The video request was cancelled.");
      }

      const result =
        await videoTool.execute(
          videoArguments,
          {
            files: request.files || [],
            signal,
          },
        );

      if (result.videoUrl) {
        videoUrl = result.videoUrl;
      }

      emit({
        type: "tool_result",
        message: result.ok
          ? "Higgsfield generated the video."
          : "Higgsfield video generation failed.",
        tool: "higgsfield_video",
        ok: result.ok,
      });

      if (!result.ok) {
        throw new Error(result.content);
      }

      finalAnswer =
        "Done — I generated your video with Higgsfield.";

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

    for (
      let iteration = 0;
      iteration < maxSteps;
      iteration += 1
    ) {
      if (signal?.aborted) {
        throw new Error("The agent request was cancelled.");
      }

      const raw = await this.model.complete(contextMessages, {
        signal,
      });

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

        throw new Error(
          "Isabella produced an invalid empty agent action.",
        );
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

      if (result.videoUrl) {
        videoUrl = result.videoUrl;
      }

      emit({
        type: "tool_result",
        message: result.ok
          ? `${tool.name} returned a result.`
          : `${tool.name} reported an error.`,
        tool: tool.name,
        ok: result.ok,
      });

      if (result.sources) {
        for (const source of result.sources) {
          if (
            !sources.some(
              (item) => item.url === source.url,
            )
          ) {
            sources.push(source);
          }
        }
      }

      contextMessages.push({
        role: "user",
        content: `TOOL RESULT (${tool.name}):
${result.content}

Use this result as evidence. Continue the task or return a final answer.`,
      });
    }

    if (!finalAnswer) {
      contextMessages.push({
        role: "user",
        content:
          "You reached the tool-step limit. Provide the best complete answer possible now, using only the evidence collected.",
      });

      const raw = await this.model.complete(
        contextMessages,
        { signal },
      );

      const action = parseAction(raw);

      finalAnswer =
        action?.type === "final"
          ? action.answer.trim()
          : raw.trim();

      emit({
        type: "final",
        message:
          "Isabella finished after reaching the safe step limit.",
      });
    }

    return {
      text:
        finalAnswer || "I could not complete that task.",
      sources,
      steps,
      memoryWrites,
      videoUrl,
    };
  }
}

export function getLastUserMessage(
  request: AgentRequest,
) {
  return lastUserMessage(request);
}
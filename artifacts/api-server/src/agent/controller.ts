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

import {
  wikipediaSearchTool,
  wikipediaArticleTool,
} from "./tools/wikipedia.ts";
 import { huggingFaceTool } from "./tools/huggingface.ts";

const ALWAYS_ON_TOOLS = [timeTool];

const TOOL_PLUGIN_MAP: Record<string, ToolDefinition[]> = {
  "web-search": [webSearchTool, webFetchTool],
  calculator: [calculatorTool],
  "file-analyzer": [fileListTool, fileReadTool, fileSearchTool],
  huggingface: [huggingFaceTool],
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
    const tools = uniqueTools(
      request.plugins,
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
    };
  }
}

export function getLastUserMessage(
  request: AgentRequest,
) {
  return lastUserMessage(request);
}
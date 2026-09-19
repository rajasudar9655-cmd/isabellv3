export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type Source = {
  title: string;
  url: string;
  snippet?: string;
};

export type AgentFile = {
  id: string;
  name: string;
  mimeType?: string;
  text: string;
};

export type AgentPreferences = {
  name?: string;
  warm?: boolean;
  concise?: boolean;
  web?: boolean;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (arguments_: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
};

export type ToolContext = {
  files: AgentFile[];
  signal?: AbortSignal;
};

export type ToolResult = {
  ok: boolean;
  content: string;
  sources?: Source[];
  metadata?: Record<string, unknown>;
};

export type AgentStep = {
  id: string;
  type: "status" | "tool_call" | "tool_result" | "final" | "error";
  message: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  ok?: boolean;
  timestamp: string;
};

export type AgentAction =
  | {
      type: "tool_call";
      tool: string;
      arguments?: Record<string, unknown>;
      reason?: string;
    }
  | {
      type: "final";
      answer: string;
      memory?: Array<{ key: string; value: string }>;
    };

export type AgentRequest = {
  messages: ChatMessage[];
  mode?: string;
  plugins?: string[];
  files?: AgentFile[];
  memory?: Array<{ key: string; value: string }>;
  preferences?: AgentPreferences;
  maxSteps?: number;
};

export type AgentResult = {
  text: string;
  sources: Source[];
  steps: AgentStep[];
  memoryWrites: Array<{ key: string; value: string }>;
};

export type AgentEvent =
  | AgentStep
  | { type: "done"; result: AgentResult; timestamp: string }
  | { type: "error"; message: string; timestamp: string };

export interface ModelProvider {
  complete(messages: ChatMessage[], options?: { signal?: AbortSignal }): Promise<string>;
}

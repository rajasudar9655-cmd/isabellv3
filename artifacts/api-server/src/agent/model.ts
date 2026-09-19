import type { ChatMessage, ModelProvider } from "./types.ts";

function getConfig() {
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "";
  const baseUrl = process.env.LLM_BASE_URL || (apiKey.startsWith("nvapi-") ? "https://integrate.api.nvidia.com/v1" : "https://api.openai.com/v1");
  const model = process.env.LLM_MODEL || (apiKey.startsWith("nvapi-") ? "nvidia/nemotron-3-ultra-550b-a55b" : "gpt-5.1");
  return { apiKey, baseUrl: baseUrl.replace(/\/$/, ""), model };
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private readonly config = getConfig()) {}

  async complete(messages: ChatMessage[], options: { signal?: AbortSignal } = {}): Promise<string> {
    const { apiKey, baseUrl, model } = this.config;
    const localEndpoint = /^(https?:\/\/)(localhost|127\.0\.0\.1|::1)(?::\d+)?(?:\/|$)/i.test(baseUrl);
    if (!apiKey && !localEndpoint && !process.env.LLM_ALLOW_ANONYMOUS) throw new Error("No LLM credential is configured. Set LLM_API_KEY/OPENAI_API_KEY or configure a local compatible endpoint.");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: options.signal,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        ...(baseUrl.includes("api.openai.com") ? { max_completion_tokens: 8192 } : { max_tokens: 8192 }),
        messages,
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Model request failed with HTTP ${response.status}: ${detail.slice(0, 400)}`);
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("The model returned an empty response.");
    return text;
  }
}

export function createModelProvider(): ModelProvider {
  return new OpenAICompatibleProvider();
}

import type { ToolDefinition, ToolResult } from "../types.ts";

const HF_URL = "https://router.huggingface.co/v1/chat/completions";

export const huggingFaceTool: ToolDefinition = {
  name: "huggingface_specialist",

  description:
    "Use Hugging Face only for specialist AI inference when a separate model is useful. Do not use it for ordinary conversation that Nemotron can answer directly.",

  inputSchema: {
    prompt: {
      type: "string",
      description: "Task for the specialist model",
    },

    model: {
      type: "string",
      description:
        "Optional Hugging Face model ID. Example: openai/gpt-oss-120b:fastest",
    },

    maxTokens: {
      type: "number",
      description: "Maximum output tokens, normally 256-1024",
    },
  },

  async execute(
    arguments_,
    context,
  ): Promise<ToolResult> {
    const token = process.env.HF_TOKEN;

    if (!token) {
      return {
        ok: false,
        content:
          "Hugging Face is not configured. Set HF_TOKEN in the API server environment.",
      };
    }

    const prompt =
      typeof arguments_.prompt === "string"
        ? arguments_.prompt.trim()
        : "";

    if (!prompt) {
      return {
        ok: false,
        content: "Hugging Face requires a prompt.",
      };
    }

    const model =
      typeof arguments_.model === "string" &&
      arguments_.model.trim()
        ? arguments_.model.trim()
        : process.env.HF_MODEL ||
          "openai/gpt-oss-120b:fastest";

    // Keep the full specialist output capability.
    const maxTokens = Math.min(
      1024,
      Math.max(
        128,
        Number(arguments_.maxTokens) || 512,
      ),
    );

    try {
      const response = await fetch(HF_URL, {
        method: "POST",
        signal: context.signal,

        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },

        body: JSON.stringify({
          model,

          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],

          max_tokens: maxTokens,

          temperature: 0.2,

          // Hugging Face streaming enabled.
          stream: true,
        }),
      });

      if (!response.ok) {
        const detail = await response.text();

        return {
          ok: false,
          content:
            `Hugging Face returned HTTP ${response.status}: ` +
            detail.slice(0, 500),
        };
      }

      if (!response.body) {
        return {
          ok: false,
          content:
            "Hugging Face returned no streaming body.",
        };
      }

      const reader =
        response.body.getReader();

      const decoder =
        new TextDecoder();

      let buffer = "";
      let answer = "";

      const processLine = (
        line: string,
      ) => {
        const trimmed =
          line.trim();

        // Ignore empty SSE lines.
        if (!trimmed) {
          return;
        }

        // Ignore SSE comments.
        if (trimmed.startsWith(":")) {
          return;
        }

        // We only need data events.
        if (!trimmed.startsWith("data:")) {
          return;
        }

        const payload =
          trimmed.slice(5).trim();

        // End of stream.
        if (
          !payload ||
          payload === "[DONE]"
        ) {
          return;
        }

        try {
          const chunk =
            JSON.parse(payload) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                };
              }>;
            };

          const piece =
            chunk.choices?.[0]?.delta
              ?.content || "";

          if (piece) {
            answer += piece;
          }
        } catch {
          // Ignore malformed chunks.
        }
      };

      while (true) {
        const {
          value,
          done,
        } = await reader.read();

        if (done) {
          break;
        }

        buffer +=
          decoder.decode(value, {
            stream: true,
          });

        const lines =
          buffer.split("\n");

        // Preserve an incomplete final line.
        buffer =
          lines.pop() || "";

        for (const line of lines) {
          processLine(line);
        }
      }

      // Flush decoder.
      buffer +=
        decoder.decode();

      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          processLine(line);
        }
      }

      const trimmedAnswer =
        answer.trim();

      if (!trimmedAnswer) {
        return {
          ok: false,
          content:
            "Hugging Face returned an empty response.",
        };
      }

      return {
        ok: true,

        content:
          trimmedAnswer,

        metadata: {
          provider:
            "huggingface",

          model,

          streaming:
            true,
        },
      };
    } catch (error) {
      return {
        ok: false,

        content:
          error instanceof Error
            ? error.message
            : "Hugging Face inference failed.",
      };
    }
  },
};
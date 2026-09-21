import type { ChatMessage, ModelProvider } from "./types.ts";

function getConfig() {
  const apiKey =
    process.env.LLM_API_KEY ||
    process.env.OPENAI_API_KEY ||
    "";

  const baseUrl =
    process.env.LLM_BASE_URL ||
    (apiKey.startsWith("nvapi-")
      ? "https://integrate.api.nvidia.com/v1"
      : "https://api.openai.com/v1");

  const model =
    process.env.LLM_MODEL ||
    (apiKey.startsWith("nvapi-")
      ? "nvidia/nemotron-3-ultra-550b-a55b"
      : "gpt-5.1");

  const maxTokens = Math.min(
    2048,
    Math.max(
      128,
      Number(process.env.LLM_MAX_TOKENS) || 1024,
    ),
  );

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/$/, ""),
    model,
    maxTokens,
  };
}

function isRetryableStatus(status: number): boolean {
  return [429, 500, 502, 503, 504].includes(status);
}

async function wait(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new Error("The model request was cancelled.");
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new Error("The model request was cancelled."),
      );
    };

    signal?.addEventListener("abort", onAbort, {
      once: true,
    });
  });
}

export class OpenAICompatibleProvider
  implements ModelProvider
{
  constructor(
    private readonly config = getConfig(),
  ) {}

  async complete(
    messages: ChatMessage[],
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const {
      apiKey,
      baseUrl,
      model,
      maxTokens,
    } = this.config;

    const localEndpoint =
      /^(https?:\/\/)(localhost|127\.0\.0\.1|::1)(:\d+)?(\/|$)/i.test(
        baseUrl,
      );

    if (
      !apiKey &&
      !localEndpoint &&
      !process.env.LLM_ALLOW_ANONYMOUS
    ) {
      throw new Error(
        "No LLM credential is configured. Set LLM_API_KEY/OPENAI_API_KEY or configure a local compatible endpoint.",
      );
    }

    const maxRetries = 3;

    for (
      let attempt = 0;
      attempt <= maxRetries;
      attempt += 1
    ) {
      if (options.signal?.aborted) {
        throw new Error(
          "The model request was cancelled.",
        );
      }

      try {
        const response = await fetch(
          `${baseUrl}/chat/completions`,
          {
            method: "POST",
            signal: options.signal,
            headers: {
              "Content-Type": "application/json",
              ...(apiKey
                ? {
                    Authorization: `Bearer ${apiKey}`,
                  }
                : {}),
            },
            body: JSON.stringify({
              model,

              ...(baseUrl.includes("api.openai.com")
                ? {
                    max_completion_tokens:
                      maxTokens,
                  }
                : {
                    max_tokens: maxTokens,
                  }),

              messages,

              temperature: 0.2,
            }),
          },
        );

        if (response.ok) {
          const data =
            (await response.json()) as {
              choices?: Array<{
                message?: {
                  content?: string;
                };
              }>;
            };

          const text =
            data.choices?.[0]?.message?.content?.trim();

          if (!text) {
            throw new Error(
              "The model returned an empty response.",
            );
          }

          return text;
        }

        const detail = await response.text();

        if (
          isRetryableStatus(response.status) &&
          attempt < maxRetries
        ) {
          const delay =
            700 * 2 ** attempt;

          await wait(
            delay,
            options.signal,
          );

          continue;
        }

        throw new Error(
          `Model request failed with HTTP ${response.status}: ${detail.slice(
            0,
            400,
          )}`,
        );
      } catch (error) {
        if (options.signal?.aborted) {
          throw new Error(
            "The model request was cancelled.",
          );
        }

        // Retry temporary network failures.
        if (
          error instanceof TypeError &&
          attempt < maxRetries
        ) {
          const delay =
            700 * 2 ** attempt;

          await wait(
            delay,
            options.signal,
          );

          continue;
        }

        throw error;
      }
    }

    throw new Error(
      "The model request failed after retries.",
    );
  }
}

export function createModelProvider(): ModelProvider {
  return new OpenAICompatibleProvider();
}
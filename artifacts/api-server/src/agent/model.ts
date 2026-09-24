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

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after")?.trim();

  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(30_000, seconds * 1000);
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.min(30_000, Math.max(0, dateMs - Date.now()));
  }

  return null;
}

function backoffDelayMs(attempt: number): number {
  const base = 1_000 * 2 ** attempt;
  const capped = Math.min(base, 8_000);
  const jitter = Math.floor(Math.random() * 251);
  return capped + jitter;
}

async function wait(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new Error("The model request was cancelled.");
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("The model request was cancelled."));
    };

    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", onAbort, { once: true });

    if (signal?.aborted) {
      clearTimeout(timer);
      onAbort();
    }
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

    // Give temporary provider overloads more time to recover.
    // Total backoff before the final attempt is roughly 15 seconds.
    const maxRetries = 4;

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
            retryAfterMs(response) ??
            backoffDelayMs(attempt);

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

        // Retry temporary network failures with the same backoff strategy.
        if (
          error instanceof TypeError &&
          attempt < maxRetries
        ) {
          const delay = backoffDelayMs(attempt);

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

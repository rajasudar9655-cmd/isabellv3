import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Router,
  type IRouter,
  type Request,
} from "express";

const execFileAsync = promisify(execFile);

const router: IRouter = Router();

/*
 * Legacy NVIDIA endpoints.
 *
 * These remain available for compatibility.
 * The new Gemini Live frontend does NOT use them.
 */
const asrEndpoint =
  "https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com/v1/audio/transcriptions";

const ttsEndpoint =
  "https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1/audio/synthesize";

/*
 * Gemini ephemeral token response.
 */
type GeminiTokenResponse = {
  name?: string;
  error?: {
    message?: string;
    status?: string;
    code?: number;
  };
};

/*
 * Decode a browser Data URL safely.
 *
 * Supports:
 *   data:audio/webm;base64,...
 *   data:audio/webm;codecs=opus;base64,...
 *   data:audio/ogg;base64,...
 *   data:audio/wav;base64,...
 */
function decodeAudio(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("Audio is required.");
  }

  const marker = ";base64,";
  const markerIndex = value.indexOf(marker);

  if (markerIndex >= 0) {
    const header = value.slice(
      0,
      markerIndex,
    );

    const base64 = value.slice(
      markerIndex + marker.length,
    );

    const mimeType =
      header
        .replace(/^data:/, "")
        .split(";")[0] ||
      "audio/webm";

    return {
      mimeType,
      buffer: Buffer.from(
        base64,
        "base64",
      ),
    };
  }

  return {
    mimeType: "audio/webm",
    buffer: Buffer.from(
      value,
      "base64",
    ),
  };
}

/*
 * Convert browser audio into mono 16 kHz WAV.
 *
 * This is used only by the legacy NVIDIA transcription
 * endpoint. Gemini Live receives PCM directly in the browser.
 */
async function toWav(
  buffer: Buffer,
  mimeType: string,
) {
  const directory =
    await mkdtemp(
      join(
        tmpdir(),
        "isabella-voice-",
      ),
    );

  const input =
    join(
      directory,
      mimeType.includes("wav")
        ? "input.wav"
        : "input.webm",
    );

  const output =
    join(
      directory,
      "output.wav",
    );

  try {
    await writeFile(
      input,
      buffer,
    );

    if (
      mimeType.includes("wav")
    ) {
      return buffer;
    }

    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        input,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        output,
      ],
      {
        maxBuffer:
          1024 * 1024,
      },
    );

    return await readFile(
      output,
    );
  } finally {
    await rm(
      directory,
      {
        recursive: true,
        force: true,
      },
    );
  }
}

/*
 * --------------------------------------------------------------------------
 * LEGACY NVIDIA SPEECH-TO-TEXT
 * --------------------------------------------------------------------------
 *
 * Kept so existing code will not break.
 * The new Gemini Live VoiceConversation does not call this route.
 */
router.post(
  "/voice/transcribe",
  async (
    req: Request,
    res,
  ) => {
    const key =
      process.env
        .NVIDIA_VOICE_API_KEY;

    if (!key) {
      res.status(503).json({
        error:
          "Isabella voice is not configured yet.",
      });

      return;
    }

    try {
      const {
        mimeType,
        buffer,
      } = decodeAudio(
        req.body?.audio,
      );

      req.log?.info(
        {
          mimeType,
          bytes:
            buffer.length,
        },
        "Isabella voice audio decoded",
      );

      if (
        buffer.length === 0
      ) {
        res.status(400).json({
          error:
            "The microphone recording was empty.",
        });

        return;
      }

      const wav =
        await toWav(
          buffer,
          mimeType,
        );

      const form =
        new FormData();

      form.append(
        "language",
        "en-US",
      );

      form.append(
        "word_time_offsets",
        "false",
      );

      const wavBytes =
        wav.buffer.slice(
          wav.byteOffset,
          wav.byteOffset +
            wav.byteLength,
        ) as ArrayBuffer;

      form.append(
        "file",
        new Blob(
          [wavBytes],
          {
            type: "audio/wav",
          },
        ),
        "isabella-voice.wav",
      );

      const response =
        await fetch(
          asrEndpoint,
          {
            method:
              "POST",
            headers: {
              Authorization:
                `Bearer ${key}`,
            },
            body: form,
          },
        );

      if (!response.ok) {
        const detail =
          await response.text();

        req.log?.error(
          {
            status:
              response.status,
            detail:
              detail.slice(
                0,
                500,
              ),
          },
          "NVIDIA transcription failed",
        );

        res.status(502).json({
          error:
            "Isabella could not hear that clearly.",
        });

        return;
      }

      const data =
        (await response.json()) as {
          text?: string;
          transcript?: string;
          results?: Array<{
            alternatives?: Array<{
              transcript?: string;
            }>;
          }>;
        };

      const text =
        data.text ||
        data.transcript ||
        data.results?.[0]
          ?.alternatives?.[0]
          ?.transcript ||
        "";

      if (
        !text.trim()
      ) {
        res.status(422).json({
          error:
            "I did not catch any words. Please try again.",
        });

        return;
      }

      res.json({
        text:
          text.trim(),
      });
    } catch (error) {
      req.log?.error(
        {
          err: error,
        },
        "Isabella transcription request failed",
      );

      res.status(502).json({
        error:
          "Isabella could not process the microphone audio.",
      });
    }
  },
);

/*
 * --------------------------------------------------------------------------
 * LEGACY NVIDIA TEXT-TO-SPEECH
 * --------------------------------------------------------------------------
 *
 * Kept for compatibility.
 * The new Gemini Live frontend receives streaming audio directly
 * from the Gemini Live session instead of using this route.
 */
router.post(
  "/voice/synthesize",
  async (
    req: Request,
    res,
  ) => {
    const key =
      process.env
        .NVIDIA_VOICE_API_KEY;

    const text =
      typeof req.body?.text ===
      "string"
        ? req.body.text
            .trim()
            .slice(
              0,
              10000,
            )
        : "";

    if (!key) {
      res.status(503).json({
        error:
          "Isabella voice is not configured yet.",
      });

      return;
    }

    if (!text) {
      res.status(400).json({
        error:
          "Text is required.",
      });

      return;
    }

    try {
      const form =
        new FormData();

      form.append(
        "text",
        text,
      );

      form.append(
        "language",
        "en-US",
      );

      form.append(
        "voice",
        "Magpie-Multilingual.EN-US.Aria",
      );

      form.append(
        "encoding",
        "LINEAR_PCM",
      );

      const response =
        await fetch(
          ttsEndpoint,
          {
            method:
              "POST",
            headers: {
              Authorization:
                `Bearer ${key}`,
            },
            body: form,
          },
        );

      if (!response.ok) {
        const detail =
          await response.text();

        req.log?.error(
          {
            status:
              response.status,
            detail:
              detail.slice(
                0,
                500,
              ),
          },
          "NVIDIA synthesis failed",
        );

        res.status(502).json({
          error:
            "Isabella could not speak right now.",
        });

        return;
      }

      const audio =
        Buffer.from(
          await response.arrayBuffer(),
        );

      res.json({
        audioBase64:
          audio.toString(
            "base64",
          ),
        mimeType:
          "audio/wav",
      });
    } catch (error) {
      req.log?.error(
        {
          err: error,
        },
        "Isabella synthesis request failed",
      );

      res.status(502).json({
        error:
          "Isabella could not speak right now.",
      });
    }
  },
);

/*
 * --------------------------------------------------------------------------
 * GEMINI LIVE EPHEMERAL TOKEN
 * --------------------------------------------------------------------------
 *
 * The real Gemini API key NEVER goes into App.tsx.
 *
 * Browser:
 *   POST /api/voice/gemini-token
 *       ↓
 *   receives short-lived token
 *       ↓
 *   connects directly to Gemini Live
 *
 * Google documents this REST shape for auth_tokens:
 *
 * {
 *   "uses": 1,
 *   "expireTime": "...",
 *   "newSessionExpireTime": "..."
 * }
 *
 * We intentionally don't constrain the Live configuration here.
 * The frontend is responsible for its Live session configuration.
 */
router.post(
  "/voice/gemini-token",
  async (
    req: Request,
    res,
  ) => {
    const apiKey =
      process.env.GEMINI_API_KEY;

    if (!apiKey) {
      res.status(503).json({
        error:
          "GEMINI_API_KEY is not configured.",
      });

      return;
    }

    try {
      const now =
        Date.now();

      const expireTime =
        new Date(
          now +
            30 *
              60 *
              1000,
        ).toISOString();

      const newSessionExpireTime =
        new Date(
          now +
            60 *
              1000,
        ).toISOString();

      const response =
        await fetch(
          "https://generativelanguage.googleapis.com/v1beta/auth_tokens",
          {
            method:
              "POST",

            headers: {
              "x-goog-api-key":
                apiKey,

              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify({
                uses: 1,

                expireTime,

                newSessionExpireTime,
              }),
          },
        );

      const data =
        (await response.json()) as GeminiTokenResponse;

      if (!response.ok) {
        req.log?.error(
          {
            status:
              response.status,
            message:
              data.error
                ?.message,
            providerStatus:
              data.error
                ?.status,
          },
          "Gemini Live token creation failed",
        );

        res.status(
          response.status >=
            400 &&
          response.status <
            600
            ? response.status
            : 502,
        ).json({
          error:
            data.error
              ?.message ||
            "Failed to create Gemini Live token.",
        });

        return;
      }

      if (!data.name) {
        req.log?.error(
          {
            response:
              data,
          },
          "Gemini Live token response did not contain a token",
        );

        res.status(502).json({
          error:
            "Gemini did not return a Live token.",
        });

        return;
      }

      req.log?.info(
        {
          expiresAt:
            expireTime,
        },
        "Gemini Live ephemeral token created",
      );

      res.json({
        token:
          data.name,

        expiresAt:
          expireTime,

        newSessionExpiresAt:
          newSessionExpireTime,
      });
    } catch (error) {
      req.log?.error(
        {
          err: error,
        },
        "Gemini Live token request failed",
      );

      res.status(502).json({
        error:
          "Could not start the Gemini Live conversation.",
      });
    }
  },
);

export default router;
import type {
  ToolDefinition,
  ToolResult,
} from "../types.ts";

import {
  config,
  higgsfield,
} from "@higgsfield/client/v2";

const HIGGSFIELD_ENDPOINT =
  "bytedance/seedance-2.0/text-to-video";

let configured = false;

function ensureConfigured() {
  if (configured) {
    return;
  }

  const credentials =
    process.env.HF_CREDENTIALS?.trim();

  if (!credentials) {
    throw new Error(
      "Higgsfield is not configured. Add HF_CREDENTIALS to artifacts/api-server/.env",
    );
  }

  config({
    credentials,
  });

  configured = true;
}

function getString(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed
    ? trimmed
    : undefined;
}

function getNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(
    maximum,
    Math.max(
      minimum,
      Math.round(parsed),
    ),
  );
}

function getBoolean(
  value: unknown,
  fallback: boolean,
): boolean {
  return typeof value === "boolean"
    ? value
    : fallback;
}

export const higgsfieldVideoTool:
  ToolDefinition = {
  name: "higgsfield_video",

  description:
    "Generate an AI video with Higgsfield. Use this tool whenever the user explicitly asks Isabella to create, generate, make, or produce a video.",

  inputSchema: {
    prompt: {
      type: "string",
      description:
        "Detailed description of the requested video.",
    },

    duration: {
      type: "number",
      description:
        "Video duration in seconds.",
    },

    resolution: {
      type: "string",
      description:
        "Video resolution: 480p, 720p, 1080p, or 4k.",
    },

    aspect_ratio: {
      type: "string",
      description:
        "Aspect ratio: 16:9, 4:3, 1:1, 3:4, 9:16, or 21:9.",
    },

    generate_audio: {
      type: "boolean",
      description:
        "Whether to generate audio with the video.",
    },
  },

  async execute(
    arguments_,
    context,
  ): Promise<ToolResult> {
    if (
      context.signal?.aborted
    ) {
      throw new Error(
        "Higgsfield video generation was cancelled.",
      );
    }

    const prompt =
      getString(
        arguments_.prompt,
      );

    if (!prompt) {
      return {
        ok: false,
        content:
          "Higgsfield requires a video prompt.",
      };
    }

    const duration =
      getNumber(
        arguments_.duration,
        5,
        4,
        15,
      );

    const resolution =
      getString(
        arguments_.resolution,
      ) || "720p";

    const allowedResolutions =
      new Set([
        "480p",
        "720p",
        "1080p",
        "4k",
      ]);

    if (
      !allowedResolutions.has(
        resolution,
      )
    ) {
      return {
        ok: false,
        content:
          "Invalid resolution. Use 480p, 720p, 1080p, or 4k.",
      };
    }

    const aspectRatio =
      getString(
        arguments_.aspect_ratio,
      ) || "16:9";

    const allowedAspectRatios =
      new Set([
        "16:9",
        "4:3",
        "1:1",
        "3:4",
        "9:16",
        "21:9",
      ]);

    if (
      !allowedAspectRatios.has(
        aspectRatio,
      )
    ) {
      return {
        ok: false,
        content:
          "Invalid aspect ratio. Use 16:9, 4:3, 1:1, 3:4, 9:16, or 21:9.",
      };
    }

    const generateAudio =
      getBoolean(
        arguments_.generate_audio,
        true,
      );

    try {
      ensureConfigured();

      const response =
        await higgsfield.subscribe(
          HIGGSFIELD_ENDPOINT,
          {
            input: {
              prompt,
              duration,
              resolution,
              aspect_ratio:
                aspectRatio,
              generate_audio:
                generateAudio,
            },

            withPolling: true,
          },
        );

      if (
        context.signal?.aborted
      ) {
        throw new Error(
          "Higgsfield video generation was cancelled.",
        );
      }

      if (
        response.status !==
        "completed"
      ) {
        return {
          ok: false,

          content:
            `Higgsfield video generation ended with status: ${response.status}`,

          metadata: {
            provider:
              "higgsfield",
            endpoint:
              HIGGSFIELD_ENDPOINT,
            requestId:
              response.request_id,
            status:
              response.status,
          },
        };
      }

      const videoUrl =
        response.video?.url;

      if (!videoUrl) {
        return {
          ok: false,

          content:
            "Higgsfield completed the generation but returned no video URL.",

          metadata: {
            provider:
              "higgsfield",
            endpoint:
              HIGGSFIELD_ENDPOINT,
            requestId:
              response.request_id,
          },
        };
      }

      return {
        ok: true,

        content:
          `Higgsfield generated the video successfully.\nVideo URL: ${videoUrl}`,

        videoUrl,

        metadata: {
          provider:
            "higgsfield",
          endpoint:
            HIGGSFIELD_ENDPOINT,
          requestId:
            response.request_id,
          status:
            response.status,
          duration,
          resolution,
          aspectRatio,
          generateAudio,
        },
      };
    } catch (error) {
      return {
        ok: false,

        content:
          error instanceof Error
            ? `Higgsfield video generation failed: ${error.message}`
            : "Higgsfield video generation failed.",
      };
    }
  },
};
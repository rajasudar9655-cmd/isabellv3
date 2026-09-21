import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";

const router: IRouter = Router();

const GEMINI_AUTH_TOKEN_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/auth_tokens";

const GEMINI_LIVE_MODEL =
  "models/gemini-3.8-live";

router.post(
  "/voice/gemini-token",
  async (
    req: Request,
    res: Response,
  ) => {
    const apiKey =
      process.env.GEMINI_API_KEY;

    if (!apiKey) {
      res.status(503).json({
        error:
          "Gemini Live is not configured yet.",
      });

      return;
    }

    try {
      /*
       * Create a short-lived token specifically
       * for one Gemini Live session.
       */
      const expireTime =
        new Date(
          Date.now() +
            30 * 60 * 1000,
        ).toISOString();

      const newSessionExpireTime =
        new Date(
          Date.now() +
            60 * 1000,
        ).toISOString();

      const response =
        await fetch(
          GEMINI_AUTH_TOKEN_ENDPOINT,
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json",
              "x-goog-api-key":
                apiKey,
            },
            body: JSON.stringify({
              uses: 1,
              expireTime,
              newSessionExpireTime,
              liveConnectConstraints:
                {
                  model:
                    GEMINI_LIVE_MODEL,
                  config: {
                    responseModalities: [
                      "AUDIO",
                    ],

                    inputAudioTranscription:
                      {},

                    outputAudioTranscription:
                      {},

                    sessionResumption:
                      {},
                  },
                },
            }),
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
                1000,
              ),
          },
          "Gemini ephemeral token creation failed",
        );

        res.status(502).json({
          error:
            "Gemini Live token could not be created.",
        });

        return;
      }

      const data =
        (await response.json()) as {
          name?: string;
        };

      if (!data.name) {
        res.status(502).json({
          error:
            "Gemini did not return a Live token.",
        });

        return;
      }

      res.json({
        token: data.name,
        model:
          GEMINI_LIVE_MODEL,
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
          "Gemini Live could not be initialized.",
      });
    }
  },
);

export default router;
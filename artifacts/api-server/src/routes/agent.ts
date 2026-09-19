import { Router, type IRouter, type Request, type Response } from "express";
import { AgentController } from "../agent/controller.ts";
import { createModelProvider } from "../agent/model.ts";
import type { AgentRequest, ChatMessage } from "../agent/types.ts";

const router: IRouter = Router();

function normaliseRequest(body: any): AgentRequest {
  const messages: ChatMessage[] = Array.isArray(body?.messages)
    ? body.messages
        .filter(
          (item: any) =>
            (item?.role === "user" || item?.role === "assistant") &&
            typeof item?.content === "string",
        )
        .slice(-20)
        .map((item: any) => ({
          role: item.role,
          content: item.content.slice(0, 12000),
        }))
    : [];

  const files = Array.isArray(body?.files)
    ? body.files
        .filter(
          (file: any) =>
            file &&
            typeof file.id === "string" &&
            typeof file.name === "string" &&
            typeof file.text === "string",
        )
        .slice(0, 8)
        .map((file: any) => ({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          text: file.text.slice(0, 30000),
        }))
    : [];

  const memory = Array.isArray(body?.memory)
    ? body.memory
        .filter(
          (item: any) =>
            item &&
            typeof item.key === "string" &&
            typeof item.value === "string",
        )
        .slice(0, 30)
    : [];

  return {
    messages,
    mode:
      typeof body?.mode === "string"
        ? body.mode.slice(0, 30)
        : undefined,

    plugins: Array.isArray(body?.plugins)
      ? body.plugins
          .filter((value: any) => typeof value === "string")
          .slice(0, 20)
      : [],

    files,
    memory,

    preferences:
      body?.preferences && typeof body.preferences === "object"
        ? {
            name:
              typeof body.preferences.name === "string"
                ? body.preferences.name.slice(0, 120)
                : undefined,

            warm:
              typeof body.preferences.warm === "boolean"
                ? body.preferences.warm
                : undefined,

            concise:
              typeof body.preferences.concise === "boolean"
                ? body.preferences.concise
                : undefined,

            web:
              typeof body.preferences.web === "boolean"
                ? body.preferences.web
                : undefined,
          }
        : undefined,

    maxSteps:
      Number.isInteger(body?.maxSteps)
        ? Math.min(12, Math.max(1, body.maxSteps))
        : 8,
  };
}

function sendEvent(res: Response, payload: unknown) {
  // Don't attempt to write after the response has already ended/died.
  if (res.writableEnded || res.destroyed) {
    return;
  }

  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function runAgent(
  request: AgentRequest,
  onEvent?: (event: any) => void,
) {
  const controller = new AgentController(createModelProvider());

  return controller.run(request, onEvent);
}

router.post("/agent/chat", async (req: Request, res: Response) => {
  const request = normaliseRequest(req.body);

  if (!request.messages.some((message) => message.role === "user")) {
    res.status(400).json({
      error: "A user message is required.",
    });
    return;
  }

  try {
    const result = await runAgent(request);

    res.json(result);
  } catch (error) {
    req.log?.error(
      { err: error },
      "Agent request failed",
    );

    res.status(502).json({
      error:
        error instanceof Error
          ? error.message
          : "Isabella could not complete that request right now.",
    });
  }
});

router.post("/agent/stream", async (req: Request, res: Response) => {
  const request = normaliseRequest(req.body);

  if (!request.messages.some((message) => message.role === "user")) {
    res.status(400).json({
      error: "A user message is required.",
    });
    return;
  }

  // SSE response configuration.
  res.status(200);
  res.setHeader(
    "Content-Type",
    "text/event-stream; charset=utf-8",
  );
  res.setHeader(
    "Cache-Control",
    "no-cache, no-transform",
  );
  res.setHeader(
    "Connection",
    "keep-alive",
  );

  res.flushHeaders?.();

  try {
    const controller = new AgentController(
      createModelProvider(),
    );

    const result = await controller.run(
      request,
      (event) => {
        sendEvent(res, event);
      },
    );

    sendEvent(res, {
      type: "done",
      result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Isabella could not complete that request right now.";

    req.log?.error(
      { err: error },
      "Agent stream failed",
    );

    sendEvent(res, {
      type: "error",
      message,
      timestamp: new Date().toISOString(),
    });
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
});

export default router;
import { Router, type IRouter, type Request } from "express";
import { AgentController } from "../agent/controller.ts";
import { createModelProvider } from "../agent/model.ts";
import type { AgentRequest, ChatMessage } from "../agent/types.ts";

const router: IRouter = Router();

/**
 * Backwards-compatible endpoint for older clients. New clients should use /api/agent/stream.
 * It now runs through the same real agent controller instead of a separate one-shot model path.
 */
router.post("/openai/chat", async (req: Request, res) => {
  const messages: ChatMessage[] = Array.isArray(req.body?.messages)
    ? req.body.messages
        .filter((item: any) => (item?.role === "user" || item?.role === "assistant") && typeof item?.content === "string")
        .slice(-20)
        .map((item: any) => ({ role: item.role, content: item.content.slice(0, 12000) }))
    : [];

  if (!messages.some((message) => message.role === "user")) {
    res.status(400).json({ error: "A user message is required." });
    return;
  }

  const request: AgentRequest = {
    messages,
    mode: typeof req.body?.mode === "string" ? req.body.mode : undefined,
    plugins: Array.isArray(req.body?.plugins) ? req.body.plugins.filter((value: any) => typeof value === "string") : [],
    files: Array.isArray(req.body?.files) ? req.body.files.filter((file: any) => file && typeof file.id === "string" && typeof file.name === "string" && typeof file.text === "string").map((file: any) => ({ id: file.id, name: file.name, mimeType: file.mimeType, text: file.text.slice(0, 30000) })) : [],
    memory: Array.isArray(req.body?.memory) ? req.body.memory.filter((item: any) => item && typeof item.key === "string" && typeof item.value === "string").slice(0, 30) : [],
    preferences: req.body?.preferences,
  };

  try {
    const controller = new AgentController(createModelProvider());
    const result = await controller.run(request);
    res.json(result);
  } catch (error) {
    req.log?.error({ err: error }, "Compatibility agent request failed");
    res.status(502).json({ error: error instanceof Error ? error.message : "Isabella could not complete that request right now." });
  }
});

export default router;

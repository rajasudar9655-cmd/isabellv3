import { Router, type IRouter, type Request } from "express";
import multer from "multer";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ];
    cb(null, allowed.includes(file.mimetype));
  },
});

async function extractText(buffer: Buffer, mimeType: string): Promise<{ text: string; canAnalyze: boolean }> {
  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    return { text: buffer.toString("utf-8").slice(0, 50000), canAnalyze: true };
  }
  if (mimeType === "application/pdf") {
    try {
      const pdfParse = await import("pdf-parse");
      const data = await (pdfParse as any)(buffer);
      return { text: data.text.slice(0, 50000), canAnalyze: true };
    } catch {
      return { text: "[PDF content could not be extracted]", canAnalyze: false };
    }
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return { text: result.value.slice(0, 50000), canAnalyze: true };
    } catch {
      return { text: "[DOCX content could not be extracted]", canAnalyze: false };
    }
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheets = workbook.SheetNames.map((name) => {
        const sheet = workbook.Sheets[name];
        return XLSX.utils.sheet_to_csv(sheet);
      }).join("\n---\n");
      return { text: sheets.slice(0, 50000), canAnalyze: true };
    } catch {
      return { text: "[XLSX content could not be extracted]", canAnalyze: false };
    }
  }
  if (mimeType.startsWith("image/")) {
    return { text: `[Image file: ${mimeType}, ${buffer.length} bytes]`, canAnalyze: false };
  }
  return { text: `[Unsupported file type: ${mimeType}]`, canAnalyze: false };
}

router.post("/files/upload", upload.single("file"), async (req: Request, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file uploaded." });
    return;
  }

  try {
    const { text, canAnalyze } = await extractText(file.buffer, file.mimetype);
    const fileId = `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    res.json({
      id: fileId,
      name: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      text: text.slice(0, 10000),
      fullText: text,
      canAnalyze,
    });
  } catch (error) {
    req.log?.error({ err: error }, "File processing failed");
    res.status(500).json({ error: "Failed to process file." });
  }
});

router.post("/files/analyze", async (req: Request, res) => {
  const { fileId, fileText, question, mode, history } = req.body;
  if (!fileText || !question) {
    res.status(400).json({ error: "fileText and question are required." });
    return;
  }

  try {
    const { AgentController } = await import("../agent/controller.ts");
    const { createModelProvider } = await import("../agent/model.ts");
    const controller = new AgentController(createModelProvider());
    const result = await controller.run({
      mode: typeof mode === "string" ? mode.slice(0, 30) : "Ask",
      messages: [
        ...(Array.isArray(history) ? history.filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string").slice(-10).map((m: any) => ({ role: m.role, content: m.content.slice(0, 12000) })) : []),
        { role: "user", content: question.slice(0, 12000) },
      ],
      plugins: ["file-analyzer"],
      files: [{ id: typeof fileId === "string" ? fileId : "uploaded-file", name: "Uploaded file", text: String(fileText).slice(0, 30000) }],
      maxSteps: 6,
    });
    res.json({ text: result.text, fileId, steps: result.steps });
  } catch (error) {
    req.log?.error({ err: error }, "Agent file analysis failed");
    res.status(502).json({ error: error instanceof Error ? error.message : "Isabella could not analyze the file right now." });
  }
});

export default router;

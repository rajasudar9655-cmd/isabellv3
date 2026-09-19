import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router, type IRouter, type Request } from "express";

const execFileAsync = promisify(execFile);
const router: IRouter = Router();
const asrEndpoint = "https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com/v1/audio/transcriptions";
const ttsEndpoint = "https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1/audio/synthesize";

function decodeAudio(value: unknown) {
  if (typeof value !== "string") throw new Error("Audio is required.");
  const match = value.match(/^data:([^;]+);base64,(.+)$/);
  const base64 = match?.[2] ?? value;
  return { mimeType: match?.[1] ?? "audio/webm", buffer: Buffer.from(base64, "base64") };
}

async function toWav(buffer: Buffer, mimeType: string) {
  const directory = await mkdtemp(join(tmpdir(), "isabella-voice-"));
  const input = join(directory, mimeType.includes("wav") ? "input.wav" : "input.webm");
  const output = join(directory, "output.wav");
  try {
    await writeFile(input, buffer);
    if (mimeType.includes("wav")) return buffer;
    await execFileAsync("ffmpeg", ["-y", "-i", input, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output], { maxBuffer: 1024 * 1024 });
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

router.post("/voice/transcribe", async (req: Request, res) => {
  const key = process.env.NVIDIA_VOICE_API_KEY;
  if (!key) {
    res.status(503).json({ error: "Isabella voice is not configured yet." });
    return;
  }

  try {
    const { mimeType, buffer } = decodeAudio(req.body?.audio);
    const wav = await toWav(buffer, mimeType);
    const form = new FormData();
    form.append("language", "en-US");
    form.append("word_time_offsets", "false");
    const wavBytes = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
    form.append("file", new Blob([wavBytes], { type: "audio/wav" }), "isabella-voice.wav");

    const response = await fetch(asrEndpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!response.ok) {
      const detail = await response.text();
      req.log?.error({ status: response.status, detail: detail.slice(0, 500) }, "NVIDIA transcription failed");
      res.status(502).json({ error: "Isabella could not hear that clearly." });
      return;
    }

    const data = await response.json() as {
      text?: string;
      transcript?: string;
      results?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
    };
    const text = data.text || data.transcript || data.results?.[0]?.alternatives?.[0]?.transcript || "";
    if (!text.trim()) {
      res.status(422).json({ error: "I did not catch any words. Please try again." });
      return;
    }
    res.json({ text: text.trim() });
  } catch (error) {
    req.log?.error({ err: error }, "Isabella transcription request failed");
    res.status(502).json({ error: "Isabella could not process the microphone audio." });
  }
});

router.post("/voice/synthesize", async (req: Request, res) => {
  const key = process.env.NVIDIA_VOICE_API_KEY;
  const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 10000) : "";
  if (!key) {
    res.status(503).json({ error: "Isabella voice is not configured yet." });
    return;
  }
  if (!text) {
    res.status(400).json({ error: "Text is required." });
    return;
  }

  try {
    const form = new FormData();
    form.append("text", text);
    form.append("language", "en-US");
    form.append("voice", "Magpie-Multilingual.EN-US.Aria");
    form.append("encoding", "LINEAR_PCM");
    const response = await fetch(ttsEndpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!response.ok) {
      const detail = await response.text();
      req.log?.error({ status: response.status, detail: detail.slice(0, 500) }, "NVIDIA synthesis failed");
      res.status(502).json({ error: "Isabella could not speak right now." });
      return;
    }
    const audio = Buffer.from(await response.arrayBuffer());
    res.json({ audioBase64: audio.toString("base64"), mimeType: "audio/wav" });
  } catch (error) {
    req.log?.error({ err: error }, "Isabella synthesis request failed");
    res.status(502).json({ error: "Isabella could not speak right now." });
  }
});

export default router;
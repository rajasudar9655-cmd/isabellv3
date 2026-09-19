import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
if (!process.env.OPENAI_API_KEY && !process.env.LLM_API_KEY && !process.env.NVIDIA_VOICE_API_KEY) {
  config({ path: join(__dirname, "..", ".env") });
}

import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"] || "5000";

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

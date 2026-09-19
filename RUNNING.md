# Running Isabella

## Windows development

1. Install Node.js 22+ and pnpm.
2. From the repository root, run `pnpm install`.
3. Copy `artifacts/api-server/.env.example` to `artifacts/api-server/.env`.
4. Choose a model provider.

### Local OpenAI-compatible model (no API key)

Set values like:

```text
LLM_BASE_URL=http://127.0.0.1:1234/v1
LLM_MODEL=your-local-model-name
LLM_API_KEY=
```

The agent layer does not require a key for loopback endpoints.

### Hosted provider

Put the real provider credential in `OPENAI_API_KEY` or `LLM_API_KEY` inside the ignored local `.env`. Never commit it.

5. Run `pnpm run build`. The root build checks and builds the production API + Isabella app; the optional mockup sandbox is not part of the production build.
6. Run `pnpm run dev`.

The web app uses port 5173 and the API uses port 5000 in the default development configuration.

## Agent smoke tests

Run `pnpm test:agent` to exercise the safe calculator, private-network web protection, and multi-step agent loop with a scripted fake model. These tests do not contact an external model provider.

## Voice

Voice still requires `NVIDIA_VOICE_API_KEY` and a working `ffmpeg` executable on PATH.

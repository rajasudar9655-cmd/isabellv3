# Isabella AI

Isabella is a calm, local-first AI workspace for chatting, public-source research, planning, creating, and keeping personal notes.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/isabella-ai/src/App.tsx` — Isabella routes, local answer engine, public Wikipedia search, chat persistence, and interaction state.
- `artifacts/isabella-ai/src/index.css` — soft lavender, blush, cream, and gold visual system matching the supplied reference.
- `artifacts/api-server/src/routes/voice.ts` — secure microphone transcription and female voice synthesis endpoints for live conversation.
- `artifacts/isabella-ai/public/reference/isabella-reference.png` — supplied visual reference.

## Architecture decisions

- The first release is local-first: conversations, notes, and preferences persist in browser localStorage.
- Research uses public Wikipedia search directly from the browser and labels source links instead of pretending local responses are live facts.
- The app intentionally avoids a user-managed model/API key; the local answer engine handles lightweight prompts and routes time-sensitive prompts to research.
- Live voice is an explicit push-to-talk flow: long-press the composer microphone, transcribe server-side, answer through Isabella's agent route, then synthesize the response server-side.

## Product

The main chat surface mirrors the supplied Isabella reference with an airy orb, shortcut actions, mode chips, and a warm glass-like shell. Discover provides public-source lookups, Tools provides guided prompts, Library stores saved conversations and notes, and Settings controls tone/research preferences.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

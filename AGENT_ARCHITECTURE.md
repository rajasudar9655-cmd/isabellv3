# Isabella Agent Architecture

Isabella now uses a model-independent agent controller. The model proposes one structured action at a time; the server validates and executes the requested tool, feeds the result back to the model, and repeats until the task is complete or a safe step limit is reached.

## Runtime loop

`user goal -> model action -> tool validation -> tool execution -> observation -> model action -> final answer`

## Built-in tools

- `time`: current time for a named place or IANA timezone.
- `calculator`: safe arithmetic parser; no `eval` or arbitrary shell execution.
- `web_search`: public search through DuckDuckGo and Wikipedia.
- `web_fetch`: readable text extraction from public HTTP/HTTPS pages with private-network blocking and redirect checks.
- `file_list`, `file_read`, `file_search`: operate on files attached to the current request.

## Provider abstraction

Set `LLM_BASE_URL`, `LLM_MODEL`, and optionally `LLM_API_KEY` to use an OpenAI-compatible service. A hosted NVIDIA/OpenAI setup still works through the backwards-compatible variables. A local OpenAI-compatible runtime can be used later without changing the agent or tool layer.

## Safety

No arbitrary terminal/shell tool is exposed. Web fetch rejects localhost and common private-network address ranges, limits redirects, and limits page size. Agent steps are capped at 12 (the UI requests 8). High-impact desktop actions such as delete/push/send are intentionally not exposed as autonomous tools.

## UI

The chat client uses `/api/agent/stream` and renders the actual agent events instead of a fake fixed delay. Long-term memory is intentionally small and client-local; the model may return durable non-sensitive memory writes which the browser stores.

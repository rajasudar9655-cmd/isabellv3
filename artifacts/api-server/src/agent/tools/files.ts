import type { ToolDefinition, ToolResult } from "../types";

export const fileListTool: ToolDefinition = {
  name: "file_list",
  description: "List files uploaded in the current conversation.",
  inputSchema: {},
  async execute(_arguments_, context): Promise<ToolResult> {
    if (!context.files.length) return { ok: true, content: "No files are attached to this conversation." };
    return { ok: true, content: context.files.map((file, i) => `${i + 1}. ${file.name} (${file.mimeType || "unknown type"}) — id ${file.id}`).join("\n") };
  },
};

export const fileReadTool: ToolDefinition = {
  name: "file_read",
  description: "Read the extracted text of an uploaded file by id or filename.",
  inputSchema: { file: { type: "string", description: "File id or exact filename" }, maxChars: { type: "number", description: "Maximum text to return" } },
  async execute(arguments_, context): Promise<ToolResult> {
    const selector = typeof arguments_.file === "string" ? arguments_.file.trim() : "";
    const file = context.files.find((item) => item.id === selector || item.name === selector);
    if (!file) return { ok: false, content: `I could not find the uploaded file "${selector}".` };
    const maxChars = Math.min(20000, Math.max(1000, Number(arguments_.maxChars) || 12000));
    return { ok: true, content: `File: ${file.name}\n${file.text.slice(0, maxChars)}`, metadata: { fileId: file.id, fileName: file.name } };
  },
};

export const fileSearchTool: ToolDefinition = {
  name: "file_search",
  description: "Search extracted text across uploaded files for a keyword or phrase.",
  inputSchema: { query: { type: "string", description: "Phrase to find in uploaded files" } },
  async execute(arguments_, context): Promise<ToolResult> {
    const query = typeof arguments_.query === "string" ? arguments_.query.trim().toLowerCase() : "";
    if (!query) return { ok: false, content: "file_search requires a query." };
    const results: string[] = [];
    for (const file of context.files) {
      const lower = file.text.toLowerCase();
      let from = 0;
      let count = 0;
      while (count < 6) {
        const index = lower.indexOf(query, from);
        if (index < 0) break;
        results.push(`${file.name}: ...${file.text.slice(Math.max(0, index - 160), Math.min(file.text.length, index + query.length + 240))}...`);
        from = index + query.length;
        count += 1;
      }
    }
    return results.length ? { ok: true, content: results.join("\n\n") } : { ok: true, content: `No match for "${query}" was found in the uploaded files.` };
  },
};

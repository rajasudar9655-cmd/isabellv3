import type { ToolDefinition, ToolResult } from "../types";

const commonZones: Record<string, string> = {
  india: "Asia/Kolkata",
  ist: "Asia/Kolkata",
  tokyo: "Asia/Tokyo",
  london: "Europe/London",
  "new york": "America/New_York",
  "los angeles": "America/Los_Angeles",
  sydney: "Australia/Sydney",
  singapore: "Asia/Singapore",
  dubai: "Asia/Dubai",
  utc: "UTC",
};

function resolveTimezone(value: unknown): string {
  const requested = typeof value === "string" ? value.trim() : "";
  return commonZones[requested.toLowerCase()] || requested || "UTC";
}

export const timeTool: ToolDefinition = {
  name: "time",
  description: "Get the current local date/time for a named place or IANA timezone.",
  inputSchema: { timezone: { type: "string", description: "Place name such as Tokyo or IANA timezone such as Asia/Tokyo" } },
  async execute(arguments_): Promise<ToolResult> {
    const timezone = resolveTimezone(arguments_.timezone);
    try {
      const now = new Date();
      const formatted = new Intl.DateTimeFormat("en-IN", {
        timeZone: timezone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(now);
      return { ok: true, content: `Current time in ${timezone}: ${formatted}`, metadata: { timezone, iso: now.toISOString() } };
    } catch {
      return { ok: false, content: `I do not recognize the timezone "${timezone}". Use a city such as Tokyo or an IANA timezone such as Asia/Tokyo.` };
    }
  },
};

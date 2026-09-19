import assert from "node:assert/strict";
import test from "node:test";
import { AgentController } from "../artifacts/api-server/src/agent/controller.ts";
import { calculate } from "../artifacts/api-server/src/agent/tools/calculator.ts";
import { assertPublicUrl } from "../artifacts/api-server/src/agent/tools/web.ts";
import type { ChatMessage, ModelProvider } from "../artifacts/api-server/src/agent/types.ts";

test("calculator handles safe arithmetic", () => {
  assert.equal(calculate("(18 * 4) / 3"), 24);
  assert.equal(calculate("2 ** 3 + 4"), 12);
  assert.equal(calculate("-5 + 2"), -3);
  assert.throws(() => calculate("1/0"));
  assert.throws(() => calculate("process.exit()"));
});

test("agent loops from tool call to final answer", async () => {
  const scripted = [
    JSON.stringify({ type: "tool_call", tool: "calculator", arguments: { expression: "18 * 4" }, reason: "Calculate the requested value." }),
    JSON.stringify({ type: "final", answer: "The result is 72." }),
  ];
  const calls: ChatMessage[][] = [];
  const model: ModelProvider = { async complete(messages) { calls.push(messages); return scripted.shift()!; } };
  const agent = new AgentController(model);
  const result = await agent.run({ messages: [{ role: "user", content: "Calculate 18 * 4." }], plugins: ["calculator"], maxSteps: 4 });
  assert.equal(result.text, "The result is 72.");
  assert.equal(result.steps.filter((step) => step.type === "tool_call").length, 1);
  assert.ok(calls.some((messages) => messages.some((message) => message.content.includes("TOOL RESULT (calculator)"))));
});


test("web tool blocks local/private addresses", () => {
  assertPublicUrl("https://example.com/");
  assert.throws(() => assertPublicUrl("http://127.0.0.1:5000/"));
  assert.throws(() => assertPublicUrl("http://192.168.1.1/"));
  assert.throws(() => assertPublicUrl("file:///C:/secret.txt"));
});

test("agent can complete a multi-tool time and math workflow", async () => {
  const scripted = [
    JSON.stringify({ type: "tool_call", tool: "time", arguments: { timezone: "Tokyo" }, reason: "Get Tokyo time." }),
    JSON.stringify({ type: "tool_call", tool: "calculator", arguments: { expression: "9 + 5.5" }, reason: "Calculate the final difference." }),
    JSON.stringify({ type: "final", answer: "Tokyo time checked and the arithmetic result is 14.5." }),
  ];
  const model: ModelProvider = { async complete() { return scripted.shift()!; } };
  const agent = new AgentController(model);
  const result = await agent.run({ messages: [{ role: "user", content: "Check Tokyo time and calculate 9 + 5.5." }], plugins: ["calculator"], maxSteps: 6 });
  assert.equal(result.steps.filter((step) => step.type === "tool_call").length, 2);
  assert.equal(result.text, "Tokyo time checked and the arithmetic result is 14.5.");
});

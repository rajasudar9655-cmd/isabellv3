import assert from "node:assert/strict";
import test from "node:test";

import { AgentController } from "../artifacts/api-server/src/agent/controller.ts";
import { calculate } from "../artifacts/api-server/src/agent/tools/calculator.ts";
import { assertPublicUrl } from "../artifacts/api-server/src/agent/tools/web.ts";
import type {
  ChatMessage,
  ModelProvider,
} from "../artifacts/api-server/src/agent/types.ts";

test("calculator handles safe arithmetic", () => {
  assert.equal(calculate("(18 * 4) / 3"), 24);
  assert.equal(calculate("2 ** 3 + 4"), 12);
  assert.equal(calculate("-5 + 2"), -3);
  assert.throws(() => calculate("1/0"));
  assert.throws(() => calculate("process.exit()"));
});

test("agent loops from tool call to final answer", async () => {
  const scripted = [
    JSON.stringify({
      type: "tool_call",
      tool: "calculator",
      arguments: { expression: "18 * 4" },
      reason: "Calculate the requested value.",
    }),
    JSON.stringify({ type: "final", answer: "The result is 72." }),
  ];

  const calls: ChatMessage[][] = [];

  const model: ModelProvider = {
    async complete(messages) {
      calls.push(messages);
      return scripted.shift()!;
    },
  };

  const agent = new AgentController(model);

  const result = await agent.run({
    messages: [{ role: "user", content: "Calculate 18 * 4." }],
    plugins: ["calculator"],
    maxSteps: 4,
  });

  assert.equal(result.text, "The result is 72.");

  assert.equal(
    result.steps.filter((step) => step.type === "tool_call").length,
    1,
  );

  assert.ok(
    calls.some((messages) =>
      messages.some((message) =>
        message.content.includes("TOOL RESULT (calculator)"),
      ),
    ),
  );
});

test("web tool blocks local/private addresses", () => {
  assertPublicUrl("https://example.com/");
  assert.throws(() => assertPublicUrl("http://127.0.0.1:5000/"));
  assert.throws(() => assertPublicUrl("http://192.168.1.1/"));
  assert.throws(() => assertPublicUrl("file:///C:/secret.txt"));
});

test("agent can complete a multi-tool time and math workflow", async () => {
  const scripted = [
    JSON.stringify({
      type: "tool_call",
      tool: "time",
      arguments: { timezone: "Tokyo" },
      reason: "Get Tokyo time.",
    }),
    JSON.stringify({
      type: "tool_call",
      tool: "calculator",
      arguments: { expression: "9 + 5.5" },
      reason: "Calculate the final difference.",
    }),
    JSON.stringify({
      type: "final",
      answer: "Tokyo time checked and the arithmetic result is 14.5.",
    }),
  ];

  const model: ModelProvider = {
    async complete() {
      return scripted.shift()!;
    },
  };

  const agent = new AgentController(model);

  const result = await agent.run({
    messages: [
      {
        role: "user",
        content: "Check Tokyo time and calculate 9 + 5.5.",
      },
    ],
    plugins: ["calculator"],
    maxSteps: 6,
  });

  assert.equal(
    result.steps.filter((step) => step.type === "tool_call").length,
    2,
  );

  assert.equal(
    result.text,
    "Tokyo time checked and the arithmetic result is 14.5.",
  );
});

function githubJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function githubFile(
  path: string,
  content: string,
  size = content.length,
): Record<string, unknown> {
  return {
    type: "file",
    path,
    name: path.split("/").pop(),
    size,
    sha: `sha-${path.replace(/[^a-z0-9]+/gi, "-")}`,
    html_url: `https://github.com/owner/repo/blob/main/${path}`,
    content: Buffer.from(content, "utf8").toString("base64"),
    encoding: "base64",
  };
}

function githubDir(path: string): Record<string, unknown> {
  return {
    type: "dir",
    path,
    name: path.split("/").pop(),
    html_url: `https://github.com/owner/repo/tree/main/${path}`,
  };
}

function installGitHubMockFetch(): () => void {
  const originalFetch = globalThis.fetch;

  const files: Record<string, string> = {
    "README.md": "# isabellv3",

    "package.json": `{
  "name": "workspace",
  "private": true,
  "scripts": {
    "dev": "concurrently API WEB",
    "build": "pnpm run typecheck",
    "test:agent": "node --experimental-strip-types --test scripts/agent-smoke.test.ts"
  }
}`,

    "AGENT_ARCHITECTURE.md": `
# Agent Architecture

The project uses a model-independent agent controller.

Runtime flow:
user goal -> model action -> tool validation -> tool execution -> observation -> model action -> final answer.

The server executes validated tools and does not expose arbitrary shell commands.
`,

    "RUNNING.md": `
# Running

Install Node.js and pnpm.
Use pnpm install.
Run pnpm dev to start the API and frontend.
`,

    "artifacts/api-server/package.json": `{
  "name": "@workspace/api-server",
  "type": "module",
  "scripts": {
    "dev": "node ./dist/index.mjs",
    "build": "node ./build.mjs",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}`,

    "artifacts/api-server/src/index.ts": `
import express from "express";
import { AgentController } from "./agent/controller.ts";
`,

    "artifacts/api-server/src/agent/controller.ts": `
export class AgentController {
  async run() {
    // validates actions, executes tools, and returns final responses
  }
}
CONTROLLER_EVIDENCE
`,

    "artifacts/api-server/src/agent/model.ts": `
export interface ModelProvider {
  complete(): Promise<string>;
}
MODEL_EVIDENCE
`,

    "artifacts/api-server/src/agent/types.ts": `
export type ToolResult = {
  ok: boolean;
  content: string;
};
TYPES_EVIDENCE
`,

    "artifacts/api-server/src/agent/tools/calculator.ts": `
export function calculate(expression: string) {
  return expression;
}
`,

    "artifacts/api-server/src/agent/tools/github.ts": `
export const githubTool = {
  name: "github"
};
GITHUB_TOOL_EVIDENCE
`,

    "artifacts/isabella-ai/src/App.tsx": `
export default function App() {
  return <div>Isabella</div>;
}
APP_EVIDENCE
`,

    "scripts/agent-smoke.test.ts": `
import test from "node:test";
TEST_EVIDENCE
`,

    "lib/api-spec/openapi.yaml": `
openapi: 3.0.0
info:
  title: Isabella API
`,
  };

  const directories: Record<string, Record<string, unknown>[]> = {
    "": [
      githubFile("README.md", files["README.md"], 11),
      githubFile("package.json", files["package.json"]),
      githubFile("AGENT_ARCHITECTURE.md", files["AGENT_ARCHITECTURE.md"]),
      githubFile("RUNNING.md", files["RUNNING.md"]),
      githubFile("pnpm-lock.yaml", "LOCKFILE_EVIDENCE", 500000),
      githubFile("logo.svg", "<svg>SVG_EVIDENCE</svg>", 900),
      githubDir("node_modules"),
      githubDir("dist"),
      githubDir("artifacts"),
      githubDir("scripts"),
      githubDir("lib"),
    ],

    artifacts: [
      githubDir("artifacts/api-server"),
      githubDir("artifacts/isabella-ai"),
    ],

    "artifacts/api-server": [
      githubFile(
        "artifacts/api-server/package.json",
        files["artifacts/api-server/package.json"],
      ),
      githubDir("artifacts/api-server/src"),
    ],

    "artifacts/api-server/src": [
      githubFile(
        "artifacts/api-server/src/index.ts",
        files["artifacts/api-server/src/index.ts"],
      ),
      githubDir("artifacts/api-server/src/agent"),
    ],

    "artifacts/api-server/src/agent": [
      githubFile(
        "artifacts/api-server/src/agent/controller.ts",
        files["artifacts/api-server/src/agent/controller.ts"],
      ),
      githubFile(
        "artifacts/api-server/src/agent/model.ts",
        files["artifacts/api-server/src/agent/model.ts"],
      ),
      githubFile(
        "artifacts/api-server/src/agent/types.ts",
        files["artifacts/api-server/src/agent/types.ts"],
      ),
      githubDir("artifacts/api-server/src/agent/tools"),
    ],

    "artifacts/api-server/src/agent/tools": [
      githubFile(
        "artifacts/api-server/src/agent/tools/calculator.ts",
        files["artifacts/api-server/src/agent/tools/calculator.ts"],
      ),
      githubFile(
        "artifacts/api-server/src/agent/tools/github.ts",
        files["artifacts/api-server/src/agent/tools/github.ts"],
      ),
    ],

    "artifacts/isabella-ai": [
      githubDir("artifacts/isabella-ai/src"),
      githubFile(
        "artifacts/isabella-ai/package.json",
        `{"name":"@workspace/isabella-ai"}`,
      ),
    ],

    "artifacts/isabella-ai/src": [
      githubFile(
        "artifacts/isabella-ai/src/App.tsx",
        files["artifacts/isabella-ai/src/App.tsx"],
      ),
    ],

    scripts: [
      githubFile(
        "scripts/agent-smoke.test.ts",
        files["scripts/agent-smoke.test.ts"],
      ),
    ],

    lib: [githubDir("lib/api-spec")],

    "lib/api-spec": [
      githubFile(
        "lib/api-spec/openapi.yaml",
        files["lib/api-spec/openapi.yaml"],
      ),
    ],

    node_modules: [
      githubFile("node_modules/big.js", "NODE_MODULES_EVIDENCE"),
    ],

    dist: [
      githubFile("dist/index.mjs", "DIST_EVIDENCE"),
    ],
  };

  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/repos/owner/repo") {
      return githubJsonResponse({
        full_name: "owner/repo",
        name: "repo",
        default_branch: "main",
        language: "TypeScript",
        description: "Test Isabella repository",
        html_url: "https://github.com/owner/repo",
      });
    }

    if (pathname === "/search/repositories") {
      return githubJsonResponse({
        total_count: 1,
        items: [
          {
            full_name: "owner/nemotron-demo",
            name: "nemotron-demo",
            stargazers_count: 42,
            language: "Python",
            description: "A Nemotron demo repository.",
            html_url: "https://github.com/owner/nemotron-demo",
          },
        ],
      });
    }

    const contentsMarker = "/contents";
    const markerIndex = pathname.indexOf(contentsMarker);

    if (markerIndex >= 0) {
      let directoryPath = pathname.slice(
        markerIndex + contentsMarker.length,
      );

      directoryPath = directoryPath.replace(/^\/+/, "");

      const normalizedPath = directoryPath || "";

      if (files[normalizedPath]) {
        return githubJsonResponse(
          githubFile(normalizedPath, files[normalizedPath]),
        );
      }

      if (directories[normalizedPath]) {
        return githubJsonResponse(directories[normalizedPath]);
      }

      if (normalizedPath === "missing.ts") {
        return githubJsonResponse({ message: "Not Found" }, 404);
      }

      return githubJsonResponse(
        { message: `Not Found: ${normalizedPath}` },
        404,
      );
    }

    return githubJsonResponse({ message: "Not Found" }, 404);
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("GitHub README fallback explores an insufficient README", async () => {
  const restoreFetch = installGitHubMockFetch();

  try {
    const modelCalls: ChatMessage[][] = [];

    const model: ModelProvider = {
      async complete(messages) {
        modelCalls.push(messages);
        return "Evidence-based repository analysis completed.";
      },
    };

    const agent = new AgentController(model);

    const result = await agent.run({
      messages: [
        {
          role: "user",
          content:
            "Read the README.md from owner/repo and explain how my project works.",
        },
      ],
      maxSteps: 4,
    });

    assert.equal(
      result.text,
      "Evidence-based repository analysis completed.",
    );

    assert.equal(modelCalls.length, 1);

    const statusMessages = result.steps
      .filter((step) => step.type === "status")
      .map((step) => step.message);

    assert.ok(
      statusMessages.some((message) =>
        message.includes("README.md is insufficient"),
      ),
    );

    assert.ok(
      statusMessages.some((message) =>
        message.includes("exploring the repository"),
      ),
    );
  } finally {
    restoreFetch();
  }
});

test("GitHub project explorer selects important architecture files", async () => {
  const restoreFetch = installGitHubMockFetch();

  try {
    let analysisPrompt = "";

    const model: ModelProvider = {
      async complete(messages) {
        analysisPrompt = String(messages.at(-1)?.content || "");
        return "Repository architecture analysis.";
      },
    };

    const agent = new AgentController(model);

    const result = await agent.run({
      messages: [
        {
          role: "user",
          content: "Understand the owner/repo repository.",
        },
      ],
      maxSteps: 4,
    });

    assert.equal(result.text, "Repository architecture analysis.");

    assert.match(
      analysisPrompt,
      /artifacts\/api-server\/src\/agent\/controller\.ts/,
    );

    assert.match(
      analysisPrompt,
      /artifacts\/api-server\/src\/agent\/model\.ts/,
    );

    assert.match(
      analysisPrompt,
      /artifacts\/isabella-ai\/src\/App\.tsx/,
    );

    assert.match(analysisPrompt, /package\.json/);
  } finally {
    restoreFetch();
  }
});

test("GitHub project explorer skips useless and huge files", async () => {
  const restoreFetch = installGitHubMockFetch();

  try {
    let analysisPrompt = "";

    const model: ModelProvider = {
      async complete(messages) {
        analysisPrompt = String(messages.at(-1)?.content || "");
        return "Filtered repository analysis.";
      },
    };

    const agent = new AgentController(model);

    await agent.run({
      messages: [
        {
          role: "user",
          content: "Understand the owner/repo repository.",
        },
      ],
      maxSteps: 4,
    });

    assert.doesNotMatch(analysisPrompt, /NODE_MODULES_EVIDENCE/);
    assert.doesNotMatch(analysisPrompt, /DIST_EVIDENCE/);
    assert.doesNotMatch(analysisPrompt, /LOCKFILE_EVIDENCE/);
    assert.doesNotMatch(analysisPrompt, /SVG_EVIDENCE/);
  } finally {
    restoreFetch();
  }
});

test("GitHub project explorer performs exactly one evidence-only model analysis", async () => {
  const restoreFetch = installGitHubMockFetch();

  try {
    const modelCalls: ChatMessage[][] = [];

    const model: ModelProvider = {
      async complete(messages) {
        modelCalls.push(messages);
        return "One evidence-only analysis.";
      },
    };

    const agent = new AgentController(model);

    const result = await agent.run({
      messages: [
        {
          role: "user",
          content:
            "Review the architecture of owner/repo and explain how the frontend, backend, model, and tools connect.",
        },
      ],
      maxSteps: 4,
    });

    assert.equal(result.text, "One evidence-only analysis.");
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0].length, 2);

    assert.match(
      String(modelCalls[0][0].content),
      /Use ONLY the GitHub repository evidence/,
    );

    assert.match(
      String(modelCalls[0][1].content),
      /Repository evidence:/,
    );
  } finally {
    restoreFetch();
  }
});

test("GitHub file errors are returned clearly", async () => {
  const restoreFetch = installGitHubMockFetch();

  try {
    const model: ModelProvider = {
      async complete() {
        return JSON.stringify({
          type: "final",
          answer: "unused",
        });
      },
    };

    const agent = new AgentController(model);

    await assert.rejects(
      agent.run({
        messages: [
          {
            role: "user",
            content: "Read missing.ts from GitHub owner/repo.",
          },
        ],
        maxSteps: 4,
      }),
      /GitHub returned HTTP 404: Not Found/,
    );
  } finally {
    restoreFetch();
  }
});

test("normal GitHub repository search still works", async () => {
  const restoreFetch = installGitHubMockFetch();

  try {
    let modelCalls = 0;

    const model: ModelProvider = {
      async complete() {
        modelCalls += 1;

        return JSON.stringify({
          type: "final",
          answer: "unused",
        });
      },
    };

    const agent = new AgentController(model);

    const result = await agent.run({
      messages: [
        {
          role: "user",
          content:
            "Search GitHub for repositories about NVIDIA Nemotron.",
        },
      ],
      maxSteps: 4,
    });

    assert.match(result.text, /owner\/nemotron-demo/);
    assert.match(result.text, /Nemotron demo repository/);
    assert.equal(modelCalls, 0);

    assert.ok(
      result.sources.some((source) =>
        source.url.includes("owner/nemotron-demo"),
      ),
    );
  } finally {
    restoreFetch();
  }
});
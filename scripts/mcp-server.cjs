#!/usr/bin/env node
// Jeeves MCP server — exposes read-only doc queries as MCP tools.
// stdio JSON-RPC, no SDK dependency.

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const readline = require("readline");

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "jeeves", version: "1.0.0" };

const TOOLS = [
  {
    name: "jeeves_check",
    description:
      "Get Jeeves's read on the current project: KB stats, last doc update, code changes since, broken doc paths, unindexed docs, and schema entities missing from SYSTEM-MAP. Returns structured JSON. Use this instead of running /jeeves or reading docs manually when you want a fast project-state snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Absolute path to the project root. Defaults to the current working directory.",
        },
      },
    },
  },
];

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function findJeevesScript(projectRoot) {
  const candidates = [
    process.env.CLAUDE_PLUGIN_ROOT ? path.join(process.env.CLAUDE_PLUGIN_ROOT, "scripts", "jeeves.ts") : null,
    path.join(projectRoot, "scripts", "jeeves.ts"),
    path.join(__dirname, "jeeves.ts"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      require("fs").accessSync(c);
      return c;
    } catch {}
  }
  return null;
}

function runCheck(projectRoot) {
  const script = findJeevesScript(projectRoot);
  if (!script) {
    return { error: `Cannot locate jeeves.ts (looked in CLAUDE_PLUGIN_ROOT, ${projectRoot}/scripts, plugin dir)` };
  }
  const result = spawnSync("npx", ["tsx", script, projectRoot, "--check", "--json"], {
    cwd: projectRoot,
    timeout: 30000,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    return { error: `jeeves --check exited ${result.status}: ${result.stderr || result.stdout}` };
  }
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    return { error: `Failed to parse jeeves JSON: ${e.message}`, raw: result.stdout.slice(0, 500) };
  }
}

function handle(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === "notifications/initialized") {
    return; // no response for notifications
  }

  if (method === "tools/list") {
    return reply(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name === "jeeves_check") {
      const projectRoot = args.project || process.cwd();
      const data = runCheck(projectRoot);
      return reply(id, {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
        isError: !!data.error,
      });
    }

    return replyError(id, -32601, `Unknown tool: ${name}`);
  }

  if (id !== undefined) {
    replyError(id, -32601, `Unknown method: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  try {
    handle(msg);
  } catch (e) {
    if (msg.id !== undefined) replyError(msg.id, -32603, e.message);
  }
});

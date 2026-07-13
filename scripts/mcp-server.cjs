#!/usr/bin/env node
// Jeeves MCP server — exposes read-only doc queries as MCP tools.
// stdio JSON-RPC, no SDK dependency.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "jeeves", version: "1.1.0" };

const TOOLS = [
  {
    name: "jeeves_check",
    description:
      "Fast project-state snapshot: KB stats (patterns, decisions), last doc-update date, code-change counts since, broken doc paths, unindexed docs, and schema entities missing from SYSTEM-MAP. Returns structured JSON. Use this at session start or whenever you'd previously run /jeeves --check.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Absolute path to the project root. Defaults to cwd." },
      },
    },
  },
  {
    name: "jeeves_search",
    description:
      "Search the project's knowledge base (docs/internal/patterns, docs/internal/decisions) AND the memory/ layer (durable prefs/feedback/reference on how to work with this user & repo) for a query string. Returns matching files with line numbers and excerpts. Use this to recall what the project already knows about a topic — or to pull a relevant memory mid-task — before reading files or asking the user.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term or phrase. Case-insensitive." },
        project: { type: "string", description: "Absolute path to the project root. Defaults to cwd." },
        scope: {
          type: "string",
          enum: ["all", "patterns", "decisions", "memory"],
          description: "Which subset to search: 'all' (KB + memory), 'patterns', 'decisions', or 'memory'. Defaults to 'all'.",
        },
        limit: { type: "number", description: "Max matches to return. Defaults to 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "jeeves_stale",
    description:
      "Get the list of doc actions Jeeves currently recommends: missing entities, new features lacking pattern docs, broken paths, unindexed docs, etc. Each action has a priority (high/medium/low) and a target file. Use this when deciding what doc work matters most.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Absolute path to the project root. Defaults to cwd." },
      },
    },
  },
  {
    name: "jeeves_health",
    description:
      "Get the KB health score (0-100) with grade, status, and breakdown across 5 categories (Structure, Freshness, Completeness, Audit Health, Lint). Includes targeted recommendations for the lowest-scoring areas. Use this when the user asks how the docs are doing.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Absolute path to the project root. Defaults to cwd." },
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
  // Same resolution contract as the hooks: PREFER the prebuilt .cjs (node, fast) over .ts
  // (tsx), and PREFER the plugin/__dirname copy over a project-local one (a stale vendored
  // copy runs old/slow logic — the v4.6.2 hazard). project-local is LAST, not first.
  const P = process.env.CLAUDE_PLUGIN_ROOT;
  const candidates = [
    P ? path.join(P, "scripts", "jeeves.cjs") : null,
    P ? path.join(P, "scripts", "jeeves.ts") : null,
    path.join(__dirname, "jeeves.cjs"),
    path.join(__dirname, "jeeves.ts"),
    path.join(projectRoot, "scripts", "jeeves.cjs"),
    path.join(projectRoot, "scripts", "jeeves.ts"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      fs.accessSync(c);
      return c;
    } catch {}
  }
  return null;
}

function runJeevesJson(projectRoot, mode) {
  const script = findJeevesScript(projectRoot);
  if (!script) {
    return { error: `Cannot locate jeeves engine (looked for jeeves.cjs/.ts in CLAUDE_PLUGIN_ROOT, plugin dir, ${projectRoot}/scripts)` };
  }
  // .cjs runs under node directly; .ts needs the tsx loader via npx.
  const isCjs = script.endsWith(".cjs");
  const [cmd, pre] = isCjs ? ["node", []] : ["npx", ["tsx"]];
  const result = spawnSync(cmd, [...pre, script, projectRoot, `--${mode}`, "--json"], {
    cwd: projectRoot,
    timeout: 45000,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    return { error: `jeeves --${mode} exited ${result.status}: ${result.stderr || result.stdout}` };
  }
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    return { error: `Failed to parse jeeves JSON: ${e.message}`, raw: result.stdout.slice(0, 500) };
  }
}

function searchKb(projectRoot, query, scope, limit) {
  const docsRoot = path.join(projectRoot, "docs", "internal");
  const dirs = [];
  if (scope === "all" || scope === "patterns") dirs.push(path.join(docsRoot, "patterns"));
  if (scope === "all" || scope === "decisions") dirs.push(path.join(docsRoot, "decisions"));
  // memory/ is a flat dir at the repo root (not under docs/internal) — the collaboration
  // layer, searchable so the agent can pull a relevant memory mid-task (D3 retrieval).
  if (scope === "all" || scope === "memory") dirs.push(path.join(projectRoot, "memory"));

  const existing = dirs.filter(d => fs.existsSync(d));
  if (existing.length === 0) {
    return { matches: [], note: `No ${scope} docs found (looked under ${docsRoot} and memory/)` };
  }

  // -F: treat the query as a LITERAL string, not a regex (the tool contract says
  // "search term or phrase"). -e query: so a query starting with `-` isn't parsed as
  // an option. --: end of options before the file list.
  const result = spawnSync("grep", ["-rniIF", "--include=*.md", "-e", query, "--", ...existing], {
    cwd: projectRoot,
    encoding: "utf-8",
    timeout: 15000,
  });
  // spawnSync failed to launch the process at all (e.g. grep missing).
  if (result.error) {
    return { error: `grep failed to run: ${result.error.message}` };
  }
  // grep exits 1 when no matches — that's fine.
  if (result.status !== 0 && result.status !== 1) {
    return { error: `grep exited ${result.status}: ${result.stderr || ""}` };
  }

  const lines = (result.stdout || "").split("\n").filter(Boolean);
  const max = Math.min(limit || 20, 100);
  const matches = lines.slice(0, max).map(line => {
    const idx1 = line.indexOf(":");
    const idx2 = line.indexOf(":", idx1 + 1);
    if (idx1 === -1 || idx2 === -1) return { raw: line };
    const file = path.relative(projectRoot, line.slice(0, idx1));
    const lineNum = parseInt(line.slice(idx1 + 1, idx2), 10);
    const excerpt = line.slice(idx2 + 1).trim();
    return { file, line: lineNum, excerpt };
  });

  return {
    query,
    scope,
    total: lines.length,
    truncated: lines.length > max,
    matches,
  };
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

  if (method === "notifications/initialized") return;

  // MCP ping: must return an empty result, not a method-not-found error (some clients
  // treat the error as a fatal transport failure and drop the connection).
  if (method === "ping") return reply(id, {});

  if (method === "tools/list") {
    return reply(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    const projectRoot = args.project || process.cwd();

    let data;
    if (name === "jeeves_check") data = runJeevesJson(projectRoot, "check");
    else if (name === "jeeves_stale") data = runJeevesJson(projectRoot, "stale");
    else if (name === "jeeves_health") data = runJeevesJson(projectRoot, "health");
    else if (name === "jeeves_search") {
      if (!args.query) return replyError(id, -32602, "jeeves_search requires 'query'");
      data = searchKb(projectRoot, args.query, args.scope || "all", args.limit);
    } else {
      return replyError(id, -32601, `Unknown tool: ${name}`);
    }

    return reply(id, {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
      isError: !!data.error,
    });
  }

  if (id !== undefined) replyError(id, -32601, `Unknown method: ${method}`);
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

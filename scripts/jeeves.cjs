var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// toolkit/scripts/jeeves.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var import_child_process = require("child_process");
var ROOT = (() => {
  const ri = process.argv.indexOf("--root");
  if (ri >= 0 && process.argv[ri + 1]) return process.argv[ri + 1];
  const absPositional = process.argv.slice(2).find((a) => !a.startsWith("-") && path.isAbsolute(a));
  if (absPositional) return absPositional;
  return process.cwd();
})();
var MODES = ["init", "migrate", "handoff", "check", "stale", "health", "index", "annotate", "verify", "research", "save", "summary", "export", "reconcile", "driftcheck", "trace", "extract", "design", "archive", "thinking-candidate", "bootstrap-thinking", "capture-check", "memory-check", "kb-check", "report"];
var MODE = MODES.find((m) => process.argv.includes(`--${m}`)) || "sync";
var JSON_OUT = process.argv.includes("--json");
function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : void 0;
}
var DOCS_DIR = path.join(ROOT, "docs", "internal");
var THINKING_DIR = path.join(ROOT, "thinking");
var SYSTEM_MAP = path.join(DOCS_DIR, "SYSTEM-MAP.md");
var LOG_FILE = path.join(DOCS_DIR, "log.md");
var PATTERNS_DIR = path.join(DOCS_DIR, "patterns");
var DECISIONS_DIR = path.join(DOCS_DIR, "decisions");
var CODE_FILTER = "grep -vE '^(docs/|thinking/|\\.claude/|README|LICENSE|CHANGELOG|package\\.json|package-lock\\.json|pnpm-lock|tsconfig|node_modules/)' | grep -E '\\.(ts|tsx|js|jsx|py|go|rs|prisma|sql)$'";
var MEMORY_DIR = path.join(ROOT, "memory");
var MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");
var MEMORY_INDEX_PREAMBLE = `# Memory Index

Durable, PRUNABLE notes on how to work with this user & repo \u2014 preferences, feedback,
reference. One file per memory (frontmatter: name, description, metadata.type =
user|feedback|reference; optional created/confirmed dates). Unlike the code KB, memory is
ephemeral: overwrite or DELETE entries that are no longer true. Jeeves injects these at
session start.
`;
var MEMORY_CANON_SECTIONS = ["## User", "## Feedback", "## Reference"];
var MEMORY_DROPPED_SECTIONS = ["## Project"];
var MEMORY_INDEX_TEMPLATE = MEMORY_INDEX_PREAMBLE + "\n" + MEMORY_CANON_SECTIONS.join("\n") + "\n";
var MEMORY_PREAMBLE_4_10 = `# Memory Index

Durable, PRUNABLE notes on how to work with this user & repo \u2014 preferences, feedback,
reference. One file per memory (frontmatter: name, description, metadata.type =
user|feedback|reference|project). Unlike the code KB, memory is ephemeral: overwrite or
DELETE entries that are no longer true. Jeeves injects these at session start.
`;
var MEMORY_KNOWN_PREAMBLE_LINES = new Set(
  (MEMORY_INDEX_PREAMBLE + "\n" + MEMORY_PREAMBLE_4_10).split("\n").map((l) => l.trim()).filter(Boolean)
);
var isDroppedSection = (head) => MEMORY_DROPPED_SECTIONS.some((d) => d.toLowerCase() === head.toLowerCase());
function migrateMemoryIndex(raw) {
  const report = [];
  const norm = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const firstH = norm.search(/^## /m);
  const preamble = firstH >= 0 ? norm.slice(0, firstH) : norm;
  const sectionsRaw = firstH >= 0 ? norm.slice(firstH) : "";
  const customLines = preamble.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() && !MEMORY_KNOWN_PREAMBLE_LINES.has(l.trim()));
  if (customLines.length) report.push(`preserved ${customLines.length} custom line(s) above the sections \u2014 verify they still belong`);
  const groups = [];
  let cur = null;
  for (const ln of sectionsRaw.split("\n")) {
    if (/^## /.test(ln)) {
      cur = { head: ln.trim(), body: [] };
      groups.push(cur);
    } else if (cur) cur.body.push(ln);
  }
  const isEmpty = (g) => g.body.every((l) => l.trim() === "");
  const kept = [];
  for (const g of groups) {
    if (isDroppedSection(g.head)) {
      if (isEmpty(g)) {
        report.push(`removed empty "${g.head}" section (dropped type)`);
        continue;
      }
      report.push(`"${g.head}" still has entries \u2014 retype them to user|feedback|reference and move their index lines, then delete the section`);
    }
    kept.push(g);
  }
  for (const h of MEMORY_CANON_SECTIONS) if (!kept.some((g) => g.head === h)) kept.push({ head: h, body: [] });
  const body = kept.map((g) => {
    const trimmed = g.body.join("\n").replace(/\n+$/, "");
    return trimmed ? `${g.head}
${trimmed}` : g.head;
  }).join("\n");
  const preambleOut = MEMORY_INDEX_PREAMBLE + (customLines.length ? "\n" + customLines.join("\n") + "\n" : "");
  const content = preambleOut + "\n" + body + "\n";
  return { content, changed: content !== norm, report };
}
function memoryEntryType(raw) {
  const norm = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const fm = norm.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return "";
  let t = "";
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^\s*type:\s*(.+?)\s*$/);
    if (m) t = m[1].replace(/^["']|["']$/g, "").trim();
  }
  return t;
}
function exists(p) {
  return fs.existsSync(p);
}
function read(p) {
  return exists(p) ? fs.readFileSync(p, "utf-8") : "";
}
function run(cmd, opts) {
  try {
    return (0, import_child_process.execSync)(cmd, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: opts?.timeout || 1e4,
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch {
    return "";
  }
}
function runFile(cmd, args, opts) {
  try {
    return (0, import_child_process.execFileSync)(cmd, args, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: opts?.timeout || 1e4,
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch (e) {
    return (e && e.stdout ? String(e.stdout) : "").trim();
  }
}
function runGit(args, opts) {
  return runFile("git", args, opts);
}
var _gitPrefix = null;
function gitPrefix() {
  if (_gitPrefix === null) _gitPrefix = (runGit(["rev-parse", "--show-prefix"]) || "").trim();
  return _gitPrefix;
}
var wordSet = (s) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
var jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
};
var _commitTimeCache = /* @__PURE__ */ new Map();
function gitCommitTime(relFile) {
  if (_commitTimeCache.has(relFile)) return _commitTimeCache.get(relFile);
  const n = parseInt(runGit(["log", "-1", "--format=%ct", "--", relFile]), 10);
  const v = isNaN(n) ? 0 : n;
  _commitTimeCache.set(relFile, v);
  return v;
}
function resolveScript(name) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const pluginPath = pluginRoot ? path.join(pluginRoot, "scripts", name) : "";
  if (pluginPath && exists(pluginPath)) return pluginPath;
  const local = path.join(ROOT, "scripts", name);
  if (exists(local)) return local;
  return null;
}
function getAllMdFiles(dir) {
  if (!exists(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...getAllMdFiles(full));
    else if (entry.name.endsWith(".md")) results.push(full);
  }
  return results;
}
function today() {
  return (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
}
var CODE_EXTS = /* @__PURE__ */ new Set([".py", ".js", ".ts", ".tsx", ".jsx", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".php", ".ex", ".exs", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".scala", ".clj", ".hs", ".ml", ".tf", ".ipynb", ".sql", ".sh"]);
var CODE_MANIFESTS = /* @__PURE__ */ new Set(["package.json", "go.mod", "Cargo.toml", "pyproject.toml", "pom.xml", "Gemfile", "mix.exs", "composer.json"]);
function countSourceFiles(dir, budget = 2e3) {
  let n = 0;
  const walk = (d) => {
    if (n >= 3 || budget <= 0) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (n >= 3 || budget <= 0) return;
      if (e === "node_modules" || e === ".git" || e === "thinking" || e === ".claude") continue;
      const full = path.join(d, e);
      budget--;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (CODE_MANIFESTS.has(e) || CODE_EXTS.has(path.extname(e))) n++;
    }
  };
  walk(dir);
  return n;
}
function isThinkingCandidate() {
  if (exists(DOCS_DIR)) return false;
  return countSourceFiles(ROOT) < 3;
}
function detectState() {
  const hasDocs = exists(DOCS_DIR);
  const hasThinking = exists(THINKING_DIR);
  const hasSystemMap = exists(SYSTEM_MAP);
  const hasLog = exists(LOG_FILE);
  const patternCount = exists(PATTERNS_DIR) ? fs.readdirSync(PATTERNS_DIR).filter((f) => f.endsWith(".md")).length : 0;
  const decisionCount = exists(DECISIONS_DIR) ? fs.readdirSync(DECISIONS_DIR).filter((f) => f.endsWith(".md")).length : 0;
  let mode = "none";
  if (hasDocs && hasThinking) mode = "both";
  else if (hasDocs) mode = "code";
  else if (hasThinking) mode = "brainstorm";
  return { hasDocs, hasThinking, hasSystemMap, hasLog, patternCount, decisionCount, mode };
}
function getSchemaEntities() {
  const prismaFiles = [
    "prisma/schema.prisma",
    "packages/db/prisma/schema.prisma",
    "db/schema.prisma"
  ];
  for (const f of prismaFiles) {
    const full = path.join(ROOT, f);
    if (exists(full)) {
      const content = read(full);
      return [...content.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
    }
  }
  const drizzleFiles = [
    "lib/db/schema.ts",
    "src/db/schema.ts",
    "db/schema.ts",
    "drizzle/schema.ts"
  ];
  for (const f of drizzleFiles) {
    const full = path.join(ROOT, f);
    if (exists(full)) {
      const content = read(full);
      return [...content.matchAll(/(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*["'](\w+)["']/g)].map((m) => m[1]);
    }
  }
  return [];
}
function getDocumentedEntities() {
  if (!exists(SYSTEM_MAP)) return [];
  const content = read(SYSTEM_MAP);
  const rows = content.match(/^\|\s*`?(\w+)`?\s*\|/gm);
  if (!rows) return [];
  const all = [];
  for (const row of rows) {
    const match = row.match(/^\|\s*`?(\w+)`?\s*\|/);
    if (match && match[1]) all.push(match[1]);
  }
  return [...new Set(all)];
}
function getGitChanges() {
  const lastDocCommit = run("git log --format='%H' -1 -- docs/internal/");
  const lastDocDate = run("git log --format='%ai' -1 -- docs/internal/");
  const codeFilter = CODE_FILTER;
  let changedCodeFiles = [];
  let newCodeFiles = [];
  let deletedCodeFiles = [];
  if (lastDocCommit) {
    const changed = run(`git -c core.quotepath=off diff --name-only --relative --diff-filter=M ${lastDocCommit}..HEAD 2>/dev/null | ${codeFilter}`);
    changedCodeFiles = changed ? changed.split("\n") : [];
    const added = run(`git -c core.quotepath=off diff --name-only --relative --diff-filter=A ${lastDocCommit}..HEAD 2>/dev/null | ${codeFilter}`);
    newCodeFiles = added ? added.split("\n") : [];
    const deleted = run(`git -c core.quotepath=off diff --name-only --relative --diff-filter=D ${lastDocCommit}..HEAD 2>/dev/null | ${codeFilter}`);
    deletedCodeFiles = deleted ? deleted.split("\n") : [];
  }
  const msgs = run("git log --format='%s' -10");
  const recentCommitMessages = msgs ? msgs.split("\n") : [];
  return { lastDocCommit, lastDocDate, changedCodeFiles, newCodeFiles, deletedCodeFiles, recentCommitMessages };
}
function parseFrontmatter(content) {
  content = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!content.startsWith("---\n")) return {};
  const rest = content.slice(4);
  const endIdx = rest.indexOf("\n---\n");
  if (endIdx === -1) return {};
  const block = rest.slice(0, endIdx);
  const out = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9-]*):\s*(.+?)\s*$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === "verified-at") out.verifiedAt = val;
    else if (key === "status") out.status = val;
    else if (key === "superseded-by") out.supersededBy = val;
  }
  return out;
}
var STALENESS_SKIP_BASENAMES = /* @__PURE__ */ new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "cargo.lock",
  "go.sum",
  "go.mod",
  "composer.json",
  "gemfile.lock"
]);
function isNonSourceStalenessRef(p) {
  if (p.endsWith(".md")) return true;
  const base = path.basename(p).toLowerCase();
  if (STALENESS_SKIP_BASENAMES.has(base)) return true;
  if (/^tsconfig.*\.json$/.test(base)) return true;
  if (/\.config\.(js|ts|mjs|cjs)$/.test(base)) return true;
  return false;
}
var JS_TS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
function extractExports(src) {
  const names = /* @__PURE__ */ new Set();
  const opaque = /export\s+\*/.test(src);
  const declRe = /export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = declRe.exec(src)) !== null) names.add(m[1]);
  const braceRe = /export\s*\{([^}]*)\}/g;
  while ((m = braceRe.exec(src)) !== null) {
    for (const part of m[1].split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      const asMatch = seg.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      if (asMatch) {
        names.add(asMatch[1]);
        continue;
      }
      const nameMatch = seg.match(/^([A-Za-z_$][\w$]*)/);
      if (nameMatch) names.add(nameMatch[1]);
    }
  }
  if (/export\s+default\b/.test(src)) names.add("default");
  return { names, opaque };
}
function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
var PY_EXT = /\.pyi?$/;
function extractPythonSurface(src) {
  const names = /* @__PURE__ */ new Set();
  const opaque = /^from\s+[.\w]+\s+import\s+\*/m.test(src);
  const declRe = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm;
  let m;
  while ((m = declRe.exec(src)) !== null) names.add(m[1]);
  const allMatch = src.match(/__all__\s*(?::[^=]+)?=\s*[\[(]([\s\S]*?)[\])]/);
  if (allMatch) {
    for (const q of allMatch[1].matchAll(/['"]([A-Za-z_]\w*)['"]/g)) names.add(q[1]);
  }
  return { names, opaque };
}
function surfaceExtractorFor(ref) {
  if (JS_TS_EXT.test(ref)) return extractExports;
  if (PY_EXT.test(ref)) return extractPythonSurface;
  return null;
}
function getPatternFiles() {
  const result = /* @__PURE__ */ new Map();
  if (!exists(PATTERNS_DIR)) return result;
  for (const file of fs.readdirSync(PATTERNS_DIR).filter((f) => f.endsWith(".md"))) {
    const content = read(path.join(PATTERNS_DIR, file));
    const fm = parseFrontmatter(content);
    const paths = [...content.matchAll(/`([a-zA-Z][a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})`/g)].map((m) => m[1]).filter((p) => !p.startsWith("http") && !p.startsWith("@") && p.includes("/"));
    result.set(file, { refs: [...new Set(paths)], fm });
  }
  return result;
}
var PATH_SKIP_PATTERNS = [
  /^[a-z]+\.[\w.-]+\.\w+\//,
  // hostnames with paths (cdn.example.com/foo.js)
  /^[a-z]+\/[a-z]+\/[a-z]+$/,
  // language constructs (try/catch/finally)
  /^[a-z]+\/[a-z]+$/,
  // two-part language constructs (try/catch)
  /\*\*/,
  // glob double-star (tests/api/**)
  /\*\./,
  // glob wildcards (drizzle/*.sql)
  /\[[^\]]+\]/,
  // template placeholders ([type], [entity-type], [slug])
  /\bxxx\b/i,
  // literal "xxx" placeholders (app/api/geo-xxx/route.ts)
  /\n/
  // multiline blocks
];
var _projectDirs = null;
function getProjectDirs() {
  if (_projectDirs) return _projectDirs;
  const dirs = /* @__PURE__ */ new Set();
  try {
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        dirs.add(entry.name);
      }
    }
  } catch {
  }
  _projectDirs = dirs;
  return dirs;
}
function stripResolvedSections(md) {
  const out = [];
  const lines = md.split("\n");
  let skipDepth = null;
  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      const text = headingMatch[2];
      if (skipDepth !== null && depth <= skipDepth) skipDepth = null;
      if (skipDepth === null && /^✅/.test(text)) {
        skipDepth = depth;
        continue;
      }
    }
    if (skipDepth === null) out.push(line);
  }
  return out.join("\n");
}
function findBrokenPaths() {
  const broken = [];
  const allDocs = getAllMdFiles(DOCS_DIR);
  const projectDirs = getProjectDirs();
  for (const docPath of allDocs) {
    const rawContent = read(docPath);
    const content = stripResolvedSections(rawContent).replace(/~~[^\n]*?~~/g, "");
    const candidates = [...content.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
    const paths = candidates.filter((c) => {
      const looksLikePath = (c.includes("/") || /\.\w{2,6}$/.test(c)) && !PATH_SKIP_PATTERNS.some((p) => p.test(c)) && !c.includes(" ") && !c.includes("(") && !c.includes("<") && !c.includes(":") && !c.startsWith("http") && !c.startsWith("@") && !c.startsWith("node:") && !c.startsWith("$") && !c.includes("*") && !c.includes("{{") && c.length < 200;
      if (!looksLikePath) return false;
      const topDir = c.split("/")[0];
      const HIDDEN_ALLOWLIST = /* @__PURE__ */ new Set([".claude", ".github", ".githooks"]);
      return projectDirs.has(topDir) || topDir === "patterns" || topDir === "decisions" || HIDDEN_ALLOWLIST.has(topDir);
    });
    for (const ref of paths) {
      const cleanRef = ref.replace(/:\d+(:\d+)?$/, "");
      const resolvedRoot = path.join(ROOT, cleanRef);
      const resolvedDocs = path.join(DOCS_DIR, cleanRef);
      if (!exists(resolvedRoot) && !exists(resolvedDocs)) {
        broken.push({ doc: path.relative(ROOT, docPath), brokenPath: ref });
      }
    }
  }
  return broken;
}
function findUnindexedDocs() {
  if (!exists(SYSTEM_MAP)) return [];
  const systemMapContent = read(SYSTEM_MAP);
  const unindexed = [];
  for (const dir of [PATTERNS_DIR, DECISIONS_DIR]) {
    if (!exists(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const esc = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const indexed = new RegExp(`(^|[^\\w.-])${esc}([^\\w.-]|$)`, "m").test(systemMapContent);
      if (!indexed) {
        unindexed.push(path.relative(DOCS_DIR, path.join(dir, file)));
      }
    }
  }
  return unindexed;
}
function buildConceptIndex() {
  const concepts = /* @__PURE__ */ new Map();
  const TEMPLATE_NOISE = /* @__PURE__ */ new Set([
    "what this is",
    "how it works",
    "key files",
    "gotchas",
    "follow this pattern",
    "decision",
    "context",
    "consequences",
    "why we chose this",
    "if thinking about changing",
    "current thinking",
    "evolution",
    "key decisions",
    "open questions",
    "proposals (not yet confirmed)",
    "what happened",
    "next steps",
    "what was built",
    "session summary",
    "recent doc activity",
    "knowledge base state",
    "key files changed",
    "pending doc actions",
    "pattern index",
    "decision index",
    "entity registry",
    "architecture overview",
    "activity log",
    "concept index"
  ]);
  function addConcept(concept, doc, codeFiles) {
    const key = concept.toLowerCase().trim();
    if (!key || key.length < 2) return;
    if (TEMPLATE_NOISE.has(key)) return;
    if (!concepts.has(key)) {
      concepts.set(key, { docs: /* @__PURE__ */ new Set(), files: /* @__PURE__ */ new Set() });
    }
    const entry = concepts.get(key);
    entry.docs.add(doc);
    for (const f of codeFiles) entry.files.add(f);
  }
  const allDocs = [
    ...getAllMdFiles(DOCS_DIR),
    ...getAllMdFiles(THINKING_DIR)
  ];
  const CATALOG_DOC_FILE_THRESHOLD = 25;
  for (const docPath of allDocs) {
    const content = read(docPath);
    const relDoc = path.relative(ROOT, docPath);
    const rawFilePaths = [...content.matchAll(/`([a-zA-Z][a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})`/g)].map((m) => m[1]).filter((p) => !p.startsWith("http") && !p.startsWith("@") && !p.startsWith("node:") && !p.includes("://") && !/^[a-z]+\.[a-z]+\.[a-z]+/.test(p) && p.includes("/")).filter((p) => exists(path.join(ROOT, p)));
    const filePaths = rawFilePaths.length > CATALOG_DOC_FILE_THRESHOLD ? [] : rawFilePaths;
    const headings = [...content.matchAll(/^##?\s+(.+)$/gm)].map((m) => m[1].replace(/[*`]/g, "").trim()).filter((h) => h.length > 2 && h.length < 60 && !h.startsWith("\u2014"));
    for (const heading of headings) {
      addConcept(heading, relDoc, filePaths);
    }
    const tableEntities = [...content.matchAll(/^\|\s*`?([A-Z][a-zA-Z]+)`?\s*\|/gm)].map((m) => m[1]);
    for (const entity of tableEntities) {
      addConcept(entity, relDoc, filePaths);
    }
    const tagMatch = content.match(/^tags:\s*\[(.+)\]/m);
    if (tagMatch) {
      const tags = tagMatch[1].split(",").map((t) => t.trim().replace(/['"]/g, ""));
      for (const tag of tags) {
        addConcept(tag, relDoc, filePaths);
      }
    }
    const docName = path.basename(docPath, ".md").replace(/-/g, " ");
    addConcept(docName, relDoc, filePaths);
  }
  return [...concepts.entries()].filter(([, v]) => v.docs.size > 0).sort((a, b) => b[1].docs.size - a[1].docs.size).map(([concept, { docs, files }]) => ({
    concept,
    docs: [...docs].sort(),
    files: [...files].sort()
  }));
}
function writeConceptIndex(entries) {
  const indexPath = path.join(DOCS_DIR, "CONCEPT-INDEX.md");
  const lines = [
    "# Concept Index",
    "",
    `> Auto-generated by Jeeves. ${entries.length} concepts across ${new Set(entries.flatMap((e) => e.docs)).size} docs.`,
    `> Last updated: ${today()}`,
    "",
    "| Concept | Docs | Code Files |",
    "|---------|------|------------|"
  ];
  for (const entry of entries) {
    const docsStr = entry.docs.map((d) => `\`${d}\``).join(", ");
    const filesStr = entry.files.length > 0 ? entry.files.slice(0, 3).map((f) => `\`${f}\``).join(", ") + (entry.files.length > 3 ? ` (+${entry.files.length - 3})` : "") : "\u2014";
    lines.push(`| ${entry.concept} | ${docsStr} | ${filesStr} |`);
  }
  fs.writeFileSync(indexPath, lines.join("\n") + "\n");
}
function findNewFeatures(newFiles) {
  const dirCounts = /* @__PURE__ */ new Map();
  for (const f of newFiles) {
    const dir = path.dirname(f);
    dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
  }
  return [...dirCounts.entries()].filter(([, count]) => count >= 2).map(([dir]) => dir);
}
function generateActions(state, git) {
  const actions = [];
  if (!state.hasSystemMap && state.hasDocs) {
    actions.push({
      type: "create",
      target: "docs/internal/SYSTEM-MAP.md",
      description: "Create SYSTEM-MAP.md \u2014 entity registry, architecture, key files, integrations",
      priority: "high"
    });
  }
  const schemaEntities = getSchemaEntities();
  const documentedEntities = getDocumentedEntities();
  const missingEntities = schemaEntities.filter(
    (e) => !documentedEntities.some((d) => d.toLowerCase() === e.toLowerCase())
  );
  if (missingEntities.length > 0) {
    actions.push({
      type: "update",
      target: "docs/internal/SYSTEM-MAP.md",
      description: `Add ${missingEntities.length} missing entities to registry: ${missingEntities.join(", ")}`,
      priority: "high"
    });
  }
  const newFeatureDirs = findNewFeatures(git.newCodeFiles);
  const patternFiles = getPatternFiles();
  const patternDirRefs = /* @__PURE__ */ new Set();
  for (const [, { refs }] of patternFiles) {
    for (const ref of refs) {
      patternDirRefs.add(path.dirname(ref));
    }
  }
  for (const dir of newFeatureDirs) {
    if (!patternDirRefs.has(dir)) {
      const name = dir.split("/").pop() || dir;
      actions.push({
        type: "create",
        target: `docs/internal/patterns/${name}.md`,
        description: `New feature in ${dir}/ (${git.newCodeFiles.filter((f) => f.startsWith(dir)).length} files) \u2014 create pattern doc`,
        priority: "medium"
      });
    }
  }
  const IGNORED_STALENESS_PATHS = [
    "/generated/",
    "/dist/",
    "/.next/",
    "/node_modules/",
    "/build/",
    ".tsbuildinfo",
    ".d.ts"
  ];
  const isIgnoredForStaleness = (p) => IGNORED_STALENESS_PATHS.some((ignored) => p.includes(ignored));
  for (const [patternFile, { refs, fm }] of patternFiles) {
    if (fm.status === "archived" || fm.supersededBy && fm.supersededBy.length > 0) continue;
    const docRelPath = `docs/internal/patterns/${patternFile}`;
    const docLastCommitSha = runGit(["log", "-1", "--format=%H", "--", docRelPath]);
    if (!docLastCommitSha) continue;
    let anchorSha = docLastCommitSha;
    if (fm.verifiedAt && /^[0-9a-f]{7,64}$/i.test(fm.verifiedAt)) {
      const verified = runGit(["rev-parse", "--verify", `${fm.verifiedAt}^{commit}`]);
      if (verified) anchorSha = verified;
    }
    const _pfx = gitPrefix();
    const docCommitFiles = new Set(
      (runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--first-parent", "--root", docLastCommitSha]) || "").split("\n").filter(Boolean).map((f) => _pfx && f.startsWith(_pfx) ? f.slice(_pfx.length) : f)
    );
    const docText = read(path.join(ROOT, docRelPath));
    const staleRefs = [];
    for (const ref of refs) {
      if (isIgnoredForStaleness(ref) || isNonSourceStalenessRef(ref)) continue;
      if (!exists(path.join(ROOT, ref))) continue;
      const latestMsg = runGit(["log", "-1", "--format=%s", `${anchorSha}..HEAD`, "--", ref]);
      if (!latestMsg) continue;
      if (docCommitFiles.has(ref)) continue;
      const extractor = surfaceExtractorFor(ref);
      if (extractor) {
        const headSrc = (() => {
          try {
            return fs.readFileSync(path.join(ROOT, ref), "utf-8");
          } catch {
            return "";
          }
        })();
        const anchorSrc = runGit(["show", `${anchorSha}:${_pfx}${ref}`]);
        const headEx = extractor(headSrc);
        const anchorEx = extractor(anchorSrc);
        if (!headEx.opaque && !anchorEx.opaque) {
          if (headEx.names.size === 0 && anchorEx.names.size === 0) {
            staleRefs.push({ ref, latestMsg, severity: "low" });
          } else if (setsEqual(anchorEx.names, headEx.names)) {
            continue;
          } else {
            let removed;
            for (const name of anchorEx.names) {
              if (name === "default") continue;
              if (!headEx.names.has(name) && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(docText)) {
                removed = name;
                break;
              }
            }
            staleRefs.push(removed ? { ref, latestMsg, severity: "high", removed } : { ref, latestMsg, severity: "medium" });
          }
        } else {
          staleRefs.push({ ref, latestMsg, severity: "low" });
        }
      } else {
        staleRefs.push({ ref, latestMsg, severity: "low" });
      }
    }
    if (staleRefs.length > 0 && !actions.some((a) => a.target === docRelPath)) {
      const truncate = (s, n) => s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
      const rank = { high: 3, medium: 2, low: 1 };
      const priority = staleRefs.reduce(
        (acc, r) => rank[r.severity] > rank[acc] ? r.severity : acc,
        "low"
      );
      const highRef = staleRefs.find((r) => r.severity === "high");
      let description;
      if (highRef) {
        description = `Stale (HIGH) \u2014 doc references removed symbol '${highRef.removed}' \u2014 ${highRef.ref} ("${truncate(highRef.latestMsg, 50)}")`;
      } else {
        const top = staleRefs.slice(0, 3).map((r) => `${r.ref} ("${truncate(r.latestMsg, 50)}")`);
        const more = staleRefs.length > 3 ? ` (+${staleRefs.length - 3} more)` : "";
        description = `Stale \u2014 ${staleRefs.length} ref(s) changed since doc: ${top.join(", ")}${more}`;
      }
      actions.push({ type: "update", target: docRelPath, description, priority });
    }
  }
  const archivedPatternFiles = /* @__PURE__ */ new Set();
  for (const [patternFile, { fm }] of patternFiles) {
    if (fm.status === "archived" || fm.supersededBy && fm.supersededBy.length > 0) {
      archivedPatternFiles.add(patternFile);
    }
  }
  const broken = findBrokenPaths().filter((b) => {
    const docFile = path.basename(b.doc);
    return !archivedPatternFiles.has(docFile);
  });
  if (broken.length > 0) {
    actions.push({
      type: "fix",
      target: "broken file paths",
      description: `${broken.length} broken path(s): ${broken.slice(0, 3).map((b) => `${b.doc} \u2192 ${b.brokenPath}`).join("; ")}${broken.length > 3 ? ` (+${broken.length - 3} more)` : ""}`,
      priority: "high"
    });
  }
  const unindexed = findUnindexedDocs().filter((u) => {
    const docFile = path.basename(u);
    return !archivedPatternFiles.has(docFile);
  });
  if (unindexed.length > 0) {
    actions.push({
      type: "update",
      target: "docs/internal/SYSTEM-MAP.md",
      description: `Add ${unindexed.length} unindexed doc(s) to SYSTEM-MAP: ${unindexed.join(", ")}`,
      priority: "medium"
    });
  }
  if (git.changedCodeFiles.length > 0 || git.newCodeFiles.length > 0) {
    const totalChanges = git.changedCodeFiles.length + git.newCodeFiles.length;
    actions.push({
      type: "log",
      target: "docs/internal/log.md",
      description: `Append: ## [${today()}] update | ${totalChanges} code files changed since last doc update`,
      priority: "low"
    });
  }
  return actions;
}
function generateHandoff(state, git, actions) {
  const date = today();
  const recentWork = git.recentCommitMessages.filter((m) => !m.startsWith("Merge") && !m.startsWith("chore:")).slice(0, 10).map((m) => `- ${m}`).join("\n");
  const logContent = read(LOG_FILE);
  const logEntries = logContent.match(/^## \[.+$/gm)?.slice(0, 5) || [];
  let openQuestions = "";
  const indexPath = path.join(THINKING_DIR, "INDEX.md");
  if (exists(indexPath)) {
    const indexContent = read(indexPath);
    const oqSection = indexContent.match(/## Open Questions[\s\S]*?(?=\n## |$)/);
    if (oqSection) openQuestions = oqSection[0];
  }
  const keyFiles = git.newCodeFiles.slice(0, 10).map((f) => `- \`${f}\``).join("\n");
  const todos = actions.filter((a) => a.priority !== "low").map((a) => `- [ ] ${a.description}`).join("\n");
  return `# Handoff \u2014 ${date}

## What happened this session
${recentWork || "(no commits this session)"}

## Recent doc activity
${logEntries.map((e) => e.replace("## ", "- ")).join("\n") || "(no recent activity)"}

## Knowledge base state
- **Mode:** ${state.mode}
- **Patterns:** ${state.patternCount}
- **Decisions:** ${state.decisionCount}
- **SYSTEM-MAP:** ${state.hasSystemMap ? "exists" : "MISSING"}

## Next steps
${todos || "- [ ] No pending doc actions"}

${openQuestions ? `## Open questions
${openQuestions}` : ""}

## Key files changed
${keyFiles || "(no new files)"}

## Pending doc actions
${actions.map((a) => `- [${a.priority}] ${a.type}: ${a.description}`).join("\n") || "None \u2014 docs are current."}
`;
}
function main() {
  const state = detectState();
  const GITLESS_MODES = /* @__PURE__ */ new Set(["capture-check", "thinking-candidate", "bootstrap-thinking", "kb-check", "memory-check", "report"]);
  const git = GITLESS_MODES.has(MODE) ? { lastDocCommit: "", lastDocDate: "", changedCodeFiles: [], newCodeFiles: [], deletedCodeFiles: [], recentCommitMessages: [] } : getGitChanges();
  if (MODE === "research") {
    const topic = process.argv.slice(process.argv.indexOf("--research") + 1).filter((a) => !a.startsWith("-")).join(" ") || "untitled";
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
    const researchDir = path.join(THINKING_DIR, "research");
    if (!fs.existsSync(researchDir)) fs.mkdirSync(researchDir, { recursive: true });
    const filePath = path.join(researchDir, `${slug}.md`);
    if (exists(filePath)) {
      console.log(`
\u{1F935} Jeeves \u2014 Research: ${topic}
`);
      console.log(`File exists: thinking/research/${slug}.md`);
      console.log(`Agent: Read the existing file, then do additional research and APPEND new findings.`);
      console.log(`Add today's date, sources, and key data points.
`);
    } else {
      const template = `# Research: ${topic}

**Started:** ${today()}
**Status:** In progress

## Key Findings

(Agent: fill this in with research results)

## Sources

| Source | URL | Date | Key takeaway |
|--------|-----|------|--------------|

## Raw Notes

(Agent: dump detailed notes here)

## Implications

What this means for our project:
- 
`;
      fs.writeFileSync(filePath, template);
      console.log(`
\u{1F935} Jeeves \u2014 Research: ${topic}
`);
      console.log(`Created: thinking/research/${slug}.md`);
      console.log(`Agent: Research "${topic}" using WebSearch/WebFetch. Fill in Key Findings, Sources table, and Implications.`);
      console.log(`Save everything \u2014 the user may close the tab at any time.
`);
    }
    const indexPath = path.join(THINKING_DIR, "INDEX.md");
    if (exists(indexPath)) {
      const indexContent = read(indexPath);
      if (!indexContent.includes(`research/${slug}.md`)) {
        const line = `| ${topic} | research/${slug}.md | In progress | ${today()} |`;
        if (indexContent.includes("## Active Topics")) {
          const updated = indexContent.replace(
            /(## Active Topics\n\|.*\|\n\|.*\|\n)/,
            `$1${line}
`
          );
          if (updated !== indexContent) {
            fs.writeFileSync(indexPath, updated);
            console.log(`Updated thinking/INDEX.md with research topic.`);
          }
        }
      }
    }
    return;
  }
  if (MODE === "save") {
    const name = process.argv.slice(process.argv.indexOf("--save") + 1).filter((a) => !a.startsWith("-")).join(" ") || "untitled";
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
    const artifactsDir = path.join(THINKING_DIR, "artifacts");
    if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });
    const filePath = path.join(artifactsDir, `${slug}.md`);
    console.log(`
\u{1F935} Jeeves \u2014 Save Artifact: ${name}
`);
    if (exists(filePath)) {
      console.log(`File exists: thinking/artifacts/${slug}.md`);
      console.log(`Agent: Update the existing artifact with new content.`);
    } else {
      const template = `# ${name}

**Created:** ${today()}
**Status:** Draft
**Session:** (link to session file if applicable)

---

(Agent: write the artifact content here)
`;
      fs.writeFileSync(filePath, template);
      console.log(`Created: thinking/artifacts/${slug}.md`);
      console.log(`Agent: Write the artifact content. This could be a draft, plan, timeline, brief, analysis, or any deliverable.`);
    }
    console.log(`
For CSVs or data files, save to thinking/artifacts/${slug}.csv (or appropriate extension).
`);
    return;
  }
  if (MODE === "summary") {
    console.log(`
\u{1F935} Jeeves \u2014 Summary
`);
    const decisionDirs = [
      path.join(THINKING_DIR, "decisions"),
      path.join(DOCS_DIR, "decisions")
    ];
    const decisions = [];
    for (const dir of decisionDirs) {
      if (!exists(dir)) continue;
      const source = dir.includes("thinking") ? "brainstorm" : "implemented";
      for (const f of fs.readdirSync(dir).filter((f2) => f2.endsWith(".md"))) {
        decisions.push({ name: f.replace(".md", "").replace(/-/g, " "), file: path.relative(ROOT, path.join(dir, f)), source });
      }
    }
    let openQuestions = "";
    const indexPath = path.join(THINKING_DIR, "INDEX.md");
    if (exists(indexPath)) {
      const content = read(indexPath);
      const oqMatch = content.match(/## Open Questions[\s\S]*?(?=\n## |$)/);
      if (oqMatch) openQuestions = oqMatch[0];
    }
    const topicsDir = path.join(THINKING_DIR, "topics");
    const topics = [];
    if (exists(topicsDir)) {
      for (const f of fs.readdirSync(topicsDir).filter((f2) => f2.endsWith(".md"))) {
        topics.push(f.replace(".md", "").replace(/-/g, " "));
      }
    }
    const researchDir = path.join(THINKING_DIR, "research");
    const research = [];
    if (exists(researchDir)) {
      for (const f of fs.readdirSync(researchDir).filter((f2) => f2.endsWith(".md"))) {
        research.push(f.replace(".md", "").replace(/-/g, " "));
      }
    }
    const artifactsDir = path.join(THINKING_DIR, "artifacts");
    const artifacts = [];
    if (exists(artifactsDir)) {
      for (const f of fs.readdirSync(artifactsDir)) {
        artifacts.push(f);
      }
    }
    const sessionsDir = path.join(THINKING_DIR, "sessions");
    const sessionCount = exists(sessionsDir) ? fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".md")).length : 0;
    const patternCount = exists(path.join(DOCS_DIR, "patterns")) ? fs.readdirSync(path.join(DOCS_DIR, "patterns")).filter((f) => f.endsWith(".md")).length : 0;
    console.log(`\u{1F4CA} Project Summary`);
    console.log(`Sessions: ${sessionCount} | Topics: ${topics.length} | Research: ${research.length} | Artifacts: ${artifacts.length}`);
    console.log("");
    if (decisions.length > 0) {
      console.log(`## Decisions (${decisions.length})`);
      const implemented = decisions.filter((d) => d.source === "implemented");
      const brainstorm = decisions.filter((d) => d.source === "brainstorm");
      if (implemented.length > 0) {
        console.log(`
Implemented (${implemented.length}):`);
        for (const d of implemented) console.log(`  \u2713 ${d.name}`);
      }
      if (brainstorm.length > 0) {
        console.log(`
Brainstorm only (${brainstorm.length}):`);
        for (const d of brainstorm) console.log(`  \u25CB ${d.name}`);
      }
      console.log("");
    }
    if (topics.length > 0) {
      console.log(`## Active Topics (${topics.length})`);
      for (const t of topics) console.log(`  - ${t}`);
      console.log("");
    }
    if (research.length > 0) {
      console.log(`## Research (${research.length})`);
      for (const r of research) console.log(`  - ${r}`);
      console.log("");
    }
    if (artifacts.length > 0) {
      console.log(`## Artifacts (${artifacts.length})`);
      for (const a of artifacts) console.log(`  - ${a}`);
      console.log("");
    }
    if (openQuestions) {
      console.log(openQuestions);
      console.log("");
    }
    if (patternCount > 0) {
      console.log(`## Code KB: ${patternCount} patterns, ${decisions.filter((d) => d.source === "implemented").length} code decisions`);
      console.log("");
    }
    console.log(`Agent: Read this summary to the user. If they want details on any item, read the file.
`);
    return;
  }
  if (MODE === "export") {
    console.log(`
\u{1F935} Jeeves \u2014 Export
`);
    const exportPath = path.join(THINKING_DIR, `export-${today()}.md`);
    const indexPath = path.join(THINKING_DIR, "INDEX.md");
    const indexContent = exists(indexPath) ? read(indexPath) : "";
    const sections = [`# Project Summary \u2014 ${today()}
`];
    const decisionDirs = [path.join(DOCS_DIR, "decisions"), path.join(THINKING_DIR, "decisions")];
    const allDecisions = [];
    for (const dir of decisionDirs) {
      if (!exists(dir)) continue;
      const source = dir.includes("thinking") ? "proposed" : "implemented";
      for (const f of fs.readdirSync(dir).filter((f2) => f2.endsWith(".md"))) {
        allDecisions.push({
          name: f.replace(".md", "").replace(/-/g, " "),
          content: read(path.join(dir, f)),
          source
        });
      }
    }
    if (allDecisions.length > 0) {
      sections.push(`## Decisions (${allDecisions.length})
`);
      for (const d of allDecisions) {
        const decisionMatch = d.content.match(/## (?:What we decided|Decision)\n([\s\S]*?)(?=\n## |$)/);
        const whyMatch = d.content.match(/## (?:Why|Why we chose this|Context)\n([\s\S]*?)(?=\n## |$)/);
        sections.push(`### ${d.name} (${d.source})`);
        if (decisionMatch) sections.push(decisionMatch[1].trim());
        if (whyMatch) sections.push(`*Why:* ${whyMatch[1].trim()}`);
        sections.push("");
      }
    }
    const oqMatch = indexContent.match(/## Open Questions[\s\S]*?(?=\n## |$)/);
    if (oqMatch) {
      sections.push(oqMatch[0]);
      sections.push("");
    }
    const researchDir = path.join(THINKING_DIR, "research");
    if (exists(researchDir)) {
      const researchFiles = fs.readdirSync(researchDir).filter((f) => f.endsWith(".md"));
      if (researchFiles.length > 0) {
        sections.push(`## Research (${researchFiles.length})
`);
        for (const f of researchFiles) {
          const content = read(path.join(researchDir, f));
          const findingsMatch = content.match(/## Key Findings\n([\s\S]*?)(?=\n## |$)/);
          const name = f.replace(".md", "").replace(/-/g, " ");
          sections.push(`### ${name}`);
          if (findingsMatch) sections.push(findingsMatch[1].trim());
          else sections.push("(no findings captured yet)");
          sections.push("");
        }
      }
    }
    const topicsDir = path.join(THINKING_DIR, "topics");
    if (exists(topicsDir)) {
      const topicFiles = fs.readdirSync(topicsDir).filter((f) => f.endsWith(".md"));
      if (topicFiles.length > 0) {
        sections.push(`## Active Topics (${topicFiles.length})
`);
        for (const f of topicFiles) {
          const content = read(path.join(topicsDir, f));
          const thinkingMatch = content.match(/## Current thinking\n([\s\S]*?)(?=\n## |$)/);
          const name = f.replace(".md", "").replace(/-/g, " ");
          sections.push(`### ${name}`);
          if (thinkingMatch) sections.push(thinkingMatch[1].trim());
          sections.push("");
        }
      }
    }
    const exportContent = sections.join("\n");
    fs.writeFileSync(exportPath, exportContent);
    console.log(`Written to: thinking/export-${today()}.md`);
    console.log(`${allDecisions.length} decisions, ${exportContent.split("\n").length} lines`);
    console.log(`
Agent: Tell the user the export is ready. They can share this file with their team.
`);
    return;
  }
  if (MODE === "reconcile") {
    console.log("\n\u{1F935} Jeeves \u2014 Reconcile\n");
    console.log("Checking all docs for drift against current project state...\n");
    const driftItems = [];
    for (const dir of [path.join(DOCS_DIR, "decisions"), path.join(THINKING_DIR, "decisions")]) {
      if (!exists(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((f2) => f2.endsWith(".md"))) {
        const content = read(path.join(dir, f));
        const relPath = path.relative(ROOT, path.join(dir, f));
        const filePaths = [...content.matchAll(/`([a-zA-Z][a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})`/g)].map((m) => m[1]).filter((p) => !p.startsWith("http") && !p.startsWith("@") && p.includes("/"));
        const brokenRefs = filePaths.filter((p) => !exists(path.join(ROOT, p)));
        if (brokenRefs.length > 0) {
          driftItems.push({
            file: relPath,
            type: "decision",
            severity: "stale",
            issue: `References ${brokenRefs.length} file(s) that no longer exist: ${brokenRefs.slice(0, 3).join(", ")}`
          });
        }
      }
    }
    const topicsDir = path.join(THINKING_DIR, "topics");
    if (exists(topicsDir)) {
      for (const f of fs.readdirSync(topicsDir).filter((f2) => f2.endsWith(".md"))) {
        const content = read(path.join(topicsDir, f));
        const relPath = `thinking/topics/${f}`;
        const topicTime = gitCommitTime(relPath);
        const topicWords = new Set(f.replace(".md", "").split("-"));
        for (const decDir of [path.join(DOCS_DIR, "decisions"), path.join(THINKING_DIR, "decisions")]) {
          if (!exists(decDir)) continue;
          for (const df of fs.readdirSync(decDir).filter((df2) => df2.endsWith(".md"))) {
            const decWords = df.replace(".md", "").split("-");
            const overlap = decWords.filter((w) => topicWords.has(w)).length;
            if (overlap >= 2) {
              const decTime = gitCommitTime(path.relative(ROOT, path.join(decDir, df)));
              if (topicTime > 0 && decTime > topicTime) {
                driftItems.push({
                  file: relPath,
                  type: "topic",
                  severity: "outdated",
                  issue: `Topic not updated since decision was made: ${df.replace(".md", "")}`
                });
                break;
              }
            }
          }
        }
        if (content.includes("## Proposals") || content.includes("## Proposals (not yet confirmed)")) {
          const proposalSection = content.match(/## Proposals[\s\S]*?(?=\n## |$)/);
          if (proposalSection && proposalSection[0].length > 50 && topicTime > 0) {
            const decDir = path.join(DOCS_DIR, "decisions");
            if (exists(decDir)) {
              const newestDecTime = fs.readdirSync(decDir).filter((df) => df.endsWith(".md")).map((df) => gitCommitTime(path.relative(ROOT, path.join(decDir, df)))).sort((a, b) => b - a)[0] || 0;
              if (newestDecTime > topicTime) {
                driftItems.push({
                  file: relPath,
                  type: "topic",
                  severity: "outdated",
                  issue: `Has proposals that may have been decided since last update \u2014 check against recent decisions`
                });
              }
            }
          }
        }
      }
    }
    const docFileRefs = /* @__PURE__ */ new Map();
    const allReconcileDocs = getAllMdFiles(DOCS_DIR);
    for (const docPath of allReconcileDocs) {
      const relDoc = path.relative(ROOT, docPath);
      if (relDoc.includes("/analyses/")) continue;
      if (relDoc.includes("CONCEPT-INDEX") || relDoc.includes("concept-index")) continue;
      const content = read(docPath);
      const refs = [...content.matchAll(/`([a-zA-Z][a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})`/g)].map((m) => m[1].replace(/:\d+(:\d+)?$/, "")).filter((p) => !p.startsWith("http") && !p.startsWith("@") && p.includes("/") && exists(path.join(ROOT, p)));
      if (refs.length >= 3) {
        docFileRefs.set(relDoc, new Set(refs));
      }
    }
    const docPaths = [...docFileRefs.keys()];
    const overlaps = [];
    for (let i = 0; i < docPaths.length; i++) {
      for (let j = i + 1; j < docPaths.length; j++) {
        const refsA = docFileRefs.get(docPaths[i]);
        const refsB = docFileRefs.get(docPaths[j]);
        const shared = [...refsA].filter((r) => refsB.has(r));
        const overlapRatio = shared.length / Math.min(refsA.size, refsB.size);
        if (shared.length >= 3 && overlapRatio > 0.5) {
          overlaps.push({
            docA: docPaths[i],
            docB: docPaths[j],
            shared: shared.length,
            totalA: refsA.size,
            totalB: refsB.size,
            sharedFiles: shared.slice(0, 5)
          });
        }
      }
    }
    if (overlaps.length > 0) {
      for (const o of overlaps) {
        driftItems.push({
          file: `${o.docA} + ${o.docB}`,
          type: "pattern",
          severity: "outdated",
          issue: `OVERLAP: ${o.shared} shared file refs (${o.totalA} in first, ${o.totalB} in second). Shared: ${o.sharedFiles.join(", ")}. Consider consolidating or linking.`
        });
      }
    }
    if (exists(DOCS_DIR)) {
      const analysesDir = path.join(DOCS_DIR, "analyses");
      for (const f of fs.readdirSync(DOCS_DIR).filter((f2) => f2.endsWith(".md"))) {
        if (["SYSTEM-MAP.md", "log.md", "CONCEPT-INDEX.md", "codebase-audit.md", "review-queue.md", "context-log.md", "FUTURE.md"].includes(f)) continue;
        const content = read(path.join(DOCS_DIR, f));
        const isAnalysis = /analysis|readiness|investigation|incident|audit report|snapshot|assessment|evaluation/i.test(content) && /\b\d{4}-\d{2}-\d{2}\b/.test(f);
        if (isAnalysis && !exists(analysesDir)) {
          driftItems.push({
            file: `docs/internal/${f}`,
            type: "pattern",
            severity: "outdated",
            issue: `Looks like a time-boxed analysis/report. Consider creating docs/internal/analyses/ and moving it there so it's visibly a snapshot, not a living doc.`
          });
        }
      }
    }
    if (driftItems.length === 0) {
      console.log("All docs appear current. No drift detected.\n");
    } else {
      const superseded = driftItems.filter((d) => d.severity === "superseded");
      const stale = driftItems.filter((d) => d.severity === "stale");
      const outdated = driftItems.filter((d) => d.severity === "outdated");
      if (superseded.length > 0) {
        console.log(`\u{1F534} SUPERSEDED (${superseded.length}) \u2014 these docs may have been replaced:
`);
        for (const d of superseded) {
          console.log(`  ${d.file}`);
          console.log(`    ${d.issue}`);
          console.log(`    Agent: Add banner "\u26A0\uFE0F POSSIBLY SUPERSEDED" to the top of this doc.
`);
        }
      }
      if (stale.length > 0) {
        console.log(`\u{1F7E1} STALE REFERENCES (${stale.length}) \u2014 these docs reference things that changed:
`);
        for (const d of stale) {
          console.log(`  ${d.file}`);
          console.log(`    ${d.issue}`);
          console.log(`    Agent: Update the references or add a note about what changed.
`);
        }
      }
      if (outdated.length > 0) {
        console.log(`\u{1F7E2} POSSIBLY OUTDATED (${outdated.length}) \u2014 these may need review:
`);
        for (const d of outdated) {
          console.log(`  ${d.file}`);
          console.log(`    ${d.issue}
`);
        }
      }
      console.log(`
Total: ${driftItems.length} items to review.`);
      console.log(`Agent: For each SUPERSEDED doc, add a banner at the top pointing to the replacement.`);
      console.log(`For STALE docs, update references. For OUTDATED, read and verify if still accurate.
`);
    }
    return;
  }
  if (MODE === "driftcheck") {
    console.log("\n\u{1F935} Jeeves \u2014 Drift Check\n");
    console.log("Comparing specs/plans against what was actually built...\n");
    const specDirs = [
      path.join(ROOT, "docs", "superpowers", "specs"),
      path.join(ROOT, "docs", "specs"),
      path.join(ROOT, ".claude", "docs"),
      path.join(THINKING_DIR, "specs")
    ];
    const planDirs = [
      path.join(ROOT, "docs", "superpowers", "plans"),
      path.join(ROOT, "docs", "plans"),
      path.join(THINKING_DIR, "plans")
    ];
    const specs = [];
    const plans = [];
    for (const dir of specDirs) {
      if (!exists(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((f2) => f2.endsWith(".md"))) {
        specs.push({
          name: f.replace(".md", "").replace(/-/g, " "),
          file: path.relative(ROOT, path.join(dir, f)),
          content: read(path.join(dir, f))
        });
      }
    }
    for (const dir of planDirs) {
      if (!exists(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((f2) => f2.endsWith(".md"))) {
        const content = read(path.join(dir, f));
        const tasks = [...content.matchAll(/^(?:- \[[ x]\]|\d+\.) (.+)$/gm)].map((m) => m[1]);
        plans.push({
          name: f.replace(".md", "").replace(/-/g, " "),
          file: path.relative(ROOT, path.join(dir, f)),
          content,
          tasks
        });
      }
    }
    if (specs.length === 0 && plans.length === 0) {
      console.log("No spec or plan docs found.");
      console.log("Looked in: docs/superpowers/specs/, docs/superpowers/plans/, thinking/specs/, thinking/plans/");
      console.log("\nIf you have spec/plan docs elsewhere, move them to one of these directories.\n");
      return;
    }
    console.log(`Found: ${specs.length} spec(s), ${plans.length} plan(s)
`);
    for (const spec of specs) {
      console.log(`\u{1F4CB} Spec: ${spec.name}`);
      console.log(`   File: ${spec.file}`);
      const specPaths = [...spec.content.matchAll(/`([a-zA-Z][a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})`/g)].map((m) => m[1]).filter((p) => !p.startsWith("http") && !p.startsWith("@") && p.includes("/"));
      const uniquePaths = [...new Set(specPaths)];
      const existing = uniquePaths.filter((p) => exists(path.join(ROOT, p)));
      const missing = uniquePaths.filter((p) => !exists(path.join(ROOT, p)));
      if (uniquePaths.length > 0) {
        console.log(`   Files referenced: ${uniquePaths.length} (${existing.length} exist, ${missing.length} missing)`);
        if (missing.length > 0) {
          console.log(`   Missing: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5})` : ""}`);
        }
      }
      const entityMentions = [...spec.content.matchAll(/(?:model|entity|table)\s+`?(\w+)`?/gi)].map((m) => m[1]);
      if (entityMentions.length > 0) {
        const schemaEntities = getSchemaEntities();
        const mentioned = [...new Set(entityMentions)];
        const implemented = mentioned.filter((e) => schemaEntities.some((s) => s.toLowerCase() === e.toLowerCase()));
        const notImplemented = mentioned.filter((e) => !schemaEntities.some((s) => s.toLowerCase() === e.toLowerCase()));
        if (notImplemented.length > 0) {
          console.log(`   Entities not in schema: ${notImplemented.join(", ")}`);
        }
      }
      console.log(`   Agent: Read this spec and compare against what was actually built. Flag any drift.
`);
    }
    for (const plan of plans) {
      console.log(`\u{1F4DD} Plan: ${plan.name}`);
      console.log(`   File: ${plan.file}`);
      if (plan.tasks.length > 0) {
        const completed = [...plan.content.matchAll(/^- \[x\] (.+)$/gm)].map((m) => m[1]);
        const incomplete = [...plan.content.matchAll(/^- \[ \] (.+)$/gm)].map((m) => m[1]);
        console.log(`   Tasks: ${plan.tasks.length} total, ${completed.length} done, ${incomplete.length} remaining`);
        if (incomplete.length > 0) {
          console.log(`   Remaining:`);
          for (const t of incomplete.slice(0, 5)) {
            console.log(`     - [ ] ${t}`);
          }
          if (incomplete.length > 5) console.log(`     ... +${incomplete.length - 5} more`);
        }
      } else {
        console.log(`   No checkbox/numbered tasks found in plan.`);
      }
      console.log(`   Agent: Read this plan and verify each task against the codebase. Mark what's actually done.
`);
    }
    console.log(`
Agent: For each spec/plan above, read the doc and compare against the actual code.`);
    console.log(`Report: what was built as specified, what diverged, what was skipped, what was added.
`);
    return;
  }
  if (MODE === "trace") {
    const feature = process.argv.slice(process.argv.indexOf("--trace") + 1).filter((a) => !a.startsWith("-")).join(" ") || "";
    console.log(`
\u{1F935} Jeeves \u2014 Trace Feature
`);
    if (!feature) {
      console.log("Usage: jeeves --trace <feature name>");
      console.log('Example: jeeves --trace "email sync pipeline"');
      console.log("\nAgent: Ask the user which feature to trace.\n");
      return;
    }
    const conceptIndex = buildConceptIndex();
    const featureWords = feature.toLowerCase().split(/\s+/);
    const related = conceptIndex.filter(
      (e) => featureWords.some((w) => e.concept.includes(w))
    );
    const relatedDocs = [...new Set(related.flatMap((r) => r.docs))];
    const relatedFiles = [...new Set(related.flatMap((r) => r.files))];
    console.log(`Tracing: "${feature}"
`);
    if (relatedDocs.length > 0) {
      console.log(`\u{1F4C4} Related docs (${relatedDocs.length}):`);
      for (const d of relatedDocs.slice(0, 15)) console.log(`  - ${d}`);
      if (relatedDocs.length > 15) console.log(`  ... +${relatedDocs.length - 15} more`);
    }
    if (relatedFiles.length > 0) {
      console.log(`
\u{1F4C1} Related code files (${relatedFiles.length}):`);
      for (const f of relatedFiles.slice(0, 15)) console.log(`  - ${f}`);
      if (relatedFiles.length > 15) console.log(`  ... +${relatedFiles.length - 15} more`);
    }
    console.log(`
Agent: Trace "${feature}" end-to-end through the codebase.`);
    console.log(`Read the related docs and code files above. Then produce a trace doc:
`);
    console.log(`1. Start from the user-facing entry point (UI, API route, CLI command)`);
    console.log(`2. Follow the data flow through each layer (route \u2192 action \u2192 service \u2192 DB)`);
    console.log(`3. Note every file touched and what it does in the flow`);
    console.log(`4. Note integration points (external APIs, background jobs, caches)`);
    console.log(`5. Write the trace to docs/internal/patterns/${feature.replace(/\s+/g, "-")}-trace.md
`);
    return;
  }
  if (MODE === "extract") {
    console.log(`
\u{1F935} Jeeves \u2014 Extract Knowledge
`);
    console.log("Agent: Review this entire conversation and extract knowledge that should be persisted.\n");
    console.log("For each piece of knowledge, file it to the right place:\n");
    console.log("| What you learned | File to |");
    console.log("|-----------------|---------|");
    console.log("| A confirmed decision | docs/internal/decisions/<name>.md (if code exists) or thinking/decisions/<name>.md |");
    console.log("| A non-obvious discovery about the code | Relevant pattern doc's Gotchas section |");
    console.log("| Business context or domain knowledge | thinking/topics/<name>.md or docs/internal/context-log.md |");
    console.log("| A bug or issue found | docs/internal/codebase-audit.md |");
    console.log("| An architecture insight | docs/internal/SYSTEM-MAP.md or relevant pattern doc |");
    console.log("| A rejected approach (and why) | Relevant thinking/topics/ file under 'Rejected approaches' |");
    console.log("| Research findings | thinking/research/<topic>.md |");
    console.log("| An open question raised | thinking/INDEX.md Open Questions table |");
    console.log("");
    console.log("Rules:");
    console.log("- File at least ONE thing. If nothing is non-obvious, log that explicitly.");
    console.log("- Update existing docs before creating new ones.");
    console.log("- Append to docs/internal/log.md after each file-back.\n");
    return;
  }
  if (MODE === "design") {
    console.log(`
\u{1F935} Jeeves \u2014 Design Doc Structure
`);
    const schemaEntities = getSchemaEntities();
    const existingPatterns = exists(PATTERNS_DIR) ? fs.readdirSync(PATTERNS_DIR).filter((f) => f.endsWith(".md")).map((f) => f.replace(".md", "")) : [];
    const existingDecisions = [
      ...exists(path.join(DOCS_DIR, "decisions")) ? fs.readdirSync(path.join(DOCS_DIR, "decisions")).filter((f) => f.endsWith(".md")).map((f) => f.replace(".md", "")) : [],
      ...exists(path.join(THINKING_DIR, "decisions")) ? fs.readdirSync(path.join(THINKING_DIR, "decisions")).filter((f) => f.endsWith(".md")).map((f) => f.replace(".md", "")) : []
    ];
    const codeFilter = CODE_FILTER;
    const allCode = run(`git -c core.quotepath=off ls-files 2>/dev/null | ${codeFilter}`);
    const codeFiles = allCode ? allCode.split("\n").filter(Boolean) : [];
    const codeDirs = /* @__PURE__ */ new Map();
    for (const f of codeFiles) {
      const parts = f.split("/");
      if (parts.length >= 2) {
        const dir = parts.slice(0, Math.min(parts.length - 1, 3)).join("/");
        codeDirs.set(dir, (codeDirs.get(dir) || 0) + 1);
      }
    }
    const featureDirs = [...codeDirs.entries()].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]);
    console.log(`Current state:`);
    console.log(`  Schema entities: ${schemaEntities.length}`);
    console.log(`  Pattern docs: ${existingPatterns.length}`);
    console.log(`  Decision docs: ${existingDecisions.length}`);
    console.log(`  Code directories with 3+ files: ${featureDirs.length}
`);
    const suggestedPatterns = [];
    for (const [dir, count] of featureDirs) {
      const dirName = dir.split("/").pop() || dir;
      const hasPattern = existingPatterns.some(
        (p) => p.includes(dirName) || dirName.includes(p.replace(/-/g, ""))
      );
      if (!hasPattern) {
        suggestedPatterns.push(`${dir}/ (${count} files) \u2192 patterns/${dirName}.md`);
      }
    }
    if (suggestedPatterns.length > 0) {
      console.log(`\u{1F4DD} Suggested pattern docs to create (${suggestedPatterns.length}):
`);
      for (const s of suggestedPatterns.slice(0, 15)) {
        console.log(`  CREATE: ${s}`);
      }
      if (suggestedPatterns.length > 15) console.log(`  ... +${suggestedPatterns.length - 15} more`);
    } else {
      console.log(`All major code directories have pattern docs. Nice.
`);
    }
    const recentCommits = run("git log --format='%s' -20");
    const commitMsgs = recentCommits ? recentCommits.split("\n") : [];
    const decisionKeywords = commitMsgs.filter(
      (m) => /chose|switch|migrat|replac|instead of|over|rather than|because/i.test(m)
    );
    if (decisionKeywords.length > 0) {
      console.log(`
\u{1F4CB} Recent commits that hint at undocumented decisions:
`);
      for (const m of decisionKeywords) {
        console.log(`  "${m}"`);
      }
    }
    console.log(`
\u{1F4D0} Docs NOT to create (already covered):`);
    for (const p of existingPatterns.slice(0, 10)) {
      console.log(`  \u2713 patterns/${p}.md`);
    }
    console.log(`
Agent: Review the suggestions above. For each CREATE item, ask the user if they want it.`);
    console.log(`Then create the docs using the pattern/decision templates.
`);
    return;
  }
  if (MODE === "archive") {
    const label = process.argv.slice(process.argv.indexOf("--archive") + 1).filter((a) => !a.startsWith("-")).join(" ") || today();
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
    const archiveDir = path.join(THINKING_DIR, "archive", slug);
    console.log(`
\u{1F935} Jeeves \u2014 Archive & Fresh Start
`);
    if (fs.existsSync(archiveDir)) {
      console.log(`Archive "${slug}" already exists at thinking/archive/${slug}/`);
      console.log(`Choose a different name or delete the existing archive.
`);
      return;
    }
    const thinkingExists = exists(THINKING_DIR);
    const docsExists = exists(DOCS_DIR);
    const hasTopics = exists(path.join(THINKING_DIR, "topics")) && fs.readdirSync(path.join(THINKING_DIR, "topics")).filter((f) => f.endsWith(".md")).length > 0;
    const hasSessions = exists(path.join(THINKING_DIR, "sessions")) && fs.readdirSync(path.join(THINKING_DIR, "sessions")).filter((f) => f.endsWith(".md")).length > 0;
    if (!hasTopics && !hasSessions) {
      console.log("Nothing to archive \u2014 no topics or sessions found.\n");
      return;
    }
    fs.mkdirSync(archiveDir, { recursive: true });
    const archived = [];
    for (const subdir of ["topics", "sessions", "decisions", "research", "artifacts"]) {
      const src = path.join(THINKING_DIR, subdir);
      const dst = path.join(archiveDir, subdir);
      if (exists(src) && fs.readdirSync(src).filter((f) => f.endsWith(".md")).length > 0) {
        fs.mkdirSync(dst, { recursive: true });
        for (const f of fs.readdirSync(src)) {
          const srcFile = path.join(src, f);
          if (fs.statSync(srcFile).isFile()) {
            fs.copyFileSync(srcFile, path.join(dst, f));
            fs.unlinkSync(srcFile);
            archived.push(`${subdir}/${f}`);
          }
        }
      }
    }
    const indexSrc = path.join(THINKING_DIR, "INDEX.md");
    if (exists(indexSrc)) {
      fs.copyFileSync(indexSrc, path.join(archiveDir, "INDEX.md"));
      archived.push("INDEX.md");
    }
    const freshIndex = `# Thinking Index

**Last session:** (none yet)
**Previous archive:** thinking/archive/${slug}/

## Active Topics
| Topic | File | Status | Last updated |
|-------|------|--------|-------------|

## Key Decisions
| Decision | Date | File |
|----------|------|------|

## Open Questions
| Question | Raised | Blocking? |
|----------|--------|-----------|
`;
    fs.writeFileSync(indexSrc, freshIndex);
    console.log(`Archived ${archived.length} files to thinking/archive/${slug}/
`);
    for (const a of archived.slice(0, 10)) console.log(`  \u2192 ${a}`);
    if (archived.length > 10) console.log(`  ... +${archived.length - 10} more`);
    console.log(`
Fresh INDEX.md created with link to archive.`);
    console.log(`Previous thinking is preserved and can be referenced at thinking/archive/${slug}/`);
    console.log(`
You're starting fresh. All topics, sessions, and decisions are archived.
`);
    return;
  }
  if (MODE === "annotate") {
    console.log("\n\u{1F935} Jeeves \u2014 Annotate Code\n");
    const codeFilter = CODE_FILTER;
    const allCode = run(`git -c core.quotepath=off ls-files 2>/dev/null | ${codeFilter}`);
    const codeFiles = allCode ? allCode.split("\n").filter(Boolean) : [];
    const targets = [];
    for (const file of codeFiles) {
      const fullPath = path.join(ROOT, file);
      if (!exists(fullPath)) continue;
      const content = read(fullPath);
      const lines = content.split("\n");
      const totalLines = lines.length;
      if (totalLines < 10) continue;
      const commentLines = lines.filter((l) => {
        const trimmed = l.trim();
        return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("#");
      }).length;
      const ratio = commentLines / totalLines;
      const hasDecisions = /if.*else|switch|ternary|\?.*:/i.test(content) && totalLines > 30;
      const hasComplexLogic = /try.*catch|Promise\.all|async.*await.*async|\.reduce\(|\.flatMap\(/i.test(content);
      if (totalLines > 20 && ratio < 0.05 && (hasDecisions || hasComplexLogic)) {
        targets.push({ file, lines: totalLines, commentLines, ratio, hasDecisions, hasComplexLogic });
      }
    }
    targets.sort((a, b) => b.lines - a.lines);
    if (targets.length === 0) {
      console.log("All code files are adequately commented. Nothing to annotate.\n");
    } else {
      console.log(`${targets.length} file(s) need comments:
`);
      for (const t of targets.slice(0, 20)) {
        const reasons = [];
        if (t.hasDecisions) reasons.push("has branching logic");
        if (t.hasComplexLogic) reasons.push("has complex async/functional patterns");
        console.log(`ACTION [annotate]: ${t.file} (${t.lines} lines, ${t.commentLines} comments, ${(t.ratio * 100).toFixed(0)}%)`);
        console.log(`   Add WHY comments to: ${reasons.join(", ")}`);
        console.log(`   Focus on: non-obvious decisions, gotchas, business rules, error handling rationale`);
        console.log("");
      }
      console.log(`Agent: Read each file above and add comments explaining WHY, not WHAT.`);
      console.log(`Good: // Retry 3x because Gmail API returns 429 under burst load`);
      console.log(`Bad:  // Retry the request`);
      console.log(`Skip: Obvious code (imports, simple assignments, standard CRUD)
`);
    }
    return;
  }
  if (MODE === "verify") {
    console.log("\n\u{1F935} Jeeves \u2014 Verify Comments\n");
    const codeFilter = CODE_FILTER;
    const allCode = run(`git -c core.quotepath=off ls-files 2>/dev/null | ${codeFilter}`);
    const codeFiles = allCode ? allCode.split("\n").filter(Boolean) : [];
    const commentsToVerify = [];
    for (const file of codeFiles) {
      const fullPath = path.join(ROOT, file);
      if (!exists(fullPath)) continue;
      const content = read(fullPath);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith("//") && trimmed.length > 15 && !trimmed.startsWith("///") && !trimmed.startsWith("// ---") && !trimmed.startsWith("// ===")) {
          const comment = trimmed;
          const nearbyCode = lines.slice(i + 1, i + 4).join("\n");
          const makesClaimPattern = /always|never|must|should|maximum|minimum|only|exactly|ensures|guarantees|prevents|returns|throws|calls|creates|deletes|updates|limit|timeout|retry|fallback|default/i;
          if (makesClaimPattern.test(comment)) {
            commentsToVerify.push({ file, line: i + 1, comment, nearbyCode });
          }
        }
      }
    }
    if (commentsToVerify.length === 0) {
      console.log("No verifiable claims found in comments. Either code has few comments or they're purely descriptive.\n");
    } else {
      console.log(`${commentsToVerify.length} comment(s) make verifiable claims:
`);
      for (const c of commentsToVerify.slice(0, 30)) {
        console.log(`VERIFY: ${c.file}:${c.line}`);
        console.log(`   Comment: ${c.comment}`);
        console.log(`   Code:    ${c.nearbyCode.split("\n")[0].trim()}`);
        console.log("");
      }
      console.log(`Agent: For each comment above, read the surrounding code and verify the claim.`);
      console.log(`If the comment is wrong \u2192 fix the comment (or flag the code as a bug).`);
      console.log(`If the comment is right \u2192 leave it.`);
      console.log(`If the comment is outdated (code changed, comment didn't) \u2192 update the comment.
`);
    }
    return;
  }
  if (MODE === "index") {
    console.log("\n\u{1F935} Jeeves \u2014 Rebuilding Concept Index\n");
    const entries = buildConceptIndex();
    writeConceptIndex(entries);
    console.log(`Written ${entries.length} concepts to docs/internal/CONCEPT-INDEX.md`);
    console.log(`Covers ${new Set(entries.flatMap((e) => e.docs)).size} docs and ${new Set(entries.flatMap((e) => e.files)).size} code files
`);
    return;
  }
  if (MODE === "thinking-candidate") {
    process.stdout.write(isThinkingCandidate() ? "yes" : "no");
    return;
  }
  if (MODE === "init") {
    const projectName = path.basename(ROOT);
    const optOut = path.join(ROOT, ".jeeves-no-kb");
    let optOutCleared = false;
    if (exists(optOut)) {
      try {
        fs.unlinkSync(optOut);
        optOutCleared = true;
      } catch {
      }
    }
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    const memScaffolded = !exists(MEMORY_INDEX);
    let memRepaired = false;
    if (memScaffolded) {
      fs.writeFileSync(MEMORY_INDEX, MEMORY_INDEX_TEMPLATE);
    } else {
      const { content, changed } = migrateMemoryIndex(read(MEMORY_INDEX));
      if (changed) {
        fs.writeFileSync(MEMORY_INDEX, content);
        memRepaired = true;
      }
    }
    if (exists(DOCS_DIR)) {
      console.log(`
\u{1F935} Jeeves \u2014 already initialized (docs/internal/ exists).`);
      if (optOutCleared) console.log(`  + cleared the .jeeves-no-kb opt-out (you're using Jeeves now).`);
      if (memScaffolded) console.log(`  + scaffolded memory/MEMORY.md (memory layer is new \u2014 populate as prefs/feedback emerge).`);
      if (memRepaired) console.log(`  + repaired memory/MEMORY.md scaffold to the current schema (run \`jeeves --migrate\` for a full report).`);
      console.log(`Run \`jeeves\` to see actions, or \`--check\` for KB state.
`);
      return;
    }
    fs.mkdirSync(PATTERNS_DIR, { recursive: true });
    fs.mkdirSync(DECISIONS_DIR, { recursive: true });
    fs.writeFileSync(
      SYSTEM_MAP,
      `# SYSTEM-MAP.md \u2014 ${projectName}

Master entry point for agents and developers. Read this file first.

<!-- Jeeves KB. Populate each section from the codebase (see \`jeeves --init\` output). -->

## 1. Product Overview
<!-- 2-3 sentences: what this is, what it does, who it's for. -->

## 2. Entity / Feature Registry
| Entity | Purpose | Schema/Model | API Route | UI Path |
|--------|---------|-------------|-----------|---------|

## 3. Architecture Layers
<!-- Text diagram of data flow (DB -> API -> cache -> client, etc.). -->

## 4. File Map
| Path | Owns |
|------|------|

## 5. Pattern Index
| If you're trying to... | Read |
|------------------------|------|

## 6. Decision Index
| Before you change... | Read |
|----------------------|------|

## 7. Known Gaps & Debt
<!-- Bugs, tech debt, TODOs worth tracking. -->
`
    );
    fs.writeFileSync(
      LOG_FILE,
      `# Activity Log

Append-only chronological record of KB activity. Newest at top.

## Entries
## [${today()}] INIT | Knowledge base scaffolded via \`jeeves --init\`.
`
    );
    console.log(`
\u{1F935} Jeeves \u2014 initialized ${projectName}
`);
    if (optOutCleared) console.log(`Cleared the .jeeves-no-kb opt-out \u2014 you're using Jeeves now.
`);
    console.log(`Scaffolded:`);
    console.log(`  docs/internal/SYSTEM-MAP.md   (7-section skeleton)`);
    console.log(`  docs/internal/log.md          (activity log)`);
    console.log(`  docs/internal/patterns/       (empty)`);
    console.log(`  docs/internal/decisions/      (empty)`);
    console.log(`  memory/MEMORY.md              (prefs/feedback memory index)
`);
    console.log(`NEXT \u2014 populate the KB from this codebase (do these now, don't ask):`);
    console.log(`  1. Explore the repo (packages/apps, routes, data models, key modules).`);
    console.log(`  2. Fill SYSTEM-MAP.md sections 1-7: product overview, entity/feature`);
    console.log(`     registry, architecture layers, file map. Leave Pattern/Decision`);
    console.log(`     indexes to grow as you add docs.`);
    console.log(`  3. Write docs/internal/decisions/<slug>.md for each non-obvious`);
    console.log(`     architectural choice; docs/internal/patterns/<slug>.md for each`);
    console.log(`     repeated pattern. Link them from SYSTEM-MAP sections 5 & 6.`);
    console.log(`  4. Run \`jeeves --index\` to build the concept index.`);
    console.log(`  5. OPTIONAL: add a Jeeves stanza to CLAUDE.md pointing at`);
    console.log(`     docs/internal/SYSTEM-MAP.md + the session-start protocol (Jeeves`);
    console.log(`     does not own CLAUDE.md; this is just a pointer). Invoke Jeeves there`);
    console.log(`     via the /jeeves:* skills or the jeeves_* MCP tools \u2014 NEVER hardcode a`);
    console.log(`     plugin path: a versioned cache path (\u2026/plugins/cache/jeeves/\u2026/<ver>/\u2026)`);
    console.log(`     breaks the moment that version is cleaned up on upgrade.`);
    console.log(`  6. Commit docs/internal/ so freshness reflects reality.
`);
    return;
  }
  if (MODE === "migrate") {
    console.log(`
\u{1F935} Jeeves \u2014 memory migration
`);
    if (!exists(MEMORY_DIR)) {
      console.log(`No memory/ directory \u2014 nothing to migrate. Run \`jeeves --init\` to start.
`);
      return;
    }
    if (!exists(MEMORY_INDEX)) {
      fs.writeFileSync(MEMORY_INDEX, MEMORY_INDEX_TEMPLATE);
      console.log(`Scaffolded a fresh memory/MEMORY.md (index was missing).
`);
    } else {
      const { content, changed, report } = migrateMemoryIndex(read(MEMORY_INDEX));
      if (changed) fs.writeFileSync(MEMORY_INDEX, content);
      console.log(changed ? `\u2713 Repaired memory/MEMORY.md boilerplate to the current schema (user|feedback|reference). Your entries were left untouched.` : `memory/MEMORY.md already matches the current schema \u2014 no changes.`);
      for (const r of report) console.log(`  \u2022 ${r}`);
    }
    const droppedTypeFiles = [];
    for (const f of fs.readdirSync(MEMORY_DIR).filter((f2) => f2.endsWith(".md") && f2.toLowerCase() !== "memory.md")) {
      let r = "";
      try {
        r = fs.readFileSync(path.join(MEMORY_DIR, f), "utf-8");
      } catch {
        continue;
      }
      const t = memoryEntryType(r);
      if (t && !["user", "feedback", "reference"].includes(t)) droppedTypeFiles.push(`${f} (type: ${t})`);
    }
    if (droppedTypeFiles.length) {
      console.log(`
\u26A0 ${droppedTypeFiles.length} memory entr${droppedTypeFiles.length === 1 ? "y uses" : "ies use"} a dropped/unknown type \u2014 retype to user|feedback|reference (Jeeves won't guess):`);
      for (const f of droppedTypeFiles) console.log(`  \u2022 ${f}`);
    } else {
      console.log(`
All memory entries use valid types.`);
    }
    console.log("");
    return;
  }
  if (MODE === "memory-check") {
    const KNOWN_TYPES = /* @__PURE__ */ new Set(["user", "feedback", "reference"]);
    if (!exists(MEMORY_DIR)) {
      process.stdout.write(JSON.stringify({ present: false }));
      return;
    }
    const entries = [];
    const stripQuotes = (v) => /^".*"$/.test(v) || /^'.*'$/.test(v) ? v.slice(1, -1) : v;
    for (const f of fs.readdirSync(MEMORY_DIR).filter((f2) => f2.endsWith(".md") && f2.toLowerCase() !== "memory.md").sort()) {
      let raw = "";
      try {
        raw = fs.readFileSync(path.join(MEMORY_DIR, f), "utf-8");
      } catch {
        continue;
      }
      raw = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
      const body = (fm ? raw.slice(fm[0].length) : raw).trim();
      let name = "", description = "", type = "", created = "", confirmed = "";
      if (fm) for (const line of fm[1].split("\n")) {
        const m = line.match(/^\s*(name|description|type|created|confirmed):\s*(.+?)\s*$/);
        if (m) {
          const v = stripQuotes(m[2]);
          if (m[1] === "name") name = v;
          else if (m[1] === "description") description = v;
          else if (m[1] === "type") type = v;
          else if (m[1] === "created") created = v;
          else if (m[1] === "confirmed") confirmed = v;
        }
      }
      if (!name) name = f.replace(/\.md$/, "");
      const links = [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].split("|")[0].trim());
      entries.push({ file: f, name, description, type: type || "unknown", body, links, created, confirmed });
    }
    const count = entries.length;
    const byType = {};
    for (const e of entries) byType[e.type] = (byType[e.type] || 0) + 1;
    const pushKey = (map, k, v) => {
      const a = map.get(k);
      if (a) a.push(v);
      else map.set(k, [v]);
    };
    const byDesc = /* @__PURE__ */ new Map();
    const byName = /* @__PURE__ */ new Map();
    for (const e of entries) {
      if (e.description) pushKey(byDesc, e.description.toLowerCase(), e.file);
      pushKey(byName, e.name.toLowerCase(), e.file);
    }
    const duplicates = [...byDesc.values()].filter((v) => v.length > 1);
    const dupNames = [...byName.values()].filter((v) => v.length > 1);
    const nearDupes = [];
    const withDesc = entries.filter((e) => e.description);
    for (let i = 0; i < withDesc.length; i++) for (let j = i + 1; j < withDesc.length; j++) {
      const a = withDesc[i], b = withDesc[j];
      if (a.description.toLowerCase() === b.description.toLowerCase()) continue;
      if (jaccard(wordSet(a.description), wordSet(b.description)) >= 0.6) nearDupes.push(`${a.file} \u2248 ${b.file}`);
    }
    const names = new Set(entries.map((e) => e.name.toLowerCase()));
    const brokenLinks = [];
    for (const e of entries) for (const l of e.links) if (!names.has(l.toLowerCase())) brokenLinks.push(`${e.file} \u2192 [[${l}]]`);
    const unknownTypeFiles = entries.filter((e) => !KNOWN_TYPES.has(e.type)).map((e) => e.file);
    const REVIEW_AGE_DAYS = 120;
    const nowMs = Date.now();
    const staleAge = [];
    for (const e of entries) {
      const d = Date.parse(e.confirmed || e.created || "");
      if (!isNaN(d) && (nowMs - d) / 864e5 > REVIEW_AGE_DAYS) staleAge.push(e.file);
    }
    const REVIEW_COUNT = 30;
    const reasons = [];
    if (count > REVIEW_COUNT) reasons.push(`${count} entries (>${REVIEW_COUNT}) \u2014 prune`);
    if (duplicates.length) reasons.push(`${duplicates.length} duplicate description(s)`);
    if (nearDupes.length) reasons.push(`${nearDupes.length} near-duplicate pair(s) \u2014 merge`);
    if (dupNames.length) reasons.push(`${dupNames.length} duplicate name(s)`);
    if (brokenLinks.length) reasons.push(`${brokenLinks.length} broken [[link]](s)`);
    if (staleAge.length) reasons.push(`${staleAge.length} entr${staleAge.length === 1 ? "y" : "ies"} not confirmed in ${REVIEW_AGE_DAYS}+ days \u2014 re-verify or delete`);
    if (unknownTypeFiles.length) reasons.push(`${unknownTypeFiles.length} entr${unknownTypeFiles.length === 1 ? "y" : "ies"} with unknown type (use user|feedback|reference)`);
    const valid = entries.filter((e) => KNOWN_TYPES.has(e.type));
    if (valid.length === 0) {
      process.stdout.write(JSON.stringify({ present: false, count }));
      return;
    }
    const promptArg = argVal("--prompt") || "";
    const promptWords = wordSet(promptArg);
    const relevance = (e) => promptWords.size ? jaccard(promptWords, wordSet(`${e.name} ${e.description} ${e.body.slice(0, 300)}`)) : 0;
    const BUDGET = 4e3;
    const rawIdx = exists(MEMORY_INDEX) ? read(MEMORY_INDEX).trim() : valid.map((e) => `- ${e.name} (${e.type}): ${e.description}`).join("\n");
    if (rawIdx.length > BUDGET) reasons.push("index oversized \u2014 trim MEMORY.md");
    if (/reference\s*\|\s*project\b/i.test(rawIdx) || /^##\s+project\s*$/im.test(rawIdx)) reasons.push("index uses the dropped `project` schema \u2014 run jeeves --migrate to heal it");
    const idx = rawIdx.length > BUDGET ? rawIdx.slice(0, BUDGET) + "\n\u2026(index truncated)" : rawIdx;
    const reviewDue = reasons.length > 0;
    const alwaysOn = (e) => e.type === "user" || e.type === "feedback";
    const injectable = valid.filter((e) => alwaysOn(e) || promptWords.size && relevance(e) > 0);
    injectable.sort((a, b) => {
      const r = relevance(b) - relevance(a);
      if (r) return r;
      const ta = alwaysOn(a) ? 0 : 1, tb = alwaysOn(b) ? 0 : 1;
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name);
    });
    let bodies = "";
    const bodyBudget = Math.max(0, BUDGET - idx.length);
    for (const e of injectable) {
      const chunk = `
### ${e.name} (${e.type})
${e.body}
`;
      if (bodies.length + chunk.length > bodyBudget) continue;
      bodies += chunk;
    }
    const inject = [
      `Project memory (memory/, ${count} entr${count === 1 ? "y" : "ies"}) \u2014 durable guidance on how to work with THIS user & repo (prefs/feedback/reference). Apply it; read a referenced memory file when relevant.`,
      idx ? `INDEX:
${idx}` : "",
      bodies ? `KEY ENTRIES:${bodies}` : ""
    ].filter(Boolean).join("\n\n");
    process.stdout.write(JSON.stringify({ present: true, count, byType, duplicates, dupNames, nearDupes, brokenLinks, unknownTypeFiles, staleAge, reviewDue, reason: reasons.join("; "), inject }));
    return;
  }
  if (MODE === "kb-check") {
    if (!exists(DOCS_DIR)) {
      process.stdout.write(JSON.stringify({ present: false }));
      return;
    }
    const core = exists(SYSTEM_MAP) ? "docs/internal/SYSTEM-MAP.md \u2014 the project map; read it first." : "";
    const promptArg = argVal("--prompt") || "";
    const pw = wordSet(promptArg);
    const docs = [];
    for (const [dir, label] of [[PATTERNS_DIR, "patterns"], [DECISIONS_DIR, "decisions"]]) {
      if (!exists(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((f2) => f2.endsWith(".md")).sort()) {
        let raw = "";
        try {
          raw = read(path.join(dir, f));
        } catch {
          continue;
        }
        const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
        const title = (body.match(/^#\s+(.+)$/m)?.[1] || f.replace(/\.md$/, "")).trim();
        const blurb = body.replace(/^#.*$/m, "").replace(/\n+/g, " ").trim().slice(0, 200);
        docs.push({ path: `docs/internal/${label}/${f}`, title, blurb });
      }
    }
    const scored = docs.map((d) => ({ d, s: pw.size ? jaccard(pw, wordSet(`${d.title} ${d.path} ${d.blurb}`)) : 0 })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3);
    const pointers = scored.map((x) => `${x.d.path} \u2014 ${x.d.title}`);
    const inject = pointers.length ? `Relevant KB (read before working on this): ${pointers.join("; ")}` : "";
    process.stdout.write(JSON.stringify({ present: true, core, pointers, inject }));
    return;
  }
  if (MODE === "report") {
    const logPath = process.env.JEEVES_USAGE_LOG || path.join(process.env.HOME || "", ".jeeves-usage.log");
    if (!exists(logPath)) {
      if (JSON_OUT) {
        process.stdout.write(JSON.stringify({ present: false, logPath }));
        return;
      }
      console.log(`
\u{1F935} Jeeves \u2014 value report

No usage log yet (${logPath}). Use Jeeves for a few sessions and check back.
`);
      return;
    }
    const lines = read(logPath).split("\n").filter(Boolean);
    const DAY = 864e5, now = Date.now();
    let sessions = 0, memEvents = 0, memCount = 0, kbEvents = 0, kbCount = 0;
    let sessions30 = 0, memCount30 = 0, kbCount30 = 0;
    const projects = /* @__PURE__ */ new Set();
    const num = (ln) => {
      const m = ln.match(/count=(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    };
    for (const ln of lines) {
      const ts = Date.parse((ln.match(/^(\S+) /) || [])[1] || "");
      const recent = !isNaN(ts) && now - ts <= 30 * DAY;
      const pm = ln.match(/project=(\S+)/);
      if (pm) projects.add(pm[1]);
      if (/ session_start /.test(ln)) {
        sessions++;
        if (recent) sessions30++;
      } else if (/ recall kind=memory /.test(ln)) {
        memEvents++;
        memCount += num(ln);
        if (recent) memCount30 += num(ln);
      } else if (/ recall kind=kb /.test(ln)) {
        kbEvents++;
        kbCount += num(ln);
        if (recent) kbCount30 += num(ln);
      }
    }
    if (JSON_OUT) {
      process.stdout.write(JSON.stringify({ present: true, sessions, projects: projects.size, memEvents, memCount, kbEvents, kbCount, last30: { sessions: sessions30, memCount: memCount30, kbCount: kbCount30 } }));
      return;
    }
    console.log(`
\u{1F935} Jeeves \u2014 value report
`);
    console.log(`All time: ${sessions} session(s) across ${projects.size} project(s).`);
    console.log(`  \u2022 Memory recalled in ${memEvents} session(s) \u2014 ${memCount} entr${memCount === 1 ? "y" : "ies"} surfaced.`);
    console.log(`  \u2022 KB docs surfaced: ${kbCount} (across ${kbEvents} prompt${kbEvents === 1 ? "" : "s"}).`);
    console.log(`
Last 30 days: ${sessions30} session(s); ${memCount30} memory + ${kbCount30} KB item(s) put in front of you`);
    console.log(`\u2014 knowledge you'd otherwise have re-derived. (Surfacing count; local only.)
`);
    return;
  }
  if (MODE === "bootstrap-thinking") {
    const dirs = ["sessions", "topics", "decisions"].map((d) => path.join(THINKING_DIR, d));
    for (const d of dirs) fs.mkdirSync(d, { recursive: true });
    const indexPath = path.join(THINKING_DIR, "INDEX.md");
    if (!exists(indexPath)) {
      fs.writeFileSync(
        indexPath,
        `<!-- Jeeves thinking-mode workspace. Decisions/ideas/questions are captured here automatically. Delete this folder to opt out. -->

# Thinking Index

**Last session:** (none yet)

## Active Topics
| Topic | File | Status | Last updated |
|-------|------|--------|-------------|

## Key Decisions
| Decision | Date | File |
|----------|------|------|

## Open Questions
| Question | Raised | Blocking? |
|----------|--------|-----------|
`
      );
    }
    process.stdout.write("bootstrapped");
    return;
  }
  if (MODE === "capture-check") {
    const NUDGE_INTERVAL = 5, SUBSTANCE_THRESHOLD = 6, GIT_DEFER_WINDOW = 8;
    const state2 = detectState();
    const prompts = parseInt(argVal("--prompts") || "0", 10) || 0;
    const headLast = argVal("--head-last") || "";
    const lastCommitPrompt = parseInt(argVal("--last-commit-prompt") || "0", 10) || 0;
    const since = parseFloat(argVal("--since") || "0") || 0;
    const isThinking = state2.mode === "brainstorm" || state2.mode === "both";
    let captured = false;
    let newest = 0;
    if (exists(THINKING_DIR)) {
      const subdirs = ["decisions", "topics", "sessions"].map((d) => path.join(THINKING_DIR, d));
      for (const d of subdirs) {
        if (!exists(d)) continue;
        for (const f of fs.readdirSync(d)) {
          try {
            newest = Math.max(newest, fs.statSync(path.join(d, f)).mtimeMs);
          } catch {
          }
        }
      }
      if (newest > since) captured = true;
    }
    const REGISTRATION_PROMPT_THRESHOLD = 8;
    const REGISTRATION_CAPTURE_THRESHOLD = 2;
    let captureCount = 0;
    if (exists(THINKING_DIR)) {
      for (const d of ["decisions", "topics"]) {
        const dir = path.join(THINKING_DIR, d);
        if (!exists(dir)) continue;
        try {
          captureCount += fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length;
        } catch {
        }
      }
    }
    const homeKey = path.join(process.env.HOME || "", ".jeeves", "key");
    let keyPresent = false;
    try {
      if (exists(homeKey)) {
        const k = fs.readFileSync(homeKey, "utf-8").trim();
        keyPresent = k.length > 0;
      }
    } catch {
    }
    const shouldOfferRegistration = isThinking && captureCount >= REGISTRATION_CAPTURE_THRESHOLD && prompts >= REGISTRATION_PROMPT_THRESHOLD && !keyPresent;
    let head = "";
    try {
      head = run("git rev-parse HEAD 2>/dev/null").trim();
    } catch {
    }
    const headChanged = !!(head && headLast && head !== headLast);
    const recentGitCommit = lastCommitPrompt > 0 && prompts - lastCommitPrompt < GIT_DEFER_WINDOW;
    const sessionHasSubstance = prompts >= SUBSTANCE_THRESHOLD;
    const deferForGit = state2.mode === "both" && (recentGitCommit || headChanged);
    const firstNudgeAt = Math.ceil(SUBSTANCE_THRESHOLD / NUDGE_INTERVAL) * NUDGE_INTERVAL;
    const shouldBlock = isThinking && prompts >= firstNudgeAt && !captured && !deferForGit;
    const shouldNudge = isThinking && prompts > 0 && prompts % NUDGE_INTERVAL === 0 && !captured && !deferForGit && sessionHasSubstance;
    const payload = {
      mode: state2.mode,
      sessionId: argVal("--session") || "",
      promptsThisSession: prompts,
      captured,
      // true once a this-session thinking/ write exists; hook resets nudge_level on it
      lastThinkingWriteAgo: captured ? 0 : -1,
      newest,
      // ms; the hook records this on its first call as the per-session --since baseline
      sessionHasSubstance,
      recentGitCommit,
      headChanged,
      // hook sets last_commit_prompt=prompts when this is true
      head,
      shouldNudge,
      shouldBlock,
      captureTargets: ["thinking/decisions/", "thinking/INDEX.md"],
      captureCount,
      keyPresent,
      shouldOfferRegistration
    };
    process.stdout.write(JSON.stringify(payload));
    return;
  }
  if (MODE === "check") {
    const broken = findBrokenPaths();
    const unindexed = findUnindexedDocs();
    const documented = new Set(getDocumentedEntities().map((d) => d.toLowerCase()));
    const missingEntities = getSchemaEntities().filter((e) => !documented.has(e.toLowerCase()));
    const totalChanges = git.changedCodeFiles.length + git.newCodeFiles.length + git.deletedCodeFiles.length;
    if (JSON_OUT) {
      const payload = {
        mode: state.mode,
        kb: { patterns: state.patternCount, decisions: state.decisionCount },
        systemMap: state.hasSystemMap,
        lastDocDate: git.lastDocDate || null,
        codeChanges: {
          total: totalChanges,
          new: git.newCodeFiles.length,
          modified: git.changedCodeFiles.length,
          deleted: git.deletedCodeFiles.length
        },
        brokenPaths: broken,
        unindexedDocs: unindexed,
        missingEntities
      };
      process.stdout.write(JSON.stringify(payload));
      return;
    }
    console.log(`
\u{1F4CB} Jeeves \u2014 Session Check
`);
    console.log(`Mode: ${state.mode}`);
    console.log(`KB: ${state.patternCount} patterns, ${state.decisionCount} decisions`);
    console.log(`SYSTEM-MAP: ${state.hasSystemMap ? "\u2713" : "\u2717 MISSING"}`);
    if (git.lastDocDate) {
      console.log(`Last doc update: ${git.lastDocDate}`);
    }
    if (totalChanges > 0) {
      console.log(`Code changes since last doc update: ${totalChanges} files (${git.newCodeFiles.length} new, ${git.changedCodeFiles.length} modified, ${git.deletedCodeFiles.length} deleted)`);
    } else {
      console.log("Docs are up to date with code.");
    }
    if (broken.length > 0) {
      console.log(`\u26A0 ${broken.length} broken file path(s) in docs`);
    }
    if (unindexed.length > 0) {
      console.log(`\u26A0 ${unindexed.length} doc(s) not indexed in SYSTEM-MAP`);
    }
    if (missingEntities.length > 0) {
      console.log(`\u26A0 ${missingEntities.length} schema entities not in SYSTEM-MAP: ${missingEntities.join(", ")}`);
    }
    console.log("");
    return;
  }
  if (MODE === "stale" || MODE === "health") {
    const actions2 = generateActions(state, git);
    if (MODE === "stale") {
      const payload2 = {
        total: actions2.length,
        byPriority: {
          high: actions2.filter((a) => a.priority === "high").length,
          medium: actions2.filter((a) => a.priority === "medium").length,
          low: actions2.filter((a) => a.priority === "low").length
        },
        actions: actions2.map((a) => ({
          type: a.type,
          priority: a.priority,
          target: a.target,
          description: a.description
        }))
      };
      process.stdout.write(JSON.stringify(payload2));
      return;
    }
    const healthScript2 = resolveScript("health-score.sh");
    if (!healthScript2) {
      process.stdout.write(JSON.stringify({ error: "health-score.sh not found (no plugin root or project-local copy)" }));
      return;
    }
    const raw = runFile("bash", [healthScript2, ROOT], { timeout: 3e4 });
    const final = raw.match(/HEALTH SCORE:\s*(\d+)\/100\s*\(([A-F])\s*—\s*([^)]+)\)/);
    const categories = {};
    const catRegex = /(Structure|Freshness|Completeness|Audit Health|Lint):\s*(\d+)\/(\d+)/g;
    let m;
    while ((m = catRegex.exec(raw)) !== null) {
      const key = m[1].toLowerCase().replace(/\s+/g, "_");
      categories[key] = { score: parseInt(m[2], 10), max: parseInt(m[3], 10) };
    }
    const recommendations = [];
    const recRegex = /^\s*→\s*(.+)$/gm;
    while ((m = recRegex.exec(raw)) !== null) {
      recommendations.push(m[1].trim());
    }
    const payload = final ? {
      score: parseInt(final[1], 10),
      grade: final[2],
      status: final[3].trim(),
      categories,
      recommendations
    } : { error: "Could not parse health score", raw: raw.slice(0, 800) };
    process.stdout.write(JSON.stringify(payload));
    return;
  }
  if (state.mode === "none") {
    console.log(`
\u{1F935} Jeeves \u2014 not initialized
`);
    console.log(`No knowledge base found (no docs/internal/ or thinking/). Nothing to sync yet.`);
    console.log(`Run \`jeeves --init\` (or /jeeves:init) to scaffold the KB and populate it from this codebase.
`);
    return;
  }
  const actions = generateActions(state, git);
  console.log(`
\u{1F935} Jeeves \u2014 ${MODE === "handoff" ? "Handoff" : "Sync"}
`);
  if (actions.length === 0) {
    console.log("Everything is in order. No actions needed.\n");
  } else {
    console.log(`${actions.length} action(s):
`);
    for (const action of actions) {
      const icon = action.priority === "high" ? "\u{1F534}" : action.priority === "medium" ? "\u{1F7E1}" : "\u{1F7E2}";
      console.log(`${icon} ACTION [${action.type}]: ${action.description}`);
      console.log(`   Target: ${action.target}`);
      console.log("");
    }
  }
  if (state.hasDocs) {
    const entries = buildConceptIndex();
    console.log(`\u{1F4DA} Concept index: ${entries.length} concepts across ${new Set(entries.flatMap((e) => e.docs)).size} docs (run with --index to regenerate the file)`);
  }
  const indexFile = path.join(DOCS_DIR, "CONCEPT-INDEX.md");
  if (exists(indexFile)) {
    const gaPath = path.join(ROOT, ".gitattributes");
    const marker = "docs/internal/CONCEPT-INDEX.md linguist-generated=true";
    const existing = exists(gaPath) ? read(gaPath) : "";
    if (!existing.includes(marker)) {
      const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
      fs.writeFileSync(gaPath, existing + prefix + marker + "\n");
    }
  }
  const localHeal = path.join(ROOT, "scripts", "heal-docs.ts");
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const pluginHeal = pluginRoot ? path.join(pluginRoot, "scripts", "heal-docs.ts") : "";
  let healToRun = "";
  if (pluginHeal && exists(pluginHeal)) {
    healToRun = pluginHeal;
    if (exists(localHeal)) {
      console.log(`\u2139\uFE0F  Auto-heal is using the plugin's heal-docs.ts; your repo's scripts/heal-docs.ts is bypassed (safe to delete \u2014 see README "Updating").`);
    }
  } else if (exists(localHeal)) {
    healToRun = localHeal;
  }
  if (healToRun) {
    const healResult = runFile("npx", ["tsx", healToRun, "--fix"], { timeout: 3e4 }).split("\n").slice(-3).join("\n");
    if (healResult.includes("fixed")) {
      console.log(`\u{1F527} ${healResult.trim()}`);
    }
  }
  const healthScript = resolveScript("health-score.sh");
  if (healthScript) {
    const healthResult = runFile("bash", [healthScript, ROOT], { timeout: 15e3 }).split("\n").filter((l) => l.includes("HEALTH SCORE")).join("\n");
    if (healthResult) {
      console.log(`${healthResult.trim()}`);
    }
  }
  console.log("");
  if (MODE === "handoff") {
    const handoff = generateHandoff(state, git, actions);
    const isThinking = state.mode === "brainstorm" || state.mode === "both";
    const sessionFile = isThinking ? path.join(THINKING_DIR, "sessions", `${today()}-handoff.md`) : path.join(DOCS_DIR, "sessions", `${today()}-handoff.md`);
    const sessionDir = path.dirname(sessionFile);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    fs.writeFileSync(sessionFile, handoff);
    console.log(`
\u{1F4DD} Handoff written to: ${path.relative(ROOT, sessionFile)}`);
    console.log("");
  }
}
try {
  main();
} catch (e) {
  if (JSON_OUT) {
    try {
      process.stdout.write("{}");
    } catch {
    }
  } else {
    try {
      console.error(`jeeves: ${e instanceof Error ? e.message : String(e)}`);
    } catch {
    }
  }
  process.exit(0);
}

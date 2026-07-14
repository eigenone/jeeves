/**
 * Jeeves — The documentation agent.
 *
 * One command that analyzes your project state and outputs specific actions.
 * Replaces: document, explore, lint, health, status, rebuild-index, brainstorm-end.
 *
 * Usage:
 *   npx tsx scripts/jeeves.ts              # Analyze and output actions
 *   npx tsx scripts/jeeves.ts --handoff    # Session end: sync + write handoff doc
 *   npx tsx scripts/jeeves.ts --check      # Quick session-start report
 *   npx tsx scripts/jeeves.ts --index      # Rebuild concept index
 *   npx tsx scripts/jeeves.ts --annotate   # Find code that needs comments, output instructions
 *   npx tsx scripts/jeeves.ts --verify     # Check existing comments against actual code behavior
 *   npx tsx scripts/jeeves.ts --research   # Save research findings to thinking/research/
 *   npx tsx scripts/jeeves.ts --save       # Save an artifact to thinking/artifacts/
 *   npx tsx scripts/jeeves.ts --summary    # Cumulative view of all decisions, proposals, open questions
 *   npx tsx scripts/jeeves.ts --export     # Generate a shareable doc for your team
 *   npx tsx scripts/jeeves.ts --reconcile  # Check all docs for drift, annotate stale ones
 *   npx tsx scripts/jeeves.ts --driftcheck # Compare specs/plans against actual code
 *   npx tsx scripts/jeeves.ts --trace      # Trace a feature end-to-end through all layers
 *   npx tsx scripts/jeeves.ts --extract    # Extract knowledge from this conversation into docs
 *   npx tsx scripts/jeeves.ts --design     # Plan what docs to create before writing them
 *   npx tsx scripts/jeeves.ts --archive    # Stash current thinking, start fresh
 */

import * as fs from "fs";
import * as path from "path";
import { execSync, execFileSync } from "child_process";

// Project root resolution. MUST be explicit — either `--root <dir>` or an
// ABSOLUTE positional (which every hook passes as the first arg). A relative /
// bare positional is NOT treated as root: mode args carry free text (e.g.
// `--research pricing strategy`), and the old "first non-flag token" heuristic
// mis-read "pricing" as ROOT, writing files into a junk dir and making every git
// call ENOENT. Falls back to process.cwd() (correct for skills, which run with
// cwd = the project dir).
const ROOT = (() => {
  const ri = process.argv.indexOf("--root");
  if (ri >= 0 && process.argv[ri + 1]) return process.argv[ri + 1];
  const absPositional = process.argv.slice(2).find(a => !a.startsWith("-") && path.isAbsolute(a));
  if (absPositional) return absPositional;
  return process.cwd();
})();
const MODES = ["init", "migrate", "handoff", "check", "stale", "health", "index", "annotate", "verify", "research", "save", "summary", "export", "reconcile", "driftcheck", "trace", "extract", "design", "archive", "thinking-candidate", "bootstrap-thinking", "capture-check", "memory-check", "kb-check", "report"] as const;
const MODE = MODES.find(m => process.argv.includes(`--${m}`)) || "sync";
const JSON_OUT = process.argv.includes("--json");
function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DOCS_DIR = path.join(ROOT, "docs", "internal");
const THINKING_DIR = path.join(ROOT, "thinking");
const SYSTEM_MAP = path.join(DOCS_DIR, "SYSTEM-MAP.md");
const LOG_FILE = path.join(DOCS_DIR, "log.md");
const PATTERNS_DIR = path.join(DOCS_DIR, "patterns");
const DECISIONS_DIR = path.join(DOCS_DIR, "decisions");
// Single source of truth for "which files are code" (v4.16.0 — was copy-pasted 4× and 3 copies
// were monorepo-BLIND: a bare `package` alternative excluded the whole `packages/` tree, and a
// bare `\.` excluded every dotdir incl. `.github/workflows/*.ts`). Exclude only SPECIFIC lock/
// manifest files, keep dotdirs. Used by getGitChanges (diff output) + design/annotate/verify
// (ls-files) — same path format, so one filter serves both.
const CODE_FILTER = "grep -vE '^(docs/|thinking/|\\.claude/|README|LICENSE|CHANGELOG|package\\.json|package-lock\\.json|pnpm-lock|tsconfig|node_modules/)' | grep -E '\\.(ts|tsx|js|jsx|py|go|rs|prisma|sql)$'";
// Memory layer — the "how to work with THIS user/repo" collaboration layer (prefs,
// feedback, reference), distinct from the code KB. Repo-root memory/, hook-injected.
const MEMORY_DIR = path.join(ROOT, "memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");
// Canonical, Jeeves-authored MEMORY.md boilerplate for the CURRENT schema. Single source
// of truth so init (create) and migrate (repair) never drift. User content lives UNDER the
// section headers; everything here is ours and safe to (re)write on an explicit init/migrate.
const MEMORY_INDEX_PREAMBLE = `# Memory Index

Durable, PRUNABLE notes on how to work with this user & repo — preferences, feedback,
reference. One file per memory (frontmatter: name, description, metadata.type =
user|feedback|reference; optional created/confirmed dates). Unlike the code KB, memory is
ephemeral: overwrite or DELETE entries that are no longer true. Jeeves injects these at
session start.
`;
const MEMORY_CANON_SECTIONS = ["## User", "## Feedback", "## Reference"];
const MEMORY_DROPPED_SECTIONS = ["## Project"]; // removed in v4.11.0 (schema history)
const MEMORY_INDEX_TEMPLATE = MEMORY_INDEX_PREAMBLE + "\n" + MEMORY_CANON_SECTIONS.join("\n") + "\n";
// The pre-4.11.0 preamble (schema history). Used only to RECOGNIZE Jeeves-authored boilerplate
// when migrating, so a user's own lines above the sections are preserved, not clobbered.
const MEMORY_PREAMBLE_4_10 = `# Memory Index

Durable, PRUNABLE notes on how to work with this user & repo — preferences, feedback,
reference. One file per memory (frontmatter: name, description, metadata.type =
user|feedback|reference|project). Unlike the code KB, memory is ephemeral: overwrite or
DELETE entries that are no longer true. Jeeves injects these at session start.
`;
// Every line (trimmed) that has ever been part of a Jeeves-authored preamble. A pre-section
// line NOT in this set is user content and must survive migration.
const MEMORY_KNOWN_PREAMBLE_LINES = new Set(
  (MEMORY_INDEX_PREAMBLE + "\n" + MEMORY_PREAMBLE_4_10).split("\n").map(l => l.trim()).filter(Boolean)
);
const isDroppedSection = (head: string) => MEMORY_DROPPED_SECTIONS.some(d => d.toLowerCase() === head.toLowerCase());

// Repair a MEMORY.md index to the current schema WITHOUT losing user content: normalize the
// Jeeves-authored preamble, PRESERVE any user lines that were above the sections, drop EMPTY
// dropped-schema sections (## Project, case-insensitively), ensure the canonical sections
// exist. A dropped section that STILL HAS entries is kept and REPORTED — Jeeves can't know the
// right replacement type. Returns the repaired text, whether it changed, and follow-up notes.
function migrateMemoryIndex(raw: string): { content: string; changed: boolean; report: string[] } {
  const report: string[] = [];
  const norm = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const firstH = norm.search(/^## /m);
  const preamble = firstH >= 0 ? norm.slice(0, firstH) : norm;
  const sectionsRaw = firstH >= 0 ? norm.slice(firstH) : "";
  // Preserve any pre-section line the user wrote (not recognized Jeeves boilerplate). The
  // canonical preamble is re-emitted fresh; custom lines are appended after it so they survive.
  const customLines = preamble.split("\n").map(l => l.replace(/\s+$/, ""))
    .filter(l => l.trim() && !MEMORY_KNOWN_PREAMBLE_LINES.has(l.trim()));
  if (customLines.length) report.push(`preserved ${customLines.length} custom line(s) above the sections — verify they still belong`);
  const groups: { head: string; body: string[] }[] = [];
  let cur: { head: string; body: string[] } | null = null;
  for (const ln of sectionsRaw.split("\n")) {
    if (/^## /.test(ln)) { cur = { head: ln.trim(), body: [] }; groups.push(cur); }
    else if (cur) cur.body.push(ln);
  }
  const isEmpty = (g: { body: string[] }) => g.body.every(l => l.trim() === "");
  const kept: typeof groups = [];
  for (const g of groups) {
    if (isDroppedSection(g.head)) {
      if (isEmpty(g)) { report.push(`removed empty "${g.head}" section (dropped type)`); continue; }
      report.push(`"${g.head}" still has entries — retype them to user|feedback|reference and move their index lines, then delete the section`);
    }
    kept.push(g);
  }
  for (const h of MEMORY_CANON_SECTIONS) if (!kept.some(g => g.head === h)) kept.push({ head: h, body: [] });
  const body = kept.map(g => {
    const trimmed = g.body.join("\n").replace(/\n+$/, "");
    return trimmed ? `${g.head}\n${trimmed}` : g.head;
  }).join("\n");
  const preambleOut = MEMORY_INDEX_PREAMBLE + (customLines.length ? "\n" + customLines.join("\n") + "\n" : "");
  const content = preambleOut + "\n" + body + "\n";
  return { content, changed: content !== norm, report };
}

// Read the frontmatter `type` of a memory entry file. Iterates all frontmatter lines and takes
// the LAST `type:` (parity with --memory-check, so both modes agree on a file's type). Returns
// "" when absent/unparseable. Shared by --migrate and any type-aware mode.
function memoryEntryType(raw: string): string {
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

// ── Helpers ──────────────────────────────────────────────────

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function read(p: string): string {
  return exists(p) ? fs.readFileSync(p, "utf-8") : "";
}

function run(cmd: string, opts?: { timeout?: number }): string {
  try {
    return execSync(cmd, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: opts?.timeout || 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

// Shell-free command execution (array args) — use for any invocation that
// interpolates filesystem names, doc frontmatter, or the project path, so a value
// like `foo$(cmd).md` or a repo path containing `$`/backticks can't inject.
function runFile(cmd: string, args: string[], opts?: { timeout?: number }): string {
  try {
    return execFileSync(cmd, args, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: opts?.timeout || 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e: any) {
    // On a non-zero exit, still surface whatever the tool printed to STDOUT (v4.16.0):
    // heal-docs --fix applies edits then exits 1 when unfixable refs remain, and the report
    // rides on stdout — swallowing it meant sync silently rewrote user docs with no output.
    // git & friends write errors to STDERR (stdout empty here), so those still yield "".
    return ((e && e.stdout) ? String(e.stdout) : "").trim();
  }
}
function runGit(args: string[], opts?: { timeout?: number }): string {
  return runFile("git", args, opts);
}

// Path prefix from the git repo root to ROOT — e.g. "apps/web/" when Claude opened a monorepo
// sub-package, "" when ROOT is the repo root. Memoized (one spawn, only when a path-frame
// consumer needs it — never in gitless hot-path modes). git plumbing that lists files
// (diff-tree, `show <rev>:<path>`) is REPO-root-relative while our refs are ROOT-relative;
// this bridges the two so staleness works when ROOT is a sub-directory of the repo (v4.16.0).
let _gitPrefix: string | null = null;
function gitPrefix(): string {
  if (_gitPrefix === null) _gitPrefix = (runGit(["rev-parse", "--show-prefix"]) || "").trim();
  return _gitPrefix;
}

// Lexical relevance scoring — shared by --memory-check and --kb-check (v4.17.0). wordSet
// tokenizes to lowercase words ≥3 chars; jaccard is set-overlap / union. Good enough to rank a
// handful of entries against the user's prompt; not a semantic engine.
const wordSet = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) || []));
const jaccard = (a: Set<string>, b: Set<string>) => { if (!a.size || !b.size) return 0; let inter = 0; for (const w of a) if (b.has(w)) inter++; return inter / (a.size + b.size - inter); };

// Last-commit time (epoch seconds) for a repo-relative file, memoized. 0 = not
// committed / unknown. Commit time is reliable across clones/checkouts; mtime is not
// (a fresh clone bumps every mtime), which is why staleness/reconcile use this.
const _commitTimeCache = new Map<string, number>();
function gitCommitTime(relFile: string): number {
  if (_commitTimeCache.has(relFile)) return _commitTimeCache.get(relFile)!;
  const n = parseInt(runGit(["log", "-1", "--format=%ct", "--", relFile]), 10);
  const v = isNaN(n) ? 0 : n;
  _commitTimeCache.set(relFile, v);
  return v;
}

// Prefer the plugin's copy of a helper script over a (possibly stale or absent)
// project-local one — same rationale as the heal-docs resolution: a plugin update
// can't refresh a copy committed into the user's repo, and a stale copy runs old
// logic. Engine/reporting scripts (jeeves.ts, heal-docs.ts, health-score.sh) prefer
// the plugin; lint-docs is the ONE customization point and is resolved local-first
// by the pre-push gate instead. Returns null if neither exists.
function resolveScript(name: string): string | null {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const pluginPath = pluginRoot ? path.join(pluginRoot, "scripts", name) : "";
  if (pluginPath && exists(pluginPath)) return pluginPath;
  const local = path.join(ROOT, "scripts", name);
  if (exists(local)) return local;
  return null;
}

function getAllMdFiles(dir: string): string[] {
  if (!exists(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...getAllMdFiles(full));
    else if (entry.name.endsWith(".md")) results.push(full);
  }
  return results;
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

const CODE_EXTS = new Set([".py",".js",".ts",".tsx",".jsx",".rb",".go",".rs",".java",".kt",".swift",".php",".ex",".exs",".c",".cc",".cpp",".h",".hpp",".cs",".scala",".clj",".hs",".ml",".tf",".ipynb",".sql",".sh"]);
const CODE_MANIFESTS = new Set(["package.json","go.mod","Cargo.toml","pyproject.toml","pom.xml","Gemfile","mix.exs","composer.json"]);

function countSourceFiles(dir: string, budget = 2000): number {
  let n = 0;
  const walk = (d: string) => {
    if (n >= 3 || budget <= 0) return;
    let entries: string[] = [];
    try { entries = fs.readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (n >= 3 || budget <= 0) return;
      if (e === "node_modules" || e === ".git" || e === "thinking" || e === ".claude") continue;
      const full = path.join(d, e);
      budget--;
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      if (CODE_MANIFESTS.has(e) || CODE_EXTS.has(path.extname(e))) n++;
    }
  };
  walk(dir);
  return n;
}

function isThinkingCandidate(): boolean {
  if (exists(DOCS_DIR)) return false;
  return countSourceFiles(ROOT) < 3;
}

// ── Detection ────────────────────────────────────────────────

interface ProjectState {
  hasDocs: boolean;
  hasThinking: boolean;
  hasSystemMap: boolean;
  hasLog: boolean;
  patternCount: number;
  decisionCount: number;
  mode: "brainstorm" | "code" | "both" | "none";
}

function detectState(): ProjectState {
  const hasDocs = exists(DOCS_DIR);
  const hasThinking = exists(THINKING_DIR);
  const hasSystemMap = exists(SYSTEM_MAP);
  const hasLog = exists(LOG_FILE);
  const patternCount = exists(PATTERNS_DIR)
    ? fs.readdirSync(PATTERNS_DIR).filter(f => f.endsWith(".md")).length
    : 0;
  const decisionCount = exists(DECISIONS_DIR)
    ? fs.readdirSync(DECISIONS_DIR).filter(f => f.endsWith(".md")).length
    : 0;

  let mode: ProjectState["mode"] = "none";
  if (hasDocs && hasThinking) mode = "both";
  else if (hasDocs) mode = "code";
  else if (hasThinking) mode = "brainstorm";

  return { hasDocs, hasThinking, hasSystemMap, hasLog, patternCount, decisionCount, mode };
}

// ── Schema parsing ───────────────────────────────────────────

function getSchemaEntities(): string[] {
  // Prisma
  const prismaFiles = [
    "prisma/schema.prisma",
    "packages/db/prisma/schema.prisma",
    "db/schema.prisma",
  ];
  for (const f of prismaFiles) {
    const full = path.join(ROOT, f);
    if (exists(full)) {
      const content = read(full);
      return [...content.matchAll(/^model\s+(\w+)\s*\{/gm)].map(m => m[1]);
    }
  }

  // Drizzle
  const drizzleFiles = [
    "lib/db/schema.ts",
    "src/db/schema.ts",
    "db/schema.ts",
    "drizzle/schema.ts",
  ];
  for (const f of drizzleFiles) {
    const full = path.join(ROOT, f);
    if (exists(full)) {
      const content = read(full);
      return [...content.matchAll(/(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*["'](\w+)["']/g)].map(m => m[1]);
    }
  }

  return [];
}

function getDocumentedEntities(): string[] {
  if (!exists(SYSTEM_MAP)) return [];
  const content = read(SYSTEM_MAP);
  // Extract every first-column table cell from the entire doc. An earlier
  // version filtered by section keyword (entity/registry/models), but that
  // missed tables under subsection headings like "Hreflang" or "Integrations"
  // that don't include those keywords. Scanning all tables catches a few
  // header-row words ("Table", "Entity") but those don't collide with real
  // schema names, so the missing-entity check stays accurate.
  const rows = content.match(/^\|\s*`?(\w+)`?\s*\|/gm);
  if (!rows) return [];
  const all: string[] = [];
  for (const row of rows) {
    const match = row.match(/^\|\s*`?(\w+)`?\s*\|/);
    if (match && match[1]) all.push(match[1]);
  }
  return [...new Set(all)];
}

// ── Git analysis ─────────────────────────────────────────────

interface GitChanges {
  lastDocCommit: string;
  lastDocDate: string;
  changedCodeFiles: string[];
  newCodeFiles: string[];
  deletedCodeFiles: string[];
  recentCommitMessages: string[];
}

function getGitChanges(): GitChanges {
  const lastDocCommit = run("git log --format='%H' -1 -- docs/internal/");
  const lastDocDate = run("git log --format='%ai' -1 -- docs/internal/");

  // NOTE: `package` must be anchored to the lockfile/manifest, NOT bare — a bare
  // `package` alternative also excluded the entire `packages/` tree, making Jeeves
  // blind to every pnpm/turbo monorepo. `\.claude/` covers our own dotdir; keep the
  // dotfile exclusion narrow so real code like `.github/workflows/*.ts` isn't dropped.
  const codeFilter = CODE_FILTER;

  let changedCodeFiles: string[] = [];
  let newCodeFiles: string[] = [];
  let deletedCodeFiles: string[] = [];

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

// ── Frontmatter parser ──────────────────────────────────────────────────────
// Minimal YAML-frontmatter parser. Reads only keys we care about:
// verified-at, status, superseded-by. Anything else is ignored.
// Must start at line 1 with `---`; terminator must be `---` on its own line.
// Anything that doesn't match: returns {}.

type DocFrontmatter = {
  verifiedAt?: string;
  status?: string;
  supersededBy?: string;
};

function parseFrontmatter(content: string): DocFrontmatter {
  // Normalize BOM + CRLF first (v4.16.0) — a CRLF/BOM'd doc otherwise fails the `---\n` match,
  // so its status:archived / superseded-by / verified-at opt-outs were silently ignored (and
  // heal vs stale disagreed on the same file). Matches the memory/heal/content-lint parsers.
  content = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!content.startsWith("---\n")) return {};
  const rest = content.slice(4);
  const endIdx = rest.indexOf("\n---\n");
  if (endIdx === -1) return {};
  const block = rest.slice(0, endIdx);
  const out: DocFrontmatter = {};
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

// ── Staleness ref filtering + content-awareness (v4.6.0) ─────────────
// Non-source refs that should never be tracked as staleness dependencies
// (they still participate in broken-path/link checks elsewhere).
const STALENESS_SKIP_BASENAMES = new Set([
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
  "bun.lockb", "cargo.lock", "go.sum", "go.mod", "composer.json", "gemfile.lock",
]);
function isNonSourceStalenessRef(p: string): boolean {
  if (p.endsWith(".md")) return true;                 // doc-to-doc / self mentions
  const base = path.basename(p).toLowerCase();
  if (STALENESS_SKIP_BASENAMES.has(base)) return true; // high-churn manifests
  if (/^tsconfig.*\.json$/.test(base)) return true;
  if (/\.config\.(js|ts|mjs|cjs)$/.test(base)) return true;
  return false;
}

const JS_TS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

// Cheap regex extraction of a module's exported identifier set. Not an AST —
// the reporter explicitly accepts a heuristic; the safe direction is to flag
// when unsure (opaque), never to silently suppress.
function extractExports(src: string): { names: Set<string>; opaque: boolean } {
  const names = new Set<string>();
  const opaque = /export\s+\*/.test(src);
  const declRe = /export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(src)) !== null) names.add(m[1]);
  const braceRe = /export\s*\{([^}]*)\}/g;
  while ((m = braceRe.exec(src)) !== null) {
    for (const part of m[1].split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      const asMatch = seg.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      if (asMatch) { names.add(asMatch[1]); continue; }
      const nameMatch = seg.match(/^([A-Za-z_$][\w$]*)/);
      if (nameMatch) names.add(nameMatch[1]);
    }
  }
  if (/export\s+default\b/.test(src)) names.add("default");
  return { names, opaque };
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

const PY_EXT = /\.pyi?$/;

// Python public surface: module-level (column-0) def/async def/class names, plus
// any names declared in __all__. Conservative — a wildcard re-export marks the
// module opaque so we flag rather than risk a false negative. Same safe direction
// as extractExports: when unsure, flag; never silently suppress.
function extractPythonSurface(src: string): { names: Set<string>; opaque: boolean } {
  const names = new Set<string>();
  const opaque = /^from\s+[.\w]+\s+import\s+\*/m.test(src);
  const declRe = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm; // column-0 only
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(src)) !== null) names.add(m[1]);
  const allMatch = src.match(/__all__\s*(?::[^=]+)?=\s*[\[(]([\s\S]*?)[\])]/);
  if (allMatch) {
    for (const q of allMatch[1].matchAll(/['"]([A-Za-z_]\w*)['"]/g)) names.add(q[1]);
  }
  return { names, opaque };
}

// Pick the public-surface extractor for a ref's language, or null when we have no
// content-aware extractor (those refs fall back to timestamp behavior at low).
function surfaceExtractorFor(ref: string): ((src: string) => { names: Set<string>; opaque: boolean }) | null {
  if (JS_TS_EXT.test(ref)) return extractExports;
  if (PY_EXT.test(ref)) return extractPythonSurface;
  return null;
}

// ── Pattern analysis ─────────────────────────────────────────

type PatternDocInfo = { refs: string[]; fm: DocFrontmatter };

function getPatternFiles(): Map<string, PatternDocInfo> {
  // Map pattern doc name → { refs it references, frontmatter }
  const result = new Map<string, PatternDocInfo>();
  if (!exists(PATTERNS_DIR)) return result;

  for (const file of fs.readdirSync(PATTERNS_DIR).filter(f => f.endsWith(".md"))) {
    const content = read(path.join(PATTERNS_DIR, file));
    const fm = parseFrontmatter(content);
    const paths = [...content.matchAll(/`([a-zA-Z][a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})`/g)]
      .map(m => m[1])
      .filter(p => !p.startsWith("http") && !p.startsWith("@") && p.includes("/"));
    // Dedupe — same ref can appear multiple times in a doc (in prose + code
    // block + table), and downstream callers (staleness check) treat refs as
    // a set, so duplicates only create redundant work and noisy previews.
    result.set(file, { refs: [...new Set(paths)], fm });
  }
  return result;
}

// False-positive patterns to skip when scanning for broken paths: hostnames
// with paths, language constructs written as slash-separated words, glob
// wildcards, multiline blocks. These look like file paths to the regex but
// aren't real refs that should resolve on disk.
const PATH_SKIP_PATTERNS = [
  /^[a-z]+\.[\w.-]+\.\w+\//, // hostnames with paths (cdn.example.com/foo.js)
  /^[a-z]+\/[a-z]+\/[a-z]+$/, // language constructs (try/catch/finally)
  /^[a-z]+\/[a-z]+$/, // two-part language constructs (try/catch)
  /\*\*/, // glob double-star (tests/api/**)
  /\*\./, // glob wildcards (drizzle/*.sql)
  /\[[^\]]+\]/, // template placeholders ([type], [entity-type], [slug])
  /\bxxx\b/i, // literal "xxx" placeholders (app/api/geo-xxx/route.ts)
  /\n/, // multiline blocks
];

// Top-level directories that exist in the project, used as a prefix allowlist
// for path candidates. Computed once. We only flag references that look like
// they'd resolve to a real top-level dir — random backticked strings with
// slashes (markdown headings, prose, code comments) get filtered out.
let _projectDirs: Set<string> | null = null;
function getProjectDirs(): Set<string> {
  if (_projectDirs) return _projectDirs;
  const dirs = new Set<string>();
  try {
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        dirs.add(entry.name);
      }
    }
  } catch {}
  _projectDirs = dirs;
  return dirs;
}

/**
 * Strip ✅-marked top-level sections from a markdown doc. Used by the
 * broken-paths scanner so SHIPPED/RESOLVED archive entries don't generate
 * noise — the file refs in those sections may legitimately point at
 * deleted files (the section preserves the incident report for history).
 * Section starts at a `##` or `#` heading whose text begins with `✅` and
 * runs until the next heading of the same depth (or shallower), or EOF.
 */
function stripResolvedSections(md: string): string {
  const out: string[] = [];
  const lines = md.split("\n");
  let skipDepth: number | null = null;
  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      const text = headingMatch[2];
      if (skipDepth !== null && depth <= skipDepth) skipDepth = null;
      if (skipDepth === null && /^✅/.test(text)) {
        skipDepth = depth;
        continue; // skip the heading line itself
      }
    }
    if (skipDepth === null) out.push(line);
  }
  return out.join("\n");
}

function findBrokenPaths(): Array<{ doc: string; brokenPath: string }> {
  const broken: Array<{ doc: string; brokenPath: string }> = [];
  const allDocs = getAllMdFiles(DOCS_DIR);
  const projectDirs = getProjectDirs();

  for (const docPath of allDocs) {
    const rawContent = read(docPath);
    // Strip noise that legitimately holds dead refs:
    //   1. ✅-marked sections — historical archive, paths may be legit-deleted.
    //   2. Strikethrough spans (~~ ... ~~) — dead-code-audit convention for
    //      "this used to exist and we removed it on purpose." Match the
    //      WHOLE strikethrough span (single line, non-greedy) so any backtick
    //      path embedded inside the strikethrough goes away with it. Handles
    //      both `~~`path`~~` and `~~Delete `path` — done.~~` forms.
    const content = stripResolvedSections(rawContent)
      .replace(/~~[^\n]*?~~/g, "");
    // Match the FULL backtick-wrapped string. Earlier we pulled substrings
    // that matched a path-shaped regex even when they were embedded in a
    // longer string with parens/spaces, which created false positives like
    // "foo/page.tsx" extracted from "app/(group)/[id]/foo/page.tsx" inside
    // a code block. Filtering on the whole backticked token avoids that.
    const candidates = [...content.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);
    const paths = candidates.filter(c => {
      const looksLikePath =
        (c.includes("/") || /\.\w{2,6}$/.test(c)) &&
        !PATH_SKIP_PATTERNS.some(p => p.test(c)) &&
        !c.includes(" ") &&
        !c.includes("(") &&
        !c.includes("<") &&
        !c.includes(":") &&
        !c.startsWith("http") &&
        !c.startsWith("@") &&
        !c.startsWith("node:") &&
        !c.startsWith("$") &&
        !c.includes("*") &&
        !c.includes("{{") &&
        c.length < 200;
      if (!looksLikePath) return false;
      // Must start with an actual top-level project dir, a doc-relative
      // prefix (patterns/, decisions/), or one of a small allowlist of
      // hidden dirs jeeves itself manages. getProjectDirs() skips hidden
      // dirs to avoid noise from .git/.next/.turbo, but jeeves docs
      // routinely reference .claude/hooks/ and .github/workflows/ —
      // without this allowlist those refs slip through unvalidated.
      const topDir = c.split("/")[0];
      const HIDDEN_ALLOWLIST = new Set([".claude", ".github", ".githooks"]);
      return projectDirs.has(topDir)
        || topDir === "patterns"
        || topDir === "decisions"
        || HIDDEN_ALLOWLIST.has(topDir);
    });

    for (const ref of paths) {
      const cleanRef = ref.replace(/:\d+(:\d+)?$/, "");
      // Try resolving relative to project root AND relative to DOCS_DIR —
      // cross-doc refs like `patterns/foo.md` written from SYSTEM-MAP.md
      // resolve to docs/internal/patterns/foo.md, not patterns/foo.md.
      const resolvedRoot = path.join(ROOT, cleanRef);
      const resolvedDocs = path.join(DOCS_DIR, cleanRef);
      if (!exists(resolvedRoot) && !exists(resolvedDocs)) {
        broken.push({ doc: path.relative(ROOT, docPath), brokenPath: ref });
      }
    }
  }
  return broken;
}

// ── Index check ──────────────────────────────────────────────

function findUnindexedDocs(): string[] {
  if (!exists(SYSTEM_MAP)) return [];
  const systemMapContent = read(SYSTEM_MAP);
  const unindexed: string[] = [];

  for (const dir of [PATTERNS_DIR, DECISIONS_DIR]) {
    if (!exists(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".md"))) {
      // Boundary-aware, not substring: a plain `content.includes("cache.md")` treats
      // `cache.md` as indexed when SYSTEM-MAP only mentions `page-cache.md`. Require
      // the filename to be bounded by a non-filename character (or line edge).
      const esc = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const indexed = new RegExp(`(^|[^\\w.-])${esc}([^\\w.-]|$)`, "m").test(systemMapContent);
      if (!indexed) {
        unindexed.push(path.relative(DOCS_DIR, path.join(dir, file)));
      }
    }
  }
  return unindexed;
}

// ── Concept index ────────────────────────────────────────────

interface ConceptEntry {
  concept: string;
  docs: string[]; // relative doc paths
  files: string[]; // code files associated
}

function buildConceptIndex(): ConceptEntry[] {
  const concepts = new Map<string, { docs: Set<string>; files: Set<string> }>();

  // Template headings that appear in every doc — not real concepts
  const TEMPLATE_NOISE = new Set([
    "what this is", "how it works", "key files", "gotchas", "follow this pattern",
    "decision", "context", "consequences", "why we chose this", "if thinking about changing",
    "current thinking", "evolution", "key decisions", "open questions", "proposals (not yet confirmed)",
    "what happened", "next steps", "what was built", "session summary",
    "recent doc activity", "knowledge base state", "key files changed", "pending doc actions",
    "pattern index", "decision index", "entity registry", "architecture overview",
    "activity log", "concept index",
  ]);

  function addConcept(concept: string, doc: string, codeFiles: string[]) {
    const key = concept.toLowerCase().trim();
    if (!key || key.length < 2) return;
    if (TEMPLATE_NOISE.has(key)) return;
    if (!concepts.has(key)) {
      concepts.set(key, { docs: new Set(), files: new Set() });
    }
    const entry = concepts.get(key)!;
    entry.docs.add(doc);
    for (const f of codeFiles) entry.files.add(f);
  }

  // Scan all docs
  const allDocs = [
    ...getAllMdFiles(DOCS_DIR),
    ...getAllMdFiles(THINKING_DIR),
  ];

  // Catalog-style docs reference dozens of files for indexing purposes, not
  // as topic-specific code references. Fanning their file lists out to every
  // concept they touch produces massive false positives (any change to a
  // pipeline file gets flagged as affecting every pattern doc mentioned in
  // SYSTEM-MAP). We still want their concept→doc mappings but drop the
  // concept→file fanout.
  const CATALOG_DOC_FILE_THRESHOLD = 25;

  for (const docPath of allDocs) {
    const content = read(docPath);
    const relDoc = path.relative(ROOT, docPath);

    // Extract file paths referenced in this doc — only include paths that actually exist on disk
    const rawFilePaths = [...content.matchAll(/`([a-zA-Z][a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})`/g)]
      .map(m => m[1])
      .filter(p => !p.startsWith("http") && !p.startsWith("@") && !p.startsWith("node:") && !p.includes("://") && !/^[a-z]+\.[a-z]+\.[a-z]+/.test(p) && p.includes("/"))
      .filter(p => exists(path.join(ROOT, p)));

    // Catalog docs contribute concept→doc mappings but not concept→file
    // associations, otherwise every concept they mention ends up claiming
    // authority over every file they index.
    const filePaths = rawFilePaths.length > CATALOG_DOC_FILE_THRESHOLD ? [] : rawFilePaths;

    // Extract concepts from headings
    const headings = [...content.matchAll(/^##?\s+(.+)$/gm)]
      .map(m => m[1].replace(/[*`]/g, "").trim())
      .filter(h => h.length > 2 && h.length < 60 && !h.startsWith("—"));

    for (const heading of headings) {
      addConcept(heading, relDoc, filePaths);
    }

    // Extract entity names from table rows (| EntityName | ... |)
    const tableEntities = [...content.matchAll(/^\|\s*`?([A-Z][a-zA-Z]+)`?\s*\|/gm)]
      .map(m => m[1]);
    for (const entity of tableEntities) {
      addConcept(entity, relDoc, filePaths);
    }

    // Extract concepts from frontmatter tags
    const tagMatch = content.match(/^tags:\s*\[(.+)\]/m);
    if (tagMatch) {
      const tags = tagMatch[1].split(",").map(t => t.trim().replace(/['"]/g, ""));
      for (const tag of tags) {
        addConcept(tag, relDoc, filePaths);
      }
    }

    // The doc's own filename is a concept
    const docName = path.basename(docPath, ".md").replace(/-/g, " ");
    addConcept(docName, relDoc, filePaths);
  }

  // Convert to sorted array, filter out low-value entries
  return [...concepts.entries()]
    .filter(([, v]) => v.docs.size > 0)
    .sort((a, b) => b[1].docs.size - a[1].docs.size)
    .map(([concept, { docs, files }]) => ({
      concept,
      docs: [...docs].sort(),
      files: [...files].sort(),
    }));
}

function writeConceptIndex(entries: ConceptEntry[]): void {
  const indexPath = path.join(DOCS_DIR, "CONCEPT-INDEX.md");
  const lines = [
    "# Concept Index",
    "",
    `> Auto-generated by Jeeves. ${entries.length} concepts across ${new Set(entries.flatMap(e => e.docs)).size} docs.`,
    `> Last updated: ${today()}`,
    "",
    "| Concept | Docs | Code Files |",
    "|---------|------|------------|",
  ];

  for (const entry of entries) {
    const docsStr = entry.docs.map(d => `\`${d}\``).join(", ");
    const filesStr = entry.files.length > 0
      ? entry.files.slice(0, 3).map(f => `\`${f}\``).join(", ") + (entry.files.length > 3 ? ` (+${entry.files.length - 3})` : "")
      : "—";
    lines.push(`| ${entry.concept} | ${docsStr} | ${filesStr} |`);
  }

  fs.writeFileSync(indexPath, lines.join("\n") + "\n");
}

// Concepts that live in too many docs are too generic to be useful signals —
// "file", "evidence", "inngest" match 10+ docs each and produce massive
// fan-out on every code touch. We keep them in the concept index for humans
// browsing the table but exclude them from change-affected-docs suggestions.
const CONCEPT_DOCS_MAX = 6;

function getAffectedDocs(changedFiles: string[], conceptIndex: ConceptEntry[]): Map<string, string[]> {
  // Map doc path → reasons it's affected
  const affected = new Map<string, string[]>();

  // Normalize a path for exact segment-match comparison.
  const norm = (p: string) => p.replace(/^\.\//, "").replace(/\\/g, "/");

  for (const changedFile of changedFiles) {
    const changedNorm = norm(changedFile);
    for (const entry of conceptIndex) {
      // Skip low-specificity concepts — they trigger on anything
      if (entry.docs.length > CONCEPT_DOCS_MAX) continue;
      // Exact-path match only. The old bidirectional substring matcher
      // flagged unrelated files whose paths happened to contain a concept
      // file's basename fragment.
      if (!entry.files.some(f => norm(f) === changedNorm)) continue;
      for (const doc of entry.docs) {
        if (!affected.has(doc)) affected.set(doc, []);
        affected.get(doc)!.push(`${changedFile} relates to "${entry.concept}"`);
      }
    }
  }

  return affected;
}

// ── Route/feature detection ──────────────────────────────────

function findNewFeatures(newFiles: string[]): string[] {
  // Group new files by directory — a cluster of new files in one dir is likely a new feature
  const dirCounts = new Map<string, number>();
  for (const f of newFiles) {
    const dir = path.dirname(f);
    dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
  }

  // Directories with 2+ new files are likely new features
  return [...dirCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([dir]) => dir);
}

// ── Action generation ────────────────────────────────────────

interface Action {
  type: "create" | "update" | "fix" | "log" | "handoff";
  target: string;
  description: string;
  priority: "high" | "medium" | "low";
}

function generateActions(state: ProjectState, git: GitChanges): Action[] {
  const actions: Action[] = [];

  // 1. Bootstrap if no SYSTEM-MAP
  if (!state.hasSystemMap && state.hasDocs) {
    actions.push({
      type: "create",
      target: "docs/internal/SYSTEM-MAP.md",
      description: "Create SYSTEM-MAP.md — entity registry, architecture, key files, integrations",
      priority: "high",
    });
  }

  // 2. Missing entities
  const schemaEntities = getSchemaEntities();
  const documentedEntities = getDocumentedEntities();
  const missingEntities = schemaEntities.filter(
    e => !documentedEntities.some(d => d.toLowerCase() === e.toLowerCase())
  );
  if (missingEntities.length > 0) {
    actions.push({
      type: "update",
      target: "docs/internal/SYSTEM-MAP.md",
      description: `Add ${missingEntities.length} missing entities to registry: ${missingEntities.join(", ")}`,
      priority: "high",
    });
  }

  // 3. New features without pattern docs
  const newFeatureDirs = findNewFeatures(git.newCodeFiles);
  const patternFiles = getPatternFiles();
  const patternDirRefs = new Set<string>();
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
        description: `New feature in ${dir}/ (${git.newCodeFiles.filter(f => f.startsWith(dir)).length} files) — create pattern doc`,
        priority: "medium",
      });
    }
  }

  // 4. Stale pattern docs — git-commit-based, not filesystem mtime.
  //
  // Old approach used fs.statSync().mtimeMs which produced massive false
  // positives: git checkout, editor saves, and same-commit updates all
  // bump mtime without meaning the doc is stale. See Repsy agent feedback
  // from 2026-04-13 for the full analysis.
  //
  // New approach (Option B — commit-grouping):
  //   1. Get the doc's last commit SHA
  //   2. Get files changed in that commit
  //   3. For each referenced file that has commits AFTER the doc's commit,
  //      check: was it also touched in the same commit as the doc?
  //   4. If yes → doc is fresh (they were updated together)
  //   5. If no → doc is genuinely stale
  //
  // Generated/build paths are still skipped.
  const IGNORED_STALENESS_PATHS = [
    "/generated/",
    "/dist/",
    "/.next/",
    "/node_modules/",
    "/build/",
    ".tsbuildinfo",
    ".d.ts",
  ];
  const isIgnoredForStaleness = (p: string) =>
    IGNORED_STALENESS_PATHS.some(ignored => p.includes(ignored));

  for (const [patternFile, { refs, fm }] of patternFiles) {
    // Archived or superseded docs are excluded from staleness scanning entirely.
    if (fm.status === "archived" || (fm.supersededBy && fm.supersededBy.length > 0)) continue;

    const docRelPath = `docs/internal/patterns/${patternFile}`;

    // Get doc's last commit SHA — used for the fresh-together check (files
    // co-committed with the doc are considered fresh regardless of anchor).
    const docLastCommitSha = runGit(["log", "-1", "--format=%H", "--", docRelPath]);
    if (!docLastCommitSha) continue; // Not tracked by git — skip

    // Staleness anchor: defaults to the doc's own last commit, but overridden
    // by verified-at frontmatter when present and valid. Falls back silently
    // on garbage values (typos must not crash the lint pass).
    let anchorSha = docLastCommitSha;
    if (fm.verifiedAt && /^[0-9a-f]{7,64}$/i.test(fm.verifiedAt)) {
      // verified-at is free-form YAML text any agent or human can write — validate
      // it's a hex SHA before interpolating into a shell command. Subprocess cost
      // is one extra spawn per opt-in doc; fine until adoption is widespread.
      const verified = runGit(["rev-parse", "--verify", `${fm.verifiedAt}^{commit}`]);
      if (verified) anchorSha = verified;
    }

    // Files co-committed with the doc's own last commit. If a ref appears here,
    // it was updated together with the doc → still considered fresh (fresh-together rule).
    // Files touched by the doc's last commit ("fresh-together": a ref changed in the
    // SAME commit as the doc isn't stale). Use diff-tree (first-parent), NOT
    // `git show --name-only`: on a MERGE commit, show prints only the combined-diff
    // conflicted paths (often none), so the doc would lose fresh-together suppression
    // and generate spurious stale flags.
    // --root so a parentless (initial) commit still lists its files; strip the repo→ROOT
    // prefix so these repo-relative paths compare against ROOT-relative refs below.
    const _pfx = gitPrefix();
    const docCommitFiles = new Set(
      (runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--first-parent", "--root", docLastCommitSha]) || "")
        .split("\n")
        .filter(Boolean)
        .map(f => _pfx && f.startsWith(_pfx) ? f.slice(_pfx.length) : f)
    );

    const docText = read(path.join(ROOT, docRelPath));
    type StaleRef = { ref: string; latestMsg: string; severity: "high" | "medium" | "low"; removed?: string };
    const staleRefs: StaleRef[] = [];
    for (const ref of refs) {
      if (isIgnoredForStaleness(ref) || isNonSourceStalenessRef(ref)) continue;  // R1
      if (!exists(path.join(ROOT, ref))) continue;

      // The latest commit-subject for this ref since the anchor. Empty means the ref
      // wasn't touched after the anchor (or has no history) — which also subsumes the
      // old "refLastSha === anchorSha" guard, so we drop that extra git call per ref.
      const latestMsg = runGit(["log", "-1", "--format=%s", `${anchorSha}..HEAD`, "--", ref]);
      if (!latestMsg) continue;
      if (docCommitFiles.has(ref)) continue;  // fresh-together

      // R3/R4: content-aware delta for languages we can extract a public surface
      // from (JS/TS, Python). Everything else falls back to timestamp behavior.
      const extractor = surfaceExtractorFor(ref);
      if (extractor) {
        const headSrc = (() => { try { return fs.readFileSync(path.join(ROOT, ref), "utf-8"); } catch { return ""; } })();
        const anchorSrc = runGit(["show", `${anchorSha}:${_pfx}${ref}`]); // repo-relative path
        const headEx = extractor(headSrc);
        const anchorEx = extractor(anchorSrc);
        if (!headEx.opaque && !anchorEx.opaque) {
          if (headEx.names.size === 0 && anchorEx.names.size === 0) {
            // No extractable public surface at either revision (side-effect module,
            // CLI entry, hook). "Both empty" is NOT "exports unchanged" — the file
            // could have been rewritten entirely. Fall back to quiet timestamp
            // behavior (low) rather than silently suppressing (the safe direction).
            staleRefs.push({ ref, latestMsg, severity: "low" });
          } else if (setsEqual(anchorEx.names, headEx.names)) {
            continue; // exports unchanged → not stale
          } else {
            // exports changed: high if the doc still names a removed symbol.
            let removed: string | undefined;
            for (const name of anchorEx.names) {
              if (name === "default") continue;
              if (!headEx.names.has(name) && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(docText)) {
                removed = name; break;
              }
            }
            staleRefs.push(removed
              ? { ref, latestMsg, severity: "high", removed }
              : { ref, latestMsg, severity: "medium" });
          }
        } else {
          // opaque (export *): can't verify → quiet.
          staleRefs.push({ ref, latestMsg, severity: "low" });
        }
      } else {
        // No surface extractor for this language (SQL/Go/Prisma/etc.):
        // timestamp behavior retained, quiet.
        staleRefs.push({ ref, latestMsg, severity: "low" });
      }
    }

    if (staleRefs.length > 0 && !actions.some(a => a.target === docRelPath)) {
      const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + "…" : s;
      const rank = { high: 3, medium: 2, low: 1 } as const;
      const priority = staleRefs.reduce<"high" | "medium" | "low">(
        (acc, r) => rank[r.severity] > rank[acc] ? r.severity : acc, "low");
      const highRef = staleRefs.find(r => r.severity === "high");
      let description: string;
      if (highRef) {
        description = `Stale (HIGH) — doc references removed symbol '${highRef.removed}' — ${highRef.ref} ("${truncate(highRef.latestMsg, 50)}")`;
      } else {
        const top = staleRefs.slice(0, 3).map(r => `${r.ref} ("${truncate(r.latestMsg, 50)}")`);
        const more = staleRefs.length > 3 ? ` (+${staleRefs.length - 3} more)` : "";
        description = `Stale — ${staleRefs.length} ref(s) changed since doc: ${top.join(", ")}${more}`;
      }
      actions.push({ type: "update", target: docRelPath, description, priority });
    }
  }

  // Concept-index-based affected docs — DISABLED (legacy block; no section number).
  // Previously this fanned out "Review" actions for every doc tangentially
  // related to a changed file via shared concept headings. The correlation
  // is too loose to be useful: a doc that mentions "database" once gets
  // flagged every time any file in the database concept changes, and
  // concepts like "clerk", "next.js", "api" hit half the codebase. We keep
  // the direct file-reference staleness check above (section 4) which is
  // precise, and rely on broken-path + overlap detection for structural
  // drift. Leave this block as a no-op documentation of the removed behavior.

  // Section 4b removed in v4.5.1 — was a concept-index-era fallback that
  // flagged docs on ANY referenced-file change without the fresh-together
  // check. Section 4 (commit-grouping) subsumes it correctly.

  // Build set of archived/superseded doc filenames for downstream skip.
  const archivedPatternFiles = new Set<string>();
  for (const [patternFile, { fm }] of patternFiles) {
    if (fm.status === "archived" || (fm.supersededBy && fm.supersededBy.length > 0)) {
      archivedPatternFiles.add(patternFile);
    }
  }

  // 5. Broken paths
  // Archived/superseded docs are excluded — they may legitimately reference deleted files.
  const broken = findBrokenPaths().filter(b => {
    const docFile = path.basename(b.doc);
    return !archivedPatternFiles.has(docFile);
  });
  if (broken.length > 0) {
    actions.push({
      type: "fix",
      target: "broken file paths",
      description: `${broken.length} broken path(s): ${broken.slice(0, 3).map(b => `${b.doc} → ${b.brokenPath}`).join("; ")}${broken.length > 3 ? ` (+${broken.length - 3} more)` : ""}`,
      priority: "high",
    });
  }

  // 6. Unindexed docs
  // Archived/superseded docs are excluded from SYSTEM-MAP listing checks.
  const unindexed = findUnindexedDocs().filter(u => {
    const docFile = path.basename(u);
    return !archivedPatternFiles.has(docFile);
  });
  if (unindexed.length > 0) {
    actions.push({
      type: "update",
      target: "docs/internal/SYSTEM-MAP.md",
      description: `Add ${unindexed.length} unindexed doc(s) to SYSTEM-MAP: ${unindexed.join(", ")}`,
      priority: "medium",
    });
  }

  // 7. Log entry
  if (git.changedCodeFiles.length > 0 || git.newCodeFiles.length > 0) {
    const totalChanges = git.changedCodeFiles.length + git.newCodeFiles.length;
    actions.push({
      type: "log",
      target: "docs/internal/log.md",
      description: `Append: ## [${today()}] update | ${totalChanges} code files changed since last doc update`,
      priority: "low",
    });
  }

  return actions;
}

// ── Handoff generation ───────────────────────────────────────

function generateHandoff(state: ProjectState, git: GitChanges, actions: Action[]): string {
  const date = today();

  // Recent work from git
  const recentWork = git.recentCommitMessages
    .filter(m => !m.startsWith("Merge") && !m.startsWith("chore:"))
    .slice(0, 10)
    .map(m => `- ${m}`)
    .join("\n");

  // Last log entries
  const logContent = read(LOG_FILE);
  const logEntries = logContent.match(/^## \[.+$/gm)?.slice(0, 5) || [];

  // Open questions from thinking
  let openQuestions = "";
  const indexPath = path.join(THINKING_DIR, "INDEX.md");
  if (exists(indexPath)) {
    const indexContent = read(indexPath);
    const oqSection = indexContent.match(/## Open Questions[\s\S]*?(?=\n## |$)/);
    if (oqSection) openQuestions = oqSection[0];
  }

  // New files as "files to look at"
  const keyFiles = git.newCodeFiles.slice(0, 10).map(f => `- \`${f}\``).join("\n");

  // Pending actions as todos
  const todos = actions
    .filter(a => a.priority !== "low")
    .map(a => `- [ ] ${a.description}`)
    .join("\n");

  return `# Handoff — ${date}

## What happened this session
${recentWork || "(no commits this session)"}

## Recent doc activity
${logEntries.map(e => e.replace("## ", "- ")).join("\n") || "(no recent activity)"}

## Knowledge base state
- **Mode:** ${state.mode}
- **Patterns:** ${state.patternCount}
- **Decisions:** ${state.decisionCount}
- **SYSTEM-MAP:** ${state.hasSystemMap ? "exists" : "MISSING"}

## Next steps
${todos || "- [ ] No pending doc actions"}

${openQuestions ? `## Open questions\n${openQuestions}` : ""}

## Key files changed
${keyFiles || "(no new files)"}

## Pending doc actions
${actions.map(a => `- [${a.priority}] ${a.type}: ${a.description}`).join("\n") || "None — docs are current."}
`;
}

// ── Main ─────────────────────────────────────────────────────

function main() {
  const state = detectState();
  // Hot-path modes run on EVERY user prompt (session-check) / turn-end (Stop gate)
  // under a tight hook timeout and never read `git` — skip the 6 git subprocesses
  // getGitChanges() spawns. (Verified: these blocks contain no `git.` references.)
  const GITLESS_MODES = new Set(["capture-check", "thinking-candidate", "bootstrap-thinking", "kb-check", "memory-check", "report"]);
  const git: GitChanges = GITLESS_MODES.has(MODE)
    ? { lastDocCommit: "", lastDocDate: "", changedCodeFiles: [], newCodeFiles: [], deletedCodeFiles: [], recentCommitMessages: [] }
    : getGitChanges();

  // ── Explorer tools ──────────────────────────────────────

  if (MODE === "research") {
    const topic = process.argv.slice(process.argv.indexOf("--research") + 1).filter(a => !a.startsWith("-")).join(" ") || "untitled";
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
    const researchDir = path.join(THINKING_DIR, "research");
    if (!fs.existsSync(researchDir)) fs.mkdirSync(researchDir, { recursive: true });
    const filePath = path.join(researchDir, `${slug}.md`);

    if (exists(filePath)) {
      console.log(`\n🤵 Jeeves — Research: ${topic}\n`);
      console.log(`File exists: thinking/research/${slug}.md`);
      console.log(`Agent: Read the existing file, then do additional research and APPEND new findings.`);
      console.log(`Add today's date, sources, and key data points.\n`);
    } else {
      const template = `# Research: ${topic}\n\n**Started:** ${today()}\n**Status:** In progress\n\n## Key Findings\n\n(Agent: fill this in with research results)\n\n## Sources\n\n| Source | URL | Date | Key takeaway |\n|--------|-----|------|--------------|\n\n## Raw Notes\n\n(Agent: dump detailed notes here)\n\n## Implications\n\nWhat this means for our project:\n- \n`;
      fs.writeFileSync(filePath, template);
      console.log(`\n🤵 Jeeves — Research: ${topic}\n`);
      console.log(`Created: thinking/research/${slug}.md`);
      console.log(`Agent: Research "${topic}" using WebSearch/WebFetch. Fill in Key Findings, Sources table, and Implications.`);
      console.log(`Save everything — the user may close the tab at any time.\n`);
    }

    // Update INDEX.md with the research topic
    const indexPath = path.join(THINKING_DIR, "INDEX.md");
    if (exists(indexPath)) {
      const indexContent = read(indexPath);
      if (!indexContent.includes(`research/${slug}.md`)) {
        const line = `| ${topic} | research/${slug}.md | In progress | ${today()} |`;
        // Try to append to Active Topics table
        if (indexContent.includes("## Active Topics")) {
          const updated = indexContent.replace(
            /(## Active Topics\n\|.*\|\n\|.*\|\n)/,
            `$1${line}\n`
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
    const name = process.argv.slice(process.argv.indexOf("--save") + 1).filter(a => !a.startsWith("-")).join(" ") || "untitled";
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
    const artifactsDir = path.join(THINKING_DIR, "artifacts");
    if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });
    const filePath = path.join(artifactsDir, `${slug}.md`);

    console.log(`\n🤵 Jeeves — Save Artifact: ${name}\n`);

    if (exists(filePath)) {
      console.log(`File exists: thinking/artifacts/${slug}.md`);
      console.log(`Agent: Update the existing artifact with new content.`);
    } else {
      const template = `# ${name}\n\n**Created:** ${today()}\n**Status:** Draft\n**Session:** (link to session file if applicable)\n\n---\n\n(Agent: write the artifact content here)\n`;
      fs.writeFileSync(filePath, template);
      console.log(`Created: thinking/artifacts/${slug}.md`);
      console.log(`Agent: Write the artifact content. This could be a draft, plan, timeline, brief, analysis, or any deliverable.`);
    }
    console.log(`\nFor CSVs or data files, save to thinking/artifacts/${slug}.csv (or appropriate extension).\n`);
    return;
  }

  if (MODE === "summary") {
    console.log(`\n🤵 Jeeves — Summary\n`);

    // Gather all decisions
    const decisionDirs = [
      path.join(THINKING_DIR, "decisions"),
      path.join(DOCS_DIR, "decisions"),
    ];
    const decisions: Array<{ name: string; file: string; source: string }> = [];
    for (const dir of decisionDirs) {
      if (!exists(dir)) continue;
      const source = dir.includes("thinking") ? "brainstorm" : "implemented";
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".md"))) {
        decisions.push({ name: f.replace(".md", "").replace(/-/g, " "), file: path.relative(ROOT, path.join(dir, f)), source });
      }
    }

    // Gather open questions from INDEX.md
    let openQuestions = "";
    const indexPath = path.join(THINKING_DIR, "INDEX.md");
    if (exists(indexPath)) {
      const content = read(indexPath);
      const oqMatch = content.match(/## Open Questions[\s\S]*?(?=\n## |$)/);
      if (oqMatch) openQuestions = oqMatch[0];
    }

    // Gather active topics
    const topicsDir = path.join(THINKING_DIR, "topics");
    const topics: string[] = [];
    if (exists(topicsDir)) {
      for (const f of fs.readdirSync(topicsDir).filter(f => f.endsWith(".md"))) {
        topics.push(f.replace(".md", "").replace(/-/g, " "));
      }
    }

    // Gather research
    const researchDir = path.join(THINKING_DIR, "research");
    const research: string[] = [];
    if (exists(researchDir)) {
      for (const f of fs.readdirSync(researchDir).filter(f => f.endsWith(".md"))) {
        research.push(f.replace(".md", "").replace(/-/g, " "));
      }
    }

    // Gather artifacts
    const artifactsDir = path.join(THINKING_DIR, "artifacts");
    const artifacts: string[] = [];
    if (exists(artifactsDir)) {
      for (const f of fs.readdirSync(artifactsDir)) {
        artifacts.push(f);
      }
    }

    // Count sessions
    const sessionsDir = path.join(THINKING_DIR, "sessions");
    const sessionCount = exists(sessionsDir) ? fs.readdirSync(sessionsDir).filter(f => f.endsWith(".md")).length : 0;

    // KB stats (if builder mode)
    const patternCount = exists(path.join(DOCS_DIR, "patterns")) ? fs.readdirSync(path.join(DOCS_DIR, "patterns")).filter(f => f.endsWith(".md")).length : 0;

    console.log(`📊 Project Summary`);
    console.log(`Sessions: ${sessionCount} | Topics: ${topics.length} | Research: ${research.length} | Artifacts: ${artifacts.length}`);
    console.log("");

    if (decisions.length > 0) {
      console.log(`## Decisions (${decisions.length})`);
      const implemented = decisions.filter(d => d.source === "implemented");
      const brainstorm = decisions.filter(d => d.source === "brainstorm");
      if (implemented.length > 0) {
        console.log(`\nImplemented (${implemented.length}):`);
        for (const d of implemented) console.log(`  ✓ ${d.name}`);
      }
      if (brainstorm.length > 0) {
        console.log(`\nBrainstorm only (${brainstorm.length}):`);
        for (const d of brainstorm) console.log(`  ○ ${d.name}`);
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
      console.log(`## Code KB: ${patternCount} patterns, ${decisions.filter(d => d.source === "implemented").length} code decisions`);
      console.log("");
    }

    console.log(`Agent: Read this summary to the user. If they want details on any item, read the file.\n`);
    return;
  }

  if (MODE === "export") {
    console.log(`\n🤵 Jeeves — Export\n`);

    // Build a single shareable document
    const exportPath = path.join(THINKING_DIR, `export-${today()}.md`);

    // Gather everything
    const indexPath = path.join(THINKING_DIR, "INDEX.md");
    const indexContent = exists(indexPath) ? read(indexPath) : "";

    const sections: string[] = [`# Project Summary — ${today()}\n`];

    // Decisions
    const decisionDirs = [path.join(DOCS_DIR, "decisions"), path.join(THINKING_DIR, "decisions")];
    const allDecisions: Array<{ name: string; content: string; source: string }> = [];
    for (const dir of decisionDirs) {
      if (!exists(dir)) continue;
      const source = dir.includes("thinking") ? "proposed" : "implemented";
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".md"))) {
        allDecisions.push({
          name: f.replace(".md", "").replace(/-/g, " "),
          content: read(path.join(dir, f)),
          source,
        });
      }
    }

    if (allDecisions.length > 0) {
      sections.push(`## Decisions (${allDecisions.length})\n`);
      for (const d of allDecisions) {
        // Extract just the decision and why sections
        const decisionMatch = d.content.match(/## (?:What we decided|Decision)\n([\s\S]*?)(?=\n## |$)/);
        const whyMatch = d.content.match(/## (?:Why|Why we chose this|Context)\n([\s\S]*?)(?=\n## |$)/);
        sections.push(`### ${d.name} (${d.source})`);
        if (decisionMatch) sections.push(decisionMatch[1].trim());
        if (whyMatch) sections.push(`*Why:* ${whyMatch[1].trim()}`);
        sections.push("");
      }
    }

    // Open questions from INDEX
    const oqMatch = indexContent.match(/## Open Questions[\s\S]*?(?=\n## |$)/);
    if (oqMatch) {
      sections.push(oqMatch[0]);
      sections.push("");
    }

    // Research summaries
    const researchDir = path.join(THINKING_DIR, "research");
    if (exists(researchDir)) {
      const researchFiles = fs.readdirSync(researchDir).filter(f => f.endsWith(".md"));
      if (researchFiles.length > 0) {
        sections.push(`## Research (${researchFiles.length})\n`);
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

    // Active topics
    const topicsDir = path.join(THINKING_DIR, "topics");
    if (exists(topicsDir)) {
      const topicFiles = fs.readdirSync(topicsDir).filter(f => f.endsWith(".md"));
      if (topicFiles.length > 0) {
        sections.push(`## Active Topics (${topicFiles.length})\n`);
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
    console.log(`\nAgent: Tell the user the export is ready. They can share this file with their team.\n`);
    return;
  }

  // ── Reconciliation & drift ────────────────────────────────

  if (MODE === "reconcile") {
    console.log("\n🤵 Jeeves — Reconcile\n");
    console.log("Checking all docs for drift against current project state...\n");

    interface DriftItem {
      file: string;
      type: "decision" | "topic" | "pattern" | "research" | "session";
      issue: string;
      severity: "stale" | "superseded" | "outdated";
    }

    const driftItems: DriftItem[] = [];

    // Check decisions — look for ones that reference things that no longer exist or have been replaced
    for (const dir of [path.join(DOCS_DIR, "decisions"), path.join(THINKING_DIR, "decisions")]) {
      if (!exists(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".md"))) {
        const content = read(path.join(dir, f));
        const relPath = path.relative(ROOT, path.join(dir, f));

        // Check if the decision references files that no longer exist
        const filePaths = [...content.matchAll(/`([a-zA-Z][a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})`/g)]
          .map(m => m[1])
          .filter(p => !p.startsWith("http") && !p.startsWith("@") && p.includes("/"));
        const brokenRefs = filePaths.filter(p => !exists(path.join(ROOT, p)));
        if (brokenRefs.length > 0) {
          driftItems.push({
            file: relPath, type: "decision", severity: "stale",
            issue: `References ${brokenRefs.length} file(s) that no longer exist: ${brokenRefs.slice(0, 3).join(", ")}`,
          });
        }

        // NOTE: the old "May be superseded by newer" check compared two decision docs
        // by fs.mtime — meaningless after a clone/checkout (arbitrary ordering), which
        // is exactly the false-positive class the staleness engine dropped mtime for.
        // Removed: content-aware staleness (--stale) owns real "is this doc stale".
      }
    }

    // Check thinking topics — "Current thinking" may be outdated if related decisions were made
    const topicsDir = path.join(THINKING_DIR, "topics");
    if (exists(topicsDir)) {
      for (const f of fs.readdirSync(topicsDir).filter(f => f.endsWith(".md"))) {
        const content = read(path.join(topicsDir, f));
        const relPath = `thinking/topics/${f}`;
        // Commit time, not mtime — reliable across clones. 0 = uncommitted (skip: we
        // can't reason about age for a file that was never committed).
        const topicTime = gitCommitTime(relPath);

        // Check if there are newer decisions that relate to this topic
        const topicWords = new Set(f.replace(".md", "").split("-"));
        for (const decDir of [path.join(DOCS_DIR, "decisions"), path.join(THINKING_DIR, "decisions")]) {
          if (!exists(decDir)) continue;
          for (const df of fs.readdirSync(decDir).filter(df => df.endsWith(".md"))) {
            const decWords = df.replace(".md", "").split("-");
            const overlap = decWords.filter(w => topicWords.has(w)).length;
            if (overlap >= 2) {
              const decTime = gitCommitTime(path.relative(ROOT, path.join(decDir, df)));
              if (topicTime > 0 && decTime > topicTime) {
                driftItems.push({
                  file: relPath, type: "topic", severity: "outdated",
                  issue: `Topic not updated since decision was made: ${df.replace(".md", "")}`,
                });
                break;
              }
            }
          }
        }

        // Check if topic has "Proposals" that were actually decided. Compare the newest
        // decision's COMMIT time against the topic's commit time (topicTime) — never fs.mtime,
        // which is meaningless across clones/checkouts (the false-positive class this function
        // dropped mtime for elsewhere). (Bug fixed v4.14.x: this compared `decMtime > mtime`
        // where `mtime` was undefined — only reachable via a topic with a `## Proposals`
        // section, so the fail-open catch masked it.)
        if (content.includes("## Proposals") || content.includes("## Proposals (not yet confirmed)")) {
          const proposalSection = content.match(/## Proposals[\s\S]*?(?=\n## |$)/);
          if (proposalSection && proposalSection[0].length > 50 && topicTime > 0) {
            const decDir = path.join(DOCS_DIR, "decisions");
            if (exists(decDir)) {
              const newestDecTime = fs.readdirSync(decDir)
                .filter(df => df.endsWith(".md"))
                .map(df => gitCommitTime(path.relative(ROOT, path.join(decDir, df))))
                .sort((a, b) => b - a)[0] || 0;
              if (newestDecTime > topicTime) {
                driftItems.push({
                  file: relPath, type: "topic", severity: "outdated",
                  issue: `Has proposals that may have been decided since last update — check against recent decisions`,
                });
              }
            }
          }
        }
      }
    }

    // (Removed v4.16.0) The pattern-doc "not updated in 14 days" age check used fs.mtime —
    // meaningless across clones (all "now") and pure treadmill noise on a mature repo (a
    // correct, stable doc is not stale). This is exactly the age-based flagging the staleness
    // engine deliberately dropped for content-aware detection; `--stale` owns real "is this
    // doc stale". Reconcile stays focused on DRIFT (broken refs, topics vs decisions).

    // Overlap detection — find docs that reference the same set of code files
    const docFileRefs = new Map<string, Set<string>>();
    const allReconcileDocs = getAllMdFiles(DOCS_DIR);
    for (const docPath of allReconcileDocs) {
      const relDoc = path.relative(ROOT, docPath);
      // Skip analyses (time-boxed snapshots) and auto-generated files
      if (relDoc.includes("/analyses/")) continue;
      if (relDoc.includes("CONCEPT-INDEX") || relDoc.includes("concept-index")) continue;
      const content = read(docPath);
      const refs = [...content.matchAll(/`([a-zA-Z][a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})`/g)]
        .map(m => m[1].replace(/:\d+(:\d+)?$/, ""))
        .filter(p => !p.startsWith("http") && !p.startsWith("@") && p.includes("/") && exists(path.join(ROOT, p)));
      if (refs.length >= 3) {
        docFileRefs.set(relDoc, new Set(refs));
      }
    }

    // Find pairs of docs with high overlap (>50% shared file references)
    const docPaths = [...docFileRefs.keys()];
    const overlaps: Array<{ docA: string; docB: string; shared: number; totalA: number; totalB: number; sharedFiles: string[] }> = [];
    for (let i = 0; i < docPaths.length; i++) {
      for (let j = i + 1; j < docPaths.length; j++) {
        const refsA = docFileRefs.get(docPaths[i])!;
        const refsB = docFileRefs.get(docPaths[j])!;
        const shared = [...refsA].filter(r => refsB.has(r));
        const overlapRatio = shared.length / Math.min(refsA.size, refsB.size);
        if (shared.length >= 3 && overlapRatio > 0.5) {
          overlaps.push({
            docA: docPaths[i],
            docB: docPaths[j],
            shared: shared.length,
            totalA: refsA.size,
            totalB: refsB.size,
            sharedFiles: shared.slice(0, 5),
          });
        }
      }
    }

    if (overlaps.length > 0) {
      for (const o of overlaps) {
        driftItems.push({
          file: `${o.docA} + ${o.docB}`,
          type: "pattern" as const,
          severity: "outdated" as const,
          issue: `OVERLAP: ${o.shared} shared file refs (${o.totalA} in first, ${o.totalB} in second). Shared: ${o.sharedFiles.join(", ")}. Consider consolidating or linking.`,
        });
      }
    }

    // Check for docs in root of docs/internal/ that look like analyses (time-boxed reports)
    // Suggest moving them to analyses/ if they contain analysis-like keywords
    if (exists(DOCS_DIR)) {
      const analysesDir = path.join(DOCS_DIR, "analyses");
      for (const f of fs.readdirSync(DOCS_DIR).filter(f => f.endsWith(".md"))) {
        if (["SYSTEM-MAP.md", "log.md", "CONCEPT-INDEX.md", "codebase-audit.md", "review-queue.md", "context-log.md", "FUTURE.md"].includes(f)) continue;
        const content = read(path.join(DOCS_DIR, f));
        const isAnalysis = /analysis|readiness|investigation|incident|audit report|snapshot|assessment|evaluation/i.test(content) &&
          /\b\d{4}-\d{2}-\d{2}\b/.test(f); // date in filename suggests time-boxed
        if (isAnalysis && !exists(analysesDir)) {
          driftItems.push({
            file: `docs/internal/${f}`,
            type: "pattern" as const,
            severity: "outdated" as const,
            issue: `Looks like a time-boxed analysis/report. Consider creating docs/internal/analyses/ and moving it there so it's visibly a snapshot, not a living doc.`,
          });
        }
      }
    }

    if (driftItems.length === 0) {
      console.log("All docs appear current. No drift detected.\n");
    } else {
      const superseded = driftItems.filter(d => d.severity === "superseded");
      const stale = driftItems.filter(d => d.severity === "stale");
      const outdated = driftItems.filter(d => d.severity === "outdated");

      if (superseded.length > 0) {
        console.log(`🔴 SUPERSEDED (${superseded.length}) — these docs may have been replaced:\n`);
        for (const d of superseded) {
          console.log(`  ${d.file}`);
          console.log(`    ${d.issue}`);
          console.log(`    Agent: Add banner "⚠️ POSSIBLY SUPERSEDED" to the top of this doc.\n`);
        }
      }

      if (stale.length > 0) {
        console.log(`🟡 STALE REFERENCES (${stale.length}) — these docs reference things that changed:\n`);
        for (const d of stale) {
          console.log(`  ${d.file}`);
          console.log(`    ${d.issue}`);
          console.log(`    Agent: Update the references or add a note about what changed.\n`);
        }
      }

      if (outdated.length > 0) {
        console.log(`🟢 POSSIBLY OUTDATED (${outdated.length}) — these may need review:\n`);
        for (const d of outdated) {
          console.log(`  ${d.file}`);
          console.log(`    ${d.issue}\n`);
        }
      }

      console.log(`\nTotal: ${driftItems.length} items to review.`);
      console.log(`Agent: For each SUPERSEDED doc, add a banner at the top pointing to the replacement.`);
      console.log(`For STALE docs, update references. For OUTDATED, read and verify if still accurate.\n`);
    }
    return;
  }

  if (MODE === "driftcheck") {
    console.log("\n🤵 Jeeves — Drift Check\n");
    console.log("Comparing specs/plans against what was actually built...\n");

    // Find spec and plan docs (superpowers creates these)
    const specDirs = [
      path.join(ROOT, "docs", "superpowers", "specs"),
      path.join(ROOT, "docs", "specs"),
      path.join(ROOT, ".claude", "docs"),
      path.join(THINKING_DIR, "specs"),
    ];

    const planDirs = [
      path.join(ROOT, "docs", "superpowers", "plans"),
      path.join(ROOT, "docs", "plans"),
      path.join(THINKING_DIR, "plans"),
    ];

    const specs: Array<{ name: string; file: string; content: string }> = [];
    const plans: Array<{ name: string; file: string; content: string; tasks: string[] }> = [];

    for (const dir of specDirs) {
      if (!exists(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".md"))) {
        specs.push({
          name: f.replace(".md", "").replace(/-/g, " "),
          file: path.relative(ROOT, path.join(dir, f)),
          content: read(path.join(dir, f)),
        });
      }
    }

    for (const dir of planDirs) {
      if (!exists(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".md"))) {
        const content = read(path.join(dir, f));
        // Extract task items (checkboxes or numbered items)
        const tasks = [...content.matchAll(/^(?:- \[[ x]\]|\d+\.) (.+)$/gm)].map(m => m[1]);
        plans.push({
          name: f.replace(".md", "").replace(/-/g, " "),
          file: path.relative(ROOT, path.join(dir, f)),
          content,
          tasks,
        });
      }
    }

    if (specs.length === 0 && plans.length === 0) {
      console.log("No spec or plan docs found.");
      console.log("Looked in: docs/superpowers/specs/, docs/superpowers/plans/, thinking/specs/, thinking/plans/");
      console.log("\nIf you have spec/plan docs elsewhere, move them to one of these directories.\n");
      return;
    }

    console.log(`Found: ${specs.length} spec(s), ${plans.length} plan(s)\n`);

    // For each spec, extract what was specified and check what exists
    for (const spec of specs) {
      console.log(`📋 Spec: ${spec.name}`);
      console.log(`   File: ${spec.file}`);

      // Extract file paths mentioned in the spec
      const specPaths = [...spec.content.matchAll(/`([a-zA-Z][a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})`/g)]
        .map(m => m[1])
        .filter(p => !p.startsWith("http") && !p.startsWith("@") && p.includes("/"));
      const uniquePaths = [...new Set(specPaths)];
      const existing = uniquePaths.filter(p => exists(path.join(ROOT, p)));
      const missing = uniquePaths.filter(p => !exists(path.join(ROOT, p)));

      if (uniquePaths.length > 0) {
        console.log(`   Files referenced: ${uniquePaths.length} (${existing.length} exist, ${missing.length} missing)`);
        if (missing.length > 0) {
          console.log(`   Missing: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5})` : ""}`);
        }
      }

      // Extract entity/model names mentioned
      const entityMentions = [...spec.content.matchAll(/(?:model|entity|table)\s+`?(\w+)`?/gi)]
        .map(m => m[1]);
      if (entityMentions.length > 0) {
        const schemaEntities = getSchemaEntities();
        const mentioned = [...new Set(entityMentions)];
        const implemented = mentioned.filter(e => schemaEntities.some(s => s.toLowerCase() === e.toLowerCase()));
        const notImplemented = mentioned.filter(e => !schemaEntities.some(s => s.toLowerCase() === e.toLowerCase()));
        if (notImplemented.length > 0) {
          console.log(`   Entities not in schema: ${notImplemented.join(", ")}`);
        }
      }

      console.log(`   Agent: Read this spec and compare against what was actually built. Flag any drift.\n`);
    }

    // For each plan, check task completion
    for (const plan of plans) {
      console.log(`📝 Plan: ${plan.name}`);
      console.log(`   File: ${plan.file}`);

      if (plan.tasks.length > 0) {
        // Check for completed checkboxes
        const completed = [...plan.content.matchAll(/^- \[x\] (.+)$/gm)].map(m => m[1]);
        const incomplete = [...plan.content.matchAll(/^- \[ \] (.+)$/gm)].map(m => m[1]);

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

      console.log(`   Agent: Read this plan and verify each task against the codebase. Mark what's actually done.\n`);
    }

    console.log(`\nAgent: For each spec/plan above, read the doc and compare against the actual code.`);
    console.log(`Report: what was built as specified, what diverged, what was skipped, what was added.\n`);
    return;
  }

  // ── Knowledge tools (both modes) ───────────────────────────

  if (MODE === "trace") {
    const feature = process.argv.slice(process.argv.indexOf("--trace") + 1).filter(a => !a.startsWith("-")).join(" ") || "";
    console.log(`\n🤵 Jeeves — Trace Feature\n`);

    if (!feature) {
      console.log("Usage: jeeves --trace <feature name>");
      console.log('Example: jeeves --trace "email sync pipeline"');
      console.log("\nAgent: Ask the user which feature to trace.\n");
      return;
    }

    // Find related docs and code via concept index
    const conceptIndex = buildConceptIndex();
    const featureWords = feature.toLowerCase().split(/\s+/);
    const related = conceptIndex.filter(e =>
      featureWords.some(w => e.concept.includes(w))
    );

    const relatedDocs = [...new Set(related.flatMap(r => r.docs))];
    const relatedFiles = [...new Set(related.flatMap(r => r.files))];

    console.log(`Tracing: "${feature}"\n`);

    if (relatedDocs.length > 0) {
      console.log(`📄 Related docs (${relatedDocs.length}):`);
      for (const d of relatedDocs.slice(0, 15)) console.log(`  - ${d}`);
      if (relatedDocs.length > 15) console.log(`  ... +${relatedDocs.length - 15} more`);
    }

    if (relatedFiles.length > 0) {
      console.log(`\n📁 Related code files (${relatedFiles.length}):`);
      for (const f of relatedFiles.slice(0, 15)) console.log(`  - ${f}`);
      if (relatedFiles.length > 15) console.log(`  ... +${relatedFiles.length - 15} more`);
    }

    console.log(`\nAgent: Trace "${feature}" end-to-end through the codebase.`);
    console.log(`Read the related docs and code files above. Then produce a trace doc:\n`);
    console.log(`1. Start from the user-facing entry point (UI, API route, CLI command)`);
    console.log(`2. Follow the data flow through each layer (route → action → service → DB)`);
    console.log(`3. Note every file touched and what it does in the flow`);
    console.log(`4. Note integration points (external APIs, background jobs, caches)`);
    console.log(`5. Write the trace to docs/internal/patterns/${feature.replace(/\s+/g, "-")}-trace.md\n`);
    return;
  }

  if (MODE === "extract") {
    console.log(`\n🤵 Jeeves — Extract Knowledge\n`);
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
    console.log(`\n🤵 Jeeves — Design Doc Structure\n`);

    // Analyze what exists
    const schemaEntities = getSchemaEntities();
    const existingPatterns = exists(PATTERNS_DIR)
      ? fs.readdirSync(PATTERNS_DIR).filter(f => f.endsWith(".md")).map(f => f.replace(".md", ""))
      : [];
    const existingDecisions = [
      ...(exists(path.join(DOCS_DIR, "decisions"))
        ? fs.readdirSync(path.join(DOCS_DIR, "decisions")).filter(f => f.endsWith(".md")).map(f => f.replace(".md", ""))
        : []),
      ...(exists(path.join(THINKING_DIR, "decisions"))
        ? fs.readdirSync(path.join(THINKING_DIR, "decisions")).filter(f => f.endsWith(".md")).map(f => f.replace(".md", ""))
        : []),
    ];

    // Find code directories that might represent features
    const codeFilter = CODE_FILTER;
    const allCode = run(`git -c core.quotepath=off ls-files 2>/dev/null | ${codeFilter}`);
    const codeFiles = allCode ? allCode.split("\n").filter(Boolean) : [];
    const codeDirs = new Map<string, number>();
    for (const f of codeFiles) {
      const parts = f.split("/");
      if (parts.length >= 2) {
        const dir = parts.slice(0, Math.min(parts.length - 1, 3)).join("/");
        codeDirs.set(dir, (codeDirs.get(dir) || 0) + 1);
      }
    }

    // Find directories with enough code to warrant a pattern doc
    const featureDirs = [...codeDirs.entries()]
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1]);

    console.log(`Current state:`);
    console.log(`  Schema entities: ${schemaEntities.length}`);
    console.log(`  Pattern docs: ${existingPatterns.length}`);
    console.log(`  Decision docs: ${existingDecisions.length}`);
    console.log(`  Code directories with 3+ files: ${featureDirs.length}\n`);

    // Suggest patterns to write
    const suggestedPatterns: string[] = [];
    for (const [dir, count] of featureDirs) {
      const dirName = dir.split("/").pop() || dir;
      const hasPattern = existingPatterns.some(p =>
        p.includes(dirName) || dirName.includes(p.replace(/-/g, ""))
      );
      if (!hasPattern) {
        suggestedPatterns.push(`${dir}/ (${count} files) → patterns/${dirName}.md`);
      }
    }

    if (suggestedPatterns.length > 0) {
      console.log(`📝 Suggested pattern docs to create (${suggestedPatterns.length}):\n`);
      for (const s of suggestedPatterns.slice(0, 15)) {
        console.log(`  CREATE: ${s}`);
      }
      if (suggestedPatterns.length > 15) console.log(`  ... +${suggestedPatterns.length - 15} more`);
    } else {
      console.log(`All major code directories have pattern docs. Nice.\n`);
    }

    // Suggest decisions to document
    const recentCommits = run("git log --format='%s' -20");
    const commitMsgs = recentCommits ? recentCommits.split("\n") : [];
    const decisionKeywords = commitMsgs.filter(m =>
      /chose|switch|migrat|replac|instead of|over|rather than|because/i.test(m)
    );
    if (decisionKeywords.length > 0) {
      console.log(`\n📋 Recent commits that hint at undocumented decisions:\n`);
      for (const m of decisionKeywords) {
        console.log(`  "${m}"`);
      }
    }

    console.log(`\n📐 Docs NOT to create (already covered):`);
    for (const p of existingPatterns.slice(0, 10)) {
      console.log(`  ✓ patterns/${p}.md`);
    }

    console.log(`\nAgent: Review the suggestions above. For each CREATE item, ask the user if they want it.`);
    console.log(`Then create the docs using the pattern/decision templates.\n`);
    return;
  }

  if (MODE === "archive") {
    const label = process.argv.slice(process.argv.indexOf("--archive") + 1).filter(a => !a.startsWith("-")).join(" ") || today();
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
    const archiveDir = path.join(THINKING_DIR, "archive", slug);

    console.log(`\n🤵 Jeeves — Archive & Fresh Start\n`);

    if (fs.existsSync(archiveDir)) {
      console.log(`Archive "${slug}" already exists at thinking/archive/${slug}/`);
      console.log(`Choose a different name or delete the existing archive.\n`);
      return;
    }

    // Check what exists to archive
    const thinkingExists = exists(THINKING_DIR);
    const docsExists = exists(DOCS_DIR);
    const hasTopics = exists(path.join(THINKING_DIR, "topics")) &&
      fs.readdirSync(path.join(THINKING_DIR, "topics")).filter(f => f.endsWith(".md")).length > 0;
    const hasSessions = exists(path.join(THINKING_DIR, "sessions")) &&
      fs.readdirSync(path.join(THINKING_DIR, "sessions")).filter(f => f.endsWith(".md")).length > 0;

    if (!hasTopics && !hasSessions) {
      console.log("Nothing to archive — no topics or sessions found.\n");
      return;
    }

    // Archive thinking content
    fs.mkdirSync(archiveDir, { recursive: true });

    const archived: string[] = [];
    for (const subdir of ["topics", "sessions", "decisions", "research", "artifacts"]) {
      const src = path.join(THINKING_DIR, subdir);
      const dst = path.join(archiveDir, subdir);
      if (exists(src) && fs.readdirSync(src).filter(f => f.endsWith(".md")).length > 0) {
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

    // Archive INDEX.md
    const indexSrc = path.join(THINKING_DIR, "INDEX.md");
    if (exists(indexSrc)) {
      fs.copyFileSync(indexSrc, path.join(archiveDir, "INDEX.md"));
      archived.push("INDEX.md");
    }

    // Create fresh INDEX.md
    const freshIndex = `# Thinking Index\n\n**Last session:** (none yet)\n**Previous archive:** thinking/archive/${slug}/\n\n## Active Topics\n| Topic | File | Status | Last updated |\n|-------|------|--------|-------------|\n\n## Key Decisions\n| Decision | Date | File |\n|----------|------|------|\n\n## Open Questions\n| Question | Raised | Blocking? |\n|----------|--------|-----------|\n`;
    fs.writeFileSync(indexSrc, freshIndex);

    console.log(`Archived ${archived.length} files to thinking/archive/${slug}/\n`);
    for (const a of archived.slice(0, 10)) console.log(`  → ${a}`);
    if (archived.length > 10) console.log(`  ... +${archived.length - 10} more`);

    console.log(`\nFresh INDEX.md created with link to archive.`);
    console.log(`Previous thinking is preserved and can be referenced at thinking/archive/${slug}/`);
    console.log(`\nYou're starting fresh. All topics, sessions, and decisions are archived.\n`);
    return;
  }

  // ── Builder/shared tools ──────────────────────────────────

  if (MODE === "annotate") {
    console.log("\n🤵 Jeeves — Annotate Code\n");
    const codeFilter = CODE_FILTER;

    // Find code files with few or no comments
    const allCode = run(`git -c core.quotepath=off ls-files 2>/dev/null | ${codeFilter}`);
    const codeFiles = allCode ? allCode.split("\n").filter(Boolean) : [];

    interface AnnotateTarget {
      file: string;
      lines: number;
      commentLines: number;
      ratio: number;
      hasDecisions: boolean;
      hasComplexLogic: boolean;
    }

    const targets: AnnotateTarget[] = [];

    for (const file of codeFiles) {
      const fullPath = path.join(ROOT, file);
      if (!exists(fullPath)) continue;
      const content = read(fullPath);
      const lines = content.split("\n");
      const totalLines = lines.length;
      if (totalLines < 10) continue; // Skip tiny files

      const commentLines = lines.filter(l => {
        const trimmed = l.trim();
        return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("#");
      }).length;

      const ratio = commentLines / totalLines;

      // Detect complexity signals
      const hasDecisions = /if.*else|switch|ternary|\?.*:/i.test(content) && totalLines > 30;
      const hasComplexLogic = /try.*catch|Promise\.all|async.*await.*async|\.reduce\(|\.flatMap\(/i.test(content);

      // Target files that are complex but poorly commented
      if (totalLines > 20 && ratio < 0.05 && (hasDecisions || hasComplexLogic)) {
        targets.push({ file, lines: totalLines, commentLines, ratio, hasDecisions, hasComplexLogic });
      }
    }

    // Sort by most in need of comments (largest uncommented complex files first)
    targets.sort((a, b) => b.lines - a.lines);

    if (targets.length === 0) {
      console.log("All code files are adequately commented. Nothing to annotate.\n");
    } else {
      console.log(`${targets.length} file(s) need comments:\n`);
      for (const t of targets.slice(0, 20)) {
        const reasons: string[] = [];
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
      console.log(`Skip: Obvious code (imports, simple assignments, standard CRUD)\n`);
    }
    return;
  }

  if (MODE === "verify") {
    console.log("\n🤵 Jeeves — Verify Comments\n");
    const codeFilter = CODE_FILTER;

    const allCode = run(`git -c core.quotepath=off ls-files 2>/dev/null | ${codeFilter}`);
    const codeFiles = allCode ? allCode.split("\n").filter(Boolean) : [];

    interface CommentBlock {
      file: string;
      line: number;
      comment: string;
      nearbyCode: string;
    }

    const commentsToVerify: CommentBlock[] = [];

    for (const file of codeFiles) {
      const fullPath = path.join(ROOT, file);
      if (!exists(fullPath)) continue;
      const content = read(fullPath);
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        // Look for substantive comments (not just section dividers or TODOs)
        if (trimmed.startsWith("//") && trimmed.length > 15 && !trimmed.startsWith("///") && !trimmed.startsWith("// ---") && !trimmed.startsWith("// ===")) {
          const comment = trimmed;
          // Grab 3 lines of code after the comment for context
          const nearbyCode = lines.slice(i + 1, i + 4).join("\n");

          // Only verify comments that make claims about behavior
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
      console.log(`${commentsToVerify.length} comment(s) make verifiable claims:\n`);
      for (const c of commentsToVerify.slice(0, 30)) {
        console.log(`VERIFY: ${c.file}:${c.line}`);
        console.log(`   Comment: ${c.comment}`);
        console.log(`   Code:    ${c.nearbyCode.split("\n")[0].trim()}`);
        console.log("");
      }
      console.log(`Agent: For each comment above, read the surrounding code and verify the claim.`);
      console.log(`If the comment is wrong → fix the comment (or flag the code as a bug).`);
      console.log(`If the comment is right → leave it.`);
      console.log(`If the comment is outdated (code changed, comment didn't) → update the comment.\n`);
    }
    return;
  }

  if (MODE === "index") {
    console.log("\n🤵 Jeeves — Rebuilding Concept Index\n");
    const entries = buildConceptIndex();
    writeConceptIndex(entries);
    console.log(`Written ${entries.length} concepts to docs/internal/CONCEPT-INDEX.md`);
    console.log(`Covers ${new Set(entries.flatMap(e => e.docs)).size} docs and ${new Set(entries.flatMap(e => e.files)).size} code files\n`);
    return;
  }

  if (MODE === "thinking-candidate") {
    process.stdout.write(isThinkingCandidate() ? "yes" : "no");
    return;
  }

  if (MODE === "init") {
    const projectName = path.basename(ROOT);
    // Running init IS "starting to use Jeeves" — so clear any `.jeeves-no-kb` opt-out the
    // user set earlier when they declined the bootstrap offer. Leaving it would be stale and
    // contradictory (and would wrongly re-suppress the offer if the KB were ever removed).
    const optOut = path.join(ROOT, ".jeeves-no-kb");
    let optOutCleared = false;
    if (exists(optOut)) { try { fs.unlinkSync(optOut); optOutCleared = true; } catch {} }
    // Memory layer is INDEPENDENT of the code KB. Scaffold it FIRST — before the
    // already-initialized early-return — so existing users upgrading into the memory
    // feature still get memory/MEMORY.md (otherwise init early-returns and they never
    // do). Idempotent: writes only when absent.
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    const memScaffolded = !exists(MEMORY_INDEX);
    let memRepaired = false;
    if (memScaffolded) {
      fs.writeFileSync(MEMORY_INDEX, MEMORY_INDEX_TEMPLATE);
    } else {
      // Existing index: repair the Jeeves-authored boilerplate to the current schema
      // (idempotent — no-op if already current). User content under the headers is untouched.
      const { content, changed } = migrateMemoryIndex(read(MEMORY_INDEX));
      if (changed) { fs.writeFileSync(MEMORY_INDEX, content); memRepaired = true; }
    }

    // Scaffold the code-mode KB skeleton, then emit instructions for the agent to
    // populate it from the codebase. Idempotent: never clobber an existing KB.
    if (exists(DOCS_DIR)) {
      console.log(`\n🤵 Jeeves — already initialized (docs/internal/ exists).`);
      if (optOutCleared) console.log(`  + cleared the .jeeves-no-kb opt-out (you're using Jeeves now).`);
      if (memScaffolded) console.log(`  + scaffolded memory/MEMORY.md (memory layer is new — populate as prefs/feedback emerge).`);
      if (memRepaired) console.log(`  + repaired memory/MEMORY.md scaffold to the current schema (run \`jeeves --migrate\` for a full report).`);
      console.log(`Run \`jeeves\` to see actions, or \`--check\` for KB state.\n`);
      return;
    }
    fs.mkdirSync(PATTERNS_DIR, { recursive: true });
    fs.mkdirSync(DECISIONS_DIR, { recursive: true });
    // SYSTEM-MAP with all 7 canonical sections present (so structure scores + the
    // agent has a frame to fill). Placeholders are HTML comments, not {{tokens}}.
    fs.writeFileSync(SYSTEM_MAP,
`# SYSTEM-MAP.md — ${projectName}

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
`);
    fs.writeFileSync(LOG_FILE,
`# Activity Log

Append-only chronological record of KB activity. Newest at top.

## Entries
## [${today()}] INIT | Knowledge base scaffolded via \`jeeves --init\`.
`);
    // (memory/ is scaffolded above, before the early-return, so it also reaches
    // already-initialized repos.)
    console.log(`\n🤵 Jeeves — initialized ${projectName}\n`);
    if (optOutCleared) console.log(`Cleared the .jeeves-no-kb opt-out — you're using Jeeves now.\n`);
    console.log(`Scaffolded:`);
    console.log(`  docs/internal/SYSTEM-MAP.md   (7-section skeleton)`);
    console.log(`  docs/internal/log.md          (activity log)`);
    console.log(`  docs/internal/patterns/       (empty)`);
    console.log(`  docs/internal/decisions/      (empty)`);
    console.log(`  memory/MEMORY.md              (prefs/feedback memory index)\n`);
    console.log(`NEXT — populate the KB from this codebase (do these now, don't ask):`);
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
    console.log(`     via the /jeeves:* skills or the jeeves_* MCP tools — NEVER hardcode a`);
    console.log(`     plugin path: a versioned cache path (…/plugins/cache/jeeves/…/<ver>/…)`);
    console.log(`     breaks the moment that version is cleaned up on upgrade.`);
    console.log(`  6. Commit docs/internal/ so freshness reflects reality.\n`);
    return;
  }

  if (MODE === "migrate") {
    // Explicit, reviewable memory-schema migration (v4.12.0). Repairs the Jeeves-authored
    // MEMORY.md boilerplate to the current schema and REPORTS user content that needs manual
    // attention (entries typed with a dropped type). Never silently deletes/retypes user data.
    console.log(`\n🤵 Jeeves — memory migration\n`);
    if (!exists(MEMORY_DIR)) { console.log(`No memory/ directory — nothing to migrate. Run \`jeeves --init\` to start.\n`); return; }
    if (!exists(MEMORY_INDEX)) {
      fs.writeFileSync(MEMORY_INDEX, MEMORY_INDEX_TEMPLATE);
      console.log(`Scaffolded a fresh memory/MEMORY.md (index was missing).\n`);
    } else {
      const { content, changed, report } = migrateMemoryIndex(read(MEMORY_INDEX));
      if (changed) fs.writeFileSync(MEMORY_INDEX, content);
      console.log(changed
        ? `✓ Repaired memory/MEMORY.md boilerplate to the current schema (user|feedback|reference). Your entries were left untouched.`
        : `memory/MEMORY.md already matches the current schema — no changes.`);
      for (const r of report) console.log(`  • ${r}`);
    }
    // Report (do NOT modify) entry files that carry a dropped/unknown type — Jeeves can't
    // know the correct replacement, so the user/agent must retype them.
    const droppedTypeFiles: string[] = [];
    for (const f of fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md") && f.toLowerCase() !== "memory.md")) {
      let r = ""; try { r = fs.readFileSync(path.join(MEMORY_DIR, f), "utf-8"); } catch { continue; }
      const t = memoryEntryType(r); // shared parser → migrate and memory-check agree on type
      if (t && !["user", "feedback", "reference"].includes(t)) droppedTypeFiles.push(`${f} (type: ${t})`);
    }
    if (droppedTypeFiles.length) {
      console.log(`\n⚠ ${droppedTypeFiles.length} memory entr${droppedTypeFiles.length === 1 ? "y uses" : "ies use"} a dropped/unknown type — retype to user|feedback|reference (Jeeves won't guess):`);
      for (const f of droppedTypeFiles) console.log(`  • ${f}`);
    } else {
      console.log(`\nAll memory entries use valid types.`);
    }
    console.log("");
    return;
  }

  if (MODE === "memory-check") {
    // Read the typed memory/ layer, report hygiene signals, and build the context the
    // session hook injects. Deterministic only — the SEMANTIC prune (stale/contradicted)
    // is the agent's job, triggered when reviewDue flags a red condition.
    // Types: user (who they are) | feedback (how to work) | reference (stable external/
    // setup facts). `project` was dropped in v4.11.0 — it never injected and blurred the
    // memory-vs-code-KB boundary (project goals/constraints live in docs/internal).
    const KNOWN_TYPES = new Set(["user", "feedback", "reference"]);
    if (!exists(MEMORY_DIR)) { process.stdout.write(JSON.stringify({ present: false })); return; }
    interface Mem { file: string; name: string; description: string; type: string; body: string; links: string[]; created: string; confirmed: string; }
    const entries: Mem[] = [];
    const stripQuotes = (v: string) => (/^".*"$/.test(v) || /^'.*'$/.test(v)) ? v.slice(1, -1) : v;
    // .sort() for deterministic order (readdir order is FS-dependent → nondeterministic
    // budget cuts / report order). Case-insensitive MEMORY.md exclusion (APFS).
    for (const f of fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md") && f.toLowerCase() !== "memory.md").sort()) {
      let raw = "";
      try { raw = fs.readFileSync(path.join(MEMORY_DIR, f), "utf-8"); } catch { continue; }
      raw = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"); // strip BOM; normalize CRLF AND lone CR
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
      const body = (fm ? raw.slice(fm[0].length) : raw).trim();
      let name = "", description = "", type = "", created = "", confirmed = "";
      if (fm) for (const line of fm[1].split("\n")) {
        const m = line.match(/^\s*(name|description|type|created|confirmed):\s*(.+?)\s*$/);
        if (m) { const v = stripQuotes(m[2]);
          if (m[1] === "name") name = v; else if (m[1] === "description") description = v;
          else if (m[1] === "type") type = v; else if (m[1] === "created") created = v; else if (m[1] === "confirmed") confirmed = v; }
      }
      if (!name) name = f.replace(/\.md$/, "");
      // [[name]] / [[name|alias]] — resolve on the pre-pipe name.
      const links = [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1].split("|")[0].trim());
      entries.push({ file: f, name, description, type: type || "unknown", body, links, created, confirmed });
    }
    const count = entries.length;
    const byType: Record<string, number> = {};
    for (const e of entries) byType[e.type] = (byType[e.type] || 0) + 1;
    const pushKey = (map: Map<string, string[]>, k: string, v: string) => { const a = map.get(k); if (a) a.push(v); else map.set(k, [v]); };
    // Duplicate descriptions / names (overlap smell + [[link]]/header collisions).
    const byDesc = new Map<string, string[]>(); const byName = new Map<string, string[]>();
    for (const e of entries) { if (e.description) pushKey(byDesc, e.description.toLowerCase(), e.file); pushKey(byName, e.name.toLowerCase(), e.file); }
    const duplicates = [...byDesc.values()].filter(v => v.length > 1);
    const dupNames = [...byName.values()].filter(v => v.length > 1);
    // Near-duplicates (v4.11.0): distinct descriptions whose word-sets overlap heavily
    // (Jaccard ≥ 0.6) — the "two entries saying almost the same thing" smell that exact-
    // match dup detection misses. Tokenize to words ≥3 chars; skip exact matches (already
    // caught above). O(n²) but bounded by the review-count guard in practice.
    const nearDupes: string[] = [];
    const withDesc = entries.filter(e => e.description);
    for (let i = 0; i < withDesc.length; i++) for (let j = i + 1; j < withDesc.length; j++) {
      const a = withDesc[i], b = withDesc[j];
      if (a.description.toLowerCase() === b.description.toLowerCase()) continue; // exact → duplicates[]
      if (jaccard(wordSet(a.description), wordSet(b.description)) >= 0.6) nearDupes.push(`${a.file} ≈ ${b.file}`);
    }
    // Broken [[links]] — case-insensitive resolution against known names.
    const names = new Set(entries.map(e => e.name.toLowerCase()));
    const brokenLinks: string[] = [];
    for (const e of entries) for (const l of e.links) if (!names.has(l.toLowerCase())) brokenLinks.push(`${e.file} → [[${l}]]`);
    // Typo'd / missing type → the entry is silently excluded from injection; flag it.
    const unknownTypeFiles = entries.filter(e => !KNOWN_TYPES.has(e.type)).map(e => e.file);
    // Age staleness (v4.11.0): an entry whose last-confirmed (or created) date is older
    // than REVIEW_AGE_DAYS should be re-verified or deleted — memory is ephemeral, and a
    // stale "preference" may no longer hold. Only entries carrying a parseable date are
    // aged; undated legacy entries are exempt (no false staleness on pre-dates memory).
    const REVIEW_AGE_DAYS = 120;
    const nowMs = Date.now();
    const staleAge: string[] = [];
    for (const e of entries) {
      const d = Date.parse(e.confirmed || e.created || "");
      if (!isNaN(d) && (nowMs - d) / 86400000 > REVIEW_AGE_DAYS) staleAge.push(e.file);
    }
    const REVIEW_COUNT = 30;
    const reasons: string[] = [];
    if (count > REVIEW_COUNT) reasons.push(`${count} entries (>${REVIEW_COUNT}) — prune`);
    if (duplicates.length) reasons.push(`${duplicates.length} duplicate description(s)`);
    if (nearDupes.length) reasons.push(`${nearDupes.length} near-duplicate pair(s) — merge`);
    if (dupNames.length) reasons.push(`${dupNames.length} duplicate name(s)`);
    if (brokenLinks.length) reasons.push(`${brokenLinks.length} broken [[link]](s)`);
    if (staleAge.length) reasons.push(`${staleAge.length} entr${staleAge.length === 1 ? "y" : "ies"} not confirmed in ${REVIEW_AGE_DAYS}+ days — re-verify or delete`);
    if (unknownTypeFiles.length) reasons.push(`${unknownTypeFiles.length} entr${unknownTypeFiles.length === 1 ? "y" : "ies"} with unknown type (use user|feedback|reference)`);
    // Provenance: only a Jeeves memory store if ≥1 entry has a recognized type. Stops an
    // unrelated memory/ dir (ML checkpoints, agent frameworks) from injecting arbitrary
    // markdown as authoritative guidance (prompt-injection surface).
    const valid = entries.filter(e => KNOWN_TYPES.has(e.type));
    if (valid.length === 0) { process.stdout.write(JSON.stringify({ present: false, count })); return; }
    // Prompt-scored relevance (v4.11.0, D3): when the session hook passes the user's
    // current prompt, rank entries by word-overlap against it so the MOST relevant bodies
    // inject first — and a reference entry surfaces when the prompt touches it, not only
    // user/feedback. No prompt → deterministic type-then-name order (unchanged behaviour).
    const promptArg = argVal("--prompt") || "";
    const promptWords = wordSet(promptArg);
    const relevance = (e: Mem) => promptWords.size ? jaccard(promptWords, wordSet(`${e.name} ${e.description} ${e.body.slice(0, 300)}`)) : 0;
    // Injection is WHOLE-payload budgeted: index first (capped), then bodies in the
    // remaining room, SKIPPING (not breaking on) an oversized entry.
    const BUDGET = 4000;
    // Auto-index fallback (no MEMORY.md) lists only VALID entries — an unknown/dropped-type
    // entry must not appear in the injected table of contents as if it were real guidance.
    const rawIdx = exists(MEMORY_INDEX) ? read(MEMORY_INDEX).trim() : valid.map(e => `- ${e.name} (${e.type}): ${e.description}`).join("\n");
    if (rawIdx.length > BUDGET) reasons.push("index oversized — trim MEMORY.md");
    // Schema drift: a MEMORY.md written by an older Jeeves still references the dropped
    // `project` type (old preamble `…|project` or an empty `## Project` section). Surface it
    // so the session-end hygiene banner points the user at `jeeves --migrate` (which heals it).
    // Match the OLD type-list token specifically (`…reference|project`) — not any stray
    // "| project" (a table cell / description), which would nag forever — plus a `## Project`
    // section header (case-insensitive). Both are unambiguous pre-4.11.0 signatures.
    if (/reference\s*\|\s*project\b/i.test(rawIdx) || /^##\s+project\s*$/im.test(rawIdx)) reasons.push("index uses the dropped `project` schema — run jeeves --migrate to heal it");
    const idx = rawIdx.length > BUDGET ? rawIdx.slice(0, BUDGET) + "\n…(index truncated)" : rawIdx;
    const reviewDue = reasons.length > 0;
    // Always-on core = user + feedback (durable behavioural guidance). With a prompt, also
    // fold in any reference entry that scores against it. Order: relevance desc (when a
    // prompt is present), then type (user/feedback before reference), then name.
    const alwaysOn = (e: Mem) => e.type === "user" || e.type === "feedback";
    const injectable = valid.filter(e => alwaysOn(e) || (promptWords.size && relevance(e) > 0));
    injectable.sort((a, b) => {
      const r = relevance(b) - relevance(a); if (r) return r;
      const ta = alwaysOn(a) ? 0 : 1, tb = alwaysOn(b) ? 0 : 1; if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name);
    });
    let bodies = "";
    const bodyBudget = Math.max(0, BUDGET - idx.length);
    for (const e of injectable) {
      const chunk = `\n### ${e.name} (${e.type})\n${e.body}\n`;
      if (bodies.length + chunk.length > bodyBudget) continue; // skip oversized, keep packing smaller ones
      bodies += chunk;
    }
    const inject = [
      `Project memory (memory/, ${count} entr${count === 1 ? "y" : "ies"}) — durable guidance on how to work with THIS user & repo (prefs/feedback/reference). Apply it; read a referenced memory file when relevant.`,
      idx ? `INDEX:\n${idx}` : "",
      bodies ? `KEY ENTRIES:${bodies}` : "",
    ].filter(Boolean).join("\n\n");
    process.stdout.write(JSON.stringify({ present: true, count, byType, duplicates, dupNames, nearDupes, brokenLinks, unknownTypeFiles, staleAge, reviewDue, reason: reasons.join("; "), inject }));
    return;
  }

  if (MODE === "kb-check") {
    // KB READ LOOP (v4.17.0): the code KB was write-only — Jeeves nagged you to WRITE docs but
    // never surfaced them when work started. This scores pattern/decision docs against the
    // user's current prompt and returns relevant POINTERS (not bodies) so the agent reads the
    // right doc before touching a subsystem. `core` = the always-relevant SYSTEM-MAP pointer
    // (session hook injects it once/session); `pointers` = prompt-scored docs (per prompt,
    // deduped by the hook). Cheap: reads a few dozen doc headers, no git.
    if (!exists(DOCS_DIR)) { process.stdout.write(JSON.stringify({ present: false })); return; }
    const core = exists(SYSTEM_MAP) ? "docs/internal/SYSTEM-MAP.md — the project map; read it first." : "";
    const promptArg = argVal("--prompt") || "";
    const pw = wordSet(promptArg);
    interface KbDoc { path: string; title: string; blurb: string; }
    const docs: KbDoc[] = [];
    for (const [dir, label] of [[PATTERNS_DIR, "patterns"], [DECISIONS_DIR, "decisions"]] as const) {
      if (!exists(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".md")).sort()) {
        let raw = ""; try { raw = read(path.join(dir, f)); } catch { continue; }
        const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, ""); // strip frontmatter
        const title = (body.match(/^#\s+(.+)$/m)?.[1] || f.replace(/\.md$/, "")).trim();
        const blurb = body.replace(/^#.*$/m, "").replace(/\n+/g, " ").trim().slice(0, 200);
        docs.push({ path: `docs/internal/${label}/${f}`, title, blurb });
      }
    }
    // Rank by prompt overlap; only surface docs that actually match (score > 0), top 3.
    const scored = docs
      .map(d => ({ d, s: pw.size ? jaccard(pw, wordSet(`${d.title} ${d.path} ${d.blurb}`)) : 0 }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3);
    const pointers = scored.map(x => `${x.d.path} — ${x.d.title}`);
    const inject = pointers.length ? `Relevant KB (read before working on this): ${pointers.join("; ")}` : "";
    process.stdout.write(JSON.stringify({ present: true, core, pointers, inject }));
    return;
  }

  if (MODE === "report") {
    // Value ledger (v4.18.0): the honest replacement for the un-backed "weekly digest" promise.
    // Reads the LOCAL usage log (no network) — session_start + recall events written by the
    // session hook — and summarizes the knowledge Jeeves has surfaced (memory + KB docs) that
    // you'd otherwise have re-derived. Measures SURFACING, not proven recall — stated honestly.
    const logPath = process.env.JEEVES_USAGE_LOG || path.join(process.env.HOME || "", ".jeeves-usage.log");
    if (!exists(logPath)) {
      if (JSON_OUT) { process.stdout.write(JSON.stringify({ present: false, logPath })); return; }
      console.log(`\n🤵 Jeeves — value report\n\nNo usage log yet (${logPath}). Use Jeeves for a few sessions and check back.\n`);
      return;
    }
    const lines = read(logPath).split("\n").filter(Boolean);
    const DAY = 86400000, now = Date.now();
    let sessions = 0, memEvents = 0, memCount = 0, kbEvents = 0, kbCount = 0;
    let sessions30 = 0, memCount30 = 0, kbCount30 = 0;
    const projects = new Set<string>();
    const num = (ln: string) => { const m = ln.match(/count=(\d+)/); return m ? parseInt(m[1], 10) : 0; };
    for (const ln of lines) {
      const ts = Date.parse((ln.match(/^(\S+) /) || [])[1] || "");
      const recent = !isNaN(ts) && (now - ts) <= 30 * DAY;
      const pm = ln.match(/project=(\S+)/); if (pm) projects.add(pm[1]);
      if (/ session_start /.test(ln)) { sessions++; if (recent) sessions30++; }
      else if (/ recall kind=memory /.test(ln)) { memEvents++; memCount += num(ln); if (recent) memCount30 += num(ln); }
      else if (/ recall kind=kb /.test(ln)) { kbEvents++; kbCount += num(ln); if (recent) kbCount30 += num(ln); }
    }
    if (JSON_OUT) {
      process.stdout.write(JSON.stringify({ present: true, sessions, projects: projects.size, memEvents, memCount, kbEvents, kbCount, last30: { sessions: sessions30, memCount: memCount30, kbCount: kbCount30 } }));
      return;
    }
    console.log(`\n🤵 Jeeves — value report\n`);
    console.log(`All time: ${sessions} session(s) across ${projects.size} project(s).`);
    console.log(`  • Memory recalled in ${memEvents} session(s) — ${memCount} entr${memCount === 1 ? "y" : "ies"} surfaced.`);
    console.log(`  • KB docs surfaced: ${kbCount} (across ${kbEvents} prompt${kbEvents === 1 ? "" : "s"}).`);
    console.log(`\nLast 30 days: ${sessions30} session(s); ${memCount30} memory + ${kbCount30} KB item(s) put in front of you`);
    console.log(`— knowledge you'd otherwise have re-derived. (Surfacing count; local only.)\n`);
    return;
  }

  if (MODE === "bootstrap-thinking") {
    const dirs = ["sessions", "topics", "decisions"].map(d => path.join(THINKING_DIR, d));
    for (const d of dirs) fs.mkdirSync(d, { recursive: true });
    const indexPath = path.join(THINKING_DIR, "INDEX.md");
    if (!exists(indexPath)) {
      fs.writeFileSync(indexPath,
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
`);
    }
    process.stdout.write("bootstrapped");
    return;
  }

  if (MODE === "capture-check") {
    const NUDGE_INTERVAL = 5, SUBSTANCE_THRESHOLD = 6, GIT_DEFER_WINDOW = 8;
    const state = detectState();
    const prompts = parseInt(argVal("--prompts") || "0", 10) || 0;
    const headLast = argVal("--head-last") || "";
    // Prompt index at which session-check last OBSERVED HEAD move. The hook owns
    // this (it runs every prompt and detects commits via headChanged); the gate
    // only reads it. deferForGit is a WINDOW (GIT_DEFER_WINDOW prompts) after a
    // commit, not "HEAD differs from last check" — the latter is always false by
    // the time the Stop gate runs because session-check already advanced
    // head_at_last_check on the same prompt.
    const lastCommitPrompt = parseInt(argVal("--last-commit-prompt") || "0", 10) || 0;
    // Per-session baseline: the hook records the newest thinking/ mtime that
    // existed BEFORE this session and passes it as --since. A capture counts
    // only if it is newer than that baseline, so a decision file written in a
    // PRIOR session does not silence the gate forever. Default 0 = "any file
    // counts" (used only by direct/standalone invocations and the bootstrap path).
    // parseFloat (NOT parseInt): mtimeMs is a float on APFS/ext4 (sub-ms
    // precision). parseInt would truncate the baseline, making every prior
    // file's mtime compare strictly greater and silently re-introducing the
    // "gate silenced forever" bug.
    const since = parseFloat(argVal("--since") || "0") || 0;
    const isThinking = state.mode === "brainstorm" || state.mode === "both";

    let captured = false;
    let newest = 0; // newest mtime (ms) across thinking/{decisions,topics,sessions}
    if (exists(THINKING_DIR)) {
      const subdirs = ["decisions", "topics", "sessions"].map(d => path.join(THINKING_DIR, d));
      for (const d of subdirs) {
        if (!exists(d)) continue;
        for (const f of fs.readdirSync(d)) {
          try { newest = Math.max(newest, fs.statSync(path.join(d, f)).mtimeMs); } catch {}
        }
      }
      // INDEX.md alone (just the bootstrap header) does NOT count as a capture;
      // only files inside decisions/topics/sessions, newer than the session
      // baseline, count.
      if (newest > since) captured = true;
    }

    // Registration-capture signals (v1: value-moment nudge for signup)
    const REGISTRATION_PROMPT_THRESHOLD = 8;
    const REGISTRATION_CAPTURE_THRESHOLD = 2;
    let captureCount = 0;
    if (exists(THINKING_DIR)) {
      // Count real captures only — decisions + topics. NOT sessions/: the Stop-gate salvage
      // writes a "No decisions … arose this session" file there, which would inflate the
      // "Jeeves has captured N decisions for you" signup nudge with empty sessions (v4.16.0).
      for (const d of ["decisions", "topics"]) {
        const dir = path.join(THINKING_DIR, d);
        if (!exists(dir)) continue;
        try { captureCount += fs.readdirSync(dir).filter(f => f.endsWith(".md")).length; } catch {}
      }
    }
    const homeKey = path.join(process.env.HOME || "", ".jeeves", "key");
    let keyPresent = false;
    try {
      if (exists(homeKey)) {
        const k = fs.readFileSync(homeKey, "utf-8").trim();
        keyPresent = k.length > 0;
      }
    } catch {}
    const shouldOfferRegistration =
      isThinking &&
      captureCount >= REGISTRATION_CAPTURE_THRESHOLD &&
      prompts >= REGISTRATION_PROMPT_THRESHOLD &&
      !keyPresent;

    let head = "";
    try { head = run("git rev-parse HEAD 2>/dev/null").trim(); } catch {}
    // headChanged = a commit happened since the hook last recorded HEAD. The hook
    // turns this into a prompt-indexed last_commit_prompt. recentGitCommit is the
    // deferral window: within GIT_DEFER_WINDOW prompts of the last observed commit.
    const headChanged = !!(head && headLast && head !== headLast);
    const recentGitCommit = lastCommitPrompt > 0 && (prompts - lastCommitPrompt) < GIT_DEFER_WINDOW;

    const sessionHasSubstance = prompts >= SUBSTANCE_THRESHOLD;
    // Also defer on headChanged: a commit made DURING the current turn is only turned into
    // last_commit_prompt by session-check on the NEXT prompt, so without this the Stop gate at
    // the end of the committing turn wouldn't defer and could hard-block — the exact moment the
    // git-defer window exists to protect (v4.16.0).
    const deferForGit = state.mode === "both" && (recentGitCommit || headChanged);
    // Don't hard-block before the user has seen at least one nudge. Nudges fire at the
    // first prompt that is a multiple of NUDGE_INTERVAL and >= SUBSTANCE_THRESHOLD
    // (i.e. prompt 10 with the defaults); blocking at 6-9 would ambush a session that
    // was never warned. Gate the block on that same first-nudge point.
    const firstNudgeAt = Math.ceil(SUBSTANCE_THRESHOLD / NUDGE_INTERVAL) * NUDGE_INTERVAL;
    const shouldBlock = isThinking && prompts >= firstNudgeAt && !captured && !deferForGit;
    const shouldNudge = isThinking && prompts > 0 && prompts % NUDGE_INTERVAL === 0 && !captured && !deferForGit && sessionHasSubstance;

    const payload = {
      mode: state.mode,
      sessionId: argVal("--session") || "",
      promptsThisSession: prompts,
      captured, // true once a this-session thinking/ write exists; hook resets nudge_level on it
      lastThinkingWriteAgo: captured ? 0 : -1,
      newest, // ms; the hook records this on its first call as the per-session --since baseline
      sessionHasSubstance,
      recentGitCommit,
      headChanged, // hook sets last_commit_prompt=prompts when this is true
      head,
      shouldNudge,
      shouldBlock,
      captureTargets: ["thinking/decisions/", "thinking/INDEX.md"],
      captureCount,
      keyPresent,
      shouldOfferRegistration,
    };
    process.stdout.write(JSON.stringify(payload));
    return;
  }

  if (MODE === "check") {
    const broken = findBrokenPaths();
    const unindexed = findUnindexedDocs();
    // Hoist getDocumentedEntities() out of the filter — it reads + regex-scans
    // SYSTEM-MAP, and calling it per schema entity re-read the file N times on this
    // session-start hot path.
    const documented = new Set(getDocumentedEntities().map(d => d.toLowerCase()));
    const missingEntities = getSchemaEntities().filter(e => !documented.has(e.toLowerCase()));
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
          deleted: git.deletedCodeFiles.length,
        },
        brokenPaths: broken,
        unindexedDocs: unindexed,
        missingEntities,
      };
      process.stdout.write(JSON.stringify(payload));
      return;
    }

    // Human-readable session-start report
    console.log(`\n📋 Jeeves — Session Check\n`);
    console.log(`Mode: ${state.mode}`);
    console.log(`KB: ${state.patternCount} patterns, ${state.decisionCount} decisions`);
    console.log(`SYSTEM-MAP: ${state.hasSystemMap ? "✓" : "✗ MISSING"}`);

    if (git.lastDocDate) {
      console.log(`Last doc update: ${git.lastDocDate}`);
    }

    if (totalChanges > 0) {
      console.log(`Code changes since last doc update: ${totalChanges} files (${git.newCodeFiles.length} new, ${git.changedCodeFiles.length} modified, ${git.deletedCodeFiles.length} deleted)`);
    } else {
      console.log("Docs are up to date with code.");
    }

    if (broken.length > 0) {
      console.log(`⚠ ${broken.length} broken file path(s) in docs`);
    }
    if (unindexed.length > 0) {
      console.log(`⚠ ${unindexed.length} doc(s) not indexed in SYSTEM-MAP`);
    }
    if (missingEntities.length > 0) {
      console.log(`⚠ ${missingEntities.length} schema entities not in SYSTEM-MAP: ${missingEntities.join(", ")}`);
    }

    console.log("");
    return;
  }

  if (MODE === "stale" || MODE === "health") {
    // These are pure-data modes — actions or health score, always as JSON.
    const actions = generateActions(state, git);

    if (MODE === "stale") {
      const payload = {
        total: actions.length,
        byPriority: {
          high: actions.filter(a => a.priority === "high").length,
          medium: actions.filter(a => a.priority === "medium").length,
          low: actions.filter(a => a.priority === "low").length,
        },
        actions: actions.map(a => ({
          type: a.type,
          priority: a.priority,
          target: a.target,
          description: a.description,
        })),
      };
      process.stdout.write(JSON.stringify(payload));
      return;
    }

    // MODE === "health" — prefer the plugin's health-score.sh (works on plugin-only
    // installs; avoids a stale vendored copy). Falls back to a project-local copy.
    const healthScript = resolveScript("health-score.sh");
    if (!healthScript) {
      process.stdout.write(JSON.stringify({ error: "health-score.sh not found (no plugin root or project-local copy)" }));
      return;
    }
    const raw = runFile("bash", [healthScript, ROOT], { timeout: 30000 });
    const final = raw.match(/HEALTH SCORE:\s*(\d+)\/100\s*\(([A-F])\s*—\s*([^)]+)\)/);
    const categories: Record<string, { score: number; max: number }> = {};
    const catRegex = /(Structure|Freshness|Completeness|Audit Health|Lint):\s*(\d+)\/(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = catRegex.exec(raw)) !== null) {
      const key = m[1].toLowerCase().replace(/\s+/g, "_");
      categories[key] = { score: parseInt(m[2], 10), max: parseInt(m[3], 10) };
    }
    const recommendations: string[] = [];
    const recRegex = /^\s*→\s*(.+)$/gm;
    while ((m = recRegex.exec(raw)) !== null) {
      recommendations.push(m[1].trim());
    }
    const payload = final
      ? {
          score: parseInt(final[1], 10),
          grade: final[2],
          status: final[3].trim(),
          categories,
          recommendations,
        }
      : { error: "Could not parse health score", raw: raw.slice(0, 800) };
    process.stdout.write(JSON.stringify(payload));
    return;
  }

  // Full sync or handoff.
  // Not-initialized guard: with no docs/internal/ or thinking/, there's no KB to sync.
  // Reporting "everything is in order" here is a false success (the #1 bootstrap
  // complaint) — point the user at init instead.
  if (state.mode === "none") {
    console.log(`\n🤵 Jeeves — not initialized\n`);
    console.log(`No knowledge base found (no docs/internal/ or thinking/). Nothing to sync yet.`);
    console.log(`Run \`jeeves --init\` (or /jeeves:init) to scaffold the KB and populate it from this codebase.\n`);
    return;
  }

  const actions = generateActions(state, git);

  console.log(`\n🤵 Jeeves — ${MODE === "handoff" ? "Handoff" : "Sync"}\n`);

  if (actions.length === 0) {
    console.log("Everything is in order. No actions needed.\n");
  } else {
    console.log(`${actions.length} action(s):\n`);
    for (const action of actions) {
      const icon = action.priority === "high" ? "🔴" : action.priority === "medium" ? "🟡" : "🟢";
      console.log(`${icon} ACTION [${action.type}]: ${action.description}`);
      console.log(`   Target: ${action.target}`);
      console.log("");
    }
  }

  // Concept index: report only, don't rewrite. Rewriting on every sync
  // created working-tree churn after every check, forcing users to commit
  // incidental drift. Regenerate explicitly via `--index` mode instead.
  if (state.hasDocs) {
    const entries = buildConceptIndex();
    console.log(`📚 Concept index: ${entries.length} concepts across ${new Set(entries.flatMap(e => e.docs)).size} docs (run with --index to regenerate the file)`);
  }

  // Self-heal .gitattributes: mark CONCEPT-INDEX.md as linguist-generated so
  // it collapses in PR diffs. Idempotent — only appends if missing. Plugin
  // installs don't run the bootstrap step that would otherwise do this.
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

  // Auto-heal broken paths. PREFER the plugin's heal-docs.ts over any
  // project-local scripts/heal-docs.ts: a plugin update cannot refresh a copy
  // committed into the user's repo, so a stale local copy would keep running
  // pre-safety-guard logic (the kind that made meaning-inverting edits) on every
  // sync. The plugin copy is always current. heal-docs reads process.cwd() for
  // the project root and run() execs with cwd=ROOT, so an absolute plugin path
  // still scans THIS project's docs. Fall back to a local copy only when there's
  // no plugin root (toolkit-only installs that vendored the scripts in).
  const localHeal = path.join(ROOT, "scripts", "heal-docs.ts");
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const pluginHeal = pluginRoot ? path.join(pluginRoot, "scripts", "heal-docs.ts") : "";
  let healToRun = "";
  if (pluginHeal && exists(pluginHeal)) {
    healToRun = pluginHeal;
    if (exists(localHeal)) {
      console.log("ℹ️  Auto-heal is using the plugin's heal-docs.ts; your repo's scripts/heal-docs.ts is bypassed (safe to delete — see README \"Updating\").");
    }
  } else if (exists(localHeal)) {
    healToRun = localHeal;
  }
  if (healToRun) {
    const healResult = runFile("npx", ["tsx", healToRun, "--fix"], { timeout: 30000 }).split("\n").slice(-3).join("\n");
    if (healResult.includes("fixed")) {
      console.log(`🔧 ${healResult.trim()}`);
    }
  }

  // Quick health summary — prefer the plugin's health-score.sh (parity with --health).
  const healthScript = resolveScript("health-score.sh");
  if (healthScript) {
    const healthResult = runFile("bash", [healthScript, ROOT], { timeout: 15000 }).split("\n").filter(l => l.includes("HEALTH SCORE")).join("\n");
    if (healthResult) {
      console.log(`${healthResult.trim()}`);
    }
  }

  console.log("");

  if (MODE === "handoff") {
    const handoff = generateHandoff(state, git, actions);
    // Code-only repos: write the handoff under docs/internal/, NOT thinking/. Creating
    // thinking/ would flip detectState() to "both" and silently start capture nudges +
    // the Stop gate on a project that never opted into thinking-mode. Only write to
    // thinking/ when the repo is already in a thinking mode.
    const isThinking = state.mode === "brainstorm" || state.mode === "both";
    const sessionFile = isThinking
      ? path.join(THINKING_DIR, "sessions", `${today()}-handoff.md`)
      : path.join(DOCS_DIR, "sessions", `${today()}-handoff.md`);

    // Ensure directory exists
    const sessionDir = path.dirname(sessionFile);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    fs.writeFileSync(sessionFile, handoff);
    console.log(`\n📝 Handoff written to: ${path.relative(ROOT, sessionFile)}`);
    console.log("");
  }
}

// Fail-open boundary. jeeves.ts runs inside hooks whose contract is "never crash the
// user's session". Any unguarded fs/git throw (file deleted mid-scan, permission
// error, ENOENT on a missing docs/ dir) must degrade to a clean exit, not a stack
// trace injected into hook output. JSON modes already wrote their payload before any
// late throw; a bare-exit here is the safe floor.
try {
  main();
} catch (e) {
  if (JSON_OUT) { try { process.stdout.write("{}"); } catch {} }
  else { try { console.error(`jeeves: ${e instanceof Error ? e.message : String(e)}`); } catch {} }
  process.exit(0);
}

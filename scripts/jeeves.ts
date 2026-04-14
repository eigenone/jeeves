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
import { execSync } from "child_process";

const ROOT = process.argv.find(a => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]) || process.cwd();
const MODES = ["handoff", "check", "index", "annotate", "verify", "research", "save", "summary", "export", "reconcile", "driftcheck", "trace", "extract", "design", "archive"] as const;
const MODE = MODES.find(m => process.argv.includes(`--${m}`)) || "sync";
const DOCS_DIR = path.join(ROOT, "docs", "internal");
const THINKING_DIR = path.join(ROOT, "thinking");
const SYSTEM_MAP = path.join(DOCS_DIR, "SYSTEM-MAP.md");
const LOG_FILE = path.join(DOCS_DIR, "log.md");
const PATTERNS_DIR = path.join(DOCS_DIR, "patterns");
const DECISIONS_DIR = path.join(DOCS_DIR, "decisions");

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
  // Look for entity registry table rows: | EntityName | ... |
  const entitySection = content.match(/(?:entity|entities|registry|models)[\s\S]*?\n\|.*\|.*\|\n((?:\|.*\|.*\|\n?)*)/i);
  if (!entitySection) return [];
  const rows = entitySection[1].match(/^\|\s*`?(\w+)`?\s*\|/gm);
  if (!rows) return [];
  return rows.map(r => {
    const match = r.match(/^\|\s*`?(\w+)`?\s*\|/);
    return match ? match[1] : "";
  }).filter(Boolean);
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

  const codeFilter = "grep -vE '^(docs/|thinking/|\\.claude/|\\.|README|LICENSE|CHANGELOG|package|tsconfig|node_modules/)' | grep -E '\\.(ts|tsx|js|jsx|py|go|rs|prisma|sql)$'";

  let changedCodeFiles: string[] = [];
  let newCodeFiles: string[] = [];
  let deletedCodeFiles: string[] = [];

  if (lastDocCommit) {
    const changed = run(`git diff --name-only --diff-filter=M ${lastDocCommit}..HEAD 2>/dev/null | ${codeFilter}`);
    changedCodeFiles = changed ? changed.split("\n") : [];

    const added = run(`git diff --name-only --diff-filter=A ${lastDocCommit}..HEAD 2>/dev/null | ${codeFilter}`);
    newCodeFiles = added ? added.split("\n") : [];

    const deleted = run(`git diff --name-only --diff-filter=D ${lastDocCommit}..HEAD 2>/dev/null | ${codeFilter}`);
    deletedCodeFiles = deleted ? deleted.split("\n") : [];
  }

  const msgs = run("git log --format='%s' -10");
  const recentCommitMessages = msgs ? msgs.split("\n") : [];

  return { lastDocCommit, lastDocDate, changedCodeFiles, newCodeFiles, deletedCodeFiles, recentCommitMessages };
}

// ── Pattern analysis ─────────────────────────────────────────

function getPatternFiles(): Map<string, string[]> {
  // Map pattern doc name → files it references
  const result = new Map<string, string[]>();
  if (!exists(PATTERNS_DIR)) return result;

  for (const file of fs.readdirSync(PATTERNS_DIR).filter(f => f.endsWith(".md"))) {
    const content = read(path.join(PATTERNS_DIR, file));
    const paths = [...content.matchAll(/`([a-zA-Z][a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})`/g)]
      .map(m => m[1])
      .filter(p => !p.startsWith("http") && !p.startsWith("@") && p.includes("/"));
    result.set(file, paths);
  }
  return result;
}

function findBrokenPaths(): Array<{ doc: string; brokenPath: string }> {
  const broken: Array<{ doc: string; brokenPath: string }> = [];
  const allDocs = getAllMdFiles(DOCS_DIR);

  for (const docPath of allDocs) {
    const content = read(docPath);
    const paths = [...content.matchAll(/`([a-zA-Z][a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})`/g)]
      .map(m => m[1])
      .filter(p =>
        !p.startsWith("http") && !p.startsWith("@") && !p.startsWith("node:") &&
        !p.startsWith("$") && p.includes("/") && !p.includes("*") &&
        !p.includes("<") && !p.includes("{{")
      );

    for (const ref of paths) {
      // Strip :line or :line:col suffix (common in references like `file.ts:42`)
      const cleanRef = ref.replace(/:\d+(:\d+)?$/, "");
      if (!exists(path.join(ROOT, cleanRef))) {
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
      if (!systemMapContent.includes(file)) {
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
  for (const [, refs] of patternFiles) {
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

  for (const [patternFile, refs] of patternFiles) {
    const docRelPath = `docs/internal/patterns/${patternFile}`;

    // Get doc's last commit SHA and the files touched in that commit
    const docLastSha = run(`git log -1 --format=%H -- "${docRelPath}" 2>/dev/null`);
    if (!docLastSha) continue; // Not tracked by git — skip

    const docCommitFiles = new Set(
      (run(`git show --name-only --format="" ${docLastSha} 2>/dev/null`) || "")
        .split("\n")
        .filter(Boolean)
    );

    const staleRefs: string[] = [];
    for (const ref of refs) {
      if (isIgnoredForStaleness(ref)) continue;
      if (!exists(path.join(ROOT, ref))) continue;

      // Was this file modified AFTER the doc's last commit?
      const refLastSha = run(`git log -1 --format=%H -- "${ref}" 2>/dev/null`);
      if (!refLastSha || refLastSha === docLastSha) continue; // Same commit or not tracked

      // Check if the ref's latest commit is actually newer than doc's
      const isNewer = run(`git log --format=%H ${docLastSha}..HEAD -- "${ref}" 2>/dev/null`);
      if (!isNewer) continue; // Ref wasn't changed after doc's commit

      // Was the ref also touched in the doc's commit? If so, they were updated together → fresh
      if (docCommitFiles.has(ref)) continue;

      staleRefs.push(ref);
    }

    if (staleRefs.length > 0 && !actions.some(a => a.target.includes(patternFile))) {
      // 1 changed ref is often a false positive (implementation change that doesn't
      // affect the doc's claims). 2+ is more likely real drift. Use priority to
      // distinguish: low = informational, medium = likely real.
      actions.push({
        type: "update",
        target: docRelPath,
        description: `Stale — ${staleRefs.length} referenced file(s) changed since doc was last updated: ${staleRefs.slice(0, 3).join(", ")}`,
        priority: staleRefs.length >= 2 ? "medium" : "low",
      });
    }
  }

  // 5. Concept-index-based affected docs — DISABLED.
  // Previously this fanned out "Review" actions for every doc tangentially
  // related to a changed file via shared concept headings. The correlation
  // is too loose to be useful: a doc that mentions "database" once gets
  // flagged every time any file in the database concept changes, and
  // concepts like "clerk", "next.js", "api" hit half the codebase. We keep
  // the direct file-reference staleness check above (section 4) which is
  // precise, and rely on broken-path + overlap detection for structural
  // drift. Leave this block as a no-op documentation of the removed behavior.

  // 4b. Also check direct file references in pattern docs (fallback for docs not in concept index)
  for (const [patternFile, refs] of patternFiles) {
    const staleRefs = refs.filter(ref =>
      git.deletedCodeFiles.includes(ref) ||
      git.changedCodeFiles.includes(ref)
    );
    if (staleRefs.length > 0 && !actions.some(a => a.target.includes(patternFile))) {
      const deleted = staleRefs.filter(r => git.deletedCodeFiles.includes(r));
      const changed = staleRefs.filter(r => git.changedCodeFiles.includes(r));
      let desc = `Review patterns/${patternFile}`;
      if (deleted.length) desc += ` — ${deleted.length} referenced files deleted`;
      if (changed.length) desc += ` — ${changed.length} referenced files changed`;
      actions.push({
        type: "update",
        target: `docs/internal/patterns/${patternFile}`,
        description: desc,
        priority: deleted.length > 0 ? "high" : "low",
      });
    }
  }

  // 5. Broken paths
  const broken = findBrokenPaths();
  if (broken.length > 0) {
    actions.push({
      type: "fix",
      target: "broken file paths",
      description: `${broken.length} broken path(s): ${broken.slice(0, 3).map(b => `${b.doc} → ${b.brokenPath}`).join("; ")}${broken.length > 3 ? ` (+${broken.length - 3} more)` : ""}`,
      priority: "high",
    });
  }

  // 6. Unindexed docs
  const unindexed = findUnindexedDocs();
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
  const git = getGitChanges();

  // ── Explorer tools ──────────────────────────────────────

  if (MODE === "research") {
    const topic = process.argv.slice(process.argv.indexOf("--research") + 1).filter(a => !a.startsWith("-")).join(" ") || "untitled";
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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

        // Check if there's a newer decision on the same topic
        const baseName = f.replace(".md", "");
        const otherDir = dir.includes("thinking") ? path.join(DOCS_DIR, "decisions") : path.join(THINKING_DIR, "decisions");
        if (exists(otherDir)) {
          for (const otherF of fs.readdirSync(otherDir).filter(of => of.endsWith(".md"))) {
            const otherBase = otherF.replace(".md", "");
            // Check for overlap in topic (rough match — shares 2+ words)
            const words = new Set(baseName.split("-"));
            const otherWords = otherBase.split("-");
            const overlap = otherWords.filter(w => words.has(w)).length;
            if (overlap >= 2 && baseName !== otherBase) {
              const otherMtime = fs.statSync(path.join(otherDir, otherF)).mtimeMs;
              const thisMtime = fs.statSync(path.join(dir, f)).mtimeMs;
              if (otherMtime > thisMtime) {
                driftItems.push({
                  file: relPath, type: "decision", severity: "superseded",
                  issue: `May be superseded by newer: ${path.relative(ROOT, path.join(otherDir, otherF))}`,
                });
              }
            }
          }
        }
      }
    }

    // Check thinking topics — "Current thinking" may be outdated if related decisions were made
    const topicsDir = path.join(THINKING_DIR, "topics");
    if (exists(topicsDir)) {
      for (const f of fs.readdirSync(topicsDir).filter(f => f.endsWith(".md"))) {
        const content = read(path.join(topicsDir, f));
        const relPath = `thinking/topics/${f}`;
        const mtime = fs.statSync(path.join(topicsDir, f)).mtimeMs;

        // Check if there are newer decisions that relate to this topic
        const topicWords = new Set(f.replace(".md", "").split("-"));
        for (const decDir of [path.join(DOCS_DIR, "decisions"), path.join(THINKING_DIR, "decisions")]) {
          if (!exists(decDir)) continue;
          for (const df of fs.readdirSync(decDir).filter(df => df.endsWith(".md"))) {
            const decWords = df.replace(".md", "").split("-");
            const overlap = decWords.filter(w => topicWords.has(w)).length;
            if (overlap >= 2) {
              const decMtime = fs.statSync(path.join(decDir, df)).mtimeMs;
              if (decMtime > mtime) {
                driftItems.push({
                  file: relPath, type: "topic", severity: "outdated",
                  issue: `Topic not updated since decision was made: ${df.replace(".md", "")}`,
                });
                break;
              }
            }
          }
        }

        // Check if topic has "Proposals" that were actually decided
        if (content.includes("## Proposals") || content.includes("## Proposals (not yet confirmed)")) {
          const proposalSection = content.match(/## Proposals[\s\S]*?(?=\n## |$)/);
          if (proposalSection && proposalSection[0].length > 50) {
            // Check if any of those proposals became decisions
            for (const decDir of [path.join(DOCS_DIR, "decisions")]) {
              if (!exists(decDir)) continue;
              const decMtime = fs.readdirSync(decDir)
                .filter(df => df.endsWith(".md"))
                .map(df => fs.statSync(path.join(decDir, df)).mtimeMs)
                .sort((a, b) => b - a)[0] || 0;
              if (decMtime > mtime) {
                driftItems.push({
                  file: relPath, type: "topic", severity: "outdated",
                  issue: `Has proposals that may have been decided since last update — check against recent decisions`,
                });
                break;
              }
            }
          }
        }
      }
    }

    // Check pattern docs — add age check, but skip analyses/ (they're time-boxed snapshots)
    if (exists(PATTERNS_DIR)) {
      for (const f of fs.readdirSync(PATTERNS_DIR).filter(f => f.endsWith(".md"))) {
        const fullPath = path.join(PATTERNS_DIR, f);
        const mtime = fs.statSync(fullPath).mtimeMs;
        const ageInDays = (Date.now() - mtime) / (1000 * 60 * 60 * 24);
        if (ageInDays > 14) {
          driftItems.push({
            file: `docs/internal/patterns/${f}`, type: "pattern", severity: "outdated",
            issue: `Not updated in ${Math.floor(ageInDays)} days — may be stale`,
          });
        }
      }
    }

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
    const codeFilter = "grep -vE '^(docs/|thinking/|\\.claude/|\\.|README|LICENSE|CHANGELOG|package|tsconfig|node_modules/)' | grep -E '\\.(ts|tsx|js|jsx|py|go|rs)$'";
    const allCode = run(`git ls-files 2>/dev/null | ${codeFilter}`);
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
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
    const codeFilter = "grep -vE '^(docs/|thinking/|\\.claude/|\\.|README|LICENSE|CHANGELOG|package|tsconfig|node_modules/)' | grep -E '\\.(ts|tsx|js|jsx|py|go|rs)$'";

    // Find code files with few or no comments
    const allCode = run(`git ls-files 2>/dev/null | ${codeFilter}`);
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
    const codeFilter = "grep -vE '^(docs/|thinking/|\\.claude/|\\.|README|LICENSE|CHANGELOG|package|tsconfig|node_modules/)' | grep -E '\\.(ts|tsx|js|jsx|py|go|rs)$'";

    const allCode = run(`git ls-files 2>/dev/null | ${codeFilter}`);
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

  if (MODE === "check") {
    // Quick session-start report
    console.log(`\n📋 Jeeves — Session Check\n`);
    console.log(`Mode: ${state.mode}`);
    console.log(`KB: ${state.patternCount} patterns, ${state.decisionCount} decisions`);
    console.log(`SYSTEM-MAP: ${state.hasSystemMap ? "✓" : "✗ MISSING"}`);

    if (git.lastDocDate) {
      console.log(`Last doc update: ${git.lastDocDate}`);
    }

    const totalChanges = git.changedCodeFiles.length + git.newCodeFiles.length + git.deletedCodeFiles.length;
    if (totalChanges > 0) {
      console.log(`Code changes since last doc update: ${totalChanges} files (${git.newCodeFiles.length} new, ${git.changedCodeFiles.length} modified, ${git.deletedCodeFiles.length} deleted)`);
    } else {
      console.log("Docs are up to date with code.");
    }

    const broken = findBrokenPaths();
    if (broken.length > 0) {
      console.log(`⚠ ${broken.length} broken file path(s) in docs`);
    }

    const unindexed = findUnindexedDocs();
    if (unindexed.length > 0) {
      console.log(`⚠ ${unindexed.length} doc(s) not indexed in SYSTEM-MAP`);
    }

    const missingEntities = getSchemaEntities().filter(
      e => !getDocumentedEntities().some(d => d.toLowerCase() === e.toLowerCase())
    );
    if (missingEntities.length > 0) {
      console.log(`⚠ ${missingEntities.length} schema entities not in SYSTEM-MAP: ${missingEntities.join(", ")}`);
    }

    console.log("");
    return;
  }

  // Full sync or handoff
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

  // Rebuild concept index on every sync
  if (state.hasDocs) {
    const entries = buildConceptIndex();
    writeConceptIndex(entries);
    console.log(`📚 Concept index: ${entries.length} concepts across ${new Set(entries.flatMap(e => e.docs)).size} docs`);
  }

  // Auto-heal broken paths if heal-docs.ts exists
  const healScript = path.join(ROOT, "scripts", "heal-docs.ts");
  if (exists(healScript)) {
    const healResult = run("npx tsx scripts/heal-docs.ts --fix 2>&1 | tail -3", { timeout: 30000 });
    if (healResult.includes("fixed")) {
      console.log(`🔧 ${healResult.trim()}`);
    }
  }

  // Quick health summary
  const healthScript = path.join(ROOT, "scripts", "health-score.sh");
  if (exists(healthScript)) {
    const healthResult = run("bash scripts/health-score.sh 2>&1 | grep 'HEALTH SCORE'", { timeout: 15000 });
    if (healthResult) {
      console.log(`${healthResult.trim()}`);
    }
  }

  console.log("");

  if (MODE === "handoff") {
    const handoff = generateHandoff(state, git, actions);
    const sessionFile = path.join(THINKING_DIR, "sessions", `${today()}-handoff.md`);

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

main();

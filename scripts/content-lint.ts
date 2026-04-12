/**
 * content-lint.ts — Content-level lint for knowledge base docs
 *
 * Goes beyond file-path lint to check doc QUALITY:
 * 1. Frontmatter presence and completeness
 * 2. Required sections per doc type
 * 3. Orphan pages (not linked from system map or any other doc)
 * 4. Missing cross-references (files in related[] that don't exist)
 * 5. Index completeness with summaries
 * 6. Activity log freshness
 *
 * The JUDGMENT checks (contradictions, stale claims) stay in prompt 17.
 * This script handles the MECHANICAL checks.
 *
 * Usage:
 *   npx tsx scripts/content-lint.ts           # Run all checks
 *   npx tsx scripts/content-lint.ts --fix     # Auto-fix what's possible
 */

import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, "docs", "internal");
const FIX_MODE = process.argv.includes("--fix");

interface LintResult {
  level: "error" | "warning" | "info";
  file: string;
  check: string;
  message: string;
}

const results: LintResult[] = [];

function addResult(level: LintResult["level"], file: string, check: string, message: string) {
  results.push({ level, file, check, message });
}

// ── Helpers ─────────────────────────────────────────────────────

function getAllMdFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllMdFiles(full));
    } else if (entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // Parse arrays: [a, b, c]
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map(s => s.trim());
    }

    fm[key] = value;
  }
  return fm;
}

function getRelPath(fullPath: string): string {
  return path.relative(ROOT, fullPath);
}

// ── Check 1: Frontmatter ─────────────────────────────────────

function checkFrontmatter() {
  const patternDir = path.join(DOCS_DIR, "patterns");
  const decisionDir = path.join(DOCS_DIR, "decisions");

  const checkDir = (dir: string, docType: string, requiredFields: string[]) => {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".md"))) {
      const fullPath = path.join(dir, file);
      const content = fs.readFileSync(fullPath, "utf-8");
      const relPath = getRelPath(fullPath);

      const fm = parseFrontmatter(content);
      if (!fm) {
        addResult("error", relPath, "frontmatter", `Missing frontmatter. ${docType} docs require YAML frontmatter.`);
        continue;
      }

      for (const field of requiredFields) {
        if (!fm[field]) {
          addResult("warning", relPath, "frontmatter", `Missing frontmatter field: ${field}`);
        }
      }

      // Check type matches
      if (fm.type && fm.type !== docType) {
        addResult("warning", relPath, "frontmatter", `Frontmatter type is "${fm.type}", expected "${docType}"`);
      }
    }
  };

  checkDir(patternDir, "pattern", ["title", "type", "created", "updated", "tags", "related"]);
  checkDir(decisionDir, "decision", ["title", "type", "created", "updated", "tags", "related", "status"]);
}

// ── Check 2: Required sections ───────────────────────────────

function checkRequiredSections() {
  const patternDir = path.join(DOCS_DIR, "patterns");
  const decisionDir = path.join(DOCS_DIR, "decisions");

  // Pattern docs
  if (fs.existsSync(patternDir)) {
    const patternSections = ["What this is", "How it works", "Key files", "Follow this pattern", "Gotchas"];
    for (const file of fs.readdirSync(patternDir).filter(f => f.endsWith(".md"))) {
      const content = fs.readFileSync(path.join(patternDir, file), "utf-8");
      const relPath = `docs/internal/patterns/${file}`;

      for (const section of patternSections) {
        if (!content.toLowerCase().includes(section.toLowerCase())) {
          addResult("warning", relPath, "sections", `Missing section: "${section}"`);
        }
      }

      // Check gotchas count
      const gotchaMatches = content.match(/^- \*\*/gm);
      if (gotchaMatches && gotchaMatches.length < 3) {
        addResult("info", relPath, "sections", `Only ${gotchaMatches.length} gotchas (recommend ≥3)`);
      }
    }
  }

  // Decision docs
  if (fs.existsSync(decisionDir)) {
    const decisionSections = ["Decision", "Context", "Why we chose", "Consequences", "thinking about changing"];
    for (const file of fs.readdirSync(decisionDir).filter(f => f.endsWith(".md"))) {
      const content = fs.readFileSync(path.join(decisionDir, file), "utf-8");
      const relPath = `docs/internal/decisions/${file}`;

      for (const section of decisionSections) {
        if (!content.toLowerCase().includes(section.toLowerCase())) {
          addResult("warning", relPath, "sections", `Missing section: "${section}"`);
        }
      }
    }
  }
}

// ── Check 3: Orphan pages ────────────────────────────────────

function checkOrphanPages() {
  const systemMapPath = path.join(DOCS_DIR, "SYSTEM-MAP.md");
  if (!fs.existsSync(systemMapPath)) return;

  const systemMap = fs.readFileSync(systemMapPath, "utf-8");
  const allDocs = getAllMdFiles(DOCS_DIR);

  // Read all docs to build a "referenced from" map
  const allContent = allDocs.map(f => ({
    path: getRelPath(f),
    content: fs.readFileSync(f, "utf-8"),
  }));

  for (const doc of allDocs) {
    const relPath = getRelPath(doc);
    const basename = path.basename(doc);

    // Skip non-pattern/decision docs
    if (!relPath.includes("/patterns/") && !relPath.includes("/decisions/")) continue;

    // Check if ANY other doc references this file
    const isReferenced = allContent.some(
      other => other.path !== relPath && (other.content.includes(basename) || other.content.includes(relPath))
    );

    if (!isReferenced) {
      addResult("warning", relPath, "orphan", "Not linked from any other doc (orphan page)");
    }
  }
}

// ── Check 4: Related field validation ────────────────────────

function checkRelatedFields() {
  const dirs = [path.join(DOCS_DIR, "patterns"), path.join(DOCS_DIR, "decisions")];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".md"))) {
      const content = fs.readFileSync(path.join(dir, file), "utf-8");
      const relPath = getRelPath(path.join(dir, file));

      const fm = parseFrontmatter(content);
      if (!fm || !fm.related) continue;

      const related = Array.isArray(fm.related) ? fm.related : [fm.related];
      for (const ref of related) {
        const refStr = String(ref).trim();
        if (!refStr) continue;

        // Try to find the referenced file
        const candidates = [
          path.join(DOCS_DIR, "patterns", refStr),
          path.join(DOCS_DIR, "decisions", refStr),
          path.join(DOCS_DIR, refStr),
        ];

        const exists = candidates.some(c => fs.existsSync(c));
        if (!exists) {
          addResult("warning", relPath, "related", `Related doc "${refStr}" not found`);
        }
      }
    }
  }
}

// ── Check 5: Activity log ────────────────────────────────────

function checkActivityLog() {
  const logPath = path.join(DOCS_DIR, "log.md");
  if (!fs.existsSync(logPath)) {
    addResult("warning", "docs/internal/log.md", "log", "Activity log does not exist. Create it to track knowledge base changes.");
    return;
  }

  const content = fs.readFileSync(logPath, "utf-8");
  const entries = content.match(/^## \[/gm);

  if (!entries || entries.length === 0) {
    addResult("warning", "docs/internal/log.md", "log", "Activity log exists but has no entries.");
  } else {
    addResult("info", "docs/internal/log.md", "log", `Activity log has ${entries.length} entries.`);
  }
}

// ── Check 6: System map index has summaries ──────────────────

function checkIndexSummaries() {
  const systemMapPath = path.join(DOCS_DIR, "SYSTEM-MAP.md");
  if (!fs.existsSync(systemMapPath)) return;

  const content = fs.readFileSync(systemMapPath, "utf-8");

  // Check pattern index rows have descriptions
  const patternRows = content.match(/\|.*\|.*patterns\/.*\.md.*\|/g);
  if (patternRows) {
    for (const row of patternRows) {
      const cols = row.split("|").map(c => c.trim()).filter(Boolean);
      if (cols.length < 2 || cols[0].length < 10) {
        addResult("info", "docs/internal/SYSTEM-MAP.md", "index", `Pattern index row may need a more descriptive task: "${cols[0]}"`);
      }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(DOCS_DIR)) {
    console.error(`ERROR: ${DOCS_DIR} does not exist`);
    process.exit(1);
  }

  console.log("=== Content Lint Report ===\n");

  checkFrontmatter();
  checkRequiredSections();
  checkOrphanPages();
  checkRelatedFields();
  checkActivityLog();
  checkIndexSummaries();

  // ── Report ──────────────────────────────────────────────

  const errors = results.filter(r => r.level === "error");
  const warnings = results.filter(r => r.level === "warning");
  const infos = results.filter(r => r.level === "info");

  if (errors.length > 0) {
    console.log(`\n── Errors (${errors.length}) — must fix ──\n`);
    for (const r of errors) {
      console.log(`  ✗ [${r.check}] ${r.file}`);
      console.log(`    ${r.message}`);
    }
  }

  if (warnings.length > 0) {
    console.log(`\n── Warnings (${warnings.length}) — should fix ──\n`);
    for (const r of warnings) {
      console.log(`  ⚠ [${r.check}] ${r.file}`);
      console.log(`    ${r.message}`);
    }
  }

  if (infos.length > 0) {
    console.log(`\n── Info (${infos.length}) ──\n`);
    for (const r of infos) {
      console.log(`  ℹ [${r.check}] ${r.file}`);
      console.log(`    ${r.message}`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Errors:   ${errors.length}`);
  console.log(`Warnings: ${warnings.length}`);
  console.log(`Info:     ${infos.length}`);

  if (errors.length > 0) {
    console.log(`\nContent lint FAILED. Fix errors before pushing.`);
    process.exit(1);
  } else if (warnings.length > 0) {
    console.log(`\nContent lint PASSED WITH WARNINGS.`);
    process.exit(0);
  } else {
    console.log(`\nContent lint PASSED.`);
    process.exit(0);
  }
}

main();

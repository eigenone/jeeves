/**
 * content-lint.ts — Content-level lint for knowledge base docs (report-only, advisory).
 * Doc QUALITY, not broken paths (that's lint-docs.ts, which gates pushes). content-lint
 * NEVER blocks — it reports at three severities so you can triage.
 *
 * ── SPEC (canonical; the templates in toolkit/templates/ are the source of truth) ──
 *
 * Severity:
 *   error   — a required element is missing. Frontmatter is REQUIRED on pattern +
 *             decision docs; its absence is the only error content-lint raises.
 *   warning — a recommended element is missing (frontmatter field, section, orphan,
 *             dangling related[] ref). Should fix; won't block anything.
 *   info    — a soft nudge (few gotchas, thin activity log).
 *
 * Required frontmatter fields:
 *   pattern  : title, type, created, updated, tags, related
 *   decision : title, type, created, updated, tags, related, status
 *
 * Recommended sections (mirror the templates; matched leniently, case-insensitive):
 *   pattern  : "What this is", "How it works", "Key files",
 *              "Follow this pattern", "Gotchas"   (template also: "Related docs")
 *   decision : "Decision", "Context", "Why we chose", "Consequences",
 *              "thinking about changing"           (template also: "Options considered")
 *
 * Other checks: orphan pages (warning), dangling related[] refs (warning), index
 * summary quality (info), activity-log freshness (info).
 *
 * Usage:
 *   npx tsx scripts/content-lint.ts           # run all checks (report-only)
 */

import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, "docs", "internal");

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
  const norm = content.replace(/^﻿/, "").replace(/\r\n/g, "\n"); // strip leading UTF-8 BOM + CRLF-tolerant (else false "missing frontmatter"; same fix the engine parser got in v4.16.0)
  const match = norm.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm: Record<string, unknown> = {};
  const lines = match[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*-\s/.test(line)) continue; // block-list item, consumed by its key below
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      // Inline array: [a, b, c]
      value = value.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
    } else if (value === "") {
      // Block-style list:  key:\n  - a\n  - b  (was parsed as empty -> false "missing field")
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s/.test(lines[j])) {
        items.push(lines[j].replace(/^\s*-\s*/, "").trim());
        j++;
      }
      if (items.length) { value = items; i = j - 1; }
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
// NOTE: these arrays mirror the headings in toolkit/templates/{pattern,decision}.template.md
// (see the SPEC in the file header). Matched leniently (substring, case-insensitive)
// and reported as warnings, never errors. Keep them in sync with the templates.

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

  console.log("=== Content Lint Report ===");
  console.log("(advisory — never blocks. error = required element missing (frontmatter);");
  console.log(" warning = recommended element missing (field/section/link); info = soft nudge.)\n");

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

  // Advisory only — content-lint NEVER blocks (fail-open house rule; it is not wired
  // into the pre-push gate). Always exit 0 regardless of severity; the report above is
  // the whole product. (Was exit(1) on errors, contradicting the file header.)
  if (errors.length > 0) {
    console.log(`\nContent lint found errors (advisory — does not block).`);
  } else if (warnings.length > 0) {
    console.log(`\nContent lint PASSED WITH WARNINGS.`);
  } else {
    console.log(`\nContent lint PASSED.`);
  }
  process.exit(0);
}

main();

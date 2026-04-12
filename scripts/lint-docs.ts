/**
 * lint-docs.ts — Validate internal knowledge-base docs against the codebase.
 *
 * Usage:
 *   npx tsx scripts/lint-docs.ts [project-root]
 *
 * Default project root: process.cwd()
 *
 * What it checks:
 *   1. Backtick-wrapped file paths in docs/internal/**\/*.md — do they exist?
 *   2. Every file in docs/internal/patterns/ is listed in SYSTEM-MAP.md pattern index
 *   3. Every file in docs/internal/decisions/ is listed in SYSTEM-MAP.md decision index
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — one or more checks failed
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW TO ADAPT FOR A SPECIFIC PROJECT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This script is intentionally generic. To add project-specific validation:
 *
 * 1. Entity registry validation:
 *    After reading SYSTEM-MAP.md, extract the entity table rows and verify each
 *    entity's listed schema path, API route, and UI path actually exist on disk.
 *    Example: parse the markdown table, grab the "Schema/Model" column, check
 *    that the file exists at the path listed.
 *
 * 2. Pattern checklist verification:
 *    For each pattern doc, check that the files listed in its "Key files" table
 *    and "Follow this pattern" checklist actually exist.
 *
 * 3. Dead pattern docs:
 *    Check for pattern/decision docs in the filesystem that are NOT listed in
 *    SYSTEM-MAP.md (the reverse of check #2/#3 above).
 *
 * 4. Link integrity for cross-doc references:
 *    Extract markdown links ([text](path)) in addition to backtick paths.
 *    Useful if your docs link to each other using markdown syntax.
 *
 * 5. Custom path prefixes:
 *    If your docs live at a different path (e.g., `.claude/docs/` or `wiki/`),
 *    change the DOCS_DIR constant below.
 */

import fs from "fs";
import path from "path";

// ─── Configuration ────────────────────────────────────────────────────────────

const projectRoot = process.argv[2] ?? process.cwd();
const DOCS_DIR = path.join(projectRoot, "docs", "internal");
const SYSTEM_MAP = path.join(DOCS_DIR, "SYSTEM-MAP.md");
const PATTERNS_DIR = path.join(DOCS_DIR, "patterns");
const DECISIONS_DIR = path.join(DOCS_DIR, "decisions");

// Paths that are intentionally relative references (skip these in path checks)
const SKIP_PATH_PATTERNS = [
  /^https?:\/\//, // URLs
  /^#/, // anchor links
  /^\.\.\//, // relative parent refs
  /^@/, // npm scoped packages (@auth/prisma-adapter, @modelcontextprotocol/sdk)
  /^node:/, // Node.js built-in modules
  /^\$/, // shell variables ($CLAUDE_PROJECT_DIR)
  /^[A-Z_]+$/, // constants (ALL_CAPS)
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function exists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * Extract all backtick-wrapped paths from a markdown string.
 * Matches: `path/to/file.ts`, `app/api/route.ts`, etc.
 * Skips: inline code that doesn't look like a file path.
 */
function extractFilePaths(markdown: string): string[] {
  const matches = markdown.matchAll(/`([^`]+)`/g);
  const paths: string[] = [];

  for (const match of matches) {
    const candidate = match[1];
    // Heuristic: looks like a file path if it contains a slash or a dot extension
    const looksLikePath =
      (candidate.includes("/") || /\.\w{2,6}$/.test(candidate)) &&
      !SKIP_PATH_PATTERNS.some((p) => p.test(candidate)) &&
      !candidate.includes(" ") && // no spaces in file paths
      !candidate.includes("(") && // not a function call
      candidate.length < 200;

    if (looksLikePath) {
      paths.push(candidate);
    }
  }

  return [...new Set(paths)]; // deduplicate
}

function getAllDocFiles(dir: string = DOCS_DIR): string[] {
  if (!exists(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllDocFiles(full));
    } else if (entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

function getPatternDocFiles(): string[] {
  if (!exists(PATTERNS_DIR)) return [];
  return fs.readdirSync(PATTERNS_DIR)
    .filter(f => f.endsWith(".md"))
    .map(f => path.join(PATTERNS_DIR, f));
}

function getDecisionDocFiles(): string[] {
  if (!exists(DECISIONS_DIR)) return [];
  return fs.readdirSync(DECISIONS_DIR)
    .filter(f => f.endsWith(".md"))
    .map(f => path.join(DECISIONS_DIR, f));
}

// ─── Check 1: File path references exist ─────────────────────────────────────

interface PathCheckResult {
  doc: string;
  referencedPath: string;
  resolvedPath: string;
  exists: boolean;
}

function checkFilePathReferences(): PathCheckResult[] {
  const results: PathCheckResult[] = [];
  const docFiles = getAllDocFiles();

  for (const docFile of docFiles) {
    const content = readFile(docFile);
    const referencedPaths = extractFilePaths(content);

    for (const refPath of referencedPaths) {
      // Strip :line or :line:col suffix (common in doc references like `file.ts:42`)
      const cleanPath = refPath.replace(/:\d+(:\d+)?$/, "");

      // Try resolving relative to project root
      const resolvedPath = path.isAbsolute(cleanPath)
        ? cleanPath
        : path.join(projectRoot, cleanPath);

      results.push({
        doc: path.relative(projectRoot, docFile),
        referencedPath: refPath,
        resolvedPath,
        exists: exists(resolvedPath)
      });
    }
  }

  return results;
}

// ─── Check 2: Pattern docs listed in SYSTEM-MAP.md ───────────────────────────

interface IndexCheckResult {
  docFile: string;
  docName: string;
  listedInSystemMap: boolean;
  section: "patterns" | "decisions";
}

function checkIndexCoverage(): IndexCheckResult[] {
  const results: IndexCheckResult[] = [];

  if (!exists(SYSTEM_MAP)) {
    console.warn(`  WARN: SYSTEM-MAP.md not found at ${SYSTEM_MAP}`);
    return results;
  }

  const systemMapContent = readFile(SYSTEM_MAP);

  // Check pattern docs
  const patternFiles = getPatternDocFiles();
  for (const patternFile of patternFiles) {
    const docName = path.basename(patternFile, ".md");
    const relPath = `patterns/${docName}.md`;

    results.push({
      docFile: path.relative(projectRoot, patternFile),
      docName,
      listedInSystemMap: systemMapContent.includes(relPath),
      section: "patterns"
    });
  }

  // Check decision docs
  const decisionFiles = getDecisionDocFiles();
  for (const decisionFile of decisionFiles) {
    const docName = path.basename(decisionFile, ".md");
    const relPath = `decisions/${docName}.md`;

    results.push({
      docFile: path.relative(projectRoot, decisionFile),
      docName,
      listedInSystemMap: systemMapContent.includes(relPath),
      section: "decisions"
    });
  }

  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  console.log(`\nLinting knowledge base docs in: ${DOCS_DIR}\n`);

  let totalChecks = 0;
  let totalFailures = 0;

  // ── Check 1: File path references ────────────────────────────────────────

  console.log("CHECK 1: File path references in docs");
  console.log("─".repeat(60));

  const pathResults = checkFilePathReferences();
  const brokenPaths = pathResults.filter((r) => !r.exists);

  if (pathResults.length === 0) {
    console.log("  (no docs found or no file paths referenced)\n");
  } else {
    const passCount = pathResults.length - brokenPaths.length;
    console.log(`  Checked: ${pathResults.length} references`);
    console.log(`  Passed:  ${passCount}`);
    console.log(`  Failed:  ${brokenPaths.length}\n`);

    if (brokenPaths.length > 0) {
      console.log("  BROKEN REFERENCES:");
      for (const result of brokenPaths) {
        console.log(`    FAIL  ${result.doc}`);
        console.log(`          references \`${result.referencedPath}\` — not found`);
      }
      console.log();
    }

    totalChecks += pathResults.length;
    totalFailures += brokenPaths.length;
  }

  // ── Check 2 & 3: SYSTEM-MAP.md index coverage ────────────────────────────

  console.log("CHECK 2: Pattern + decision docs indexed in SYSTEM-MAP.md");
  console.log("─".repeat(60));

  const indexResults = checkIndexCoverage();
  const unindexed = indexResults.filter((r) => !r.listedInSystemMap);

  if (indexResults.length === 0) {
    console.log("  (no pattern or decision docs found)\n");
  } else {
    const passCount = indexResults.length - unindexed.length;
    console.log(`  Checked: ${indexResults.length} docs`);
    console.log(`  Passed:  ${passCount}`);
    console.log(`  Failed:  ${unindexed.length}\n`);

    if (unindexed.length > 0) {
      console.log("  NOT INDEXED IN SYSTEM-MAP.md:");
      for (const result of unindexed) {
        const sectionLabel =
          result.section === "patterns" ? "Pattern Index (Section 5)" : "Decision Index (Section 6)";
        console.log(`    FAIL  ${result.docFile}`);
        console.log(`          not listed in SYSTEM-MAP.md ${sectionLabel}`);
      }
      console.log();
    }

    totalChecks += indexResults.length;
    totalFailures += unindexed.length;
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log("═".repeat(60));
  console.log(`SUMMARY: ${totalChecks - totalFailures}/${totalChecks} checks passed`);

  if (totalFailures === 0) {
    console.log("ALL CHECKS PASSED\n");
    process.exit(0);
  } else {
    console.log(`${totalFailures} FAILURE(S) — fix the issues above\n`);
    process.exit(1);
  }
}

main();

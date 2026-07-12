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
import { extractFileRefs, stripLineSuffix } from "./ref-extract";

// ─── Configuration ────────────────────────────────────────────────────────────

const projectRoot = process.argv[2] ?? process.cwd();
const DOCS_DIR = path.join(projectRoot, "docs", "internal");
const SYSTEM_MAP = path.join(DOCS_DIR, "SYSTEM-MAP.md");
const PATTERNS_DIR = path.join(DOCS_DIR, "patterns");
const DECISIONS_DIR = path.join(DOCS_DIR, "decisions");

// File-path reference detection (SOURCE_EXT, isFileRef, extractFileRefs) lives in the
// shared ref-extract module so this gate and heal-docs agree on what a ref is.

// ─── Helpers ──────────────────────────────────────────────────────────────────

function exists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

// Case-exact existence: on a case-insensitive FS (default macOS APFS), existsSync
// returns true for `lib/Auth.ts` when the real file is `lib/auth.ts` — masking a ref
// that is genuinely broken for Linux/CI collaborators. Verify the final segment's
// exact case via the parent directory listing.
function existsExactCase(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    return fs.readdirSync(path.dirname(filePath)).includes(path.basename(filePath));
  } catch {
    return false;
  }
}

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

// Boundary-aware "is this doc path referenced in the map" — not a raw substring, so
// `patterns/foo.md` isn't considered indexed just because it's a substring of a
// longer token. Requires the path to appear as a standalone token (table cell / link
// / list item), bounded by a non-path character or a line edge.
function listedInMap(mapContent: string, relPath: string): boolean {
  const esc = relPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w./-])${esc}([^\\w./-]|$)`, "m").test(mapContent);
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
    // Skip (don't abort) a file we can't read — a broken symlink or permission error
    // is an infra problem, not doc rot, and must not block the pre-push gate.
    let content: string;
    try { content = readFile(docFile); } catch { continue; }
    const referencedPaths = extractFileRefs(content);

    for (const refPath of referencedPaths) {
      const cleanPath = stripLineSuffix(refPath); // `file.ts:42`, `file.ts:12-40`

      // Multi-base resolution. A ref is valid if it exists relative to ANY of:
      //   - repo root         → code refs like `src/x.ts`
      //   - the doc's own dir  → doc-relative `./sibling.md` / `../y.md`
      //   - docs/internal/     → KB-relative `decisions/x.md` (matches the SYSTEM-MAP
      //                          index convention that Check 2 expects)
      // This reconciles Check 1 vs Check 2 and lets docs use concise intra-KB links.
      const bases = [projectRoot, path.dirname(docFile), DOCS_DIR];
      const candidates = path.isAbsolute(cleanPath)
        ? [cleanPath]
        : bases.map(b => path.join(b, cleanPath));
      const hit = candidates.find(existsExactCase);

      results.push({
        doc: path.relative(projectRoot, docFile),
        referencedPath: refPath,
        resolvedPath: hit ?? candidates[0], // report the repo-root candidate when missing
        exists: hit != null,
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
      listedInSystemMap: listedInMap(systemMapContent, relPath),
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
      listedInSystemMap: listedInMap(systemMapContent, relPath),
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

try {
  main();
} catch (e) {
  // Fail OPEN: a linter bug (unreadable file, regex/IO error) must never block the
  // pre-push gate. Warn to stderr and exit 0 so a non-zero exit unambiguously means
  // "real broken-path findings", which is the only thing the gate should block on.
  console.error(`lint-docs: internal error, skipping (fail-open): ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0);
}

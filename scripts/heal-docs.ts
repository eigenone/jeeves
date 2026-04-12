/**
 * heal-docs.ts — Self-healing documentation linter
 *
 * Goes beyond lint-docs.ts: instead of just reporting broken paths,
 * it tries to FIND the correct path and offers fixes.
 *
 * How it works:
 * 1. Scans all docs for backtick-wrapped file paths
 * 2. For each broken path, tries to find the file:
 *    a. Check if the file was renamed (git log --diff-filter=R)
 *    b. Search for the filename in the project (maybe it moved directories)
 *    c. Search for similar filenames (typo detection)
 * 3. Reports findings with suggested fixes
 * 4. With --fix flag, automatically applies the fixes
 *
 * Usage:
 *   npx tsx scripts/heal-docs.ts           # Report mode (dry run)
 *   npx tsx scripts/heal-docs.ts --fix     # Auto-fix mode
 *
 * Adapt the DOCS_DIR and CODE_DIRS constants for your project.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ── Configuration (adapt for your project) ─────────────────────────
const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, "docs", "internal");
const FIX_MODE = process.argv.includes("--fix");

// Directories that contain documented code files
const CODE_DIRS = ["lib", "app", "workers", "components", "prisma", "widget", "src", "packages", "e2e", "tests", "scripts", "drizzle", "config", "hooks", "contexts"];

// Regex to extract backtick-wrapped file paths
const PATH_REGEX = /`([a-zA-Z][a-zA-Z0-9_\-./]*\.[a-zA-Z]{1,4})`/g;
const DIR_REGEX = /`([a-zA-Z][a-zA-Z0-9_\-./]*\/)`/g;

// ── Helpers ─────────────────────────────────────────────────────────

function getAllDocFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
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

function fileExists(relativePath: string): boolean {
  // Try the path as-is
  if (fs.existsSync(path.join(ROOT, relativePath))) return true;
  // Try common extensions
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs"]) {
    if (fs.existsSync(path.join(ROOT, relativePath + ext))) return true;
  }
  return false;
}

function isCodePath(p: string): boolean {
  return CODE_DIRS.some((dir) => p.startsWith(dir + "/") || p.startsWith(dir + "\\"));
}

function getBasename(p: string): string {
  return path.basename(p);
}

/**
 * Try to find where a file was renamed to using git history.
 * Returns the new path if found, null otherwise.
 */
function findRenamedFile(oldPath: string): string | null {
  try {
    // Check git log for renames involving this filename
    const basename = getBasename(oldPath);
    const output = execSync(
      `git log --all --diff-filter=R --summary --format="" -- "*${basename}" 2>/dev/null | grep "rename" | head -5`,
      { cwd: ROOT, encoding: "utf-8", timeout: 5000 }
    ).trim();

    if (!output) return null;

    // Parse rename entries: "rename lib/{old.ts => new.ts} (100%)" or "rename lib/old.ts => lib/new.ts (95%)"
    for (const line of output.split("\n")) {
      // Look for the old path in the rename
      if (line.includes(basename)) {
        // Extract the "to" path from brace syntax: {old => new}
        const braceMatch = line.match(/rename\s+(.+)\{(.+)\s+=>\s+(.+)\}\s+\((\d+)%\)/);
        if (braceMatch) {
          const prefix = braceMatch[1].trim();
          const newName = braceMatch[3].trim();
          const newPath = prefix + newName;
          if (fs.existsSync(path.join(ROOT, newPath))) return newPath;
        }
        // Extract from arrow syntax: old => new
        const arrowMatch = line.match(/rename\s+(.+)\s+=>\s+(.+)\s+\((\d+)%\)/);
        if (arrowMatch) {
          const newPath = arrowMatch[2].trim();
          if (fs.existsSync(path.join(ROOT, newPath))) return newPath;
        }
      }
    }
  } catch {
    // git command failed — not a git repo or no history
  }
  return null;
}

/**
 * Search the project for files with the same basename.
 * Returns all matches (there might be multiple).
 */
function findByBasename(oldPath: string): string[] {
  const basename = getBasename(oldPath);
  const results: string[] = [];

  try {
    const output = execSync(
      `find . -name "${basename}" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.next/*" -not -path "*/dist/*" 2>/dev/null`,
      { cwd: ROOT, encoding: "utf-8", timeout: 5000 }
    ).trim();

    if (output) {
      for (const line of output.split("\n")) {
        const cleanPath = line.replace(/^\.\//, "");
        if (cleanPath && cleanPath !== oldPath) {
          results.push(cleanPath);
        }
      }
    }
  } catch {
    // find command failed
  }
  return results;
}

/**
 * Search for files with similar names (e.g., auth.ts vs dashboard-auth.ts).
 */
function findSimilarFiles(oldPath: string): string[] {
  const basename = getBasename(oldPath);
  const nameWithoutExt = basename.replace(/\.\w+$/, "");
  const results: string[] = [];

  try {
    const output = execSync(
      `find . -name "*${nameWithoutExt}*" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.next/*" -not -path "*/dist/*" 2>/dev/null`,
      { cwd: ROOT, encoding: "utf-8", timeout: 5000 }
    ).trim();

    if (output) {
      for (const line of output.split("\n")) {
        const cleanPath = line.replace(/^\.\//, "");
        if (cleanPath && cleanPath !== oldPath) {
          results.push(cleanPath);
        }
      }
    }
  } catch {
    // find command failed
  }
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

interface BrokenRef {
  docPath: string;       // which doc file
  lineNumber: number;    // line number in the doc
  brokenPath: string;    // the path that doesn't exist
  suggestion: string | null;  // suggested fix
  confidence: "high" | "medium" | "low";
  source: "renamed" | "moved" | "similar" | "none";
}

function main() {
  if (!fs.existsSync(DOCS_DIR)) {
    console.error(`ERROR: ${DOCS_DIR} does not exist`);
    process.exit(1);
  }

  const docFiles = getAllDocFiles(DOCS_DIR);
  const broken: BrokenRef[] = [];
  let totalPaths = 0;
  let validPaths = 0;

  for (const docFile of docFiles) {
    const content = fs.readFileSync(docFile, "utf-8");
    const lines = content.split("\n");
    const relDoc = path.relative(ROOT, docFile);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Extract file paths from backticks
      for (const regex of [PATH_REGEX, DIR_REGEX]) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(line)) !== null) {
          const refPath = match[1];

          // Skip non-code paths, URLs, placeholders
          if (!isCodePath(refPath)) continue;
          if (refPath.includes("{{")) continue;
          if (refPath.includes("*")) continue;
          if (refPath.includes("xxx") || refPath.includes("XXX")) continue;
          if (refPath.includes("<") || refPath.includes(">")) continue;
          if (/New[A-Z][a-z]+/.test(getBasename(refPath))) continue; // Skip placeholder names like NewType.tsx, NewFeature.ts
          if (/[Ee]xample|[Ss]ample|[Tt]emplate|[Pp]laceholder/.test(refPath)) continue;

          totalPaths++;

          if (fileExists(refPath)) {
            validPaths++;
            continue;
          }

          // Path is broken — try to heal it
          let suggestion: string | null = null;
          let confidence: "high" | "medium" | "low" = "low";
          let source: "renamed" | "moved" | "similar" | "none" = "none";

          // Strategy 1: Check git renames
          const renamed = findRenamedFile(refPath);
          if (renamed) {
            suggestion = renamed;
            confidence = "high";
            source = "renamed";
          }

          // Strategy 2: Search by basename (file moved to different directory)
          if (!suggestion) {
            const byBasename = findByBasename(refPath);
            if (byBasename.length === 1) {
              suggestion = byBasename[0];
              confidence = "high";
              source = "moved";
            } else if (byBasename.length > 1) {
              // Multiple matches — pick the one in the most similar directory
              const origDir = path.dirname(refPath);
              const best = byBasename.sort((a, b) => {
                const aDist = path.dirname(a).split("/").filter(p => origDir.includes(p)).length;
                const bDist = path.dirname(b).split("/").filter(p => origDir.includes(p)).length;
                return bDist - aDist;
              })[0];
              suggestion = best;
              confidence = "medium";
              source = "moved";
            }
          }

          // Strategy 3: Search for similar filenames
          if (!suggestion) {
            const similar = findSimilarFiles(refPath);
            if (similar.length === 1) {
              suggestion = similar[0];
              confidence = "medium";
              source = "similar";
            } else if (similar.length > 1 && similar.length <= 3) {
              suggestion = similar.join(" | ");
              confidence = "low";
              source = "similar";
            }
          }

          broken.push({
            docPath: relDoc,
            lineNumber: i + 1,
            brokenPath: refPath,
            suggestion,
            confidence,
            source,
          });
        }
      }
    }
  }

  // ── Report ──────────────────────────────────────────────────────

  console.log("=== Heal Docs Report ===\n");
  console.log(`Scanned: ${docFiles.length} docs, ${totalPaths} paths`);
  console.log(`Valid: ${validPaths}`);
  console.log(`Broken: ${broken.length}`);
  console.log("");

  if (broken.length === 0) {
    console.log("All paths are valid. Nothing to heal.");
    process.exit(0);
  }

  // Group by fixability
  const autoFixable = broken.filter(b => b.suggestion && b.confidence === "high");
  const suggestable = broken.filter(b => b.suggestion && b.confidence !== "high");
  const unfixable = broken.filter(b => !b.suggestion);

  if (autoFixable.length > 0) {
    console.log(`\n=== Auto-fixable (${autoFixable.length}) — high confidence ===\n`);
    for (const b of autoFixable) {
      console.log(`  ${b.docPath}:${b.lineNumber}`);
      console.log(`    ✗ ${b.brokenPath}`);
      console.log(`    → ${b.suggestion} (${b.source})`);
    }
  }

  if (suggestable.length > 0) {
    console.log(`\n=== Suggestions (${suggestable.length}) — review manually ===\n`);
    for (const b of suggestable) {
      console.log(`  ${b.docPath}:${b.lineNumber}`);
      console.log(`    ✗ ${b.brokenPath}`);
      console.log(`    ? ${b.suggestion} (${b.source}, ${b.confidence} confidence)`);
    }
  }

  if (unfixable.length > 0) {
    console.log(`\n=== Unfixable (${unfixable.length}) — file not found anywhere ===\n`);
    for (const b of unfixable) {
      console.log(`  ${b.docPath}:${b.lineNumber}`);
      console.log(`    ✗ ${b.brokenPath} — no match found`);
    }
  }

  // ── Auto-fix mode ───────────────────────────────────────────────

  if (FIX_MODE && autoFixable.length > 0) {
    console.log(`\n=== Applying ${autoFixable.length} auto-fixes ===\n`);

    // Group fixes by doc file
    const fixesByDoc = new Map<string, BrokenRef[]>();
    for (const b of autoFixable) {
      const existing = fixesByDoc.get(b.docPath) || [];
      existing.push(b);
      fixesByDoc.set(b.docPath, existing);
    }

    for (const [docPath, fixes] of fixesByDoc) {
      const fullPath = path.join(ROOT, docPath);
      let content = fs.readFileSync(fullPath, "utf-8");

      for (const fix of fixes) {
        // Replace the old path with the new path (within backticks)
        const oldRef = `\`${fix.brokenPath}\``;
        const newRef = `\`${fix.suggestion}\``;
        content = content.replace(oldRef, newRef);
        console.log(`  Fixed: ${fix.brokenPath} → ${fix.suggestion} in ${docPath}`);
      }

      fs.writeFileSync(fullPath, content);
    }

    console.log(`\nDone. ${autoFixable.length} paths fixed across ${fixesByDoc.size} files.`);
    console.log("Review the changes and commit.");
  } else if (FIX_MODE) {
    console.log("\nNo auto-fixable issues found.");
  } else if (autoFixable.length > 0) {
    console.log(`\nRun with --fix to auto-apply ${autoFixable.length} high-confidence fixes.`);
  }

  // Exit with error if there are unfixable issues
  if (unfixable.length > 0) {
    process.exit(1);
  }
}

main();

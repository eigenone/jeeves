/**
 * heal-docs.ts — Self-healing documentation linter
 *
 * Goes beyond lint-docs.ts: instead of just reporting broken paths,
 * it tries to FIND the correct path and offers fixes.
 *
 * How it works:
 * 1. Scans all docs for backtick-wrapped file paths
 * 2. For each broken path, tries to find the file:
 *    a. Check if the file was renamed (git log -M --name-status, v4.5.2 fix)
 *    b. Search for the filename in the project (maybe it moved directories)
 *    c. Search for similar filenames (typo detection)
 * 3. Reports findings with suggested fixes
 * 4. With --fix flag, automatically applies the fixes — but ONLY for fixes
 *    that pass the isAutoApplicable predicate (v4.5.2 safety guards):
 *    - Trustworthy source: git-confirmed rename OR single unambiguous basename move
 *    - Same package: suggestion stays within the same top-level package root
 *    - No historical/negation marker on the line (retired, deleted, was, etc.)
 *    - Not a historical doc (plans/, specs/, decisions/, sessions/, log.md, changelog.md)
 *    - Not opted out (<!-- heal-docs:ignore --> on the line, or status:archived frontmatter)
 *    Everything that fails any clause is downgraded to a report-only suggestion.
 * 5. On apply, prints a before/after diff for each changed line.
 *
 * Usage:
 *   npx tsx scripts/heal-docs.ts           # Report mode (dry run)
 *   npx tsx scripts/heal-docs.ts --fix     # Auto-fix mode
 *
 * Adapt the DOCS_DIR and CODE_DIRS constants for your project.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync, execFileSync } from "child_process";
import { isFileRef, stripLineSuffix } from "./ref-extract";

// ── Configuration (adapt for your project) ─────────────────────────
const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, "docs", "internal");
const FIX_MODE = process.argv.includes("--fix");

// Directories that contain documented code files
const CODE_DIRS = ["lib", "app", "workers", "components", "prisma", "widget", "src", "packages", "e2e", "tests", "scripts", "drizzle", "config", "hooks", "contexts"];

// Regex to extract backtick-wrapped file paths
// File-path ref detection now lives in ./ref-extract (isFileRef) — shared with the
// pre-push gate. Only DIR_REGEX (directory refs) remains heal-specific.
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
 *
 * v4.5.2 fix: the old invocation (`git log --diff-filter=R --summary -- "*basename"`)
 * was silently dead — the restrictive pathspec filters out the rename destination side
 * so git cannot pair old→new and emits nothing. We now use `-M --name-status` without
 * a pathspec and filter the results in JS, matching lines of the form:
 *   R<score>\t<old-path>\t<new-path>
 */
function findRenamedFile(oldPath: string): string | null {
  try {
    const basename = getBasename(oldPath);
    const oldDir = path.posix.dirname(oldPath);
    // Scan renames via --name-status (R<score>\told\tnew); filter in JS.
    // NOT `--all`: a rename on an abandoned/other branch must not heal a doc — we
    // only trust renames reachable from HEAD. No pathspec (it filters the dest
    // side). execFileSync (array args) — no shell, no injection.
    const output = execFileSync(
      "git",
      ["log", "-M", "--diff-filter=R", "--name-status", "--format="],
      { cwd: ROOT, encoding: "utf-8", timeout: 5000 }
    ).trim();
    if (!output) return null;
    // git log is reverse-chronological, so the first match is the most recent.
    // Exact-path match is the ONLY unambiguous signal. A same-basename rename in a
    // DIFFERENT directory (auth/session.ts vs payments/session.ts) must never win —
    // that produced confidently-wrong auto-edits. Accept a basename match only when
    // the source was in the SAME directory (file renamed in place); otherwise skip.
    let sameDirFallback: string | null = null;
    for (const line of output.split("\n").slice(0, 5000)) {
      const parts = line.split("\t");
      if (parts.length < 3 || !parts[0].startsWith("R")) continue;
      const oldRenamed = parts[1].trim();
      const newRenamed = parts[2].trim();
      if (!fs.existsSync(path.join(ROOT, newRenamed))) continue;
      if (oldRenamed === oldPath) return newRenamed; // exact — first (most recent) wins
      if (sameDirFallback === null &&
          getBasename(oldRenamed) === basename &&
          path.posix.dirname(oldRenamed) === oldDir) {
        sameDirFallback = newRenamed;
      }
    }
    return sameDirFallback;
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
    // execFileSync (array args) — no shell, so an odd basename can't inject.
    const output = execFileSync(
      "find",
      [".", "-name", basename, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/.next/*", "-not", "-path", "*/dist/*"],
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
    const output = execFileSync(
      "find",
      [".", "-name", `*${nameWithoutExt}*`, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/.next/*", "-not", "-path", "*/dist/*"],
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

// ── Safety guards (v4.5.2) ──────────────────────────────────────────
// heal-docs auto-applied confidently-wrong edits (UBQT 2026-06-14). These
// guards narrow the auto-applicable set so meaning-inverting / cross-package
// rewrites become report-only suggestions instead of silent edits.

const HISTORICAL_MARKER =
  /\b(retired|deleted|removed|legacy|former|formerly|deprecated|obsolete|old|pre-migration|no longer|used to|previously|replaced|superseded|was|were)\b/i;

const PACKAGE_PREFIXES = new Set(["apps", "packages", "services", "libs", "modules"]);

function packageRoot(p: string): string {
  // Operate on the DIRECTORY, never the filename — otherwise a same-directory rename
  // (scripts/old.ts -> scripts/new.ts) looks cross-package and the guard blocks a
  // legitimate auto-fix.
  const slash = p.lastIndexOf("/");
  const dir = slash >= 0 ? p.slice(0, slash) : "";
  const segs = dir.split("/").filter(Boolean);
  if (segs.length === 0) return ""; // root-level file
  if (PACKAGE_PREFIXES.has(segs[0]) && segs.length >= 2) return segs[0] + "/" + segs[1];
  // Single-root layouts (everything under src/, lib/, app/): compare the first two
  // DIRECTORY segments so src/auth vs src/payments count as different "packages".
  // With a one-segment root the guard was a no-op in the common single-src repo,
  // letting a same-basename cross-directory match auto-apply (confidently wrong).
  if (segs.length >= 2) return segs[0] + "/" + segs[1];
  return segs[0];
}

function crossesPackage(broken: string, suggestion: string): boolean {
  return packageRoot(broken) !== packageRoot(suggestion);
}

function hasHistoricalMarker(line: string): boolean {
  return HISTORICAL_MARKER.test(line);
}

function hasIgnoreMarker(line: string): boolean {
  return line.includes("<!-- heal-docs:ignore -->");
}

function isHistoricalDoc(relDocPath: string): boolean {
  const base = path.basename(relDocPath).toLowerCase();
  if (base === "log.md" || base === "changelog.md") return true;
  return /\/(plans|specs|decisions|sessions)\//.test("/" + relDocPath.replace(/\\/g, "/"));
}

function docIsArchived(fullDocPath: string): boolean {
  let c: string;
  try { c = fs.readFileSync(fullDocPath, "utf-8").replace(/\r\n/g, "\n"); } catch { return false; }
  if (!c.startsWith("---\n")) return false; // CRLF normalized above so `status: archived` opt-out isn't silently bypassed
  const end = c.slice(4).indexOf("\n---\n");
  if (end === -1) return false;
  for (const line of c.slice(4, 4 + end).split("\n")) {
    const m = line.match(/^(status|superseded-by):\s*(.+?)\s*$/);
    if (!m) continue;
    if (m[1] === "status" && m[2].trim() === "archived") return true;
    if (m[1] === "superseded-by" && m[2].trim().length > 0) return true;
  }
  return false;
}

// ── Main ────────────────────────────────────────────────────────────

interface BrokenRef {
  docPath: string;       // which doc file
  lineNumber: number;    // line number in the doc
  brokenPath: string;    // the path that doesn't exist
  suggestion: string | null;  // suggested fix
  confidence: "high" | "medium" | "low";
  source: "renamed" | "moved" | "similar" | "none";
  lineText: string;      // raw line, for ignore checks and diff output
  context: string;       // enclosing block (back to prev blank line), for marker check
  docArchived: boolean;  // frontmatter status:archived / superseded-by
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
    // Compute once per doc — recomputing frontmatter per line is wasteful.
    const archived = docIsArchived(docFile);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // FILE refs via the SHARED predicate (identical to the pre-push gate, so heal
      // can fix exactly what the gate flags — no more "gate says broken, heal says
      // all valid" for prisma/.svelte/etc.). DIRECTORY refs are heal-only (no
      // extension) so they still gate on CODE_DIRS via DIR_REGEX.
      const lineRefs: string[] = [];
      for (const bt of line.matchAll(/`([^`]+)`/g)) {
        if (bt[1] !== undefined && isFileRef(bt[1])) lineRefs.push(bt[1]);
      }
      DIR_REGEX.lastIndex = 0;
      let dmatch;
      while ((dmatch = DIR_REGEX.exec(line)) !== null) {
        if (isCodePath(dmatch[1])) lineRefs.push(dmatch[1]);
      }
      {
        for (const refPath of lineRefs) {
          // heal has never handled :line-suffixed refs; the gate reports them and the
          // user fixes them by hand. Preserve that (don't rewrite and drop the line#).
          if (refPath !== stripLineSuffix(refPath)) continue;
          // Semantic placeholder skips (isFileRef already excludes globs/<>/spaces).
          if (refPath.includes("{{")) continue;
          if (refPath.includes("xxx") || refPath.includes("XXX")) continue;
          if (/New[A-Z][a-z]+/.test(getBasename(refPath))) continue; // NewType.tsx etc.
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

          // Enclosing block: walk up to the previous blank line (capped), so a
          // "Deleted in v2:" header a few lines above a bulleted path list still
          // guards those paths from being auto-rewritten (meaning-inverting edit).
          let blockStart = i;
          while (blockStart > 0 && lines[blockStart - 1].trim() !== "" && i - blockStart < 12) blockStart--;
          const context = lines.slice(blockStart, i + 1).join("\n");

          broken.push({
            docPath: relDoc,
            lineNumber: i + 1,
            brokenPath: refPath,
            suggestion,
            confidence,
            source,
            lineText: line,
            context,
            docArchived: archived,
          });
        }
      }
    }
  }

  // ── Report ──────────────────────────────────────────────────────

  // A fix is auto-applied ONLY if it is trustworthy AND safe on every axis.
  // Everything else is downgraded to a report-only suggestion.
  function isAutoApplicable(b: BrokenRef): boolean {
    if (!b.suggestion) return false;
    // 1. Trustworthy source: git rename, or a single unambiguous same-name move.
    const trustworthy = b.source === "renamed" || (b.source === "moved" && b.confidence === "high");
    if (!trustworthy) return false;
    // 2. Never cross a package/app boundary.
    if (crossesPackage(b.brokenPath, b.suggestion)) return false;
    // 3. Never rewrite a path described as historical/retired. Check the ENCLOSING
    //    BLOCK, not just the ref's own line: the "Deleted in v2:\n- `x.ts`" idiom
    //    puts the marker on the header line, not the path line. Strip the backtick
    //    path token(s) first so filename tokens (e.g. "old" in "scripts/old.ts")
    //    don't self-trigger — only prose words matter.
    const contextWithoutPath = b.context.split(`\`${b.brokenPath}\``).join("");
    if (hasHistoricalMarker(contextWithoutPath)) return false;
    // 4. Never auto-edit append-only logs or dated plan/spec/decision/session docs.
    if (isHistoricalDoc(b.docPath)) return false;
    // 5. Honor explicit opt-out (line marker or archived/superseded frontmatter).
    if (hasIgnoreMarker(b.lineText)) return false;
    if (b.docArchived) return false;
    return true;
  }

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
  const autoFixable = broken.filter(isAutoApplicable);
  const suggestable = broken.filter(b => b.suggestion && !isAutoApplicable(b));
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
      const lines = fs.readFileSync(fullPath, "utf-8").split("\n");

      // Rewrite by line index, not whole-file string-replace: the same broken
      // path can appear on multiple lines, and a string `content.replace` only
      // hits the first occurrence — which would partially apply and make the
      // printed diff diverge from what's actually written.
      for (const fix of fixes) {
        const oldRef = `\`${fix.brokenPath}\``;
        const newRef = `\`${fix.suggestion}\``;
        const idx = fix.lineNumber - 1;
        const newLine = lines[idx].replace(oldRef, newRef);
        lines[idx] = newLine;
        console.log(`  ${fix.docPath}:${fix.lineNumber}`);
        console.log(`    - ${fix.lineText.trim()}`);
        console.log(`    + ${newLine.trim()}`);
      }

      fs.writeFileSync(fullPath, lines.join("\n"));
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

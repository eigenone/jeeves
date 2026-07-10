/**
 * ref-extract.ts — shared file-path reference extraction (v4.6.5).
 *
 * The SINGLE source of truth for "is this backtick token a file-path reference?",
 * used by BOTH lint-docs.ts (the pre-push gate) and heal-docs.ts (the fixer). Before
 * this, each had its own regex and they disagreed: the gate would flag a broken
 * `prisma/schema.prisma` / `*.svelte` ref, tell the user to run heal, and heal would
 * report "all valid" because its narrower regex never saw it. One predicate, one
 * behavior.
 *
 * A token qualifies only if it is path-shaped (contains "/", not a leading-slash URL
 * route) and ends in a known source/asset/config extension — deliberately NOT bare
 * filenames, URL routes, schema.table identifiers, <placeholders>, globs, or
 * hostnames (all common non-file backtick tokens that would otherwise false-positive).
 */

export const SOURCE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|css|scss|sass|less|md|mdx|prisma|sh|bash|zsh|sql|ya?ml|toml|ini|env|html|xml|svg|png|jpe?g|gif|webp|ico|py|rb|go|rs|java|kt|kts|swift|c|cc|cpp|cxx|h|hpp|cs|php|vue|svelte|astro|tf|gradle|txt|csv|proto|graphql|gql)$/i;

/** Strip a `:line`, `:line:col`, or `:line-line` suffix from a ref. */
export function stripLineSuffix(ref: string): string {
  return ref.replace(/:\d+([-:]\d+)?$/, "");
}

/** True if `token` (raw backtick content) is a path-shaped source-file reference. */
export function isFileRef(token: string): boolean {
  const cleanish = stripLineSuffix(token);
  const firstSeg = cleanish.split("/")[0];
  return (
    cleanish.includes("/") && // path-shaped (excludes bare `route.ts`, `events.outbox`)
    !cleanish.startsWith("/") && // excludes URL routes (/api/..., /flows)
    SOURCE_EXT.test(cleanish) && // ends in a real source/asset/config extension
    !/^https?:\/\//.test(cleanish) && // URLs
    !cleanish.startsWith("@") && // npm scoped packages
    !cleanish.startsWith("node:") && // node builtins
    !cleanish.includes(" ") && // no spaces in file paths
    !cleanish.includes("(") && // not a function call
    !cleanish.includes("<") && // placeholder tokens like /p/<id>/<slug>
    !/[*?{}]/.test(cleanish) && // globs (existsSync always fails them)
    !cleanish.startsWith("path/to/") && // the canonical placeholder-path idiom
    !firstSeg.includes(".") && // hostname-shaped (raw.githubusercontent.com/...)
    cleanish.length < 200
  );
}

/** All unique file-path refs in a chunk of markdown (raw tokens, incl any :line). */
export function extractFileRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    if (m[1] !== undefined && isFileRef(m[1])) out.push(m[1]);
  }
  return [...new Set(out)];
}

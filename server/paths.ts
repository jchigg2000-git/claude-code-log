import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Expand a leading `~` / `$HOME` to the user's home directory and normalize. */
export function expandHome(p: string): string {
  let out = p.trim();
  if (out === "~" || out.startsWith("~/")) {
    out = path.join(os.homedir(), out.slice(1));
  } else if (out.startsWith("$HOME")) {
    out = path.join(os.homedir(), out.slice("$HOME".length));
  }
  return path.resolve(out);
}

/**
 * Claude Code names each project directory after the absolute cwd it was
 * launched from, with every path separator replaced by a dash, e.g.
 *   /Users/me/Projects/app  ->  -Users-me-Projects-app
 *
 * Encoding (realPath -> dirName) is deterministic and lossless for matching.
 * Decoding (dirName -> realPath) is inherently ambiguous because a path
 * segment can itself contain a dash, so {@link decodeProjectDirApprox} is
 * BEST-EFFORT and is the LAST resort, never the first.
 *
 * Anything that needs a real path or a display name should go through
 * server/projectNames.ts, which recovers both by encoding paths already known
 * to be real and matching those. The approximate decode is correct only for a
 * log directory with no known counterpart — an orphan whose project has moved
 * or been deleted.
 */
export function encodeProjectDir(absPath: string): string {
  return path.resolve(absPath).split(path.sep).join("-");
}

export function decodeProjectDirApprox(dirName: string): string {
  // Leading dash represents the root separator.
  const body = dirName.startsWith("-") ? dirName.slice(1) : dirName;
  return path.sep + body.split("-").join(path.sep);
}

/**
 * Guard against path traversal: returns the resolved absolute path only if it
 * stays within `root`, otherwise null. This check is purely lexical — see
 * {@link safeResolveReal} for the symlink-aware version.
 */
export function safeResolve(root: string, candidate: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved === resolvedRoot) return resolved;
  if (resolved.startsWith(resolvedRoot + path.sep)) return resolved;
  return null;
}

/**
 * Symlink-aware containment. {@link safeResolve} compares strings, so a symlink
 * living *inside* the root but pointing outside it passes the lexical test and
 * would then be read. Re-check the fully resolved path before handing it back.
 *
 * If either side can't be resolved (path doesn't exist yet, EACCES) we fall
 * back to the lexical result: the subsequent read will fail on its own, and
 * failing closed here would break legitimate reads on transient FS races.
 */
export async function safeResolveReal(root: string, candidate: string): Promise<string | null> {
  const lexical = safeResolve(root, candidate);
  if (!lexical) return null;
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(lexical)]);
    return safeResolve(realRoot, realTarget) ? lexical : null;
  } catch {
    return lexical;
  }
}

/**
 * Roots the read-only API is allowed to serve from.
 *
 * Every route takes its `logDir`/`repoRoot` from the caller — they're operator
 * settings persisted in the browser's localStorage, not server config — so
 * without a boundary the API would happily read any path on the machine. Both
 * things this app legitimately reads (`~/.claude/projects` and the repo base
 * root) live under `$HOME`, so `$HOME` is the default boundary.
 *
 * `CLAUDE_CODE_LOG_ROOTS` (colon-separated, `~`/`$HOME` expanded) adds roots for
 * operators who keep repos on another volume.
 */
export function allowedRoots(): string[] {
  const extra = (process.env.CLAUDE_CODE_LOG_ROOTS ?? "")
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(expandHome);
  return [path.resolve(os.homedir()), ...extra];
}

/**
 * Expand and validate a caller-supplied root directory. Returns the resolved
 * absolute path, or null if it falls outside {@link allowedRoots} — callers
 * should answer 400 rather than reading it.
 */
export function resolveRoot(raw: string): string | null {
  if (!raw.trim()) return null;
  const resolved = expandHome(raw);
  for (const root of allowedRoots()) {
    if (safeResolve(root, resolved)) return resolved;
  }
  return null;
}

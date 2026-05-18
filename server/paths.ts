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
 * segment can itself contain a dash, so it is BEST-EFFORT and used only for
 * display of log projects that don't map to a crawled repo.
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
 * stays within `root`, otherwise null.
 */
export function safeResolve(root: string, candidate: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved === resolvedRoot) return resolved;
  if (resolved.startsWith(resolvedRoot + path.sep)) return resolved;
  return null;
}

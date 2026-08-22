import os from "node:os";
import path from "node:path";

import { decodeProjectDirApprox, encodeProjectDir } from "./paths.ts";

/**
 * Recovering a human-readable project name from a Claude Code log directory.
 *
 * Claude Code names each log directory after the absolute cwd it was launched
 * from, with every path separator replaced by `-`. Encoding is lossless;
 * DECODING IS NOT, because a path segment may itself contain a dash — so
 * `-Users-me-code-mapkit-demo` decodes just as plausibly to `.../mapkit/demo`
 * as to `.../mapkit-demo`.
 *
 * The only reliable way back is to encode paths we already know to be real —
 * the crawled repos, the configured repo root, the home directory — and match
 * those against the directory name. That is what this module does, and it is
 * the rule the rest of the app already follows (see README, "The directory-name
 * encoding").
 *
 * Nothing here ever splits a dash it cannot account for. When no known path
 * matches, the remainder is returned VERBATIM rather than guessed at: showing
 * `code-mapkit-demo` is imprecise, but showing `demo` is wrong, and wrong is
 * worse than long.
 */

export interface RepoKey {
  /** The repo's real absolute path, encoded — the join key. */
  key: string;
  /** The repo's real absolute path. */
  path: string;
  /** Display name from the crawl: `repo`, or `org/repo` for a grouped repo. */
  name: string;
}

/** Encode each crawled repo's real path once, for repeated matching. */
export function buildRepoKeys(repos: { name: string; path: string }[]): RepoKey[] {
  return repos.map((r) => ({ key: encodeProjectDir(r.path), path: r.path, name: r.name }));
}

/**
 * The prefix a *child* directory of `key` must start with.
 *
 * Normally `key + "-"`, which is also what stops `-Users-me-app` from matching
 * `-Users-me-appendix`. The filesystem root is the exception: it encodes to a
 * bare `"-"`, and its children are `-Users-...`, not `--Users-...`.
 */
function childPrefix(key: string): string {
  return key === "-" ? "-" : key + "-";
}

export interface RepoMatch {
  repo: RepoKey;
  /** Encoded path tail below the repo, or "" when the log dir IS the repo. */
  remainder: string;
}

/**
 * Attribute a log directory to the repo whose encoded path is its longest
 * prefix. Longest wins so that `~/Projects/org/repo` beats `~/Projects/org`
 * when both were crawled.
 */
export function matchRepo(dirName: string, keys: RepoKey[]): RepoMatch | null {
  let best: RepoKey | null = null;
  for (const r of keys) {
    if (dirName === r.key || dirName.startsWith(childPrefix(r.key))) {
      if (!best || r.key.length > best.key.length) best = r;
    }
  }
  if (!best) return null;
  const remainder = dirName === best.key ? "" : dirName.slice(childPrefix(best.key).length);
  return { repo: best, remainder };
}

/**
 * A path segment can be empty when the encoded name has a doubled or trailing
 * dash, which would otherwise surface as `Some-Project-` with a dangling
 * separator. Trim the ends; never touch the interior, since an interior dash
 * is exactly the thing we refuse to guess about.
 */
function trimSeparators(s: string): string {
  return s.replace(/^-+|-+$/g, "");
}

/**
 * Name a log dir relative to a known real root. Returns null when the dir isn't
 * under that root at all.
 *
 * `absRoot` must already be expanded and resolved — `path.resolve("~")` does
 * NOT expand a tilde, it treats it as a relative segment, so a raw setting
 * value would encode to nonsense. Callers pass the output of `resolveRoot`.
 *
 * `rootLabel` names the case where the log dir IS the root, so the home
 * directory can render as `~` — matching normalizeProject (server/journey.ts)
 * so the Journey tab and the metrics-backed tabs agree on one project.
 */
function nameUnderRoot(dirName: string, absRoot: string, rootLabel?: string): string | null {
  const key = encodeProjectDir(absRoot);
  if (dirName === key) return rootLabel ?? path.basename(absRoot) ?? absRoot;
  const prefix = childPrefix(key);
  if (!dirName.startsWith(prefix)) return null;
  return trimSeparators(dirName.slice(prefix.length)) || null;
}

/**
 * Best available display name for a log directory.
 *
 * Ladder, most precise first:
 *   1. exact match on a crawled repo        -> that repo's name (`repo`, `org/repo`)
 *   2. a directory inside a crawled repo    -> `repo/<tail>`; the repo half is exact
 *   3. somewhere under the configured root  -> the tail, verbatim
 *   4. somewhere under $HOME                -> the tail, verbatim
 *   5. nothing known matches                -> the raw directory name
 *
 * Rungs 3-5 can be more verbose than a human would write, but they are never
 * *wrong*: no dash is ever split on a guess. `repoRoot` is optional because
 * `/api/metrics` and `/api/search` accept it optionally, so an older client
 * still gets rungs 4-5 rather than an error.
 */
export function resolveProjectName(dirName: string, keys: RepoKey[], repoRoot?: string): string {
  const match = matchRepo(dirName, keys);
  if (match) {
    const tail = trimSeparators(match.remainder);
    return tail ? `${match.repo.name}/${tail}` : match.repo.name;
  }

  if (repoRoot) {
    const underRepoRoot = nameUnderRoot(dirName, repoRoot);
    if (underRepoRoot) return underRepoRoot;
  }

  const underHome = nameUnderRoot(dirName, os.homedir(), "~");
  if (underHome) return underHome;

  // Nothing known matches — the project has moved, been deleted, or belongs to
  // another machine. Show the directory name as-is, minus the leading separator
  // that stands in for the filesystem root: this is a label, not a path.
  return trimSeparators(dirName) || dirName;
}

/**
 * Best available real path for a log directory, for surfaces that show a path
 * rather than a name (search results, words entries).
 *
 * When the directory belongs to a crawled repo the repo portion is exact. The
 * tail below it is appended un-split, for the same reason as above. With no
 * match there is nothing to anchor on, so this falls back to the documented
 * best-effort decode — which is the honest answer for a log directory whose
 * project no longer exists on disk.
 */
export function resolveProjectPath(dirName: string, keys: RepoKey[]): string {
  const match = matchRepo(dirName, keys);
  if (!match) return decodeProjectDirApprox(dirName);
  const tail = trimSeparators(match.remainder);
  return tail ? `${match.repo.path}${path.sep}${tail}` : match.repo.path;
}

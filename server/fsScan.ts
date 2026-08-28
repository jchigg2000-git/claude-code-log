import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { countLines } from "./jsonl.ts";
import { encodeProjectDir, decodeProjectDirApprox, safeResolveReal } from "./paths.ts";
import { buildRepoKeys, matchRepo, type RepoKey } from "./projectNames.ts";

export interface SessionMeta {
  id: string;
  file: string;
  mtime: string;
  sizeBytes: number;
  messageCount: number;
}

export interface LogProject {
  dirName: string;
  approxPath: string;
  sessions: SessionMeta[];
  messageCount: number;
  lastActivity: string | null;
}

export interface RepoSummary {
  name: string;
  path: string;
  hasGit: boolean;
  sessionCount: number;
  messageCount: number;
  lastActivity: string | null;
}

export interface SpecDoc {
  name: string;
  kind: "markdown" | "json" | "text";
  content: string;
}

export interface RepoDetail extends RepoSummary {
  specs: SpecDoc[];
  stack: string[];
  sessions: SessionMeta[];
}

const SIZE_CAP = 50 * 1024 * 1024; // skip line-counting absurdly large logs
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "dist", "build"]);

/**
 * Per-file message-count memo. Counting lines is the only reason
 * scanLogProjects reads transcript bytes at all, and /api/overview reruns the
 * scan on every landing-page visit — on a multi-GB corpus that is seconds of
 * re-reading unchanged files. Transcripts are append-only (the invariant
 * transcriptCache.ts documents), so `mtimeMs` + `size` are a sound staleness
 * key: a rescan reads only files that are new or have grown, and the rest of
 * the scan is readdir + stat. Entries are ~a hundred bytes, so even a
 * 100k-file corpus holds a few MB — no eviction needed.
 */
const lineCountCache = new Map<string, { mtimeMs: number; size: number; count: number }>();

/** Drop every cached line count. Exposed for tests. */
export function clearLineCountCache(): void {
  lineCountCache.clear();
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read Claude Code project directories and their `.jsonl` transcripts.
 * `dirFilter` is applied to the directory name before any transcript is read,
 * so callers that want one project pay for one project, not the corpus.
 */
export async function scanLogProjects(
  logDir: string,
  dirFilter?: (dirName: string) => boolean,
): Promise<LogProject[]> {
  const dirNames = await listDirs(logDir);
  const projects: LogProject[] = [];

  for (const dirName of dirNames) {
    if (dirFilter && !dirFilter(dirName)) continue;
    const projDir = path.join(logDir, dirName);
    let files: string[];
    try {
      files = (await readdir(projDir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    const sessions: SessionMeta[] = [];
    let messageCount = 0;
    let lastActivity: string | null = null;

    for (const f of files) {
      const full = path.join(projDir, f);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      let count = -1;
      if (st.size <= SIZE_CAP) {
        const cached = lineCountCache.get(full);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          count = cached.count;
        } else {
          try {
            count = countLines(await readFile(full, "utf8"));
            lineCountCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, count });
          } catch {
            count = -1;
          }
        }
      }
      const mtime = st.mtime.toISOString();
      sessions.push({ id: f.replace(/\.jsonl$/, ""), file: full, mtime, sizeBytes: st.size, messageCount: count });
      if (count > 0) messageCount += count;
      if (!lastActivity || mtime > lastActivity) lastActivity = mtime;
    }

    sessions.sort((a, b) => b.mtime.localeCompare(a.mtime));
    projects.push({ dirName, approxPath: decodeProjectDirApprox(dirName), sessions, messageCount, lastActivity });
  }
  return projects;
}

/** Crawl the base root for repositories (depth 1 always listed; git repos to depth 2). */
export async function crawlRepos(repoRoot: string): Promise<{ name: string; path: string; hasGit: boolean }[]> {
  const found = new Map<string, { name: string; path: string; hasGit: boolean }>();

  const level1 = await listDirs(repoRoot);
  for (const name of level1) {
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const full = path.join(repoRoot, name);
    const hasGit = await exists(path.join(full, ".git"));
    found.set(full, { name, path: full, hasGit });

    if (!hasGit) {
      // One level deeper: pick up grouped repos like ~/Projects/org/repo.
      for (const sub of await listDirs(full)) {
        if (sub.startsWith(".") || SKIP_DIRS.has(sub)) continue;
        const subFull = path.join(full, sub);
        if (await exists(path.join(subFull, ".git"))) {
          found.set(subFull, { name: `${name}/${sub}`, path: subFull, hasGit: true });
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Crawl `repoRoot` and encode each repo path, ready for matching against log
 * directory names. Returns [] when no root is configured, which makes every
 * consumer's naming ladder degrade instead of failing.
 *
 * Lives here rather than in projectNames.ts so that module stays dependency-free
 * and there is no fsScan <-> projectNames import cycle.
 */
export async function repoKeysFor(repoRoot?: string): Promise<RepoKey[]> {
  if (!repoRoot) return [];
  return buildRepoKeys(await crawlRepos(repoRoot));
}

export interface Overview {
  repos: RepoSummary[];
  orphanLogs: { approxPath: string; dirName: string; sessionCount: number; messageCount: number; lastActivity: string | null }[];
}

export async function buildOverview(logDir: string, repoRoot: string): Promise<Overview> {
  const [logs, repos] = await Promise.all([scanLogProjects(logDir), crawlRepos(repoRoot)]);
  const repoKeys = buildRepoKeys(repos);

  const byRepo = new Map<string, LogProject[]>();
  const orphans: LogProject[] = [];
  for (const lp of logs) {
    const repoPath = matchRepo(lp.dirName, repoKeys)?.repo.path ?? null;
    if (repoPath) {
      const arr = byRepo.get(repoPath) ?? [];
      arr.push(lp);
      byRepo.set(repoPath, arr);
    } else {
      orphans.push(lp);
    }
  }

  const summaries: RepoSummary[] = repos.map((r) => {
    const lps = byRepo.get(r.path) ?? [];
    let sessionCount = 0;
    let messageCount = 0;
    let lastActivity: string | null = null;
    for (const lp of lps) {
      sessionCount += lp.sessions.length;
      messageCount += Math.max(0, lp.messageCount);
      if (lp.lastActivity && (!lastActivity || lp.lastActivity > lastActivity)) lastActivity = lp.lastActivity;
    }
    return { name: r.name, path: r.path, hasGit: r.hasGit, sessionCount, messageCount, lastActivity };
  });

  summaries.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "") || a.name.localeCompare(b.name));

  return {
    repos: summaries,
    orphanLogs: orphans
      .filter((o) => o.sessions.length > 0)
      .map((o) => ({
        approxPath: o.approxPath,
        dirName: o.dirName,
        sessionCount: o.sessions.length,
        messageCount: Math.max(0, o.messageCount),
        lastActivity: o.lastActivity,
      }))
      .sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "")),
  };
}

/**
 * Read one spec doc, refusing to follow a symlink out of `base`. /api/repo
 * validates the repo *directory*, but a checked-out repo can itself contain a
 * symlink named README.md pointing at ~/.ssh keys or /etc/passwd — a bare
 * readFile would render those bytes as a spec and serve them over the API.
 * Containment mirrors the API's file rule: the real target must stay inside
 * the directory the caller was allowed to read. The cost is deliberate: a
 * legitimately symlinked spec (dotfiles-style CLAUDE.md) is skipped too.
 */
async function readSpec(
  base: string,
  file: string,
  name: string,
  kind: SpecDoc["kind"],
): Promise<SpecDoc | null> {
  try {
    const contained = await safeResolveReal(base, file);
    if (!contained) return null;
    const content = await readFile(contained, "utf8");
    return { name, kind, content };
  } catch {
    return null;
  }
}

async function detectStack(repoPath: string): Promise<{ stack: string[]; pkgSpec: SpecDoc | null }> {
  const stack: string[] = [];
  let pkgSpec: SpecDoc | null = null;

  const pkgPath = path.join(repoPath, "package.json");
  if (await exists(pkgPath)) {
    stack.push("Node / JavaScript");
    pkgSpec = await readSpec(repoPath, pkgPath, "package.json", "json");
    try {
      const pkg = JSON.parse((pkgSpec?.content ?? "{}") || "{}");
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const [dep, label] of [
        ["typescript", "TypeScript"],
        ["vite", "Vite"],
        ["react", "React"],
        ["vue", "Vue"],
        ["svelte", "Svelte"],
        ["next", "Next.js"],
        ["express", "Express"],
      ] as const) {
        if (dep in deps) stack.push(label);
      }
    } catch {
      /* ignore malformed package.json */
    }
  }
  for (const [marker, label] of [
    ["pyproject.toml", "Python"],
    ["requirements.txt", "Python"],
    ["go.mod", "Go"],
    ["Cargo.toml", "Rust"],
    ["Gemfile", "Ruby"],
    ["pom.xml", "Java"],
  ] as const) {
    if (await exists(path.join(repoPath, marker)) && !stack.includes(label)) stack.push(label);
  }
  return { stack, pkgSpec };
}

export async function buildRepoDetail(
  repoPath: string,
  repoName: string,
  logDir: string,
): Promise<RepoDetail> {
  const hasGit = await exists(path.join(repoPath, ".git"));
  const specs: SpecDoc[] = [];

  const claudeMd = await readSpec(repoPath, path.join(repoPath, "CLAUDE.md"), "CLAUDE.md", "markdown");
  if (claudeMd) specs.push(claudeMd);

  for (const readme of ["README.md", "README", "README.txt", "readme.md"]) {
    const doc = await readSpec(repoPath, path.join(repoPath, readme), readme, readme.toLowerCase().endsWith(".md") || readme === "README" ? "markdown" : "text");
    if (doc) {
      specs.push(doc);
      break;
    }
  }

  const { stack, pkgSpec } = await detectStack(repoPath);
  if (pkgSpec) specs.push(pkgSpec);

  const pyproject = await readSpec(repoPath, path.join(repoPath, "pyproject.toml"), "pyproject.toml", "text");
  if (pyproject) specs.push(pyproject);

  // Claude Code memory index for this repo, if present.
  const memPath = path.join(logDir, encodeProjectDir(repoPath), "memory", "MEMORY.md");
  const mem = await readSpec(logDir, memPath, "memory/MEMORY.md", "markdown");
  if (mem) specs.push(mem);

  // Sessions attributed to this repo. The dir-name match runs as a scan
  // filter, so only this repo's project dirs are ever read.
  const key = encodeProjectDir(repoPath);
  const logs = await scanLogProjects(logDir, (d) => d === key || d.startsWith(key + "-"));
  const sessions: SessionMeta[] = [];
  let messageCount = 0;
  let lastActivity: string | null = null;
  for (const lp of logs) {
    sessions.push(...lp.sessions);
    messageCount += Math.max(0, lp.messageCount);
    if (lp.lastActivity && (!lastActivity || lp.lastActivity > lastActivity)) lastActivity = lp.lastActivity;
  }
  sessions.sort((a, b) => b.mtime.localeCompare(a.mtime));

  return {
    name: repoName,
    path: repoPath,
    hasGit,
    sessionCount: sessions.length,
    messageCount,
    lastActivity,
    specs,
    stack,
    sessions,
  };
}

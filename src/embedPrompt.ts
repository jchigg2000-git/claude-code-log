import type { AppConfig } from "./types.ts";

/**
 * The prompt a user copies and pastes into Claude Code *inside another
 * project*. It recreates this dashboard there but explicitly conforms to the
 * host project's existing stack and styling instead of this app's vanilla/Vite
 * setup.
 */
export function buildEmbedPrompt(cfg: AppConfig): string {
  return `Add a "Claude Code Log" dashboard to THIS project that visualizes my Claude Code history across my local repos.

CRITICAL — conform to this host project, do not impose a new stack:
- First detect this project's stack, framework, routing, build tool, and styling conventions (component library, CSS approach, design tokens). Read package.json / config files and a few existing components before writing anything.
- Implement the dashboard using THIS project's existing framework, router, component patterns, and CSS/styling system. Do NOT introduce vanilla JS, a new bundler, a new CSS framework, or a parallel design system. Match the host's conventions exactly.
- Reuse existing UI primitives (buttons, modals, cards, layout) where they exist.

Functionality to implement (same as the standalone app):
1. A read-only local filesystem access layer appropriate to this project (an existing API/server route, a dev middleware, or the host's backend pattern) — the browser cannot read the filesystem directly. Never write to disk.
2. Data sources, user-configurable, seeded with these defaults:
   - Claude Code log location: "${cfg.logDir}" (expand ~ / $HOME). Contains one directory per project; the directory name is the project's absolute path with every "/" replaced by "-". Each dir holds *.jsonl session transcripts (one JSON object per line) and may contain a memory/ subdir. To join logs to repos, ENCODE each repo's real path ("/" -> "-") and match it against directory names (decoding dir names is lossy).
   - Base repo root: "${cfg.repoRoot}". Crawl it for git repositories and read each repo's specs: CLAUDE.md, README*, package.json, pyproject.toml, and the repo's memory/MEMORY.md from the log dir if present.
3. Pages: an Overview listing every repo under the base root with Claude activity summary (session count, message count, last activity; repos with no logs still shown); a Repo Detail drill-in rendering the project specs (Markdown rendered) plus a session list whose entries open a parsed transcript timeline; a gear icon in the top bar opening a Settings panel with the two editable path fields (persisted) and this same copy-prompt button.
4. Handle missing/permission-denied paths and malformed JSONL lines gracefully (skip and continue). Filesystem access is strictly read-only.

Before coding, output a short plan: where files go in this project's structure, which existing UI primitives/styles you will reuse, and the data model — then implement it.`;
}

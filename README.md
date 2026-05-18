# Claude Code Log

A local dashboard for browsing your Claude Code history across every repo on your machine.

It scans your Claude Code session logs, crawls your repositories, joins the two, and lets you drill into any repo to read its project specs (CLAUDE.md, README, manifests, memory index) alongside the parsed transcripts of every Claude Code session run there.

## Stack

- **Vite + TypeScript**, vanilla DOM — no UI framework.
- A thin **read-only filesystem API** is served by the Vite dev/preview server itself (connect middleware in `vite.config.ts`), so the whole app is **one process**. The browser cannot read the filesystem directly; all access goes through `/api/*`.

## Run

```bash
npm install
npm run dev
```

Opens automatically in your browser (Vite's default `http://localhost:5173`, or the next free port).

## Configuration

Click the **⚙ gear** in the top bar. Two paths, persisted to `localStorage`, seeded with defaults:

- **Claude Code log location** — default `~/.claude/projects`
- **Base repo root** — default `~/Projects`

`~` and `$HOME` are expanded server-side. "Save & rescan" reloads the view against the new paths.

### The directory-name encoding

Claude Code stores one directory per project under the log location. The directory name is the project's **absolute path with every `/` replaced by `-`** — e.g. `/Users/me/Projects/app` → `-Users-me-Projects-app`. Each directory holds `*.jsonl` session transcripts (one JSON object per line) and may contain a `memory/` subdirectory.

Decoding a directory name back to a path is **ambiguous** (a path segment can itself contain `-`). So repos are joined to logs by *encoding* each crawled repo's real path and matching it against directory names — lossless in that direction. Log projects that match no crawled repo are listed separately under "Other Claude Code activity".

## Copy embed prompt

The Settings panel has a **Copy embed prompt** button. It copies a prompt you can paste into Claude Code **inside any other project**: it recreates this dashboard there, but instructs the agent to detect and conform to *that project's* existing framework, routing, and styling instead of this app's vanilla/Vite stack.

## Notes & constraints

- Filesystem access is strictly **read-only**; nothing is written to `~/.claude` or any crawled repo.
- Missing/permission-denied paths and malformed JSONL lines are skipped gracefully.
- The repo crawl lists every directory directly under the base root, plus git repos nested one level deeper (e.g. `~/Projects/org/repo`).
- Markdown in spec files is rendered as HTML; this is a local tool reading your own trusted files.

## Build

```bash
npm run build && npm run preview
```

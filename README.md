# Claude Code Log

A local dashboard for browsing **and analyzing** your Claude Code history across every repo on your machine.

It scans your Claude Code session logs, crawls your repositories, and joins the two. From there you can drill into any repo to read its project specs (CLAUDE.md, README, manifests, memory index) alongside the parsed transcripts of every session run there — or step back and see the whole corpus at once: spend, token flow, the subagent fleet, and a scroll-driven retelling of the entire journey.

## Stack

- **Vite + TypeScript**, vanilla DOM — no UI framework. `marked` renders markdown; everything else is hand-rolled (the charts and the journey particle field are plain SVG/Canvas, no charting library).
- A thin **read-only filesystem API** lives under `server/` (`api.ts` dispatches the routes; `fsScan`, `journey`, `jsonl`, `metrics`, and `paths` do the work) and is wired into the Vite **dev and preview** servers as connect middleware (`vite.config.ts`), so the whole app stays **one process**. The browser never touches the filesystem directly; all access goes through `/api/*`.

## Run

```bash
npm install
npm run dev
```

Opens automatically at **`http://localhost:5189`**. The port is pinned via `strictPort`, so a collision fails loudly rather than silently drifting onto another port.

## Search

The top bar has a live, debounced **search box** that full-text-searches every transcript across every project (`#/search`, backed by `GET /api/search`). Results are newest-first, capped at 100 rows, with a match count and a highlighted snippet per session; clicking a result opens a standalone transcript view (`#/session`) with the query still highlighted. Queries under 2 characters are ignored.

## Views

Four tabs across the top, plus a per-repo drill-down:

- **Repos** (home) — the front page: every crawled repo as a card (git badge, session/message counts, last activity), sorted by recency. A hero strip summarizes the whole corpus (sessions, prompts, est. spend, cache-read tokens, active days) and links into Data Viz. Log projects that match no crawled repo are collected under **"Other Claude Code activity"**.
- **Data Viz** ("By the Numbers") — the analytics page, computed live from every transcript. It leads with the **agent fleet**: hours on the clock, agents dispatched, time delegated to subagents, a segmented fleet bar, ranked "who gets called" vs. "who does the work" breakdowns by agent type, dispatch cadence, and the longest single main-thread missions. Then pace by day, spend by day, the prompt-cache "iceberg" (log scale), where spend concentrated by project, and a tool-call fingerprint. Cost is estimated at public list prices; agent counts and durations are measured from message timestamps (human idle excluded).
- **Journey** — a scroll-driven ("scrollytelling") retelling of the whole history: a canvas particle field behind pinned scenes that animate day-one → build-up → scale → spread → the subagent-fleet climax, with animated counters and a chapter rail. Below the scenes sits an interactive **map** — a force-directed project graph (node size = lines typed there, warmth = recency; solid edges = explicit switches, faint dashed = inferred "leaps of faith") and a woven timeline of every project visit, all click-to-inspect. (Needs `~/.claude/history.jsonl` next to the log dir.)
- **Profile** ("The User, Observed") — a written, long-form read of the operator behind the transcripts, with a fixed snapshot stat strip. This one is narrative and interpretation dated to its snapshot, not a live computation.
- **Repo detail** (click any repo card) — the original browse view: project specs (CLAUDE.md, README, package/pyproject manifests, and the repo's Claude Code `memory/MEMORY.md` index) rendered alongside every session transcript for that repo, each expandable into its parsed user/assistant/tool timeline. The detected stack shows as chips.

## Live refresh

A long-lived tab re-scans the logs on a quiet **5-minute interval** (`src/main.ts`): it drops the cached metrics/journey scans and re-renders the current view in place, scroll preserved — no manual reload. This is plain polling, not a push/filesystem-watch.

## API surface

Every route is read-only, JSON, and served under `/api/` by `server/api.ts`:

- `GET /api/health` — liveness probe
- `GET /api/overview?logDir&repoRoot` — repo cards + orphan log projects
- `GET /api/repo?logDir&repoRoot&path&name` — one repo's specs + session list
- `GET /api/session?logDir&file` — a single parsed transcript
- `GET /api/metrics?logDir` — the whole-corpus rollup (Data Viz)
- `GET /api/journey?logDir&days` — the project graph + visit timeline (Journey)
- `GET /api/search?logDir&q` — full-text search across every transcript, newest-first, capped at 100 results

## Configuration

Click the **⚙ gear** in the top bar. Two paths, persisted to `localStorage`, seeded with defaults:

- **Claude Code log location** — default `~/.claude/projects`
- **Base repo root** — default `~/Projects`

`~` and `$HOME` are expanded server-side. "Save & rescan" drops the caches and reloads the view against the new paths.

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

`preview` serves the built app plus the same read-only `/api/*` middleware.

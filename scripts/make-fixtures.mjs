#!/usr/bin/env node
// Generates a synthetic, fully-anonymous demo corpus under <repo>/fixtures/
// so the dashboard can be shown to anyone without exposing the author's real
// Claude Code transcripts. Plain ESM, zero npm dependencies, deterministic.
//
// Run: node scripts/make-fixtures.mjs
//
// Layout produced (see README's "directory-name encoding" section, and
// server/paths.ts::encodeProjectDir, for why the projects/ dir names look
// the way they do):
//   fixtures/repos/<name>/            - 6 invented sample repos
//   fixtures/projects/<encodedDir>/*.jsonl - Claude Code session transcripts
//   fixtures/history.jsonl            - ~/.claude/history.jsonl equivalent

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — fixed seed so re-runs are byte-identical
// modulo the "now"-relative timestamps, which shift day to day by design.
// ---------------------------------------------------------------------------
const SEED = 0x5eed_c0de;
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const choice = (arr) => arr[randInt(0, arr.length - 1)];
function weighted(pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) {
    if (r < w) return v;
    r -= w;
  }
  return pairs[pairs.length - 1][0];
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function hex(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}
/** UUID-shaped id derived from the seeded PRNG (not crypto.randomUUID). */
function uuid() {
  const h = hex(30);
  const variant = choice(["8", "9", "a", "b"]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(12, 15)}-${variant}${h.slice(15, 18)}-${h.slice(18, 30)}`;
}
function toolUseId() {
  return `toolu_01${hex(22)}`;
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------
// Path plumbing — mirrors server/paths.ts::encodeProjectDir exactly. Resolved
// from THIS script's own location so it works regardless of cwd or where the
// repo is cloned.
// ---------------------------------------------------------------------------
function encodeProjectDir(absPath) {
  return path.resolve(absPath).split(path.sep).join("-");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
// Normally generated inside the repo (gitignored). CCL_FIXTURES_DIR relocates
// the whole corpus, which is how `npm run demo:shots` builds it under a neutral
// root — the app renders each repo's ABSOLUTE path, so committed screenshots
// would otherwise show the home directory of whoever captured them.
const FIXTURES_DIR = process.env.CCL_FIXTURES_DIR
  ? path.resolve(process.env.CCL_FIXTURES_DIR)
  : path.join(REPO_ROOT, "fixtures");
// CCL_FIXTURES_REPOS relocates just the repo half of the corpus, so a capture
// run can generate repos somewhere neutral and keep the operator's home
// directory out of committed screenshots. It takes an absolute path rather than
// a leaf name because macOS is case-insensitive, so a sibling named "Projects"
// would collide with the "projects" log dir.
/** Written into a relocated repos dir so a later run can tell it is safe to clear. */
const MARKER = ".ccl-generated-fixtures";
const REPOS_DIR = process.env.CCL_FIXTURES_REPOS
  ? path.resolve(process.env.CCL_FIXTURES_REPOS)
  : path.join(FIXTURES_DIR, "repos");
const PROJECTS_DIR = path.join(FIXTURES_DIR, "projects");
const HISTORY_FILE = path.join(FIXTURES_DIR, "history.jsonl");

// ---------------------------------------------------------------------------
// Repo definitions — boring, obviously-fake invented projects. Every word is
// invented; nothing here should resemble a real company/product/person.
// ---------------------------------------------------------------------------
const REPOS = [
  {
    key: "orchard-api",
    name: "orchard-api",
    hasGit: true,
    hasClaudeMd: true,
    files: [
      "src/routes/orders.ts",
      "src/routes/suppliers.ts",
      "src/lib/supplier-webhook.ts",
      "src/lib/crate-weight.ts",
      "src/db/crates.ts",
      "src/db/deliveries.ts",
      "test/orders.test.ts",
      "test/webhook.test.ts",
    ],
    srcDir: "src",
    globPattern: "src/**/*.ts",
    commands: [
      "npm test",
      "npm run build",
      "npx vitest run src/routes/orders.test.ts",
      "npx tsc --noEmit",
      "git diff",
      "git log --oneline -10",
    ],
    manifest: {
      file: "package.json",
      content: {
        name: "orchard-api",
        version: "0.4.1",
        private: true,
        type: "module",
        scripts: { dev: "vite", build: "vite build", test: "vitest run" },
        dependencies: { express: "^4.19.2" },
        devDependencies: { typescript: "^5.5.4", vite: "^5.4.2", vitest: "^2.0.5" },
      },
    },
    topics: [
      "the pagination cursor is off by one on the /orders endpoint",
      "the harvest batch importer double-counts crates when a supplier retries",
      "add exponential backoff to the supplier webhook client",
      "the crate weight validation accepts negative numbers",
      "why does the nightly inventory reconciliation job time out on Tuesdays",
      "the delivery ETA calc ignores the driver's lunch window",
      "flaky test: order-total rounding drifts by a cent under load",
      "the /suppliers endpoint leaks a stack trace on malformed JSON",
      "add an idempotency key to the crate intake endpoint",
      "the webhook signature check is comparing before trimming whitespace",
      "orders stuck in 'pending' never get retried after a 502 from the supplier",
      "the seasonal pricing override isn't applied on the first day of the month",
      "add a dead-letter queue for failed delivery notifications",
      "the crate SKU normalizer breaks on supplier codes with lowercase letters",
    ],
    readme: [
      "# Orchard API",
      "",
      "Backend service for small-orchard inventory and order management — crate",
      "intake, supplier webhooks, delivery scheduling, and the nightly",
      "reconciliation job that keeps the warehouse counts honest. It's the thing",
      "three packing sheds and a produce co-op depend on without knowing it exists.",
      "",
      "The service is deliberately boring: a small Express API in front of a",
      "handful of tables (crates, suppliers, deliveries, orders), a webhook",
      "receiver for supplier stock updates, and a nightly job that reconciles",
      "on-hand counts against what the sheds report by hand. Most incidents so",
      "far have come from the webhook path — suppliers retry aggressively on",
      "timeout, and the intake logic wasn't idempotent for the first few months.",
      "",
      "Local dev spins up against a seeded SQLite file; there's no shared",
      "staging environment yet, so `npm run dev` plus the fixtures in",
      "`test/fixtures/` is the whole loop. Deploys are manual for now — someone",
      "runs `npm run build` and copies the output, which is exactly as fragile",
      "as it sounds and is tracked as a known gap.",
    ].join("\n"),
    claudeMd: [
      "# Working agreement — orchard-api",
      "",
      "- Webhook handlers must be idempotent. Suppliers retry on any non-2xx,",
      "  including timeouts, so a handler that isn't safe to run twice will",
      "  eventually double-count something.",
      "- Money and weight fields are integers (cents, grams) at the boundary.",
      "  Never let a float touch the crate-weight or order-total path.",
      "- The nightly reconciliation job is the source of truth for on-hand",
      "  counts. If a fix disagrees with it, the job is probably right and the",
      "  fix is wrong.",
      "- New routes get a test with at least one malformed-payload case before",
      "  they're considered done — the supplier webhook has taught us this the",
      "  hard way twice.",
      "- Don't add a queue/broker for a problem a dead-letter table can solve.",
      "  Keep the infra footprint small until there's a second consumer.",
    ].join("\n"),
  },
  {
    key: "tidepool-ui",
    name: "tidepool-ui",
    hasGit: true,
    hasClaudeMd: false,
    files: [
      "src/components/TideChart.tsx",
      "src/components/BuoyMap.tsx",
      "src/components/ReadingsTable.tsx",
      "src/hooks/useBuoyFeed.ts",
      "src/lib/format.ts",
      "src/pages/Dashboard.tsx",
    ],
    srcDir: "src",
    globPattern: "src/**/*.tsx",
    commands: ["npm run dev", "npm run build", "npx vitest run", "npx eslint src", "git status", "git diff"],
    manifest: {
      file: "package.json",
      content: {
        name: "tidepool-ui",
        version: "0.9.0",
        private: true,
        type: "module",
        scripts: { dev: "vite", build: "vite build" },
        dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
        devDependencies: { vite: "^5.4.2" },
      },
    },
    topics: [
      "the tide chart resizes wrong on mobile and clips the y-axis labels",
      "buoy marker cluster flickers on zoom",
      "dark mode contrast is bad on the readings table",
      "the live feed reconnect loop spams the websocket on flaky wifi",
      "water temp readings show as NaN when a sensor drops offline mid-poll",
      "the tide chart tooltip lags behind the cursor by a frame or two",
      "buoy selection state doesn't survive a page refresh",
      "the readings table sort arrow points the wrong way after a re-sort",
      "add a loading skeleton for the dashboard instead of a blank flash",
      "the low-tide marker on the chart is off by about twenty minutes",
      "map pins for offline buoys should be greyed out, not just missing",
    ],
    readme: [
      "# Tidepool UI",
      "",
      "A small dashboard for a handful of coastal sensor buoys — tide height,",
      "water temperature, and a live map of which buoys are currently",
      "reporting. Built for a weekend project that turned into something a few",
      "people actually check every morning.",
      "",
      "The frontend polls a public sensor feed on an interval, renders a tide",
      "chart, a readings table, and a map with buoy markers colored by",
      "recency. There's no backend of its own — it talks straight to the",
      "upstream feed from the browser, which is simple but means a feed outage",
      "shows up as a blank dashboard rather than a graceful message.",
      "",
      "Known rough edges: mobile layout needs another pass, the websocket",
      "reconnect logic is naive, and dark mode was added late so a few",
      "components still assume a light background.",
    ].join("\n"),
    claudeMd: null,
  },
  {
    key: "slate-notes",
    name: "slate-notes",
    hasGit: true,
    hasClaudeMd: true,
    files: [
      "slate/importer.py",
      "slate/tags.py",
      "slate/search.py",
      "slate/models.py",
      "slate/api.py",
      "tests/test_importer.py",
      "tests/test_tags.py",
    ],
    srcDir: "slate",
    globPattern: "slate/**/*.py",
    commands: [
      "pytest -k importer",
      "python -m pytest tests/",
      "ruff check .",
      "python -m slate.cli reindex",
      "git diff",
      "git log --oneline -10",
    ],
    manifest: {
      file: "pyproject.toml",
      content: [
        "[project]",
        'name = "slate-notes"',
        'version = "0.3.2"',
        'description = "A small personal note-taking service with a tag graph and full-text search."',
        'requires-python = ">=3.11"',
        "",
        "[tool.pytest.ini_options]",
        'testpaths = ["tests"]',
        "",
      ].join("\n"),
    },
    topics: [
      "why is the note importer skipping frontmatter on notes with a BOM",
      "tag autocomplete is O(n^2) on a vault with a few thousand notes",
      "sync conflict resolution merges duplicate notes instead of flagging them",
      "the full-text search index doesn't pick up edits until a manual reindex",
      "backlinks panel shows a note linking to itself after a rename",
      "the markdown importer chokes on nested code fences",
      "tag merge doesn't update notes that reference the old tag in frontmatter",
      "search ranking puts title matches below body matches",
      "the daily-note template doesn't respect the user's timezone",
      "importer silently drops notes over a certain file size instead of erroring",
    ],
    readme: [
      "# Slate Notes",
      "",
      "A personal note-taking service: plain markdown files on disk, a tag",
      "graph on top, and a full-text search index that's supposed to stay in",
      "sync with whatever's on disk. It started as a weekend importer script",
      "and grew a small API and a search index because grepping a few thousand",
      "notes stopped being fun.",
      "",
      "The importer watches a notes directory, parses frontmatter and tags out",
      "of each file, and rebuilds a lightweight backlink graph. Search is a",
      "simple inverted index rebuilt on a schedule rather than truly live,",
      "which has caused more than one \"why isn't this showing up\" report.",
      "",
      "Nothing here talks to a real device sync service — import/export is",
      "manual, on purpose, until the conflict-resolution story is trustworthy",
      "enough to automate.",
    ].join("\n"),
    claudeMd: [
      "# Working agreement — slate-notes",
      "",
      "- The importer must be safe to re-run on the same directory at any",
      "  time. Idempotent imports are the whole reason this survived past a",
      "  weekend script.",
      "- Search index rebuilds are cheap; prefer a full reindex over a clever",
      "  incremental patch until reindex time actually becomes a problem.",
      "- Tag renames/merges touch every note that references the tag. Never",
      "  leave a note pointing at a tag id that no longer exists.",
      "- Frontmatter parsing has to tolerate a stray BOM, CRLF line endings,",
      "  and empty frontmatter blocks — real export tools produce all three.",
    ].join("\n"),
  },
  {
    key: "ferry-scheduler",
    name: "ferry-scheduler",
    hasGit: true,
    hasClaudeMd: false,
    files: [
      "cmd/scheduler/main.go",
      "internal/timetable/import.go",
      "internal/timetable/capacity.go",
      "internal/timetable/holiday.go",
      "internal/api/routes.go",
      "internal/api/handlers.go",
    ],
    srcDir: "internal",
    globPattern: "**/*.go",
    commands: ["go test ./...", "go vet ./...", "go build ./...", "gofmt -l .", "git diff", "git log --oneline -10"],
    manifest: {
      file: "go.mod",
      content: ["module example.com/ferry-scheduler", "", "go 1.22", ""].join("\n"),
    },
    topics: [
      "why is the ferry timetable importer skipping Sundays",
      "the crossing capacity calc ignores the holiday schedule",
      "timezone offset bug on the winter schedule — crossings show an hour early",
      "the importer chokes on a route with a mid-week schedule change",
      "duplicate crossings appear when two timetable PDFs overlap by a day",
      "capacity check doesn't account for a vehicle-only crossing",
      "the holiday calendar hardcodes last year's dates",
      "daylight saving transition breaks the crossing duration calc",
      "the importer trusts the PDF's page order instead of the printed date",
      "walk-on passenger counts aren't reset between crossings",
    ],
    readme: [
      "# Ferry Scheduler",
      "",
      "A small Go service that imports published ferry timetables and serves a",
      "normalized schedule with crossing capacity. The timetables arrive as",
      "PDFs from a handful of operators on no consistent format, which is most",
      "of why this exists — nobody wants to read a timetable PDF twice a week.",
      "",
      "The importer parses each operator's PDF into a common crossing record,",
      "reconciles it against the holiday calendar (crossings run on a reduced",
      "schedule on public holidays), and computes remaining capacity per",
      "crossing from vehicle and walk-on counts. The API is a thin read layer",
      "over the resulting schedule.",
      "",
      "This has been a steady source of small, annoying bugs — timezone",
      "handling around daylight saving, PDFs that don't sort by date the way",
      "you'd expect, and a holiday calendar that needs a manual update once a",
      "year and is inevitably forgotten.",
    ].join("\n"),
    claudeMd: null,
  },
  {
    key: "lint-bot",
    name: "lint-bot",
    hasGit: true,
    hasClaudeMd: true,
    files: [
      "src/lint.rs",
      "src/rules/unused_imports.rs",
      "src/rules/multiline_strings.rs",
      "src/ci/comment.rs",
      "src/main.rs",
      "tests/rules_test.rs",
    ],
    srcDir: "src",
    globPattern: "src/**/*.rs",
    commands: [
      "cargo test",
      "cargo clippy --all-targets",
      "cargo build --release",
      "cargo fmt -- --check",
      "git diff",
      "git log --oneline -10",
    ],
    manifest: {
      file: "Cargo.toml",
      content: [
        "[package]",
        'name = "lint-bot"',
        'version = "0.2.0"',
        'edition = "2021"',
        "",
        "[dependencies]",
        'serde = { version = "1", features = ["derive"] }',
        "",
      ].join("\n"),
    },
    topics: [
      "the linter false-positives on multiline strings inside a macro",
      "add a rule for unused imports in generated code, but skip build.rs output",
      "CI job hangs on large diffs instead of timing out cleanly",
      "the PR comment formatter double-posts when a job retries",
      "rule severity levels aren't respected — everything posts as an error",
      "the unused-imports rule misses re-exported imports",
      "lint-bot doesn't skip vendored/ directories and lints third-party code",
      "the CI comment gets truncated mid-sentence on very long rule output",
      "add a suppress-with-reason comment syntax instead of a bare allow",
      "rule config isn't picked up from a workspace root, only per-crate",
    ],
    readme: [
      "# Lint Bot",
      "",
      "A small Rust CLI that runs a handful of custom lint rules over a repo",
      "and posts the results as a PR comment in CI. It exists because the",
      "built-in linter didn't have an opinion about a few house style rules —",
      "unused imports in generated code, multiline strings inside macros, that",
      "kind of thing.",
      "",
      "It's structured as a small rule engine: each rule walks the parsed",
      "source and yields findings, the CLI aggregates findings per file, and a",
      "formatter turns the aggregate into a single PR comment rather than one",
      "comment per finding. The comment-posting path has had more bugs than",
      "the actual lint rules.",
      "",
      "Runs today as a single binary invoked from a CI job; there's no",
      "language-server integration yet, so feedback only shows up after a",
      "push, not while typing.",
    ].join("\n"),
    claudeMd: [
      "# Working agreement — lint-bot",
      "",
      "- A rule that can't explain *why* something is flagged, in the comment",
      "  it posts, doesn't ship. \"disallowed pattern\" with no reason is worse",
      "  than no rule at all.",
      "- New rules default to warning severity for their first two weeks",
      "  before being promoted to error. Nobody trusts a linter that starts",
      "  loud.",
      "- The CI comment path needs to be idempotent under job retries — never",
      "  post a duplicate comment for the same commit.",
      "- Prefer skipping a directory over trying to special-case vendored or",
      "  generated code inside a rule; the rule engine shouldn't know about",
      "  project layout.",
    ].join("\n"),
  },
  {
    key: "mapkit-demo",
    name: "mapkit-demo",
    hasGit: false,
    hasClaudeMd: false,
    files: ["notes.md", "sketch/tiles.js", "sketch/geocode.js"],
    srcDir: "sketch",
    globPattern: "sketch/**/*.js",
    commands: ["ls -la", "cat notes.md", "git status", "node sketch/tiles.js"],
    manifest: null,
    topics: [
      "map tiles don't load offline even though they're cached",
      "geocoding fallback throws on an empty search string instead of returning nothing",
      "clustering perf tanks past about five thousand pins",
      "tile cache never evicts anything and grows unbounded",
      "the offline indicator shows 'online' for a few seconds after losing wifi",
      "pin clustering re-clusters on every pan frame instead of debouncing",
      "geocode results don't get cached, so the same address hits the API every time",
    ],
    readme: [
      "# MapKit Demo",
      "",
      "A scratch prototype exploring offline map tile caching and a geocoding",
      "fallback path — no build tooling, no tests, just a couple of sketch",
      "files and a running notes doc. This is the \"figure out if the idea even",
      "works\" phase, not a real project yet.",
      "",
      "The current sketch caches tiles in IndexedDB as they're requested and",
      "tries to fall back to the cache when a network request fails, with a",
      "very rough geocoding fallback for when the primary provider is down.",
      "Both halves work in isolation and neither is wired together properly.",
      "",
      "If this graduates past prototype it'll get an actual toolchain; for now",
      "it's deliberately bare so it stays easy to throw away.",
    ].join("\n"),
    claudeMd: null,
  },
];

const SUBAGENT_TYPES = ["Explore", "general-purpose", "code-explorer", "Plan", "code-reviewer"];
const TOOLS = ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "TodoWrite"];
const MODELS = [
  ["claude-sonnet-5", 58],
  ["claude-opus-5", 20],
  ["claude-haiku-4-5-20251001", 22],
];

const THINKING = [
  "Let me check the recent commits around this area first.",
  "I should look at the existing tests before changing behavior.",
  "This might be a timezone/locale issue given the symptom.",
  "Worth checking if this is a stale cache rather than a real bug.",
  "I'll trace the data from the entry point down to where it goes wrong.",
  "Let me reproduce this locally before proposing a fix.",
  "This smells like an off-by-one — checking the loop bounds.",
  "Better to add a regression test first, then patch the behavior.",
  "I want to rule out a race condition before assuming it's the logic.",
  "Let me check whether this was working before the last refactor.",
];
const RESPONSES = [
  "Looked into it and found the root cause — writing up a fix now.",
  "Reproduced locally. It's a boundary condition, patching it.",
  "Confirmed via the logs. Opening a small fix for this.",
  "Traced it back to a stale cache entry rather than the code path I expected.",
  "Added a regression test first, then the fix.",
  "This one's messier than it looks — narrowing it down with extra logging.",
  "Found it: an off-by-one in the loop bound.",
  "Not fully sure yet — dispatching a subagent to explore the surrounding code.",
  "Verified the fix against the existing test suite, all green.",
  "Turned out to be a timezone/locale issue, not the parser.",
  "Ran it a few times to make sure it wasn't flaky before calling it fixed.",
  "That's expected behavior actually — documented why below.",
];
const AGENT_RESULT_TEMPLATES = [
  "Traced it to {file} — the fix is a one-line boundary check.",
  "Found three call sites that need the same fix; listed them with line numbers.",
  "No repro locally, but found a suspicious retry loop in {file}.",
  "Confirmed the root cause and left a summary of the fix approach.",
  "Explored the surrounding code; recommend the fix land in {file}.",
  "Reviewed the change — looks correct, one nit about error handling left inline.",
];
const NOISE_LINES = [
  "yes", "y", "yep", "yeah", "ok", "okay", "k", "sure", "continue", "go", "next",
  "do it", "ship it", "good", "great", "thanks", "thank you", "stop", "no", "n",
  "nope", "wait", "undo", "fix it", "retry", "exit", "quit", "clear", "resume",
  "/clear", "/compact", "/resume", "/cost", "/status",
];

function toolResultFor(name) {
  switch (name) {
    case "Bash":
      return choice(["Exit code 0.", "42 passed, 0 failed.", "Exit code 1 — see output above.", "Build succeeded."]);
    case "Read":
      return `${randInt(20, 300)} lines read.`;
    case "Edit":
      return "Applied 1 edit.";
    case "Write":
      return `Wrote ${randInt(5, 80)} lines.`;
    case "Grep":
      return `${randInt(0, 9)} matches found.`;
    case "Glob":
      return `${randInt(1, 14)} files matched.`;
    case "TodoWrite":
      return "Todo list updated.";
    default:
      return "Done.";
  }
}

function buildToolInput(name, repo) {
  const f = choice(repo.files);
  switch (name) {
    case "Bash":
      return { command: choice(repo.commands) };
    case "Read":
      return { file_path: f };
    case "Edit":
      return { file_path: f, old_string: "// TODO", new_string: "// fixed" };
    case "Write":
      return { file_path: f, content: "// scratch notes\n" };
    case "Grep":
      return { pattern: choice(["TODO", "FIXME", "console.log"]), path: repo.srcDir };
    case "Glob":
      return { pattern: repo.globPattern };
    case "TodoWrite":
      return { todos: [{ content: `investigate: ${choice(repo.topics)}`, status: choice(["pending", "in_progress", "completed"]) }] };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Corrections — what the Words tab mines.
//
// A later user message carrying a correction marker gets paired with the
// nearest earlier substantive prompt. Without a few of these the demo corpus
// renders the Words tab empty, which makes a shipped feature look broken.
// Every template below fires a real marker in server/words.ts, spread across
// all three buckets (taken literally / mis-said / overweighted) and both
// confidence levels, so the tab demonstrates its own badges.
// ---------------------------------------------------------------------------
// The topics are full sentences, so these deliberately do NOT interpolate one:
// the Words tab already renders the paired original prompt beside the
// correction, and splicing a sentence into a clause reads like a mail merge.
const CORRECTIONS = [
  // taken literally — explicit
  "that's not what I meant — I wanted the read path diagnosed, not rewritten",
  "you misunderstood me. That was the example, not the whole scope",
  "I didn't mean change the behaviour — just tell me why it happens",
  "that was too literal. I wanted the shape of the fix, not the fix itself",
  // mis-said — explicit (the human's own slip)
  "typo, I meant the opposite — it should stay exactly as it is",
  "sorry, I misspoke: the caller, not the callee",
  "I meant to say staging, not production",
  // overweighted — explicit
  "I never asked for a refactor here. Just the one function",
  "I didn't ask you to touch the tests",
  // inferred — a weak reversal that names no miscommunication outright
  "no, wait — back up. Smallest reproduction first",
  "undo that. Let's take it one piece at a time",
];

/** Close a topic off so appending a suffix doesn't produce a run-on sentence. */
function terminate(topic) {
  if (/[.?!]$/.test(topic)) return topic;
  return /^(why|what|when|where|who|how|is|are|does|do|did|can|could|should|would)\b/i.test(topic)
    ? `${topic}?`
    : `${topic}.`;
}

function buildPrompt(topic) {
  const prefixes = ["", "", "", "Hey — ", "Quick one: ", "Following up: ", "One more thing: "];
  const suffixes = ["", "", "", " Can you take a look?", " Let me know what you find.", " Flag if it's bigger than it looks."];
  // Both draws happen in the original order so the deterministic RNG stream is
  // unchanged: only the punctuation between them differs.
  const prefix = choice(prefixes);
  const suffix = choice(suffixes);
  return prefix + terminate(topic) + suffix;
}
function buildAgentDesc(topic) {
  return choice([
    `Explore the code paths related to: ${topic}`,
    `Find where this is handled: ${topic}`,
    `Review a fix for: ${topic}`,
    `Investigate: ${topic}`,
    `Plan the fix for: ${topic}`,
  ]);
}
function buildAgentResult(repo) {
  return choice(AGENT_RESULT_TEMPLATES).replace("{file}", choice(repo.files));
}
function buildUsage(turnIndex) {
  const input_tokens = randInt(200, 3500);
  const output_tokens = randInt(60, 900);
  const cache_creation_input_tokens = rand() < 0.5 ? randInt(0, 1800) : 0;
  const ceiling = Math.min(40000, turnIndex * randInt(500, 2800) + 300);
  const cache_read_input_tokens = rand() < 0.85 ? randInt(0, ceiling) : 0;
  return { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens };
}

// ---------------------------------------------------------------------------
// Time span: ~70 days back, ending ~1 day before "now", clustered into ~45
// active days so the by-day charts, span, and active-day counts look real.
// ---------------------------------------------------------------------------
const NOW = Date.now();
const SPAN_DAYS = 70;
const ACTIVE_DAYS_COUNT = 45;
const dayPool = shuffle(Array.from({ length: SPAN_DAYS }, (_, i) => i + 1)); // 1..70 days ago
const activeDaysAgo = dayPool.slice(0, ACTIVE_DAYS_COUNT).sort((a, b) => b - a); // oldest first

function dayBaseMs(daysAgo) {
  const d = new Date(NOW - daysAgo * 86_400_000);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ---------------------------------------------------------------------------
// Global counters so the "leave a few dispatches unpaired" requirement is
// enforced across the WHOLE corpus, not per file.
// ---------------------------------------------------------------------------
let dispatchGlobalIndex = 0;
let unpairedCount = 0;
const UNPAIRED_TARGET = 3;

let statAgentDispatches = 0;
let statAgentPaired = 0;
let statCorrections = 0;
let statTotalLines = 0;
let statTotalSessions = 0;

/** Build one session's raw JSONL lines (already JSON.stringify'd, plus a few
 *  intentionally malformed raw strings). Returns { lines, startMs }. */
function buildSessionLines(repo, injectMalformed) {
  const daysAgo = choice(activeDaysAgo);
  let cur = dayBaseMs(daysAgo) + randInt(8, 21) * 3_600_000 + randInt(0, 3599) * 1000;
  const startMs = cur;
  const targetLines = randInt(30, 120);
  const lines = [];

  function push(obj) {
    lines.push(JSON.stringify(obj));
  }
  function advance(big) {
    const secs = big ? randInt(660, 2200) : randInt(4, 150);
    cur += secs * 1000;
  }

  let turnIndex = 0;
  while (lines.length < targetLines) {
    turnIndex++;
    const topic = choice(repo.topics);

    // Human prompt (opens/continues a turn).
    const useArray = rand() < 0.35;
    push({
      type: "user",
      timestamp: new Date(cur).toISOString(),
      message: { role: "user", content: useArray ? [{ type: "text", text: buildPrompt(topic) }] : buildPrompt(topic) },
    });

    const exchanges = randInt(3, 14);
    for (let i = 0; i < exchanges && lines.length < targetLines + 8; i++) {
      // Occasional sidechain noise: a small subagent-internal exchange that
      // must NOT count toward main-thread working time.
      if (rand() < 0.06) {
        const sid = toolUseId();
        advance(false);
        push({
          type: "assistant",
          timestamp: new Date(cur).toISOString(),
          isSidechain: true,
          message: {
            role: "assistant",
            model: weighted(MODELS),
            usage: buildUsage(turnIndex),
            content: [
              { type: "tool_use", id: sid, name: choice(TOOLS), input: buildToolInput(choice(TOOLS), repo) },
            ],
          },
        });
        advance(false);
        push({
          type: "user",
          timestamp: new Date(cur).toISOString(),
          isSidechain: true,
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: sid, content: "Done." }] },
        });
      }

      const big = rand() < 0.08;
      advance(big);

      const content = [];
      if (rand() < 0.4) content.push({ type: "thinking", thinking: choice(THINKING) });
      if (rand() < 0.75) content.push({ type: "text", text: choice(RESPONSES) });

      const toolBlocks = [];
      const nTools = rand() < 0.75 ? randInt(1, 2) : 0;
      for (let t = 0; t < nTools; t++) {
        let name, input;
        if (rand() < 0.1) {
          name = rand() < 0.75 ? "Agent" : "Task";
          input = { subagent_type: choice(SUBAGENT_TYPES), description: buildAgentDesc(topic) };
        } else {
          name = choice(TOOLS);
          input = buildToolInput(name, repo);
        }
        const id = toolUseId();
        content.push({ type: "tool_use", id, name, input });
        toolBlocks.push({ id, name });
      }

      push({
        type: "assistant",
        timestamp: new Date(cur).toISOString(),
        message: { role: "assistant", model: weighted(MODELS), usage: buildUsage(turnIndex), content },
      });

      for (const tb of toolBlocks) {
        const isAgent = tb.name === "Agent" || tb.name === "Task";
        if (isAgent) {
          dispatchGlobalIndex++;
          statAgentDispatches++;
          const forceUnpaired = unpairedCount < UNPAIRED_TARGET && dispatchGlobalIndex % 9 === 0;
          if (forceUnpaired) {
            unpairedCount++;
            continue; // no matching tool_result — a deliberately unpaired dispatch
          }
          cur += randInt(30, 1500) * 1000; // 30s .. 25min
          push({
            type: "user",
            timestamp: new Date(cur).toISOString(),
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: tb.id, content: buildAgentResult(repo) }] },
          });
          statAgentPaired++;
        } else {
          advance(false);
          push({
            type: "user",
            timestamp: new Date(cur).toISOString(),
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: tb.id, content: toolResultFor(tb.name) }] },
          });
        }
      }
      if (lines.length >= targetLines) break;
    }

    // Occasionally the human comes back and says the prompt was taken the wrong
    // way. Deliberately rare: the Words tab should look like a real corpus --
    // a handful of moments that mattered -- not a stream of corrections.
    if (rand() < 0.17) {
      advance(false);
      // Rotate rather than draw: a random pick repeats often enough that the
      // newest few entries -- the ones the Words tab shows first -- kept landing
      // on the same line, which reads as canned rather than mined.
      const correction = CORRECTIONS[statCorrections % CORRECTIONS.length];
      push({
        type: "user",
        timestamp: new Date(cur).toISOString(),
        message: { role: "user", content: correction },
      });
      statCorrections++;
    }

    if (rand() < 0.15) {
      advance(false);
      push({ type: "summary", timestamp: new Date(cur).toISOString(), summary: `Session summary: worked on ${topic}.` });
    }
  }

  if (injectMalformed) {
    const truncatedTs = new Date(cur).toISOString();
    const pos1 = randInt(2, Math.max(2, lines.length - 3));
    lines.splice(pos1, 0, `{"type":"user","timestamp":"${truncatedTs.slice(0, 10)}`); // truncated JSON
    const pos2 = randInt(2, Math.max(2, lines.length - 2));
    lines.splice(pos2, 0, "null"); // parses to null
    const pos3 = randInt(2, Math.max(2, lines.length - 1));
    lines.splice(pos3, 0, ""); // blank line
  }

  return { lines, startMs };
}

// ---------------------------------------------------------------------------
// History (~/.claude/history.jsonl equivalent). Interleaves the 6 repos so
// there are many project->project hops, with both explicit and inferred
// bridging lines.
// ---------------------------------------------------------------------------
function explicitArrivalLine(repo, topic) {
  return choice([
    `switching over to ${repo.name} — need to look at ${topic}`,
    `back in ${repo.name} now, picking up ${topic}`,
    `ok moving to ${repo.name} for this one`,
    `let's check ${repo.name}: ${topic}`,
  ]);
}
function inferredArrivalLine(topic) {
  return choice([topic, `can you also check: ${topic}`, `one more: ${topic}`, `also seeing this — ${topic}`]);
}

function buildHistory(sessionIdsByRepoKey) {
  const entries = [];
  let prevRepo = null;
  for (const daysAgo of activeDaysAgo) {
    const blocksToday = randInt(1, 3);
    const dayRepos = shuffle(REPOS).slice(0, blocksToday);
    let cur = dayBaseMs(daysAgo) + randInt(8, 20) * 3_600_000;
    for (const repo of dayRepos) {
      const blockLen = randInt(4, 12);
      const sessionIds = sessionIdsByRepoKey[repo.key];
      for (let i = 0; i < blockLen; i++) {
        const topic = choice(repo.topics);
        let text;
        if (i === 0 && prevRepo && prevRepo.key !== repo.key) {
          text = rand() < 0.5 ? explicitArrivalLine(repo, topic) : inferredArrivalLine(topic);
        } else if (rand() < 0.12) {
          text = choice(NOISE_LINES);
        } else {
          text = topic;
        }
        entries.push({
          display: text,
          timestamp: cur,
          project: repo.absPath,
          sessionId: choice(sessionIds),
        });
        cur += randInt(20, 240) * 1000;
      }
      prevRepo = repo;
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // CCL_FIXTURES_DIR is an arbitrary absolute path from the environment, and the
  // next line deletes it recursively. The relocated-repos branch below has always
  // refused to clear a directory this script didn't create; the corpus root needs
  // the identical guard, or `CCL_FIXTURES_DIR=~/Documents npm run fixtures` eats
  // Documents. Only the in-repo default (gitignored, script-owned) is cleared on
  // trust.
  if (process.env.CCL_FIXTURES_DIR) {
    const marker = path.join(FIXTURES_DIR, MARKER);
    if (existsSync(FIXTURES_DIR) && !existsSync(marker)) {
      console.error(
        `Refusing to overwrite ${FIXTURES_DIR}: it exists and was not generated by this script.\n` +
          `CCL_FIXTURES_DIR must point at a new or previously-generated fixture directory.`,
      );
      process.exit(1);
    }
  }
  await rm(FIXTURES_DIR, { recursive: true, force: true });
  // REPOS_DIR can live outside FIXTURES_DIR when relocated via CCL_FIXTURES_REPOS,
  // so it needs clearing separately. That env var is an arbitrary absolute path, so
  // NEVER recursively delete it on trust: only a directory this script itself created
  // (marked) — or one that doesn't exist yet — is safe to blow away. Pointing the var
  // at a real repo root should fail loudly, not eat it.
  if (!REPOS_DIR.startsWith(FIXTURES_DIR + path.sep)) {
    const marker = path.join(REPOS_DIR, MARKER);
    if (existsSync(REPOS_DIR) && !existsSync(marker)) {
      console.error(
        `Refusing to overwrite ${REPOS_DIR}: it exists and was not generated by this script.\n` +
          `CCL_FIXTURES_REPOS must point at a new or previously-generated fixture directory.`,
      );
      process.exit(1);
    }
    await rm(REPOS_DIR, { recursive: true, force: true });
  }
  await mkdir(REPOS_DIR, { recursive: true });
  await writeFile(path.join(REPOS_DIR, MARKER), "generated by scripts/make-fixtures.mjs\n", "utf8");
  await mkdir(PROJECTS_DIR, { recursive: true });
  // Marks the corpus root as script-generated so a later relocated run knows it
  // is safe to clear. Mirrors the marker written into a relocated REPOS_DIR.
  await writeFile(path.join(FIXTURES_DIR, MARKER), "generated by scripts/make-fixtures.mjs\n", "utf8");

  // --- 1. Write invented repos to fixtures/repos/ -------------------------
  for (const repo of REPOS) {
    const repoPath = path.join(REPOS_DIR, repo.name);
    repo.absPath = repoPath;
    await mkdir(repoPath, { recursive: true });
    await writeFile(path.join(repoPath, "README.md"), repo.readme + "\n", "utf8");
    if (repo.hasClaudeMd) {
      await writeFile(path.join(repoPath, "CLAUDE.md"), repo.claudeMd + "\n", "utf8");
    }
    if (repo.manifest) {
      const content =
        typeof repo.manifest.content === "string"
          ? repo.manifest.content
          : JSON.stringify(repo.manifest.content, null, 2) + "\n";
      await writeFile(path.join(repoPath, repo.manifest.file), content, "utf8");
    }
    if (repo.hasGit) {
      await mkdir(path.join(repoPath, ".git"), { recursive: true });
    }
  }

  // --- 2. Write session transcripts to fixtures/projects/ -----------------
  const sessionIdsByRepoKey = {};
  for (const repo of REPOS) {
    const dirName = encodeProjectDir(repo.absPath);
    const projDir = path.join(PROJECTS_DIR, dirName);
    await mkdir(projDir, { recursive: true });

    const sessionCount = randInt(3, 8);
    const ids = [];
    for (let s = 0; s < sessionCount; s++) {
      const id = uuid();
      ids.push(id);
      const { lines } = buildSessionLines(repo, s === 0);
      await writeFile(path.join(projDir, `${id}.jsonl`), lines.join("\n") + "\n", "utf8");
      statTotalSessions++;
      statTotalLines += lines.length;
    }
    sessionIdsByRepoKey[repo.key] = ids;
  }

  // --- 2b. One orphan log project with no matching fixture repo -----------
  const ORPHAN_ABS_PATH = "/Users/demo-operator/Archive/sunset-prototype";
  const ORPHAN_REPO = {
    key: "sunset-prototype",
    name: "sunset-prototype",
    files: ["scripts/migrate.js", "scripts/cleanup.js", "notes.md"],
    srcDir: "scripts",
    globPattern: "scripts/**/*.js",
    commands: ["node scripts/migrate.js", "git status", "ls -la"],
    topics: [
      "the migration script leaves orphaned rows behind when it's interrupted",
      "cleanup job never got scheduled after the last handoff",
      "not sure this is worth finishing — checking if anything still depends on it",
      "the old export format doesn't match what the new tool expects",
    ],
  };
  {
    const dirName = encodeProjectDir(ORPHAN_ABS_PATH);
    const projDir = path.join(PROJECTS_DIR, dirName);
    await mkdir(projDir, { recursive: true });
    const sessionCount = randInt(2, 4);
    for (let s = 0; s < sessionCount; s++) {
      const id = uuid();
      const { lines } = buildSessionLines(ORPHAN_REPO, false);
      await writeFile(path.join(projDir, `${id}.jsonl`), lines.join("\n") + "\n", "utf8");
      statTotalSessions++;
      statTotalLines += lines.length;
    }
  }

  // --- 3. History.jsonl (project journey) ----------------------------------
  const history = buildHistory(sessionIdsByRepoKey);
  const historyLines = history.map((e) => JSON.stringify(e));
  await writeFile(HISTORY_FILE, historyLines.join("\n") + "\n", "utf8");

  // --- 4. Summary -----------------------------------------------------------
  const logDirArg = PROJECTS_DIR;
  const repoRootArg = REPOS_DIR;
  console.log("Synthetic fixture corpus generated.");
  console.log("");
  console.log(`  Repos:            ${REPOS.length}`);
  console.log(`  Log projects:     ${REPOS.length + 1} (incl. 1 orphan)`);
  console.log(`  Sessions:         ${statTotalSessions}`);
  console.log(`  JSONL lines:      ${statTotalLines}`);
  console.log(`  Agent dispatches: ${statAgentDispatches} (${statAgentPaired} paired, ${statAgentDispatches - statAgentPaired} unpaired)`);
  console.log(`  History entries:  ${history.length}`);
  console.log(`  Corrections:      ${statCorrections} (Words tab)`);
  console.log(`  Active days:      ${ACTIVE_DAYS_COUNT} of ${SPAN_DAYS}`);
  console.log("");
  console.log("Paste into the app's Settings dialog:");
  console.log(`  Claude Code log location: ${logDirArg}`);
  console.log(`  Base repo root:           ${repoRootArg}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

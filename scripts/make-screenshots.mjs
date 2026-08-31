#!/usr/bin/env node
/**
 * Capture the README screenshot set against the generated sample corpus.
 *
 * Deliberately shoots `fixtures/`, never a real `~/.claude` — the point of the
 * sample corpus is that the app can be shown without publishing somebody's
 * private repo names, prompts and spend. The script refuses to run if the
 * fixture corpus isn't readable.
 *
 * Usage:  npm run demo:shots         # terminal 1
 *         npm run screenshots:shots # terminal 2
 *
 * `demo:shots`, not `demo`: the Repos page renders each repo's ABSOLUTE path on
 * its card, so a corpus under ./fixtures would put the capturing machine's home
 * directory into every committed PNG. `demo:shots` builds it under
 * /tmp/demo-operator instead, and sets CCL_FIXTURES_DIR so this script looks
 * there too.
 *
 * Drives headless Chrome over the DevTools Protocol rather than using
 * `--screenshot`. That flag needs `--virtual-time-budget` to let the page
 * finish fetching, and virtual time never expires on a page with a running
 * `requestAnimationFrame` loop — which both the Journey canvas field and the
 * animated counters have. CDP lets us wait for a real readiness condition
 * instead. Zero dependencies: Node 24 has global `fetch` and `WebSocket`.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "docs", "screenshots");
// Must match whatever `npm run demo` / `npm run demo:shots` pointed the server at.
const FIXTURES = process.env.CCL_FIXTURES_DIR
  ? path.resolve(process.env.CCL_FIXTURES_DIR)
  : path.join(REPO, "fixtures");
const URL_BASE = "http://127.0.0.1:5189";
/** Must match STORAGE_KEY in src/config.ts — the page reads its corpus from here first. */
const CONFIG_KEY = "claude-code-log.config";
const CHROME =
  process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

/** width, height, and the readiness probe evaluated in the page. */
const SHOTS = [
  { name: "repos", route: "/", ready: ".hero-stats, .empty" },
  { name: "dataviz", route: "/viz", ready: ".vz-hero, .error", height: 1500 },
  // Scrolled to the interactive map: the opening scene is mostly an empty
  // particle field, and the project graph is the informative part.
  {
    name: "journey",
    route: "/journey",
    ready: ".jn-graph-wrap, .empty, .error",
    height: 1100,
    // Anchor on the whole map SECTION, not the graph box. Centring the graph
    // left the section's own intro paragraph sliced in half under the sticky
    // topbar. `start` plus an offset clears the topbar and frames the section
    // from its heading down.
    scrollTo: "#jny-map",
    scrollBlock: "start",
    scrollOffset: -72,
  },
  { name: "search", route: "/search?q=ferry", ready: ".results, .empty, .hint" },
  { name: "words", route: "/words", ready: ".wm-list, .empty, .error", height: 1100 },
  { name: "profile", route: "/profile", ready: ".stats.snapshot, .empty, .error", height: 1500 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${URL_BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

/** The corpus this run is supposed to be shooting. Both guards use it, so they
 *  can never disagree about which corpus "correct" means. */
function fixturePaths() {
  return {
    logDir: path.join(FIXTURES, "projects"),
    repoRoot: process.env.CCL_FIXTURES_REPOS
      ? path.resolve(process.env.CCL_FIXTURES_REPOS)
      : path.join(FIXTURES, "repos"),
  };
}

/**
 * Refuse to shoot a corpus that sits inside the repo.
 *
 * The Repos page renders each repo's ABSOLUTE path on its card, so a corpus at
 * ./fixtures puts the capturing machine's home directory into every committed
 * PNG. That is the leak that reached the published screenshot set once already.
 * `demo:shots` / `screenshots:shots` relocate the corpus under /tmp; this makes
 * running the non-`:shots` pair a hard failure rather than a silent one.
 */
function assertNeutralRoot() {
  if (FIXTURES === REPO || FIXTURES.startsWith(REPO + path.sep)) {
    console.error(`Refusing to capture: the corpus at ${FIXTURES} is inside the repo,`);
    console.error(`so every repo card would render this machine's home directory.`);
    console.error(`Use the relocated pair instead:`);
    console.error(`  npm run demo:shots        # terminal 1`);
    console.error(`  npm run screenshots:shots # terminal 2`);
    return false;
  }
  return true;
}

/**
 * Pin the page's corpus, rather than trusting the server's build-time seed.
 *
 * `loadConfig()` (src/config.ts) reads localStorage first and only falls back to
 * the VITE_LOG_DIR seed. Chrome runs on a throwaway profile here, so that store
 * is empty and the seed wins — which means the corpus depends entirely on which
 * npm script happens to be holding the port. Writing the key ourselves makes the
 * capture independent of that: `npm run dev` in terminal 1 can no longer put real
 * transcripts into the shots.
 */
async function pinBrowserCorpus(call) {
  const { logDir, repoRoot } = fixturePaths();
  const { result } = await call("Runtime.evaluate", {
    expression: `(() => {
      try {
        localStorage.setItem(${JSON.stringify(CONFIG_KEY)}, ${JSON.stringify(
          JSON.stringify({ logDir, repoRoot }),
        )});
        return localStorage.getItem(${JSON.stringify(CONFIG_KEY)});
      } catch (e) { return "ERR:" + e.message; }
    })()`,
    returnByValue: true,
  });
  const stored = result?.value;
  if (typeof stored !== "string" || stored.startsWith("ERR:")) {
    throw new Error(`could not pin the capture corpus in localStorage (${stored})`);
  }
  return stored;
}

/**
 * Backstop: never write a screenshot that shows this machine's home directory.
 *
 * Everything above is a precondition check. This one reads the rendered page,
 * which is the only thing that actually ends up in the PNG. If it ever fires,
 * some path the guards do not model has put real data on screen.
 */
async function assertNoHomePaths(call, name) {
  const home = os.homedir();
  const { result } = await call("Runtime.evaluate", {
    expression: `document.body ? document.body.innerText : ""`,
    returnByValue: true,
  });
  const text = typeof result?.value === "string" ? result.value : "";
  if (home && text.includes(home)) {
    const line = text.split("\n").find((l) => l.includes(home)) ?? "";
    throw new Error(
      `${name}: the rendered page contains this machine's home directory — refusing to write it.\n` +
        `  offending line: ${line.trim().slice(0, 160)}\n` +
        `  the server on ${URL_BASE} is serving real transcripts; restart it with: npm run demo:shots`,
    );
  }
}

async function assertFixtures() {
  const qs = new URLSearchParams(fixturePaths());
  const res = await fetch(`${URL_BASE}/api/overview?${qs}`);
  if (!res.ok) return false;
  const data = await res.json();
  return Array.isArray(data.repos) && data.repos.length > 0;
}

/** Minimal CDP client over the browser-level WebSocket. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
  });
  return new Cdp(ws);
}

/**
 * Refuse to shoot a server that can't serve THIS fixture corpus.
 *
 * `waitForServer` only proves something answers on the port. The port is pinned
 * with strictPort, so a stale dev server left over from an earlier run keeps it
 * and the new one exits — leaving the capture pointed at whatever corpus the old
 * process was serving, silently. That produces screenshots that disagree with
 * the README's own numbers, and nothing about the run looks wrong.
 *
 * This catches the corpus being unreadable, empty, or outside the server's
 * allowed roots. It does NOT establish what the captured PAGE will render: the
 * browser resolves its own corpus from localStorage, falling back to the
 * VITE_LOG_DIR seed baked in by whichever npm script started the server. A
 * server launched with plain `npm run dev` sets no seed, so the page reads the
 * REAL ~/.claude/projects while this probe still passes — the server can serve
 * both. `pinBrowserCorpus` closes that by writing the corpus into localStorage
 * itself, and `assertNoHomePaths` is the backstop that refuses to write a PNG
 * showing the capturing machine's home directory.
 */
async function assertServingFixtures() {
  const { logDir, repoRoot } = fixturePaths();
  const url = `${URL_BASE}/api/metrics?logDir=${encodeURIComponent(logDir)}&repoRoot=${encodeURIComponent(repoRoot)}`;
  let served;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`The server rejected the fixture corpus (HTTP ${res.status}).`);
      console.error(`It is probably a stale server on ${URL_BASE} from an earlier run, or one`);
      console.error(`started without CLAUDE_CODE_LOG_ROOTS covering ${FIXTURES}.`);
      return false;
    }
    served = await res.json();
  } catch (err) {
    console.error(`Could not read ${url}: ${err.message}`);
    return false;
  }
  if (!served?.totals?.sessions) {
    console.error(`The server reports an empty corpus at ${logDir} — it is serving something else.`);
    console.error(`Kill whatever holds ${URL_BASE} and re-run: npm run demo:shots`);
    return false;
  }
  console.log(
    `  serving ${served.totals.sessions} sessions / ${served.agents?.total ?? 0} agent dispatches from ${logDir}`,
  );
  return true;
}

async function main() {
  if (!assertNeutralRoot()) process.exit(1);
  if (!(await waitForServer())) {
    console.error(`Nothing serving ${URL_BASE} — start it first with: npm run demo:shots`);
    process.exit(1);
  }
  if (!(await assertFixtures())) {
    console.error(`The fixture corpus at ${FIXTURES} isn't readable — run: npm run demo:shots`);
    process.exit(1);
  }
  if (!(await assertServingFixtures())) process.exit(1);

  await mkdir(OUT, { recursive: true });
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "ccl-shots-"));

  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const cleanup = async () => {
    chrome.kill();
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    // Wait for the debugging endpoint.
    let version = null;
    for (let i = 0; i < 60; i++) {
      try {
        version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!version) throw new Error("Chrome did not expose its debugging port");

    const browser = await connect(version.webSocketDebuggerUrl);
    console.log(`Capturing to ${OUT}`);

    for (const shot of SHOTS) {
      const width = shot.width ?? 1440;
      const height = shot.height ?? 900;

      const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });

      const call = (method, params) => browser.send(method, params, sessionId);
      await call("Page.enable");
      await call("Runtime.enable");
      await call("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 2,
        mobile: false,
      });

      // Load the origin once so localStorage is reachable, pin the corpus there,
      // then reload into the same route so the app boots reading our config
      // instead of whatever seed the running server was built with.
      await call("Page.navigate", { url: `${URL_BASE}/#${shot.route}` });
      await sleep(400);
      await pinBrowserCorpus(call);
      await call("Page.reload", { ignoreCache: true });

      // Wait for the view's own content to exist, not just for load —
      // every view fetches after mount.
      let ready = false;
      for (let i = 0; i < 80; i++) {
        const { result } = await call("Runtime.evaluate", {
          expression: `!!document.querySelector(${JSON.stringify(shot.ready)})`,
          returnByValue: true,
        });
        if (result.value) {
          ready = true;
          break;
        }
        await sleep(250);
      }
      if (!ready) console.warn(`  ! ${shot.name}: "${shot.ready}" never appeared — capturing anyway`);

      if (shot.scrollTo) {
        await call("Runtime.evaluate", {
          expression:
            `document.querySelector(${JSON.stringify(shot.scrollTo)})` +
            `?.scrollIntoView({ block: ${JSON.stringify(shot.scrollBlock ?? "center")} });` +
            // The topbar is position:sticky, so `start` parks the anchor under
            // it. Nudge back by the offset to bring it clear.
            (shot.scrollOffset ? ` window.scrollBy(0, ${Number(shot.scrollOffset)});` : ""),
        });
        await sleep(1200); // scroll-driven scenes re-render on scroll
      }

      // Let charts/counters settle. These animate, so this is a deliberate
      // settle delay rather than a condition.
      await sleep(2500);

      await assertNoHomePaths(call, shot.name);

      const { data } = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(path.join(OUT, `${shot.name}.png`), Buffer.from(data, "base64"));
      console.log(`  → ${shot.name}.png (${width}x${height} @2x)`);

      await browser.send("Target.closeTarget", { targetId });
    }
  } finally {
    await cleanup();
  }
}

await main();

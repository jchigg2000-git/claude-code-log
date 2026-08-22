import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { encodeProjectDir } from "../server/paths.ts";
import { buildRepoKeys, matchRepo, resolveProjectName, resolveProjectPath } from "../server/projectNames.ts";

/** Encode a real path the way Claude Code names its log directory for that cwd. */
const dirFor = (p: string) => encodeProjectDir(p);

const ROOT = "/tmp/ccl-fake/code";
const KEYS = buildRepoKeys([
  { name: "mapkit-demo", path: `${ROOT}/mapkit-demo` },
  { name: "ferry-scheduler", path: `${ROOT}/ferry-scheduler` },
  { name: "app", path: `${ROOT}/app` },
  { name: "appendix", path: `${ROOT}/appendix` },
  { name: "acme/web-app", path: `${ROOT}/acme/web-app` },
]);

test("a hyphenated repo outside ~/Projects keeps its whole name", () => {
  // The original bug: with no `Projects` segment to anchor on, the old code
  // decoded the dir name and took the basename, truncating at the last dash.
  for (const root of ["/tmp/ccl-fake/code", "/tmp/ccl-fake/dev", "/tmp/ccl-fake/src"]) {
    const keys = buildRepoKeys([{ name: "mapkit-demo", path: `${root}/mapkit-demo` }]);
    assert.equal(resolveProjectName(dirFor(`${root}/mapkit-demo`), keys, root), "mapkit-demo");
  }
});

test("a grouped repo reports the same name the repo crawl gives it", () => {
  // crawlRepos names a depth-2 repo `org/repo`; the two surfaces must agree or
  // the Repos tab and the Data Viz tab disagree about the same project.
  assert.equal(resolveProjectName(dirFor(`${ROOT}/acme/web-app`), KEYS, ROOT), "acme/web-app");
});

test("a subdirectory of a repo is named repo/tail, not folded and not truncated", () => {
  assert.equal(resolveProjectName(dirFor(`${ROOT}/mapkit-demo/server`), KEYS, ROOT), "mapkit-demo/server");
});

test("longest matching repo wins, so a nested repo beats its parent directory", () => {
  const keys = buildRepoKeys([
    { name: "acme", path: `${ROOT}/acme` },
    { name: "acme/web-app", path: `${ROOT}/acme/web-app` },
  ]);
  assert.equal(resolveProjectName(dirFor(`${ROOT}/acme/web-app`), keys, ROOT), "acme/web-app");
});

test("a repo whose name prefixes another is not swallowed by it", () => {
  // `-...-app-endix` must not match the `app` key: the guard is `key + "-"`.
  assert.equal(resolveProjectName(dirFor(`${ROOT}/app`), KEYS, ROOT), "app");
  assert.equal(resolveProjectName(dirFor(`${ROOT}/appendix`), KEYS, ROOT), "appendix");
});

test("an unmatched project under the configured root keeps every dash", () => {
  // No crawled repo matches (it was deleted, or was never a directory we crawl),
  // so precision is gone — but the answer must still not drop half the name.
  const name = resolveProjectName(dirFor(`${ROOT}/archive/old-thing`), KEYS, ROOT);
  assert.equal(name, "archive-old-thing");
  assert.ok(name.includes("old-thing"), "must not truncate at the last dash");
});

test("with no repoRoot at all, a project under $HOME is still not truncated", () => {
  const home = os.homedir();
  const dirName = dirFor(path.join(home, "elsewhere", "some-tool"));
  assert.equal(resolveProjectName(dirName, []), "elsewhere-some-tool");
});

test("a project matching nothing known keeps every segment, minus the root separator", () => {
  // Moved, deleted, or from another machine: there is nothing to match against,
  // so show the whole directory name. It is a label, not a path, so the leading
  // dash standing in for `/` goes — but no interior dash is ever touched.
  assert.equal(resolveProjectName("-somewhere-else-entirely", []), "somewhere-else-entirely");
});

test("the filesystem root encodes to a bare dash and still matches its children", () => {
  // encodeProjectDir("/") is "-", so the child prefix is "-", not "--".
  // Getting this wrong makes every lookup under a root of "/" silently miss.
  assert.equal(encodeProjectDir("/"), "-");
  assert.equal(resolveProjectName("-Users-x-code-mapkit-demo", [], "/"), "Users-x-code-mapkit-demo");
});

test("a log dir that IS the configured root is named after the root", () => {
  assert.equal(resolveProjectName(dirFor(ROOT), [], ROOT), "code");
});

test("a trailing dash yields the repo name, never a dangling separator", () => {
  const dirName = `${dirFor(`${ROOT}/mapkit-demo`)}-`;
  assert.equal(resolveProjectName(dirName, KEYS, ROOT), "mapkit-demo");
});

test("matchRepo reports the encoded tail below the matched repo", () => {
  const m = matchRepo(dirFor(`${ROOT}/mapkit-demo/server/api`), KEYS);
  assert.equal(m?.repo.name, "mapkit-demo");
  assert.equal(m?.remainder, "server-api");
  assert.equal(matchRepo(dirFor(`${ROOT}/mapkit-demo`), KEYS)?.remainder, "");
});

test("resolveProjectPath returns the repo's real path, exactly", () => {
  // The whole point: the repo half comes from a path we crawled, so it is not
  // a guess. Compare against the lossy decode, which splits the dash.
  assert.equal(resolveProjectPath(dirFor(`${ROOT}/ferry-scheduler`), KEYS), `${ROOT}/ferry-scheduler`);
  assert.notEqual(resolveProjectPath(dirFor(`${ROOT}/ferry-scheduler`), KEYS), `${ROOT}/ferry/scheduler`);
});

test("resolveProjectPath falls back to the documented approximation when nothing matches", () => {
  // An orphan log dir has no repo to anchor on, so best-effort is the honest
  // answer — and it stays lossy, exactly as test/paths.test.ts pins it.
  assert.equal(resolveProjectPath("-Users-me-Projects-my-app", []), "/Users/me/Projects/my/app");
});

test("the home directory itself is named '~', matching the Journey tab", () => {
  // server/journey.ts::normalizeProject labels this project "~". If the two
  // disagree, the same project shows two different names on two tabs.
  assert.equal(resolveProjectName(dirFor(os.homedir()), [], `${os.homedir()}/code`), "~");
});

test("a trailing separator never surfaces as a dangling dash", () => {
  // The old implementation dropped empty segments via .filter(Boolean); the
  // verbatim remainder has to trim its own ends or it renders "Some-Project-".
  const dirName = `${dirFor(`${ROOT}/archive`)}-Stone-Web-`;
  const name = resolveProjectName(dirName, [], ROOT);
  assert.equal(name, "archive-Stone-Web");
  assert.ok(!name.endsWith("-"), "must not end in a separator");
});

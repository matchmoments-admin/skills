// Pipeline tests: cli (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as names from "../src/conventions.mjs";
import * as gate from "../src/gate.mjs";
import * as verdict from "../src/verdict.mjs";
import * as roles from "../src/roles.mjs";
import * as journey from "../src/journey.mjs";
import * as capacity from "../src/capacity.mjs";
import * as settings from "../src/settings.mjs";
import { plan } from "../src/closeout.mjs";
import { jiraTracker, githubTracker, adfToText } from "../src/tracker.mjs";
import { orgRegistry, packageList, findOrphans, personaOf as orgPersonaOf, expandSeed, sameSourceVia } from "../src/org.mjs";
import { summarize, toMarkdown, aiCost } from "../src/metrics.mjs";
import { typesafeJev, triageUiFailure, triageReview, storyReadiness } from "../src/jev.mjs";
import * as plans from "../src/plan.mjs";
import { storyCard, CARD_MARK, startingCard, activityLine } from "../src/card.mjs";
import * as board from "../src/board.mjs";
import * as tests from "../src/tests.mjs";
import * as production from "../src/production.mjs";
import * as access from "../src/access.mjs";
import * as pack from "../src/context-pack.mjs";
import * as shipping from "../src/shipping.mjs";
import * as closeout from "../src/closeout.mjs";
import { lane, jobId, wakeAll, waiterJob } from "../src/lane.mjs";
import * as events from "../src/events.mjs";
import { codeHost } from "../src/github.mjs";
import { storyCards, releaseCard, newStoryCard } from "../src/card.mjs";
import * as actions from "../src/actions.mjs";
import * as specs from "../src/spec.mjs";
import * as evidence from "../src/evidence.mjs";
import * as baselineMod from "../src/baseline.mjs";
import * as orgMod from "../src/org.mjs";
import * as start from "../src/start.mjs";
import * as harness from "../src/harness.mjs";
import { fixture, open, ok, FULL_AI, withVerdicts, uiPassed, fakeSf, fakeJev, src, files, pick, repo, O, SHA, fakeRefs, fakeGitHub, scratchSkill, webp, meta, provisionSf, deliveryIo, BOT, wfSteps, pipeSources, st_, read, TREE } from "./helpers.mjs";


test("TRACKER=jira: pipe builds the tracker on first use, so a command that never reads it needs no Jira login", async () => {
  const { spawnSync } = await import("node:child_process");
  const pipe = (...args) => spawnSync(process.execPath, [new URL("../bin/pipe.mjs", import.meta.url).pathname, ...args], { encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GH_REPO: "o/r", PIPELINE_EVENTS: "off", PIPELINE_VARS: JSON.stringify({ TRACKER: "jira", JIRA_BASE_URL: "https://acme.atlassian.net" }) } });
  const s = pipe("settings");
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /TRACKER\s+jira/);
  const t = pipe("tracker", "story", "LIFE-1");
  assert.notEqual(t.status, 0, "a tracker command without the login fails");
  assert.match(t.stdout + t.stderr, /JIRA_EMAIL and JIRA_API_TOKEN/);
});

test("pipe.mjs is a thin command table: no GitHub, git or Salesforce logic of its own", async () => {
  const src = readFileSync(new URL("../bin/pipe.mjs", import.meta.url), "utf8");
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, ["--check", new URL("../bin/pipe.mjs", import.meta.url).pathname]);   // it parses (a comment once swallowed a body)
  assert.ok(src.split("\n").length < 500, "small: one line or a few per command");
  assert.doesNotMatch(src, /fetch\(|check-runs`, \{|sgd", "source", "delta"|createSign/);
});

test("harness overlay: main's copy replaces the branch's, git sees nothing to commit, and a missing path fails", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "overlay-"));
  const g = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const put = (p, t) => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), t); };
  g(["init", "-q"]); g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
  put("CLAUDE.md", "branch rules"); put("REVIEW.md", "branch review"); put("docs/agents/salesforce.md", "old facts"); put("docs/agents/gone.md", "removed on main");
  g(["add", "-A"]); g(["commit", "-qm", "branch"]);
  put(".pipeline/CLAUDE.md", "main rules"); put(".pipeline/REVIEW.md", "main review"); put(".pipeline/docs/agents/salesforce.md", "new facts"); put(".pipeline/docs/agents/new.md", "added on main");
  const git = (args, o) => execFileSync("git", args, { cwd: o?.cwd || root, encoding: "utf8" });
  assert.deepEqual(harness.overlay("implement", { git, root }), ["CLAUDE.md", "REVIEW.md", "docs/agents"]);
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), "main rules");
  assert.equal(readFileSync(join(root, "docs/agents/new.md"), "utf8"), "added on main");
  assert.ok(!existsSync(join(root, "docs/agents/gone.md")));
  assert.equal(g(["status", "--porcelain"]).trim(), "", "nothing of main's copy would be committed");
  put("sub/CLAUDE.md", "a nested file the agent made");
  assert.match(g(["status", "--porcelain"]), /sub\//, "only the root CLAUDE.md is hidden");
    harness.overlay("implement", { git, root });   // twice is fine
  assert.throws(() => harness.overlay("staging", { git, root }), /main has no e2e\/support/);
  assert.throws(() => harness.overlay("nope", { git, root }), /unknown role/);
});

test("every pipe command is reachable: a one-word command is keyed with its trailing space (`pipe next` was unreachable on 13 Oct)", () => {
  const main = readFileSync(new URL("../bin/pipe.mjs", import.meta.url), "utf8");
  const src = main.slice(main.indexOf("const commands = {")) + pipeSources().slice(main.length);   // and the command modules (commands/*.mjs)
  const keys = [...src.matchAll(/^ {2,4}"([^"]+)":/gm)].map((m) => m[1]);
  assert.ok(keys.length > 40);
  for (const k of keys) assert.match(k, /^[a-z-]+ ([a-z-]+)?$/, `"${k}" can never be looked up as "<command> <sub>"`);
  assert.ok(keys.includes("next "));
});

test("every flag a command reads with a value is declared as one (a bare --result made `uat` a positional)", () => {
  const src = pipeSources();
  const declared = new Set([...src.match(/VALUE_FLAGS = new Set\(\[([^\]]+)\]/)[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]));
  const read = new Set([...src.matchAll(/\bflag\("([a-z-]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...read].filter((f) => !declared.has(f)), [], "add these to VALUE_FLAGS in pipe.mjs");
});

test("every gate.X, facts.X and journey.X the commands call exists (a moved landedOf once let every blocked story start, 28 Oct)", async () => {
  const mods = { gate: await import("../src/gate.mjs"), facts: await import("../src/facts.mjs"), journey: await import("../src/journey.mjs"), start: await import("../src/start.mjs") };
  const files = ["../bin/pipe.mjs", ...readdirSync(new URL("../bin/commands/", import.meta.url)).map((f) => `../bin/commands/${f}`)];
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const [, mod, name] of src.matchAll(/\b(gate|facts|journey|start)\.([A-Za-z_]\w*)\b(?!["'`])/g)) {
      if (["mjs", "yml", "json", "md"].includes(name) || !new RegExp(`import \\* as ${mod} from`).test(src)) continue;   // a file name; a local variable of the same name
      assert.ok(name in mods[mod], `${f}: ${mod}.${name} is not exported by ${mod}.mjs`);
    }
  }
});

const pipelineSkill = new URL("../../.claude/skills/salesforce-github-ci-pipeline/", import.meta.url);
test("the skill's bootstrap: its own git repo (even inside another), FFLib at this repo's pinned commits once, an existing repo kept and told to use a PR, --fill-only for the org ID", { skip: !existsSync(new URL("assets/template/pipeline", pipelineSkill)) && "the pipeline skill is not vendored here" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, chmodSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const pins = Object.fromEntries([...readFileSync(new URL("../../docs/vendor.md", import.meta.url), "utf8").matchAll(/^\| `(fflib-apex-[a-z]+)` \| (\S+) \| `([0-9a-f]{40})` \| (.+?) \|/gm)].map((m) => [m[1], { url: m[2], sha: m[3], dirs: m[4].replace(/`/g, "").split(" ") }]));
  assert.deepEqual(Object.keys(pins).sort(), ["fflib-apex-common", "fflib-apex-mocks"]);
  // a fake git: clone makes the upstream folders, checkout and rev-parse answer as git would; every call is logged
  const bin = mkdtempSync(`${tmpdir()}/boot-bin-`);
  writeFileSync(`${bin}/git`, `#!/usr/bin/env node
const a = process.argv.slice(2), fs = require("fs"), path = require("path");
fs.appendFileSync(process.env.FAKE_GIT_LOG, a.join(" ") + "\\n");
const C = a[0] === "-C" ? a[1] : process.cwd(), rest = a[0] === "-C" ? a.slice(2) : a;
if (rest[0] === "init") { fs.mkdirSync(path.join(C, ".git"), { recursive: true }); fs.writeFileSync(path.join(C, ".git/HEAD_NAME"), "main"); process.exit(0); }
if (rest[0] === "rev-parse" && rest[1] === "--abbrev-ref") { const f = path.join(C, ".git/HEAD_NAME"); console.log(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "main"); process.exit(0); }
if (rest[0] === "remote" && rest[1] === "get-url") { const f = path.join(C, ".git/ORIGIN"); if (!fs.existsSync(f)) process.exit(2); console.log(fs.readFileSync(f, "utf8")); process.exit(0); }
if (rest[0] === "rev-parse" && rest[1] === "--show-toplevel") { let d = C; while (!fs.existsSync(path.join(d, ".git"))) { if (d === "/") process.exit(128); d = path.dirname(d); } console.log(d); process.exit(0); }
if (rest[0] === "rev-parse" && rest[1] === "--is-inside-work-tree") { let d = C; while (!fs.existsSync(path.join(d, ".git"))) { if (d === "/") process.exit(128); d = path.dirname(d); } console.log("true"); process.exit(0); }
if (rest[0] === "clone") { const dest = rest.at(-1); for (const d of JSON.parse(process.env.FAKE_DIRS)) { fs.mkdirSync(path.join(dest, d), { recursive: true }); fs.writeFileSync(path.join(dest, d, "x.cls"), "x"); } fs.writeFileSync(path.join(dest, ".url"), rest.at(-2)); process.exit(0); }
if (rest[0] === "checkout") { fs.writeFileSync(path.join(C, ".sha"), rest.at(-1)); process.exit(0); }
if (rest[0] === "rev-parse" && rest[1] === "HEAD") { console.log(fs.readFileSync(path.join(C, ".sha"), "utf8")); process.exit(0); }
process.exit(0);
`);
  chmodSync(`${bin}/git`, 0o755);
  let n = 0;
  const run = (target, ...flags) => {
    const log = `${bin}/log-${++n}`;
    writeFileSync(log, "");
    const r = spawnSync("bash", [new URL("scripts/bootstrap.sh", pipelineSkill).pathname, target, "--owner", "Acme-Co", "--project", "acme-sf", "--no-test", ...flags], { encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GIT_LOG: log, FAKE_DIRS: JSON.stringify(Object.values(pins).flatMap((p) => p.dirs)) } });
    return { ...r, out: r.stdout + r.stderr, log: readFileSync(log, "utf8") };
  };
  const { realpathSync } = await import("node:fs");
  const t = realpathSync(mkdtempSync(`${tmpdir()}/boot-`));   // bootstrap works on the real path (macOS: /var is /private/var)
  // a new directory: a git repository on main, FFLib at this repo's commits, the first push to main
  const r = run(`${t}/acme-sf`);
  assert.equal(r.status, 0, r.out);
  assert.match(r.log, new RegExp(`-C ${t}/acme-sf init -q -b main`), "a new directory becomes a git repository (vendor.sh and the first push need one)");
  const vendor = readFileSync(`${t}/acme-sf/docs/vendor.md`, "utf8");
  for (const [name, p] of Object.entries(pins)) {
    assert.match(r.log, new RegExp(`checkout -q ${p.sha}`), `${name} at this repo's commit`);
    assert.ok(vendor.includes(`| \`${name}\` | ${p.url} | \`${p.sha}\` |`), `${name}'s row in the new repo's docs/vendor.md`);
    for (const d of p.dirs) assert.ok(existsSync(`${t}/acme-sf/force-app/vendor/${name}/${d.split("/").pop()}/x.cls`), `${name}/${d}`);
  }
  assert.match(r.stdout, /PROD_TEST_LEVEL=RunLocalTests/, "says why production validation needs RunLocalTests with FFLib vendored");
  assert.doesNotMatch(r.stdout, /\d\d\.\d\d%/, "no coverage figure that goes stale: it says how to check");
  assert.match(r.stdout, /git push -u origin main/, "a new repository: the first push goes straight to main");
  // run again: FFLib is already at the pinned commits, nothing is cloned
  const again = run(`${t}/acme-sf`);
  assert.equal(again.status, 0, again.out);
  assert.doesNotMatch(again.log, /\bclone\b/, "a re-run does not clone FFLib again");
  assert.match(again.out, /FFLib already vendored at the pinned commits/);
  // a directory inside another repository: its own repository, and FFLib lands in it, never in the parent
  mkdirSync(`${t}/parent/.git`, { recursive: true });
  const nested = run(`${t}/parent/acme-sf`);
  assert.equal(nested.status, 0, nested.out);
  assert.match(nested.log, new RegExp(`-C ${t}/parent/acme-sf init -q -b main`), "inside a parent repository it still makes its own");
  assert.ok(existsSync(`${t}/parent/acme-sf/force-app/vendor/fflib-apex-common`) && !existsSync(`${t}/parent/force-app`), "FFLib lands in the new repo, not the parent");
  // an existing Salesforce DX repository on another branch, with FFLib of its own: kept, no duplicate classes
  const ex = `${t}/existing`;
  mkdirSync(`${ex}/.git`, { recursive: true }); writeFileSync(`${ex}/.git/HEAD_NAME`, "master"); writeFileSync(`${ex}/.git/ORIGIN`, "https://github.com/acme/existing.git");
  mkdirSync(`${ex}/force-app/main/default/classes`, { recursive: true });
  writeFileSync(`${ex}/force-app/main/default/classes/fflib_SObjectDomain.cls`, "public class fflib_SObjectDomain {}");
  const existing = run(ex);
  assert.equal(existing.status, 0, existing.out);
  assert.doesNotMatch(existing.log, /\binit\b|\bclone\b/, "an existing repository: no git init, no FFLib clone");
  assert.match(existing.out, /FFLib is already in force-app .*fflib_SObjectDomain\.cls.*not vendored/);
  assert.ok(existsSync(`${ex}/force-app/main/default/classes/fflib_SObjectDomain.cls`));
  assert.match(existing.out, /existing repository.*branch master/i);
  assert.match(existing.out, /git switch -c pipeline-setup/, "an existing repository: the change goes through a PR, never a push to its default branch");
  assert.match(existing.out, /ships from main.*rename/i, "a default branch other than main is named, with how to rename it");
  // --org --fill-only: production's org ID into the pushed repo, nothing copied over it
  writeFileSync(`${t}/acme-sf/CLAUDE.md`, readFileSync(`${t}/acme-sf/CLAUDE.md`, "utf8") + "\nProject rule kept.\n");
  const fill = run(`${t}/acme-sf`, "--org", "00D000000000001AAA", "--fill-only");
  assert.equal(fill.status, 0, fill.out);
  assert.match(readFileSync(`${t}/acme-sf/config/scratch-dev.json`, "utf8"), /00D000000000001AAA/);
  assert.match(readFileSync(`${t}/acme-sf/CLAUDE.md`, "utf8"), /Project rule kept/, "the template is not copied again");
  assert.doesNotMatch(fill.out, /^wrote /m);
  assert.equal(fill.log, "", "fill-only touches no git and no FFLib");
  // --no-fflib
  mkdirSync(`${t}/bare`);
  const skip = run(`${t}/bare`, "--no-fflib");
  assert.equal(skip.status, 0, skip.out);
  assert.ok(!existsSync(`${t}/bare/force-app/vendor`), "--no-fflib vendors nothing");
});

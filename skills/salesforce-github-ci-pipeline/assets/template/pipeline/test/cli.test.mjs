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

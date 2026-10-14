// Pipeline tests: release (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
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


test("close-out of sprint 2026-w41: ship #1 and #3, carry #2, close hotfix #8, ignore pipeline PRs", () => {
  const p = plan({
    releases: [{ sprint: "2026-w41", inMain: true }],
    mergedIntoRelease: { "2026-w41": ["issue-1-add-account-tier-field-with-validation", "issue-3-show-open-case-count-on-account"] },
    sprintStories: { "2026-w41": [{ key: "1", state: "OPEN" }, { key: "2", state: "OPEN" }, { key: "3", state: "OPEN" }] },
    mergedIntoMain: [
      { number: 6, headRefName: "release/2026-w41" },
      { number: 12, headRefName: "issue-8-hotfix-account-layout-references-a-quick" },
      { number: 7, headRefName: "chore/staging-lane-and-test-log" },
    ],
  });
  assert.equal(p.sprint, "2026-w41");
  assert.deepEqual(p.ship, ["1", "3"]);
  assert.deepEqual(p.carry, ["2"]);
  assert.deepEqual(p.hotfix, [{ key: "8", pr: 12 }]);
  assert.deepEqual(p.deleteOrgs, ["story:1", "story:3", "sprint:2026-w41", "uat:2026-w41", "story:8"]);
  assert.equal(p.deleteBranch, "release/2026-w41");
});

test("close-out with no sprint in main is a hotfix-only release", () => {
  const p = plan({ releases: [{ sprint: "2026-w42", inMain: false }], mergedIntoMain: [{ number: 30, headRefName: "issue-20" }] });
  assert.equal(p.sprint, null);
  assert.deepEqual(p.hotfix, [{ key: "20", pr: 30 }]);
  assert.equal(p.deleteBranch, null);
});

test("release plan: an already-shipped SHA is a no-op; the gate's validation is used only for the exact tree it checked", () => {
  const f = { sha: SHA, onMain: true, tree: TREE, previous: "v2026.10.04-8" };
  assert.deepEqual(shipping.releasePlan({ ...f, shippedIn: ["v2026.10.05-9", "v2026.10.05-12"] }).tag, "v2026.10.05-9");
  assert.equal(shipping.releasePlan({ ...f, shippedIn: ["v2026.10.05-9"] }).action, "skip");
  const quick = shipping.releasePlan({ ...f, validated: { job: "0AfX", tree: TREE } });
  assert.deepEqual([quick.action, quick.job, quick.previous], ["quick", "0AfX", "v2026.10.04-8"]);
  const moved = shipping.releasePlan({ ...f, validated: { job: "0AfX", tree: "other" } });
  assert.deepEqual([moved.action, moved.job], ["validate", undefined]);
  assert.match(moved.why, /not the one the gate validated/);
  assert.match(shipping.releasePlan(f).why, /no gate validation/);
  assert.throws(() => shipping.releasePlan({ ...f, onMain: false }), /only main ships/);
});

test("release facts: the SHA, whether a release contains it, and the release before it (before its own tag on a re-run)", () => {
  const git = (args) => {
    const a = args.join(" ");
    if (a.startsWith("fetch")) return "";
    if (a === "rev-parse origin/main") return SHA;
    if (a === `rev-parse ${SHA}^{tree}`) return TREE;
    if (a.startsWith("rev-parse")) return args[1];
    if (a.startsWith("merge-base")) return "";
    if (a.startsWith("tag --contains")) return "v2026.10.05-9";
    if (a.startsWith("describe")) return args.at(-1) === "v2026.10.05-9^" ? "v2026.10.04-8" : "v2026.10.05-9";
    throw new Error(a);
  };
  const f = shipping.gatherRelease(git, {});
  assert.deepEqual([f.sha, f.onMain, f.shippedIn, f.previous], [SHA, true, ["v2026.10.05-9"], "v2026.10.04-8"]);
});

test("the gate's candidate is the base's tip now plus the decided head, and refuses a head that moved", () => {
  const calls = [];
  const git = (head) => (args) => {
    calls.push(args.slice(2).join(" "));
    const a = args.slice(2).join(" ");
    if (a === "rev-parse refs/remotes/origin/pr-7") return head;
    if (a === "rev-parse refs/remotes/origin/main") return "b".repeat(40);
    if (a === "rev-parse HEAD^{tree}") return TREE;
    if (a.startsWith("describe")) return "v2026.10.04-8";
    return "";
  };
  const c = shipping.buildCandidate(git(SHA), { pr: 7, base: "main", head: SHA, dir: "candidate" });
  assert.deepEqual([c.base, c.tree, c.since], ["b".repeat(40), TREE, "v2026.10.04-8"]);
  assert.ok(calls.some((x) => /merge -q --no-ff --no-edit a{40}/.test(x)), "merges the decided head");
  assert.throws(() => shipping.buildCandidate(git("c".repeat(40)), { pr: 7, base: "main", head: SHA, dir: "candidate" }), /moved to ccccccc/);
});

test("release watchdog: ships what never shipped; never re-ships after a rollback or loops on a failed release", () => {
  const f = { mainSha: SHA, previous: "v2026.10.04-8", forceAppChanged: true, releaseActive: false };
  assert.equal(shipping.watchdog(f).action, "release");
  assert.equal(shipping.watchdog({ ...f, forceAppChanged: false }).action, "none");
  assert.equal(shipping.watchdog({ ...f, releaseActive: true }).action, "none");
  assert.equal(shipping.watchdog({ ...f, previous: null }).action, "none");
  assert.equal(shipping.watchdog({ ...f, rolledBack: true }).action, "report");
  assert.equal(shipping.watchdog({ ...f, lastRun: { sha: SHA, conclusion: "failure" } }).action, "report");
  assert.equal(shipping.watchdog({ ...f, lastRun: { sha: "b".repeat(40), conclusion: "failure" } }).action, "release");
});

test("a production validation that cannot start says why", () => {
  const io = { sf: () => { throw new Error("INVALID_SESSION_ID: expired"); } };
  assert.throws(() => production.validate(io, { source: [], sleep: () => {} }), /RunRelevantTests: INVALID_SESSION_ID: expired \| all: INVALID_SESSION_ID/);
});

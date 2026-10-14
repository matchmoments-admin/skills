// Pipeline tests: journey (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
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

test("Actions minutes: a job that has nothing to do never starts a runner (GitHub bills each job as at least a minute)", () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  const ci = wf("ci");
  // static decides what changed before the PR's code runs; the org job and the code analyzer only on Salesforce changes
  assert.ok(ci.indexOf("id: what") < ci.indexOf("npm ci --no-audit"), "decided before any of the PR's code runs");
  assert.match(ci, /needs\.static\.outputs\.org == 'true' \|\| \(github\.event_name == 'workflow_dispatch' &&\n\s+needs\.static\.outputs\.kind != 'release' && needs\.static\.outputs\.kind != 'backmerge'\)/, "a hand-started release or back-merge CI never deploys again");
  assert.match(ci, /Code analyzer \(PMD and ESLint\)\n\s+if: steps\.what\.outputs\.sf == 'true'/);
  assert.match(ci, /needs\.apex\.result == 'skipped'/, "the nudge runs when the org job was skipped");
  assert.match(ci, /needs\.static\.outputs\.ui == 'false'/, "UI test not needed, posted by the nudge");
  assert.match(ci, /needs\.static\.outputs\.kind == 'story'/, "autofix filtered before a runner starts");
  assert.doesNotMatch(ci, /pull_request\.labels\.\*\.name, 'blocked'/, "blocked is read live: the payload is older than a person's push");
  // nothing reviewable: the routing job says so; the review and verdict jobs never start
  assert.match(wf("ai-review"), /pipe\.mjs start review --pr/, "the route decides (start.decide); the review job never starts for nothing");
  assert.match(wf("story-pr"), /github\.event\.sender\.type != 'Bot'/);
  assert.equal(gate.checkPassed("skipped"), true, "a skipped org job passes the gate, as it passes GitHub's rules");
  // sprint-start read "skipped" as not green, so no sprint could start after a pipeline-only commit on main
  assert.match(wf("sprint-start"), /grep -q '\^green=true' "\$GITHUB_OUTPUT"/);
  assert.doesNotMatch(wf("sprint-start"), /grep -qv ": success"/);
  assert.equal(gate.checkPassed("failure"), false);
});

test("cost wiring: no duplicate full run on release PRs, the fixer only for code failures, renudge only on the main lock", () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  assert.equal(start.ciPlan({ ref: "release/2026-w47", base: "main", files: ["force-app/a.cls"] }).org, false, "release PRs test in the staging regression");
  assert.equal(start.ciPlan({ ref: "backmerge-9", base: "release/2026-w47", files: ["force-app/a.cls"] }).org, false);
  assert.match(wf("ci"), /needs.apex.outputs.code-failed == 'true'/);
  assert.match(wf("gate"), /needs.decide.outputs.lock == 'main'/);
});

test("a story made from a spec carries the whole spec to every agent; blockers mean merged, and are checked at Start", () => {
  const sc = plans.planContext([{ author: "app/pipeline", body: `${specs.SPEC_MARK}\n### Spec\n\n### Decisions\n- No new fields`, created: "1" }, { author: "pm", body: "3. calendar year", created: "2" }], { mark: specs.SPEC_MARK, title: specs.SPEC_TITLE });
  const md = plans.specSection("125", sc);
  assert.match(md, /## The spec \(#125\): this story builds all of it/);
  assert.match(md, /- No new fields/);
  assert.match(md, /- \*\*pm:\*\* 3\. calendar year/);
  const src = readFileSync(new URL("../bin/pipe.mjs", import.meta.url), "utf8");
  assert.match(src, /Part of spec #\(\\d\+\)/, "pipe tracker story adds the spec");

  assert.deepEqual(gate.blockersOf("Blocked by #12, #14 and #3.\nBlocked by #12"), [12, 14, 3]);
  const gh = (state, merged) => (a) => (a[0] === "issue" ? { state } : a[0] === "pr" ? (merged ? [{ headRefName: merged }] : []) : null);
  assert.equal(gate.landedOf(12, gh("OPEN", false)), false, "started (in-sprint) is not landed");
  assert.equal(gate.landedOf(12, gh("OPEN", "issue-12")), true, "its story PR merged");
  assert.equal(gate.landedOf(12, gh("OPEN", "issue-12-region-field")), true, "an older issue-N-slug branch counts too");
  assert.equal(gate.landedOf(12, gh("OPEN", "issue-123")), false, "issue-123 is not issue-12");
  assert.equal(gate.landedOf(12, gh("CLOSED", false)), true);
  assert.match(gate.blockedMessage([12]), /blocked by #12, which has not merged yet\. Nothing was created/);
  const wf = readFileSync(new URL("../../.github/workflows/issue-start.yml", import.meta.url), "utf8");
  assert.match(wf, /start:\n\s+needs: blockers\n\s+if: needs\.blockers\.outputs\.ok == 'true'/);
});

test("round 1: a person's push re-runs the review and resets the fix rounds; the round limit says what to do, once", () => {
  const rv = readFileSync(new URL("../../.github/workflows/ai-review.yml", import.meta.url), "utf8");
  assert.match(rv, /types: \[opened, ready_for_review, labeled, synchronize\]/);
  assert.match(rv, /github\.event\.action != 'synchronize' \|\| github\.event\.sender\.type != 'Bot'/);
  assert.match(rv, /start review --pr "\$\{\{ github\.event\.pull_request\.number \}\}" \$PUSH/, "a push passes before and after: the route sees what this push changed");
  assert.equal(start.decide("review", { ai: { review: true }, branch: "issue-1", pushed: ["e2e/story-1.spec.ts"] }).run, false, "a spec-only push: no review");
  assert.match(start.decide("fix", { ai: { fix: true }, branch: "issue-1", labels: ["blocked"] }).why, /blocked: a person is on it/);
  assert.match(start.stopMessage(2), /\*\*What you can do:\*\* push a fix yourself/);
  const fx = readFileSync(new URL("../../.github/workflows/ai-fix.yml", import.meta.url), "utf8");
  assert.match(fx, /if: failure\(\) && env\.STORY_KEY != ''/);
  const isBot = (l) => /\[bot\]$/.test(l) || l === "__owner__-pipeline";
  const commits = [{ committedDate: "2026-10-08T10:55:01Z", authors: [{ login: "" }, { login: "claude" }] },
    { committedDate: "2026-10-08T11:45:04Z", authors: [{ login: "github-actions[bot]" }, { login: "claude" }] }];
  assert.equal(verdict.lastHumanPush(commits, (l) => l !== "claude" && !isBot(l)), "2026-10-08T10:55:01Z", "an AI commit co-authored by Claude is not a person's push");
  const runs = [{ id: 1, display_title: "ai-fix PR #9", status: "completed", conclusion: "success", created_at: "2026-10-08T10:00:00Z" },
    { id: 2, display_title: "ai-fix PR #9", status: "completed", conclusion: "success", created_at: "2026-10-08T11:00:00Z" }];
  assert.equal(verdict.fixRunsFor(runs, 9, 0, () => true, "2026-10-08T10:55:01Z"), 1, "rounds count again from a person's push");
});

test("start decisions: a job that has nothing to do is decided before a runner starts, in main's code", async () => {
  const on = { review: true, fix: true, uiTest: true };
  // review
  assert.deepEqual(start.decide("review", { ai: {}, branch: "issue-1" }).off, "AI_REVIEW");
  assert.equal(start.decide("review", { ai: on, branch: "release/2026-w47" }).run, false);
  assert.equal(start.decide("review", { ai: on, branch: "backmerge-7" }).run, false);
  const nothing = start.decide("review", { ai: on, branch: "issue-1", changed: [".github/workflows/ci.yml", "docs/x.md"] });
  assert.deepEqual([nothing.run, nothing.status?.description], [false, "not needed: no Salesforce source or specs changed"]);
  assert.equal(start.decide("review", { ai: on, branch: "issue-1", changed: Array(300).fill("docs/x.md") }).run, true, "300 files is the compare limit: always reviewed");
  assert.equal(start.decide("review", { ai: on, branch: "issue-1", changed: null }).run, true, "unknown: reviewed");
  assert.equal(start.decide("review", { ai: on, branch: "issue-1", changed: ["force-app/a.cls"], pushed: ["force-app/a.cls", "e2e/s.spec.ts"] }).run, true);
  // fix
  assert.equal(start.decide("fix", { ai: on, branch: "fix/x" }).run, false, "story PRs only");
  const over = start.decide("fix", { ai: on, branch: "issue-1", rounds: { n: 2, limit: 2 } });
  assert.deepEqual([over.run, over.stop], [false, true]);
  assert.equal(start.decide("fix", { ai: on, branch: "issue-1", rounds: { n: 1, limit: 2 } }).run, true);
  // ui-test
  assert.equal(start.decide("ui-test", { ai: {}, branch: "issue-1", mode: "ai" }).off, "AI_UI_TEST");
  const none = start.decide("ui-test", { ai: on, branch: "issue-12", mode: "run", hasSpec: false });
  assert.deepEqual([none.run, none.status.state, none.status.description], [false, "failure", "no spec e2e/story-12.spec.ts committed"]);
  assert.equal(start.decide("ui-test", { ai: on, branch: "issue-12", mode: "run", hasSpec: true }).run, true);
  // branch kinds and CI's plan (a diff that failed assumes everything)
  assert.deepEqual(["issue-4", "LIFE-12", "release/2026-w47", "backmerge-9", "fix/gate"].map(start.branchKind), ["story", "story", "release", "backmerge", "maintenance"]);
  assert.deepEqual(start.ciPlan({ ref: "issue-4", base: "release/2026-w47", files: ["force-app/main/default/layouts/A.layout-meta.xml"] }), { kind: "story", sf: true, org: true, ui: true, target: "issue-4", all: false, carried: "" });
  assert.deepEqual(start.ciPlan({ ref: "backmerge-9", base: "release/2026-w47", files: [] }), { kind: "backmerge", sf: false, org: false, ui: false, target: "sprint:2026-w47", all: true, carried: "" });
  assert.equal(start.ciPlan({ ref: "issue-4", base: "main", files: null }).ui, true, "fails closed");
  // the job starter acts on the decision: dispatch, or post the verdict and say why
  const did = [];
  const host = { repo: "o/r", runUrl: "u", dispatch: (...a) => did.push(["dispatch", ...a]), status: (...a) => did.push(["status", ...a]),
    api: (m, path) => (path.includes("/compare/") ? { files: [{ filename: "docs/readme.md" }] } : {}), workflowRuns: () => [] };
  const gh = (a) => { did.push(a.slice(0, 3).join(" ")); return a[0] === "pr" && a[1] === "view" ? { headRefName: "issue-5", baseRefName: "release/w", headRefOid: "h5", labels: [], state: "OPEN", commits: [] } : null; };
  const cards = { refreshPr: async () => did.push("card"), refresh: async () => did.push("card") };
  const d = await start.startJob("review", 5, { host, gh, cards, ai: on });
  assert.equal(d.run, false);
  assert.ok(did.some((x) => Array.isArray(x) && x[0] === "status" && x[1] === "h5" && x[3] === "success"), "posts not needed on the head");
  assert.ok(!did.some((x) => Array.isArray(x) && x[0] === "dispatch"), "no review runner");
  did.length = 0;
  await start.startJob("fix", 5, { host, gh, cards, ai: on });
  assert.deepEqual(did.find((x) => Array.isArray(x) && x[0] === "dispatch"), ["dispatch", "ai-fix.yml", { pr: 5 }]);
  // follow-ups: the same for the gate and an emergency merge
  did.length = 0;
  const removed = [];
  await start.startFollowUps("staging delete-story-org", { pr: 9, base: "release/w", sha: "m1", story: "5" }, { host, gh, cards, removeOrg: (t) => removed.push(t) });
  assert.deepEqual(did.filter(Array.isArray), [["dispatch", "staging-deploy.yml", {}, "release/w"]]);
  assert.deepEqual(removed, ["story:5"]);
  assert.ok(did.includes("issue edit 5"), "in-sprint label (the emergency path used to miss it)");
  did.length = 0;
  await start.startFollowUps("release", { pr: 9, sha: "m1", job: "0Af1", tree: "t1" }, { host, gh, cards, removeOrg: () => {} });
  assert.deepEqual(did.filter(Array.isArray), [["dispatch", "release.yml", { sha: "m1", validated_job: "0Af1", validated_tree: "t1" }]]);
});

test("Standing's carry rules are one table: specs-only, exact head, and no-force-app for CI's Salesforce tests", () => {
  assert.equal(gate.carries("specs", "a", "h", ["e2e/s.spec.ts"]), true);
  assert.equal(gate.carries("specs", "a", "h", ["force-app/x"]), false);
  assert.equal(gate.carries("exact", "a", "h", ["e2e/s.spec.ts"]), false, "the UI test and UAT need the exact head");
  assert.equal(gate.carries("no-sf", "a", "h", ["e2e/s.spec.ts", "docs/x.md"]), true, "a spec-only push needs no deploy");
  assert.equal(gate.carries("no-sf", "a", "h", ["force-app/main/default/flows/F.flow-meta.xml"]), false);
  assert.equal(gate.carries("no-sf", "a", "h", null), false, "an unknown diff never carries");
  assert.equal(gate.carries("no-sf", "a", "h", [".github/workflows/ci.yml"]), false, "a pass under the branch's own workflows is no pass (forgeable)");
  const changed = { c3: ["e2e/s.spec.ts"], c2: ["e2e/s.spec.ts", "force-app/x"], c1: ["force-app/x"] };
  assert.equal(gate.carriedFrom("no-sf", { head: "h", passed: ["c3", "c1"], changedSince: (s) => changed[s] }), "c3");
  assert.equal(gate.carriedFrom("no-sf", { head: "h", passed: ["c2", "c1"], changedSince: (s) => changed[s] }), null);
  // CI's plan: no org job when the Salesforce tests carry (story #193 deployed five times, three for spec-only pushes)
  const p = start.ciPlan({ ref: "issue-4", base: "release/w1", files: ["force-app/x", "e2e/story-4.spec.ts"], carried: "c3" });
  assert.deepEqual([p.sf, p.org, p.carried], [true, false, "c3"]);
  // ciCarry reads the branch's commits and their checks through git and the host
  const git = (a) => (a[0] === "rev-list" ? "c3\nc2" : a[0] === "rev-parse" ? "h" : a[0] === "diff" ? (a[2] === "c3" ? "e2e/s.spec.ts" : "force-app/x") : null);
  const host = { repo: "o/r", api: (m, path) => ({ check_runs: path.includes("/c3/") || path.includes("/c2/") ? [{ conclusion: "success", started_at: "1" }] : [] }) };
  assert.equal(start.ciCarry({ ref: "issue-4", base: "release/w1", git, host }), "c3");
  const rerunFailed = { repo: "o/r", api: () => ({ check_runs: [{ conclusion: "success", started_at: "1" }, { conclusion: "failure", started_at: "2" }] }) };
  assert.equal(start.ciCarry({ ref: "issue-4", base: "release/w1", git, host: rerunFailed }), null, "the newest run on that commit is the truth");
  assert.equal(start.ciCarry({ ref: "release/2026-w1", base: "main", git, host }), null, "release PRs test in staging");
  const wf = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(wf, /checks: read +# "What changed\?" only/);
  assert.match(wf, /org advance "\$\{\{ steps.org.outputs.alias \}\}" --sha "\$SHA"/, "the story org holds the tested commit: no second deploy by the UI test");
});

test("start decisions read Standing: a review or Claude's UI test that still stands is not started again unless a person asks (E13, E14)", () => {
  const on = { review: true, uiTest: true, fix: true };
  const passed = { state: "success", sha: "abc1234" };
  assert.equal(start.decide("review", { ai: on, branch: "issue-1", review: passed }).run, false);
  assert.match(start.decide("review", { ai: on, branch: "issue-1", review: { state: "failure", sha: "abc" } }).why, /still stands \(asked for changes/);
  assert.equal(start.decide("review", { ai: on, branch: "issue-1", review: passed, explicit: true }).run, true, "the card's Run the AI review again");
  assert.equal(start.decide("review", { ai: on, branch: "issue-1", review: { state: "stale" } }).run, true);
  assert.equal(start.decide("ui-test", { ai: on, branch: "issue-1", mode: "ai", ui: passed }).run, false);
  assert.equal(start.decide("ui-test", { ai: on, branch: "issue-1", mode: "ai", ui: { state: "pending" } }).run, false, "one is running");
  assert.equal(start.decide("ui-test", { ai: on, branch: "issue-1", mode: "ai", ui: passed, explicit: true }).run, true);
  assert.equal(start.decide("ui-test", { ai: on, branch: "issue-1", mode: "run", hasSpec: true, ui: passed }).run, true, "running the committed spec is always a person's ask");
  for (const f of ["ai-review", "ui-test"]) assert.match(readFileSync(new URL(`../../.github/workflows/${f}.yml`, import.meta.url), "utf8"), /--explicit/);
  // starting Claude's UI test marks it running on the head, so a second writer is not started meanwhile
  const posted = [];
  const host = { repo: "o/r", api: () => ({}), dispatch: () => {}, status: (...a) => posted.push(a), prFacts: () => ({ pr: { headRefName: "issue-1", baseRefName: "release/w1", headRefOid: "h" }, statuses: [], reviews: [], checkRuns: [] }) };
  const gh = () => ({ state: "OPEN", labels: [], headRefName: "issue-1", baseRefName: "release/w1", headRefOid: "h" });
  return start.startJob("ui-test", 1, { host, gh, ai: on, mode: "ai" }).then((d) => {
    assert.equal(d.run, true);
    assert.deepEqual(posted[0].slice(0, 3), ["h", "pipeline/ui-test", "pending"]);
  });
});

test("the journey decides what starts next from Standing: after a review, after staging, when the release PR opens or a slot frees (E14, E15)", () => {
  const ai = { autoChain: true, fix: true, uiTest: true };
  assert.deepEqual(journey.nextSteps("review", st_({ review: { state: "failure" } }), { ai }).map((x) => x.start), ["fix"]);
  assert.deepEqual(journey.nextSteps("review", st_({ review: { state: "success" } }), { ai, uiNeeded: true }).map((x) => [x.start, x.mode]), [["ui-test", "ai"]]);
  assert.deepEqual(journey.nextSteps("review", st_({ review: { state: "success" }, ui: { state: "success" } }), { ai }), [], "a UI test that passed on this commit stands");
  assert.deepEqual(journey.nextSteps("review", st_({ review: { state: "success" } }), { ai, uiNeeded: false }), []);
  const pushed = (m) => st_({ review: { state: "success" }, ctx: { pr: { commits: [{ messageHeadline: "feat: x" }, { messageHeadline: m }] } } });
  for (const after of ["ci", "review"]) {
    assert.deepEqual(journey.nextSteps(after, pushed("test(e2e): story 241"), { ai }), [], `${after}: the UI test that pushed the spec reports on it (#242 ran 4)`);
    assert.equal(journey.nextSteps(after, pushed("fix: y"), { ai }).length, 1, `${after}: a person's push still needs the UI test`);
  }
  assert.deepEqual(journey.nextSteps("review", st_({ review: { state: "failure" } }), { ai: { ...ai, autoChain: false } }), []);
  assert.deepEqual(journey.nextSteps("review", st_({ route: "release", review: { state: "failure" } }), { ai }), []);
  const rel = (staging, uat) => st_({ route: "release", checks: { [names.CHECKS.staging]: { state: staging } }, uat: { state: uat } });
  for (const after of ["staging", "release-pr", "org-freed"]) {
    assert.deepEqual(journey.nextSteps(after, rel("passed", "missing"), { uat: true, pr: 197 }).map((x) => [x.dispatch, x.inputs]), [["uat-deploy.yml", { pr: "197" }]], after);
  }
  assert.deepEqual(journey.nextSteps("staging", rel("passed", "stale"), { uat: true, pr: 1 }).length, 1, "a newer head needs UAT again");
  assert.deepEqual(journey.nextSteps("staging", rel("passed", "pending"), { uat: true, pr: 1 }), [], "UAT already has this commit");
  assert.deepEqual(journey.nextSteps("release-pr", rel("running", "missing"), { uat: true, pr: 1 }).map((x) => x.inputs), [{ pr: "1", warm: "true" }], "staging's end starts UAT; its org is built meanwhile");
  assert.deepEqual(journey.nextSteps("staging", rel("running", "missing"), { uat: true, pr: 1 }), [], "only the release PR opening warms UAT");
  assert.deepEqual(journey.nextSteps("staging", rel("passed", "missing"), { uat: false, pr: 1 }), []);
  assert.throws(() => journey.nextSteps("lunch", st_()), /unknown stage/);
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  assert.match(wf("ai-review"), /pipe.mjs next --after review --pr "\$PR"/);
  assert.doesNotMatch(wf("ai-review"), /gate ui-needed|label=ai:test/, "no chain decided in shell");
  assert.match(wf("release-cut"), /pipe.mjs next --after release-pr/);
  assert.doesNotMatch(wf("release-cut") + wf("staging-deploy"), /gh workflow run uat-deploy/, "UAT is started only by the journey");
  assert.match(wf("gate"), /types: \[labeled, ready_for_review, converted_to_draft\]/, "a draft never keeps an earlier success (E12)");
});

test("journey.next finds the open release PR when none is named, and acts through the start decision or a dispatch", async () => {
  const did = [];
  const facts = { pr: { state: "OPEN", headRefName: "release/2026-w1", baseRefName: "main", headRefOid: "h" }, checkRuns: [{ name: names.CHECKS.staging, conclusion: "success", started_at: "t" }], statuses: [], reviews: [], compare: { prFiles: ["force-app/x"] } };
  const host = { openRelease: () => "origin/release/2026-w1", prFacts: () => facts, dispatch: (w, i, ref) => did.push([w, i, ref]) };
  const gh = (a) => (a[0] === "pr" && a[1] === "list" ? [{ number: 197 }] : null);
  const r = await journey.next("org-freed", null, { host, gh, ai: {}, uat: true, startJob: async () => {} });
  assert.deepEqual(did, [["staging-deploy.yml", {}, "release/2026-w1"], ["uat-deploy.yml", { pr: "197" }, undefined]], "the UI regression (on the release branch) beside UAT");
  assert.match(r.said, /uat-deploy/);
  const none = await journey.next("staging", null, { host: { openRelease: () => null }, gh, ai: {}, uat: true });
  assert.match(none.said, /no pull request/);
});

test("after a merge: deleting the story org lets UAT try again; a change to the gate's rules re-decides open PRs (E12, E15)", async () => {
  const seen = [];
  await start.startFollowUps("delete-story-org regate", { pr: null, story: "193" }, { host: { dispatch: () => {} }, gh: () => null, cards: { refreshPr: async () => {} },
    removeOrg: () => true, orgFreed: async () => seen.push("org-freed"), regate: () => { seen.push("regate"); return [5]; } });
  assert.deepEqual(seen, ["org-freed", "regate"]);
  const m = { headRefName: "fix/gate", baseRefName: "main" };
  assert.ok(gate.followUps(m, ["pipeline/src/gate.mjs"]).includes("regate"));
  assert.ok(!gate.followUps(m, ["pipeline/src/card.mjs"]).includes("regate"));
  const { regate } = await import("../src/shipping.mjs");
  const out = [];
  const io = { gh: () => [{ number: 5, headRefOid: "a" }, { number: 6, headRefOid: "b" }], ghPages: (p) => (p.includes("/a/") ? [{ context: "pipeline/gate", state: "success", creator: { login: "github-actions[bot]" } }] : [{ context: "pipeline/gate", state: "pending", creator: { login: "github-actions[bot]" } }]) };
  assert.deepEqual(regate(io, { repo: "o/r", dispatch: (w, i) => out.push(i.pr) }), [5]);
  assert.deepEqual(out, [5], "only PRs whose head carries a success the old rules gave");
});

test("no free scratch-org slot: the story waits in line (no runner waits) and the next org deleted starts it, after UAT", async () => {
  const dispatched = [], edited = [];
  const host = { openRelease: () => null, repoDispatch: (t, p) => dispatched.push([t, p]) };
  const gh = (a) => (a[0] === "issue" && a[1] === "list" ? [{ number: 9, createdAt: "2", labels: [] }, { number: 7, createdAt: "1", labels: [{ name: "feature" }, { name: "waiting:org" }] }] : a[0] === "issue" && a[1] === "edit" ? edited.push(a) : null);
  const r = await journey.next("org-freed", null, { host, gh, ai: {}, uat: true });
  assert.deepEqual(dispatched, [["jira-start", { key: "7", labels: "feature" }]], "the one waiting longest");
  assert.ok(edited.some((a) => a.includes("--remove-label") && a.includes("waiting:org")));
  assert.match(r.said, /story #7/);
  const wf = readFileSync(new URL("../../.github/workflows/issue-start.yml", import.meta.url), "utf8");
  assert.match(wf, /steps\.org\.outputs\.waiting == 'true'[\s\S]*--add-label waiting:org/);
  assert.ok(names.LABELS["waiting:org"]);
});

test("#230: Claude's UI test starts only once CI's org job passed on the head; CI's finish starts it when the review passed first", () => {
  const ai = { autoChain: true, fix: true, uiTest: true };
  const running = { checks: { [names.CHECKS.apex]: { state: "running" } } };
  assert.deepEqual(journey.nextSteps("review", st_({ review: { state: "success" }, ...running }), { ai }), [], "CI still holds the story org: no runner waits for it");
  assert.deepEqual(journey.nextSteps("review", st_({ review: { state: "failure" }, ...running }), { ai }).map((x) => x.start), ["fix"], "a fix does not wait");
  assert.deepEqual(journey.nextSteps("ci", st_({ review: { state: "success" } }), { ai }).map((x) => [x.start, x.mode]), [["ui-test", "ai"]], "CI finished after the review");
  assert.deepEqual(journey.nextSteps("ci", st_({ review: { state: "running" } }), { ai }), [], "the review's own finish starts it");
  assert.deepEqual(journey.nextSteps("ci", st_({ review: { state: "success" }, ui: { state: "pending" } }), { ai }), [], "one already running stands");
  assert.deepEqual(journey.nextSteps("ci", st_({ review: { state: "success" }, checks: { [names.CHECKS.apex]: { state: "failed" } } }), { ai }), []);
  assert.deepEqual(journey.nextSteps("ci", st_({ route: "release", review: { state: "success" } }), { ai }), []);
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci.split(/\n  nudge:\n/)[1], /pipe\.mjs next --after ci --pr/);
});

test("the UI regression runs once per release (#273): Apex on every staging run, every UI spec once the release PR is open; UI_REGRESSION=every keeps the old way", () => {
  const plan = (o) => start.stagingPlan(o);
  assert.deepEqual([plan({}).apex, plan({}).ui], ["run", "skip"], "a story merge mid-sprint: Apex and Flow only");
  assert.match(plan({}).why, /once per release, when the release PR opens/);
  assert.deepEqual([plan({ releaseOpen: true }).apex, plan({ releaseOpen: true }).ui], ["run", "run"]);
  assert.deepEqual([plan({ releaseOpen: true, apexPassed: true }).apex, plan({ releaseOpen: true, apexPassed: true }).ui], ["skip", "run"], "the release's UI run on a head staging already tested");
  assert.equal(plan({ releaseOpen: true, apexPassed: true, uiPassed: true }).done, true);
  assert.equal(plan({ policy: "every" }).ui, "run", "the flag turns it back on for every run");
  // the journey starts it when the release PR is open, beside UAT; a pass or a failure on the head stops it
  const rel = (statuses = []) => gate.standing({ pr: { state: "OPEN", headRefName: "release/2026-w1", baseRefName: "main", headRefOid: "h" }, checkRuns: [{ name: names.CHECKS.staging, conclusion: "success", started_at: "t" }], statuses, reviews: [] });
  const ui = (state) => ({ sha: "h", context: gate.STATUS.uiRegression, state, created_at: "t", creator: { login: "github-actions[bot]" } });
  assert.deepEqual(journey.nextSteps("release-pr", rel(), { uat: false, pr: 1 }).map((x) => [x.dispatch, x.ref]), [["staging-deploy.yml", "release/2026-w1"]], "UAT off: still once per release");
  assert.deepEqual(journey.nextSteps("staging", rel([ui("success")]), { uat: false, pr: 1 }), []);
  assert.deepEqual(journey.nextSteps("staging", rel([ui("failure")]), { uat: false, pr: 1 }), [], "a failure is not owed: no loop");
  const running = gate.standing({ pr: { state: "OPEN", headRefName: "release/2026-w1", baseRefName: "main", headRefOid: "h" }, checkRuns: [{ name: names.CHECKS.staging, conclusion: null, status: "in_progress", started_at: "t" }], statuses: [], reviews: [] });
  assert.deepEqual(journey.nextSteps("release-pr", running, { uat: false, pr: 1 }), [], "a staging run going now does it itself");
  // the gate: failed and stale say so
  const f = open(fixture(26)), st = (state, sha = f.pr.headRefOid) => ({ ...ui(state), sha });
  assert.match(gate.evaluate({ ...f, statuses: [st("failure")] }).reasons.join(), /UI regression failed/);
  const older = "0000000000000000000000000000000000000009";
  assert.match(gate.evaluate({ ...f, statuses: [st("success", older)], diffsToHead: { [older]: ["e2e/story-9.spec.ts"] } }).reasons.join(), /older commit/);
  assert.deepEqual(gate.evaluate({ ...f, statuses: [st("success", older)], diffsToHead: { [older]: ["docs/handbook.md"] } }).reasons, [], "a docs-only back-merge carries it");
  // the workflow: the plan decides, the UI step's outcome travels out, and the agent-free nudge job records it
  const wf = readFileSync(new URL("../../.github/workflows/staging-deploy.yml", import.meta.url), "utf8");
  assert.match(wf, /id: uirun\n\s+if: steps\.fresh\.outputs\.ui == 'run'/);
  assert.match(wf, /ui: \$\{\{ steps\.uirun\.outcome \}\}/);
  const nudge = wf.slice(wf.indexOf("  nudge:"));
  assert.match(nudge, /status set pipeline\/ui-regression "\$S" "\$GITHUB_SHA"/);
  assert.ok(nudge.indexOf("pipeline/ui-regression") < nudge.indexOf("next --after staging"), "recorded before the journey asks what is owed");
});

test("the staging plan reads the gate's own Standing for the UI regression, so plan, journey and gate agree (code review, 14 Oct)", () => {
  const ui = (state, extra = {}) => ({ sha: "h", context: gate.STATUS.uiRegression, state, created_at: "t", creator: { login: "github-actions[bot]" }, ...extra });
  const facts = (statuses, headRefOid = "h") => ({ pr: { state: "OPEN", headRefName: "release/2026-w1", baseRefName: "main", headRefOid }, checkRuns: [], statuses, reviews: [] });
  const plan = (f, head = "h") => start.stagingPlanFor({ git: (a) => (a[0] === "rev-parse" ? head : a[0] === "rev-list" ? "" : ""), host: { repo: "o/r", prFacts: () => f, api: () => ({ check_runs: [] }) },
    gh: () => [{ number: 7 }], branch: "release/2026-w1", policy: "release" });
  assert.equal(plan(facts([ui("success")])).ui, "skip", "passed on the release head: done");
  assert.equal(plan(facts([ui("success", { trusted: false })])).ui, "run", "a status a story branch's workflow posted does not count");
  assert.equal(plan(facts([ui("failure")])).ui, "run", "failed: runs again on this run");
  assert.equal(plan(facts([])).ui, "run");
  assert.deepEqual([plan(facts([]), "older").done, plan(facts([]), "older").why], [true, "superseded: the release PR's head moved on; its own run tests it"]);
  const noPr = start.stagingPlanFor({ git: () => "", host: { repo: "o/r", api: () => ({ check_runs: [] }) }, gh: () => [], branch: "release/2026-w1", policy: "release" });
  assert.equal(noPr.ui, "skip", "no release PR yet: not due");
  // the workflow: issues read for the PR's facts; the lane stays held after the UI run; a planned run that never ran fails
  const wf = readFileSync(new URL("../../.github/workflows/staging-deploy.yml", import.meta.url), "utf8");
  assert.match(wf, /issues: read/);
  assert.match(wf, /if: always\(\) && steps\.current\.outputs\.superseded != 'true' && steps\.fresh\.outputs\.ui != 'run'/);
  assert.match(wf, /needs\.staging\.outputs\.ui-planned == 'run'/);
  assert.match(wf, /the UI regression could not run/);
  assert.equal(gate.STAGING_INPUTS.test("pipeline/src/settings.mjs"), true, "the seed and baseline defaults change what staging builds");
});

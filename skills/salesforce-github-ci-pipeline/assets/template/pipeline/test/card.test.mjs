// Pipeline tests: card (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
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

test("story card: before the PR it says how to build; with a PR it tracks each stage and links the approval", () => {
  const base = { key: "2", repoUrl: "https://github.com/o/r", branch: "issue-2", base: "release/2026-w41" };
  const before = storyCard({ ...base, ai: { implement: true } });
  assert.ok(before.startsWith(CARD_MARK));
  assert.match(before, /\*\*Next:\*\* Build it, or tick \*\*Build it with Claude\*\*/);
  assert.match(before, /- \[ \] 🤖 Build it with Claude <!-- act:build -->/);

  const f = { ...open(fixture(23)), ai: {}, statuses: [], reviews: [] };
  const pr = { ...f.pr, title: "Escalate cases" };
  const waiting = storyCard({ ...base, pr, facts: f, decision: gate.evaluate(f) });
  assert.match(waiting, /\*\*Next:\*\* \*\*\[Approve here\]\(https:\/\/github.com\/o\/r\/pull\/\d+\/files\)\*\*: everything else is green/);
  assert.match(waiting, /➖ \| AI review \| off: your approval is the review/);

  const failedReview = { ...f, ai: { review: true, fix: true }, statuses: [{ ...ok(f.pr.headRefOid, gate.STATUS.review), state: "failure" }] };
  assert.match(storyCard({ ...base, ai: failedReview.ai, pr, facts: failedReview, decision: gate.evaluate(failedReview) }), /Address the review comments .*tick \*\*Fix … with Claude\*\*[\s\S]*act:fix[\s\S]*act:review/);

  const shipped = storyCard({ ...base, pr: { ...pr, state: "MERGED" }, facts: f, shipped: { tag: "v1", url: "https://x/v1" } });
  assert.match(shipped, /Done: live in production since \[v1\]/);
  assert.doesNotMatch(shipped, /⬜/);
});

test("story card draws the stages as a coloured flow; trackers without Mermaid get the table only", () => {
  const card = storyCard({ key: "2", repoUrl: "https://github.com/o/r", branch: "issue-2", base: "release/w", ai: {} });
  assert.match(card, /```mermaid\nflowchart LR\n  s0\["✅ Branch \+ org"\]:::done\n  s1\["⬜ Build"\]:::waiting\n  s0 --> s1/);
  assert.match(card, /\| ✅ \| Branch and scratch org/);
});

test("story card says what is running right now, with a link; failures say where to look and how to retry", () => {
  const url = "https://github.com/o/r/actions/runs/1";
  assert.equal(activityLine(null), null);
  assert.equal(activityLine({ state: "running", what: "creating the scratch org", url }), `⏳ **Now:** creating the scratch org · **[watch it live](${url})**`);
  assert.equal(activityLine({ state: "failed", what: "creating the scratch org", url, retry: "comment /start to retry" }), `❌ **Failed:** creating the scratch org · **[see what went wrong](${url})** · comment /start to retry`);
  const first = startingCard({ key: "84", activity: { state: "running", what: "creating the branch", url } });
  assert.match(first, /⏳ \*\*Now:\*\* creating the branch/);
  assert.match(first, /CARD|pipeline:story-card/);
  const card = storyCard({ key: "2", repoUrl: "https://github.com/o/r", branch: "issue-2", base: "release/w", activity: { state: "running", what: "Claude is building the story", url } });
  assert.ok(card.indexOf("Now:") < card.indexOf("Next:"));
});

test("the story card never says everything is green while the gate blocks: its Next names what no row shows (14 Oct review)", () => {
  const f = open(fixture(12));
  for (const [facts, why] of [[{ ...f, pr: { ...f.pr, isDraft: true } }, /Blocked: the PR is a draft/], [{ ...f, pr: { ...f.pr, mergeable: "CONFLICTING" } }, /Blocked: it has merge conflicts/],
    [{ ...f, blockers: [{ number: 41, landed: false }] }, /Blocked: blocked by #41/]]) {
    const decision = gate.evaluate(facts);
    assert.ok(decision.other.length, "a reason no row stands for");
    const md = storyCard({ key: "12", repoUrl: "https://github.com/o/r", branch: facts.pr.headRefName, base: facts.pr.baseRefName, pr: facts.pr, facts, decision });
    assert.match(md, why);
    assert.doesNotMatch(md, /everything else is green/);
  }
  assert.deepEqual(gate.evaluate(f).other, [], "nothing extra on a clean PR");
  // one rule for "does it need a UI test": unknown files count as yes
  assert.equal(names.uiNeeded(null), true);
  assert.equal(names.uiNeeded(["docs/x.md"]), false);
  assert.equal(names.uiNeeded(["force-app/main/default/layouts/A.layout-meta.xml"]), true);
});

test("a light card refresh (the Now line while tests run) reuses the facts: two comment edits, nothing re-gathered", async () => {
  const edits = [];
  let gathered = 0;
  const host = { repoUrl: "https://github.com/o/r", runUrl: "u", openRelease: () => "release/w45", hasApp: () => false,
    storyPr: () => ({ number: 90, state: "OPEN", baseRefName: "release/w45", headRefOid: "h" }),
    prFacts: () => { gathered++; return { pr: { number: 90, state: "OPEN", headRefName: "issue-84", baseRefName: "release/w45", headRefOid: "h" }, checkRuns: [], statuses: [], reviews: [] }; } };
  const t = (who) => ({ comments: async () => [], card: async (k) => edits.push(`${who}:${k}`) });
  const c = storyCards({ host, tracker: t("issue"), prTracker: t("pr") });
  await c.refresh("84");
  await c.refresh("84", { light: true, activity: { state: "running", what: "testing" } });
  await c.refresh("84", { light: true, activity: { state: "running", what: "testing" } });
  assert.equal(gathered, 1);
  assert.deepEqual(edits, ["issue:84", "pr:90", "issue:84", "pr:90", "issue:84", "pr:90"]);
});

test("release card: what ships, each stage, what to do next, and only the boxes that make sense", () => {
  const pr = { number: 110, state: "OPEN", headRefName: "release/2026-w45", baseRefName: "main", headRefOid: "h" };
  const run = (name, conclusion) => ({ name, conclusion, status: "completed", started_at: "2026-10-05T10:00:00Z" });
  const green = [run("static checks (no org)", "success"), run("deploy and Apex tests (scratch org)", "success"), run("staging regression", "success")];
  const st = (state, description = "") => ({ sha: "h", context: gate.STATUS.uat, state, description, created_at: "2026-10-05T11:00:00Z", creator: { login: "github-actions[bot]" } });
  const base = { repoUrl: "https://github.com/o/r", pr, uat: true, stories: [{ key: "106", title: "Sales region" }] };
  const inUat = releaseCard({ ...base, facts: { checkRuns: green, statuses: [st("pending", "In UAT")], reviews: [] } });
  assert.match(inUat, /Release status: sprint 2026-w45/);
  assert.match(inUat, /#106 Sales region/);
  assert.match(inUat, /\*\*Next:\*\* Test it in UAT, then tick \*\*UAT passed\*\*/);
  assert.match(inUat, /- \[ \] ✅ UAT passed.*<!-- act:uat-pass -->/);
  assert.doesNotMatch(inUat, /act:gate/, "not approved yet: nothing to re-check");
  const approved = { checkRuns: green, statuses: [st("success")], reviews: [{ user: { type: "User", login: "lead" }, state: "APPROVED", commit_id: "h", submitted_at: "2026-10-05T12:00:00Z" }] };
  const ready = releaseCard({ ...base, facts: approved, decision: { mergeable: true } });
  assert.match(ready, /Nothing to do: the gate is validating/);
  assert.match(ready, /act:gate/, "approved and green but stuck (a cancelled run): the box re-runs the gate");
  const rejected = releaseCard({ ...base, facts: { ...approved, checkRuns: [...green, run("Production validation", "failure")] } });
  assert.match(rejected, /Production rejected it/);
  const shipped = releaseCard({ ...base, pr: { ...pr, state: "MERGED" }, facts: approved, shipped: { tag: "v1", url: "https://x/v1" } });
  assert.match(shipped, /Done: sprint 2026-w45 is live in production/);
  assert.deepEqual([...shipped.matchAll(/act:([a-z-]+)/g)].map((m) => m[1]), ["sprint"], "shipped: only the next sprint");
  assert.match(rejected, /act:fix-story/);
  assert.match(newStoryCard({ key: "120", ai: { plan: true } }), /act:plan[\s\S]*act:start[\s\S]*act:hotfix/);
});

test("spec wiring: the agents' prompts, the spec issue form and the boxes", () => {
  assert.match(verdict.instructions("spec"), /### One-way doors/);
  assert.throws(() => roles.modelFor("tickets", ""), /Unknown AI role/, "no AI split any more");
  assert.match(newStoryCard({ key: "150", ai: { plan: true }, spec: true }), /act:spec/);
  assert.deepEqual(actions.command("/tickets"), { id: "story", arg: "" }, "the old command makes the story");
  assert.deepEqual(actions.command("/story"), { id: "story", arg: "" });
  const wf = readFileSync(new URL("../../.github/workflows/ai-spec.yml", import.meta.url), "utf8");
  assert.doesNotMatch(wf, /tickets|breakdown/);
  assert.match(wf, /User stories" become the story's acceptance criteria/);
});

test("completion fixes: UAT failure offers a retest; a spec card follows the spec; sprint names", () => {
  const pr = { number: 110, state: "OPEN", headRefName: "release/w45", baseRefName: "main", headRefOid: "h" };
  const st = { sha: "h", context: gate.STATUS.uat, state: "failure", description: "totals wrong", created_at: "2026-10-06T10:00:00Z", creator: { login: "github-actions[bot]" } };
  const failedUat = releaseCard({ repoUrl: "https://github.com/o/r", pr, uat: true, facts: { checkRuns: [], statuses: [st], reviews: [] } });
  assert.match(failedUat, /act:uat-pass[\s\S]*act:uat\b/);
  assert.match(newStoryCard({ key: "125", spec: true, stage: "spec" }), /tick \*\*Make it a story\*\*/);
  // the card carries the boxes (its stage icons are not boxes), the open questions, and ⏳ while Claude writes
  const asked = newStoryCard({ key: "125", ai: { plan: true }, spec: true, stage: "spec", questions: 5 });
  assert.match(asked, /\*\*5 open questions\*\*[\s\S]*act:spec[\s\S]*act:story-anyway/);
  assert.match(newStoryCard({ key: "125", ai: { plan: true }, spec: true, stage: "spec" }), /act:story -->/);
  assert.match(newStoryCard({ key: "125", spec: true, stage: "writing" }), /Claude is writing the spec/);
  assert.doesNotMatch(newStoryCard({ key: "125", ai: { plan: true }, spec: true, stage: "story", stories: [142] }), /act:/);
  assert.deepEqual(specs.pendingCard(null), { spec: true, stage: "writing", questions: 0 });
  const written = specs.specComment("### Open questions\n\n1. Which?\n2. Where?");
  assert.deepEqual(specs.pendingCard(written, { failed: true }), { spec: true, stage: "spec", questions: 2 });
  assert.equal(specs.pendingCard(`${written}\n<!-- story:9 -->`), null, "a spec made into a story keeps its card");
  // answers written after the command on the same comment are kept; a bare command is not an answer
  const c = (body, created) => ({ author: "pat", body, created });
  const ctx = plans.planContext([c(written, "1"), c("/spec 1. Use X\n2. Here", "2"), c("  /spec", "3"), c("plain answer", "4")], { mark: specs.SPEC_MARK, title: specs.SPEC_TITLE });
  assert.deepEqual(ctx.answers.map((x) => x.body), ["1. Use X\n2. Here", "plain answer"]);
  assert.match(newStoryCard({ key: "125", spec: true, stage: "story", stories: [142] }), /Done: the spec is story #142/);
  assert.equal(names.nextSprint(["2026-w45", "2026-w44"]), "2026-w46");
  assert.equal(names.nextSprint(["2026-w52"]), "2027-w01");
  assert.match(names.nextSprint([]), /^\d{4}-w\d{2}$/);
  assert.match(verdict.instructions("implement", { key: "7" }), /Story #7[^\n]*never "Closes"/);
});

test("the card's UI test row links the evidence comment when the verdict carries it", () => {
  const base = { key: "2", repoUrl: "https://github.com/o/r", branch: "issue-2", base: "release/2026-w41" };
  const f = { ...open(fixture(23)), ai: { uiTest: true }, reviews: [] };
  const withUrl = (url) => ({ ...f, statuses: [{ ...ok(f.pr.headRefOid, gate.STATUS.ui), url }] });
  const shown = storyCard({ ...base, pr: f.pr, facts: withUrl("https://github.com/o/r/issues/2#issuecomment-9"), decision: gate.evaluate(withUrl(null)) });
  assert.match(shown, /UI test \| passed in the scratch org: \*\*\[see the screenshots\]\(https:\/\/github\.com\/o\/r\/issues\/2#issuecomment-9\)\*\*/);
  const plain = storyCard({ ...base, pr: f.pr, facts: withUrl("https://github.com/o/r/actions/runs/1"), decision: gate.evaluate(withUrl(null)) });
  assert.match(plain, /UI test \| passed in the scratch org \|/, "a run link is not evidence: the row stays as it was");
});

test("round 1: a spec closes when its stories ship, and its card says where", async () => {
  const issues = { 143: { state: "OPEN", body: "x\n\nPart of spec #125." }, 125: { state: "OPEN", body: "spec" } };
  const done = [], cardsDone = [];
  const tracker = { story: async (k) => issues[k], done: async (k, t) => { done.push([k, t]); issues[k].state = "CLOSED"; }, carry: async () => {}, comment: async () => {}, closeSprint: async () => {} };
  const gh = (a) => (a[0] === "issue" && a[1] === "list" ? [{ number: 143 }] : []);
  await closeout.apply({ ship: ["143"], carry: [], hotfix: [], sprint: null, deleteOrgs: [], deleteBranch: null }, { tag: "v1", tracker, orgs: { remove() {} }, git: () => "", gh, cards: { newStory: async (k, o) => cardsDone.push([k, o]) }, log: () => {} });
  assert.deepEqual(done.map((d) => d[0]), ["143", "125"]);
  assert.match(done[1][1], /every story of this spec is in production \(v1\)/);
  assert.deepEqual(cardsDone, [["125", { spec: true, stage: "shipped", stories: ["143"], tag: "v1" }]]);
  assert.match(newStoryCard({ key: "125", spec: true, stage: "shipped", stories: ["143"], tag: "v1" }), /Done: shipped in v1 \(story #143\)/);
  const left = { 150: { state: "OPEN", body: "Part of spec #9." }, 9: { state: "OPEN" } };
  const done2 = [];
  await closeout.apply({ ship: ["150"], carry: [], hotfix: [], sprint: null, deleteOrgs: [], deleteBranch: null }, { tag: "v2", tracker: { ...tracker, story: async (k) => left[k], done: async (k) => done2.push(k) }, orgs: { remove() {} }, git: () => "", gh: () => [{ number: 150 }, { number: 151 }], log: () => {} });
  assert.deepEqual(done2, ["150"], "a spec with an unshipped story stays open");
});

test("a story that has not started keeps its Start card when something refreshes it (story #166 showed 'branch and org' it did not have)", () => {
  const src = readFileSync(new URL("../src/card.mjs", import.meta.url), "utf8");
  assert.match(src, /not started \(no PR, no branch\): the card offers Plan and Start/);
  assert.match(newStoryCard({ key: "166", ai: { plan: true } }), /act:start/);
});

test("approver (enterprise B): Sign off and /review-ok refuse an approval that would not count; the reason is kept in full; stories name the default approver; a big spec suggests slicing", () => {
  const did = [];
  const host = { repoUrl: "https://github.com/o/r", status: (...a) => did.push(a), dispatch: () => {} };
  const story = { headRefName: "issue-106", headRefOid: "h1", baseRefName: "release/w45" };
  const deps = { host, appGh: () => {}, gh: () => {}, inUat: () => false, mayApprove: (who) => (who === "bob" ? "@bob pushed the latest change, so @alice (the approver) needs to approve" : null) };
  assert.match(actions.perform("ship", "", { number: 108, isPr: true, pr: story }, "bob", deps).said, /Not signed off: @bob pushed the latest change/);
  assert.match(actions.perform("review-ok", "it is fine", { number: 108, isPr: true, pr: story }, "bob", deps).said, /The AI review stands/);
  assert.equal(did.length, 0, "no status was written for a refused approval");
  assert.match(actions.perform("ship", "", { number: 108, isPr: true, pr: story }, "alice", deps).done, /signed off by @alice/);
  const long = "x".repeat(400);
  assert.equal(actions.command(`/review-ok ${long}`).arg.length, 400, "the full reason, not 100 characters");

  const body = specs.storyBody({ summary: "s", criteria: ["a"], access: "No change", where: "w", out: "o" }, { spec: 1, approver: "alice" });
  assert.match(body, /### Approver\n\n@alice\n/);
  assert.equal(gate.approverOf(body), "alice");
  const seven = specs.specComment(`### Problem\nx\n### User stories\n${[1, 2, 3, 4, 5, 6, 7].map((n) => `${n}. As a rep, I want ${n}`).join("\n")}\n`);
  assert.match(seven, /\*\*Big for one story:\*\* 7 user stories/);
  assert.match(seven, /act:story/, "it can still be made one story");
  assert.doesNotMatch(specs.specComment("### Problem\nx\n### User stories\n1. As a rep, I want y\n"), /Big for one story/);

  const f = withVerdicts(fixture(23));
  const card = storyCard({ key: "23", repoUrl: "https://github.com/o/r", branch: "issue-23", base: "release/w", pr: { ...f.pr, state: "OPEN" }, facts: { ...f, reviews: [], approvers: ["alice", "carol"], storyApprover: "alice", lastPusher: "bob" }, decision: { mergeable: false } });
  assert.match(card, /@alice \(the approver\): \*\*\[Approve here\]/);
});

test("a person is told once when a card needs them; a UI test still running over its own spec commit reads as running (14 Oct review)", async () => {
  const { needsOf, needsLine, notifyNeeds } = await import("../src/card.mjs");
  // pending on the head before the spec commit, with only e2e/ since: still running
  const older = "0000000000000000000000000000000000000001";
  const pend = { sha: older, context: gate.STATUS.ui, state: "pending", created_at: "t", creator: { login: "github-actions[bot]" } };
  assert.equal(gate.verdictFor(gate.STATUS.ui, { statuses: [pend], head: "h", diffsToHead: { [older]: ["e2e/story-1.spec.ts"] } }).state, "pending");
  assert.equal(gate.verdictFor(gate.STATUS.ui, { statuses: [pend], head: "h", diffsToHead: { [older]: ["force-app/x.cls"] } }).state, "stale", "code changed: stale");
  // UAT pending on an older commit is owed on the head, even over a spec-only change (release 2027-w01's deadlock)
  assert.equal(gate.verdictFor(gate.STATUS.uat, { statuses: [{ ...pend, context: gate.STATUS.uat }], head: "h", diffsToHead: { [older]: ["e2e/story-293.spec.ts"] } }).state, "stale");
  // the hidden line round-trips
  assert.deepEqual(needsOf(`card\n${needsLine({ who: ["alice", "bob"], what: "approve it" })}`), { who: ["alice", "bob"], what: "approve it" });
  assert.equal(needsLine({ who: [], what: "x" }), "", "nobody to name: no line");
  // one comment when who or what changes; none when it is the same, or when nobody is needed
  const said = [];
  let prior = "";
  const tracker = { prior: async () => prior, comment: async (n, t) => said.push([n, t]) };
  const body = (who, what) => `card\n${needsLine({ who, what })}`;
  assert.equal(await notifyNeeds({ tracker, number: 7, body: body(["alice"], "approve #7") }), true);
  prior = body(["alice"], "approve #7");
  assert.equal(await notifyNeeds({ tracker, number: 7, body: body(["alice"], "approve #7") }), false, "the same need: no second mention");
  assert.equal(await notifyNeeds({ tracker, number: 7, body: "card" }), false, "nobody needed");
  assert.equal(await notifyNeeds({ tracker: { card: async () => {} }, number: 7, body: body(["alice"], "x") }), false, "a tracker without prior (Jira): nothing");
  assert.deepEqual(said, [[7, "@alice: approve #7"]]);
  // the story card asks its approver once everything else is green
  const f = { ...open(fixture(12)), reviews: [], storyApprover: "alice" };   // everything green, not approved yet
  const card = (facts) => storyCard({ key: "12", repoUrl: "https://github.com/o/r", branch: facts.pr.headRefName, base: facts.pr.baseRefName, pr: facts.pr, facts, decision: gate.evaluate(facts) });
  assert.deepEqual(needsOf(card(f)), { who: ["alice"], what: "story #12 is ready for your approval: https://github.com/o/r/pull/12/files" });
  assert.equal(needsOf(card(open(fixture(12)))), null, "approved: nobody needed");
  assert.equal(needsOf(card({ ...f, pr: { ...f.pr, isDraft: true } })), null, "a draft: the author, not the approver");
});

test("a release calls its approvers only when everything above Approval is done (2027-w01 called them as its PR opened)", async () => {
  const { needsOf } = await import("../src/card.mjs");
  const pr = { number: 296, state: "OPEN", headRefName: "release/2027-w01", baseRefName: "main", headRefOid: "h" };
  const run = (name, conclusion) => ({ name, conclusion, status: conclusion ? "completed" : "in_progress", started_at: "2026-10-14T12:00:00Z" });
  const st = (context, state) => ({ sha: "h", context, state, description: "", created_at: "2026-10-14T12:30:00Z", creator: { login: "github-actions[bot]" } });
  const base = { repoUrl: "https://github.com/o/r", pr, uat: true, stories: [{ key: "293", title: "Competitor mentions" }], facts: { approvers: ["lead"] } };
  const green = [run("static checks (no org)", "success"), run("deploy and Apex tests (scratch org)", "success"), run("staging regression", "success")];
  const opened = releaseCard({ ...base, facts: { ...base.facts, checkRuns: [run("static checks (no org)", null), run("staging regression", null)], statuses: [], reviews: [] } });
  assert.equal(needsOf(opened), null, "staging and UAT still to come: nobody is called");
  const done = releaseCard({ ...base, facts: { ...base.facts, checkRuns: green, statuses: [st(gate.STATUS.uat, "success"), st(gate.STATUS.uiRegression, "success")], reviews: [] } });
  assert.deepEqual(needsOf(done)?.who, ["lead"]);
});

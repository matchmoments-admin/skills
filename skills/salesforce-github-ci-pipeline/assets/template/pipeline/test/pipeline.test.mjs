process.env.PIPELINE_BOTS = "github-actions,__owner__-pipeline";   // the pipeline's identities, as the repo variable sets them
// Tests through each module's interface. Gate fixtures are this repo's real PRs from sprint 2026-w41.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import * as names from "../src/conventions.mjs";
import * as gate from "../src/gate.mjs";
import * as verdict from "../src/verdict.mjs";
import { plan } from "../src/closeout.mjs";
import { jiraTracker, githubTracker, adfToText } from "../src/tracker.mjs";
import { orgRegistry, packageList, findOrphans, personaOf as orgPersonaOf, expandSeed } from "../src/org.mjs";
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
import { lane } from "../src/lane.mjs";
import * as events from "../src/events.mjs";
import { codeHost } from "../src/github.mjs";
import { storyCards, releaseCard, newStoryCard } from "../src/card.mjs";
import * as actions from "../src/actions.mjs";
import * as specs from "../src/spec.mjs";
import * as evidence from "../src/evidence.mjs";
import * as baselineMod from "../src/baseline.mjs";
import * as orgMod from "../src/org.mjs";

const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/pr-${n}.json`, import.meta.url)));
const open = (f, pr = {}) => ({ ...f, pr: { ...f.pr, state: "OPEN", mergeable: "MERGEABLE", ...pr } });   // as it was before merging

// ---------------------------------------------------------------- conventions
test("story keys and branches round-trip for GitHub and Jira", () => {
  assert.equal(names.storyBranch(12), "issue-12");
  assert.equal(names.storyBranch("LIFE-123"), "LIFE-123");
  assert.equal(names.storyOf("issue-12"), "12");
  assert.equal(names.storyOf("origin/issue-12"), "12");
  assert.equal(names.storyOf("issue-1-add-account-tier-field-with-validation"), "1"); // older form
  assert.equal(names.storyOf("LIFE-123"), "LIFE-123");
  assert.equal(names.storyOf("release/2026-w41"), null);
  assert.equal(names.storyOf("chore/staging-lane"), null);
  assert.throws(() => names.storyBranch("not a key"));
});

test("one lock per org: the issue lock and the PR lock are the same string", () => {
  const fromIssue = names.orgFor("story:12").lock;
  const fromBranch = `org-${names.storyBranch(12)}`; // what a PR job computes from head_ref
  assert.equal(fromIssue, fromBranch);
  assert.equal(names.orgFor("release/2026-w42").lock, "org-staging");
});

test("org identity: alias, registry key, definition and lifetime", () => {
  assert.deepEqual(names.orgFor("story:12"), { kind: "story", key: "12", alias: "issue-12", description: "issue-12", lock: "org-issue-12", definition: "config/scratch-dev.json", days: 7 });
  assert.equal(names.orgFor("story:12", { hotfix: true }).definition, "config/scratch-hotfix.json");
  assert.deepEqual(names.orgFor("sprint:2026-w42"), { kind: "sprint", sprint: "2026-w42", alias: "staging", description: "staging-2026-w42", lock: "org-staging", definition: "config/scratch-qa.json", days: 30 });
  assert.equal(names.orgFor("issue-7").alias, "issue-7");
  assert.equal(names.orgFor("main"), null);
});

test("base branch: hotfix from main, otherwise the open release; refuse with no sprint", () => {
  assert.equal(names.baseFor({ labels: ["feature", "hotfix"], openReleaseBranch: "release/x" }), "main");
  assert.equal(names.baseFor({ labels: [{ name: "feature" }], openReleaseBranch: "release/x" }), "release/x");
  assert.throws(() => names.baseFor({ labels: [], openReleaseBranch: null }), /sprint-start/);
  assert.throws(() => names.openRelease(["origin/release/a", "origin/release/b"]), /More than one/);
  assert.equal(names.openRelease(["origin/main", "origin/release/2026-w42"]), "release/2026-w42");
});

test("context gives a workflow every name it needs", () => {
  const c = names.context({ key: "12", labels: [], openReleaseBranch: "release/2026-w42" });
  assert.equal(c.STORY_BRANCH, "issue-12");
  assert.equal(c.BASE_BRANCH, "release/2026-w42");
  assert.equal(c.MILESTONE, "Sprint 2026-w42");
  assert.equal(c.STAGING_DESCRIPTION, "staging-2026-w42");
  assert.equal(c.ORG_LOCK, "org-issue-12");
});

// ---------------------------------------------------------------- gate
// Real PRs (#12 hotfix, #23 story, #26 release) predate verdict statuses; tests add the statuses the
// agent-free jobs now post, so each rule is checked against real reviews, checks and history.
const ok = (sha, context, at = "2026-10-04T12:00:00Z") => ({ sha, context, state: "success", created_at: at, creator: { login: "github-actions[bot]" } });
const FULL_AI = { review: true, uiTest: true };   // the flags these real PRs ran under
const withVerdicts = (f, extra = {}) => ({
  ...open(f), ai: FULL_AI, statuses: [ok(f.pr.headRefOid, gate.STATUS.review), ok(f.pr.headRefOid, gate.STATUS.ui)], ...extra,
});

test("routes, including pipeline maintenance into main", () => {
  assert.equal(gate.route({ headRefName: "issue-1", baseRefName: "release/w" }), "feature");
  assert.equal(gate.route({ headRefName: "issue-8", baseRefName: "main" }), "hotfix");
  assert.equal(gate.route({ headRefName: "release/w", baseRefName: "main" }), "release");
  assert.equal(gate.route({ headRefName: "backmerge-99", baseRefName: "release/w" }), "backmerge");
  assert.equal(gate.route({ headRefName: "fix/gate", baseRefName: "main" }), "maintenance");
  assert.equal(gate.route({ headRefName: "x", baseRefName: "dev" }), null);
});

test("PR #23 (story): mergeable once the trusted verdict statuses exist; labels alone count for nothing", () => {
  const f = fixture(23);
  assert.ok(f.pr.labels.some((l) => l.name === "review:pass"));          // the label is there...
  assert.match(gate.evaluate({ ...open(f), ai: FULL_AI }).reasons.join(), /AI review has not run on this code/);   // ...but not trusted
  assert.deepEqual(gate.evaluate(withVerdicts(f)).reasons, []);
});

test("verdicts from anyone but the Actions bot are ignored; a failed or stale verdict blocks", () => {
  const f = fixture(23), head = f.pr.headRefOid;
  const forged = { ...ok(head, gate.STATUS.review), creator: { login: "__owner__-pipeline[bot]" } };
  assert.match(gate.evaluate(withVerdicts(f, { statuses: [forged, ok(head, gate.STATUS.ui)] })).reasons.join(), /AI review has not run/);
  const failed = { ...ok(head, gate.STATUS.ui, "2026-10-04T13:00:00Z"), state: "failure" };
  assert.match(gate.evaluate(withVerdicts(f, { statuses: [ok(head, gate.STATUS.review), ok(head, gate.STATUS.ui), failed] })).reasons.join(), /UI test did not pass/);
  const older = "0000000000000000000000000000000000000001";
  const stale = { statuses: [ok(older, gate.STATUS.review), ok(head, gate.STATUS.ui)], diffsToHead: { [older]: ["force-app/main/default/classes/X.cls"] } };
  assert.match(gate.evaluate(withVerdicts(f, stale)).reasons.join(), /AI review judged an older commit/);
  const specOnly = { statuses: [ok(older, gate.STATUS.review), ok(head, gate.STATUS.ui)], diffsToHead: { [older]: ["e2e/story-2.spec.ts"] } };
  assert.deepEqual(gate.evaluate(withVerdicts(f, specOnly)).reasons, []);
});

test("AI flags: all off = CI and an approval; each flag adds only its own verdict; a failed verdict always blocks", () => {
  const f = fixture(23), head = f.pr.headRefOid;
  const approved = [{ user: { login: "u", type: "User" }, state: "APPROVED", commit_id: head, submitted_at: "2026-10-04T12:00:00Z" }];
  const pr = (ai, extra = {}) => ({ ...open(f), reviews: approved, ai, statuses: [], compare: { prFiles: ["force-app/main/default/layouts/Account-Account Layout.layout-meta.xml"] }, ...extra });
  assert.deepEqual(gate.evaluate(pr({})).reasons, []);                                           // manual pipeline
  assert.match(gate.evaluate(pr({ review: true })).reasons.join(), /AI review has not run/);
  assert.doesNotMatch(gate.evaluate(pr({ review: true })).reasons.join(), /UI test/);
  assert.match(gate.evaluate(pr({ uiTest: true })).reasons.join(), /UI test has not run on this code \(tick Have Claude write and run the UI test\)/);
  assert.deepEqual(gate.evaluate(pr({ uiTest: true }, { compare: { prFiles: ["force-app/main/default/classes/X.cls"] } })).reasons, []);   // not UI-facing
  const withSpec = { compare: { prFiles: ["force-app/main/default/layouts/A.layout-meta.xml", "e2e/story-2.spec.ts"] } };
  assert.match(gate.evaluate(pr({}, withSpec)).reasons.join(), /UI test has not run on this code \(tick Run the committed UI test/);   // committed spec, no AI
  const failed = { ...ok(head, gate.STATUS.ui), state: "failure" };
  assert.match(gate.evaluate(pr({}, { statuses: [failed] })).reasons.join(), /UI test did not pass/);   // never ignored
});

test("approval counts only for the commit it reviewed (e2e-only changes since are fine); bots never sign off", () => {
  const f = fixture(23), head = f.pr.headRefOid, older = "0000000000000000000000000000000000000002";
  const human = (commit_id) => [{ user: { login: "u", type: "User" }, state: "APPROVED", commit_id, submitted_at: "2026-10-04T12:00:00Z" }];
  assert.equal(gate.humanApproval({ reviews: human(head), head }), true);
  assert.equal(gate.humanApproval({ reviews: human(older), head, diffsToHead: { [older]: ["force-app/x.cls"] } }), false);
  assert.equal(gate.humanApproval({ reviews: human(older), head, diffsToHead: { [older]: ["e2e/s.spec.ts"] } }), true);
  assert.equal(gate.humanApproval({ reviews: [{ user: { login: "bot", type: "Bot" }, state: "APPROVED", commit_id: head }], head }), false);
  const stale = gate.evaluate(withVerdicts(f, { reviews: human(older), diffsToHead: { [older]: ["force-app/x.cls"] } }));
  assert.match(stale.reasons.join(), /approval was for an older commit/);
});

test("ready counts only when applied after the head was pushed", () => {
  const checks = [{ name: "x", started_at: "2026-10-04T10:00:00Z" }];
  const ready = (at, type = "User") => [{ event: "labeled", label: { name: "ready" }, created_at: at, actor: { type } }];
  assert.equal(gate.readyAfterPush({ labelEvents: ready("2026-10-04T10:05:00Z"), checkRuns: checks }), true);
  assert.equal(gate.readyAfterPush({ labelEvents: ready("2026-10-04T09:00:00Z"), checkRuns: checks }), false);
  assert.equal(gate.readyAfterPush({ labelEvents: ready("2026-10-04T10:05:00Z", "Bot"), checkRuns: checks }), false);
  const ship = (at, assoc = "MEMBER", type = "User", body = "/ship") => [{ body, created_at: at, author_association: assoc, user: { type } }];
  assert.equal(gate.readyAfterPush({ comments: ship("2026-10-04T10:05:00Z"), checkRuns: checks }), true);
  assert.equal(gate.readyAfterPush({ comments: ship("2026-10-04T09:00:00Z"), checkRuns: checks }), false);   // before the push
  assert.equal(gate.readyAfterPush({ comments: ship("2026-10-04T10:05:00Z", "NONE"), checkRuns: checks }), false);   // no write access
  assert.equal(gate.readyAfterPush({ comments: ship("2026-10-04T10:05:00Z", "MEMBER", "Bot"), checkRuns: checks }), false);
  assert.equal(gate.readyAfterPush({ comments: ship("2026-10-04T10:05:00Z", "MEMBER", "User", "please /ship it"), checkRuns: checks }), false);
});

test("PR #12 (hotfix): approved on its head, validated against production; refused if it carries sprint commits", () => {
  const f = fixture(12);
  const d = gate.evaluate(withVerdicts(f, { compare: { ...f.compare, unreleasedSprintCommits: 0 } }));
  assert.deepEqual(d.reasons, []);
  assert.equal(d.validate, true);
  assert.deepEqual(d.after, ["release", "delete-story-org"]);
  assert.match(gate.evaluate(withVerdicts(f, { compare: { unreleasedSprintCommits: 3 } })).reasons.join(), /3 unreleased sprint commit/);
});

test("PR #26 (release): needs CI, the staging regression and an approval on its head; merge commit", () => {
  const d = gate.evaluate(open(fixture(26)));
  assert.equal(d.route, "release");
  assert.deepEqual(d.reasons, []);
  assert.equal(d.rules.merge, "merge");
  const noStaging = { ...open(fixture(26)), checkRuns: fixture(26).checkRuns.filter((c) => c.name !== names.CHECKS.staging) };
  assert.match(gate.evaluate(noStaging).reasons.join(), /staging regression" is missing/);
});

test("back-merge: only the pipeline's own, and only commits already in main", () => {
  const f = fixture(26);
  const bm = (login, headInMain) => ({ ...open(f), pr: { ...open(f).pr, headRefName: "backmerge-1", baseRefName: "release/w43", author: { login, is_bot: false } }, compare: { headInMain } });
  assert.deepEqual(gate.evaluate(bm("app/__owner__-pipeline", true)).reasons, []);
  assert.match(gate.evaluate(bm("someone", true)).reasons.join(), /opened by the pipeline/);
  assert.match(gate.evaluate(bm("app/__owner__-pipeline", false)).reasons.join(), /already in main/);
});

test("maintenance into main: approval; production only when Salesforce source changed", () => {
  const f = fixture(26);
  const m = (forceAppChanged) => ({ ...open(f), pr: { ...open(f).pr, headRefName: "fix/gate", baseRefName: "main" }, compare: { forceAppChanged } });
  const pipelineOnly = gate.evaluate(m(false));
  assert.equal(pipelineOnly.route, "maintenance");
  assert.equal(pipelineOnly.validate, false);
  assert.deepEqual(pipelineOnly.after, []);
  assert.deepEqual(gate.evaluate(m(true)).after, ["release"]);
});

test("conflicts, drafts and merged PRs are explained, never merged", () => {
  const f = withVerdicts(fixture(23));
  assert.match(gate.evaluate({ ...f, pr: { ...f.pr, mergeable: "CONFLICTING" } }).reasons.join(), /merge conflicts/);
  assert.match(gate.evaluate({ ...f, pr: { ...f.pr, isDraft: true } }).reasons.join(), /draft/);
  assert.match(gate.evaluate({ ...f, pr: { ...f.pr, state: "MERGED" } }).reasons.join(), /merged/);
});

test("checks are matched by exact name and only the latest run counts", () => {
  const f = withVerdicts(fixture(23));
  const noApex = { ...f, checkRuns: f.checkRuns.filter((c) => c.name !== names.CHECKS.apex) };
  assert.match(gate.evaluate(noApex).reasons.join(), /deploy and Apex tests \(scratch org\)" is missing/);
  const failedThenFixed = { ...f, checkRuns: [...f.checkRuns, { name: names.CHECKS.static, conclusion: "failure", started_at: "2000-01-01T00:00:00Z" }] };
  assert.deepEqual(gate.evaluate(failedThenFixed).reasons, []);
});

test("nudge: re-runs the gate on any human approval, ready, or a back-merge; otherwise waits", () => {
  const io2 = (pr, reviews = []) => ({ gh: () => ({ state: "OPEN", labels: [], headRefName: "issue-1", baseRefName: "release/w", ...pr }), ghPages: () => reviews });
  assert.equal(gate.nudge(1, io2({}, [{ user: { type: "User" }, state: "APPROVED" }])).action, "dispatch");
  assert.equal(gate.nudge(1, io2({ labels: [{ name: "ready" }] })).action, "dispatch");
  assert.equal(gate.nudge(1, io2({ headRefName: "backmerge-1" })).action, "dispatch");
  assert.equal(gate.nudge(1, io2({}, [{ user: { type: "Bot" }, state: "APPROVED" }])).action, "none");
  assert.equal(gate.nudge(1, io2({ state: "MERGED" })).action, "none");
});

test("pipeline paths are guarded and UI-facing changes are recognised", () => {
  assert.deepEqual(names.touchesPipeline(["pipeline/src/gate.mjs", "force-app/x", "e2e/a.spec.ts", ".github/workflows/ci.yml"]), ["pipeline/src/gate.mjs", ".github/workflows/ci.yml"]);
  assert.equal(names.uiFacing(["force-app/main/default/classes/AccountSelector.cls"]).length, 0);
  assert.equal(names.uiFacing(["force-app/main/default/layouts/Case-Case Layout.layout-meta.xml"]).length, 1);
});

// ---------------------------------------------------------------- verdict
test("review verdict: formats tolerated, latest wins, none is null", () => {
  assert.equal(verdict.reviewVerdict(["...\n`AI-REVIEW: CHANGES`", "ok\n**AI-REVIEW: PASS**"]), "pass");
  assert.equal(verdict.reviewVerdict(["AI-REVIEW: PASS", "AI-REVIEW: CHANGES"]), "changes");
  assert.equal(verdict.reviewVerdict(["no verdict"]), null);
});

test("fix rounds count only fix(review) commits; instructions carry the shell rule and the format", () => {
  assert.equal(verdict.fixRounds(["feat(x): a (#1)", "fix(review): b", "fix(review): c", "test(e2e): story 1"]), 2);
  const r = verdict.instructions("review");
  assert.match(r, /Shell rule/);
  assert.match(r, /AI-REVIEW: PASS/);
  assert.match(verdict.instructions("ui-test", { key: "12" }), /test\(e2e\): story 12/);
  assert.throws(() => verdict.instructions("nope"));
});

// ---------------------------------------------------------------- close-out (sprint 2026-w41, as it happened)
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

// ---------------------------------------------------------------- tracker adapters
test("Jira adapter: reads a story, comments and transitions to Done (mocked REST)", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(`${init.method} ${url.replace("https://acme.atlassian.net", "")}`);
    const json = (b) => ({ ok: true, status: 200, json: async () => b });
    if (url.endsWith("/transitions") && init.method === "GET")
      return json({ transitions: [{ id: "11", name: "In Progress", to: { statusCategory: { key: "indeterminate" } } }, { id: "31", name: "Done", to: { statusCategory: { key: "done" } } }] });
    if (url.includes("/issue/LIFE-123?"))
      return json({ key: "LIFE-123", fields: { summary: "Tier field", status: { statusCategory: { key: "new" } }, labels: ["feature"],
        description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Acceptance criteria" }] }, { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Gold needs Industry" }] }] }] }] } } });
    return { ok: true, status: 204, json: async () => null };
  };
  const t = jiraTracker({ fetch, base: "https://acme.atlassian.net", email: "ci@acme.test", token: "t" });
  const s = await t.story("LIFE-123");
  assert.equal(s.title, "Tier field");
  assert.equal(s.state, "OPEN");
  assert.match(s.body, /Acceptance criteria[\s\S]*- Gold needs Industry/);
  await t.done("LIFE-123", "Shipped");
  assert.deepEqual(calls.slice(1), ["POST /rest/api/3/issue/LIFE-123/comment", "GET /rest/api/3/issue/LIFE-123/transitions", "POST /rest/api/3/issue/LIFE-123/transitions"]);
  assert.throws(() => jiraTracker({ fetch, base: "", email: "", token: "" }), /JIRA_BASE_URL/);
});

test("GitHub adapter: carry over removes the milestone; sprint stories map to keys", async () => {
  const calls = [];
  const gh = (args) => { calls.push(args.join(" ")); return args[1] === "list" ? [{ number: 2, title: "Urgent", state: "OPEN" }] : null; };
  const t = githubTracker({ gh, repo: "o/r" });
  await t.carry("2", "w41", "carried");
  assert.deepEqual(calls, ["issue comment 2 --body carried", "issue edit 2 --remove-milestone --remove-label in-sprint"]);
  assert.deepEqual(await t.sprintStories("w41"), [{ key: "2", title: "Urgent", state: "OPEN" }]);
  assert.equal(adfToText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }] }] }).trim(), "a\nb");
});

// ---------------------------------------------------------------- org registry (fake sf)
function fakeSf(records, { ready = true, installed = [] } = {}) {
  const calls = [];
  const sf = (args, opts) => {
    calls.push(args.slice(0, 3).join(" "));
    if (args[0] === "data" && args[1] === "query" && /FROM User/.test(args.at(-1))) return { records: [{ Title: ready ? "pipeline: ready" : null }] };
    if (args[0] === "package" && args[1] === "installed") return installed.map((id) => ({ SubscriberPackageVersionId: id }));
    if (args[0] === "data" && args[1] === "query") return { records };
    if (args[0] === "org" && args[1] === "display") return { clientId: "CID", username: "u@x" };
    return {};
  };
  return { sf, calls };
}

test("org registry: attaches the live org found by Description; never creates when one exists", () => {
  const { sf, calls } = fakeSf([{ Description: "issue-12", SignupUsername: "u@x", LoginUrl: "https://s", ExpirationDate: "2026-10-07" }, { Description: "staging-w", SignupUsername: "s@x", LoginUrl: "https://t" }]);
  const r = orgRegistry({ sf, log: () => {}, sleep: () => {}, env: { BASELINE: "off", SEED: "off" } });
  assert.equal(r.find("story:99"), null);
  const o = r.ensure("issue-12");
  assert.equal(o.created, false);
  assert.ok(calls.includes("org login jwt"));
  assert.ok(!calls.includes("org create scratch"));
});

test("org registry: creates, deploys and prepares when none is live; remove is a no-op when none", () => {
  const { sf, calls } = fakeSf([]);
  const r = orgRegistry({ sf, log: () => {}, sleep: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } });
  const o = r.ensure("story:12", { hotfix: true });
  assert.equal(o.created, true);
  assert.equal(o.definition, "config/scratch-hotfix.json");
  assert.deepEqual(calls.filter((c) => !c.startsWith("data query")).slice(0, 4), ["limits api display", "org list snapshot", "org create scratch", "project deploy start"]);   // capacity first, then the newest snapshot (none: shape)
  assert.equal(r.remove("story:12"), false);
});

// ---------------------------------------------------------------- io seam
test("gh output: JSON is parsed, plain text (a comment URL) is returned as text", async () => {
  const { parseJson } = await import("../src/io.mjs");
  assert.deepEqual(parseJson("warning line\n{\"a\":1}"), { a: 1 });
  assert.throws(() => parseJson("https://github.com/o/r/issues/2#issuecomment-1"), /no JSON/);
});



test("org registry refuses to create when the Dev Hub has no room, with the reason", () => {
  const full = (name, remaining) => ({ name, remaining, max: name === "DailyScratchOrgs" ? 6 : 3 });
  const sf = (args) => {
    if (args[0] === "limits") return [full("ActiveScratchOrgs", 0), full("DailyScratchOrgs", 4)];
    if (args[0] === "data") return { records: [] };
    return {};
  };
  assert.throws(() => orgRegistry({ sf, log: () => {}, sleep: () => {}, env: { BASELINE: "off", SEED: "off" } }).ensure("story:9"), /No free scratch org slot/);
});

test("the review verdict comes only from the pipeline's comments posted during this run", () => {
  const c = (login, createdAt, body) => ({ author: { login }, createdAt, body });
  const comments = [
    c("app/__owner__-pipeline", "2026-10-04T09:00:00Z", "old\nAI-REVIEW: PASS"),
    c("someone", "2026-10-04T12:05:00Z", "AI-REVIEW: PASS"),
    c("app/__owner__-pipeline", "2026-10-04T12:06:00Z", "review\nAI-REVIEW: CHANGES"),
  ];
  assert.equal(verdict.reviewVerdict(verdict.reviewComments(comments, "2026-10-04T12:00:00Z")), "changes");
  assert.equal(verdict.reviewVerdict(verdict.reviewComments(comments.slice(0, 2), "2026-10-04T12:00:00Z")), null);
});

test("close-out is safe to re-run and closes PRs still aimed at the shipped release branch", async () => {
  const done = [], closed = [];
  const tracker = { story: async (k) => ({ state: k === "1" ? "CLOSED" : "OPEN" }), done: async (k) => done.push(k), carry: async () => {}, closeSprint: async () => {} };
  const gh = (args) => (args[1] === "list" ? [{ number: 40, headRefName: "issue-5" }] : args[1] === "close" ? (closed.push(args[2]), null) : null);
  const { apply } = await import("../src/closeout.mjs");
  await apply({ sprint: "w", ship: ["1", "3"], carry: [], hotfix: [], deleteOrgs: [], deleteBranch: "release/w" },
    { tag: "v1", tracker, orgs: { remove: () => true }, git: (args) => (args[0] === "ls-remote" ? null : ""), gh, log: () => {} });
  assert.deepEqual(done, ["3"]);       // story 1 was already closed by an earlier run
  assert.deepEqual(closed, ["40"]);
  // git cannot delete it: the API does, and a branch that survives both is reported, never silent
  const calls = [], logs = [];
  let alive = true;
  const git = (args) => (args[0] === "ls-remote" ? (alive ? "sha refs/heads/release/w" : null) : null);
  const gh2 = (args) => { calls.push(args.join(" ")); if (args.includes("DELETE")) alive = false; return []; };
  await apply({ sprint: "w", ship: [], carry: [], hotfix: [], deleteOrgs: [], deleteBranch: "release/w" }, { tag: "v1", tracker, orgs: { remove: () => true }, git, gh: gh2, log: (m) => logs.push(m) });
  assert.ok(calls.some((c) => c.includes("-X DELETE") && c.endsWith("git/refs/heads/release/w")));
  assert.ok(logs.includes("deleted release/w"));
});

// ---------------------------------------------------------------- metrics
test("metrics: DORA from releases and PR routes, AI first-pass rate from fix commits", () => {
  const pr = (number, headRefName, baseRefName, createdAt, mergedAt, labels = []) => ({ number, headRefName, baseRefName, createdAt, mergedAt, labels: labels.map((name) => ({ name })) });
  const s = summarize({
    days: 14,
    prs: [
      pr(1, "issue-1", "release/2026-w43", "2026-10-01T00:00:00Z", "2026-10-01T04:00:00Z", ["review:pass"]),
      pr(2, "issue-2", "release/2026-w43", "2026-10-01T00:00:00Z", "2026-10-01T10:00:00Z", ["review:pass"]),
      pr(3, "issue-3", "main", "2026-10-02T00:00:00Z", "2026-10-02T02:00:00Z"),          // hotfix
      pr(4, "release/2026-w43", "main", "2026-10-03T00:00:00Z", "2026-10-03T01:00:00Z"),  // release: not a story
      pr(5, "issue-5", "release/2026-w43", "2026-10-03T00:00:00Z", null),                 // still open
    ],
    releases: [{ tagName: "v1" }, { tagName: "v2" }],
    runs: [
      { name: "ci", conclusion: "success", run_started_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:10:00Z" },
      { name: "ci", conclusion: "failure", run_started_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:20:00Z" },
      { name: "ci", conclusion: "skipped", run_started_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:01Z" },
    ],
    fixCommits: { 2: 1 },
  });
  assert.deepEqual(s.counts, { features: 2, hotfixes: 1, releases: 2 });
  assert.equal(s.dora.deploymentsPerWeek, 1);
  assert.equal(s.dora.leadTimeHours, 7);
  assert.equal(s.dora.changeFailureRate, 50);
  assert.equal(s.dora.timeToRestoreHours, 2);
  assert.equal(s.ai.passedFirstReview, 50);
  assert.deepEqual(s.pipeline.ci, { runs: 2, successRate: 50, medianMinutes: 15, p90Minutes: 20 });
  assert.match(toMarkdown(s), /\| ci \| 2 \| 50% \| 15 \|/);
});

// ---------------------------------------------------------------- AI flags, models, Jev triage
test("AI flags are off unless set to true; models are the cheapest per role, AI_MODEL overrides", () => {
  assert.deepEqual(names.aiFeatures({}), { plan: false, implement: false, review: false, fix: false, uiTest: false, autoChain: false, triage: false });
  assert.equal(names.aiFeatures({ AI_REVIEW: "true", AI_FIX: "yes" }).review, true);
  assert.equal(names.aiFeatures({ AI_REVIEW: "true", AI_FIX: "yes" }).fix, false);
  assert.match(verdict.modelFor("review", ""), /sonnet/);   // Haiku made false blockers (PR #144)
  assert.match(verdict.modelFor("implement", ""), /sonnet/);
  assert.equal(verdict.modelFor("review", "claude-opus-5-5"), "claude-opus-5-5");
});

const fakeJev = (answers, status = 200) => typesafeJev("apik-test", async (url, init) => {
  fakeJev.last = JSON.parse(init.body);
  return { ok: status === 200, status, json: async () => ({ model: "jev-1.13.0", answers, usage: { input_tokens: 10 } }) };
});

test("Jev never throws: no key, HTTP errors, timeouts and junk all fall back", async () => {
  assert.deepEqual(await typesafeJev("")({}, {}), { ok: false, reason: "no-key" });
  assert.equal((await fakeJev({}, 429)({}, {})).reason, "rate_limited");
  assert.equal((await fakeJev({}, 500)({}, {})).reason, "http_error");
  const boom = typesafeJev("k", async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); });
  assert.equal((await boom({}, {})).reason, "timeout");
  const junk = typesafeJev("k", async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }));
  assert.equal((await junk({}, {})).reason, "bad_shape");
});

test("UI failure triage: confident answers classify, anything else is unknown", async () => {
  const t = await triageUiFailure(fakeJev({ kind: { type: "choice", choice: "flake", confidence: 0.9 } }), { log: "Timeout 30000ms exceeded waiting for login" });
  assert.equal(t.kind, "flake");
  assert.ok(fakeJev.last.questions.kind.criteria.feature);
  assert.equal((await triageUiFailure(fakeJev({ kind: { type: "choice", choice: "test", confidence: 0.4 } }), { log: "x" })).kind, "unknown");
  assert.equal((await triageUiFailure(typesafeJev(""), { log: "x" })).kind, "unknown");
});

test("review triage: code and access changes always reviewed; only confident low risk skips; any failure reviews", async () => {
  const low = fakeJev({ risk: { type: "score", score: 0.4, confidence: 0.8 } });
  assert.equal((await triageReview(low, { files: ["force-app/main/default/classes/A.cls"], diff: "" })).review, true);
  assert.equal((await triageReview(low, { files: ["force-app/main/default/permissionsets/P.permissionset-meta.xml"], diff: "" })).review, true);
  assert.equal((await triageReview(low, { files: ["force-app/main/default/flows/F.flow-meta.xml"], diff: "" })).review, true);   // a Flow is logic
  assert.equal((await triageReview(low, { files: ["README.md"], diff: "" })).review, false);
  assert.equal((await triageReview(low, { files: ["force-app/main/default/objects/Account/fields/X__c.field-meta.xml"], diff: "+<label>X</label>" })).review, false);
  const high = fakeJev({ risk: { type: "score", score: 2.6, confidence: 0.8 } });
  assert.equal((await triageReview(high, { files: ["force-app/main/default/objects/Account/fields/X__c.field-meta.xml"], diff: "" })).review, true);
  assert.equal((await triageReview(typesafeJev(""), { files: ["force-app/main/default/objects/Account/fields/X__c.field-meta.xml"], diff: "" })).review, true);
});

test("AI cost: per role from transcripts, totals rounded to cents", () => {
  const c = aiCost([
    { role: "review", total_cost_usd: 0.0896, num_turns: 6, duration_ms: 60000 },
    { role: "review", total_cost_usd: 0.11, num_turns: 8, duration_ms: 120000 },
    { role: "implement", total_cost_usd: 1.234, num_turns: 42, duration_ms: 600000 },
  ]);
  assert.deepEqual(c.byRole.review, { runs: 2, usd: 0.2, perRunUsd: 0.1, medianTurns: 7, medianMinutes: 1.5 });
  assert.deepEqual(c.total, { runs: 3, usd: 1.43 });
  const md = toMarkdown(summarize({ days: 7, prs: [], releases: [], runs: [], transcripts: [{ role: "review", total_cost_usd: 0.09, num_turns: 6, duration_ms: 1 }] }));
  assert.match(md, /\| review \| 1 \| \$0\.09 \|/);
});

// ---------------------------------------------------------------- story card
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

test("board: stage follows the story; moving a card adds it and sets Status", async () => {
  assert.equal(board.stageOf({}), "Building");
  assert.equal(board.stageOf({ pr: { state: "OPEN" } }), "In review");
  assert.equal(board.stageOf({ pr: { state: "OPEN" }, approved: true }), "Approved");
  assert.equal(board.stageOf({ pr: { state: "MERGED", baseRefName: "release/w" } }), "In staging");
  assert.equal(board.stageOf({ pr: { state: "MERGED", baseRefName: "main" } }), "Live");
  assert.equal(board.stageOf({ pr: { state: "MERGED", baseRefName: "release/w" }, shipped: true }), "Live");
  const calls = [];
  const graphql = async (q, v) => {
    calls.push(v);
    if (q.includes("organization")) return { organization: { projectV2: { id: "P", field: { id: "F", options: board.STAGES.map((n, i) => ({ id: `o${i}`, name: n })) } } } };
    if (q.includes("addProjectV2ItemById")) return { addProjectV2ItemById: { item: { id: "I" } } };
    return {};
  };
  assert.deepEqual(await board.moveCard({ graphql, org: "o", project: "3", issueNodeId: "N", stage: "In staging" }), { item: "I", stage: "In staging" });
  assert.deepEqual(calls[2], { p: "P", i: "I", f: "F", o: "o4" });
});

test("managed packages: installed before the source, with an install key from the env; bad ids rejected", async () => {
  const { sf, calls } = fakeSf([]);
  const seen = [];
  const spy = (args, o) => { seen.push(args); return sf(args, o); };
  const r = orgRegistry({ sf: spy, log: () => {}, sleep: () => {}, packages: [{ name: "DocuSign", id: "04t000000000001AAA", keyEnv: "DS_KEY" }], env: { DS_KEY: "k", BASELINE: "off", SEED: "off" } });
  r.ensure("story:12");
  const order = calls.filter((c) => /^(org create|package install|project deploy)/.test(c));
  // a shape org gets "log in as" and its roles rebuilt (settings and role deploys), then the packages BEFORE the source
  assert.equal(order[0], "org create scratch");
  assert.ok(order.indexOf("package install --package") < order.lastIndexOf("project deploy start"), order.join(" > "));
  assert.equal(order.at(-1), "project deploy start");
  assert.ok(seen.find((a) => a[1] === "install").includes("--installation-key"));
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const f = `${mkdtempSync(`${tmpdir()}/pk-`)}/packages.json`;
  writeFileSync(f, JSON.stringify([{ name: "X", id: "not-an-id" }]));
  assert.throws(() => packageList(f), /needs a package version id/);
  assert.deepEqual(packageList(`${f}.missing`), []);
});

// ---------------------------------------------------------------- test runs
const src = {
  "force-app/c/AccountSelector.cls": "public class AccountSelector {}",
  "force-app/c/AccountSelectorTest.cls": "@isTest class AccountSelectorTest { AccountSelector s; }",
  "force-app/c/CaseHandler.cls": "public class CaseHandler {}",
  "force-app/c/CaseHandlerTest.cls": "@IsTest class CaseHandlerTest { CaseHandler h; Case c; }",
  "force-app/c/Orphan.cls": "public class Orphan {}",
  "force-app/t/CaseTrigger.trigger": "trigger CaseTrigger on Case (before insert) {}",
  "force-app/f/flows/Web_Priority.flow-meta.xml": "<Flow><start><object>Case</object></start></Flow>",
  "force-app/f/flowtests/Web_Medium.flowtest-meta.xml": "<FlowTest><flowApiName>Web_Priority</flowApiName></FlowTest>",
  "force-app/o/Account/fields/Tier__c.field-meta.xml": "<CustomField/>",
};
const files = Object.keys(src), read = (p) => src[p] || "";
const pick = (changed, extra = {}) => tests.selectTests({ changed, files, read, ...extra });

test("test selection: only what a change needs, everything when in doubt", () => {
  assert.equal(pick([]).mode, "none");
  assert.deepEqual(pick(["force-app/c/AccountSelector.cls"]).apex, ["AccountSelectorTest"]);
  assert.deepEqual(pick(["force-app/c/CaseHandlerTest.cls"]).apex, ["CaseHandlerTest"]);
  assert.deepEqual(pick(["force-app/t/CaseTrigger.trigger"]).apex, ["CaseHandlerTest"]);           // names its object
  const flow = pick(["force-app/f/flows/Web_Priority.flow-meta.xml"]);
  assert.deepEqual([flow.apex, flow.flows], [["CaseHandlerTest"], ["Web_Priority.Web_Medium"]]);
  const five = pick(["force-app/c/AccountSelector.cls", "force-app/c/CaseHandler.cls", "force-app/f/flows/Web_Priority.flow-meta.xml"]);
  assert.equal(five.mode, "relevant");
  assert.deepEqual(five.apex, ["AccountSelectorTest", "CaseHandlerTest"]);
  assert.equal(pick(["force-app/c/Orphan.cls"]).mode, "all");                                        // no test names it
  assert.equal(pick(["force-app/o/Account/fields/Tier__c.field-meta.xml"]).mode, "all");            // other metadata
  assert.equal(pick(["force-app/c/AccountSelector.cls"], { deleted: ["force-app/c/Old.cls"] }).mode, "all");
  assert.deepEqual(pick(["force-app/c/AccountSelector.cls"], { mode: "all" }).flows, ["Web_Priority.Web_Medium"]);   // all includes every Flow test
  assert.deepEqual(tests.changedCode(["force-app/c/AccountSelector.cls", "force-app/c/AccountSelectorTest.cls"], files, read), ["AccountSelector"]);
});

test("test run: polls with live progress, collects failures and coverage; verdict and check output", () => {
  let polls = 0;
  const sf = (args) => {
    const k = args.slice(0, 3).join(" ");
    if (k === "apex run test") return { testRunId: "707X" };
    if (k.startsWith("data query") && args.at(-1).includes("ApexTestQueueItem")) return { records: polls++ < 1 ? [{ Status: "Processing", ApexClass: { Name: "CaseHandlerTest" } }] : [{ Status: "Completed", ApexClass: { Name: "CaseHandlerTest" } }] };
    if (k.startsWith("data query")) return { records: [{ Outcome: "Pass", MethodName: "a", ApexClass: { Name: "CaseHandlerTest" } }, { Outcome: "Fail", MethodName: "b", Message: "Expected Medium", StackTrace: "Class.CaseHandlerTest.b: line 12, column 1", ApexClass: { Name: "CaseHandlerTest" } }] };
    if (k === "apex get test") return { summary: { orgWideCoverage: "80%" }, coverage: { coverage: [{ name: "CaseHandler", coveredPercent: 60 }] } };
    if (k === "flow run test") return { testRunId: "707F" };
    if (k === "flow get test") return { summary: { outcome: "Passed" }, tests: [{ FullName: "Web_Priority.Web_Medium", Outcome: "Pass" }] };
    throw new Error(`unexpected ${k}`);
  };
  const plan = { mode: "relevant", apex: ["CaseHandlerTest"], flows: ["Web_Priority.Web_Medium"], why: "2 changed file(s)" };
  const seen = [];
  const st = tests.runTests({ sf }, { alias: "o", plan, sleep: () => {}, onProgress: (s) => seen.push(`${s.phase}:${s.apex.classesDone}/${s.apex.classes}`) });
  assert.deepEqual(seen, ["apex:0/1", "apex:1/1", "flows:1/1", "done:1/1"]);
  assert.equal(st.apex.failed, 1);
  assert.equal(st.flows.passed, 1);
  const r = tests.verdict(st, { plan, changedCode: ["CaseHandler"] });
  assert.deepEqual(r.reasons, ["1 Apex test(s) failed", "CaseHandler coverage 60% is below 75%"]);
  const out = tests.checkOutput(st, { plan, result: r, classPath: (c) => `force-app/c/${c}.cls` });
  assert.equal(out.title, "Failed: Apex 1/2 (1/1 classes) · Flow 1/1");
  assert.deepEqual(out.annotations[0], { path: "force-app/c/CaseHandlerTest.cls", start_line: 12, end_line: 12, annotation_level: "failure", title: "CaseHandlerTest.b", message: "Expected Medium" });
  assert.match(tests.summaryMarkdown(st, { plan, result: r }), /\| CaseHandler \| 60% \|/);
});

// ---------------------------------------------------------------- production validation
test("production validation: RunRelevantTests, live progress, fallback to every test class when the org refuses it", () => {
  const calls = [];
  const fakeIo = (rejectStart, reports) => ({
    sf: (args) => {
      calls.push(args.join(" "));
      if (args[2] === "validate") return rejectStart && args.includes("RunRelevantTests") ? null : { id: "0AfX" };
      return reports.shift();
    },
  });
  const progress = [];
  const ok = production.validate(fakeIo(false, [
    { status: "InProgress", numberComponentsDeployed: 3, numberComponentsTotal: 26, numberTestsCompleted: 0, numberTestsTotal: 5 },
    { status: "Succeeded", done: true, numberComponentsDeployed: 26, numberComponentsTotal: 26, numberTestsCompleted: 5, numberTestsTotal: 5 },
  ]), { source: ["-d", "force-app"], allTests: ["A", "B"], sleep: () => {}, onProgress: (p) => progress.push(`${p.components.done}/${p.tests.done}`) });
  assert.equal(ok.ok, true);
  assert.equal(ok.level, "RunRelevantTests");
  assert.deepEqual(progress, ["3/0", "26/5"]);
  calls.length = 0;
  const fb = production.validate(fakeIo(true, [{ status: "Succeeded", done: true }]), { source: ["-d", "force-app"], allTests: ["A", "B"], sleep: () => {} });
  assert.equal(fb.level, "all");
  assert.match(calls[1], /--test-level RunSpecifiedTests --tests A --tests B/);
  const failed = production.validate(fakeIo(false, [{ status: "Failed", done: true, details: { componentFailures: { fullName: "X", componentType: "ApexClass", problem: "bad" }, runTestResult: { failures: [{ name: "T", methodName: "m", message: "boom" }] } } }]), { source: [], sleep: () => {} });
  assert.equal(failed.ok, false);
  const out = production.progressOutput(failed, { done: true, deployStatusUrl: "https://x/ds" });
  assert.match(out.title, /^Failed:/);
  assert.match(out.text, /\| component \| ApexClass X \| bad \|/);
  assert.match(out.text, /\| test \| T\.m \| boom \|/);
});

// ---------------------------------------------------------------- UAT
test("UAT: with UAT_ENABLED a release needs a sign-off on its current code; off, nothing changes", () => {
  const f = open(fixture(26)), head = f.pr.headRefOid;
  const st = (state, sha = head, description = "") => ({ sha, context: gate.STATUS.uat, state, description, created_at: "2026-10-05T00:00:00Z", creator: { login: "github-actions[bot]" } });
  assert.deepEqual(gate.evaluate({ ...f, uat: false }).reasons, []);
  assert.match(gate.evaluate({ ...f, uat: true }).reasons.join(), /not in UAT yet/);
  assert.match(gate.evaluate({ ...f, uat: true, statuses: [st("pending")] }).reasons.join(), /waiting for UAT sign-off/);
  assert.match(gate.evaluate({ ...f, uat: true, statuses: [st("failure", head, "totals wrong")] }).reasons.join(), /UAT failed \(totals wrong\)/);
  const older = "0000000000000000000000000000000000000009";
  assert.match(gate.evaluate({ ...f, uat: true, statuses: [st("success", older)], diffsToHead: { [older]: ["force-app/x.cls"] } }).reasons.join(), /older version/);
  assert.deepEqual(gate.evaluate({ ...f, uat: true, statuses: [st("success")] }).reasons, []);
  const o = names.orgFor("uat:2026-w45");
  assert.deepEqual([o.alias, o.description, o.lock, o.days], ["uat", "uat-2026-w45", "org-uat", 30]);
});

// ---------------------------------------------------------------- scratch org cleanup
test("orphans: dead CI orgs, closed stories, and staging or UAT of sprints no longer open; nothing else", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  const r = (Description, hoursAgo = 1) => ({ Description, SignupUsername: `${Description}@x`, CreatedDate: new Date(now - hoursAgo * 3600e3).toISOString() });
  const orphans = findOrphans([
    r("ci-371", 5), r("ci-372", 1), r("issue-12"), r("issue-13"), r("LIFE-7"),
    r("staging-2026-w44"), r("uat-2026-w44"), r("staging-2026-w45"), r("uat-2026-w45"), r("someone's own org"),
  ], { now, openSprint: "2026-w45", isStoryClosed: (d) => ["issue-12", "LIFE-7"].includes(d) });
  assert.deepEqual(orphans.map((o) => o.description), ["ci-371", "issue-12", "LIFE-7", "staging-2026-w44", "uat-2026-w44"]);
  assert.match(orphans[0].why, /5 h old/);
  assert.deepEqual(findOrphans([r("staging-2026-w45")], { now, openSprint: null }).map((o) => o.why), ["sprint no longer open"]);   // no sprint open
});

test("removing an org goes through the Dev Hub record, never a login to the org; tagged deletes find half-made orgs", () => {
  const calls = [];
  const sf = (args) => {
    calls.push(args.join(" "));
    if (args[1] === "query") return { records: [{ Description: "issue-12", SignupUsername: "u12@x" }, { Description: "ci-9", SignupUsername: "c9@x" }] };
    return {};
  };
  const r = orgRegistry({ sf, log: () => {}, sleep: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } });
  assert.equal(r.remove("story:12"), true);
  assert.equal(r.removeTagged("ci-9"), 1);
  assert.ok(calls.some((c) => c.includes("data delete record -o devhub -s ActiveScratchOrg -w SignupUsername='u12@x'")));
  assert.ok(calls.some((c) => c.includes("SignupUsername='c9@x'")));
  assert.ok(!calls.some((c) => c.startsWith("org login") || c.startsWith("org delete")));
});

// ---------------------------------------------------------------- workflow wiring
test("every workflow that runs the Claude agent allows the pipeline's own bots (commands and auto-chain act as the App)", async () => {
  const { readdirSync } = await import("node:fs");
  const dir = new URL("../../.github/workflows/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml"))) {
    const y = readFileSync(new URL(f, dir), "utf8");
    const agents = y.split("uses: ./.pipeline/.github/actions/claude-agent").length - 1;
    const allowed = (y.match(/allowed-bots: \$\{\{ vars\.PIPELINE_BOTS \}\}/g) || []).length;
    assert.equal(allowed, agents, `${f}: ${agents} agent step(s), ${allowed} with allowed-bots`);
  }
});

// ---------------------------------------------------------------- the gate's own status and emergency merges
test("pipeline/gate: success only when mergeable; failure when something failed; pending while waiting", () => {
  assert.deepEqual(gate.gateStatus({ mergeable: true, reasons: [] }), { state: "success", description: "All requirements met: the gate merges it" });
  assert.deepEqual(gate.gateStatus({ mergeable: false, reasons: ["not approved (Review changes > Approve)", "AI review has not run on this code"] }), { state: "pending", description: "not approved (+1 more)" });
  assert.equal(gate.gateStatus({ mergeable: false, reasons: ["UI test did not pass (failure)"] }).state, "failure");
  assert.ok(gate.gateStatus({ mergeable: false, reasons: ["x".repeat(300)] }).description.length <= 139);
});

test("follow-ups after an emergency merge are the ones the gate would have started", () => {
  assert.deepEqual(gate.followUps({ headRefName: "issue-5", baseRefName: "release/w" }), ["staging", "delete-story-org"]);
  assert.deepEqual(gate.followUps({ headRefName: "issue-5", baseRefName: "main" }), ["release", "delete-story-org"]);
  assert.deepEqual(gate.followUps({ headRefName: "release/w", baseRefName: "main" }), ["release"]);
  assert.deepEqual(gate.followUps({ headRefName: "fix/x", baseRefName: "main" }, ["pipeline/a.mjs"]), []);
  assert.deepEqual(gate.followUps({ headRefName: "fix/x", baseRefName: "main" }, ["force-app/a.cls"]), ["release"]);
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

// ---------------------------------------------------------------- build plan and readiness
test("plan context: the latest build plan and only people's answers after it become part of the spec", () => {
  const c = (author, body, created) => ({ author, body, created });
  const comments = [
    c("ann", "first thoughts", "1"),
    c("__owner__-pipeline[bot]", `${plans.PLAN_MARK}\n### Build plan (size M)\nold plan`, "2"),
    c("ann", "answer to the old plan", "3"),
    c("__owner__-pipeline[bot]", `${plans.PLAN_MARK}\n### Build plan (size M)\nnew plan\n### Open questions\n1. Which date?`, "4"),
    c("ann", "/start", "5"),
    c("ann", "1. Use the Close Date", "6"),
    c("github-actions[bot]", "<!-- pipeline:story-card -->", "7"),
  ];
  const ctx = plans.planContext(comments);
  assert.match(ctx.plan, /new plan/);
  assert.deepEqual(ctx.answers, [{ author: "ann", body: "1. Use the Close Date" }]);
  const md = plans.storyFile({ key: "84", title: "T", url: "u", body: "story body" }, ctx);
  assert.match(md, /## Agreed plan[\s\S]*new plan[\s\S]*## Answers[\s\S]*\*\*ann:\*\* 1\. Use the Close Date/);
  assert.doesNotMatch(plans.storyFile({ key: "1", title: "T", url: "u", body: "b" }, { plan: null, answers: [] }), /Agreed plan/);
});

test("plan comment: the next step follows from the size and the open questions; criteria parse from the story", () => {
  const withQs = plans.planComment("### Proposed build\nx\n### Open questions\n1. A?\n2. B?\nPLAN-SIZE: M");
  assert.match(withQs, /### Build plan \(size M\)/);
  assert.match(withQs, /answer the 2 questions in a comment, then comment \*\*\/plan\*\*/);
  assert.doesNotMatch(withQs, /PLAN-SIZE/);
  assert.match(plans.planComment("### Proposed build\nx\n### Open questions\nnone\nPLAN-SIZE: S"), /\*\*Next:\*\* ready\. Comment \*\*\/start\*\*/);
  assert.match(plans.planComment("### Proposed build\nx\nPLAN-SIZE: S", { started: true }), /\*\*Next:\*\* ready\. Comment \*\*\/build\*\*/);   // already started
  assert.match(plans.planComment("### Proposed build\nx\nPLAN-SIZE: S"), /\(size S\)\n\n### Proposed build/);
  assert.deepEqual(plans.criteria("### Summary\nx\n\n### Acceptance criteria\n- one\n* two\n\n### Where to see it\n- not this"), ["one", "two"]);
  assert.equal(verdict.modelFor("plan", ""), "claude-sonnet-5-5");
  assert.match(verdict.instructions("plan"), /PLAN-SIZE: S/);
});

test("readiness: vague criteria and large stories are flagged; Jev down or all fine says nothing", async () => {
  const jev = (answers) => typesafeJev("apik-x", async () => ({ ok: true, status: 200, json: async () => ({ model: "jev-1", answers }) }));
  const r = await storyReadiness(jev({ c1: { type: "noul", noul: 0.9 }, c2: { type: "noul", noul: 0.2 }, size: { type: "choice", choice: "large", confidence: 0.8 } }), { criteria: ["Customer Since is set to the Close Date", "It works well"] });
  assert.deepEqual(r.weak.map((w) => w.n), [2]);
  assert.equal(r.size, "large");
  assert.match(plans.readinessComment(r), /Criterion 2 may not be testable \(20%\): "It works well"[\s\S]*large story/);
  assert.equal(await storyReadiness(typesafeJev(""), { criteria: ["x"] }), null);
  assert.equal(plans.readinessComment({ weak: [], size: "small" }), null);
});

test("the Build plan comment appears at once while Claude plans, with a link to watch", () => {
  const body = plans.planPending({ state: "running", what: "Claude is planning the build", url: "https://x/runs/1" });
  assert.ok(body.startsWith(plans.PLAN_MARK));
  assert.match(body, /⏳ \*\*Now:\*\* Claude is planning the build · \*\*\[watch it live\]\(https:\/\/x\/runs\/1\)\*\*/);
  assert.equal(plans.planContext([{ author: "app/x", body, created: "1" }]).plan, null);   // a placeholder is never the plan
  const real = `${plans.PLAN_MARK}\n### Build plan (size S)\nthe plan`;
  assert.match(plans.planContext([{ author: "app/x", body: real, created: "1" }, { author: "app/x", body, created: "2" }]).plan, /the plan/);   // a re-plan in progress keeps the last agreed one
  assert.match(plans.planPending({ state: "failed", what: "Claude could not produce a plan", url: "u" }), /❌ \*\*Failed:\*\*[\s\S]*\/plan\*\* to try again/);
});

test("a full run never depends on the diff; unfinished or empty runs fail", () => {
  assert.equal(pick([], { mode: "all" }).mode, "all");   // staging: --all with no changes against HEAD
  const plan = { mode: "all", apex: [], flows: [], why: "" };
  const base = { apex: { ran: 0, failed: 0, finished: false, failures: [] }, flows: { ran: 0, failed: 0, finished: true, failures: [] }, coverage: {}, orgWide: null };
  assert.match(tests.verdict(base, { plan }).reasons.join(), /did not finish/);
  assert.match(tests.verdict({ ...base, apex: { ...base.apex, finished: true } }, { plan }).reasons.join(), /no Apex tests ran/);
  assert.match(tests.verdict({ ...base, apex: { ran: 5, failed: 0, finished: true, failures: [] } }, { plan }).reasons.join(), /coverage is unknown/);
  assert.equal(tests.verdict({ ...base, apex: { ran: 5, failed: 0, finished: true, failures: [] }, orgWide: 90 }, { plan }).ok, true);
  const flowsOnly = { mode: "relevant", apex: [], flows: ["F.T"], why: "" };
  assert.match(tests.verdict({ ...base, flows: { ...base.flows, finished: false } }, { plan: flowsOnly }).reasons.join(), /Flow tests did not finish/);
});

test("the pipeline's identity is exact: look-alike users and other bots are not trusted", () => {
  for (const ok of ["github-actions", "github-actions[bot]", "app/github-actions", "__owner__-pipeline[bot]", "app/__owner__-pipeline"]) assert.equal(names.isPipelineAuthor(ok), true, ok);
  for (const bad of ["evil-pipeline", "someone[bot]", "app/other", "dependabot[bot]", "__owner__-pipeline2", ""]) assert.equal(names.isPipelineAuthor(bad), false, bad);
  const c = (login, body) => ({ author: { login }, createdAt: "2026-10-05T10:00:00Z", body });
  assert.equal(verdict.reviewVerdict(verdict.reviewComments([c("evil-pipeline", "AI-REVIEW: PASS")], "2026-10-05T09:00:00Z")), null);
  assert.deepEqual(names.touchesPipeline(["package.json", "force-app/x.cls"]), ["package.json"]);
});

// ---------------------------------------------------------------- access and context
const repo = (map) => ({ files: Object.keys(map), read: (p) => map[p] ?? "" });
const O = "force-app/main/default";

test("access check: profiles, admin permissions, View All and unexplained without-sharing are blockers", () => {
  const r = repo({
    [`${O}/profiles/Admin.profile-meta.xml`]: "<Profile/>",
    [`${O}/permissionsets/Ops.permissionset-meta.xml`]: "<PermissionSet><userPermissions><enabled>true</enabled><name>ModifyAllData</name></userPermissions><objectPermissions><object>Case</object><viewAllRecords>true</viewAllRecords></objectPermissions><userPermissions><enabled>true</enabled><name>ApiEnabled</name></userPermissions></PermissionSet>",
    [`${O}/classes/Plain.cls`]: "public class Plain {\n}",
    [`${O}/classes/Wide.cls`]: "public without sharing class Wide {\n}",
    [`${O}/classes/Ok.cls`]: "// sharing: counts every case for the dashboard total, which users may see but not open\npublic without sharing class Ok {\n}",
    [`${O}/classes/PlainTest.cls`]: "@IsTest\nprivate class PlainTest { }",
    [`${O}/classes/Shape.cls`]: "public interface Shape { }",
    [`${O}/flows/Screen.flow-meta.xml`]: "<Flow><runInMode>SystemModeWithoutSharing</runInMode><description>Shows totals</description></Flow>",
  });
  const f = access.findings({ ...r, changed: r.files });
  const rules = f.filter((x) => x.level === "blocker").map((x) => `${x.rule} ${x.file.split("/").pop()}`).sort();
  assert.deepEqual(rules, ["admin-permission Ops.permissionset-meta.xml", "flow-without-sharing Screen.flow-meta.xml", "profile Admin.profile-meta.xml",
    "sharing-keyword Plain.cls", "view-all Ops.permissionset-meta.xml", "without-sharing Wide.cls"]);
  assert.ok(!f.some((x) => /ApiEnabled/.test(x.message)), "ordinary permissions are fine");
  assert.match(access.toMarkdown(f), /❌ \| profile/);
});

test("access check: a new field or object needs a permission set; a new object should start Private; exceptions are reviewed config", () => {
  const field = `${O}/objects/Account/fields/Score__c.field-meta.xml`, req = `${O}/objects/Account/fields/Code__c.field-meta.xml`;
  const obj = `${O}/objects/Visit__c/Visit__c.object-meta.xml`;
  const r = repo({ [field]: "<CustomField><type>Number</type></CustomField>", [req]: "<CustomField><required>true</required></CustomField>",
    [obj]: "<CustomObject><sharingModel>ReadWrite</sharingModel><externalSharingModel>Read</externalSharingModel></CustomObject>",
    [`${O}/permissionsets/Visits.permissionset-meta.xml`]: "<PermissionSet><objectPermissions><object>Visit__c</object></objectPermissions></PermissionSet>" });
  const f = access.findings({ ...r, changed: [field, req, obj], added: [field, req, obj] });
  assert.deepEqual(f.filter((x) => x.level === "blocker").map((x) => x.rule), ["field-permission"]);   // required fields cannot have field access entries
  assert.equal(f.filter((x) => x.rule === "object-owd").length, 2);
  const allowed = access.findings({ ...r, changed: [field], added: [field], exceptions: [{ file: field, rule: "field-permission", why: "integration only" }] });
  assert.equal(allowed[0].level, "warning");
  assert.match(allowed[0].message, /allowed: integration only/);
  const granted = repo({ [field]: "<CustomField/>", [`${O}/permissionsets/S.permissionset-meta.xml`]: "<fieldPermissions><field>Account.Score__c</field></fieldPermissions>" });
  assert.deepEqual(access.findings({ ...granted, changed: [field], added: [field] }), []);
});

test("access check: user-facing queries in user mode, and a permission test that runs as a limited user", () => {
  const ctl = `${O}/classes/Ctl.cls`;
  const r = repo({ [ctl]: "public with sharing class Ctl {\n @AuraEnabled public static Integer n() { return [SELECT COUNT() FROM Case]; }\n}",
    [`${O}/classes/CtlTest.cls`]: "@IsTest private class CtlTest { @IsTest static void t() { Ctl.n(); } }" });
  assert.deepEqual(access.findings({ ...r, changed: [ctl] }).map((x) => `${x.level} ${x.rule}`), ["warning user-mode", "warning permission-test"]);
});

test("context pack: the objects a story names (capitalised for plain English words, fields bring their object)", () => {
  const files = [`${O}/objects/Account/fields/Customer_Since__c.field-meta.xml`, `${O}/objects/Visit__c/Visit__c.object-meta.xml`];
  assert.deepEqual(pack.objectsFor({ text: "Fill Customer Since when an opportunity is won, just in case", files }), ["Account", "Opportunity"]);
  assert.deepEqual(pack.objectsFor({ text: "Escalate the Case; log a visit", files }), ["Case", "Visit__c"]);
  assert.deepEqual(pack.objectsFor({ text: "nothing here", files, changed: [`${O}/objects/Visit__c/fields/X__c.field-meta.xml`] }), ["Visit__c"]);
});

test("context pack: what exists per object and production's sharing model, so the agent extends instead of duplicating", () => {
  const r = repo({
    [`${O}/objects/Case/fields/Escalated__c.field-meta.xml`]: "",
    [`${O}/triggers/CaseTrigger.trigger`]: "trigger CaseTrigger on Case (before insert) { }",
    [`${O}/flows/Case_Prio.flow-meta.xml`]: "<Flow><start><object>Case</object><triggerType>RecordBeforeSave</triggerType><recordTriggerType>Create</recordTriggerType></start><status>Active</status></Flow>",
    [`${O}/classes/CaseHandler.cls`]: "public with sharing class CaseHandler { Case c; }",
    [`${O}/classes/CaseHandlerTest.cls`]: "@IsTest class CaseHandlerTest { Case c; }",
    [`${O}/permissionsets/Esc.permissionset-meta.xml`]: "<fieldPermissions><field>Case.Escalated__c</field></fieldPermissions>",
  });
  const md = pack.pack({ ...r, objects: ["Case"], owd: pack.owdFrom([{ QualifiedApiName: "Case", InternalSharingModel: "ReadWrite", ExternalSharingModel: "Private" }]) });
  for (const want of ["internal **ReadWrite**", "must not rely on this", "Escalated__c", "Triggers: CaseTrigger", "Case_Prio (RecordBeforeSave Create, runs as system)",
    "CaseHandler (with sharing)", "Tests that name it: CaseHandlerTest", "grant it: Esc"]) assert.ok(md.includes(want), want);
  assert.match(pack.owdQuery(["Case", "Bad'; DROP"]), /IN \('Case','BadDROP'\)/);
});

test("rules that steer checks and agents are pipeline paths; the plan asks for an Access section", () => {
  assert.deepEqual(names.touchesPipeline(["CLAUDE.md", "REVIEW.md", "code-analyzer.yml", "README.md"]), ["CLAUDE.md", "REVIEW.md", "code-analyzer.yml"]);
  assert.match(verdict.instructions("plan"), /### Access/);
});

test("every agent reads the story with its context pack; CI runs the access check", () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  for (const n of ["ai-plan", "ai-implement", "ai-review", "ai-fix", "ui-test"]) assert.match(wf(n), /tracker story "?\$[A-Z_]*KEY"? --pack/, n);
  assert.match(wf("ci"), /access check --base/);
  assert.match(wf("ai-implement"), /merge -q --no-edit "origin\/\$BASE"/);
});

// ---------------------------------------------------------------- shipping keyed by commit
const SHA = "a".repeat(40), TREE = "t".repeat(40);

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

test("close-out counts what is in the shipped SHA and not in the release before it, wherever main has moved since", async () => {
  const inside = { m1: [SHA], m2: [SHA, "v2026.10.04-8"], m3: [] };   // m3 merged after the shipped SHA
  const git = (args) => {
    if (args[0] === "merge-base") return inside[args[2]]?.includes(args[3]) ? "" : null;
    if (args[0] === "for-each-ref") return "";
    return "";
  };
  const gh = () => [{ number: 1, headRefName: "issue-1", mergeCommit: { oid: "m1" } }, { number: 2, headRefName: "issue-2", mergeCommit: { oid: "m2" } }, { number: 3, headRefName: "issue-3", mergeCommit: { oid: "m3" } }];
  const f = await closeout.gather({ gh, git }, { sprintStories: async () => [] }, { sha: SHA, previous: "v2026.10.04-8" });
  assert.deepEqual(f.mergedIntoMain.map((p) => p.number), [1]);
});

test("a production validation that cannot start says why", () => {
  const io = { sf: () => { throw new Error("INVALID_SESSION_ID: expired"); } };
  assert.throws(() => production.validate(io, { source: [], sleep: () => {} }), /RunRelevantTests: INVALID_SESSION_ID: expired \| all: INVALID_SESSION_ID/);
});

test("shipping wiring: the gate passes the SHA and the validated tree; nothing queued is lost; UAT signs only what it runs", () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  assert.match(wf("gate"), /release.yml --ref main -f sha="\$SHA" -f validated_job="\$JOB" -f validated_tree="\$TREE"/);
  assert.match(wf("gate"), /ship candidate --pr/);
  assert.doesNotMatch(wf("gate"), /refs\/pull\/\$\{\{ env.PR \}\}\/merge/);
  assert.match(wf("gate"), /ship renudge --base/);
  assert.match(wf("release"), /run-name: release \$\{\{ inputs.sha/);
  assert.match(wf("release"), /closeout run --tag "\$TAG" --sha "\$SHA"/);
  assert.match(wf("merged"), /-f sha="\$MERGED_SHA"/);
  assert.match(wf("scratch-janitor"), /ship watchdog/);
  assert.match(readFileSync(new URL("../src/actions.mjs", import.meta.url), "utf8"), /startsWith\("In UAT"\)/);
  assert.match(wf("commands"), /pipe.mjs act /);
});

// ---------------------------------------------------------------- lanes and resumable orgs
test("org registry: a live org that never finished is completed, not trusted; a ready one is left alone", () => {
  const live = [{ Description: "issue-12", SignupUsername: "u@x", LoginUrl: "https://s" }];
  const half = fakeSf(live, { ready: false, installed: ["04t000000000001AAA"] });
  const pkgs = [{ name: "A", id: "04t000000000001AAA" }, { name: "B", id: "04t000000000002AAA" }];
  const o = orgRegistry({ sf: half.sf, log: () => {}, sleep: () => {}, packages: pkgs, env: { BASELINE: "off", SEED: "off" } }).ensure("story:12");
  assert.deepEqual([o.created, o.completed], [false, true]);
  assert.ok(!half.calls.includes("org create scratch"));
  assert.equal(half.calls.filter((c) => c === "package install --package").length, 1, "only the missing package");
  assert.ok(half.calls.includes("project deploy start") && half.calls.includes("data update record"));
  const done = fakeSf(live, { ready: true });
  orgRegistry({ sf: done.sf, log: () => {}, sleep: () => {}, packages: pkgs, env: { BASELINE: "off", SEED: "off" } }).ensure("story:12");
  assert.ok(!done.calls.includes("project deploy start") && !done.calls.includes("package install --package"));
});

/** A fake GitHub git-refs API with the atomic create and fast-forward-only update the lane relies on. */
function fakeRefs({ runs = {} } = {}) {
  const refs = {}, commits = { base: { tree: { sha: "T" } } };
  let failClaims = 0;
  let n = 0;
  const api = (method, path, body) => {
    if (method === "GET" && path.endsWith("/commits/main")) return { commit: { tree: { sha: "T" } } };
    if (method === "POST" && path.endsWith("/git/commits") && failClaims > 0) { failClaims--; return { status: 422, message: "tree not found" }; }
    if (method === "POST" && path.endsWith("/git/commits")) { const sha = `c${++n}`; commits[sha] = { message: body.message, parents: body.parents, tree: { sha: body.tree } }; return { sha }; }
    if (method === "GET" && path.includes("/git/commits/")) return commits[path.split("/").pop()];
    if (method === "GET" && path.includes("/actions/runs/")) return { status: runs[path.split("/").pop()] || "in_progress" };
    const name = path.split("/git/")[1];
    if (method === "POST" && path.endsWith("/git/refs")) { if (refs[body.ref]) return { status: 422 }; refs[body.ref] = body.sha; return { ref: body.ref }; }
    if (method === "GET") return refs[name] ? { object: { sha: refs[name] } } : { status: 404 };
    if (method === "PATCH") { if (!commits[body.sha].parents.includes(refs[name])) return { status: 422 }; refs[name] = body.sha; return {}; }
    if (method === "DELETE") { delete refs[name]; return {}; }
    throw new Error(`${method} ${path}`);
  };
  return { api, refs, commits, failClaims: (n) => { failClaims = n; } };
}

test("lane: one holder at a time; the next waits its turn and is never dropped; only the holder releases", () => {
  const f = fakeRefs();
  let t = 0;
  const mk = (run, job) => lane({ api: f.api, repo: "o/r", holder: { run, job, sha: "base" }, now: () => t, sleep: (ms) => { t += ms; }, log: () => {} });
  const a = mk("1", "ci"), b = mk("2", "ai-fix");
  assert.equal(a.acquire("org-issue-12"), true);
  assert.equal(a.acquire("org-issue-12"), true, "a retried step that already holds it");
  assert.throws(() => b.acquire("org-issue-12", { timeoutMinutes: 1, pollSeconds: 20 }), /still busy after 1 minutes \(run 1\)/);
  assert.equal(b.release("org-issue-12"), false, "not the holder");
  assert.equal(a.release("org-issue-12"), true);
  assert.equal(b.acquire("org-issue-12"), true);
});

test("lane: a holder whose run finished (crashed, cancelled) is taken over, by exactly one waiter", () => {
  const f = fakeRefs({ runs: { 1: "completed" } });
  const mk = (run) => lane({ api: f.api, repo: "o/r", holder: { run, job: "j", sha: "base" }, now: () => 0, sleep: () => {}, log: () => {} });
  mk("1").acquire("org-staging");
  const stale = f.refs["refs/locks/org-staging"];
  assert.equal(mk("2").acquire("org-staging"), true);
  assert.match(f.commits[f.refs["refs/locks/org-staging"]].message, /"run":"2"/);
  // a second waiter that saw the same stale holder loses the fast-forward race
  const loser = f.api("PATCH", "repos/o/r/git/refs/locks/org-staging", { sha: f.api("POST", "repos/o/r/git/commits", { message: "{}", tree: "T", parents: [stale] }).sha, force: false });
  assert.equal(loser.status, 422);
});

test("every job that uses a story or staging org holds its lane, and releases it whatever happens", () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  for (const n of ["issue-start", "ai-implement", "ai-fix", "ui-test", "ci", "staging-deploy"]) {
    const y = wf(n);
    const steps = y.split(/\n\s+- (?=name:|uses:|run:|id:|if:)/);
    const takes = steps.filter((x) => /lane acquire/.test(x)).length, gives = steps.filter((x) => /lane release/.test(x));
    assert.ok(takes > 0, `${n} takes a lane`);
    assert.equal(gives.length, takes, `${n} releases every lane it takes`);
    for (const g of gives) assert.match(g, /if: always\(\)/, `${n} releases whatever happens`);
    assert.doesNotMatch(y, /group: (ai-pr-|org-staging|org-\$\{\{)/, `${n} has no GitHub concurrency group on an org`);
  }
});

// ---------------------------------------------------------------- the event log and settings
test("settings come from the one PIPELINE_VARS line (toJSON(vars)); an env var of the same name wins", () => {
  const env = { PIPELINE_VARS: JSON.stringify({ AI_PLAN: "true", AI_REVIEW: "false", UAT_ENABLED: "true", PIPELINE_BOTS: "github-actions,acme-bot" }) };
  assert.equal(names.setting("UAT_ENABLED", env), "true");
  assert.equal(names.setting("AI_REVIEW", { ...env, AI_REVIEW: "true" }), "true");
  assert.equal(names.setting("MISSING", env), "");
  assert.deepEqual([names.aiFeatures(env).plan, names.aiFeatures(env).review], [true, false]);
  assert.equal(names.setting("X", { PIPELINE_VARS: "not json" }), "");
});

test("every workflow passes every repository variable in one line, and lists no switch by hand", () => {
  for (const f of readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter((n) => n.endsWith(".yml"))) {
    const y = readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8");
    assert.match(y, /^  PIPELINE_VARS: \$\{\{ toJSON\(vars\) \}\}/m, f);
    assert.doesNotMatch(y, /^\s+(AI_[A-Z_]+|PIPELINE_BOTS|UAT_ENABLED|BOARD_PROJECT|PROD_TEST_LEVEL): \$\{\{ vars\./m, f);
  }
});

test("events: what happened and where, one new file each; a token that cannot write turns recording off, quietly", () => {
  const e = events.event("tests", { story: "84", ok: true, empty: "", none: null }, { GITHUB_RUN_ID: "9", GITHUB_WORKFLOW: "ci", GITHUB_JOB: "apex" }, new Date("2026-10-05T10:11:12.345Z"));
  assert.deepEqual(e, { v: 1, at: "2026-10-05T10:11:12.345Z", kind: "tests", story: "84", ok: true, run: "9", workflow: "ci", job: "apex" });
  assert.equal(events.pathOf(e, "abc"), "events/2026/10/05/20261005T101112345Z-9-tests-abc.json");
  assert.throws(() => events.event("nonsense"), /Unknown event kind/);
  const puts = [];
  let reply = [{ status: 409 }, {}];
  const rec = events.recorder({ api: (m, p, b) => { puts.push(p); return reply.shift(); }, repo: "o/r", env: {}, sleep: () => {} });
  assert.equal(rec("gate", { pr: 1 }), true);
  assert.equal(puts.length, 2, "a 409 (the branch moved) is retried");
  reply = [{ status: 403 }];
  const notes = [];
  const ro = events.recorder({ api: () => reply.shift(), repo: "o/r", env: {}, log: (m) => notes.push(m) });
  assert.equal(ro("gate", {}), false);
  assert.equal(ro("gate", {}), false, "no second call after a 403");
  assert.equal(notes.length, 1);
});

test("event log: DORA to production, rollbacks as failures, what PRs waited on, org-hours and AI cost", () => {
  const ev = (at, kind, d) => ({ at: `2026-10-0${at}`, kind, ...d });
  const log = [
    ev("1T00:00:00Z", "stage", { story: "84", what: "creating the branch", state: "running" }),
    ev("1T01:00:00Z", "org", { action: "created", org: "issue-84" }),
    ev("1T02:00:00Z", "gate", { pr: 90, mergeable: false, reasons: ['check "deploy and Apex tests (scratch org)" is pending', "no sign-off (approve it, or comment /ship)"] }),
    ev("1T03:00:00Z", "gate", { pr: 90, mergeable: false, reasons: ['check "static checks (no org)" is pending'] }),
    ev("1T03:00:00Z", "gate", { pr: 91, mergeable: false, reasons: ['check "x" is pending'] }),
    ev("1T04:00:00Z", "tests", { story: "84", mode: "relevant", ok: true, seconds: 240 }),
    ev("1T05:00:00Z", "org", { action: "deleted", org: "issue-84" }),
    ev("1T06:00:00Z", "stage", { story: "84", what: "CI (deploy or tests)", state: "failed" }),
    ev("2T00:00:00Z", "agent", { role: "fix", pr: 90, usd: 0.4, turns: 20, minutes: 6 }),
    ev("2T01:00:00Z", "agent", { role: "fix", pr: 90, usd: 0.6, turns: 30, minutes: 8 }),
    ev("2T02:00:00Z", "verdict", { context: "pipeline/ai-review", state: "failure", pr: 90 }),
    ev("2T03:00:00Z", "verdict", { context: "pipeline/ai-review", state: "success", pr: 90 }),
    ev("3T00:00:00Z", "release", { tag: "v1", sprint: "w45", shipped: ["84"], hotfixes: [] }),
    ev("3T12:00:00Z", "stage", { story: "95", what: "starting", state: "running" }),
    ev("4T00:00:00Z", "release", { tag: "v2", sprint: null, shipped: [], hotfixes: ["95"] }),
    ev("5T00:00:00Z", "rollback", { tag: "v1" }),
    ev("5T01:00:00Z", "lane", { lane: "org-issue-84", waitedSeconds: 600 }),
  ];
  const s = events.summarize(log, { days: 7 });
  assert.equal(s.dora.leadTimeHours, 48);                   // started 1st 00:00, in production 3rd 00:00
  assert.equal(s.dora.changeFailureRate, 100);              // 1 hotfix release + 1 rollback over 2 releases
  assert.equal(s.dora.timeToRestoreHours, 12);
  assert.deepEqual(s.gateWaits[0], { reason: "check X is pending", prs: 2 });
  assert.equal(s.stages.orgs.orgHours, 4);
  assert.equal(s.stages.lanes.totalMinutes, 10);
  assert.deepEqual(s.failedStages, [{ what: "CI (deploy or tests)", n: 1 }]);
  assert.deepEqual([s.ai.byRole.fix.runs, s.ai.totalUsd, s.ai.medianFixRounds, s.ai.passedFirstReview], [2, 1, 2, 0]);
  const md = events.toMarkdown(s);
  for (const want of ["story started to in production) | 48 h", "1 hotfix, 1 rollback", "check X is pending | 2", "| fix | 2 | $1.00"]) assert.ok(md.includes(want), want);
});

test("the event log is read with one git cat-file --batch, sizes in bytes (non-ASCII safe)", () => {
  const a = Buffer.from('{"kind":"gate","why":"→ ok"}'), b = Buffer.from('{"kind":"org"}');
  const out = Buffer.concat([Buffer.from(`aaa blob ${a.length}\n`), a, Buffer.from("\n"), Buffer.from(`bbb blob ${b.length}\n`), b, Buffer.from("\n")]);
  assert.deepEqual(events.parseBatch(out).map((t) => JSON.parse(t).kind), ["gate", "org"]);
});

test("fix rounds are this PR's earlier completed ai-fix runs, whatever the commits were called", () => {
  const runs = [{ id: 1, display_title: "ai-fix PR #90", status: "completed", conclusion: "success" }, { id: 2, display_title: "ai-fix PR #90", status: "completed", conclusion: "cancelled" },
    { id: 3, display_title: "ai-fix PR #91", status: "completed", conclusion: "success" }, { id: 4, display_title: "ai-fix PR #90", status: "in_progress" }, { id: 5, display_title: "ai-fix PR #90", status: "completed", conclusion: "failure" }];
  assert.equal(verdict.fixRunsFor(runs, 90, 5), 1);
  assert.equal(verdict.fixRunsFor(runs, 90, 4), 2);
  const wf = readFileSync(new URL("../../.github/workflows/ai-fix.yml", import.meta.url), "utf8");
  assert.match(wf, /verdict rounds --pr/);
  assert.match(readFileSync(new URL("../../.github/actions/claude-agent/action.yml", import.meta.url), "utf8"), /event agent --role/);
});

// ---------------------------------------------------------------- the code host and cheap card refreshes
function fakeGitHub() {
  const calls = [];
  const io = {
    run: (cmd, args, o) => {
      calls.push(`${args[2]} ${args[3]}`);
      if (args[3].endsWith("/check-runs") && args[2] === "POST") return JSON.stringify({ id: 7 });
      if (args[3].includes("/missing")) throw new Error("gh api failed: gh: Not Found (HTTP 404)");
      return "";
    },
    gh: (args) => { calls.push(args.slice(0, 3).join(" ")); if (args[0] === "pr" && args[1] === "list") return [{ number: 90, state: "OPEN", baseRefName: "release/w45", headRefOid: "h" }]; if (args[0] === "api" && /matching-refs/.test(args[1])) return [{ ref: "refs/heads/release/w45" }]; return null; },
    ghPages: () => [],
  };
  return { io, calls };
}

test("code host: one call per fact per process, errors as a status, verdicts linked to the run", () => {
  const { io, calls } = fakeGitHub();
  const h = codeHost({ io, env: { GH_REPO: "o/r", GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "5" } });
  assert.equal(h.runUrl, "https://github.com/o/r/actions/runs/5");
  assert.equal(h.openRelease(), "release/w45");
  h.openRelease(); h.storyPr("issue-84"); h.storyPr("issue-84");
  assert.equal(calls.filter((c) => /matching-refs/.test(c)).length, 1);
  assert.equal(calls.filter((c) => c === "pr list --head").length, 1);
  assert.deepEqual(h.api("GET", "repos/o/r/missing"), { status: 404, message: "gh api failed: gh: Not Found (HTTP 404)" });
  const check = h.checkRun("abc", "Salesforce tests");
  check.update({ title: "x" }, "success");
  assert.ok(calls.includes("PATCH repos/o/r/check-runs/7"));
  assert.deepEqual(codeHost({ io, env: { GH_REPO: "o/r" } }).checkRun(null, "x").update(), undefined, "no commit: a no-op check");
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

test("the GitHub tracker finds a marked comment once, then edits it directly", async () => {
  const calls = [];
  const t = githubTracker({ repo: "o/r", gh: (a) => { calls.push(a.slice(0, 3).join(" ")); return null; }, ghPages: (p) => { calls.push(`list ${p}`); return [{ id: 11, body: "<!-- mark --> old" }]; } });
  await t.card(84, "new 1", "<!-- mark -->");
  await t.card(84, "new 2", "<!-- mark -->");
  assert.equal(calls.filter((c) => c.startsWith("list")).length, 1);
  assert.equal(calls.filter((c) => c === "api -X PATCH").length, 2);
});

test("pipe.mjs is a thin command table: no GitHub, git or Salesforce logic of its own", () => {
  const src = readFileSync(new URL("../bin/pipe.mjs", import.meta.url), "utf8");
  assert.ok(src.split("\n").length < 450, "small: one line or a few per command");
  assert.doesNotMatch(src, /fetch\(|check-runs`, \{|sgd", "source", "delta"|createSign/);
});

// ---------------------------------------------------------------- one engine for both skills
// the scratch-org skill is vendored in the reference repo only; a repo made from the template does not carry it
const scratchSkill = new URL("../../.claude/skills/salesforce-scratch-org-tests/scripts/engine/tests.mjs", import.meta.url);
test("the scratch-org skill runs this pipeline's test selection: its engine is tests.mjs, verbatim, and agrees on a real repo", { skip: !existsSync(scratchSkill) && "the scratch-org skill is not vendored here" }, async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const skill = new URL("../../.claude/skills/salesforce-scratch-org-tests/scripts/", import.meta.url);
  assert.equal(readFileSync(new URL("engine/tests.mjs", skill), "utf8"), readFileSync(new URL("../src/tests.mjs", import.meta.url), "utf8"));
  const dir = mkdtempSync(`${tmpdir()}/engine-`);
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  const put = (p, t) => { mkdirSync(`${dir}/${p.split("/").slice(0, -1).join("/")}`, { recursive: true }); writeFileSync(`${dir}/${p}`, t); };
  put("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
  put("force-app/main/default/classes/Svc.cls", "public with sharing class Svc {}");
  put("force-app/main/default/classes/SvcTest.cls", "@IsTest class SvcTest { Svc s; }");
  put("force-app/main/default/classes/OtherTest.cls", "@IsTest class OtherTest { }");
  g("init", "-q"); g("add", "."); g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD").trim();
  put("force-app/main/default/classes/Svc.cls", "public with sharing class Svc { Integer n; }");
  g("commit", "-qam", "change");
  const sel = (env = {}) => execFileSync("bash", [new URL("select-tests.sh", skill).pathname, base], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "ignore"] }).trim();
  assert.equal(sel(), "apex SvcTest");
  assert.equal(sel({ TEST_MODE: "all" }), "all");
  put("force-app/main/default/objects/Account/fields/X__c.field-meta.xml", "<CustomField/>");
  g("add", "."); g("commit", "-qm", "field");
  assert.equal(sel(), "all", "other metadata can affect anything");
});

test("route check before /build: a base that moved on is fine; a hotfix branch carrying sprint work is refused", () => {
  const git = (inMain) => (args) => (args[1] === "--is-ancestor" ? (inMain ? "" : null) : "fork");
  assert.equal(gate.branchRoute(git(false), { branch: "issue-106", base: "release/w45", release: "release/w45" }).ok, true, "sprint story: the build merges the base in");
  assert.equal(gate.branchRoute(git(true), { branch: "issue-7", base: "main", release: "release/w45" }).ok, true, "hotfix cut from main");
  const bad = gate.branchRoute(git(false), { branch: "issue-7", base: "main", release: "release/w45" });
  assert.match(bad.why, /carries unreleased release\/w45 work/);
  assert.equal(gate.branchRoute(git(false), { branch: "issue-7", base: "main" }).ok, true, "no open sprint: nothing to carry");
});

test("the event log is read from a real metrics branch (fetch, ls-tree, one cat-file --batch), only inside the window", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { io } = await import("../src/io.mjs");
  const root = mkdtempSync(`${tmpdir()}/log-`);
  const g = (dir, ...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  execFileSync("git", ["init", "-q", "--bare", `${root}/remote.git`]);
  g(root, "init", "-q", "w"); const w = `${root}/w`;
  const put = (p, e) => { mkdirSync(`${w}/${p.split("/").slice(0, -1).join("/")}`, { recursive: true }); writeFileSync(`${w}/${p}`, JSON.stringify(e) + "\n"); };
  put("events/2026/10/05/a-1-gate-x.json", { kind: "gate", at: "2026-10-05T10:00:00Z", why: "→ waiting" });
  put("events/2026/10/05/b-1-agent-y.json", { kind: "agent", at: "2026-10-05T11:00:00Z", role: "fix", usd: 0.5 });
  put("events/2026/08/01/c-1-org-z.json", { kind: "org", at: "2026-08-01T00:00:00Z" });
  g(w, "checkout", "-q", "-b", "metrics"); g(w, "add", "."); g(w, "commit", "-qm", "events"); g(w, "remote", "add", "origin", `${root}/remote.git`); g(w, "push", "-q", "origin", "metrics");
  g(root, "clone", "-q", `${root}/remote.git`, "reader");
  const here = process.cwd();
  process.chdir(`${root}/reader`);
  try {
    const got = events.readLog(io, { days: 7, now: new Date("2026-10-06T00:00:00Z") });
    assert.deepEqual(got.map((e) => e.kind).sort(), ["agent", "gate"]);
    assert.equal(got.find((e) => e.kind === "gate").why, "→ waiting");
  } finally { process.chdir(here); }
});

test("every dispatch names its ref (without one, gh needs contents: read to find the default branch)", () => {
  for (const f of readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter((n) => n.endsWith(".yml"))) {
    const y = readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8");
    for (const line of y.split("\n").filter((l) => /gh workflow run /.test(l))) assert.match(line, /--ref /, `${f}: ${line.trim()}`);
  }
  const calls = [];
  codeHost({ io: { gh: (a) => calls.push(a.join(" ")) }, env: { GH_REPO: "o/r" } }).dispatch("gate.yml", { pr: 7 });
  assert.deepEqual(calls, ["workflow run gate.yml --ref main -f pr=7"]);
});

test("lane: a claim that cannot be written is said and retried, never mistaken for waiting; five in a row fail", () => {
  const f = fakeRefs();
  const logs = [];
  const mk = () => lane({ api: f.api, repo: "o/r", holder: { run: "9", job: "ci", sha: "gone" }, now: () => 0, sleep: () => {}, log: (m) => logs.push(m) });
  f.failClaims(2);
  assert.equal(mk().acquire("org-staging"), true);
  assert.equal(logs.filter((m) => /could not write the claim \(422: tree not found\)/.test(m)).length, 2);
  mk().release("org-staging");
  f.failClaims(9);
  assert.throws(() => mk().acquire("org-staging"), /5 times in a row/);
});

// ---------------------------------------------------------------- card actions (tick boxes) and the release card
test("actions: commands and ticked boxes name the same actions; only write access, never a bot", () => {
  assert.deepEqual(actions.command("/uat-fail the totals are wrong\nmore"), { id: "uat-fail", arg: "the totals are wrong" });
  assert.deepEqual(actions.command("/SHIP"), { id: "ship", arg: "" });
  assert.equal(actions.command("ship it please"), null);
  const card = actions.checklist(["ship", "review"]).join("\n");
  assert.deepEqual(actions.ticked(card, card.replace("- [ ] 🚀", "- [x] 🚀")), ["ship"]);
  assert.deepEqual(actions.ticked(card, card), [], "an edit that ticks nothing does nothing");
  assert.deepEqual(actions.ticked(card.replace("- [ ] 🚀", "- [x] 🚀"), card.replace("- [ ] 🚀", "- [x] 🚀")), [], "already ticked: not a new tick");
  assert.deepEqual(actions.allowed(["build", "start", "fix"], { implement: true }), ["build", "start"]);
  assert.equal(actions.mayAct({ login: "dev", type: "User", permission: "write" }), true);
  for (const bad of [{ login: "dev", type: "User", permission: "read" }, { login: "__owner__-pipeline[bot]", type: "Bot", permission: "admin" }]) assert.equal(actions.mayAct(bad), false);
});

test("actions: a sign-off is a trusted status on the head (into the sprint); into main it asks for a GitHub approval", () => {
  const did = [];
  const host = { repoUrl: "https://github.com/o/r", status: (...a) => did.push(["status", ...a]), dispatch: (...a) => did.push(["dispatch", a[0]]) };
  const deps = { host, appGh: (a) => did.push(["gh", a.join(" ")]), gh: () => {}, inUat: (sha) => sha === "in-uat" };
  const story = { headRefName: "issue-106", headRefOid: "h1", baseRefName: "release/w45" };
  assert.match(actions.perform("ship", "", { number: 108, isPr: true, pr: story }, "dev", deps).done, /signed off by @dev/);
  assert.deepEqual(did.slice(0, 2), [["status", "h1", "pipeline/sign-off", "success", "Signed off by @dev"], ["dispatch", "gate.yml"]]);
  assert.match(actions.perform("ship", "", { number: 7, isPr: true, pr: { ...story, baseRefName: "main" } }, "dev", deps).said, /need a GitHub approval/);
  const release = { headRefName: "release/w45", headRefOid: "not-yet", baseRefName: "main" };
  assert.match(actions.perform("uat-pass", "", { number: 110, isPr: true, pr: release }, "dev", deps).said, /UAT is not running/);
  did.length = 0;
  actions.perform("uat-pass", "", { number: 110, isPr: true, pr: { ...release, headRefOid: "in-uat" } }, "dev", deps);
  assert.deepEqual(did[0], ["status", "in-uat", "pipeline/uat", "success", "Signed off in UAT by @dev"]);
  did.length = 0;
  actions.perform("review", "", { number: 108, isPr: true, pr: story }, "dev", deps);
  assert.deepEqual(did, [["gh", "issue edit 108 --remove-label ai:review"], ["gh", "issue edit 108 --add-label ai:review"]]);
  assert.match(actions.perform("build", "", { number: 108, isPr: true, pr: story }, "dev", deps).said, /works on the story/);
});

test("the gate counts a trusted sign-off status on the head (a ticked box), not one from anyone else", () => {
  const f = { ...open(fixture(23)), ai: {}, reviews: [], labelEvents: [], comments: [] };
  const head = f.pr.headRefOid;
  const signed = (login) => ({ ...f, statuses: [{ sha: head, context: gate.STATUS.signoff, state: "success", created_at: "2026-10-06T00:00:00Z", creator: { login } }] });
  assert.ok(!gate.evaluate(signed("github-actions[bot]")).reasons.some((r) => /sign-off/.test(r)));
  assert.ok(gate.evaluate(signed("someone")).reasons.some((r) => /no sign-off/.test(r)));
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

test("tick boxes: the card-actions workflow acts only on a person's edit of a card, through the same pipe act as commands", () => {
  const y = readFileSync(new URL("../../.github/workflows/card-actions.yml", import.meta.url), "utf8");
  assert.match(y, /github.event.sender.type != 'Bot'/);
  assert.match(y, /contains\(github.event.comment.body, '<!-- pipeline:'\)/);
  assert.match(y, /pipe.mjs act --number .* --before .* --after/);
  assert.match(readFileSync(new URL("../../.github/workflows/commands.yml", import.meta.url), "utf8"), /pipe.mjs act --number .* --command "\$BODY"/);
});

test("agent jobs cannot post verdicts or start workflows; follow-ups run on a fresh runner; no endless fix loop", () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  const job = (y, name) => y.split(/\n  (?=[a-z-]+:\n)/).find((b) => b.startsWith(`${name}:`)) || "";
  for (const [n, j] of [["ai-implement", "implement"], ["ai-fix", "fix"], ["ui-test", "write"]]) {
    const b = job(wf(n), j);
    assert.match(b, /permissions:\n/, `${n}/${j} sets its own permissions`);
    assert.doesNotMatch(b, /statuses: write|actions: write/, `${n}/${j}`);
    assert.doesNotMatch(b, /gh workflow run/, `${n}/${j} dispatches nothing`);
  }
  assert.match(job(wf("ai-fix"), "follow-up"), /the fix pushed nothing: no new review/);
  assert.match(wf("ai-review"), /round limit reached: no AI fix/);
});

test("correctness wiring: story PR base from the story, UAT never reset by a redeploy, merge button locked until production accepts", () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  assert.match(wf("story-pr"), /pipe.mjs story base "\$KEY"/);
  assert.doesNotMatch(wf("story-pr"), /merge-base --is-ancestor/);
  assert.match(wf("uat-deploy"), /UAT already has/);
  assert.match(wf("staging-deploy"), /superseded by/);
  assert.match(wf("staging-deploy"), /needs.staging.outputs.tested/);
  assert.match(wf("gate"), /STATE=pending; DESC="Ready: validating against production before merging"/);
  assert.match(wf("gate"), /status set pipeline\/gate failure "\$HEAD_SHA" "Production rejected it/);
  const did = [];
  actions.perform("uat", "", { number: 110, isPr: true, pr: { headRefName: "release/w45" } }, "dev", { host: { dispatch: (w, i) => did.push([w, i]) } });
  assert.deepEqual(did, [["uat-deploy.yml", { pr: 110, again: "true" }]], "the card's box deploys again on purpose");
  assert.equal(names.baseFor({ labels: ["feature"], openReleaseBranch: "release/w45" }), "release/w45");
  assert.equal(names.baseFor({ labels: ["hotfix"], openReleaseBranch: "release/w45" }), "main");
});

// ---------------------------------------------------------------- scale and cost
test("lane: a waiting poll is one read of the lock (holder read once, its run checked every few minutes)", () => {
  const f = fakeRefs();
  let t = 0, calls = [];
  const api = (m, p, b) => { calls.push(`${m} ${p.split("/").slice(3).join("/")}`); return f.api(m, p, b); };
  const mk = (run) => lane({ api, repo: "o/r", holder: { run, job: "j", sha: "base" }, now: () => t, sleep: (ms) => { t += ms; }, log: () => {} });
  mk("1").acquire("org-issue-1");
  calls = [];
  assert.throws(() => mk("2").acquire("org-issue-1", { timeoutMinutes: 10, pollSeconds: 30 }));
  const polls = calls.filter((c) => c === "GET git/refs/locks/org-issue-1").length;
  assert.ok(polls >= 5 && polls <= 10, `polled ${polls} times in 10 minutes: backing off to 3 minutes keeps many waiters inside the API limit`);
  assert.ok(calls.length <= polls + 8, `${calls.length} calls for ${polls} polls`);
  assert.equal(calls.filter((c) => c.startsWith("POST")).length, 0, "no claim commit while the lane is busy");
});

test("test selection: a field, validation rule or permission set runs the tests that use it, not everything", () => {
  const files = ["force-app/main/default/objects/Account/fields/Region__c.field-meta.xml", "force-app/main/default/classes/AccountTest.cls",
    "force-app/main/default/classes/CaseTest.cls", "force-app/main/default/permissionsets/Region_Access.permissionset-meta.xml"];
  const src = { "force-app/main/default/classes/AccountTest.cls": "@IsTest class AccountTest { Account a; }", "force-app/main/default/classes/CaseTest.cls": "@IsTest class CaseTest { Case c; Region_Access x; }" };
  const read = (p) => src[p] || "";
  assert.deepEqual(tests.selectTests({ changed: [files[0]], files, read }).apex, ["AccountTest"]);
  assert.deepEqual(tests.selectTests({ changed: [files[3]], files, read }).apex, ["CaseTest"]);
  assert.equal(tests.selectTests({ changed: ["force-app/main/default/objects/Lead/fields/X__c.field-meta.xml"], files, read }).mode, "all", "nothing names Lead: all");
  assert.equal(tests.selectTests({ changed: ["force-app/main/default/layouts/Account-Account Layout.layout-meta.xml"], files, read }).mode, "all");
});

test("check runs are updated when their title changes, at most once a minute; the result always", () => {
  const sent = [];
  let t = 0;
  const io = { run: (c, a, o) => { if (a[2] === "POST") return JSON.stringify({ id: 9 }); sent.push(JSON.parse(o.input)); return ""; } };
  const check = codeHost({ io, env: { GH_REPO: "o/r" }, now: () => t }).checkRun("sha", "Salesforce tests");
  for (let i = 0; i < 8; i++) { t += 15e3; check.update({ title: `Running: ${Math.floor(i / 4)}` }); }
  check.update({ title: "Passed" }, "success");
  assert.equal(sent.length, 3, "two progress updates in two minutes, then the result");
  assert.equal(sent.at(-1).conclusion, "success");
});

test("story orgs leave ORG_RESERVE slots for staging, UAT and CI; an expired org says how to rebuild it", () => {
  const { sf } = fakeSf([]);
  const limited = (remaining) => (args, o) => (args[0] === "limits" ? [{ name: "ActiveScratchOrgs", remaining, max: 40 }, { name: "DailyScratchOrgs", remaining: 50, max: 80 }] : sf(args, o));
  assert.throws(() => orgRegistry({ sf: limited(2), log: () => {}, packages: [], env: { ORG_RESERVE: "2", BASELINE: "off", SEED: "off" } }).ensure("story:9"), /2 kept for staging, UAT and CI/);
  assert.doesNotThrow(() => orgRegistry({ sf: limited(3), log: () => {}, packages: [], env: { ORG_RESERVE: "2", BASELINE: "off", SEED: "off" } }).ensure("story:9"));
  assert.throws(() => orgRegistry({ sf, log: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } }).attach("story:9"), /expired \(story orgs live 7 days\)\. Comment \/start/);
});

test("cost wiring: no duplicate full run on release PRs, the fixer only for code failures, renudge only on the main lock", () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  assert.match(wf("ci"), /release\/\*\|backmerge-\*\) echo "none=true"/);
  assert.match(wf("ci"), /needs.apex.outputs.code-failed == 'true'/);
  assert.match(wf("gate"), /needs.decide.outputs.lock == 'main'/);
});

test("clarity: a carried-over story says how to pick it up again; a waiting job puts 'waiting for the org' on the card", () => {
  const f = { ...open(fixture(23)), ai: {}, statuses: [], reviews: [] };
  const closed = storyCard({ key: "2", repoUrl: "https://github.com/o/r", branch: "issue-2", base: "release/w45", pr: { ...f.pr, state: "CLOSED" }, facts: f });
  assert.match(closed, /To work on it again, tick \*\*Start\*\*/);
  assert.match(closed, /act:start/);
  const fr = fakeRefs();
  const waits = [];
  let t = 0;
  const mk = (run, onWait) => lane({ api: fr.api, repo: "o/r", holder: { run, job: "ci#1", sha: "base" }, now: () => t, sleep: (ms) => { t += ms; }, onWait });
  mk("1").acquire("org-issue-2");
  assert.throws(() => mk("2", (h) => waits.push(h.job)).acquire("org-issue-2", { timeoutMinutes: 5 }));
  assert.deepEqual(waits, ["ci#1"], "said once per holder");
});

test("Apex tests run as production's CI user would: the story permission sets are taken away for the run and given back", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/ps-`);
  mkdirSync(`${dir}/permissionsets`, { recursive: true });
  writeFileSync(`${dir}/permissionsets/Sales_Region_Access.permissionset-meta.xml`, "<PermissionSet/>");
  const calls = [];
  const sf = (args) => {
    calls.push(args.slice(0, 3).join(" "));
    if (args[0] === "org" && args[1] === "display") return { username: "admin@scratch" };
    if (args[0] === "data" && args[1] === "query") return { records: [{ Id: "0PaX1" }] };
    return {};
  };
  const r = orgRegistry({ sf, log: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } });
  const seen = r.asProductionUser("issue-1", () => { calls.push("RUN TESTS"); return 42; }, dir);
  assert.equal(seen, 42);
  const at = (c) => calls.indexOf(c);
  assert.ok(at("data delete record") < at("RUN TESTS") && at("RUN TESTS") < at("org assign permset"), calls.join(" | "));
  assert.throws(() => r.asProductionUser("issue-1", () => { throw new Error("tests failed"); }, dir), /tests failed/);
  assert.equal(calls.filter((c) => c === "org assign permset").length, 2, "given back even when the tests fail");
});

test("engineering skills: the agents get the pr body, the spec-axis review and the diagnosing loop; the skills' conventions exist", () => {
  assert.match(verdict.instructions("implement", { key: "106" }), /Story #106[\s\S]*## Summary[\s\S]*## Evidence[\s\S]*## Merge danger[\s\S]*## Test plan/);
  assert.match(verdict.instructions("review"), /### Acceptance criteria[\s\S]*met, missing or partly met[\s\S]*### Standards/);
  assert.match(verdict.instructions("fix"), /one failing test method alone/);
  for (const f of ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md", "docs/agents/salesforce.md", "GLOSSARY-MAP.md"]) {
    assert.ok(readFileSync(new URL(`../../${f}`, import.meta.url), "utf8").length > 200, f);
  }
  // the org glossary is the project's own: a new repo starts with just its heading and table
  assert.match(readFileSync(new URL("../../docs/org/GLOSSARY.md", import.meta.url), "utf8"), /^# The Salesforce org: domain glossary[\s\S]*\| Term \| Meaning \| In the org \|/);
  const tracker = readFileSync(new URL("../../docs/agents/issue-tracker.md", import.meta.url), "utf8");
  for (const h of ["### Summary", "### Acceptance criteria", "### Access", "### Where to see it in the UI", "### Out of scope"]) assert.ok(tracker.includes(h), h);
  assert.deepEqual(plans.criteria("### Acceptance criteria\n- a\n- b\n\n### Access\nNo change"), ["a", "b"], "the Access section does not leak into the criteria");
  assert.ok(names.LABELS["in-sprint"] && names.LABELS.spec);
});

test("every workflow that refreshes a card can read checks (the card is built from the gate's facts)", () => {
  for (const f of readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter((n) => n.endsWith(".yml"))) {
    const y = readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8");
    if (!/pipe\.mjs (pr card|story card|act |gate nudge|gate evaluate)/.test(y)) continue;
    assert.match(y, /checks: (read|write)/, `${f} refreshes a card without checks permission`);   // workflow or job level
  }
});

// ---------------------------------------------------------------- specs and story breakdowns (to-spec, to-tickets on GitHub)
test("spec: open questions make the story an explicit choice; one story from the spec (the real #125), made once", () => {
  const withQ = specs.specComment("### Problem\nx\n### Open questions\n1. Which regions?\n");
  assert.match(withQ, /answer the question in a comment/);
  assert.match(withQ, /act:story-anyway/);
  assert.doesNotMatch(withQ, /act:story -->/);
  const clean = specs.specComment("### Problem\nx\n### User stories\n1. As a rep, I want y\n");
  assert.match(clean, /act:story -->/);

  const text = readFileSync(new URL("./fixtures/spec-125.md", import.meta.url), "utf8");
  const t = specs.storyFromSpec({ spec: 125, text, title: "Spec: Regional reporting for sales managers" });
  assert.equal(t.title, "Regional reporting for sales managers");
  assert.equal(t.criteria.length, 11);
  assert.match(t.criteria[0], /^As a sales manager, I want a report of accounts grouped by sales region/);
  assert.match(t.summary, /^Sales managers cannot see/);
  assert.match(t.access, /Regional_Reporting_Access/);
  assert.match(t.out, /^- Restricting a manager to only their own territory/);
  const body = specs.storyBody(t, { spec: 125 });
  assert.equal(plans.criteria(body).length, 11, "the story reads like any story");
  assert.match(body, /Part of spec #125\.$/);
  assert.throws(() => specs.storyFromSpec({ spec: 9, text: "### Problem\nx", title: "Spec: y" }), /no user stories/);

  const calls = [];
  const gh = (a) => { calls.push(a); if (a[0] === "issue" && a[1] === "create") return "https://github.com/o/r/issues/142"; if (a[0] === "api" && a.includes("--jq")) return 9001; return null; };
  const r = specs.makeStory({ gh, repo: "o/r", spec: 125, title: "Spec: Regional reporting for sales managers", body: specs.specComment(text) });
  assert.equal(r.number, 142);
  assert.ok(calls.some((a) => a.join(" ").includes("issues/125/sub_issues")), "linked as a sub-issue of the spec");
  assert.match(r.body, /<!-- story:142 -->\n\*\*Story:\*\* #142/);
  assert.doesNotMatch(r.body, /act:story/, "the box is gone once made");
  assert.deepEqual(specs.makeStory({ gh: () => { throw new Error("must not create twice"); }, repo: "o/r", spec: 125, title: "x", body: r.body }), { number: 142, body: r.body, already: true });
  assert.throws(() => specs.makeStory({ gh: () => "rate limited", repo: "o/r", spec: 125, title: "x", body: specs.specComment(text) }), /was not created/);
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

test("spec wiring: the agents' prompts, the spec issue form and the boxes", () => {
  assert.match(verdict.instructions("spec"), /### One-way doors/);
  assert.throws(() => verdict.modelFor("tickets", ""), /Unknown AI role/, "no AI split any more");
  assert.match(newStoryCard({ key: "150", ai: { plan: true }, spec: true }), /act:spec/);
  assert.deepEqual(actions.command("/tickets"), { id: "story", arg: "" }, "the old command makes the story");
  assert.deepEqual(actions.command("/story"), { id: "story", arg: "" });
  const wf = readFileSync(new URL("../../.github/workflows/ai-spec.yml", import.meta.url), "utf8");
  assert.doesNotMatch(wf, /tickets|breakdown/);
  assert.match(wf, /User stories" become the story's acceptance criteria/);
});

test("labels follow conventions.mjs on main; specs read the open sprint like /plan", () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  assert.match(wf("labels"), /paths: \["pipeline\/src\/conventions.mjs"\]/);
  assert.match(wf("ai-spec"), /git checkout -q "origin\/\$REL"/);
});

test("UAT access from GitHub: the card links UAT; a stand-in offers 'Send me a UAT login'; the tester gets an email, never a secret", async () => {
  const pr = { number: 110, state: "OPEN", headRefName: "release/2026-w45", baseRefName: "main", headRefOid: "h" };
  const run = (name) => ({ name, conclusion: "success", status: "completed", started_at: "2026-10-06T08:00:00Z" });
  const green = ["static checks (no org)", "deploy and Apex tests (scratch org)", "staging regression"].map(run);
  const uat = (description, url) => ({ sha: "h", context: gate.STATUS.uat, state: "pending", description, url, created_at: "2026-10-06T09:00:00Z", creator: { login: "github-actions[bot]" } });
  const card = (d, u) => releaseCard({ repoUrl: "https://github.com/o/r", pr, uat: true, facts: { checkRuns: green, statuses: [uat(d, u)], reviews: [] } });
  const stand = card("In UAT (scratch org): test it", "https://uat-x.my.salesforce.com");
  assert.match(stand, /\*\*\[open UAT\]\(https:\/\/uat-x\.my\.salesforce\.com\)\*\*/);
  assert.match(stand, /act:uat-login/);
  const sandbox = card("In UAT (sandbox): test it", "https://acme--uat.sandbox.my.salesforce.com");
  assert.match(sandbox, /your UAT sandbox login/);
  assert.doesNotMatch(sandbox, /act:uat-login/);
  const did = [];
  actions.perform("uat-login", "", { number: 110, isPr: true, pr }, "tester1", { host: { dispatch: (w, i) => did.push([w, i]) } });
  assert.deepEqual(did, [["uat-login.yml", { pr: 110, who: "tester1" }]]);
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/uat-`);
  mkdirSync(`${dir}/permissionsets`, { recursive: true });
  writeFileSync(`${dir}/permissionsets/Sales_Region_Access.permissionset-meta.xml`, "<PermissionSet/>");
  const calls = [];
  const sf = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "org" && args[1] === "display") return { id: "00DRt00000YW6BXMA1" };
    if (args[0] === "data" && args[1] === "query") return { records: /FROM Profile/.test(args.join(" ")) ? [{ Id: "00eSTD" }] : [] };
    if (args[0] === "data" && args[1] === "create") return { id: "005X" };
    return {};
  };
  const r = orgRegistry({ sf, log: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } }).tester("uat", { login: "Tester-1", email: "t@example.com" }, dir);
  assert.deepEqual(r, { username: "tester1.uat@00drt00000yw6bx.pipeline", created: true, admin: false, persona: { role: null, permsets: ["Sales_Region_Access"] } });
  assert.ok(calls.some((c) => /data create record -o uat -s User -v Username='tester1\.uat@.*ProfileId=00eSTD/.test(c)), "a User record (org create user fails with JWT on Hyperforce)");
  assert.ok(calls.some((c) => c === "org assign permset --name Sales_Region_Access -o uat --on-behalf-of tester1.uat@00drt00000yw6bx.pipeline"));
  assert.ok(calls.some((c) => /FROM Profile WHERE Name = 'Standard User'/.test(c)));
  // an admin asks for their own login: System Administrator, no persona permission sets
  calls.length = 0;
  const a = orgRegistry({ sf, log: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } }).tester("issue-166", { login: "alice", email: "a@example.com", admin: true }, dir);
  assert.equal(a.username, "alice.admin@00drt00000yw6bx.pipeline");
  assert.ok(calls.some((c) => /FROM Profile WHERE Name = 'System Administrator'/.test(c)));
  assert.ok(!calls.some((c) => c.startsWith("org assign permset")));
  // a full org: the UI-test personas' licences are freed, then it is tried again
  calls.length = 0;
  let full = true;
  const sfFull = (args) => {
    const c = args.join(" "); calls.push(c);
    if (args[1] === "display") return { id: "00DRt00000YW6BXMA1" };
    if (args[1] === "query") return { records: /FROM Profile/.test(c) ? [{ Id: "00eSTD" }] : /persona\./.test(c) ? [{ Id: "005P1" }] : [] };
    if (args[1] === "create") { if (full) { full = false; throw new Error("LICENSE_LIMIT_EXCEEDED: License Limit Exceeded"); } return { id: "005Y" }; }
    return {};
  };
  orgRegistry({ sf: sfFull, log: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } }).tester("uat", { login: "t2", email: "t@example.com" }, dir);
  assert.ok(calls.includes("data update record -o uat -s User -i 005P1 -v IsActive=false"));
  assert.equal(calls.filter((c) => c.startsWith("data create record")).length, 2);
  assert.ok(calls.some((c) => c.startsWith("apex run -o uat --file")), "Salesforce emails the password link");
  const wf = readFileSync(new URL("../../.github/workflows/uat-login.yml", import.meta.url), "utf8");
  assert.match(wf, /::add-mask::\$EMAIL/);
  assert.doesNotMatch(wf, /generate password|org open|frontdoor/i, "no password or session in GitHub");
});

test("completion fixes: a ticked sign-off re-runs the gate later; UAT failure offers a retest; a spec card follows the spec; sprint names", () => {
  const head = "h1";
  const io = (statuses, reviews = []) => ({
    gh: () => ({ state: "OPEN", labels: [], headRefName: "issue-5", baseRefName: "release/w45", headRefOid: head }),
    ghPages: (p) => (p.includes("/reviews") ? reviews : statuses),
  });
  assert.equal(gate.nudge(5, io([{ context: "pipeline/sign-off", state: "success", creator: { login: "github-actions[bot]" } }])).action, "dispatch");
  assert.equal(gate.nudge(5, io([{ context: "pipeline/sign-off", state: "success", creator: { login: "someone" } }])).action, "none");
  const pr = { number: 110, state: "OPEN", headRefName: "release/w45", baseRefName: "main", headRefOid: "h" };
  const st = { sha: "h", context: gate.STATUS.uat, state: "failure", description: "totals wrong", created_at: "2026-10-06T10:00:00Z", creator: { login: "github-actions[bot]" } };
  const failedUat = releaseCard({ repoUrl: "https://github.com/o/r", pr, uat: true, facts: { checkRuns: [], statuses: [st], reviews: [] } });
  assert.match(failedUat, /act:uat-pass[\s\S]*act:uat\b/);
  assert.match(newStoryCard({ key: "125", spec: true, stage: "spec" }), /tick \*\*Make it a story\*\*/);
  assert.match(newStoryCard({ key: "125", spec: true, stage: "story", stories: [142] }), /Done: the spec is story #142/);
  assert.equal(names.nextSprint(["2026-w45", "2026-w44"]), "2026-w46");
  assert.equal(names.nextSprint(["2026-w52"]), "2027-w01");
  assert.match(names.nextSprint([]), /^\d{4}-w\d{2}$/);
  assert.match(verdict.instructions("implement", { key: "7" }), /Story #7[^\n]*never "Closes"/);
});

test("the gate holds main while production is rolled back, and a story until its blockers have landed", () => {
  const rel = { ...open(fixture(26)), ai: {} };
  const rr = gate.evaluate({ ...rel, rolledBack: 131 });
  assert.ok(rr.reasons.some((x) => /production was rolled back \(#131\)/.test(x)), rr.reasons.join(" | "));
  const f = { ...open(fixture(23)), ai: {}, statuses: [], reviews: [] };
  const blocked = gate.evaluate({ ...f, blockers: [{ number: 201, landed: false }, { number: 202, landed: true }] });
  assert.ok(blocked.reasons.includes("blocked by #201: it has not merged into the sprint yet"));
  assert.ok(!blocked.reasons.some((x) => /#202/.test(x)));
  const wf = readFileSync(new URL("../../.github/workflows/rollback.yml", import.meta.url), "utf8");
  assert.match(wf, /gh issue reopen "\$KEY"/);
});

test("pipe act parses the workflows' own arguments: who acted and that it is a PR (a value flag must not swallow them)", async () => {
  const { execFileSync } = await import("node:child_process");
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  for (const n of ["commands", "card-actions"]) assert.match(wf(n), /'--is-pr'/, n);
  // the argument parser is the one in pipe.mjs: run a dry parse through a tiny shim of the same VALUE_FLAGS rule
  const src = readFileSync(new URL("../bin/pipe.mjs", import.meta.url), "utf8");
  const valueFlags = new Set(JSON.parse(`[${src.match(/const VALUE_FLAGS = new Set\(\[([\s\S]*?)\]\)/)[1].replace(/\s+/g, " ")}]`));
  const switches = [...new Set([...src.matchAll(/has\("([a-z-]+)"\)/g)].map((m) => m[1]))];
  assert.deepEqual(switches.filter((s) => valueFlags.has(s)), [], "a switch that is also a value flag swallows the next argument");
  const argv = ["--number", "110", "--is-pr", "--by", "matchmoments-admin", "--by-type", "User", "--command", "/uat-pass"];
  const flags = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) { const n = argv[i].slice(2); flags[n] = valueFlags.has(n) ? argv[++i] : true; }
  assert.deepEqual([flags.number, flags["is-pr"], flags.by, flags["by-type"], flags.command], ["110", true, "matchmoments-admin", "User", "/uat-pass"]);
});

// ---------------------------------------------------------------- UI evidence
const webp = (kb = 10) => { const b = Buffer.alloc(kb * 1024); b.write("RIFF", 0, "latin1"); b.write("WEBP", 8, "latin1"); return b; };
const meta = (o) => Buffer.from(JSON.stringify(o));

test("UI evidence is behind UI_EVIDENCE: off unless exactly true, and the workflows obey it", () => {
  assert.equal(evidence.evidenceOn({}), false);
  assert.equal(evidence.evidenceOn({ PIPELINE_VARS: JSON.stringify({ UI_EVIDENCE: "false" }) }), false);
  assert.equal(evidence.evidenceOn({ PIPELINE_VARS: JSON.stringify({ UI_EVIDENCE: "true" }) }), true);
  assert.equal(evidence.evidenceOn({ UI_EVIDENCE: "TRUE" }), true);
  const wf = readFileSync(new URL("../../.github/workflows/ui-test.yml", import.meta.url), "utf8");
  // off: the spec gets no EVIDENCE_DIR (evidence() does nothing) and nothing is published; the spec step has no token
  assert.match(wf, /GH_TOKEN: ""\n\s+EVIDENCE_DIR: \$\{\{ vars\.UI_EVIDENCE == 'true' && 'ui-out\/evidence' \|\| '' \}\}/);
  assert.match(wf, /id: evidence\n\s+if: env\.OUTCOME == 'success' && vars\.UI_EVIDENCE == 'true'/);
  assert.match(wf, /continue-on-error: true   # no screenshots never fails the verdict/);
  assert.match(readFileSync(new URL("../../e2e/support/evidence.ts", import.meta.url), "utf8"), /const dir = process\.env\.EVIDENCE_DIR;\n\s+if \(!dir\) return;/);
  assert.match(readFileSync(new URL("../../.github/workflows/scratch-janitor.yml", import.meta.url), "utf8"), /pipe\.mjs evidence squash/);
});

test("UI evidence: only small WebP shots with safe names are published, at most 6, never a URL", () => {
  const files = [
    { name: "01-ac1-customer-since.webp", data: webp() }, { name: "01-ac1-customer-since.json", data: meta({ caption: "AC1: *Customer* [Since] @org/everyone see https://evil.example/x #12", path: "/lightning/r/Account/001xx/view" }) },
    { name: "02-png.webp", data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100)]) },
    { name: "03-big.webp", data: webp(130) },
    { name: "../x.webp", data: webp() },
    { name: "04-url.webp", data: webp() }, { name: "04-url.json", data: meta({ caption: "x", path: "https://evil.example/secur/frontdoor.jsp?sid=1" }) },
    ...[5, 6, 7, 8, 9].map((n) => ({ name: `0${n}-more.webp`, data: webp() })),
  ];
  const { shots, rejected } = evidence.check(files);
  assert.deepEqual(shots.map((s) => s.name), ["01-ac1-customer-since.webp", "04-url.webp", "05-more.webp", "06-more.webp", "07-more.webp", "08-more.webp"]);
  assert.equal(shots[0].path, "/lightning/r/Account/001xx/view");
  assert.equal(shots[1].path, null, "a URL with a query is never kept");
  assert.ok(rejected.some((r) => /02-png\.webp: not a WebP/.test(r)));
  assert.ok(rejected.some((r) => /03-big\.webp: 130 KB is over 120 KB/.test(r)));
  assert.ok(rejected.some((r) => /\.\.\/x\.webp: not an evidence file name/.test(r)));
  assert.ok(rejected.some((r) => /09-more\.webp: more than 6/.test(r)));

  const body = evidence.evidenceComment({ key: "84", pr: 90, sha: "abcdef1234", shots, orgUrl: "https://x-dev-ed.scratch.my.salesforce.com", repoUrl: "https://github.com/o/r" });
  assert.ok(body.startsWith(evidence.EVIDENCE_MARK));
  // the caption is plain words: no markdown, no @mention, no #reference, no live link (the spec that wrote it is untrusted)
  assert.equal(shots[0].caption, "AC1: Customer Since org/everyone see https:\u200b//evil.example/x 12");
  assert.equal(evidence.safeCaption("go to www.evil.example"), "go to www\u200b.evil.example");
  assert.match(body, /\*\*AC1: Customer Since org\/everyone see https:\u200b\/\/evil\.example\/x 12\*\* · \[open in the scratch org\]\(https:\/\/x-dev-ed\.scratch\.my\.salesforce\.com\/lightning\/r\/Account\/001xx\/view\)/);
  assert.match(body, /!\[.*\]\(https:\/\/github\.com\/o\/r\/blob\/evidence\/story-84\/abcdef1\/01-ac1-customer-since\.webp\?raw=true\)/);
  assert.match(body, /Send me a login to this story's scratch org/);
  assert.doesNotMatch(body, /sid=|frontdoor|@org|https:\/\/evil|#12/);
  assert.ok(body.includes(`### ${evidence.EVIDENCE_TITLE}: 6 screenshots`), "Jira finds the comment by this distinctive title, never by plain \"UI evidence\"");
  assert.ok(evidence.removedComment().includes(evidence.EVIDENCE_TITLE) && /screenshots were deleted/.test(evidence.removedComment()));
  assert.doesNotMatch(evidence.evidenceComment({ key: "84", pr: 90, sha: "abc", shots, orgUrl: "https://evil.example", repoUrl: "https://github.com/o/r" }), /open in the scratch org|\]\(https:\/\/evil/);
  assert.throws(() => evidence.folder("../84"), /not a story key/);
});

test("UI evidence storage: one commit replaces the story's folder (retrying a moved branch); squash keeps open stories only, atomically", async () => {
  const calls = [];
  let patches = 0;
  let graphql = {};
  let moved = false;
  const api = (m, path, body) => {
    calls.push([m, path, body]);
    if (m === "POST" && path.endsWith("/git/blobs")) return { sha: `blob${calls.length}` };
    if (m === "GET" && path.endsWith("/git/ref/heads/evidence")) return { object: { sha: moved ? "head2" : "head1" } };
    if (m === "GET" && path.includes("/git/commits/")) return { tree: { sha: "tree1" }, parents: [{ sha: "p" }] };
    if (m === "GET" && path.includes("/git/trees/")) return { tree: [{ type: "blob", path: "story-84/old0000/01-a.webp", sha: "o1", mode: "100644" }, { type: "blob", path: "story-7/aaa/01-b.webp", sha: "o2", mode: "100644" }] };
    if (m === "POST" && path.endsWith("/git/trees")) return { sha: "newtree" };
    if (m === "POST" && path.endsWith("/git/commits")) return { sha: "newcommit" };
    if (m === "PATCH") return ++patches === 1 && !body.force ? { status: 422, message: "not a fast forward" } : {};
    if (m === "GET" && path === "repos/o/r") return { node_id: "R_1" };
    if (m === "POST" && path === "graphql") return graphql;
    return {};
  };
  const shots = [{ name: "01-a.webp", data: webp(1) }];
  assert.equal(evidence.store({ api, repo: "o/r", key: "84", sha: "abcdef1234", shots }), "newcommit");
  const tree = calls.filter(([m, p]) => m === "POST" && p.endsWith("/git/trees")).pop()[2];
  assert.deepEqual(tree.tree.map((e) => [e.path, e.sha]), [["story-84/abcdef1/01-a.webp", "blob1"], ["story-84/old0000/01-a.webp", null]], "the old head's shot is deleted, other stories untouched");
  assert.equal(calls.filter(([m]) => m === "PATCH").length, 2, "a moved branch is retried");

  calls.length = 0;
  const r = await evidence.squash({ api, repo: "o/r", isOpen: async (k) => k === "84" });
  assert.deepEqual(r, { kept: 1, removed: ["7"] });
  const squashTree = calls.find(([m, p]) => m === "POST" && p.endsWith("/git/trees"))[2];
  assert.deepEqual(squashTree.tree.map((e) => e.path), ["story-84/old0000/01-a.webp"]);
  assert.deepEqual(calls.find(([m, p]) => m === "POST" && p.endsWith("/git/commits"))[2].parents, [], "one parentless commit: the branch never grows");
  assert.equal(calls.some(([m]) => m === "PATCH"), false, "never a blind forced PATCH");
  const swap = calls.find(([m, p]) => m === "POST" && p === "graphql")[2];
  assert.match(swap.query, /updateRefs/);
  assert.deepEqual(swap.variables, { id: "R_1", u: [{ name: "refs/heads/evidence", beforeOid: "head1", afterOid: "newcommit", force: true }] }, "moves only if the branch is still where it was read");
  // GitHub answers a stale beforeOid with a generic error (seen live), and gh exits non-zero: the api seam's { status }
  graphql = { status: 500, message: "Something went wrong while executing your query" };
  const realApi = api;
  let reads = 0;
  const racing = (m, path, body) => { if (m === "GET" && path.endsWith("/git/ref/heads/evidence") && ++reads > 1) moved = true; return realApi(m, path, body); };
  assert.equal(await evidence.squash({ api: racing, repo: "o/r", isOpen: async (k) => k === "84" }), null, "a publish landed meanwhile: nothing lost, the next sweep squashes");
  moved = false;
  await assert.rejects(evidence.squash({ api, repo: "o/r", isOpen: async (k) => k === "84" }), /could not squash evidence/, "an error with the branch unmoved is reported");
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

test("evidence() in a real browser: boxed small WebP the trusted check accepts; no-match skips fast; retries and shared captions", async (t) => {
  const { chromium } = await import("@playwright/test");
  if (!existsSync(chromium.executablePath())) return t.skip("no Playwright Chromium here (CI installs it in static checks)");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  try {
    execFileSync("npx", ["playwright", "test", "-c", "pipeline/test/evidence/playwright.config.ts"], { env: { ...process.env, EVIDENCE_DIR: dir }, stdio: "pipe", cwd: new URL("../../", import.meta.url).pathname });
    const files = readdirSync(dir).map((name) => ({ name, data: readFileSync(join(dir, name)) }));
    const { shots, rejected } = evidence.check(files);
    assert.deepEqual(rejected, [], "everything the helper writes passes the trusted check");
    const captions = shots.map((s) => s.caption).sort();
    assert.deepEqual(captions, ["AC1: Customer Since is set", "AC3: many values", "AC4: same caption", "AC4: same caption", "AC5: the passing retry"]);
    for (const s of shots) assert.ok(s.data.length <= 100 * 1024, `${s.name} is ${s.data.length} bytes`);
    assert.ok(!files.some((f) => /only-in-the-failed-attempt/.test(f.name)), "a failed attempt's shot is not evidence");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("UI evidence is in the event log and the weekly metrics", () => {
  const at = "2026-10-07T09:30:00Z";
  const s = events.summarize([{ kind: "evidence", at, story: "134", shots: 2, rejected: 0, kb: 28 }, { kind: "evidence", at, story: "135", shots: 0, rejected: 3, kb: 0 }], { days: 7 });
  assert.deepEqual(s.stages.evidence, { posts: 1, shots: 2, rejected: 3, medianKbPerShot: 14, totalKb: 28 });
  assert.match(events.toMarkdown(s), /\| UI evidence \| 1 posts, 2 screenshots \(3 refused\); median 14 KB each, 28 KB in all \|/);
  assert.doesNotThrow(() => events.event("evidence", { story: "1", shots: 1 }));
});

test("an agent run that finished successfully past its turn cap counts as success (story #143: 69 of 60, PR opened)", () => {
  const a = readFileSync(new URL("../../.github/actions/claude-agent/action.yml", import.meta.url), "utf8");
  assert.match(a, /id: claude\n\s+uses: anthropics\/claude-code-action@v1\n\s+continue-on-error: true/);
  assert.match(a, /if \[ "\$R" = "success false" \]; then echo "::warning::/);
  assert.match(a, /\\\(\.is_error \| tostring\)/, "false must print as false, not vanish under //");
  assert.match(readFileSync(new URL("../../.github/workflows/ai-implement.yml", import.meta.url), "utf8"), /max-turns: "100"/);
  const plan = plans.storyFile({ key: "143", title: "Story: Regional reporting", url: "u", body: "b" }, { plan: null, answers: [] });
  assert.match(plan, /^# Story 143: Regional reporting\n/, "no doubled 'Story:'");
});

test("ai-fix's job can read Actions runs (the round limit and the UI log need actions: read; job permissions replace the workflow's)", () => {
  const wf = readFileSync(new URL("../../.github/workflows/ai-fix.yml", import.meta.url), "utf8");
  const fixJob = wf.slice(wf.indexOf("\n  fix:"), wf.indexOf("\n  follow-up:"));
  assert.match(fixJob, /permissions:[\s\S]*?actions: read/);
  assert.doesNotMatch(fixJob, /actions: write/, "the agent's job never gets to start workflows");
});

test("a fix round counts only when Claude ran in it (PR #144's runs that failed on a permission were not rounds)", () => {
  const runs = [1, 2, 3].map((id) => ({ id, display_title: "ai-fix PR #144", status: "completed", conclusion: "failure" }));
  const ran = { 1: false, 2: false, 3: true };
  assert.equal(verdict.fixRunsFor(runs, 144, 9, (id) => ran[id]), 1);
  assert.equal(verdict.ranAgent([{ steps: [{ name: "Enforce the round limit", conclusion: "failure" }, { name: "Run ./.pipeline/.github/actions/claude-agent", conclusion: "skipped" }] }]), false);
  assert.equal(verdict.ranAgent([{ steps: [{ name: "Run ./.pipeline/.github/actions/claude-agent", conclusion: "failure" }] }]), true);
});

test("reports, report types and dashboards are UI-facing; a review the agent only wrote is still posted (PR #144)", () => {
  assert.deepEqual(names.uiFacing(["force-app/main/default/reports/Regional_Reporting/Accounts_by_Sales_Region.report-meta.xml",
    "force-app/main/default/dashboards/Regional_Reporting/Regional_Sales.dashboard-meta.xml", "force-app/main/default/reportTypes/Opps.reportType-meta.xml",
    "force-app/main/default/classes/X.cls"]).length, 3);
  const wf = readFileSync(new URL("../../.github/workflows/ai-review.yml", import.meta.url), "utf8");
  assert.match(wf, /verdict review "\$PR" --since "\$SINCE"\)" = none \] \|\| exit 0/);
  assert.match(wf, /GH_TOKEN: \$\{\{ steps\.id\.outputs\.token \}\}   # the pipeline's identity/);
  assert.match(wf, /gh pr comment "\$PR" --body-file "\$F"/);
  // the reviewer writes its summary to a file and never posts through the shell (10 quoting failures on PR #144)
  assert.match(wf, /allowed-tools: "Read,Glob,Grep,Write,mcp__github_inline_comment__create_inline_comment,/);
  assert.doesNotMatch(wf, /Bash\(gh pr comment/);
  assert.match(verdict.instructions("review"), /Do not post the summary yourself: write it with the Write tool/);
});

test("review round 3: a spec revision keeps the spec and its story link; screenshots are found wherever the artifact put them; lanes can see runs", () => {
  const spec = specs.specComment("### Problem\nslow\n### User stories\n1. As a manager, I want x\n");
  const pending = specs.pendingComment(spec, { state: "running", what: "Claude is revising the spec" });
  assert.match(pending, /^<!-- pipeline:spec -->\n⏳ \*\*Now:\*\* Claude is revising the spec\n\n### Spec/);
  assert.match(pending, /### Problem\nslow/, "the current spec stays readable while Claude revises it");
  const failed = specs.pendingComment(pending, { state: "failed", what: "Claude could not write the spec" });
  assert.equal((failed.match(/\*\*(Now|Failed):\*\*/g) || []).length, 1, "one status line, the spec intact");
  const ctx = plans.planContext([{ author: "app/pipeline", body: failed, created: "1" }], { mark: specs.SPEC_MARK, title: specs.SPEC_TITLE });
  assert.match(ctx.plan, /^### Spec\n\n### Problem\nslow/, "agents read the spec, not the status line");
  assert.match(specs.pendingComment(null, { state: "running", what: "x" }), /plan-pending/, "a first spec's placeholder is never read as a spec");

  const made = specs.specComment("### User stories\n1. y\n", { story: 143 });
  assert.equal(specs.storyOfSpec(made), 143);
  assert.doesNotMatch(made, /act:story/, "a revision never offers a second story");
  assert.equal(specs.storyOfSpec(specs.pendingComment(made, { state: "running", what: "x" })), 143, "the link survives the pending status");
  assert.doesNotMatch(plans.planContext([{ author: "app/pipeline", body: made, created: "1" }], { mark: specs.SPEC_MARK, title: specs.SPEC_TITLE }).plan, /Story:|story:143/);

  assert.equal(verdict.ranAgent(undefined), true, "an API error counts as a round: the limit holds");
  assert.equal(names.uiFacing(["force-app/main/default/objects/Account/recordTypes/Customer.recordType-meta.xml", "force-app/main/default/objects/Account/webLinks/Map.webLink-meta.xml"]).length, 2);

  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  assert.match(wf("ui-test"), /D=\$\(find art -type d -name evidence/);
  assert.match(wf("commands"), /group: card-\$\{\{ github\.event\.issue\.number \}\}/);
  assert.match(wf("ai-review"), /posted no verdict: tick Run the AI review again" --pr "\$PR"/);
  // every job that waits in an org lane can see whether the holder's run ended (or a dead holder blocks until the TTL)
  for (const f of readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter((x) => x.endsWith(".yml"))) {
    const y = wf(f.replace(/\.yml$/, ""));
    const workflowLevel = (y.match(/\npermissions:\n((?:  .*\n)+)/) || [])[1] || "";
    for (const job of y.split(/\n  (?=[a-z-]+:\n)/).slice(1)) {
      if (!/lane acquire/.test(job)) continue;
      const own = /\n    permissions:/.test(job) ? job : workflowLevel;   // job-level permissions replace the workflow's
      assert.match(own, /actions: (read|write)/, `${f}: a job that runs lane acquire needs actions: read`);
    }
  }
});

test("the review rubric: the UI test spec comes after the review; answers win over the spec text", () => {
  const r = readFileSync(new URL("../../REVIEW.md", import.meta.url), "utf8");
  assert.match(r, /written by the UI test step \*\*after\*\* this review, so its absence here is never a\nfinding/);
  assert.match(r, /win over the spec text/);
});

test("the reviewer's rules come from main (a PR cannot soften its own review)", () => {
  const wf = readFileSync(new URL("../../.github/workflows/ai-review.yml", import.meta.url), "utf8");
  assert.match(wf, /sparse-checkout: "pipeline\\nscripts\\nconfig\\n\.github\/actions\\nbaseline\\ndata\/seed\\nREVIEW\.md\\nCLAUDE\.md\\ndocs\/agents"/);
  assert.match(wf, /following \.pipeline\/REVIEW\.md, \.pipeline\/CLAUDE\.md and \.pipeline\/docs\/agents\/salesforce\.md/);
});

test("a person can overrule a wrong AI review on the exact commit, with the reason on record; the reviewer sees CI (PR #144)", () => {
  const did = [];
  const host = { status: (...a) => did.push(["status", ...a]), dispatch: (w, i) => did.push(["dispatch", w, i]) };
  const pr = { headRefName: "issue-143", headRefOid: "abc1234def", baseRefName: "release/2026-w46" };
  const r = actions.perform("review-ok", "THIS_YEAR is valid SOQL; CI passed", { number: 144, isPr: true, pr }, "pm", { host });
  assert.deepEqual(did[0], ["status", "abc1234def", gate.STATUS.review, "success", "AI review overruled by @pm: THIS_YEAR is valid SOQL; CI passed"]);
  assert.deepEqual(did[1], ["dispatch", "gate.yml", { pr: 144 }]);
  assert.match(r.said, /accepted this change over the AI review on `abc1234`: THIS_YEAR/);
  assert.deepEqual(actions.command("/review-ok because"), { id: "review-ok", arg: "because" });
  assert.equal(verdict.modelFor("review", ""), "claude-sonnet-5-5");
  const wf = readFileSync(new URL("../../.github/workflows/ai-review.yml", import.meta.url), "utf8");
  assert.match(wf, /> "\$RUNNER_TEMP\/ci\.md"/);
  assert.match(wf, /never report it as a syntax or compile error/);
});

test("the UI tester's screenshots must show the criterion met: data first, the element that shows it (story #143 showed an empty report)", () => {
  const wf = readFileSync(new URL("../../.github/workflows/ui-test.yml", import.meta.url), "utf8");
  assert.match(wf, /A screenshot is evidence only if it shows the criterion met: create the records the criterion needs first/);
  assert.match(wf, /never the app name or an empty page/);
});

// ---------------------------------------------------------------- end-to-end round 1 (the spec #125 release)
test("round 1: a weak UI spec fails; evidence never boxes the page header; closed stories' comments are rewritten before their screenshots go", async () => {
  assert.deepEqual(evidence.specProblems("await expect(page.getByRole('heading').first()).toBeVisible();").length, 2);
  assert.deepEqual(evidence.specProblems(readFileSync(new URL("../../e2e/story-84.spec.ts", import.meta.url), "utf8")), []);
  assert.match(readFileSync(new URL("../../e2e/support/evidence.ts", import.meta.url), "utf8"), /its locator points into the page header/);
  const ui = readFileSync(new URL("../../.github/workflows/ui-test.yml", import.meta.url), "utf8");
  assert.match(ui, /pipe\.mjs ui spec-check --file/);
  assert.match(ui, /the spec passed but checks too little/);
  const api = (m, path) => path.endsWith("/git/ref/heads/evidence") ? { object: { sha: "h" } } : path.includes("/git/commits/") ? { tree: { sha: "t" } }
    : { tree: [{ type: "blob", path: "story-143/abc/01-a.webp" }, { type: "blob", path: "story-150/def/01-b.webp" }, { type: "blob", path: "README.md" }] };
  assert.deepEqual(evidence.storiesOnBranch({ api, repo: "o/r" }), ["143", "150"]);
  assert.match(readFileSync(new URL("../../.github/workflows/scratch-janitor.yml", import.meta.url), "utf8"), /issues: write/);
  assert.doesNotMatch(evidence.removedComment(), /open in the scratch org|!\[/);
});

test("round 1: a person's push re-runs the review and resets the fix rounds; the round limit says what to do, once", () => {
  const rv = readFileSync(new URL("../../.github/workflows/ai-review.yml", import.meta.url), "utf8");
  assert.match(rv, /types: \[opened, ready_for_review, labeled, synchronize\]/);
  assert.match(rv, /github\.event\.action != 'synchronize' \|\| github\.event\.sender\.type != 'Bot'/);
  assert.match(rv, /spec-only push: no review/);
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /blocked: a person is on it/);
  const fx = readFileSync(new URL("../../.github/workflows/ai-fix.yml", import.meta.url), "utf8");
  assert.match(fx, /\*\*What you can do:\*\* push a fix yourself/);
  assert.match(fx, /if: failure\(\) && env\.STORY_KEY != '' && steps\.rounds\.outputs\.over != 'true'/);
  const isBot = (l) => /\[bot\]$/.test(l) || l === "__owner__-pipeline";
  const commits = [{ committedDate: "2026-10-08T10:55:01Z", authors: [{ login: "" }, { login: "claude" }] },
    { committedDate: "2026-10-08T11:45:04Z", authors: [{ login: "github-actions[bot]" }, { login: "claude" }] }];
  assert.equal(verdict.lastHumanPush(commits, isBot), "2026-10-08T10:55:01Z", "an AI commit co-authored by Claude is not a person's push");
  const runs = [{ id: 1, display_title: "ai-fix PR #9", status: "completed", conclusion: "success", created_at: "2026-10-08T10:00:00Z" },
    { id: 2, display_title: "ai-fix PR #9", status: "completed", conclusion: "success", created_at: "2026-10-08T11:00:00Z" }];
  assert.equal(verdict.fixRunsFor(runs, 9, 0, () => true, "2026-10-08T10:55:01Z"), 1, "rounds count again from a person's push");
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

test("round 1: spec revisions reach the story; Where keeps the whole Solution; Accept anyway needs a reason; release notes mention UAT", async () => {
  assert.match(specs.revisedNote(125), /Spec #125 was revised\. Its decisions bind this story/);
  const t = specs.storyFromSpec({ spec: 1, title: "Spec: x", text: "### Solution\nManagers see two things:\n- the count\n- the amount\n### User stories\n1. As a manager, I want y\n" });
  assert.match(t.where, /- the count\n- the amount/);
  const r = actions.perform("review-ok", "", { number: 9, isPr: true, pr: { headRefOid: "abc1234" } }, "pm", { host: { status: () => { throw new Error("no reason: no status"); } } });
  assert.match(r.said, /say why in a comment: `\/review-ok <why>`/);
  const notes = await closeout.releaseNotes({ gh: () => [] }, { sprintStories: async () => [{ key: "143", title: "Story: x", state: "OPEN" }] }, "2026-w46");
  assert.match(notes, /- #143 Story: x\n/);
  assert.doesNotMatch(notes, /\[OPEN\]/);
});

// ---------------------------------------------------------------- Org provisioning (round 2)
function provisionSf({ live = [], title = null, snapshotWorks = true } = {}) {
  const calls = [];
  const sf = (args, opts) => {
    const c = args.join(" ");
    calls.push(c);
    if (args[0] === "limits") return [{ name: "ActiveScratchOrgs", remaining: 2, max: 3 }, { name: "DailyScratchOrgs", remaining: 5, max: 6 }];
    if (args[0] === "data" && args[1] === "query" && /FROM User WHERE Username/.test(c)) return { records: [{ Title: title }] };
    if (args[0] === "data" && args[1] === "query" && /FROM UserRole/.test(c)) return { records: [{ Id: "00E1" }] };
    if (args[0] === "data" && args[1] === "query") return { records: live };
    if (args[0] === "org" && args[1] === "display") return { clientId: "CID", username: "u@x", id: "00Dxx0000000001" };
    if (args[0] === "org" && args[1] === "create" && args[2] === "scratch" && c.includes("snapshot-")) { if (!snapshotWorks) throw new Error("sf org failed: SN-0001 The snapshot has expired"); return {}; }
    if (args[0] === "org" && args[1] === "create" && args[2] === "user") return { fields: { id: "005u" } };
    return {};
  };
  return { sf, calls };
}

test("Org provisioning: ready() holds the commit once; creates from the snapshot, else shape; personas set the tester's role", () => {
  // a live org already marked for this commit: nothing deployed again (ui-test used to deploy and prepare twice)
  let { sf, calls } = provisionSf({ live: [{ Description: "issue-12", SignupUsername: "u@x", LoginUrl: "https://s" }], title: "pipeline: ready abc123456789" });
  let o = orgRegistry({ sf, log: () => {}, sleep: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } }).ready("issue-12", { commit: "abc123456789ffff" });
  assert.equal(o.fresh, true);
  assert.ok(!calls.some((c) => c.startsWith("project deploy")));
  // marked for an older commit: deploy, prepare, mark with the new one
  ({ sf, calls } = provisionSf({ live: [{ Description: "issue-12", SignupUsername: "u@x", LoginUrl: "https://s" }], title: "pipeline: ready 000000000000" }));
  o = orgRegistry({ sf, log: () => {}, sleep: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } }).ready("issue-12", { commit: "abc123456789ffff" });
  assert.ok(calls.some((c) => c.startsWith("project deploy start")));
  assert.ok(calls.some((c) => /Title='pipeline: ready abc123456789'/.test(c)));
  // none live, a snapshot set: created from it
  ({ sf, calls } = provisionSf());
  orgRegistry({ sf, log: () => {}, sleep: () => {}, packages: [], env: { SCRATCH_SNAPSHOT: "LCB26100912", BASELINE: "off", SEED: "off" } }).ready("story:12", { commit: "abc" });
  assert.ok(calls.some((c) => c.startsWith("org create scratch") && c.includes("snapshot-")));
  assert.ok(!calls.some((c) => c.includes("config/scratch-dev.json")), "the snapshot worked: no shape create");
  // the snapshot fails (expired): falls back to shape, after removing the half-made attempt
  ({ sf, calls } = provisionSf({ snapshotWorks: false }));
  orgRegistry({ sf, log: () => {}, sleep: () => {}, packages: [], env: { SCRATCH_SNAPSHOT: "LCB26100912", BASELINE: "off", SEED: "off" } }).ready("story:12", { commit: "abc" });
  assert.ok(calls.some((c) => c.includes("config/scratch-dev.json")));
  // a throwaway CI org skips source tracking
  ({ sf, calls } = provisionSf());
  orgRegistry({ sf, log: () => {}, sleep: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } }).temporary("ci-1");
  assert.ok(calls.some((c) => c.startsWith("org create scratch") && c.includes("--no-track-source")));
  // personas
  assert.deepEqual(orgPersonaOf("### Access\n\n- Persona: DirectorDirectSales role, Regional_Reporting_Access\n"), { role: "DirectorDirectSales", permsets: ["Regional_Reporting_Access"] });
  assert.equal(orgPersonaOf("### Access\n\nNo change"), null);
  ({ sf, calls } = provisionSf());
  const t = orgRegistry({ sf, log: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } }).tester("uat", { login: "pm", email: "p@x.com", persona: { role: "DirectorDirectSales", permsets: ["Regional_Reporting_Access"] } });
  assert.deepEqual(t.persona, { role: "DirectorDirectSales", permsets: ["Regional_Reporting_Access"] });
  assert.ok(calls.some((c) => /org assign permset --name Regional_Reporting_Access -o uat/.test(c)));
  assert.ok(calls.some((c) => /UserRoleId=00E1/.test(c)), "the tester gets the persona's role");
  // every workflow readies orgs one way; ui-test no longer deploys and prepares a second time
  for (const f of ["issue-start", "ai-implement", "ai-fix", "ui-test", "staging-deploy", "sprint-start", "uat-deploy"]) {
    const y = readFileSync(new URL(`../../.github/workflows/${f}.yml`, import.meta.url), "utf8");
    assert.match(y, /pipe\.mjs" org ready |pipe\.mjs org ready /, f);
    assert.doesNotMatch(y, /org ensure|org deploy|org prepare/, f);
  }
});

// ---------------------------------------------------------------- production baseline + snapshots (round 3)
test("baseline: all of production, minus the managed, the platform's own and exclusions; sanitized; force-app owns what it holds", async () => {
  const config = JSON.parse(readFileSync(new URL("../../config/baseline.json", import.meta.url), "utf8"));
  const m = (fullName, extra = {}) => ({ fullName, manageableState: "unmanaged", lastModifiedByName: "Brendan Milton", lastModifiedDate: "2026-10-01T00:00:00Z", ...extra });
  const manifest = baselineMod.manifestFor({
    CustomObject: [m("Timesheet__c"), m("Account"), m("pkg__Thing__c", { namespacePrefix: "pkg" })],
    CustomField: [m("Account.SLA__c"), m("Incident.Old__c", { lastModifiedDate: "2026-09-20T00:30:00Z" }), m("Timesheet__c.Hours__c", { lastModifiedDate: "2026-09-20T00:30:00Z" })],
    Layout: [m("Account-Account Layout"), m("Case-Case Layout", { lastModifiedByName: "Salesforce, Inc." })],
    ReportType: [m("Program_sfdcSESv60", { lastModifiedByName: "Salesforce, Inc." }), m("Opps_with_Accounts")],
    PermissionSet: [m("Lifecycle_CI"), m("Timesheet_User")],
    Flow: [m("sfdc_default_ReportExport_Protection_Flow"), m("Weather_Check")],
  }, { config, orgCreated: "2026-09-20T00:00:00Z" });
  assert.deepEqual(manifest, {
    CustomObject: ["Timesheet__c"], CustomField: ["Account.SLA__c", "Timesheet__c.Hours__c"], Layout: ["Account-Account Layout"],
    ReportType: ["Opps_with_Accounts"], PermissionSet: ["Timesheet_User"], Flow: ["Weather_Check"],
  }, "standard objects come only through their children; standard-object children only when a person made them after the org's setup");
  assert.match(baselineMod.packageXml({ Flow: ["Weather_Check"] }), /<members>Weather_Check<\/members>\n    <name>Flow<\/name>/);

  const dash = baselineMod.sanitize("x.dashboard-meta.xml", "<Dashboard><dashboardType>SpecifiedUser</dashboardType>\n<runningUser>admin@prod.com</runningUser></Dashboard>");
  assert.doesNotMatch(dash, /admin@prod/); assert.match(dash, /<dashboardType>LoggedInUser<\/dashboardType>/);
  assert.match(baselineMod.sanitize("Case.workflow-meta.xml", "<integrationUser>workato@koala</integrationUser>"), /__SCRATCH_ADMIN__/);
  assert.doesNotMatch(baselineMod.sanitize("Q.queue-meta.xml", "<Queue><queueMembers><users><user>a@b</user></users><roles><role>X</role></roles></queueMembers></Queue>"), /a@b/);
  assert.throws(() => baselineMod.sanitize("n.namedCredential-meta.xml", "<password>hunter2</password>"), /holds a secret/);

  const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const t = mkdtempSync(join(tmpdir(), "bl-"));
  for (const [f, body] of [["b/objects/Account/fields/SLA__c.field-meta.xml", "x"], ["b/objects/Account/fields/Tier__c.field-meta.xml", "x"], ["fa/objects/Account/fields/Tier__c.field-meta.xml", "x"],
    ["b/sharingRules/ScratchOrgInfo.sharingRules-meta.xml", "<SharingRules/>"], ["b/sharingRules/Account.sharingRules-meta.xml", "<SharingRules><sharingCriteriaRules/></SharingRules>"]]) {
    mkdirSync(join(t, f, ".."), { recursive: true }); writeFileSync(join(t, f), body);
  }
  assert.deepEqual(baselineMod.subtractOwned(join(t, "b"), join(t, "fa")), ["objects/Account/fields/Tier__c.field-meta.xml"], "one owner: force-app");
  assert.deepEqual(baselineMod.dropEmpty(join(t, "b")), ["sharingRules/ScratchOrgInfo.sharingRules-meta.xml"]);
  const id = baselineMod.baselineId(join(t, "b"));
  assert.match(id, /^[0-9a-f]{10}$/);
  writeFileSync(join(t, "b/objects/Account/fields/SLA__c.field-meta.xml"), "changed");
  assert.notEqual(baselineMod.baselineId(join(t, "b")), id, "any change makes a new id, so orgs redeploy it");
  const dir = baselineMod.composeProject({ baselineDir: join(t, "b"), sourceDir: join(t, "fa") });
  const proj = JSON.parse(readFileSync(join(dir, "sfdx-project.json"), "utf8"));
  assert.deepEqual(proj.packageDirectories.map((p) => p.path), ["baseline", "force-app"]);
  assert.equal(proj.replacements[0].replaceWithEnv, "SCRATCH_ADMIN");
  assert.ok(existsSync(join(dir, "baseline/objects/Account/fields/SLA__c.field-meta.xml")));
  assert.match(baselineMod.driftSummary(["?? baseline/main/default/objects/Account/fields/SLA__c.field-meta.xml"], { CustomField: [m("Account.SLA__c")] }), /\| added \| `objects\/Account\/fields\/SLA__c` \| Brendan Milton, 2026-10-01 \|/);
});

test("baseline in orgs: one combined deploy; soft falls back to force-app alone; the newest Active snapshot is found; baseline/ is pipeline-owned", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const b = mkdtempSync(join(tmpdir(), "blo-"));
  mkdirSync(join(b, "objects"), { recursive: true }); writeFileSync(join(b, "objects/x.xml"), "x");
  const run = (deployOk) => {
    const calls = [];
    const sf = (args, opts) => {
      const c = args.join(" "); calls.push([c, opts]);
      if (args[0] === "org" && args[1] === "display") return { username: "admin@scratch" };
      if (args[0] === "project" && args[1] === "deploy") return c.includes("-d baseline") ? (deployOk ? { success: true } : null) : { success: true };
      if (args[0] === "org" && args[1] === "list" && args[2] === "snapshot") return [{ SnapshotName: "LCB2610080100", Status: "Active", CreatedDate: "2026-10-08T01:00:00Z" },
        { SnapshotName: "LCB2610090100", Status: "InProgress", CreatedDate: "2026-10-09T01:00:00Z" }, { SnapshotName: "LCBTEST1", Status: "Active", CreatedDate: "2026-10-10T00:00:00Z" }];
      return {};
    };
    const events = [];
    const r = orgRegistry({ sf, log: () => {}, sleep: () => {}, packages: [], baselineDir: b, env: { BASELINE: "soft", SEED: "off" }, record: (k, d) => events.push([k, d]) });
    return { r, calls, events };
  };
  let { r, calls, events } = run(true);
  assert.deepEqual(r.deploy("issue-1"), { baseline: baselineMod.baselineId(b) });
  const combined = calls.find(([c]) => c.startsWith("project deploy start"));
  assert.match(combined[0], /-d baseline -d force-app/);
  assert.deepEqual(combined[1].env, { SCRATCH_ADMIN: "admin@scratch" }, "the outbound-message token becomes the org's admin");
  ({ r, calls, events } = run(false));
  assert.deepEqual(r.deploy("issue-1"), { baseline: null });
  assert.ok(calls.some(([c]) => /^project deploy start -o issue-1 -d force-app/.test(c)), "soft: force-app alone");
  assert.equal(events[0][0], "baseline");
  assert.equal(r.currentSnapshot(), "LCB2610080100", "the newest ACTIVE pipeline snapshot (not in progress, not a test one)");
  assert.equal(orgRegistry({ sf: () => [], log: () => {}, packages: [], env: { SCRATCH_SNAPSHOT: "off" } }).currentSnapshot(), null);
  assert.equal(names.orgFor("snapshot").kind, "snapshot");
  assert.ok(names.touchesPipeline(["baseline/main/default/objects/X.xml"]).length, "story PRs cannot edit baseline/");
  const rel = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(rel, /gh workflow run prod-baseline\.yml --ref main/);
  assert.match(rel, /gh workflow run snapshot-refresh\.yml --ref main/);
  assert.match(readFileSync(new URL("../../.github/workflows/prod-baseline.yml", import.meta.url), "utf8"), /github\.event_name != 'schedule' \|\| vars\.BASELINE_NIGHTLY == 'true'/);
});

test("prod-baseline checks out main before the identity action re-clones it (a .pipeline checkout first was wiped)", () => {
  const wf = readFileSync(new URL("../../.github/workflows/prod-baseline.yml", import.meta.url), "utf8");
  assert.match(wf, /uses: actions\/checkout@v4\n\s+with: \{ ref: main \}[^\n]*\n\s+- id: id\n\s+uses: \.\/\.github\/actions\/pipeline-identity/);
  assert.doesNotMatch(wf, /\.pipeline\//);
});

// ---------------------------------------------------------------- test data (round 4)
test("seed: dates never go stale; loaded once per org (markers); a story's own data too; never production", async () => {
  const out = expandSeed({ "a.json": '{"CloseDate":"${THIS_YEAR}-03-15","Name":"${SEED_MARKER}","Next":"${NEXT_YEAR}-01-01"}' }, { today: new Date("2026-10-09T00:00:00Z"), marker: "[seed abc]" });
  assert.equal(out["a.json"], '{"CloseDate":"2026-03-15","Name":"[seed abc]","Next":"2027-01-01"}');
  const real = JSON.parse(readFileSync(new URL("../../data/seed/Opportunity.json", import.meta.url), "utf8")).records;
  assert.ok(real.every((r) => /^\$\{(THIS|NEXT|LAST)_YEAR\}-\d\d-\d\d$/.test(r.CloseDate)), "seed dates are tokens");
  assert.ok(readFileSync(new URL("../../data/seed/Account.json", import.meta.url), "utf8").includes("${SEED_MARKER}"));
  const plan = JSON.parse(readFileSync(new URL("../../data/seed/plan.json", import.meta.url), "utf8"));
  assert.deepEqual(plan.map((p) => p.sobject), ["Account", "Contact", "Opportunity", "Case", "Lead"]);

  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const seedDir = mkdtempSync(join(tmpdir(), "seed-"));
  writeFileSync(join(seedDir, "plan.json"), JSON.stringify([{ sobject: "Account", files: ["Account.json"] }]));
  writeFileSync(join(seedDir, "Account.json"), JSON.stringify({ records: [{ attributes: { type: "Account", referenceId: "M" }, Name: "${SEED_MARKER}" }] }));
  const story = mkdtempSync(join(tmpdir(), "story-"));
  mkdirSync(join(story, "data/seed/stories/150"), { recursive: true });
  writeFileSync(join(story, "data/seed/stories/150/plan.json"), JSON.stringify([{ sobject: "Lead", files: ["Lead.json"] }]));
  writeFileSync(join(story, "data/seed/stories/150/Lead.json"), JSON.stringify({ records: [] }));
  const mk = ({ have = false, prodId = "00D000000000001" } = {}) => {
    const calls = [];
    const sf = (args) => {
      calls.push(args.join(" "));
      if (args[0] === "org" && args[1] === "display") return { id: args.includes("devhub") ? prodId : "00D000000000002", username: "a@b" };
      if (args[0] === "data" && args[1] === "query") return { records: have ? [{ Id: "001" }] : [] };
      return {};
    };
    return { calls, r: orgRegistry({ sf, log: () => {}, packages: [], seedDir, env: { BASELINE: "off" } }) };
  };
  const cwd = process.cwd();
  process.chdir(story);
  try {
    let { r, calls } = mk();
    const loaded = r.seed("issue-150", { story: "150" });
    assert.equal(loaded.length, 2, "the core seed, then the story's own");
    assert.match(loaded[1], /^\[seed story 150 /);
    assert.equal(calls.filter((c) => c.startsWith("data import tree")).length, 2);
    ({ r, calls } = mk({ have: true }));
    assert.deepEqual(r.seed("issue-150", { story: "150" }), [], "markers present (e.g. from the snapshot): nothing loaded again");
    ({ r } = mk({ prodId: "00D000000000002" }));
    assert.throws(() => r.seed("devhub"), /refusing to load test data into devhub: it is production/);
  } finally { process.chdir(cwd); }
});

test("Org Shape roles are rebuilt so they can be assigned; personas log in through Log in as (no password)", () => {
  const { roleRebuild } = orgMod;
  const roles = [{ Id: "1", Name: "CEO", DeveloperName: "CEO", ParentRoleId: null, CaseAccessForAccountOwner: "Edit", ContactAccessForAccountOwner: "Edit", OpportunityAccessForAccountOwner: "Read" },
    { Id: "2", Name: "Director", DeveloperName: "DirectorDirectSales", ParentRoleId: "1", RollupDescription: "Direct & Sales" },
    { Id: "3", Name: "Western", DeveloperName: "WesternSalesTeam", ParentRoleId: "2" }];
  const { levels, files } = roleRebuild(roles);
  assert.deepEqual(levels, [["3"], ["2"], ["1"]], "leaves are deleted first");
  assert.match(files.WesternSalesTeam, /<parentRole>DirectorDirectSales<\/parentRole>/);
  assert.match(files.DirectorDirectSales, /<description>Direct &amp; Sales<\/description>/);
  assert.match(files.CEO, /<opportunityAccessLevel>Read<\/opportunityAccessLevel>/);
  assert.doesNotMatch(files.CEO, /parentRole/);
  const login = readFileSync(new URL("../../e2e/support/login.ts", import.meta.url), "utf8");
  assert.match(login, /servlet\/servlet\.su\?oid=/);
  assert.match(login, /LICENSE_LIMIT_EXCEEDED/);
  assert.doesNotMatch(login, /"generate", "password"|"org", "create", "user"/, "no password, and no create user (JWT on Hyperforce refuses it)");
  assert.match(readFileSync(new URL("../../pipeline/src/org.mjs", import.meta.url), "utf8"), /enableAdminLoginAsAnyUser>true/);
  assert.match(readFileSync(new URL("../../.github/workflows/ui-test.yml", import.meta.url), "utf8"), /loginAs\(page, \{ role, permsets \}\)/);
});

test("persona lines with an explanation after them still give the role and the permission sets (story #166)", () => {
  assert.deepEqual(orgPersonaOf("### Access\n\n- Persona: DirectorDirectSales role, Regional_Reporting_Access. (One of the five manager roles the report folder is shared with; reps, who have no such role or set, must not see it.)\n"),
    { role: "DirectorDirectSales", permsets: ["Regional_Reporting_Access"] });
  assert.deepEqual(orgPersonaOf("Persona: `WesternSalesTeam` role (a rep)"), { role: "WesternSalesTeam", permsets: [] });
});

test("a story that has not started keeps its Start card when something refreshes it (story #166 showed 'branch and org' it did not have)", () => {
  const src = readFileSync(new URL("../src/card.mjs", import.meta.url), "utf8");
  assert.match(src, /not started \(no PR, no branch\): the card offers Plan and Start/);
  assert.match(newStoryCard({ key: "166", ai: { plan: true } }), /act:start/);
});

test("enterprise A: a CLI warning never hides the real error; a refused snapshot is not tried again; rebuilds at most daily; cards change at the start, not on every poll", async () => {
  const { failureDetail } = await import("../src/io.mjs");
  assert.equal(failureDetail('{"status":1,"name":"SnapshotNotActive","message":"The snapshot is not active"}', " ›   Warning: @salesforce/cli update available from 2.152 to 2.153"), "SnapshotNotActive: The snapshot is not active");
  assert.equal(failureDetail("", " ›   Warning: @salesforce/cli update available\nERROR: boom"), "ERROR: boom");
  // gh api: the JSON body says "Not Found"; the status codeHost.api reads is on stderr and must survive (a 404 read as
  // a 500 broke every lane on story #166's start)
  const gh404 = failureDetail('{"message":"Not Found","documentation_url":"https://docs.github.com","status":"404"}', "gh: Not Found (HTTP 404)");
  assert.match(gh404, /^Not Found \| gh: Not Found \(HTTP 404\)$/);
  const { codeHost } = await import("../src/github.mjs");
  const fail = () => { const e = new Error(`gh api -X GET failed: ${gh404}`); throw e; };
  assert.equal(codeHost({ io: { run: fail }, env: { GH_REPO: "o/r" } }).api("GET", "repos/o/r/git/ref/locks/x").status, 404);
  const list = [{ SnapshotName: "LCB2610081953", Status: "Active", CreatedDate: "2026-10-08T19:53:51.000+0000" }, { SnapshotName: "LCB2610081922", Status: "Active", CreatedDate: "2026-10-08T19:22:19.000+0000" }];
  const sf = (a) => (a[0] === "org" && a[2] === "snapshot" ? list : {});
  const r = orgRegistry({ sf, log: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" }, snapshotRefused: (n) => n === "LCB2610081953" });
  assert.equal(r.currentSnapshot(), "LCB2610081922", "the refused one is skipped");
  assert.equal(Math.round(r.snapshotAgeHours(Date.parse("2026-10-09T07:53:51Z"))), 12);
  const src = readFileSync(new URL("../bin/pipe.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /polls\+\+ % 8/, "no card refresh on every few test polls");
  assert.match(readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"), /snapshot-refresh\.yml --ref main -f if-older-than=20/);
});

test("approver (enterprise B): the story's approver approves, never the person who pushed the latest change; APPROVERS unset keeps today's rule", () => {
  const team = { approvers: ["alice", "carol"], storyApprover: "alice", lastPusher: "bob" };
  assert.equal(gate.approvalProblem({ ...team, approvers: [] }, "bob"), null, "no policy: anyone with write access");
  assert.equal(gate.approvalProblem(team, "alice"), null);
  assert.match(gate.approvalProblem(team, "bob"), /@bob pushed the latest change, so @alice \(the approver\) needs to approve/);
  assert.match(gate.approvalProblem(team, "carol"), /@alice is this story's approver/);
  const selfPushed = { ...team, lastPusher: "alice" };   // the approver fixed it themselves: another approver steps in
  assert.match(gate.approvalProblem(selfPushed, "alice"), /pushed the latest change/);
  assert.equal(gate.approvalProblem(selfPushed, "carol"), null);
  assert.match(gate.approvalProblem(selfPushed, "dave"), /@alice is this story's approver/);
  const none = { ...team, storyApprover: null };   // a release, or a story with no Approver line
  assert.equal(gate.approvalProblem(none, "Carol"), null, "logins compare case-insensitively");
  assert.match(gate.approvalProblem(none, "dave"), /not an approver \(APPROVERS: @alice, @carol\)/);

  assert.equal(gate.approverOf("### Access\n\nx\n\n### Approver\n\n@alice\n"), "alice");
  assert.equal(gate.approverOf("### Approver\n\n_No response_"), null);
  assert.deepEqual(gate.approverList("@alice, carol  dave"), ["alice", "carol", "dave"]);
  assert.equal(gate.lastPusherOf([
    { committedDate: "2026-10-09T01:00:00Z", authors: [{ login: "bob" }] },
    { committedDate: "2026-10-09T03:00:00Z", authors: [{ login: "github-actions" }] },   // the pipeline
    { committedDate: "2026-10-09T02:00:00Z", authors: [{ login: "dave" }, { login: "claude" }] },
  ]), "dave");

  // the gate: PR #23 was approved by matchmoments-admin; with a policy, only the named approver's approval counts
  const f = withVerdicts(fixture(23));
  assert.deepEqual(gate.evaluate({ ...f, approvers: ["matchmoments-admin"], storyApprover: null, lastPusher: "someone-else" }).reasons, []);
  assert.match(gate.evaluate({ ...f, approvers: ["matchmoments-admin", "lead"], storyApprover: "lead", lastPusher: "x" }).reasons.join(), /approval does not count: @lead is this story's approver/);
  assert.match(gate.evaluate({ ...f, approvers: ["matchmoments-admin"], lastPusher: "matchmoments-admin" }).reasons.join(), /pushed the latest change/);
  // a ticked Sign off names its person (the trusted status says who); it is checked the same way
  const signed = { ...f, reviews: [], statuses: [...f.statuses, { ...ok(f.pr.headRefOid, gate.STATUS.signoff), description: "Signed off by @alice" }] };
  assert.deepEqual(gate.approval({ ...signed, head: f.pr.headRefOid, ...team }, { signOff: true }).by, ["alice"]);
  assert.match(gate.approval({ ...signed, head: f.pr.headRefOid, ...team, lastPusher: "alice" }, { signOff: true }).refused[0].why, /pushed the latest change/);
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

test("RunRelevantTests (enterprise C): CI lets Salesforce choose a story's Apex tests, falls back to our selection when it runs none; production never accepts a zero-test validation", () => {
  const calls = [];
  const report = { status: "Succeeded", done: true, numberTestsCompleted: 3, numberTestErrors: 1, details: { runTestResult: { numTestsRun: 3,
    successes: [{ name: "CaseHandlerTest", methodName: "a" }, { name: "CaseHandlerTest", methodName: "b" }],
    failures: { name: "RegionTest", methodName: "c", message: "boom" },
    codeCoverage: [{ name: "CaseHandler", numLocations: 20, numLocationsNotCovered: 4 }] } } };
  const io = (rep) => ({ sf: (a) => { calls.push(a.join(" ")); return a[2] === "validate" ? { id: "0AfR" } : rep; } });
  const changed = ["force-app/main/default/classes/CaseHandler.cls", "force-app/main/default/lwc/regionCard/regionCard.js", "force-app/main/default/lwc/regionCard/regionCard.html", "README.md"];
  const r = tests.runRelevant(io(report), { alias: "issue-7", changed, sleep: () => {} });
  assert.match(calls[0], /deploy validate -o issue-7 --source-dir force-app\/main\/default\/classes\/CaseHandler\.cls --source-dir force-app\/main\/default\/lwc\/regionCard --test-level RunRelevantTests --async$/, "a bundle deploys as its folder; non-source files stay out");
  assert.deepEqual(r.chosen, ["CaseHandlerTest", "RegionTest"]);
  assert.equal(r.state.apex.ran, 3);
  assert.equal(r.state.apex.failed, 1);
  assert.equal(r.state.apex.failures[0].test, "RegionTest.c");
  assert.equal(r.state.coverage.CaseHandler, 80);
  const logs = [];
  assert.equal(tests.runRelevant(io({ status: "Succeeded", done: true, details: { runTestResult: { numTestsRun: 0 } } }), { alias: "a", changed, sleep: () => {}, log: (l) => logs.push(l) }), null, "zero tests: not trusted");
  assert.match(logs.join(), /ran no tests.*our own test selection/);
  assert.equal(tests.runRelevant({ sf: () => { throw new Error("INVALID_TEST_LEVEL"); } }, { alias: "a", changed, sleep: () => {} }), null, "an org without the beta");
  // the runner takes RunRelevantTests' results and runs no Apex of its own (flow tests still run)
  const st = tests.runTests({ sf: (a) => { calls.push(a.join(" ")); return a[1] === "run" ? { testRunId: "f1" } : { summary: { outcome: "Passed" }, tests: [{ FullName: "F.t", Outcome: "Pass" }] }; } },
    { alias: "a", plan: { mode: "relevant", apex: r.chosen, flows: ["F"] }, sleep: () => {}, apexDone: r.state });
  assert.equal(st.apex.ran, 3);
  assert.equal(st.flows.ran, 1);
  assert.ok(!calls.some((c) => c.startsWith("apex run test")));

  // production: a "Succeeded" RunRelevantTests validation that ran nothing is re-run with every test class
  const prodCalls = [];
  const reports = [{ status: "Succeeded", done: true, numberTestsTotal: 0, details: { runTestResult: { numTestsRun: 0 } } }, { status: "Succeeded", done: true, numberTestsTotal: 2 }];
  const p = production.validate({ sf: (a) => { prodCalls.push(a.join(" ")); return a[2] === "validate" ? { id: "0AfP" } : reports.shift(); } }, { source: ["-d", "force-app"], allTests: ["A", "B"], sleep: () => {} });
  assert.equal(p.level, "all");
  assert.match(prodCalls.at(-2), /--test-level RunSpecifiedTests --tests A --tests B/);
});

test("delivery record (enterprise D): the shipped story's trail, read from GitHub, as one table and one JSON line; an overrule keeps its full reason", async () => {
  const { gatherDelivery, deliveryRecord, apply, DELIVERY_MARK } = await import("../src/closeout.mjs");
  const R = "repos/o/r";
  const reason = "THIS_YEAR is valid SOQL and CI passed; the reviewer misread the date literal, which the Salesforce docs list as a valid filter for CreatedDate";
  const data = {
    "issue view 166": { title: "Story: Regional Sales dashboard", body: "### Approver\n\n@alice\n", createdAt: "2026-10-08T00:00:00Z" },
    "pr list issue-166": [{ number: 180, headRefName: "issue-166", headRefOid: "h180", createdAt: "2026-10-08T06:00:00Z", mergedAt: "2026-10-09T00:00:00Z", commits: [{ committedDate: "2026-10-08T07:00:00Z", authors: [{ login: "bob" }] }] }],
    [`${R}/commits/h180/statuses?per_page=100`]: [
      { context: "pipeline/ai-review", state: "success", description: `AI review overruled by @alice: ${reason}`.slice(0, 139), created_at: "2026-10-08T08:00:00Z" },
      { context: "pipeline/ui-test", state: "success", target_url: "https://github.com/o/r/issues/166#issuecomment-9", created_at: "2026-10-08T08:30:00Z" },
      { context: "pipeline/sign-off", state: "success", description: "Signed off by @alice", created_at: "2026-10-08T12:00:00Z" }],
    [`${R}/pulls/180/reviews?per_page=100`]: [],
    [`${R}/issues/180/comments?per_page=100`]: [{ body: `✋ @alice accepted this change over the AI review on \`abc1234\`: ${reason}. A new push needs a review again.` }],
    "pr list release/2026-w47": [{ number: 181, headRefOid: "r181", mergedAt: "2026-10-10T00:00:00Z" }],
    [`${R}/commits/r181/statuses?per_page=100`]: [{ context: "pipeline/uat", state: "success", description: "Signed off in UAT by @carol", created_at: "2026-10-09T20:00:00Z" }],
    [`${R}/commits/r181/check-runs?per_page=100`]: { check_runs: [{ name: "Production validation", conclusion: "success", output: { summary: "**Check-only deploy to production** `0AfAB000001xyz` with **RunRelevantTests**." } }] },
  };
  const gh = (a) => a[0] === "api" ? data[a[1]] : a[0] === "issue" ? data[`issue view ${a[2]}`] : data[`pr list ${(a.find((x) => /^head:|^release\//.test(x)) || "").replace("head:", "")}`];
  const d = gatherDelivery("166", gh, { tag: "v2026.10.10-1", sprint: "2026-w47", now: new Date("2026-10-10T01:00:00Z"), repo: "o/r" });
  assert.equal(d.approver, "alice");
  assert.deepEqual(d.approved, { by: "alice", at: "2026-10-08T12:00:00Z", how: "ticked Sign off" });
  assert.equal(d.lastPusher, "bob");
  assert.equal(d.review.overruledBy, "alice");
  assert.equal(d.review.reason, reason, "the full reason, not the 139-character status");
  assert.equal(d.uat, "carol");
  assert.equal(d.validation, "0AfAB000001xyz");
  const md = deliveryRecord(d);
  assert.match(md, /\| Approved by \| @alice \(ticked Sign off, 2026-10-08 12:00 UTC\) \|/);
  assert.match(md, /\| AI review \| overruled by @alice: THIS_YEAR is valid SOQL.*CreatedDate \|/);
  assert.match(md, /\| lead time \(story opened → in production\) \| 48 \|/);
  const json = JSON.parse(md.match(/<!-- delivery: (.*) -->/)[1]);
  assert.equal(json.hours["PR opened → approved"], 6);
  // apply writes it once per shipped story, through the tracker's marked comment (re-running updates it)
  const cards = [];
  const tracker = { story: async () => ({ state: "OPEN" }), done: async () => {}, carry: async () => {}, closeSprint: async () => {}, card: async (k, body, mark) => cards.push([k, mark, body]) };
  await apply({ sprint: "2026-w47", ship: ["166"], carry: [], hotfix: [], deleteOrgs: [], deleteBranch: null }, { tag: "v1", tracker, orgs: { remove: () => {} }, git: () => "", gh, log: () => {} });
  assert.equal(cards.length, 1);
  assert.equal(cards[0][1], DELIVERY_MARK);
});

test("admins' path (enterprise D): a login to the story's org from the story itself, as the persona or as an admin; Setup changes come back as a commit; people's changes only", () => {
  const did = [];
  const deps = { host: { dispatch: (...a) => did.push(a) }, appGh: () => {}, gh: () => {}, inUat: () => false };
  actions.perform("org-login-admin", "", { number: 166, isPr: false }, "alice", deps);
  actions.perform("org-login", "", { number: 180, isPr: true, pr: { headRefName: "issue-166" } }, "bob", deps);
  actions.perform("retrieve", "", { number: 166, isPr: false }, "alice", deps);
  assert.deepEqual(did, [
    ["uat-login.yml", { pr: 166, who: "alice", target: "issue-166", admin: "true" }],
    ["uat-login.yml", { pr: 180, who: "bob", target: "issue-166", admin: "false" }],
    ["story-retrieve.yml", { story: "166", who: "alice" }]]);
  assert.equal(actions.command("/admin-login").id, "org-login-admin");
  assert.equal(actions.command("/retrieve").id, "retrieve");
  // the started story's card offers them before there is a PR
  const card = storyCard({ key: "166", repoUrl: "https://github.com/o/r", branch: "issue-166", base: "release/w", ai: { plan: true } });
  assert.match(card, /act:org-login-admin/);
  assert.match(card, /act:retrieve/);

  // what people changed: only the logins the pipeline gave people (ChangedBy holds 15-character ids), never the org's
  // admin user (the pipeline's deploys), system users, profiles, exclusions, deletions or a bundle's sub-parts
  const calls = [];
  const sf = (a) => {
    const c = a.join(" "); calls.push(c);
    if (/FROM User/.test(c)) return { records: [{ Id: "005ALICE00000AAQA3" }] };
    if (/ChangedBy/.test(c)) return null;   // an older API: LastModifiedById instead
    if (/FROM SourceMember/.test(c)) return { records: [
      { MemberType: "CustomField", MemberName: "Account.Tier__c", LastModifiedById: "005ALICE00000AA" },
      { MemberType: "CustomField", MemberName: "Account.Tier__c", LastModifiedById: "005ALICE00000AA" },
      { MemberType: "Profile", MemberName: "Admin", LastModifiedById: "005ALICE00000AA" },
      { MemberType: "ApexClass", MemberName: "RegionService", LastModifiedById: "005ADMIN00000AA" },
      { MemberType: "Layout", MemberName: "Account-Old", IsNameObsolete: true, LastModifiedById: "005ALICE00000AA" },
      { MemberType: "PermissionSet", MemberName: "Lifecycle_CI", LastModifiedById: "005ALICE00000AA" },
      { MemberType: "LightningComponentResource", MemberName: "regionCard/regionCard.js", LastModifiedById: "005ALICE00000AA" },
      { MemberType: "FlexiPage", MemberName: "Account_Record_Page", LastModifiedById: "005ALICE00000AA" }] };
    return {};
  };
  const r = orgRegistry({ sf, log: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } });
  const ch = r.setupChanges("issue-166", { exclude: ["PermissionSet:Lifecycle_CI"] });
  assert.deepEqual(ch, [{ type: "CustomField", name: "Account.Tier__c" }, { type: "FlexiPage", name: "Account_Record_Page" }]);
  r.retrieveChanges("issue-166", ch);
  assert.ok(calls.includes("project retrieve start -o issue-166 -m CustomField:Account.Tier__c -m FlexiPage:Account_Record_Page --ignore-conflicts"));
  const wf = readFileSync(new URL("../../.github/workflows/story-retrieve.yml", import.meta.url), "utf8");
  assert.match(wf, /Co-authored-by: \$WHO/, "the person is the change's author: someone else approves it");
  assert.match(wf, /path: \.pipeline/, "main's pipeline code, never the branch's");
  assert.match(wf, /set -o pipefail/, "a failed retrieve is a failure, not \"nothing new\"");
  assert.ok(calls.some((c) => /Username LIKE '%\.pipeline' AND \(NOT Username LIKE 'persona\.%'\)/.test(c)));
});

test("full runs in a scratch org (story #166): this repo's tests and coverage, not production's own classes the baseline brings; a dashboard does not force everything", () => {
  const src = {
    "force-app/main/default/classes/AccountSelector.cls": "public class AccountSelector {}",
    "force-app/main/default/classes/AccountSelectorTest.cls": "@IsTest(testFor='ApexClass:AccountSelector') class AccountSelectorTest {}",
    "force-app/main/default/classes/RegionalReportingTest.cls": "@IsTest class RegionalReportingTest { /* Regional_Reporting */ }",
    "force-app/main/default/triggers/CaseTrigger.trigger": "trigger CaseTrigger on Case (before insert) {}",
    "force-app/main/default/dashboards/Regional_Reporting.dashboardFolder-meta.xml": "<DashboardFolder/>",
    "force-app/main/default/dashboards/Regional_Reporting/Regional_Sales.dashboard-meta.xml": "<Dashboard/>",
  };
  const files = Object.keys(src), read = (p) => src[p] || "";
  const all = tests.selectTests({ changed: [], files, read, mode: "all" });
  assert.deepEqual(all.apex, ["AccountSelectorTest", "RegionalReportingTest"]);
  assert.deepEqual(all.code, ["AccountSelector", "CaseTrigger"]);
  const dash = tests.selectTests({ changed: files.filter((p) => p.includes("/dashboards/")), files, read });
  assert.equal(dash.mode, "relevant", "a dashboard is not 'metadata that can affect anything'");
  assert.deepEqual(dash.apex, ["RegionalReportingTest"], "the test that names its folder");
  // the runner: RunSpecifiedTests with the repo's tests; coverage from the repo's classes only (live: org-wide read 10%)
  const calls = [];
  const io = { sf: (a) => {
    calls.push(a.join(" "));
    if (a[1] === "run") return { testRunId: "707" };
    if (a[0] === "data") return { records: /ApexTestQueueItem/.test(a.join(" ")) ? [{ Status: "Completed" }] : [{ Outcome: "Pass", MethodName: "m", ApexClass: { Name: "AccountSelectorTest" } }] };
    return { summary: { orgWideCoverage: "10%" }, coverage: { coverage: [
      { name: "AccountSelector", totalLines: 9, totalCovered: 9, coveredPercent: 100 },
      { name: "CaseTrigger", totalLines: 11, totalCovered: 7, coveredPercent: 64 },
      { name: "MeterApi", totalLines: 400, totalCovered: 0, coveredPercent: 0 }] } };
  } };
  const st = tests.runTests(io, { alias: "issue-166", plan: { ...all, flows: [] }, sleep: () => {} });
  assert.match(calls[0], /apex run test -o issue-166 --test-level RunSpecifiedTests --tests AccountSelectorTest --tests RegionalReportingTest --code-coverage/);
  assert.equal(st.orgWide, 80, "16 of 20 repo lines, not 10% of the org");
  assert.equal(tests.verdict(st, { plan: all }).ok, true);
});

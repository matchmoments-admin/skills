// Tests through each module's interface. Gate fixtures are this repo's real PRs from sprint 2026-w41.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as names from "../src/conventions.mjs";
import * as gate from "../src/gate.mjs";
import * as verdict from "../src/verdict.mjs";
import { plan } from "../src/closeout.mjs";
import { jiraTracker, githubTracker, adfToText } from "../src/tracker.mjs";
import { orgRegistry } from "../src/org.mjs";
import { summarize, toMarkdown, aiCost } from "../src/metrics.mjs";
import { typesafeJev, triageUiFailure, triageReview } from "../src/jev.mjs";
import { storyCard, CARD_MARK } from "../src/card.mjs";

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
  assert.deepEqual(names.orgFor("story:12"), { kind: "story", key: "12", alias: "issue-12", description: "issue-12", lock: "org-issue-12", definition: "config/scratch-dev.json", days: 3 });
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
  assert.match(gate.evaluate(pr({ uiTest: true })).reasons.join(), /UI test has not run on this code \(label ai:test\)/);
  assert.deepEqual(gate.evaluate(pr({ uiTest: true }, { compare: { prFiles: ["force-app/main/default/classes/X.cls"] } })).reasons, []);   // not UI-facing
  const withSpec = { compare: { prFiles: ["force-app/main/default/layouts/A.layout-meta.xml", "e2e/story-2.spec.ts"] } };
  assert.match(gate.evaluate(pr({}, withSpec)).reasons.join(), /UI test has not run on this code \(label test/);   // committed spec, no AI
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
  assert.deepEqual(p.deleteOrgs, ["story:1", "story:3", "sprint:2026-w41", "story:8"]);
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
  assert.deepEqual(calls, ["issue comment 2 --body carried", "issue edit 2 --remove-milestone"]);
  assert.deepEqual(await t.sprintStories("w41"), [{ key: "2", title: "Urgent", state: "OPEN" }]);
  assert.equal(adfToText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }] }] }).trim(), "a\nb");
});

// ---------------------------------------------------------------- org registry (fake sf)
function fakeSf(records) {
  const calls = [];
  const sf = (args, opts) => {
    calls.push(args.slice(0, 3).join(" "));
    if (args[0] === "data" && args[1] === "query") return { records };
    if (args[0] === "org" && args[1] === "display") return { clientId: "CID", username: "u@x" };
    return {};
  };
  return { sf, calls };
}

test("org registry: attaches the live org found by Description; never creates when one exists", () => {
  const { sf, calls } = fakeSf([{ Description: "issue-12", SignupUsername: "u@x", LoginUrl: "https://s", ExpirationDate: "2026-10-07" }, { Description: "staging-w", SignupUsername: "s@x", LoginUrl: "https://t" }]);
  const r = orgRegistry({ sf, log: () => {}, sleep: () => {} });
  assert.equal(r.find("story:99"), null);
  const o = r.ensure("issue-12");
  assert.equal(o.created, false);
  assert.ok(calls.includes("org login jwt"));
  assert.ok(!calls.includes("org create scratch"));
});

test("org registry: creates, deploys and prepares when none is live; remove is a no-op when none", () => {
  const { sf, calls } = fakeSf([]);
  const r = orgRegistry({ sf, log: () => {}, sleep: () => {} });
  const o = r.ensure("story:12", { hotfix: true });
  assert.equal(o.created, true);
  assert.equal(o.definition, "config/scratch-hotfix.json");
  assert.deepEqual(calls.filter((c) => !c.startsWith("data query")).slice(0, 4), ["limits api display", "org create scratch", "project deploy start", "org display -o"]);   // capacity first
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
  assert.throws(() => orgRegistry({ sf, log: () => {}, sleep: () => {} }).ensure("story:9"), /No free scratch org slot/);
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
  const gh = (args) => (args[1] === "list" ? [{ number: 40, headRefName: "issue-5" }] : (closed.push(args[2]), null));
  const { apply } = await import("../src/closeout.mjs");
  await apply({ sprint: "w", ship: ["1", "3"], carry: [], hotfix: [], deleteOrgs: [], deleteBranch: "release/w" },
    { tag: "v1", tracker, orgs: { remove: () => true }, git: () => "", gh, log: () => {} });
  assert.deepEqual(done, ["3"]);       // story 1 was already closed by an earlier run
  assert.deepEqual(closed, ["40"]);
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
  assert.deepEqual(s.pipeline.ci, { runs: 2, successRate: 50, medianMinutes: 15 });
  assert.match(toMarkdown(s), /\| ci \| 2 \| 50% \| 15 \|/);
});

// ---------------------------------------------------------------- AI flags, models, Jev triage
test("AI flags are off unless set to true; models are the cheapest per role, AI_MODEL overrides", () => {
  assert.deepEqual(names.aiFeatures({}), { implement: false, review: false, fix: false, uiTest: false, autoChain: false, triage: false });
  assert.equal(names.aiFeatures({ AI_REVIEW: "true", AI_FIX: "yes" }).review, true);
  assert.equal(names.aiFeatures({ AI_REVIEW: "true", AI_FIX: "yes" }).fix, false);
  assert.match(verdict.modelFor("review", ""), /haiku/);
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
  assert.match(before, /\*\*Next:\*\* Build it, or add the label \*\*ai:implement\*\*/);

  const f = { ...open(fixture(23)), ai: {}, statuses: [], reviews: [] };
  const pr = { ...f.pr, title: "Escalate cases" };
  const waiting = storyCard({ ...base, pr, facts: f, decision: gate.evaluate(f) });
  assert.match(waiting, /\*\*Next:\*\* \*\*\[Approve here\]\(https:\/\/github.com\/o\/r\/pull\/\d+\/files\)\*\*: everything else is green/);
  assert.match(waiting, /➖ \| AI review \| off: your approval is the review/);

  const failedReview = { ...f, ai: { review: true, fix: true }, statuses: [{ ...ok(f.pr.headRefOid, gate.STATUS.review), state: "failure" }] };
  assert.match(storyCard({ ...base, ai: failedReview.ai, pr, facts: failedReview, decision: gate.evaluate(failedReview) }), /Address the review comments .*\*\*ai:fix\*\*/);

  const shipped = storyCard({ ...base, pr: { ...pr, state: "MERGED" }, facts: f, shipped: { tag: "v1", url: "https://x/v1" } });
  assert.match(shipped, /Done: live in production since \[v1\]/);
  assert.doesNotMatch(shipped, /⬜/);
});

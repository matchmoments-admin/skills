// Pipeline tests: gate (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
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

test("PR #26 (release): needs CI, the staging regression, the UI regression and an approval on its head; merge commit", () => {
  assert.match(gate.evaluate(open(fixture(26))).reasons.join(), /UI regression has not run on this release yet/, "once per release, before production (#273)");
  const d = gate.evaluate(uiPassed(open(fixture(26))));
  assert.equal(d.route, "release");
  assert.deepEqual(d.reasons, []);
  assert.equal(d.rules.merge, "merge");
  const noStaging = { ...uiPassed(open(fixture(26))), checkRuns: fixture(26).checkRuns.filter((c) => c.name !== names.CHECKS.staging) };
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

test("pipeline paths are guarded and UI-facing changes are recognised", () => {
  assert.deepEqual(names.touchesPipeline(["pipeline/src/gate.mjs", "force-app/x", "e2e/a.spec.ts", ".github/workflows/ci.yml"]), ["pipeline/src/gate.mjs", ".github/workflows/ci.yml"]);
  assert.equal(names.uiFacing(["force-app/main/default/classes/AccountSelector.cls"]).length, 0);
  assert.equal(names.uiFacing(["force-app/main/default/layouts/Case-Case Layout.layout-meta.xml"]).length, 1);
});

test("UAT: with UAT_ENABLED a release needs a sign-off on its current code; off, nothing changes", () => {
  const f = uiPassed(open(fixture(26))), head = f.pr.headRefOid;
  const st = (state, sha = head, description = "") => ({ sha, context: gate.STATUS.uat, state, description, created_at: "2026-10-05T00:00:00Z", creator: { login: "github-actions[bot]" } });
  assert.deepEqual(gate.evaluate({ ...f, uat: false }).reasons, []);
  assert.match(gate.evaluate({ ...f, uat: true }).reasons.join(), /not in UAT yet/);
  assert.match(gate.evaluate({ ...f, uat: true, statuses: [...f.statuses, st("pending")] }).reasons.join(), /waiting for UAT sign-off/);
  assert.match(gate.evaluate({ ...f, uat: true, statuses: [...f.statuses, st("failure", head, "totals wrong")] }).reasons.join(), /UAT failed \(totals wrong\)/);
  const older = "0000000000000000000000000000000000000009";
  assert.match(gate.evaluate({ ...f, uat: true, statuses: [...f.statuses, st("success", older)], diffsToHead: { [older]: ["force-app/x.cls"] } }).reasons.join(), /older version/);
  assert.deepEqual(gate.evaluate({ ...f, uat: true, statuses: [...f.statuses, st("success")] }).reasons, []);
  const o = names.orgFor("uat:2026-w45");
  assert.deepEqual([o.alias, o.description, o.lock, o.days], ["uat", "uat-2026-w45", "org-uat", 30]);
});

test("pipeline/gate: success only when mergeable; failure when something failed; pending while waiting", () => {
  assert.deepEqual(gate.gateStatus({ mergeable: true, reasons: [] }), { state: "success", description: "All requirements met: the gate merges it" });
  assert.deepEqual(gate.gateStatus({ mergeable: false, reasons: ["not approved (Review changes > Approve)", "AI review has not run on this code"] }), { state: "pending", description: "not approved (+1 more)" });
  assert.equal(gate.gateStatus({ mergeable: false, blocking: "failure", reasons: ["UI test did not pass (failure)"] }).state, "failure");
  assert.equal(gate.gateStatus({ mergeable: false, blocking: "pending", reasons: ["UI test did not pass (failure)"] }).state, "pending", "the decision says it, not the wording");
  assert.ok(gate.gateStatus({ mergeable: false, reasons: ["x".repeat(300)] }).description.length <= 139);
});

test("follow-ups after an emergency merge are the ones the gate would have started", () => {
  assert.deepEqual(gate.followUps({ headRefName: "issue-5", baseRefName: "release/w" }), ["staging", "delete-story-org"]);
  assert.deepEqual(gate.followUps({ headRefName: "issue-5", baseRefName: "main" }), ["release", "delete-story-org"]);
  assert.deepEqual(gate.followUps({ headRefName: "release/w", baseRefName: "main" }), ["release"]);
  assert.deepEqual(gate.followUps({ headRefName: "fix/x", baseRefName: "main" }, ["pipeline/a.mjs"]), []);
  assert.deepEqual(gate.followUps({ headRefName: "fix/x", baseRefName: "main" }, ["force-app/a.cls"]), ["release"]);
  // a workflow fix reaches the open sprint's release branch (its own copy runs staging): back-merge (story #166)
  assert.deepEqual(gate.followUps({ headRefName: "fix/x", baseRefName: "main" }, [".github/workflows/staging-deploy.yml"]), ["backmerge"]);
  // one command starts them for the gate and an emergency merge alike (they had drifted: merged.yml missed in-sprint)
  for (const f of ["gate", "merged"]) assert.match(readFileSync(new URL(`../../.github/workflows/${f}.yml`, import.meta.url), "utf8"), /pipe\.mjs start followups --after "\$AFTER"/);
});

test("route check before /build: a base that moved on is fine; a hotfix branch carrying sprint work is refused", () => {
  const git = (inMain) => (args) => (args[1] === "--is-ancestor" ? (inMain ? "" : null) : "fork");
  assert.equal(gate.branchRoute(git(false), { branch: "issue-106", base: "release/w45", release: "release/w45" }).ok, true, "sprint story: the build merges the base in");
  assert.equal(gate.branchRoute(git(true), { branch: "issue-7", base: "main", release: "release/w45" }).ok, true, "hotfix cut from main");
  const bad = gate.branchRoute(git(false), { branch: "issue-7", base: "main", release: "release/w45" });
  assert.match(bad.why, /carries unreleased release\/w45 work/);
  assert.equal(gate.branchRoute(git(false), { branch: "issue-7", base: "main" }).ok, true, "no open sprint: nothing to carry");
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

test("correctness wiring: story PR base from the story, UAT never reset by a redeploy, merge button locked until production accepts", () => {
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  assert.match(wf("story-pr"), /pipe.mjs story base "\$KEY"/);
  assert.doesNotMatch(wf("story-pr"), /merge-base --is-ancestor/);
  assert.match(wf("uat-deploy"), /UAT already has/);
  assert.match(wf("staging-deploy"), /superseded by/);
  assert.match(wf("staging-deploy"), /pipe.mjs finish staging --branch "\$REL"/, "UAT only when the journey owes it: staging passed on the head, UAT lacks it (finish asks it)");
  assert.deepEqual(gate.gateStatus({ mergeable: true, validate: true, reasons: [] }), { state: "pending", description: "Ready: validating against production before merging" });
  assert.doesNotMatch(wf("gate"), /STATE=pending/, "the decision's status is mapped in one place (gateStatus)");
  assert.match(wf("gate"), /status set pipeline\/gate failure "\$HEAD_SHA" "Production rejected it/);
  const did = [];
  actions.perform("uat", "", { number: 110, isPr: true, pr: { headRefName: "release/w45" } }, "dev", { host: { dispatch: (w, i) => did.push([w, i]) } });
  assert.deepEqual(did, [["uat-deploy.yml", { pr: 110, again: "true" }]], "the card's box deploys again on purpose");
  assert.equal(names.baseFor({ labels: ["feature"], openReleaseBranch: "release/w45" }), "release/w45");
  assert.equal(names.baseFor({ labels: ["hotfix"], openReleaseBranch: "release/w45" }), "main");
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

test("a person can overrule a wrong AI review on the exact commit, with the reason on record; the reviewer sees CI (PR #144)", () => {
  const did = [];
  const host = { status: (...a) => did.push(["status", ...a]), dispatch: (w, i) => did.push(["dispatch", w, i]) };
  const pr = { headRefName: "issue-143", headRefOid: "abc1234def", baseRefName: "release/2026-w46" };
  const r = actions.perform("review-ok", "THIS_YEAR is valid SOQL; CI passed", { number: 144, isPr: true, pr }, "pm", { host });
  assert.deepEqual(did[0], ["status", "abc1234def", gate.STATUS.review, "success", "AI review overruled by @pm: THIS_YEAR is valid SOQL; CI passed"]);
  assert.deepEqual(did[1], ["dispatch", "gate.yml", { pr: 144 }]);
  assert.match(r.said, /accepted this change over the AI review on `abc1234`: THIS_YEAR/);
  assert.deepEqual(actions.command("/review-ok because"), { id: "review-ok", arg: "because" });
  assert.equal(roles.modelFor("review", ""), "claude-sonnet-5-5");
  const wf = readFileSync(new URL("../../.github/workflows/ai-review.yml", import.meta.url), "utf8");
  assert.match(wf, /> "\$RUNNER_TEMP\/ci\.md"/);
  assert.match(wf, /never report it as a syntax or compile error/);
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

  // the gate: PR #23 was approved by alex-admin; with a policy, only the named approver's approval counts
  const f = withVerdicts(fixture(23));
  assert.deepEqual(gate.evaluate({ ...f, approvers: ["alex-admin"], storyApprover: null, lastPusher: "someone-else" }).reasons, []);
  assert.match(gate.evaluate({ ...f, approvers: ["alex-admin", "lead"], storyApprover: "lead", lastPusher: "x" }).reasons.join(), /approval does not count: @lead is this story's approver/);
  assert.match(gate.evaluate({ ...f, approvers: ["alex-admin"], lastPusher: "alex-admin" }).reasons.join(), /pushed the latest change/);
  // a ticked Sign off names its person (the trusted status says who); it is checked the same way
  const signed = { ...f, reviews: [], statuses: [...f.statuses, { ...ok(f.pr.headRefOid, gate.STATUS.signoff), description: "Signed off by @alice" }] };
  assert.deepEqual(gate.approval({ ...signed, head: f.pr.headRefOid, ...team }, { signOff: true }).by, ["alice"]);
  assert.match(gate.approval({ ...signed, head: f.pr.headRefOid, ...team, lastPusher: "alice" }, { signOff: true }).refused[0].why, /pushed the latest change/);
});

test("who pushed last: GitHub's push record counts, so a commit email not linked to an account cannot dodge separation of duties (story #193)", () => {
  const commits = [{ committedDate: "2026-10-12T09:22:00Z", authors: [{ login: "__owner__-pipeline" }, { login: "claude" }] },
    { committedDate: "2026-10-12T09:41:00Z", authors: [{ name: "Alex Admin" }] }];   // no login: the email is not linked
  assert.equal(gate.lastPusherOf(commits), null, "commit authors alone miss the person");
  const pushes = [{ activity_type: "push", actor: { login: "alex-admin", type: "User" }, timestamp: "2026-10-12T09:41:32Z" },
    { activity_type: "push", actor: { login: "__owner__-pipeline[bot]", type: "Bot" }, timestamp: "2026-10-12T09:22:05Z" }];
  assert.equal(gate.lastPusherOf(commits, pushes), "alex-admin");
  // the pipeline pushing a person's change for them (Bring my Setup changes) still names the person, if newer
  const setup = [{ committedDate: "2026-10-12T10:00:00Z", authors: [{ login: "__owner__-pipeline" }, { login: "carol" }] }];
  assert.equal(gate.lastPusherOf(setup, [...pushes, { activity_type: "push", actor: { login: "__owner__-pipeline[bot]", type: "Bot" }, timestamp: "2026-10-12T10:00:05Z" }]), "carol");
  // and the refusal follows
  assert.match(gate.approvalProblem({ approvers: ["alex-admin"], lastPusher: gate.lastPusherOf(commits, pushes) }, "alex-admin"), /pushed the latest change/);
});

test("Standing: one place decides what still counts on the head, and the gate, the card and the board read it", () => {
  const f = withVerdicts(fixture(23));
  const head = f.pr.headRefOid;
  // the head: everything stands
  const st = gate.standing(f);
  assert.equal(st.route, "feature");
  assert.equal(st.review.state, "success");
  assert.equal(st.review.sha, head);
  // a spec-only push: the review carries; the UI test and UAT do not (their verdict is about that exact code)
  const pushed = { ...f, pr: { ...f.pr, headRefOid: "spec2" }, diffsToHead: { [head]: ["e2e/story-23.spec.ts"] },
    statuses: [...f.statuses, ok(head, gate.STATUS.uat)] };
  const sp = gate.standing(pushed);
  assert.equal(sp.review.state, "success", "a review carries over a spec-only push");
  assert.equal(sp.ui.state, "stale", "the UI test must run on the new spec");
  assert.equal(sp.uat.state, "stale", "UAT signed off that code, not this");
  // a diverged compare (null): nothing carries
  assert.equal(gate.standing({ ...pushed, diffsToHead: { [head]: null } }).review.state, "stale");
  // a status anyone but the pipeline posted counts for nothing
  assert.equal(gate.standing({ ...f, statuses: f.statuses.map((x) => ({ ...x, creator: { login: "mallory" } })) }).review.state, "missing");
  // a cancelled required check is a failure for the gate status and for the card alike
  const cancelled = { ...f, checkRuns: f.checkRuns.map((c) => (c.name === names.CHECKS.apex ? { ...c, conclusion: "timed_out" } : c)) };
  assert.equal(gate.checkState("cancelled"), "missing", "a newer run on the same head cancels the older one: waiting, not red");
  assert.equal(gate.checkState("timed_out"), "failed");
  assert.equal(gate.checkState("skipped"), "passed");
  assert.equal(gate.checkState("in_progress"), "running");
  assert.equal(gate.gateStatus(gate.evaluate(cancelled)).state, "failure", "a timed-out check: red on the gate as on the card");
  const superseded = { ...f, checkRuns: f.checkRuns.map((c) => (c.name === names.CHECKS.apex ? { ...c, conclusion: "cancelled" } : c)) };
  assert.equal(gate.gateStatus(gate.evaluate(superseded)).state, "pending", "cancelled by a newer run: waiting, on the gate as on the card");
  // a hotfix needs a review, not a sign-off: the board reads the same rule as the gate
  const hot = { ...withVerdicts(fixture(12)), reviews: [], statuses: [...withVerdicts(fixture(12)).statuses, { ...ok(fixture(12).pr.headRefOid, gate.STATUS.signoff), description: "Signed off by @alice" }] };
  assert.equal(gate.standing(hot).approval.ok, false, "a sign-off box is not a hotfix approval");
  assert.equal(gate.standing(hot).approval.ok, gate.evaluate(hot).reasons.every((r) => !/approv/.test(r)));
  // approvals carry who, when and how (the delivery record's row)
  const signed = { ...f, reviews: [], statuses: [...f.statuses, { ...ok(head, gate.STATUS.signoff, "2026-10-05T01:00:00Z"), description: "Signed off by @alice" }] };
  assert.deepEqual(gate.standing(signed).approval.who, [{ login: "alice", at: "2026-10-05T01:00:00Z", how: "ticked Sign off" }]);
});

test("a spec-only push keeps the AI review but not the UI test (story #166: a weakened spec rode on the earlier pass)", async () => {
  const { verdictFor, STATUS } = await import("../src/gate.mjs");
  const by = { login: "github-actions[bot]" };
  const ctx = { head: "h2", diffsToHead: { h1: ["e2e/story-166.spec.ts"] }, statuses: [
    { context: STATUS.review, state: "success", sha: "h1", creator: by, created_at: "1" },
    { context: STATUS.ui, state: "success", sha: "h1", creator: by, created_at: "2" }] };
  assert.equal(verdictFor(STATUS.review, ctx).state, "success");
  assert.equal(verdictFor(STATUS.ui, ctx).state, "stale");
  assert.equal(verdictFor(STATUS.ui, { ...ctx, head: "h1" }).state, "success");
});

test("a result on a newer commit wins over one an older commit's run posted later (scenario fuzz, 15 Oct)", async () => {
  const { verdictFor, STATUS } = await import("../src/gate.mjs");
  const by = { login: "github-actions[bot]" };
  // the review of h1 finished after the review of h2 started: h2's running review stands on h3 (a spec push)
  const ctx = { head: "h3", pr: { commits: [{ oid: "h1" }, { oid: "h2" }, { oid: "h3" }] }, diffsToHead: { h1: ["force-app/A.cls", "e2e/a.spec.ts"], h2: ["e2e/a.spec.ts"] }, statuses: [
    { context: STATUS.review, state: "pending", sha: "h2", creator: by, created_at: "2" },
    { context: STATUS.review, state: "failure", sha: "h1", creator: by, created_at: "3" }] };
  assert.equal(verdictFor(STATUS.review, ctx).state, "pending");
  assert.equal(verdictFor(STATUS.review, { ...ctx, pr: null }).state, "stale", "without the commit order: the newest by time, as before");
});

test("the gate records the approval it accepted on the head as it merges; close-out reads that record (E17)", () => {
  const a = { ok: true, who: [{ login: "alice", how: "ticked Sign off", at: "2026-10-12T09:56:30Z" }] };
  assert.equal(gate.approvalRecord(a), "@alice (ticked Sign off, 2026-10-12T09:56Z)");
  assert.deepEqual(gate.readApprovalRecord(gate.approvalRecord(a)), { by: "alice", how: "ticked Sign off", at: "2026-10-12T09:56:00Z" });
  assert.equal(gate.readApprovalRecord("no approval needed (route)"), null);
  assert.equal(gate.RESULTS[gate.STATUS.approval].inputs, "exact", "a record is for the exact commit merged");
  const wf = readFileSync(new URL("../../.github/workflows/gate.yml", import.meta.url), "utf8");
  assert.ok(wf.indexOf("status set pipeline/approval success") > wf.indexOf("name: Merge (only the head"), "recorded after the merge, never before production validation");
});

test("the verdicts that unlock a merge count only from a run of main's (or a release branch's) workflows; a story PR never changes pipeline code", () => {
  assert.equal(gate.trustedRun({ event: "workflow_dispatch", head_branch: "main" }), true);
  assert.equal(gate.trustedRun({ event: "issue_comment", head_branch: "main" }), true, "/ship and the boxes");
  assert.equal(gate.trustedRun({ event: "pull_request_target", head_branch: "issue-5", pull_requests: [{ base: { ref: "release/2026-w49" } }] }), true, "the base branch's file");
  assert.equal(gate.trustedRun({ event: "pull_request_target", head_branch: "x", pull_requests: [{ base: { ref: "issue-5" } }] }), false, "a PR into a story branch runs that branch's file");
  assert.equal(gate.trustedRun({ event: "pull_request", head_branch: "issue-5" }), false, "the branch's own workflow files");
  assert.equal(gate.trustedRun({ event: "push", head_branch: "issue-5" }), false);
  assert.equal(gate.trustedRun({ event: "workflow_dispatch", head_branch: "issue-5" }), false, "dispatched on the story branch: its own file");
  assert.equal(gate.trustedRun(null), false, "no run linked: not proven");
  const st = [{ sha: "h", context: gate.STATUS.review, state: "success", created_at: "1", creator: { login: "github-actions[bot]" }, trusted: false }];
  assert.equal(gate.verdictFor(gate.STATUS.review, { statuses: st, head: "h" }).state, "missing");
  // the gate reads the diff itself: CI's guard can be faked by a branch's own workflows
  const pr = { number: 5, state: "OPEN", headRefName: "issue-5", baseRefName: "release/w1", headRefOid: "h", author: { login: "a" } };
  const d = gate.evaluate({ pr, compare: { prFiles: ["force-app/a.cls", ".github/workflows/evil.yml"] }, checkRuns: [], statuses: [], reviews: [] });
  assert.equal(d.blocking, "failure");
  assert.match(d.reasons.join(" "), /cannot change pipeline code \(\.github\/workflows\/evil\.yml\)/);
  assert.match(readFileSync(new URL("../../.github/workflows/gate.yml", import.meta.url), "utf8"), /^  pull_request_target:/m, "never a PR's own gate.yml");
});

test("nudge reads Standing: a sign-off that still covers the head, an approval (or one that does not count, so the gate says why), a back-merge", async () => {
  const { world } = await import("./sim.mjs");
  process.env.APPROVERS = "boss";
  const nudge = (w, n) => gate.nudge(w.host().prFacts(n)).action;
  const w = world();
  w.branch("release/w45");
  w.story("5", { approver: "boss" });
  const h1 = w.commit("issue-5", ["force-app/main/default/classes/A.cls"], { by: "dev", from: "release/w45" });
  w.pr(5, { head: "issue-5", base: "release/w45" });
  assert.equal(nudge(w, 5), "none", "nobody has acted");
  w.acting({ event: "issue_comment", branch: "main" });
  w.status(h1, gate.STATUS.signoff, "success", "Signed off by @boss", { runId: w.state.actingRun });
  assert.equal(nudge(w, 5), "dispatch");
  w.commit("issue-5", ["e2e/story-5.spec.ts"], { by: "claude" });
  assert.equal(nudge(w, 5), "dispatch", "spec-only since the sign-off: it still covers the head");
  w.commit("issue-5", ["force-app/main/default/classes/A.cls"], { by: "dev" });
  assert.equal(nudge(w, 5), "none", "code changed since: the sign-off no longer covers it (no billed gate run per check)");
  const forged = w.fork();
  forged.status(forged.tip("issue-5"), gate.STATUS.signoff, "success", "Signed off by @boss", { runId: forged.run({ event: "pull_request", branch: "issue-5" }) });
  assert.equal(nudge(forged, 5), "none", "a sign-off from the branch's own workflow is not trusted");
  w.approve(5, "dev");
  assert.equal(nudge(w, 5), "dispatch", "an approval that does not count still re-runs the gate, which says why");
  const merged = w.fork(); merged.merge(5);
  assert.equal(nudge(merged, 5), "none");
  w.commit("backmerge-1", [".github/workflows/x.yml"], { by: "github-actions", from: "main" });
  w.pr(6, { head: "backmerge-1", base: "release/w45", author: "github-actions" });
  assert.equal(nudge(w, 6), "dispatch", "a back-merge needs no one");
  delete process.env.APPROVERS;
});

test("AI budget per story: spend from the agents' own reports; over the cap no agent starts; an approver's /budget-ok adds as much again, on record", async () => {
  const ev = [
    { kind: "agent", story: "12", usd: 1.6 }, { kind: "agent", story: "12", usd: 2.1 }, { kind: "agent", story: "13", usd: 9 },
    { kind: "agent", story: "12", usd: 1.3 },
  ];
  assert.deepEqual(roles.storyBudget(ev, "12", 5), { spent: 5, cap: 5, extensions: 0, over: true }, "at the cap: stop");
  assert.equal(roles.storyBudget([...ev, { kind: "budget-ok", story: "12" }], "12", 5).over, false, "one /budget-ok: $10");
  assert.equal(roles.storyBudget(ev, "12", 0).over, false, "0: no limit");
  assert.equal(roles.storyBudget(ev, "99", 5).spent, 0);
  // /budget-ok: a reason, an approver, on record; the blocked label comes off
  const did = [], host = { record: (k, d) => did.push(["record", k, d]) }, appGh = (a) => did.push(["gh", ...a]);
  const pr = { headRefName: "issue-12", headRefOid: "abc1234", baseRefName: "release/2027-w03" };
  assert.match(actions.perform("budget-ok", "", { number: 40, isPr: true, pr }, "boss", { host, appGh }).said, /say why/);
  assert.match(actions.perform("budget-ok", "one more fix round", { number: 40, isPr: true, pr }, "dev", { host, appGh, authority: (action) => (action === "budget" ? "only an approver (@boss) can" : null) }).said, /The budget stands/);
  const r = actions.perform("budget-ok", "one more fix round", { number: 40, isPr: true, pr }, "boss", { host, appGh });
  assert.match(r.done, /story 12 extended by @boss/);
  assert.deepEqual(did[0], ["record", "budget-ok", { story: "12", by: "boss", why: "one more fix round" }]);
  assert.deepEqual(did[1], ["gh", "pr", "edit", "40", "--remove-label", "blocked"]);
  assert.deepEqual(actions.command("/budget-ok because"), { id: "budget-ok", arg: "because" });
  const a = readFileSync(new URL("../../.github/actions/claude-agent/action.yml", import.meta.url), "utf8");
  assert.match(a, /if: steps\.rules\.outputs\.stop == 'true'[\s\S]*?--add-label blocked[\s\S]*?AI_BUDGET_STOPPED=true[\s\S]*?over its AI budget/, "the stop labels and explains, then fails the job");
  // the workspace checkout's own credentials fetch the log: a second Authorization header made GitHub refuse it (400)
  assert.doesNotMatch(a, /GIT_CONFIG_|extraheader/);
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  assert.match(wf("ai-implement"), /Make sure the work is pushed and a PR exists\n\s+if: [^\n]*env\.AI_BUDGET_STOPPED != 'true'/, "no \"finished without pushing\" after a budget stop");
  assert.match(wf("ai-fix"), /needs\.fix\.outputs\.budget != 'true'/, "no \"changed nothing\" after a budget stop");
  assert.match(wf("ai-review"), /V=budget/);
  const { verdictOf } = await import("../src/finish.mjs");
  assert.match(verdictOf("review", { outcome: "budget" }).description, /AI budget is spent: an approver's \/budget-ok/);
});

test("metrics by model: each role, provider, model and arm with cost, failures and overruled reviews; spend by story; log collisions", () => {
  const { summarize, toMarkdown } = events;
  const at = "2026-10-27T00:00:00Z";
  const s = summarize([
    { kind: "agent", at, role: "review", provider: "anthropic", model: "claude-haiku-5-5", arm: "declarative", usd: 0.1, pr: 7, story: "12", ok: true },
    { kind: "agent", at, role: "review", provider: "anthropic", model: "claude-sonnet-5-5", usd: 0.3, pr: 8, story: "13", ok: true },
    { kind: "agent", at, role: "implement", model: "claude-sonnet-5-5", usd: 1.2, story: "12", ok: false, retries: 2 },
    { kind: "overrule", at, pr: 7 }, { kind: "budget-ok", at, story: "12" },
  ]);
  const haiku = s.ai.byModel.find((m) => m.model === "claude-haiku-5-5");
  assert.deepEqual(haiku, { role: "review", provider: "anthropic", model: "claude-haiku-5-5", arm: "declarative", runs: 1, usd: 0.1, perRunUsd: 0.1, failed: 0, overruled: 1 });
  assert.equal(s.ai.byModel.find((m) => m.role === "implement").failed, 1);
  assert.deepEqual(s.ai.byStory[0], { story: "12", usd: 1.3 });
  assert.equal(s.ai.budgetExtensions, 1);
  assert.equal(s.ai.logRetries, 2);
  assert.match(toMarkdown(s), /\| review \| anthropic \| claude-haiku-5-5 \| declarative \| 1 \| \$0\.10 \| \$0\.10 \| 0 \| 1 \|/);
});

test("solo approval (APPROVAL_MODE=solo): the one approver's own push counts once the AI review passed on it, and the record says solo; a team never", () => {
  const solo = { approvers: ["boss"], lastPusher: "boss", approvalMode: "solo" };
  for (const k of [null, "changes", "not-needed", "budget", "running", "none"]) assert.match(gate.approvalProblem({ ...solo, aiReview: k }, "boss"), /needs a real AI review to pass/, String(k));
  assert.match(gate.approvalProblem({ ...solo, aiReview: "passed", aiReviewOn: false }, "boss"), /turn on AI_REVIEW/);
  assert.equal(gate.approvalProblem({ ...solo, aiReview: "passed" }, "boss"), null);
  assert.equal(gate.approvalProblem({ ...solo, aiReview: "overruled" }, "boss"), null, "an overrule with a reason on record stands in for the review");
  assert.match(gate.approvalProblem({ ...solo, approvalMode: "team", aiReview: "passed" }, "boss"), /pushed the latest change/, "team mode: four eyes");
  assert.match(gate.approvalProblem({ ...solo, approvers: ["boss", "deputy"], aiReview: "passed" }, "boss"), /pushed the latest change/, "two approvers: the other one approves");
  assert.equal(gate.approvalProblem({ approvers: [], lastPusher: "dev", approvalMode: "team" }, "dev"), null, "APPROVERS unset: anyone with write access (as the handbook says)");
  // through approval(): the AI review's verdict on the head decides, and the approval says solo
  const head = "a".repeat(40);
  const ctx = (reviewState, description = "AI review passed") => ({ ...solo, head, ai: { review: true }, reviews: [{ user: { login: "boss", type: "User" }, state: "APPROVED", commit_id: head, submitted_at: "2026-10-27T01:00:00Z" }],
    statuses: reviewState ? [{ sha: head, context: gate.STATUS.review, state: reviewState, description, created_at: "2026-10-27T00:59:00Z", creator: { login: "github-actions[bot]" } }] : [] });
  assert.equal(gate.approval(ctx(null)).ok, false, "no AI review yet");
  assert.equal(gate.approval(ctx("success", "not needed: low risk per Jev (0.40 of 0-3)")).ok, false, "a review no AI ran is not a second pair of eyes");
  const a = gate.approval(ctx("success"));
  assert.ok(a.ok && a.who[0].solo);
  assert.match(gate.approvalRecord(a), /^@boss \(approved the pull request \(solo: the AI review passed\), 2026-10-27T01:00Z\)$/);
  assert.deepEqual(gate.readApprovalRecord(gate.approvalRecord(a)), { by: "boss", how: "approved the pull request (solo: the AI review passed)", at: "2026-10-27T01:00:00Z" });
  const o = gate.approval(ctx("success", gate.REVIEW.overruled("boss", "THIS_YEAR is valid SOQL")));
  assert.ok(o.ok);
  assert.match(gate.approvalRecord(o), /solo: the AI review was overruled, reason on record/, "the record never reads an overrule as a pass");
});

test("solo lockout (27 Oct review): the one approver may overrule a review of their own push and extend its budget; a team keeps four eyes", () => {
  const head = "b".repeat(40);
  const facts = (mode, approvers, description = "AI review asks for changes", state = "failure") => ({ approvers, approvalMode: mode, lastPusher: "boss", head, ai: { review: true }, reviews: [],
    statuses: [{ sha: head, context: gate.STATUS.review, state, description, created_at: "2026-10-27T00:59:00Z", creator: { login: "github-actions[bot]" } }] });
  const solo = facts("solo", ["boss"]);
  assert.equal(gate.authorityProblemFor(solo, "overrule", "boss"), null, "solo: /review-ok on their own push");
  assert.equal(gate.authorityProblemFor(facts("solo", ["boss"], gate.REVIEW.budget(), "error"), "budget", "boss"), null, "solo: /budget-ok after a budget stop");
  assert.match(gate.authorityProblemFor(solo, "approve", "boss"), /needs a real AI review/, "approving still needs the review (or an overrule) first");
  const team = facts("team", ["boss", "deputy"]);
  assert.match(gate.authorityProblemFor(team, "overrule", "boss"), /pushed the latest change/, "a team: the author never overrules their own review");
  assert.equal(gate.authorityProblemFor(team, "overrule", "deputy"), null);
  assert.equal(gate.authorityProblemFor(team, "budget", "boss"), null, "budget is spending, not code: any approver");
  assert.match(gate.authorityProblemFor(team, "budget", "eve"), /only an approver/);
  assert.equal(gate.authorityProblem("budget", { approvers: [] }, "eve"), null, "APPROVERS unset: anyone with write access");
  assert.throws(() => gate.authorityProblem("merge", { approvers: ["boss"] }, "boss"), /unknown action/);
});

test("a review verdict's kind is read in one place (REVIEW, reviewKindOf), and what writes it uses the same text", () => {
  const k = (s, d) => gate.reviewKindOf(s, d);
  assert.equal(k("success", gate.REVIEW.passed()), "passed");
  assert.equal(k("failure", gate.REVIEW.changes()), "changes");
  assert.equal(k("success", gate.REVIEW.notNeeded("low risk per Jev (0.40 of 0-3)")), "not-needed");
  assert.equal(k("success", gate.REVIEW.overruled("boss", "fine")), "overruled");
  assert.equal(k("error", gate.REVIEW.budget()), "budget");
  assert.equal(k("pending", gate.REVIEW.running()), "running");
  assert.equal(k("error", gate.REVIEW.none()), "none");
  for (const f of ["finish.mjs", "start.mjs", "actions.mjs", "events.mjs", "closeout.mjs"]) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\/\^not needed|"AI review passed"|STATUS\.review, "[a-z]+", [`"']|overruled by @\(/, `${f} reads or writes review text itself`);
  }
});

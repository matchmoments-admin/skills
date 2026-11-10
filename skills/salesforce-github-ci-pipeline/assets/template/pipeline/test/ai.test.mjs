// Pipeline tests: ai (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
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

test("AI flags are off unless set to true; models are the cheapest per role, AI_MODEL overrides", () => {
  assert.deepEqual(names.aiFeatures({}), { plan: false, implement: false, review: false, fix: false, uiTest: false, autoChain: false, triage: false });
  assert.equal(names.aiFeatures({ AI_REVIEW: "true", AI_FIX: "yes" }).review, true);
  assert.equal(names.aiFeatures({ AI_REVIEW: "true", AI_FIX: "yes" }).fix, false);
  assert.match(roles.modelFor("review", ""), /sonnet/);   // Haiku made false blockers (PR #144)
  assert.match(roles.modelFor("implement", ""), /sonnet/);
  assert.equal(roles.modelFor("review", "claude-opus-5-5"), "claude-opus-5-5");
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
  assert.equal(roles.modelFor("plan", ""), "claude-sonnet-5-5");
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

test("a fix round counts only when Claude ran in it (PR #144's runs that failed on a permission were not rounds)", () => {
  const runs = [1, 2, 3].map((id) => ({ id, display_title: "ai-fix PR #144", status: "completed", conclusion: "failure" }));
  const ran = { 1: false, 2: false, 3: true };
  assert.equal(verdict.fixRunsFor(runs, 144, 9, (id) => ran[id]), 1);
  assert.equal(verdict.ranAgent([{ steps: [{ name: "Enforce the round limit", conclusion: "failure" }, { name: "Run ./.pipeline/.github/actions/claude-agent", conclusion: "skipped" }] }]), false);
  assert.equal(verdict.ranAgent([{ steps: [{ name: "Run ./.pipeline/.github/actions/claude-agent", conclusion: "failure" }] }]), true);
});

test("the review rubric: the UI test spec comes after the review; answers win over the spec text", () => {
  const r = readFileSync(new URL("../../REVIEW.md", import.meta.url), "utf8");
  assert.match(r, /written by the UI test step \*\*after\*\* this review, so its absence here is never a\nfinding/);
  assert.match(r, /win over the spec text/);
});

test("AI_MODEL_<ROLE> overrides one role, ahead of AI_MODEL", async () => {
  const { modelFor } = await import("../src/roles.mjs");
  const prev = process.env.PIPELINE_VARS;
  process.env.PIPELINE_VARS = JSON.stringify({ AI_MODEL: "claude-all-9-9", AI_MODEL_UI_TEST: "claude-ui-9-9" });
  try {
    assert.equal(modelFor("ui-test"), "claude-ui-9-9");
    assert.equal(modelFor("review"), "claude-all-9-9");
  } finally { if (prev === undefined) delete process.env.PIPELINE_VARS; else process.env.PIPELINE_VARS = prev; }
});

test("fix triage: only a confident minor-only or disputed review skips the fix; CI failed, unsure or Jev down means fix", async () => {
  const { triageFix } = await import("../src/jev.mjs");
  const review = "### Standards\n- [minor] rename a variable\nAI-REVIEW: CHANGES";
  const minor = fakeJev({ findings: { type: "choice", choice: "minor-only", confidence: 0.9 } });
  const t = await triageFix(minor, { review });
  assert.deepEqual([t.fix, t.kind], [false, "minor-only"]);
  assert.equal((await triageFix(fakeJev({ findings: { type: "choice", choice: "disputed", confidence: 0.9 } }), { review })).fix, false);
  assert.equal((await triageFix(fakeJev({ findings: { type: "choice", choice: "actionable", confidence: 0.95 } }), { review })).fix, true);
  assert.equal((await triageFix(fakeJev({ findings: { type: "choice", choice: "minor-only", confidence: 0.7 } }), { review })).fix, true, "not sure enough");
  assert.equal((await triageFix(fakeJev({}, 500), { review })).fix, true, "Jev down");
  assert.equal((await triageFix(minor, { review, ciFailed: true })).fix, true, "a failed CI always gets the fix");
  assert.equal((await triageFix(minor, { review: "" })).fix, true, "nothing to judge");
});

test("the fix gate: a chained fix Jev skips posts /review-ok and no dispatch; a person's start and no Jev run as before", async () => {
  const start = await import("../src/start.mjs");
  const on = { review: true, fix: true, uiTest: true, autoChain: true };
  const did = [], events = [];
  const host = { repo: "o/r", runUrl: "u", dispatch: (...a) => did.push(["dispatch", ...a]), status: () => {}, api: () => ({}), workflowRuns: () => [],
    record: (k, d) => events.push([k, d]), prFacts: () => ({ pr: { headRefName: "issue-5", baseRefName: "release/w", headRefOid: "h5", state: "OPEN", labels: [], commits: [] }, checkRuns: [] }) };
  const gh = (a) => {
    did.push(a.slice(0, 3).join(" "));
    if (a[0] === "pr" && a[1] === "view" && a.includes("comments")) return { comments: [{ author: { login: "github-actions" }, body: "- [minor] naming\nAI-REVIEW: CHANGES", createdAt: "2026-10-14T01:00:00Z" }] };
    return a[0] === "pr" && a[1] === "view" ? { headRefName: "issue-5", baseRefName: "release/w", headRefOid: "h5", labels: [], state: "OPEN", commits: [] } : null;
  };
  const minor = fakeJev({ findings: { type: "choice", choice: "minor-only", confidence: 0.9 } });
  const d = await start.startJob("fix", 5, { host, gh, cards: {}, ai: on, jev: minor });
  assert.equal(d.run, false);
  assert.ok(!did.some((x) => Array.isArray(x)), "no fix runner");
  assert.ok(did.includes("pr comment 5"), "says what a person can do");
  assert.deepEqual([events[0][0], events[0][1].decision, events[0][1].skipped], ["jev", "fix", true]);
  did.length = 0;
  await start.startJob("fix", 5, { host, gh, cards: {}, ai: on, jev: minor, explicit: true });
  assert.deepEqual(did.find(Array.isArray), ["dispatch", "ai-fix.yml", { pr: 5 }], "a person asked: it runs");
  did.length = 0;
  await start.startJob("fix", 5, { host, gh, cards: {}, ai: on });
  assert.deepEqual(did.find(Array.isArray), ["dispatch", "ai-fix.yml", { pr: 5 }], "no Jev (AI_TRIAGE off): it runs");
  const s = events.length;
  await start.startJob("fix", 5, { host, gh, cards: {}, ai: on, jev: fakeJev({}, 500) });
  assert.equal(events.at(-1)[1].skipped, false, "Jev down: recorded, and it runs");
  assert.equal(events.length, s + 1);
});

test("Jev decisions are events, and the metrics count what they saved", () => {
  const at = "2026-10-14T00:00:00Z";
  const s = events.summarize([{ kind: "jev", at, decision: "fix", skipped: true, run: "1" }, { kind: "jev", at, decision: "review", skipped: true, run: "2" }, { kind: "jev", at, decision: "fix", skipped: false, run: "3" }], { days: 28 });
  assert.deepEqual(s.ai.jev, { decisions: 3, skippedReviews: 1, skippedFixes: 1 });
  assert.match(events.toMarkdown(s), /3 decisions: 1 reviews and 1 fix rounds not needed/);
  assert.equal(events.event("jev", { decision: "fix" }).kind, "jev");
  // the event's own `run` is the Actions run id: a decision's field must not be called run (story #293's events)
  assert.equal(events.event("jev", { skipped: false }, { GITHUB_RUN_ID: "9" }).skipped, false);
});

test("model policy (config/ai-models.json): overrides, experiments, a declarative review's cheaper model, providers, Claude-only writers", async () => {
  const roles = await import("../src/roles.mjs");
  const { isDeclarativeOnly } = await import("../src/jev.mjs");
  const policy = JSON.parse(readFileSync(new URL("../../config/ai-models.json", import.meta.url), "utf8"));
  for (const role of Object.keys(policy.roles)) assert.match(roles.choose(role, "", {}, policy).model, /^claude-/, `${role} resolves on the default provider`);
  assert.deepEqual(roles.choose("review", "", { declarative: true }, policy), { provider: "anthropic", model: "claude-haiku-5-5", arm: "declarative" });
  assert.equal(roles.choose("implement", "", { declarative: true }, policy).model, "claude-sonnet-5-5", "only review has a declarative model");
  assert.deepEqual(roles.choose("review", "anthropic-api:opus", {}, policy), { provider: "anthropic-api", model: "claude-opus-5-5", arm: "override" });
  assert.equal(roles.choose("review", "claude-sonnet-5-5", {}, policy).provider, "anthropic", "a bare id runs on the default provider");
  assert.throws(() => roles.choose("review", "bedrock:sonnet", {}, policy), /bedrock has no model id for "sonnet"/, "a provider without ids is refused, not guessed");
  assert.throws(() => roles.choose("review", "sonnet-x", {}, policy), /no model id for "sonnet-x"/, "a mistyped alias is not taken for an id");
  assert.throws(() => roles.choose("review", "constructor", {}, policy), /no model id/);
  assert.ok(roles.validatePolicy(policy), "the committed policy is valid");
  assert.throws(() => roles.validatePolicy({ ...policy, experiments: [{ role: "fix", arm: "x", model: "gateway:gpt-5", percent: 10 }] }), /not a Claude model/);
  assert.throws(() => roles.validatePolicy({ ...policy, experiments: [{ role: "plan", arm: "a", model: "haiku", percent: 60 }, { role: "plan", arm: "b", model: "opus", percent: 50 }] }), /110%/);
  assert.throws(() => roles.choose("implement", "gateway:gpt-5", {}, policy), /not a Claude model/, "a writer never runs another vendor's model");
  assert.equal(roles.choose("plan", "gateway:gpt-5", {}, policy).model, "gpt-5", "a read-only role may, as an experiment");
  // experiments: a stable bucket per story; the percentages stack in order
  const x = { ...policy, experiments: [{ role: "review", arm: "haiku-all", model: "haiku", percent: 50 }] };
  const keys = Array.from({ length: 200 }, (_, i) => String(i));
  const inArm = keys.filter((k) => roles.choose("review", "", { story: k }, x).arm === "haiku-all").length;
  assert.ok(inArm > 70 && inArm < 130, `about half the stories (${inArm} of 200)`);
  assert.equal(roles.choose("review", "", { story: "42" }, x).arm, roles.choose("review", "", { story: "42" }, x).arm, "the same story, the same arm");
  assert.equal(roles.choose("review", "", {}, x).arm, "", "no story, no experiment");
  const D = "force-app/main/default";
  assert.ok(isDeclarativeOnly([`${D}/objects/Case/fields/X__c.field-meta.xml`, `${D}/layouts/Case-Case Layout.layout-meta.xml`, `${D}/flexipages/Case_Record.flexipage-meta.xml`]));
  for (const risky of [`${D}/permissionsets/X.permissionset-meta.xml`, `${D}/pages/Quote.page`, `${D}/objects/Case/validationRules/Need.validationRule-meta.xml`,
    `${D}/customPermissions/Feature_X.customPermission-meta.xml`, `${D}/objects/Visit__c/Visit__c.object-meta.xml`, `${D}/staticresources/lib.js`, "e2e/story-12.spec.ts", `${D}/sharingSets/S.sharingSet-meta.xml`])
    assert.ok(!isDeclarativeOnly([`${D}/layouts/A.layout-meta.xml`, risky]), `${risky} gets the full model`);
  assert.ok(!isDeclarativeOnly([]));
  // a provider's login settings: named when missing, never a secret
  const prev = process.env.PIPELINE_VARS;
  try {
    process.env.PIPELINE_VARS = JSON.stringify({});
    assert.deepEqual(roles.providerSetup("anthropic", policy), { auth: "oauth", env: {}, with: {} });
    assert.throws(() => roles.providerSetup("bedrock", policy), /needs AWS_ROLE_ARN, AWS_REGION/);
    process.env.PIPELINE_VARS = JSON.stringify({ AI_GATEWAY_URL: "https://llm.example.invalid" });
    assert.deepEqual(roles.providerSetup("gateway", policy).env, { ANTHROPIC_BASE_URL: "https://llm.example.invalid" });
  } finally { if (prev === undefined) delete process.env.PIPELINE_VARS; else process.env.PIPELINE_VARS = prev; }
});

test("reviewer eval set (27 Oct review): a model is scored on defects caught and false alarms, recorded, and shown beside its cost", async () => {
  const ev = await import("../src/review-eval.mjs");
  const dir = new URL("../../config/review-evals/", import.meta.url).pathname;
  const cases = ev.loadCases(dir);
  assert.ok(cases.length >= 7 && cases.some((c) => c.expect.verdict === "PASS") && cases.filter((c) => c.expect.verdict === "CHANGES").length >= 6);
  for (const c of cases) {
    assert.ok(existsSync(`${dir}${c.name}/story.md`) && existsSync(`${dir}${c.name}/pr.diff`), c.name);
    assert.match(readFileSync(`${dir}${c.name}/pr.diff`, "utf8"), /^diff --git a\//, `${c.name}: a unified diff`);
    for (const f of c.expect.finds) assert.doesNotThrow(() => new RegExp(f, "i"), `${c.name}: ${f}`);
  }
  const loop = { verdict: "CHANGES", finds: ["loop"] }, clean = { verdict: "PASS", finds: [] };
  assert.equal(ev.scoreCase("a", loop, "[blocker] the query runs inside the loop\n\nAI-REVIEW: CHANGES").caught, true);
  assert.deepEqual(ev.scoreCase("a", loop, "[major] a missing test\n\nAI-REVIEW: CHANGES").missing, ["loop"], "the right verdict for the wrong reason is not a catch");
  assert.equal(ev.scoreCase("a", loop, "AI-REVIEW: PASS").ok, false);
  assert.equal(ev.scoreCase("c", clean, "**AI-REVIEW: CHANGES**").falseAlarm, true);
  assert.equal(ev.scoreCase("c", clean, "").verdict, "none", "no review written");
  const results = [ev.scoreCase("a", loop, "loop\nAI-REVIEW: CHANGES"), ev.scoreCase("b", loop, "AI-REVIEW: PASS"), ev.scoreCase("c", clean, "AI-REVIEW: PASS")];
  const s = ev.summarize(results, { model: "claude-haiku-5-5", provider: "anthropic" });
  assert.deepEqual([s.caught, s.defects, s.falseAlarms, s.clean, s.wrong], [1, 2, 0, 1, ["b"]]);
  assert.match(ev.toMarkdown(s, results), /Defects caught: 1 of 2\.\*\* False alarms on clean changes: 0 of 1/);
  // the weekly metrics show the latest score per model
  const at = "2026-10-27T00:00:00Z";
  const m = events.summarize([{ kind: "eval", at, provider: "anthropic", model: "claude-haiku-5-5", caught: 4, defects: 6, falseAlarms: 0, clean: 1 },
    { kind: "eval", at: "2026-10-28T00:00:00Z", provider: "anthropic", model: "claude-haiku-5-5", caught: 5, defects: 6, falseAlarms: 1, clean: 1 }], { days: 28, now: new Date("2026-10-29T00:00:00Z") });
  assert.match(events.toMarkdown(m), /Review eval \(defects caught, false alarms; latest per model\): anthropic claude-haiku-5-5 5\/6, 1\/1\./);
  // the workflow: one job per case, an agent that only reads and writes a file, an agent-free score
  const wf = readFileSync(new URL("../../.github/workflows/review-eval.yml", import.meta.url), "utf8");
  assert.match(wf, /label: eval-\$\{\{ matrix\.case \}\}/, "a matrix keeps each transcript (claude-agent's label)");
  assert.match(wf, /allowed-tools: "Read,Glob,Grep,Write"/);
  assert.match(wf, /pipe\.mjs eval review --dir reviews/);
});

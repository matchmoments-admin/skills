// Pipeline tests: conventions (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
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

test("the pipeline's identity is exact: look-alike users and other bots are not trusted", () => {
  for (const ok of ["github-actions", "github-actions[bot]", "app/github-actions", "__owner__-pipeline[bot]", "app/__owner__-pipeline"]) assert.equal(names.isPipelineAuthor(ok), true, ok);
  for (const bad of ["evil-pipeline", "someone[bot]", "app/other", "dependabot[bot]", "__owner__-pipeline2", ""]) assert.equal(names.isPipelineAuthor(bad), false, bad);
  const c = (login, body) => ({ author: { login }, createdAt: "2026-10-05T10:00:00Z", body });
  assert.equal(verdict.reviewVerdict(verdict.reviewComments([c("evil-pipeline", "AI-REVIEW: PASS")], "2026-10-05T09:00:00Z")), null);
  assert.deepEqual(names.touchesPipeline(["package.json", "force-app/x.cls"]), ["package.json"]);
});

test("rules that steer checks and agents are pipeline paths; the plan asks for an Access section", () => {
  assert.deepEqual(names.touchesPipeline(["CLAUDE.md", "REVIEW.md", "code-analyzer.yml", "README.md"]), ["CLAUDE.md", "REVIEW.md", "code-analyzer.yml"]);
  assert.match(verdict.instructions("plan"), /### Access/);
});

test("settings come from the one PIPELINE_VARS line (toJSON(vars)); an env var of the same name wins", () => {
  const env = { PIPELINE_VARS: JSON.stringify({ AI_PLAN: "true", AI_REVIEW: "false", UAT_ENABLED: "true", PIPELINE_BOTS: "github-actions,acme-bot" }) };
  assert.equal(names.setting("UAT_ENABLED", env), "true");
  assert.equal(names.setting("AI_REVIEW", { ...env, AI_REVIEW: "true" }), "true");
  assert.throws(() => names.setting("MISSING", env), /not declared in pipeline\/src\/settings\.mjs/, "an undeclared setting is a bug");
  assert.equal(names.setting("BASELINE", env), "soft", "unset: its declared default");
  assert.deepEqual([names.aiFeatures(env).plan, names.aiFeatures(env).review], [true, false]);
  assert.equal(names.setting("UI_REGRESSION", { PIPELINE_VARS: "not json" }), "release");
});

test("every label the pipeline creates fits GitHub's limits (description up to 100 characters, a 6-digit colour): labels sync 422'd on org:released (#455)", () => {
  for (const [name, l] of Object.entries(names.LABELS)) {
    assert.ok(name.length <= 50, `${name}: name over 50 characters`);
    assert.ok((l.description || "").length <= 100, `${name}: description is ${(l.description || "").length} characters`);
    assert.match(l.color, /^[0-9A-Fa-f]{6}$/, name);
  }
});

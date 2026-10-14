// Pipeline tests: improve (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
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

test("a failed pipeline run becomes an improvement ticket; the story's own failures open nothing (improve.mjs)", async () => {
  const improve = await import("../src/improve.mjs");
  const c = (step, logTail, conclusion) => improve.classify({ step, logTail, conclusion });
  // real failures from the run logs
  assert.equal(c("What comes next", "##[error]Unknown command: next . See the header of pipeline/bin/pipe.mjs."), "pipeline", "E20");
  assert.equal(c("Refresh the snapshot", "##[error]A fatal signup error occurred. Please try again."), "pipeline", "E28");
  assert.equal(c("Deploy what changed against the base", "##[error]Deploy failed: force-app/main/default/objects/Case/Case.object-meta.xml: No such column 'SLA__c'"), "story", "a story's component error");
  assert.equal(c("Deploy what changed against the base", "##[error]INVALID_SESSION_ID: Session expired or invalid"), "pipeline", "a deploy can fail for the pipeline's reasons");
  assert.equal(c("Tests for this change (Apex and Flow), live on the PR as \"Salesforce tests\"", "##[error]tests failed: 2 Apex tests failed"), "story");
  assert.equal(c("Access check (least privilege; blockers fail, warnings annotate the PR)", "##[error]blocker"), "story");
  assert.equal(c("Every changed record-triggered Flow has a Flow test (as every Apex class has tests)", "##[error]no Flow test"), "story");
  assert.equal(c("Tests for this change", "##[error]Cannot find module '../src/x.mjs'"), "pipeline", "a crash is never the story's");
  assert.equal(c("A step nobody listed", "##[error]boom"), "pipeline", "unknown steps are the pipeline's");
  assert.equal(c("Deploy what changed against the base", "boom", "cancelled"), "ignore", "a newer run replaced it");

  const fault = { workflow: "snapshot-refresh", job: "refresh", step: "Refresh the snapshot", error: "sf org create scratch failed: RemoteOrgSignupFailed (00D5g000004ABCDEFG) at 2026-10-11T19:19:52Z",
    logTail: "##[error]A fatal signup error occurred. Please try again.\nlogin: https://x.my.salesforce.com/secur/frontdoor.jsp?sid=00D5g000004ABCD!AQ8AQxyz", runUrl: "https://github.com/o/r/actions/runs/1", branch: "main" };
  const again = { ...fault, error: "sf org create scratch failed: RemoteOrgSignupFailed (00D5g000009ZZZZZZZ) at 2026-10-13T01:12:07Z", runUrl: "https://github.com/o/r/actions/runs/2" };
  assert.equal(improve.signature(fault), improve.signature(again), "ids and times do not make a new ticket");
  assert.notEqual(improve.signature(fault), improve.signature({ ...fault, step: "Deploy" }));
  const t = improve.ticket(fault);
  assert.equal(t.action, "create");
  assert.deepEqual(t.labels, ["pipeline-improvement", "needs-triage", "transient"]);
  assert.doesNotMatch(t.body, /frontdoor|sid=|AQ8AQxyz/, "no login or session in a ticket");
  for (const h of ["### What happened", "### Where", "### Seen", "### Cause", "### Fix"]) assert.ok(t.body.includes(h), h);
  const seen = improve.ticket(again, { number: 42, body: t.body });
  assert.equal(seen.action, "comment");
  assert.equal(seen.seen, 2);
  assert.match(seen.body, /\*\*Seen:\*\* 2 times, last https:\/\/github\.com\/o\/r\/actions\/runs\/2/);

  // the run → its first failed step's own output (not its script, not an earlier step's error), the story from the branch
  const log = ["2026-10-13T01:00:00.0Z ##[group]Run actions/checkout@v4", "##[endgroup]", "ok",
    "##[group]Run node pipeline/bin/pipe.mjs story readiness 208", "##[endgroup]", "##[error]Jev: HTTP 401",   // continue-on-error, earlier
    "##[group]Run sf project deploy start --source-dir force-app", "  sf project deploy start --source-dir force-app", "##[endgroup]",
    "NamedOrgNotFound: No authorization information found for issue-208", "##[error]Process completed with exit code 1."].join("\n");
  const steps = [{ name: "Set up job", conclusion: "success" }, { name: "Run actions/checkout@v4", conclusion: "success" }, { name: "Readiness", conclusion: "success" },
    { name: "Not run", conclusion: "skipped" }, { name: "Deploy what changed against the base", conclusion: "failure" }, { name: "Complete job", conclusion: "success" }];
  const f = improve.faultOf({ name: "ci", conclusion: "failure", head_branch: "issue-208", html_url: "u", pull_requests: [{ number: 211 }] },
    [{ id: 1, name: "static checks (no org)", conclusion: "success", steps: [] }, { id: 2, name: "apex", conclusion: "failure", steps }], () => log);
  assert.deepEqual([f.step, f.story, f.pr], ["Deploy what changed against the base", "208", 211]);
  assert.doesNotMatch(f.logTail, /Jev|--source-dir/, "only the failed step's output");
  assert.equal(f.error, "NamedOrgNotFound: No authorization information found for issue-208", "\"Process completed\" says nothing");
  assert.equal(f.whose, "pipeline", "the script names force-app; the output does not: the pipeline's");
  assert.equal(improve.faultOf({ name: "gate", conclusion: "startup_failure", html_url: "u" }, [], () => "").whose, "pipeline", "a broken workflow file");
  // the API listed no failed step (partial steps, null conclusions): the errored section, not the post-job warnings
  const partial = improve.faultOf({ name: "staging-deploy", conclusion: "failure", html_url: "u" },
    [{ id: 3, name: "staging regression", conclusion: "failure", steps: [{ name: "Set up job", conclusion: null }] }], () => log + "\n##[warning]Node.js 20 is deprecated.");
  assert.equal(partial.error, "NamedOrgNotFound: No authorization information found for issue-208", "#265 was titled with a Node.js warning");
  assert.equal(c("The story's scratch org", "##[error]No free scratch org slot (3 active is the Dev Hub's limit)."), "ignore", "waiting in line, by design");
  assert.equal(c("Decide (and the card)", "file:///x/pipeline/src/gate.mjs:12\n    at gather (file:///x/pipeline/src/gate.mjs:40:9)"), "pipeline", "a crash in a story-fault step");
  const loud = improve.ticket({ ...fault, error: "@someone [click](https://evil) `x`", logTail: "@someone\n" + "y".repeat(5000) });
  assert.doesNotMatch(loud.body + loud.title, /@someone/, "no pings");
  assert.ok(loud.body.length < 60001 && !loud.body.includes("y".repeat(401)));
  assert.notEqual(improve.signature({ ...fault, error: "uuid 9d4e-11aa user test-abc1@example.com /tmp/x1" }), undefined);
  assert.equal(improve.signature({ ...fault, error: "org test-ab12cd@example.com in /tmp/sf-9d4e" }), improve.signature({ ...fault, error: "org test-zz99yy@example.com in /tmp/sf-1a2b" }));
  const run = { created_at: "2026-10-01T00:00:00Z" };
  assert.deepEqual(improve.loop([{ ...run, body: `${improve.MARK}a -->`, closed_at: "2026-10-02T00:00:00Z" }, { ...run, body: `${improve.MARK}b -->` }, { ...run, body: "a person's" }], { days: 28, now: Date.parse("2026-10-13T00:00:00Z") }),
    { opened: 2, fixed: 1, open: 1, medianDays: 1 }, "only tickets a run opened, in the window");

  const wf = readFileSync(new URL("../../.github/workflows/improve.yml", import.meta.url), "utf8");
  assert.match(wf, /\["failure","startup_failure"\]'\), github\.event\.workflow_run\.conclusion\)/, "a passed run needs no runner");
  assert.match(wf, /head_repository\.full_name == github\.repository/, "a fork's run is not reported");
  assert.match(wf, /issues: write/);
  assert.doesNotMatch(wf, /contents: write|pull-requests: write|statuses: write/, "least privilege");
  const listed = wf.match(/workflows: \[([\s\S]*?)\]/)[1].split(",").map((s) => s.trim());
  const all = readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter((n) => n.endsWith(".yml") && n !== "improve.yml")
    .map((n) => readFileSync(new URL(`../../.github/workflows/${n}`, import.meta.url), "utf8").match(/^name: (.+)$/m)[1].trim());
  assert.deepEqual(listed.sort(), all.sort(), "every pipeline workflow is watched (a new one too)");
  assert.ok(names.LABELS["pipeline-improvement"] && names.LABELS.transient);
});

test("improve reads a job log through either gh (newer gh refuses colour codes without --allow-escape-sequences)", async () => {
  const improve = await import("../src/improve.mjs");
  const calls = [];
  const log = "\u001b[36;1m##[group]Run sf org create scratch\u001b[0m\n##[endgroup]\n##[error]RemoteOrgSignupFailed: the org shape version is outdated\n##[error]Process completed with exit code 1.";
  const io = { run: (c, a) => { calls.push(a); if (a.includes("--allow-escape-sequences")) throw new Error("unknown flag"); return log; },
    ghPages: () => [] };
  const posted = [];
  const host = { repo: "o/r", api: (m, p, b) => (p.endsWith("/jobs?per_page=100") ? { jobs: [{ id: 5, name: "build", conclusion: "failure", steps: [{ name: "Build", conclusion: "failure" }] }] }
    : p.endsWith("/issues") ? (posted.push(b), { number: 7 }) : { name: "snapshot-refresh", conclusion: "failure", html_url: "u", head_branch: "main" }) };
  assert.match(improve.report(io, host, 1), /opened #7/);
  assert.equal(calls.length, 2, "the flag first, then without it");
  assert.match(posted[0].body, /RemoteOrgSignupFailed: the org shape version is outdated/);
  assert.doesNotMatch(posted[0].body, /\u001b/, "no colour codes in a ticket");
});

test("#220: a warning in the log does not make a story's failure the pipeline's; every job that draws a card can read statuses", async () => {
  const improve = await import("../src/improve.mjs");
  const tail = "##[warning]story card for 218 not updated: gh api --paginate --slurp failed: gh: Resource not accessible by integration (HTTP 403)\n" +
    "  FAIL Site_Visit_Negative_Follow_Up.Site_Visit_Negative_Follow_Up_Negative_Creates_Task: \n##[error]tests failed: 1 Flow test(s) failed";
  assert.equal(improve.classify({ step: "Tests for this change (Apex and Flow), live on the PR as \"Salesforce tests\"", logTail: tail }), "story");
  assert.equal(improve.classify({ step: "A step nobody listed", logTail: "##[error]gh: Resource not accessible by integration (HTTP 403)" }), "pipeline", "as the error itself it still is");
  // after the story's gates, a failure is an escape: staging, UAT and production validation always ticket (E43, E44)
  for (const step of ["UI regression (every spec in e2e/)", "Full regression (every Apex and Flow test)", "Validate against production (check-only, all tests)", "Deploy the release branch to staging and prepare it"]) {
    assert.equal(improve.classify({ step, logTail: "  1 failed\n Test failure: SiteVisitTest" }), "pipeline", step);
  }
  // a job with its own permissions replaces the workflow's: one that refreshes a card must keep statuses (the card reads verdicts)
  for (const n of readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter((f) => f.endsWith(".yml"))) {
    const y = readFileSync(new URL(`../../.github/workflows/${n}`, import.meta.url), "utf8");
    for (const job of y.split(/\n  (?=[a-z][\w-]*:\n)/).slice(1)) {
      if (!/pipe\.mjs (story|pr) card/.test(job) || !/\n    permissions:/.test(job)) continue;
      assert.match(job.split(/\n    steps:/)[0], /statuses: (read|write)/, `${n} ${job.split(":")[0]}`);
    }
  }
});

test("#237: a back-merge that changes nothing staging tests keeps the regression an earlier release commit passed", () => {
  // the files of sprint 2026-w51's back-merges (#226 and after): pipeline work only
  const backmerge = ["pipeline/src/improve.mjs", "pipeline/src/journey.mjs", "pipeline/bin/pipe.mjs", ".github/workflows/improve.yml", ".github/workflows/ci.yml", "GLOSSARY.md", "docs/handbook.md", "pipeline/test/pipeline.test.mjs", ".claude/skills/x/SKILL.md"];
  assert.equal(gate.carries("no-staging-input", "a", "h", backmerge), true);
  for (const f of ["force-app/main/default/classes/X.cls", "e2e/story-218.spec.ts", "data/seed/accounts.json", "config/scratch-dev.json", "pipeline/src/org.mjs", "pipeline/src/org/data.mjs", "pipeline/src/tests.mjs", ".github/actions/sf-auth/action.yml", ".github/workflows/staging-deploy.yml", "package-lock.json"])
    assert.equal(gate.carries("no-staging-input", "a", "h", [...backmerge, f]), false, f);
  const git = (a) => (a[0] === "rev-list" ? "p1\np2" : a[0] === "rev-parse" ? "h" : a[0] === "diff" ? (a[1] === "p1" ? backmerge.join("\n") : "") : null);
  // the live "Salesforce tests" check is what carries: it exists only where the tests really ran
  const runs = (map) => ({ repo: "o/r", api: (m, p) => ({ check_runs: p.includes("check_name=Salesforce%20tests") ? Object.entries(map).flatMap(([sha, list]) => (p.includes(`/${sha}/`) ? list : [])) : [{ conclusion: "success", started_at: "9", status: "completed" }] }) });
  const done = (conclusion, started_at = "1") => ({ conclusion, started_at, status: "completed" });
  const host = runs({ p1: [done("success")] });
  assert.equal(start.stagingCarry({ git, host }), "p1");
  assert.equal(start.stagingCarry({ git: (a) => (a[0] === "diff" ? "force-app/x.cls" : git(a)), host }), null, "Salesforce source changed: run it");
  assert.equal(start.stagingCarry({ git, host: runs({ p1: [done("success", "1"), done("failure", "2")] }) }), null, "the newest run on that commit is the truth");
  assert.equal(start.stagingCarry({ git, host: runs({}) }), null, "a green staging check without a test run (superseded, UI only) carries nothing");
  const wf = readFileSync(new URL("../../.github/workflows/staging-deploy.yml", import.meta.url), "utf8");
  assert.match(wf, /path: candidate, fetch-depth: 20/);
  assert.match(wf, /pipe\.mjs ci staging-plan --branch/);
  assert.equal(start.stagingCarry({ git: (a) => (a[0] === "rev-list" ? "h\np1" : git(a)), host: runs({ h: [done("success", "1"), { status: "in_progress", started_at: "2" }] }) }), "h", "the head itself counts; a run in progress does not hide its pass");
});

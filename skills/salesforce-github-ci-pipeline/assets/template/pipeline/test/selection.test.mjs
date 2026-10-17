// Pipeline tests: selection (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
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

test("test selection: a field, validation rule or permission set runs the tests that use it, not everything", () => {
  const files = ["force-app/main/default/objects/Account/fields/Region__c.field-meta.xml", "force-app/main/default/classes/AccountTest.cls",
    "force-app/main/default/classes/CaseTest.cls", "force-app/main/default/permissionsets/Region_Access.permissionset-meta.xml"];
  const src = { "force-app/main/default/classes/AccountTest.cls": "@IsTest class AccountTest { Account a; }", "force-app/main/default/classes/CaseTest.cls": "@IsTest class CaseTest { Case c; Region_Access x; }" };
  const read = (p) => src[p] || "";
  assert.deepEqual(tests.selectTests({ changed: [files[0]], files, read }).apex, ["AccountTest"]);
  assert.deepEqual(tests.selectTests({ changed: [files[3]], files, read }).apex, ["CaseTest"]);
  assert.equal(tests.selectTests({ changed: ["force-app/main/default/objects/Lead/fields/X__c.field-meta.xml"], files, read }).mode, "all", "nothing names Lead: all");
  assert.equal(tests.selectTests({ changed: ["force-app/main/default/layouts/Account-Account Layout.layout-meta.xml"], files, read }).mode, "none", "no test reads a layout (#234)");
});

test("Flow parity: a changed active record-triggered Flow needs a Flow test; production inventory lists what scratch orgs lack", () => {
  const flow = (trigger, status = "Active") => `<Flow><start><triggerType>${trigger}</triggerType></start><status>${status}</status></Flow>`;
  const files = { "force-app/main/default/flows/A.flow-meta.xml": flow("RecordAfterSave"), "force-app/main/default/flows/B.flow-meta.xml": flow("RecordBeforeSave"),
    "force-app/main/default/flows/S.flow-meta.xml": "<Flow><processType>Flow</processType><status>Active</status></Flow>",
    "force-app/main/default/flows/D.flow-meta.xml": flow("RecordAfterSave", "Draft"),
    "force-app/main/default/flowtests/B_Path.flowtest-meta.xml": "<FlowTest><flowApiName>B</flowApiName></FlowTest>" };
  const src = { files: Object.keys(files), read: (p) => files[p] || "", changed: Object.keys(files).filter((p) => p.includes("/flows/")) };
  assert.deepEqual(tests.flowTestGaps(src), ["A"], "B has a test; a screen Flow and a draft are not asked");
  assert.deepEqual(tests.flowTestGaps(src, ["A"]), [], "an exception (config/test-exceptions.json)");
  assert.deepEqual(tests.recordTriggeredFlows(src.changed, src.read), ["A", "B"], "coverage minimum: only active record-triggered Flows");
  assert.deepEqual(tests.flowTestGaps({ ...src, changed: [] }), [], "only what the change touches");
  const cov = tests.flowCoverage({ sf: () => ({ records: [{ FlowVersion: { Definition: { DeveloperName: "A" } }, NumElementsCovered: 3, NumElementsNotCovered: 1 },
    { FlowVersion: { Definition: { DeveloperName: "A" } }, NumElementsCovered: 1, NumElementsNotCovered: 3 }, { FlowVersion: { Definition: { DeveloperName: "Z" } }, NumElementsCovered: 1, NumElementsNotCovered: 0 }] }) }, "issue-1", ["A"]);
  assert.deepEqual(cov, { A: 75 }, "the best test method; other Flows ignored");
  assert.deepEqual(tests.flowCoverage({ sf: () => null }, "x", ["A"]), {}, "never throws");
  // the inventory: watched types production has customised, which the baseline does not copy
  const config = { types: ["CustomObject"], customisedOnly: [], exclude: ["ApprovalProcess:*.Skip_*"] };
  const later = "2026-09-01T00:00:00Z";
  const watched = { ApprovalProcess: [{ fullName: "Opportunity.Discount", lastModifiedDate: later, lastModifiedByName: "Ann Admin" }, { fullName: "Opportunity.Skip_Me", lastModifiedDate: later, lastModifiedByName: "Ann Admin" }],
    StandardValueSet: [{ fullName: "LeadSource", lastModifiedDate: "2020-01-01T00:00:00Z", lastModifiedByName: "Ann Admin" }], AssignmentRules: [{ fullName: "Lead", namespacePrefix: "pkg", lastModifiedDate: later }] };
  const nc = baselineMod.uncovered(watched, { config, orgCreated: "2025-01-01T00:00:00Z" });
  assert.deepEqual(nc, { ApprovalProcess: ["Opportunity.Discount"] }, "customised only: not unchanged since the org was created, not managed, not excluded");
  assert.match(baselineMod.inventoryMarkdown(nc), /\| ApprovalProcess \| 1 \| `Opportunity\.Discount` \|/);
  assert.match(baselineMod.inventoryMarkdown({}), /nothing of the watched types/);
  const cfg = JSON.parse(readFileSync(new URL("../../config/baseline.json", import.meta.url), "utf8"));
  assert.ok(cfg.types.includes("ApprovalProcess") && !cfg.watch.includes("ApprovalProcess"), "copied now: Timesheet_Weekly_Approval was a real gap (13 Oct)");
  assert.ok(cfg.watch.includes("Territory2Model"), "still listed only: needs a feature the shape does not give");
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
  // a cancelled run's tests still queued in the org are aborted first; "already enqueued" clears and retries once (#353)
  {
    const calls = [];
    let refused = false;
    const sf = (a, o) => {
      calls.push(a.slice(0, 3).join(" "));
      if (a[0] === "data" && a[1] === "query") return { records: refused ? [{ Id: "709q2" }] : [{ Id: "709q1" }] };
      if (a[1] === "run" && !refused) { refused = true; throw new Error("ALREADY_IN_PROCESS: Test already enqueued flowtesting.F"); }
      if (a[1] === "run") return { testRunId: "f2" };
      if (a[1] === "get") return { summary: { outcome: "Passed" }, tests: [{ FullName: "F.t", Outcome: "Pass" }] };
      return {};
    };
    const st = tests.runTests({ sf }, { alias: "a", plan: { mode: "relevant", apex: r.chosen, flows: ["F"] }, sleep: () => {}, apexDone: r.state });
    assert.equal(st.flows.passed, 1);
    assert.equal(st.flows.cleared, 2, "q1 before, q2 after the refusal");
    assert.equal(calls.filter((c) => c === "data update record").length, 2);
  }
  // a run Salesforce reports Skipped (no test passed) or Aborted is finished, not polled for an hour (#353), and fails
  for (const outcome of ["Skipped", "Aborted"]) {
    let polls = 0;
    const done = tests.runTests({ sf: (a) => (a[1] === "run" ? { testRunId: "f1" } : a[1] === "get" ? (polls++, { summary: { outcome }, tests: [] }) : {}) },
      { alias: "a", plan: { mode: "relevant", apex: r.chosen, flows: ["F"] }, sleep: () => {}, apexDone: r.state });
    assert.equal(polls, 1, `${outcome}: one look, then done`);
    assert.ok(done.flows.finished);
    const v = tests.verdict(done, { plan: { mode: "relevant", apex: [], flows: ["F"] } });
    assert.ok(v.reasons.some((x) => new RegExp(`Flow tests did not run: Salesforce reported the run ${outcome}`).test(x)), `${outcome}: ${v.reasons}`);
  }

  // production: a "Succeeded" RunRelevantTests validation that ran nothing is re-run with every test class
  const prodCalls = [];
  const reports = [{ status: "Succeeded", done: true, numberTestsTotal: 0, details: { runTestResult: { numTestsRun: 0 } } }, { status: "Succeeded", done: true, numberTestsTotal: 2 }];
  const p = production.validate({ sf: (a) => { prodCalls.push(a.join(" ")); return a[2] === "validate" ? { id: "0AfP" } : reports.shift(); } }, { source: ["-d", "force-app"], allTests: ["A", "B"], sleep: () => {} });
  assert.equal(p.level, "all");
  assert.match(prodCalls.at(-2), /--test-level RunSpecifiedTests --tests A --tests B/);
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

test("RunRelevantTests never skips a changed test class (live, story #166: Salesforce chose 2 of 9 changed tests)", () => {
  const a = { phase: "done", apex: { classes: 2, classesDone: 2, ran: 12, passed: 12, failed: 0, failures: [], finished: true }, flows: {}, coverage: { AccountSelector: 60 } };
  const b = { phase: "done", apex: { classes: 1, classesDone: 1, ran: 3, passed: 2, failed: 1, failures: [{ test: "AccountSelectorTest.m" }], finished: true }, flows: {}, coverage: { AccountSelector: 100, CaseTriggerHandler: 90 } };
  const m = tests.merged(a, b);
  assert.deepEqual([m.apex.ran, m.apex.passed, m.apex.failed, m.apex.classes], [15, 14, 1, 3]);
  assert.deepEqual(m.coverage, { AccountSelector: 100, CaseTriggerHandler: 90 });
  const src = readFileSync(new URL("../src/tests.mjs", import.meta.url), "utf8");
  assert.match(src, /changedTests = relevant \? \[\.\.\.new Set\(\[\.\.\.plan\.apex\.filter/);
});

test("RunRelevantTests without coverage for new code: our test classes that name it run again (live, story #241)", () => {
  const srcs = { ServiceReviewTest: "@IsTest(testFor='ApexClass:ServiceReviewTriggerHandler,ApexTrigger:ServiceReviewTrigger')", SiteVisitTest: "SiteVisitTriggerHandler", AccountTierTest: "x" };
  const read = (t) => srcs[t];
  assert.deepEqual(tests.recheckTests({ ours: Object.keys(srcs), code: ["ServiceReviewTriggerHandler", "ServiceReviewTrigger"], coverage: { SiteVisitTriggerHandler: 90 }, read }), ["ServiceReviewTest"]);
  assert.deepEqual(tests.recheckTests({ ours: Object.keys(srcs), code: ["ServiceReviewTriggerHandler"], coverage: { ServiceReviewTriggerHandler: 95 }, read }), [], "covered: nothing runs twice");
  assert.deepEqual(tests.recheckTests({ ours: ["SiteVisitTest"], code: ["SiteVisitTrigger"], coverage: {}, read }), [], "a name is matched whole, not as a prefix");
});

test("test data: a changed seed replaces the old one in a long-lived org; staging gets volume; critical tests always run; a Persona story's spec logs in as it", async () => {
  const { seedReplaceApex, volumeApex, VOLUME_MARKER } = await import("../src/org.mjs");
  const files = { "Account.json": JSON.stringify({ records: [{ Name: "Seed Account 01 Pty Ltd" }, { Name: "O'Brien & Co" }, { Name: "${SEED_MARKER}" }] }), "Lead.json": JSON.stringify({ records: [{ Email: "a@x.example" }] }) };
  const apex = seedReplaceApex(files, ["[seed abc]"]);
  assert.match(apex, /'Seed Account 01 Pty Ltd', 'O\\'Brien & Co', '\[seed abc\]'/, "names quoted for Apex; the old marker goes too; the token never");
  assert.match(apex, /delete \[SELECT Id FROM Case WHERE AccountId IN :a\];[\s\S]*delete a;/, "children before their accounts");
  assert.match(apex, /Email IN :emails AND IsConverted = false/);
  const v = volumeApex(2500);
  assert.equal(v.length, 3, "chunks one anonymous Apex call can hold");
  assert.match(v[2], /for \(Integer i = 2000; i < 2500; i\+\+\)/);
  assert.ok(v[2].includes(`Name = '${VOLUME_MARKER(2500)}'`) && !v[0].includes("[volume"), "the marker only after the last chunk");
  // critical=true runs whatever changed, as production's RunRelevantTests does
  const read = (p) => ({ "c/ATest.cls": "@IsTest class ATest { A a; }", "c/CritTest.cls": "@IsTest(critical=true) class CritTest {}", "c/A.cls": "class A {}" })[p] || "";
  const plan = tests.selectTests({ changed: ["c/A.cls"], files: ["c/ATest.cls", "c/CritTest.cls", "c/A.cls"], read });
  assert.deepEqual(plan.apex, ["ATest", "CritTest"]);
  // a story with a Persona: the spec must log in as it
  const { specProblems } = await import("../src/evidence.mjs");
  const spec = 'await login(page); await expect(field(page, "X")).toContainText("Y");';
  assert.match(specProblems(spec, { persona: true }).join(" "), /never logs in as it/);
  assert.deepEqual(specProblems(spec.replace("login(page)", "loginAs(page, { permsets: ['P'] })"), { persona: true }), []);
  assert.ok(existsSync(new URL("../../e2e/support/record.ts", import.meta.url)), "the record helpers the UI writer is pointed at");
});

test("story #218: a Flow that reads its parent is covered by a declared Apex test; a Flow test error says why; tabs and apps select no tests", () => {
  const F = "force-app/main/default/flows/Site_Visit_Negative_Follow_Up.flow-meta.xml", T = "force-app/main/default/classes/SiteVisitTest.cls";
  const flow = "<Flow><start><object>Site_Visit__c</object><triggerType>RecordAfterSave</triggerType></start><status>Active</status></Flow>";
  const declared = "@IsTest\nprivate class SiteVisitTest {\n  // Flow test: Site_Visit_Negative_Follow_Up: a Flow test cannot create the Account it reads\n  @IsTest static void negative() { insert new Site_Visit__c(); }\n}";
  const gaps = (cls) => tests.flowTestGaps({ changed: [F], files: [F, T], read: (p) => (p === F ? flow : cls) });
  assert.deepEqual(gaps(declared), [], "declared, and names the Flow's object");
  assert.deepEqual(gaps(declared.replace("Site_Visit__c()", "Account()")), ["Site_Visit_Negative_Follow_Up"], "must insert the Flow's object");
  assert.deepEqual(gaps(declared.replace(": a Flow test cannot create the Account it reads", "")), ["Site_Visit_Negative_Follow_Up"], "must say why");
  assert.deepEqual(gaps(declared.replaceAll("@IsTest", "")), ["Site_Visit_Negative_Follow_Up"], "a test class, not any class");
  const nav = ["force-app/main/default/tabs/Site_Visit__c.tab-meta.xml", "force-app/main/default/applications/standard__Sales.app-meta.xml"];
  assert.equal(tests.selectTests({ changed: nav, files: [T], read: () => declared }).mode, "none", "navigation alone runs nothing");
  const r = tests.selectTests({ changed: [...nav, "force-app/main/default/objects/Site_Visit__c/fields/Score__c.field-meta.xml"], files: [T], read: () => declared });
  assert.deepEqual([r.mode, r.apex], ["relevant", ["SiteVisitTest"]], "a tab no longer makes it all tests");
  const src = readFileSync(new URL("../src/tests.mjs", import.meta.url), "utf8");
  assert.match(src, /Error, no message from Salesforce: the Flow faulted before reaching an assertion/);
});

test("#234: layouts, Lightning pages, compact layouts and list views select no tests; a field next to them still selects its object's", () => {
  const T = "force-app/main/default/classes/SiteVisitTest.cls", src = "@IsTest private class SiteVisitTest { Site_Visit__c v; Account a; }";
  const pick = (changed) => tests.selectTests({ changed, files: [T], read: () => src });
  const seen = ["force-app/main/default/flexipages/Account_Record_Page.flexipage-meta.xml", "force-app/main/default/layouts/Site_Visit__c-Site Visit Layout.layout-meta.xml",
    "force-app/main/default/objects/Site_Visit__c/compactLayouts/Main.compactLayout-meta.xml", "force-app/main/default/objects/Site_Visit__c/listViews/All.listView-meta.xml"];
  assert.equal(pick(seen).mode, "none");
  assert.deepEqual(pick([...seen, "force-app/main/default/objects/Site_Visit__c/fields/Score__c.field-meta.xml"]).apex, ["SiteVisitTest"]);
  assert.equal(pick(["force-app/main/default/quickActions/Account.New.quickAction-meta.xml"]).mode, "all", "a quick action can carry field defaults: unchanged");
});

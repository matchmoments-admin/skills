// Pipeline tests: org (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
import * as sample from "../src/sample.mjs";
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
import { orgRegistry, packageList, findOrphans, personaOf as orgPersonaOf, expandSeed, sameSourceVia, assignAccess, permissionSetGroups } from "../src/org.mjs";
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

test("org registry refuses to create when the Dev Hub has no room, with the reason", () => {
  const full = (name, remaining) => ({ name, remaining, max: name === "DailyScratchOrgs" ? 6 : 3 });
  const sf = (args) => {
    if (args[0] === "limits") return [full("ActiveScratchOrgs", 0), full("DailyScratchOrgs", 4)];
    if (args[0] === "data") return { records: [] };
    return {};
  };
  assert.throws(() => orgRegistry({ sf, log: () => {}, sleep: () => {}, env: { BASELINE: "off", SEED: "off" } }).ensure("story:9"), /No free scratch org slot/);
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

test("story orgs leave ORG_RESERVE slots for staging, UAT and CI; an expired org says how to rebuild it", () => {
  const { sf } = fakeSf([]);
  const limited = (remaining) => (args, o) => (args[0] === "limits" ? [{ name: "ActiveScratchOrgs", remaining, max: 40 }, { name: "DailyScratchOrgs", remaining: 50, max: 80 }] : sf(args, o));
  assert.throws(() => orgRegistry({ sf: limited(2), log: () => {}, packages: [], env: { ORG_RESERVE: "2", BASELINE: "off", SEED: "off" } }).ensure("story:9"), /2 kept for staging, UAT and CI/);
  assert.doesNotThrow(() => orgRegistry({ sf: limited(3), log: () => {}, packages: [], env: { ORG_RESERVE: "2", BASELINE: "off", SEED: "off" } }).ensure("story:9"));
  assert.throws(() => orgRegistry({ sf, log: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } }).attach("story:9"), /expired \(story orgs live 7 days\)\. Comment \/start/);
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

test("a persona's permission set group is assigned once Salesforce has recalculated it; loose sets still work; groups leave for the test run", async () => {
  const made = [], queries = [];
  let status = "Updating";
  const sf = (args) => {
    if (args[1] === "query") {
      queries.push(args[5]);
      if (/FROM PermissionSetGroup/.test(args[5])) { const r = [{ Id: "0PG1", DeveloperName: "Support_Agent", Status: status }]; status = "Updated"; return { records: r }; }
    }
    if (args[1] === "create" || args[1] === "assign") { made.push(args.slice(1).join(" ")); return { id: "0Pa" }; }
    return {};
  };
  const slept = [];
  const done = assignAccess({ sf, sleep: (ms) => slept.push(ms) }, "issue-1", { id: "005U", username: "t@x" }, ["Support_Agent", "Case_Escalated_Access", "bad name'"]);
  assert.deepEqual(done, ["Support_Agent", "Case_Escalated_Access"]);
  assert.deepEqual(made, ["create record -o issue-1 -s PermissionSetAssignment -v AssigneeId=005U PermissionSetGroupId=0PG1",
    "assign permset --name Case_Escalated_Access -o issue-1 --on-behalf-of t@x"]);
  assert.equal(slept.length, 1, "waited for the recalculation once");
  assert.ok(!queries.some((q) => /bad name/.test(q)), "only API names reach SOQL");
  const warned = [];
  status = "Failed";
  const sfFailed = (args) => (args[1] === "query" ? { records: [{ Id: "0PG1", DeveloperName: "Support_Agent", Status: "Failed" }] } : {});
  assert.deepEqual(assignAccess({ sf: sfFailed, log: (m) => warned.push(m) }, "issue-1", { id: "005U", username: "t@x" }, ["Support_Agent"]), []);
  assert.match(warned[0], /Support_Agent is Failed/);

  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/psg-`);
  mkdirSync(`${dir}/permissionsetgroups`, { recursive: true });
  writeFileSync(`${dir}/permissionsetgroups/Support_Agent.permissionsetgroup-meta.xml`, "<PermissionSetGroup/>");
  assert.deepEqual(permissionSetGroups(dir), ["Support_Agent"]);
  const soql = [];
  const r = orgRegistry({ sf: (args) => { if (args[1] === "display") return { username: "admin@scratch" }; if (args[1] === "query") soql.push(args[5]); return { records: [] }; }, log: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } });
  r.asProductionUser("issue-1", () => 1, dir);
  assert.match(soql[0], /PermissionSetGroup\.DeveloperName IN \('Support_Agent'\)/, "a group assignment is taken away for the run too");
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
  // marked for an older commit, and nothing deployable changed since (the UI test's spec commit): re-marked, no deploy
  ({ sf, calls } = provisionSf({ live: [{ Description: "issue-12", SignupUsername: "u@x", LoginUrl: "https://s" }], title: "pipeline: ready 000000000000" }));
  const asked = [];
  o = orgRegistry({ sf, log: () => {}, sleep: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" }, sameSource: (held, head) => (asked.push([held, head]), true) }).ready("issue-12", { commit: "abc123456789ffff" });
  assert.equal(o.fresh, true);
  assert.deepEqual(asked, [["000000000000", "abc123456789ffff"]]);
  assert.ok(!calls.some((c) => c.startsWith("project deploy")), "nothing redeployed");
  assert.ok(calls.some((c) => /Title='pipeline: ready abc123456789'/.test(c)));
  const same = (status, files) => sameSourceVia(() => ({ status, files: files.map((filename) => ({ filename })) }))("a", "b");
  assert.equal(same("ahead", ["e2e/story-241.spec.ts", "docs/x.md"]), true);
  assert.equal(same("ahead", ["force-app/main/default/classes/X.cls"]), false);
  assert.equal(same("ahead", ["config/packages.json"]), false);
  assert.equal(same("diverged", ["e2e/x.spec.ts"]), false, "a rewritten branch is not the same source");
  assert.equal(sameSourceVia(() => ({ status: 404 }))("a", "b"), false, "unknown counts as changed");
  assert.equal(same("ahead", Array.from({ length: 300 }, (_, i) => `e2e/${i}.spec.ts`)), false, "a capped file list counts as changed");
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
  assert.match(rel, /gh workflow run snapshot-refresh\.yml --ref main -f if-changed=true/, "#430: a release rebuilds the snapshot only if it changed the shape inputs");
  assert.match(readFileSync(new URL("../../.github/workflows/prod-baseline.yml", import.meta.url), "utf8"), /github\.event_name != 'schedule' \|\| vars\.BASELINE_NIGHTLY == 'true'/);
});

test("seed: dates never go stale; loaded once per org (markers); a story's own data too; never production", async () => {
  const out = expandSeed({ "a.json": '{"CloseDate":"${THIS_YEAR}-03-15","Name":"${SEED_MARKER}","Next":"${NEXT_YEAR}-01-01"}' }, { today: new Date("2026-10-09T00:00:00Z"), marker: "[seed abc]" });
  assert.equal(out["a.json"], '{"CloseDate":"2026-03-15","Name":"[seed abc]","Next":"2027-01-01"}');
  const real = JSON.parse(readFileSync(new URL("../../data/seed/Opportunity.json", import.meta.url), "utf8")).records;
  assert.ok(real.every((r) => /^\$\{(THIS|NEXT|LAST)_YEAR\}-\d\d-\d\d$/.test(r.CloseDate)), "seed dates are tokens");
  assert.ok(readFileSync(new URL("../../data/seed/Account.json", import.meta.url), "utf8").includes("${SEED_MARKER}"));
  const plan = JSON.parse(readFileSync(new URL("../../data/seed/plan.json", import.meta.url), "utf8"));
  // the baseline loads parents first; shipped stories' seeds are folded in after it (seed-fold), so the plan grows
  assert.deepEqual(plan.slice(0, 5).map((p) => p.sobject), ["Account", "Contact", "Opportunity", "Case", "Lead"]);
  const { existsSync } = await import("node:fs");
  for (const f of plan.flatMap((p) => p.files)) assert.ok(existsSync(new URL(`../../data/seed/${f}`, import.meta.url)), `plan file ${f} exists`);

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

test("Org Shape roles are rebuilt so they can be assigned; personas log in through Log in as (no password)", async () => {
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
  assert.match(readFileSync(new URL("../../pipeline/src/org/users.mjs", import.meta.url), "utf8"), /enableAdminLoginAsAnyUser>true/);
  // the tester's first instruction is how to log in: as the story's Persona when it has one (#343: it came mid-paragraph,
  // after "Call login(page)", and the agent logged in as the admin)
  const ui = readFileSync(new URL("../../.github/workflows/ui-test.yml", import.meta.url), "utf8");
  assert.match(ui, /ui login-step --story/);
  assert.match(ui, /spec\.ts\.\n\s+\$\{\{ steps\.org\.outputs\.login \}\}/);
  assert.doesNotMatch(ui, /Call `login\(page\)`/);
  const { loginStep } = await import("../src/evidence.mjs");
  const { personaOf } = await import("../src/org.mjs");
  const step = loginStep(personaOf("- Persona: CustomerSupportNorthAmerica role, Case_Escalated_Access (a Customer Support user who sees the flag)."));
  assert.match(step, /loginAs\(page, \{ role: "CustomerSupportNorthAmerica", permsets: \["Case_Escalated_Access"\] \}\)/);
  assert.match(step, /never `login\(page\)`/);
  assert.match(loginStep(null), /await login\(page\)/);
  assert.match(loginStep({ role: 'X"); evil(', permsets: ["ok", "no way"] }), /role: "Xevil", permsets: \["ok"\]/, "story text cannot break out of the snippet");
});

test("persona lines with an explanation after them still give the role and the permission sets (story #166)", () => {
  assert.deepEqual(orgPersonaOf("### Access\n\n- Persona: DirectorDirectSales role, Regional_Reporting_Access. (One of the five manager roles the report folder is shared with; reps, who have no such role or set, must not see it.)\n"),
    { role: "DirectorDirectSales", permsets: ["Regional_Reporting_Access"] });
  assert.deepEqual(orgPersonaOf("Persona: `WesternSalesTeam` role (a rep)"), { role: "WesternSalesTeam", permsets: [] });
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
  assert.match(readFileSync(new URL("../../.github/workflows/org-shape-refresh.yml", import.meta.url), "utf8"), /snapshot-refresh\.yml --ref main -f if-older-than=20/, "the weekly rebuild is at most daily");
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

test("org lifecycle: capacity names who holds the slots; a merged story's org is never rebuilt and is swept; an outdated shape is refreshed once (E5, E6, E16)", async () => {
  const { capacityProblem, createRefusal, shapeOutdated, isPipelineOrg, findOrphans, mergedBefore, doneStoryOrgs } = await import("../src/org.mjs");
  const full = capacityProblem({ active: { remaining: 0, max: 3 }, daily: { remaining: 5, max: 6 } }, ["staging-2026-w48", "snapshot-src", "HubSpot dev"]);
  assert.match(full, /No free scratch org slot \(3 active.*In use: staging-2026-w48, snapshot-src, HubSpot dev \(not this pipeline\)/);
  assert.equal(capacityProblem({ active: { remaining: 1, max: 3 }, daily: { remaining: 1 } }, []), null);
  assert.equal(capacityProblem({ active: {}, daily: {} }, []), null, "unknown limits: Salesforce's own error decides");
  assert.match(capacityProblem({ active: { remaining: 1, max: 3 }, daily: {} }, ["issue-9"], 1), /ORG_RESERVE.*issue-9/);
  assert.deepEqual(["issue-193", "LIFE-2", "uat-2026-w48", "ci-123", "HubSpot"].map(isPipelineOrg), [true, true, true, true, false]);
  const story = { kind: "story", key: "193" };
  assert.match(createRefusal(story, "MERGED"), /PR is merged: its org is not rebuilt/);
  assert.equal(createRefusal(story, "OPEN"), null);
  assert.equal(createRefusal(story, null), null, "a job without a PR (start, build; a reopened story) may create it");
  assert.equal(createRefusal({ kind: "sprint" }, "MERGED"), null);
  // the janitor: an org made before its story merged is left over; one made after (a reopened story) is not
  const merged = [{ state: "MERGED", mergedAt: "2026-10-12T09:57:00Z" }];
  assert.equal(mergedBefore(merged, "2026-10-11T19:43:00Z"), true);
  assert.equal(mergedBefore(merged, "2026-10-13T08:00:00Z"), false);
  assert.equal(mergedBefore([...merged, { state: "OPEN" }], "2026-10-11T19:43:00Z"), false);
  const done = await doneStoryOrgs([{ Description: "issue-193", CreatedDate: "2026-10-11T19:43:00Z" }, { Description: "staging-w1" }], { tracker: { story: async () => ({ state: "OPEN" }) }, gh: () => merged });
  assert.deepEqual([...done], ["issue-193"]);
  assert.ok(shapeOutdated("ERROR: The org shape version is outdated. Recreate the org shape."));
  assert.ok(!shapeOutdated("No free scratch org slot"));
  const recs = [{ Description: "issue-193", SignupUsername: "u193", CreatedDate: new Date().toISOString() }];
  assert.equal(findOrphans(recs, { isStoryDone: (d) => d === "issue-193" })[0].why, "story merged or closed");
  // the registry refuses before creating anything, and retries an outdated shape once after refreshing it
  const calls = [];
  let creates = 0;
  const sf = (a) => {
    calls.push(a.slice(0, 3).join(" "));
    if (a[0] === "data" && a[1] === "query") return { records: [] };
    if (a[0] === "limits") return [{ name: "ActiveScratchOrgs", remaining: 2, max: 3 }, { name: "DailyScratchOrgs", remaining: 4, max: 6 }];
    if (a[0] === "org" && a[1] === "create" && a[2] === "scratch" && creates++ === 0) throw new Error("The org shape version is outdated");
    if (a[0] === "org" && a[1] === "list" && a[2] === "shape") return [{ status: "Active", createdDate: new Date().toISOString() }];
    if (a[0] === "org" && a[1] === "display") return { username: "admin@x", clientId: "c" };
    return {};
  };
  const reg = orgRegistry({ sf, log: () => {}, sleep: () => {}, packages: [], env: { BASELINE: "off", SEED: "off", SCRATCH_SNAPSHOT: "off" } });
  assert.throws(() => reg.ready("story:193", { refusal: () => "story 193 has merged" }), /has merged/);
  assert.ok(!calls.includes("org create scratch"), "nothing created for a merged story");
  reg.create({ kind: "story", alias: "issue-7", description: "issue-7", definition: "config/scratch-dev.json", days: 7 });
  assert.equal(creates, 2, "created again after the shape refresh");
  assert.ok(calls.includes("org create shape"));
});

test("CI's tested commit moves the story org's ready marker only when the org was ready with the same baseline and seed, on a straight line the delta covered", async () => {
  const { advanceCovered } = await import("../src/org.mjs");
  let title = "pipeline: ready 0123456789ab";
  const sf = (a) => (a[1] === "display" ? { username: "u" } : a[1] === "query" ? { records: [{ Title: title }] } : a[1] === "update" ? ((title = a[a.length - 1].replace(/^Title='|'$/g, "")), {}) : {});
  const reg = orgRegistry({ sf, log: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } });
  assert.equal(reg.advance("issue-7", "fedcba9876543210"), false, "never without proof the deploy covered the move");
  let held = null;
  assert.equal(reg.advance("issue-7", "fedcba9876543210", (h) => { held = h; return true; }), true);
  assert.equal(held, "0123456789ab");
  assert.equal(title, "pipeline: ready fedcba987654");
  // the git proof: ancestor, no merge since, no deletion, every file moved is in the delta
  const git = (r) => (a) => r[a[0] === "diff" ? `diff ${a[1]}` : a[0]] ?? null;
  const base = { "merge-base": "", "rev-list": "", "diff --name-status": "M\tforce-app/a.cls", "diff --name-only": "force-app/a.cls\nforce-app/b.cls" };
  assert.equal(advanceCovered(git(base), { held: "x", head: "h", base: "origin/b" }), true);
  assert.equal(advanceCovered(git({ ...base, "merge-base": null }), { held: "x", head: "h", base: "origin/b" }), false, "not an ancestor (force-push)");
  assert.equal(advanceCovered(git({ ...base, "rev-list": "m1" }), { held: "x", head: "h", base: "origin/b" }), false, "the base was merged in");
  assert.equal(advanceCovered(git({ ...base, "diff --name-status": "D\tforce-app/a.cls" }), { held: "x", head: "h", base: "origin/b" }), false, "a deletion");
  assert.equal(advanceCovered(git({ ...base, "diff --name-status": "M\tforce-app/z.layout-meta.xml" }), { held: "x", head: "h", base: "origin/b" }), false, "reverted to the base: not in the delta");
  title = "pipeline: ready 0123456789ab bdeadbeef00";
  assert.equal(reg.advance("issue-7", "fedcba9876543210"), false, "made with another baseline: provisioning must finish it");
  title = "something else";
  assert.equal(reg.advance("issue-7", "fedcba9876543210"), false, "never marks an org provisioning did not finish");
});

test("production-likeness: sharing defaults that differ, missing packages, users in approval and assignment rules, a partial baseline (13 Oct)", async () => {
  const b = await import("../src/baseline.mjs");
  assert.deepEqual(b.sharingFiles({ DefaultAccountAccess: "Edit", DefaultContactAccess: "ControlledByParent", DefaultLeadAccess: "ReadEditTransfer" }), {}, "production on Salesforce's defaults (today): nothing to write");
  const f = b.sharingFiles({ DefaultAccountAccess: "Read", DefaultCaseAccess: "None", DefaultCampaignAccess: "All" });
  assert.deepEqual(Object.keys(f).sort(), ["objects/Account/Account.object-meta.xml", "objects/Case/Case.object-meta.xml"]);
  assert.match(f["objects/Account/Account.object-meta.xml"], /<sharingModel>Read<\/sharingModel>/);
  assert.match(f["objects/Case/Case.object-meta.xml"], /<sharingModel>Private<\/sharingModel>/);
  const installed = [{ SubscriberPackageName: "HubSpot Integration", SubscriberPackageNamespace: "HubSpot_Inc", SubscriberPackageVersionId: "04t0B00000063ZSQAY" },
    { SubscriberPackageName: "Developer Edition", SubscriberPackageNamespace: "devedapp", SubscriberPackageVersionId: "04tfn000001PPYvAAO" }];
  assert.deepEqual(b.missingPackages(installed, []), ["HubSpot Integration (HubSpot_Inc) 04t0B00000063ZSQAY"], "the edition's own app is not a gap");
  assert.deepEqual(b.missingPackages(installed, packageList(new URL("fixtures/packages.json", import.meta.url).pathname)), [], "a packages.json that lists HubSpot installs it");
  const ap = '<ApprovalProcess><approvalStep><assignedApprover><approver>\n<name>jane@prod.example</name>\n<type>user</type>\n</approver></assignedApprover></approvalStep><approvalStep><assignedApprover><approver><name>Timesheet_Approvers</name><type>queue</type></approver></assignedApprover></approvalStep></ApprovalProcess>';
  const sa = b.sanitize("baseline/x.approvalProcess-meta.xml", ap);
  assert.match(sa, /<name>__SCRATCH_ADMIN__<\/name>\s*<type>user<\/type>/);
  assert.match(sa, /<name>Timesheet_Approvers<\/name><type>queue<\/type>/, "a queue stays (the baseline copies queues)");
  const ar = b.sanitize("baseline/Case.assignmentRules-meta.xml", "<ruleEntry><assignedTo>epic@orgfarm.example</assignedTo>\n<assignedToType>User</assignedToType></ruleEntry><ruleEntry><assignedTo>Support</assignedTo><assignedToType>Queue</assignedToType></ruleEntry>");
  assert.match(ar, /<assignedTo>__SCRATCH_ADMIN__<\/assignedTo>\n<assignedToType>User/);
  assert.match(ar, /<assignedTo>Support<\/assignedTo><assignedToType>Queue/);
  // an escalation action carries its email template between the assignee and its type (production's Case rules)
  const er = b.sanitize("baseline/Case.escalationRules-meta.xml", "<escalationAction>\n<assignedTo>epic@orgfarm.example</assignedTo>\n<assignedToTemplate>unfiled$public/X</assignedToTemplate>\n<assignedToType>User</assignedToType>\n</escalationAction>");
  assert.match(er, /<assignedTo>__SCRATCH_ADMIN__<\/assignedTo>\n<assignedToTemplate>unfiled\$public\/X/);
  const cfg = JSON.parse(readFileSync(new URL("../../config/baseline.json", import.meta.url), "utf8"));
  for (const t of ["ApprovalProcess", "AssignmentRules", "AutoResponseRules", "EscalationRules"]) assert.ok(cfg.types.includes(t), t);
  // a deploy that fails on baseline components only: those leave, the rest retries
  const { failedBaselineFiles } = await import("../src/org.mjs");
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync: ex } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "composed-"));
  mkdirSync(join(dir, "baseline/main/default/approvalProcesses"), { recursive: true });
  writeFileSync(join(dir, "baseline/main/default/approvalProcesses/T.approvalProcess-meta.xml"), "x");
  mkdirSync(join(dir, "baseline/main/default/classes"), { recursive: true });
  writeFileSync(join(dir, "baseline/main/default/classes/P.cls"), "x");
  writeFileSync(join(dir, "baseline/main/default/classes/P.cls-meta.xml"), "x");
  // sf's reply on a failed deploy (io.sf with allowFail "json"): files with their state and absolute path
  const reply = (...paths) => ({ success: false, files: [...paths.map((p) => ({ state: "Failed", filePath: join(dir, p) })), { state: "Changed", filePath: join(dir, "force-app/x") }] });
  assert.deepEqual(failedBaselineFiles(reply("baseline/main/default/approvalProcesses/T.approvalProcess-meta.xml", "baseline/main/default/classes/P.cls"), dir).sort(),
    ["baseline/main/default/approvalProcesses/T.approvalProcess-meta.xml", "baseline/main/default/classes/P.cls", "baseline/main/default/classes/P.cls-meta.xml"], "with its companion file");
  assert.ok(!ex(join(dir, "baseline/main/default/approvalProcesses/T.approvalProcess-meta.xml")));
  assert.deepEqual(failedBaselineFiles({ files: [{ state: "Failed", filePath: join(dir, "baseline/x") }, { state: "Failed", filePath: join(dir, "force-app/main/default/classes/A.cls") }] }, dir), [], "the story's own failure: no retry without production's pieces");
  // the CLI wrapper hands a failed --json command's reply back when asked
  const { run } = await import("../src/io.mjs");
  assert.match(run("node", ["-e", "console.log(JSON.stringify({status:1,result:{files:[]}}));process.exit(1)"], { allowFail: "json" }), /"status":1/);
});

test("orgs know what they hold: the seed loads on every ready() (even when the code is already there), staging and UAT get every story's seed, a snapshot's baseline is not redeployed", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync: write } = await import("node:fs");
  const { tmpdir: tmp } = await import("node:os");
  const { join: j } = await import("node:path");
  const root = mkdtempSync(j(tmp(), "seed-"));
  const seedDir = j(root, "core"), work = j(root, "work"), baselineDir = j(root, "baseline");
  mkdirSync(seedDir, { recursive: true });
  write(j(seedDir, "plan.json"), JSON.stringify([{ sobject: "Account", files: ["Account.json"] }]));
  write(j(seedDir, "Account.json"), JSON.stringify({ records: [{ attributes: { type: "Account", referenceId: "M" }, Name: "${SEED_MARKER}" }] }));
  for (const k of ["77", "78"]) {
    mkdirSync(j(work, "data/seed/stories", k), { recursive: true });
    write(j(work, "data/seed/stories", k, "plan.json"), JSON.stringify([{ sobject: "Account", files: ["Account.json"] }]));
    write(j(work, "data/seed/stories", k, "Account.json"), JSON.stringify({ records: [{ attributes: { type: "Account", referenceId: "A" }, Name: `Story ${k} account` }] }));
  }
  mkdirSync(j(work, "force-app/main/default"), { recursive: true });
  mkdirSync(j(baselineDir, "main/default/objects"), { recursive: true });
  write(j(baselineDir, "main/default/objects/X.txt"), "x");
  // a fake sf: no seed marker in the org yet, a scratch org that is not production, and a snapshot listing
  const fake = ({ live = [], title = null, snapshots = [] } = {}) => {
    const p = provisionSf({ live, title });
    const sf = (args, opts) => {
      const c = args.join(" ");
      if (/FROM Account WHERE Name = '\[seed/.test(c) || /FROM Account WHERE Name LIKE '\[seed/.test(c)) { p.calls.push(c); return { records: [] }; }
      if (args[0] === "org" && args[1] === "list" && args[2] === "snapshot") return snapshots;
      if (args[0] === "org" && args[1] === "display") return { clientId: "CID", username: "u@x", id: args.includes("devhub") ? "00Dprod000000001" : "00Dscratch000001" };
      return p.sf(args, opts);
    };
    return { sf, calls: p.calls };
  };
  const reg = (sf, env = {}, dir = seedDir) => orgRegistry({ sf, log: () => {}, sleep: () => {}, packages: [], seedDir: dir, baselineDir, env: { BASELINE: "off", SEED: "on", ...env } });
  const cwd = process.cwd();
  process.chdir(work);
  try {
    // a story org gets the core seed and its own story's
    let f = fake();
    assert.deepEqual(reg(f.sf).seed("issue-77", { story: "77" }).map((m) => m.replace(/ [0-9a-f]+\]$/, "]")), ["[seed]", "[seed story 77]"]);
    // staging and UAT get every story's seed in the release
    f = fake();
    assert.deepEqual(reg(f.sf).seed("staging", { stories: "all" }).map((m) => m.replace(/ [0-9a-f]+\]$/, "]")), ["[seed]", "[seed story 77]", "[seed story 78]"]);
    // ready() seeds even when it returns early because the org already holds the commit (a seed added later loads)
    const { baselineId } = await import("../src/baseline.mjs");
    f = fake({ live: [{ Description: "issue-77", SignupUsername: "u@x", LoginUrl: "https://s" }], title: orgMod.readyMarker("abc123456789ffff", null, baselineId(seedDir)) });
    assert.equal(reg(f.sf).ready("issue-77", { commit: "abc123456789ffff" }).fresh, true);
    assert.ok(!f.calls.some((c) => c.startsWith("project deploy")), "nothing redeployed");
    assert.ok(f.calls.some((c) => c.startsWith("data import tree")), "the story's seed loaded");
    // a new org from a snapshot that holds this baseline: force-app only; a snapshot of another baseline: the full deploy
    const id = reg(() => ({}), { BASELINE: "soft" }).baselineId();
    for (const [desc, full] of [[`main@abc b${id}`, false], ["main@abc b0000000000", true]]) {
      f = fake({ snapshots: [{ SnapshotName: "LCB2610140000", Status: "Active", CreatedDate: "2026-10-14", Description: desc }] });
      reg(f.sf, { BASELINE: "soft", SEED: "off" }).ready("story:90", { commit: "c0ffee" });
      assert.equal(f.calls.some((c) => (c + " ").includes(" -d baseline ")), full, desc);
    }
    // a claimed warm pool org came from a snapshot too: the same rule, no baseline redeploy when that snapshot holds this
    // baseline (#426: a claim redeployed it every time). ScratchOrgInfo.Snapshot holds the snapshot's name (live Dev Hub,
    // 30 Oct: "LCB2610250836" on uat-2027-w03). pool-1 is older but on this baseline; pool-2 is newer, on an older one.
    const snaps = (current = id) => [{ SnapshotName: "LCB2610250836", Status: "Active", CreatedDate: "2026-10-25", Description: `main@abc b${current}` },
      { SnapshotName: "LCB2610162243", Status: "Active", CreatedDate: "2026-10-16", Description: "main@abc b0000000000" }];
    const pool = () => [{ Description: "pool-1", SignupUsername: "p1@x", LoginUrl: "https://s", CreatedDate: "2026-10-26", Snapshot: "LCB2610250836" },
      { Description: "pool-2", SignupUsername: "p2@x", LoginUrl: "https://s", CreatedDate: "2026-10-27", Snapshot: "LCB2610162243" }];
    const devhub = (live, snapshots = snaps()) => {
      const g = fake({ live, snapshots }), calls = [];
      const sf = (args, opts) => {
        calls.push(args.join(" "));
        if (args[0] === "data" && args[1] === "update" && args.includes("ScratchOrgInfo")) {
          const who = args[args.indexOf("-w") + 1].match(/'(.+)'/)[1];
          live.find((r) => r.SignupUsername === who).Description = args[args.indexOf("-v") + 1].match(/'(.+)'/)[1];
          return { success: true };
        }
        return g.sf(args, opts);
      };
      return { sf, calls };
    };
    let live = pool(), d = devhub(live);
    reg(d.sf, { BASELINE: "soft", SEED: "off", ORG_POOL: "2" }).ready("story:91", { commit: "c0ffee" });
    assert.deepEqual(live.map((r) => r.Description), ["issue-91", "pool-2"], "the pool org on this baseline is claimed first, though older");
    assert.ok(!d.calls.some((c) => c.startsWith("org create scratch")), "no new org");
    assert.ok(!d.calls.some((c) => (c + " ").includes(" -d baseline ")), "its snapshot holds this baseline: force-app only");
    assert.ok(d.calls.some((c) => /^data query .*SELECT SignupUsername, .*\bSnapshot\b.* FROM ScratchOrgInfo/.test(c)), "the registry reads which snapshot each org came from");
    assert.equal(d.calls.filter((c) => c.startsWith("org list snapshot")).length, 1, "the snapshot list is read once per registry");
    // only a pool org on an older baseline left: still claimed (it saves the create), with the full deploy
    live = [pool()[1]]; d = devhub(live);
    reg(d.sf, { BASELINE: "soft", SEED: "off", ORG_POOL: "2" }).ready("story:92", { commit: "c0ffee" });
    assert.equal(live[0].Description, "issue-92");
    assert.ok(d.calls.some((c) => (c + " ").includes(" -d baseline ")), "an older baseline: the full deploy");
    // the janitor retires a pool org on an older baseline once the current snapshot holds this one, and makes it again
    live = pool(); d = devhub(live);
    assert.deepEqual(reg(d.sf, { BASELINE: "soft", SEED: "off", ORG_POOL: "2" }).topUpPool(2), ["pool-2"]);
    assert.deepEqual(d.calls.filter((c) => c.startsWith("data delete record")).map((c) => c.match(/SignupUsername='(.+)'/)[1]), ["p2@x"], "only the stale one");
    // ... but not while the current snapshot holds an older baseline too: its replacement would be no better
    live = pool(); d = devhub(live, snaps("0000000000"));
    assert.deepEqual(reg(d.sf, { BASELINE: "soft", SEED: "off", ORG_POOL: "2" }).topUpPool(2), []);
    assert.ok(!d.calls.some((c) => c.startsWith("data delete record")), "nothing retired");
  } finally { process.chdir(cwd); }
  // the core seed has no email-origin Cases: they queue ClassifyCaseJob, whose pending async job blocked every baseline
  // redeploy of its classes (6 files retried on every org build, 14 Oct)
  assert.doesNotMatch(readFileSync(new URL("../../data/seed/Case.json", import.meta.url), "utf8"), /"Origin": "Email"/);
});

test("shipped stories' seeds fold into the core seed: files renamed per story, their own reference ids prefixed, references to the core kept", () => {
  const core = { plan: [{ sobject: "Account", saveRefs: true, files: ["Account.json"] }], files: { "Account.json": '{"records":[{"attributes":{"type":"Account","referenceId":"Acc01"},"Name":"Northwind"}]}' } };
  const story = { key: "283", plan: [{ sobject: "Renewal_Check__c", resolveRefs: true, files: ["Renewal_Check__c.json"] }, { sobject: "Account", files: ["SeedMarker.json"] }],
    files: { "Renewal_Check__c.json": '{"records":[{"attributes":{"type":"Renewal_Check__c","referenceId":"RC1"},"Account__c":"@Acc01","Parent__c":"@RC1"}]}', "SeedMarker.json": "{}" } };
  const r = orgMod.foldSeeds(core, [story]);
  assert.deepEqual(r.plan.map((e) => e.files), [["Account.json"], ["story-283-Renewal_Check__c.json"]], "the story's marker file is dropped");
  assert.match(r.files["story-283-Renewal_Check__c.json"], /"referenceId":"S283RC1"/);
  assert.match(r.files["story-283-Renewal_Check__c.json"], /"Account__c":"@Acc01"/, "a reference to the core's Account stays");
  assert.match(r.files["story-283-Renewal_Check__c.json"], /"Parent__c":"@S283RC1"/, "a reference to the story's own record follows the rename");
  const pre = orgMod.foldSeeds(core, [{ key: "444", plan: [{ sobject: "Account", files: ["Account.json"] }], files: { "Account.json": '{"records":[{"attributes":{"type":"Account","referenceId":"S444Acc01"}}],"x":"@S444Acc01"}' } }]);
  assert.match(pre.files["story-444-Account.json"], /"referenceId":"S444Acc01"\}[\s\S]*"@S444Acc01"/, "an id the story already prefixed is prefixed once (#475: S444S444Acc01)");
  const wf = readFileSync(new URL("../../.github/workflows/seed-fold.yml", import.meta.url), "utf8");
  assert.match(wf, /pipeline-identity/, "opened as the App, so its PR runs CI");
  assert.match(wf, /paths: \["data\/seed\/stories\/\*\*"\]/);
  assert.match(readFileSync(new URL("../../.github/workflows/improve.yml", import.meta.url), "utf8"), /seed-fold/);
  assert.match(readFileSync(new URL("../../docs/agents/salesforce.md", import.meta.url), "utf8"), /data\/seed\/stories\/<story key>\/plan\.json/);
  assert.match(readFileSync(new URL("../../.github/workflows/ai-implement.yml", import.meta.url), "utf8"), /data\/seed\/stories\/\$\{\{ env\.KEY \}\}\/plan\.json/);
});

test("the masked production sample for UAT: off by default, a protected environment, org to org, and a guard that fails on a surviving production email", () => {
  assert.deepEqual(sample.parseDomains("acme.com, @Acme.co.uk not-a-domain"), ["acme.com", "acme.co.uk"]);
  assert.deepEqual(sample.guardQueries(""), [], "no domains: nothing to check (the command then refuses to trust the sample)");
  assert.match(sample.guardQueries("acme.com")[0], /FROM Contact WHERE Email LIKE '%@acme\.com'/);
  assert.deepEqual(sample.sampleLeaks([]), { ok: true, leaked: [] });
  assert.deepEqual(sample.sampleLeaks([{ Email: "jane.doe@acme.com" }]), { ok: false, leaked: ["***@acme.com"] }, "the leak is reported without the person's name");
  assert.equal(settings.setting("UAT_SAMPLE", {}), "off");
  const wf = readFileSync(new URL("../../.github/workflows/uat-sample.yml", import.meta.url), "utf8");
  assert.match(wf, /if: vars\.UAT_SAMPLE == 'on'/);
  assert.match(wf, /environment: production-read/);
  assert.match(wf, /SF_PROD_READ_USERNAME/, "a read-only production user, not the CI admin");
  assert.match(wf, /sf org logout -o devhub/);
  assert.match(wf, /sfdmu@5\.8\.0/, "a pinned SFDMU");
  assert.match(wf, /pipe\.mjs sample guard --org uat/);
  assert.doesNotMatch(wf, /upload-artifact|csvfile/, "nothing written or uploaded: org to org only");
  const cfg = JSON.parse(readFileSync(new URL("../../config/uat-sample/export.json", import.meta.url), "utf8"));
  for (const o of cfg.objects) {
    assert.equal(o.updateWithMockData, true, o.query);
    assert.doesNotMatch(o.query, /\bDescription\b|\bComments?\b/, "no free text is copied");
  }
  assert.ok(cfg.objects.find((o) => /FROM Contact/.test(o.query)).mockFields.some((m) => m.name === "Email"), "emails are masked");
  assert.ok(cfg.objects.find((o) => /FROM Case/.test(o.query)).mockFields.some((m) => m.name === "Origin"), "no email-origin Cases (they queue Apex jobs in UAT)");
});

test("a login error from a snapshot is tried once more and never refuses it; a real snapshot error still does", () => {
  const list = [{ SnapshotName: "LCB2610140537", Status: "Active", CreatedDate: "2026-10-14T05:37:00.000+0000" }];
  const run = (errors) => {
    const refused = [], events = [];
    let creates = 0;
    const sf = (a) => {
      if (a[0] === "org" && a[2] === "snapshot") return list;
      if (a[0] === "org" && a[1] === "create" && a.some((x) => String(x).includes("snapshot-"))) { const e = errors[creates++]; if (e) throw new Error(e); return {}; }
      if (a[0] === "org" && a[1] === "list") return { scratchOrgs: [] };
      return {};
    };
    const r = orgRegistry({ sf, sleep: () => {}, log: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" }, record: (k, d) => events.push([k, d]), refuseSnapshot: (n) => refused.push(n) });
    const how = r.create({ alias: "staging", description: "staging-2027-w01", days: 30, kind: "sprint", definition: "qa" });
    return { how, refused, creates, events };
  };
  const jwt = "sf org create scratch failed: JwtAuthError: Error authenticating with JWT. Errors encountered: <!DOCTYPE HTML>";
  const once = run([jwt]);
  assert.deepEqual([once.how.fromSnapshot, once.creates, once.refused], [true, 2, []], "the second try works");
  const twice = run([jwt, jwt]);
  assert.deepEqual([twice.how.fromSnapshot, twice.refused], [false, []], "falls back to shape, the snapshot kept");
  assert.equal(twice.events.find(([k]) => k === "snapshot")[1].transient, true);
  const real = run(["SnapshotNotActive: The snapshot is not active"]);
  assert.deepEqual([real.creates, real.refused], [1, ["LCB2610140537"]], "a snapshot error: no second try, refused");
});

test("one table says what kind of Salesforce failure an error is; every caller branches on the kind", async () => {
  const { sfFailure } = await import("../src/io.mjs");
  assert.equal(sfFailure("ERROR running org create: JwtAuthError: Error authenticating with JWT"), "transient");
  assert.equal(sfFailure("UNABLE_TO_LOCK_ROW: unable to obtain exclusive access"), "transient");
  assert.equal(sfFailure("LICENSE_LIMIT_EXCEEDED: License Limit Exceeded"), "licence");
  assert.equal(sfFailure("No free scratch org slot (3 active is the Dev Hub's limit)"), "slots");
  assert.equal(sfFailure("REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded"), "limit");
  assert.equal(sfFailure("ERROR: The org shape version is outdated. Recreate the org shape."), "shape");
  assert.equal(sfFailure("Deploy failed: Field Tier__c does not exist"), "real");
  for (const f of ["org.mjs", "improve.mjs", "org/users.mjs", "org/fleet.mjs"]) {
    assert.doesNotMatch(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"), /JwtAuthError|LICENSE_LIMIT_EXCEEDED|shape\.\{0,40\}|HTTP 50\[234\]/, `${f} keeps no failure-kind regex of its own: io.SF_FAILURES`);
  }
});

test("the warm pool (ORG_POOL): a story claims a pool org instead of creating one; the janitor makes only what a spare slot allows; lowering it deletes the newest", async () => {
  const { poolToMake } = await import("../src/org.mjs");
  const lim = (active, daily = 50) => ({ active: { remaining: active, max: 40 }, daily: { remaining: daily, max: 80 } });
  assert.deepEqual(poolToMake({ records: [], size: 2, limits: lim(10) }), ["pool-1", "pool-2"]);
  assert.deepEqual(poolToMake({ records: [{ Description: "pool-1" }], size: 2, limits: lim(10) }), ["pool-2"], "only what is missing");
  assert.deepEqual(poolToMake({ records: [], size: 3, limits: lim(3), reserve: 1 }), ["pool-1"], "a slot stays free beyond the reserve");
  assert.deepEqual(poolToMake({ records: [], size: 3, limits: lim(10, 2) }), ["pool-1"], "the daily allowance too, never its last org");
  assert.deepEqual(poolToMake({ records: [], size: 0, limits: lim(10) }), []);
  const pool = [{ Description: "pool-1", SignupUsername: "p1@x", CreatedDate: "2026-10-20" }, { Description: "pool-2", SignupUsername: "p2@x", CreatedDate: "2026-10-21" }];
  const now = new Date("2026-10-22T00:00:00Z");
  assert.deepEqual(findOrphans(pool, { poolSize: 1, now }).map((o) => o.description), ["pool-2"], "the newest go first");
  assert.deepEqual(findOrphans(pool, { now }), [], "no pool size given: pool orgs are left alone");
  assert.deepEqual(findOrphans(pool, { poolSize: 2, now: new Date("2026-10-23T12:00:00Z") }).map((o) => o.description), ["pool-1"], "older than 72 h: a fresh one is made");
  // a story claims the oldest pool org: its Description becomes the story's, then the usual deploy; no new org
  const live = pool.map((r) => ({ ...r })), calls = [];
  const sf = (args) => {
    calls.push(args.slice(0, 3).join(" "));
    if (args[0] === "data" && args[1] === "update" && args.includes("ScratchOrgInfo")) {
      const who = args[args.indexOf("-w") + 1].match(/'(.+)'/)[1], to = args[args.indexOf("-v") + 1].match(/'(.+)'/)[1];
      live.find((r) => r.SignupUsername === who).Description = to;
      return { success: true };
    }
    if (args[0] === "data" && args[1] === "query" && /FROM User/.test(args.at(-1))) return { records: [{ Title: null }] };
    if (args[0] === "data" && args[1] === "query") return { records: live };
    if (args[0] === "org" && args[1] === "display") return { clientId: "CID", username: "u@x" };
    if (args[0] === "package" && args[1] === "installed") return [];
    return {};
  };
  const o = orgRegistry({ sf, log: () => {}, sleep: () => {}, packages: [], record: () => {}, env: { ORG_POOL: "2", BASELINE: "off", SEED: "off" } }).ensure("story:9");
  assert.equal(o.created, true);
  assert.equal(live[1].Description, "issue-9", "the newest pool org (the most days left) is the story's now");
  assert.ok(!calls.includes("org create scratch"), "no new org");
  assert.ok(calls.includes("org login jwt") && calls.includes("project deploy start"), "logged in under the story's alias, then deployed");
  // a race: another story's write lands on the newest pool org after ours; we take the next one, not a new org
  const live2 = pool.map((r) => ({ ...r })), calls3 = [];
  const racing = (args, x) => {
    calls3.push(args.slice(0, 3).join(" "));
    if (args[0] === "data" && args[1] === "update" && args.includes("ScratchOrgInfo")) {
      const who = args[args.indexOf("-w") + 1].match(/'(.+)'/)[1], to = args[args.indexOf("-v") + 1].match(/'(.+)'/)[1];
      live2.find((r) => r.SignupUsername === who).Description = who === "p2@x" ? "issue-77" : to;   // story 77 won p2
      return { success: true };
    }
    if (args[0] === "data" && args[1] === "query" && !/FROM User/.test(args.at(-1))) return { records: live2 };
    return sf(args, x);
  };
  orgRegistry({ sf: racing, log: () => {}, sleep: () => {}, packages: [], record: () => {}, env: { ORG_POOL: "2", BASELINE: "off", SEED: "off" } }).ensure("story:11");
  assert.deepEqual(live2.map((r) => r.Description), ["issue-11", "issue-77"], "the loser took the next pool org");
  assert.ok(!calls3.includes("org create scratch"), "no daily slot spent");
  // pool off: a story creates as before
  const c2 = [];
  orgRegistry({ sf: (a, x) => { c2.push(a.slice(0, 3).join(" ")); return sf(a, x); }, log: () => {}, sleep: () => {}, packages: [], record: () => {}, env: { BASELINE: "off", SEED: "off" } }).ensure("story:10");
  assert.ok(c2.includes("org create scratch"));
  // wiring: the janitor tops it up after its sweep; a story PR closed without merging gives its org back at once
  const wf = (n) => readFileSync(new URL(`../../.github/workflows/${n}.yml`, import.meta.url), "utf8");
  assert.match(wf("scratch-janitor"), /org sweep\n\s+node pipeline\/bin\/pipe\.mjs org pool/);
  assert.match(wf("merged"), /closed:\n[\s\S]*merged == false && github\.event\.pull_request\.head\.repo\.full_name == github\.repository[\s\S]*pipe\.mjs start closed --head[\s\S]*start followups --after delete-story-org/);
  // the decision is start.closedPlan (27 Oct review: merged.yml had its own branch regex, storyOf another)
  assert.deepEqual(start.closedPlan({ head: "issue-9" }), { story: "9" });
  assert.deepEqual(start.closedPlan({ head: "LIFE-12" }), { story: "LIFE-12" });
  assert.match(start.closedPlan({ head: "issue-9-x" }).why, /not a story's own branch/, "storyOf accepts it; the org is not its");
  assert.match(start.closedPlan({ head: "fix-ci" }).why, /not a story's own branch/);
  assert.match(start.closedPlan({ head: "issue-9", openPrs: 1 }).why, /still open: the org stays/);
});

test("CI's org (org.ci, B2): attached when live; completed when half-made; a gone story org rebuilt once; a temporary org only when it must be", () => {
  const env = { BASELINE: "off", SEED: "off" };
  const live = [{ Description: "issue-12", SignupUsername: "u@x", LoginUrl: "https://s" }];
  const mk = (sf) => orgRegistry({ sf, log: () => {}, sleep: () => {}, packages: [], env });
  // live and ready: logged in, nothing deployed by the org step (CI deploys the delta)
  let f = fakeSf(live);
  let o = mk(f.sf).ci("issue-12", { name: "ci-1" });
  assert.deepEqual([o.alias, o.temp, o.full], ["issue-12", false, false]);
  assert.ok(!f.calls.includes("org create scratch") && !f.calls.includes("project deploy start"));
  // live but never finished: completed by ready(), so CI does not delta-deploy onto a half-made org
  f = fakeSf(live, { ready: false });
  o = mk(f.sf).ci("issue-12", { name: "ci-1" });
  assert.deepEqual([o.temp, o.full, o.completed], [false, true, true]);
  assert.ok(!f.calls.includes("org create scratch") && f.calls.includes("project deploy start"));
  // the story org is gone (expired): rebuilt as the story's org, once; the next push attaches to it
  f = fakeSf([]);
  let temps = 0;
  o = mk(f.sf).ci("issue-12", { name: "ci-1", onTemp: () => temps++ });
  assert.deepEqual([o.alias, o.temp, o.full, o.created, temps], ["issue-12", false, true, true, 0]);
  assert.equal(f.calls.filter((c) => c === "org create scratch").length, 1);
  // no slot past ORG_RESERVE: a temporary org for this run (onTemp first, so CI deletes it whatever happens)
  const full = (args, opts) => (args[0] === "limits" ? [{ name: "ActiveScratchOrgs", remaining: 1, max: 3 }, { name: "DailyScratchOrgs", remaining: 5, max: 6 }] : f.sf(args, opts));
  f = fakeSf([]);
  o = orgRegistry({ sf: full, log: () => {}, sleep: () => {}, packages: [], env: { ...env, ORG_RESERVE: "1" } }).ci("issue-12", { name: "ci-2", onTemp: () => temps++ });
  assert.deepEqual([o.alias, o.temp, temps], ["ci-2", true, 1]);
  assert.ok(f.calls.includes("project deploy start"), "the temporary org gets the whole source");
  // the PR is not open: the story org is not rebuilt, a temporary org runs the check
  f = fakeSf([]);
  o = mk(f.sf).ci("issue-12", { name: "ci-3", refusal: () => "story 12's PR is closed" });
  assert.equal(o.temp, true);
  // a branch with no org of its own (maintenance): a temporary org, as before
  f = fakeSf([]);
  assert.equal(mk(f.sf).ci("docs-tidy", { name: "ci-4" }).temp, true);
  // the org is there but login fails: the step fails, no daily org spent on it
  f = fakeSf(live);
  const noLogin = (args, opts) => (args[0] === "org" && args[1] === "login" ? null : f.sf(args, opts));
  assert.throws(() => mk(noLogin).ci("issue-12", { name: "ci-5" }), /Could not log in/);
  assert.ok(!f.calls.includes("org create scratch"));
});

test("the org registry reads the Dev Hub's active orgs once until it changes them (28 Oct): ready() on a live org, one query; a create or a claim reads again", () => {
  const live = [{ Description: "issue-12", SignupUsername: "u@x", LoginUrl: "https://s" }];
  const queries = (calls) => calls.filter((c) => c === "data query -o").length;
  const n = { devhub: 0 };
  const count = (f) => (args, o) => { if (args[0] === "data" && args[1] === "query" && /ScratchOrgInfo/.test(args.at(-1))) n.devhub++; if (args[0] === "org" && args[1] === "display" && args[3] === "devhub") n.display = (n.display || 0) + 1; return f(args, o); };
  let f = fakeSf(live);
  const r = orgRegistry({ sf: count(f.sf), log: () => {}, sleep: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } });
  r.ready("issue-12", { commit: "abc123456789ffff" });
  r.attach("issue-12");
  assert.equal(n.devhub, 1, "find, attach and a second attach share one read");
  assert.equal(n.display, 1, "the Dev Hub's client id once");
  // a new org changes the list: the next find reads again
  n.devhub = 0; f = fakeSf([]);
  const r2 = orgRegistry({ sf: count(f.sf), log: () => {}, sleep: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } });
  r2.find("issue-9"); r2.find("issue-9");
  assert.equal(n.devhub, 1);
  r2.create({ kind: "story", alias: "issue-9", description: "issue-9", days: 7, definition: "config/scratch-dev.json" });
  r2.find("issue-9");
  assert.equal(n.devhub, 2, "read again after the create");
  n.devhub = 0;
  r.removeTagged("issue-12");   // deletes the live org: the list changed
  r.find("issue-12");
  assert.equal(n.devhub, 1, "the delete finds the org in the list already read; after it, one fresh read");
  assert.ok(queries(f.calls) >= 2);
});

test("org.ci: the change's own deploy failing inside ready() is marked as a deploy failure (CI's code-failed, so autofix still starts)", () => {
  const f = fakeSf([{ Description: "issue-12", SignupUsername: "u@x", LoginUrl: "https://s" }], { ready: false });
  const broken = (args, o) => { if (args[0] === "project" && args[1] === "deploy") throw new Error("Deploy failed: Variable does not exist: x"); return f.sf(args, o); };
  let err;
  try { orgRegistry({ sf: broken, log: () => {}, sleep: () => {}, packages: [], env: { BASELINE: "off", SEED: "off" } }).ci("issue-12", { name: "ci-1" }); } catch (e) { err = e; }
  assert.equal(err?.phase, "deploy");
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /code-failed: .*steps\.org\.outputs\.deploy-failed == 'true'/);
  assert.match(readFileSync(new URL("../bin/commands/org.mjs", import.meta.url), "utf8"), /"no open PR for this run"/, "a hand-run CI with no open PR never rebuilds a story org");
});

test("#430: the snapshot is rebuilt only when main's baseline, seed or the release's shape inputs differ from what it holds", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "snap-430-"));
  const baselineDir = join(root, "baseline"), seedDir = join(root, "data/seed");
  mkdirSync(join(baselineDir, "objects"), { recursive: true }); mkdirSync(seedDir, { recursive: true });
  mkdirSync(join(root, "force-app/main/default/settings"), { recursive: true }); mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(baselineDir, "objects", "X.xml"), "<x/>");
  writeFileSync(join(seedDir, "plan.json"), "[]");
  writeFileSync(join(root, "force-app/main/default/settings/Account.settings-meta.xml"), "<AccountSettings/>");
  writeFileSync(join(root, "config/scratch-dev.json"), "{}");
  let lists = 0;
  const registry = (snapshots, env = {}) => orgRegistry({ sf: (a) => (a[0] === "org" && a[1] === "list" && a[2] === "snapshot" ? (lists++, snapshots) : {}), log: () => {}, packages: [], baselineDir, seedDir, shapeRoot: root, env });
  const ids = registry([]).snapshotPlan({ ifChanged: true }).ids;
  const { baseline: b, seed: s, shape: h } = ids;
  for (const id of [b, s, h]) assert.match(id, /^[0-9a-f]{10}$/);
  const NOW = Date.parse("2026-10-30T05:00:00Z");
  const snap = (Description, extra = {}) => ({ SnapshotName: "LCB2610300100", Status: "Active", CreatedDate: "2026-10-30T01:00:00.000+0000", Description, ...extra });
  const plan = (snaps, opts = { ifChanged: true }, env) => registry(snaps, env).snapshotPlan({ now: NOW, ...opts });
  const held = `b${b} s${s} h${h} main@1234567`;

  lists = 0;
  assert.equal(plan([snap(held)]).rebuild, false, "it holds all three: nothing to rebuild");
  assert.equal(lists, 1, "one snapshot listing per decision");
  assert.match(plan([snap(`b0000000000 s${s} h${h}`)]).why, /baseline/, "the baseline changed");
  assert.match(plan([snap(`b${b} s0000000000 h${h}`)]).why, /seed/, "the seed changed");
  assert.match(plan([snap(`b${b} s${s} h0000000000`)]).why, /shape/, "a release changed production's settings: the shape the snapshot was made from is old");
  assert.equal(plan([snap(`b${b} s${s} h0000000000`)]).rebuild, true);
  assert.match(plan([snap(`main@1234567 b${b} s${s}`)]).why, /shape/, "a snapshot made before #430 names no shape: rebuilt once");
  assert.match(plan([]).why, /no Active snapshot/);
  // a second push queued behind the first: the first one's snapshot, still being made, already holds main's ids
  const building = snap(held, { SnapshotName: "LCB2610300400", Status: "InProgress", CreatedDate: "2026-10-30T04:00:00.000+0000" });
  const pending = plan([snap(`b0000000000 s${s} h${h}`), building]);
  assert.equal(pending.rebuild, false); assert.match(pending.why, /LCB2610300400 .*InProgress/);
  assert.equal(plan([building]).rebuild, false, "no Active one yet, but one holding main's ids is on its way");
  assert.equal(plan([snap(`b0000000000 s${s} h${h}`), { ...building, Status: "Error" }]).rebuild, true, "a failed one does not count");
  assert.equal(plan([snap(held, { CreatedDate: "2026-10-29T01:00:00.000+0000", SnapshotName: "LCB2610290100" }), snap(`b0000000000 s${s} h${h}`)]).rebuild, true, "an older snapshot holding them is not the one new orgs use");
  // a release merge that changes the seed and Settings: its push must not build on the old shape and claim the new
  // shape inputs, or the release's own run (after its shape job) would find them held and skip
  const both = plan([snap(`b${b} s0000000000 h0000000000`)], { ifChanged: true, onPush: true });
  assert.equal(both.rebuild, false); assert.match(both.why, /release rebuilds it after its shape job/);
  assert.equal(plan([snap(`b${b} s0000000000 h${h}`)], { ifChanged: true, onPush: true }).rebuild, true, "the seed alone: the push rebuilds");
  assert.equal(plan([snap(`main@1 b${b} s0000000000`)], { ifChanged: true, onPush: true }).rebuild, true, "a snapshot from before #430 names no shape: not deferred");
  // a short main SHA that starts with b is not a baseline id (the old \bb regex read main@b1c2d3e as baseline 1c2d3e)
  assert.match(plan([snap(`main@b1c2d3e s${s} h${h}`)]).why, /baseline/);
  // --if-older-than and an explicit run
  assert.equal(plan([snap("main@1")], { olderThan: 20 }).rebuild, false, "4 hours old");
  assert.equal(plan([snap("main@1")], { olderThan: 2 }).rebuild, true);
  assert.equal(plan([snap(held)], {}).rebuild, true, "by hand, nothing asked: always");
  // a pinned snapshot: nothing new would be used, so nothing is built
  const pinned = plan([snap("main@1")], {}, { SCRATCH_SNAPSHOT: "LCB2610010100" });
  assert.equal(pinned.rebuild, false); assert.match(pinned.why, /::notice::SCRATCH_SNAPSHOT pins LCB2610010100/);
  assert.equal(plan([], {}, { SCRATCH_SNAPSHOT: "off" }).rebuild, false);

  // what a new snapshot says it holds: ids first, so the 255-character cut only ever shortens the free text
  const { snapshotDescription, snapshotHolds } = await import("../src/org/snapshot.mjs");
  const d = snapshotDescription({ ...ids, commit: "1234567" });
  assert.equal(d, held);
  assert.deepEqual(snapshotHolds(d), ids);
  const long = snapshotDescription({ ...ids, commit: "x".repeat(400) });
  assert.equal(long.length, 255); assert.deepEqual(snapshotHolds(long), ids);
  assert.deepEqual(snapshotHolds("main@b1c2d3e"), { baseline: null, seed: null, shape: null });
  assert.equal(registry([snap(`main@b1c2d3e b${b} s${s}`)]).snapshotBaseline("LCB2610300100"), b, "older descriptions (main@ first) still read");
  const src = readFileSync(new URL("../src/org/snapshot.mjs", import.meta.url), "utf8");
  assert.equal((src.match(/\.slice\(0, 255\)/g) || []).length, 1, "the description is cut in one place");
});

test("CI deploys what changed since the commit the story org holds, so a sprint merged into the story reaches the org (#450)", async () => {
  const { heldCommit, readyMarker } = await import("../src/org.mjs");
  assert.equal(heldCommit(readyMarker("0123456789abcdef0123", "123", "abc")), "0123456789ab");
  assert.equal(heldCommit(readyMarker("0123456789abcdef")), "0123456789ab");
  assert.equal(heldCommit("pipeline: ready"), null, "ready, with no commit");
  assert.equal(heldCommit("Sales Rep"), null);
  assert.equal(heldCommit(undefined), null);
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /HELD=\$\(node \.pipeline\/pipeline\/bin\/pipe\.mjs org held "\$ALIAS"/);
  assert.match(ci, /git merge-base --is-ancestor "\$HELD" HEAD[^\n]*FROM="\$HELD"/);
  assert.match(ci, /sf sgd source delta --to HEAD --from "\$FROM"/);
});

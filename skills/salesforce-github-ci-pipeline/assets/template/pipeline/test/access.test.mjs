// Pipeline tests: access (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
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

test("context pack: production's own components (baseline/) are listed and marked, with validation, workflow, sharing and duplicate rules and every Flow that touches the object", () => {
  const B = "baseline/main/default";
  const r = repo({
    [`${O}/classes/CaseHandler.cls`]: "public with sharing class CaseHandler { Case c; }",
    [`${B}/triggers/LegacyCase.trigger`]: "trigger LegacyCase on Case (after update) { }",
    [`${B}/objects/Case/validationRules/Need_Reason.validationRule-meta.xml`]: "<ValidationRule><active>true</active></ValidationRule>",
    [`${B}/objects/Case/validationRules/Old.validationRule-meta.xml`]: "<ValidationRule><active>false</active></ValidationRule>",
    [`${B}/workflows/Case.workflow-meta.xml`]: "<Workflow><rules><fullName>Notify_Owner</fullName></rules></Workflow>",
    [`${B}/sharingRules/Case.sharingRules-meta.xml`]: "<SharingRules><sharingCriteriaRules><fullName>Support_Sees_All</fullName></sharingCriteriaRules></SharingRules>",
    [`${B}/duplicateRules/Case.Same_Subject.duplicateRule-meta.xml`]: "<DuplicateRule/>",
    [`${B}/layouts/Case-Case %28Support%29 Layout.layout-meta.xml`]: "<Layout/>",
    [`${B}/flows/Nightly_Close.flow-meta.xml`]: "<Flow><start><triggerType>Scheduled</triggerType></start><recordUpdates><object>Case</object></recordUpdates><status>Active</status></Flow>",
    [`${B}/objects/Visit__c/fields/When__c.field-meta.xml`]: "",
  });
  const files = r.files.filter((p) => p.startsWith(O)), production = r.files.filter((p) => p.startsWith(B));
  const md = pack.pack({ files, production, read: r.read, objects: ["Case"] });
  for (const want of ["**(production)** are production's own", "Triggers: LegacyCase (production)", "Apex that names it: CaseHandler (with sharing)",
    "Validation rules: Need_Reason (production), Old (inactive) (production)", "Workflow rules: Notify_Owner (production)", "Sharing rules: Support_Sees_All (production)",
    "Duplicate rules: Same_Subject (production)", "Page layouts: Case (Support) Layout (production)", "Other Flows that read or write it: Nightly_Close (production)"]) assert.ok(md.includes(want), want);
  // a production custom object is recognised in a story's words; kinds nothing has are left out, the core ones say none
  assert.deepEqual(pack.objectsFor({ text: "Log a visit", files: [...files, ...production] }), ["Visit__c"]);
  // a lookup named after an object does not bring every object that has one
  assert.deepEqual(pack.objectsFor({ text: "Update the Account", files: [...files, `${O}/objects/Visit__c/fields/Account__c.field-meta.xml`] }), ["Account"]);
  const bare = pack.pack({ files, read: r.read, objects: ["Case"] });
  assert.ok(!bare.includes("(production)") && !bare.includes("Sharing rules") && bare.includes("Validation rules: none"));
});

test("vendored libraries (force-app/vendor/): the access check and the context pack skip them; Code Analyzer, Prettier and the review are told to", () => {
  const V = "force-app/vendor/fflib-apex-common/classes";
  const r = repo({ [`${V}/fflib_SObjects.cls`]: "public virtual class fflib_SObjects { Case c; }", [`${O}/classes/Plain.cls`]: "public class Plain {\n}" });
  assert.deepEqual(access.findings({ ...r, changed: r.files }).map((x) => `${x.rule} ${x.file.split("/").pop()}`), ["sharing-keyword Plain.cls"], "only our code is checked");
  assert.ok(names.isVendored(`${V}/fflib_SObjects.cls`) && !names.isVendored(`${O}/classes/Plain.cls`));
  const io = { sourceFiles: ({ dirs } = {}) => (dirs ? { files: [] } : { files: r.files, read: r.read, changed: [] }), sf: () => null, git: () => "" };
  assert.doesNotMatch(pack.packForCheckout(io, { text: "Escalate the Case" }), /fflib/, "a library's classes are not the codebase to extend");
  const cfg = (f) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
  assert.match(cfg("code-analyzer.yml"), /ignores:\s*\n\s*files:\s*\n\s*- "vendor\/\*\*"/, "relative to the workspace: force-app/vendor only");
  assert.match(cfg(".prettierignore"), /^force-app\/vendor\/$/m);
  assert.match(cfg(".github/workflows/ai-review.yml"), /git diff "\$RANGE" -- \. ':\(exclude\)force-app\/vendor'/);
  assert.doesNotMatch(cfg(".github/workflows/ai-review.yml"), /gh pr diff/, "GitHub refuses diffs over 20,000 lines (#353)");
  assert.ok(names.touchesPipeline([".prettierignore"]).length, "what the checks skip is a pipeline decision");
  assert.match(verdict.instructions("spec"), /Needs a pipeline change first:/);
  assert.match(verdict.instructions("plan"), /force-app\/vendor\//);
  // the agents vendor through the script (they may not copy files), and the script refuses anything but a pinned commit
  for (const wf of ["ai-implement", "ai-fix"]) assert.match(cfg(`.github/workflows/${wf}.yml`), /Bash\(scripts\/vendor\.sh:\*\)/, wf);
  const { spawnSync } = createRequire(import.meta.url)("node:child_process");
  const run = (...a) => spawnSync(new URL("../../scripts/vendor.sh", import.meta.url).pathname, a, { encoding: "utf8" });
  assert.match(run("fflib", "https://github.com/o/r", "master", "why", "src").stderr, /a commit SHA \(pin it; never a branch\)/);
  assert.match(run("fflib", "https://evil.example/o/r", "abcdef1", "why", "src").stderr, /https:\/\/github\.com\/owner\/repo/);
  assert.match(run("fflib", "https://github.com/o/r", "abcdef1", "why", "../etc").stderr, /folder: a path inside the repository/, "checked before anything is fetched");
  for (const role of ["implement", "fix", "review"]) assert.match(verdict.instructions(role, { key: "7" }), /Never edit pipeline files \(.*code-analyzer\.yml.*\): CI refuses/, `${role}: every pipeline path`);
  for (const role of ["spec", "plan"]) assert.match(verdict.instructions(role), /answered is no longer open: record its answer under Decisions \(a plan: in the Proposed build\) and remove it/, `${role}: answered questions leave Open questions`);
});

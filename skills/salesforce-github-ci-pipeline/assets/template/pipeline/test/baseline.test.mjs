// Pipeline tests: baseline (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
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

test("baseline: all of production, minus the managed, the platform's own and exclusions; sanitized; force-app owns what it holds", async () => {
  const config = JSON.parse(readFileSync(new URL("../../config/baseline.json", import.meta.url), "utf8"));
  const m = (fullName, extra = {}) => ({ fullName, manageableState: "unmanaged", lastModifiedByName: "Alex Admin", lastModifiedDate: "2026-10-01T00:00:00Z", ...extra });
  const manifest = baselineMod.manifestFor({
    CustomObject: [m("Timesheet__c"), m("Account"), m("pkg__Thing__c", { namespacePrefix: "pkg" })],
    CustomField: [m("Account.SLA__c"), m("Incident.Old__c", { lastModifiedDate: "2026-09-20T00:30:00Z" }), m("Timesheet__c.Hours__c", { lastModifiedDate: "2026-09-20T00:30:00Z" })],
    Layout: [m("Account-Account Layout"), m("Case-Case Layout", { lastModifiedByName: "Salesforce, Inc." })],
    ReportType: [m("Program_sfdcSESv60", { lastModifiedByName: "Salesforce, Inc." }), m("Opps_with_Accounts")],
    PermissionSet: [m("Lifecycle_CI"), m("Timesheet_User")],
    Flow: [m("sfdc_default_ReportExport_Protection_Flow"), m("Weather_Check")],
  }, { config, orgCreated: "2026-09-20T00:00:00Z" });
  assert.deepEqual(manifest, {
    // a custom field on a standard object is copied whatever its date (13 Oct: production's rules name Account.SLA__c);
    // one a scratch org cannot hold is left out of the deploy by the partial retry, never the whole baseline
    CustomObject: ["Timesheet__c"], CustomField: ["Account.SLA__c", "Incident.Old__c", "Timesheet__c.Hours__c"], Layout: ["Account-Account Layout"],
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
  // a vendored library keeps its own layout, and production merges every custom label into one file (release v2026.10.25-26)
  const lab = (...ns) => `<CustomLabels>${ns.map((n) => `\n    <labels>\n        <fullName>${n}</fullName>\n    </labels>`).join("")}\n</CustomLabels>`;
  for (const [f, body] of [["v/main/default/classes/fflib_Answer.cls", "x"], ["v/main/default/classes/Mine.cls", "x"], ["v/main/default/labels/CustomLabels.labels-meta.xml", lab("fflib_a", "Mine")],
    ["v/main/default/labels/Other.labels-meta.xml", lab("fflib_b")], ["vfa/vendor/fflib-apex-mocks/main/classes/fflib_Answer.cls", "x"], ["vfa/vendor/fflib-apex-common/main/labels/fflib-CustomLabels.labels-meta.xml", lab("fflib_a", "fflib_b")]]) {
    mkdirSync(join(t, f, ".."), { recursive: true }); writeFileSync(join(t, f), body);
  }
  assert.deepEqual(baselineMod.subtractOwned(join(t, "v"), join(t, "vfa")).sort(), ["main/default/classes/fflib_Answer.cls", "main/default/labels/Other.labels-meta.xml"], "vendored classes and all-vendored label files go");
  assert.ok(existsSync(join(t, "v/main/default/classes/Mine.cls")), "a class force-app does not hold stays");
  const left = readFileSync(join(t, "v/main/default/labels/CustomLabels.labels-meta.xml"), "utf8");
  assert.match(left, /<fullName>Mine</); assert.doesNotMatch(left, /fflib_a/, "a vendored label leaves the merged file; production's own stay");
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
  assert.match(baselineMod.driftSummary(["?? baseline/main/default/objects/Account/fields/SLA__c.field-meta.xml"], { CustomField: [m("Account.SLA__c")] }), /\| added \| `objects\/Account\/fields\/SLA__c` \| Alex Admin, 2026-10-01 \|/);
});

test("prod-baseline checks out main before the identity action re-clones it (a .pipeline checkout first was wiped)", () => {
  const wf = readFileSync(new URL("../../.github/workflows/prod-baseline.yml", import.meta.url), "utf8");
  assert.match(wf, /uses: actions\/checkout@v4\n\s+with: \{ ref: main \}[^\n]*\n\s+- id: id\n\s+uses: \.\/\.github\/actions\/pipeline-identity/);
  assert.doesNotMatch(wf, /\.pipeline\//);
});

test("the baseline drops empty shells, and keeps members production lists with a 1970 date (drift PR #192: I6, I20)", async () => {
  const { isEmptyMetadata, manifestFor } = await import("../src/baseline.mjs");
  const x = '<?xml version="1.0" encoding="UTF-8"?>\n';
  assert.ok(isEmptyMetadata("objects/Lead/Lead.object-meta.xml", `${x}<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"></CustomObject>`));
  assert.ok(isEmptyMetadata("matchingRules/ContactPointEmail.matchingRule-meta.xml", `${x}<MatchingRules xmlns="http://soap.sforce.com/2006/04/metadata"/>\n`));
  assert.ok(!isEmptyMetadata("objects/Lead/Lead.object-meta.xml", `${x}<CustomObject xmlns="x"><enableHistory>true</enableHistory></CustomObject>`));
  assert.ok(!isEmptyMetadata("objects/A__c/A__c.object-meta.xml", `${x}<CustomObject xmlns="x">\n  <label>A</label>\n</CustomObject>`));
  // a 1970-01-01 date is how production lists custom metadata records, assignment rules and workflows (13 Oct): it is not
  // "never modified", so it keeps them (the empty shells above are what drop ContactPointEmail's matching rules)
  const m = manifestFor({ AssignmentRules: [{ fullName: "Case", lastModifiedByName: "Alex Admin", lastModifiedDate: "1970-01-01T00:00:00.000Z" }], CustomMetadata: [{ fullName: "Claude_Setting.Default", lastModifiedByName: "Alex Admin", lastModifiedDate: "1970-01-01T00:00:00.000Z" }] }, { config: {}, orgCreated: "2026-01-01" });
  assert.deepEqual(m, { AssignmentRules: ["Case"], CustomMetadata: ["Claude_Setting.Default"] });
});

test("a custom field on a standard object is copied whatever its date: production's rules name Account.SLA__c (13 Oct snapshot)", async () => {
  const { manifestFor } = await import("../src/baseline.mjs");
  const m = manifestFor({ CustomField: [{ fullName: "Account.SLA__c", lastModifiedByName: "Alex Admin", lastModifiedDate: "2026-01-01T00:10:00.000Z" },
    { fullName: "Account.Industry", lastModifiedByName: "Alex Admin", lastModifiedDate: "2026-01-01T00:10:00.000Z" }] }, { config: {}, orgCreated: "2026-01-01T00:00:00Z" });
  assert.deepEqual(m, { CustomField: ["Account.SLA__c"] }, "a standard field unchanged since the org was made still stays out");
});

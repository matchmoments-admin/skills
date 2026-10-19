// The engine's pure parts. Run: node --test tests/  (from the skill's folder). No org, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as baselineMod from "../scripts/engine/baseline.mjs";
import { storyOf, orgFor, descriptionFor, isPipelineOrg } from "../scripts/engine/conventions.mjs";
import { findOrphans, capacityProblem, readyMarker, sameSourceGit, failedBaselineFiles } from "../scripts/engine/org.mjs";
import { sourceDirs, sfFailure } from "../scripts/engine/io.mjs";
import { permissionSets } from "../scripts/engine/org/users.mjs";

const config = JSON.parse(readFileSync(new URL("../assets/config/baseline.json", import.meta.url), "utf8"));
const tmp = () => mkdtempSync(join(tmpdir(), "sfo-"));
const put = (root, files) => { for (const [f, body] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), body); } };

test("any branch gets one org: its Jira key when it has one, else a slug; long names keep a hash", () => {
  assert.equal(storyOf("feature/LIFE-123-tidy-accounts"), "LIFE-123");
  assert.equal(storyOf("origin/LIFE-123"), "LIFE-123");
  assert.equal(storyOf("Tidy up_accounts"), "tidy-up-accounts");
  assert.equal(storyOf(""), null);
  const o = orgFor("bugfix/ABC-9-x", { env: {} });
  assert.deepEqual([o.kind, o.key, o.alias, o.description, o.definition, o.days], ["story", "ABC-9", "feat-ABC-9", "feat-ABC-9", "config/scratch-feature.json", 7]);
  assert.equal(orgFor("x", { env: { ORG_PREFIX: "dev-", ORG_DAYS: "99", SCRATCH_DEF: "config/a.json" } }).description, "dev-x");
  assert.equal(orgFor("x", { env: { ORG_DAYS: "99" } }).days, 30, "Salesforce's maximum");
  const long = descriptionFor("a".repeat(120)), other = descriptionFor("a".repeat(119) + "b");
  assert.ok(long.length <= 80 && other.length <= 80);
  assert.notEqual(long, other, "two long branches never share an org");
  assert.ok(isPipelineOrg("feat-ABC-9") && isPipelineOrg("ci-build-1") && !isPipelineOrg("someone-elses-org"));
});

test("orphans: a feature org whose branch is gone, an old CI org; an unknown branch list deletes no feature org", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const recs = [
    { SignupUsername: "a", Description: "feat-ABC-1", CreatedDate: "2026-10-18T00:00:00Z" },
    { SignupUsername: "b", Description: "feat-ABC-2", CreatedDate: "2026-10-18T00:00:00Z" },
    { SignupUsername: "c", Description: "ci-77", CreatedDate: "2026-10-19T08:00:00Z" },
    { SignupUsername: "d", Description: "not ours", CreatedDate: "2026-01-01T00:00:00Z" },
  ];
  assert.deepEqual(findOrphans(recs, { now, openBranches: ["feature/ABC-1-x", "main"] }).map((o) => o.description), ["feat-ABC-2", "ci-77"]);
  assert.deepEqual(findOrphans(recs, { now }).map((o) => o.description), ["ci-77"], "no branch list: feature orgs are kept");
});

test("capacity names who holds the slots; the failure table sorts Salesforce's messages", () => {
  assert.match(capacityProblem({ active: { remaining: 0, max: 3 }, daily: { remaining: 2 } }, ["feat-ABC-1", "other"]), /feat-ABC-1, other \(not this pipeline\)/);
  assert.match(capacityProblem({ active: { remaining: 2 }, daily: { remaining: 0, max: 6 } }), /resets at 00:00 UTC/);
  assert.equal(capacityProblem({ active: { remaining: 2 }, daily: { remaining: 4 } }), null);
  assert.equal(sfFailure("LICENSE_LIMIT_EXCEEDED: no more"), "licence");
  assert.equal(sfFailure("JwtAuthError: invalid_grant"), "transient");
  assert.equal(sfFailure("the org shape is outdated"), "shape");
});

test("the ready marker names the commit, the baseline and the seed; sameSource reads git", () => {
  assert.equal(readyMarker("0123456789abcdef", "b1", "s2"), "pipeline: ready 0123456789ab bb1 ss2");
  const git = (fake) => (args) => fake[args[0]] ?? null;
  assert.equal(sameSourceGit(git({ "merge-base": "", diff: "" }), ["src"])("a", "b"), true, "descends, nothing deployable changed");
  assert.equal(sameSourceGit(git({ "merge-base": "", diff: "src/classes/A.cls\n" }), ["src"])("a", "b"), false);
  assert.equal(sameSourceGit(git({ diff: "" }), ["src"])("a", "b"), false, "not an ancestor (or a shallow clone): redeploy");
});

test("baseline: production minus the managed, the platform's own and exclusions; sanitized", () => {
  const m = (fullName, extra = {}) => ({ fullName, manageableState: "unmanaged", lastModifiedByName: "Alex Admin", lastModifiedDate: "2026-10-01T00:00:00Z", ...extra });
  const manifest = baselineMod.manifestFor({
    CustomObject: [m("Timesheet__c"), m("Account"), m("pkg__Thing__c", { namespacePrefix: "pkg" })],
    CustomField: [m("Account.SLA__c"), m("Timesheet__c.Hours__c", { lastModifiedDate: "2026-09-20T00:30:00Z" })],
    Layout: [m("Account-Account Layout"), m("Case-Case Layout", { lastModifiedByName: "Salesforce, Inc." })],
    PermissionSet: [m("Pipeline_CI"), m("Timesheet_User")],
    Flow: [m("sfdc_default_ReportExport_Protection_Flow"), m("Weather_Check")],
  }, { config, orgCreated: "2026-09-20T00:00:00Z" });
  assert.deepEqual(manifest, { CustomObject: ["Timesheet__c"], CustomField: ["Account.SLA__c", "Timesheet__c.Hours__c"], Layout: ["Account-Account Layout"], PermissionSet: ["Timesheet_User"], Flow: ["Weather_Check"] });
  const dash = baselineMod.sanitize("x.dashboard-meta.xml", "<Dashboard><dashboardType>SpecifiedUser</dashboardType>\n<runningUser>admin@prod.com</runningUser></Dashboard>");
  assert.doesNotMatch(dash, /admin@prod/);
  assert.match(baselineMod.sanitize("Case.workflow-meta.xml", "<integrationUser>svc@prod</integrationUser>"), /__SCRATCH_ADMIN__/);
  assert.throws(() => baselineMod.sanitize("n.namedCredential-meta.xml", "<password>hunter2</password>"), /holds a secret/);
});

test("one owner, whatever the folder layout: a source file's metadata identity removes it from the baseline", () => {
  assert.equal(baselineMod.ownedKey("main/default/classes/A.cls"), "classes/A.cls");
  assert.equal(baselineMod.ownedKey("src/sales/classes/A.cls"), "classes/A.cls");
  assert.equal(baselineMod.ownedKey("README.md"), null);
  const t = tmp();
  put(t, {
    "baseline/main/default/objects/Account/fields/SLA__c.field-meta.xml": "x",
    "baseline/main/default/objects/Account/fields/Tier__c.field-meta.xml": "x",
    "baseline/main/default/classes/Svc.cls": "x",
    "sales/objects/Account/fields/Tier__c.field-meta.xml": "x",          // a flat layout
    "service/main/default/classes/Svc.cls": "x",                       // the DX layout, a second package directory
  });
  assert.deepEqual(baselineMod.subtractOwned(join(t, "baseline"), [join(t, "sales"), join(t, "service")]).sort(),
    ["main/default/classes/Svc.cls", "main/default/objects/Account/fields/Tier__c.field-meta.xml"]);
  assert.ok(existsSync(join(t, "baseline/main/default/objects/Account/fields/SLA__c.field-meta.xml")));
});

test("one deploy of baseline/ and every source folder; a failed baseline file is left out of the retry, a failed source file never", () => {
  const t = tmp();
  put(t, { "b/main/default/classes/Old.cls": "x", "b/main/default/classes/Old.cls-meta.xml": "x", "sales/classes/A.cls": "x", "service/classes/B.cls": "x", ".forceignore": "**/jsconfig.json\n" });
  const dir = baselineMod.composeProject({ baselineDir: join(t, "b"), sourceDirs: ["sales", "service"], cwd: t, forceignore: join(t, ".forceignore") });
  const proj = JSON.parse(readFileSync(join(dir, "sfdx-project.json"), "utf8"));
  assert.deepEqual(proj.packageDirectories, [{ path: "baseline" }, { path: "sales", default: true }, { path: "service" }]);
  assert.ok(existsSync(join(dir, "service/classes/B.cls")) && existsSync(join(dir, ".forceignore")));
  assert.deepEqual(failedBaselineFiles({ files: [{ state: "Failed", filePath: "sales/classes/A.cls" }] }, dir), [], "the branch's own failure: no retry");
  const dropped = failedBaselineFiles({ files: [{ state: "Failed", filePath: `${dir}/baseline/main/default/classes/Old.cls` }] }, dir);
  assert.deepEqual(dropped.sort(), ["baseline/main/default/classes/Old.cls", "baseline/main/default/classes/Old.cls-meta.xml"]);
});

test("source folders come from sfdx-project.json (never baseline/), else force-app; permission sets from all of them", () => {
  const t = tmp();
  put(t, { "sfdx-project.json": JSON.stringify({ packageDirectories: [{ path: "sales/" }, { path: "baseline" }, { path: "missing" }] }), "sales/permissionsets/Sales_User.permissionset-meta.xml": "x", "x/permissionsets/Other.permissionset-meta.xml": "x" });
  mkdirSync(join(t, "baseline"));
  assert.deepEqual(sourceDirs({}, t), ["sales"]);
  assert.deepEqual(sourceDirs({ SOURCE_DIRS: "a b" }, t), ["a", "b"]);
  assert.deepEqual(sourceDirs({}, tmp()), ["force-app"]);
  assert.deepEqual(permissionSets([join(t, "sales"), join(t, "x")]), ["Other", "Sales_User"]);
});

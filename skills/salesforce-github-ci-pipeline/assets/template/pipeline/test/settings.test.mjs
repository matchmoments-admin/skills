// Pipeline tests: settings (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
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

test("settings are declared once: every name the code and the workflows read is declared, and documented in the handbook", () => {
  const declared = new Set(settings.SETTINGS.map(([n]) => n));
  const src = [...readdirSync(new URL("../src/", import.meta.url)).filter((f) => f.endsWith(".mjs")).map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")), pipeSources()].join("\n");
  const read = new Set([...src.matchAll(/setting\("([A-Z_]+)"/g)].map((m) => m[1]));
  const wfDir = new URL("../../.github/workflows/", import.meta.url);
  const yml = readdirSync(wfDir).map((f) => readFileSync(new URL(f, wfDir), "utf8")).join("\n");
  for (const m of yml.matchAll(/vars\.([A-Z_]+)/g)) read.add(m[1]);
  for (const n of read) assert.ok(declared.has(n), `${n} is read but not declared in settings.mjs`);
  const handbook = readFileSync(new URL("../../docs/handbook.md", import.meta.url), "utf8");
  for (const n of declared) assert.match(handbook, new RegExp(`^\\| \`${n}\``, "m"), `${n} has a row in the handbook's settings table`);
  // org provisioning gets every setting it reads, resolved: SEED=off as a repository variable once never reached it
  assert.equal(settings.orgSettings({ PIPELINE_VARS: JSON.stringify({ SEED: "off" }) }).SEED, "off");
  assert.deepEqual(settings.orgSettings({}), { SCRATCH_SNAPSHOT: "", BASELINE: "soft", SEED: "on", VOLUME_RECORDS: "5000", ORG_RESERVE: "0", ORG_POOL: "0" });
  assert.match(pipeSources(), /\.\.\.orgSettings\(\)/, "orgRegistry's env carries them");
});

test("tests never use CI's Jira login or the repository's tracker settings (npm run test:pipeline scrubs them)", () => {
  assert.equal(process.env.JIRA_EMAIL, undefined);
  assert.equal(process.env.JIRA_API_TOKEN, undefined);
  const vars = JSON.parse(process.env.PIPELINE_VARS || "{}");
  assert.equal(vars.TRACKER, undefined, "the repository's TRACKER never reaches a test (TRACKER=jira in the env is a deliberate run)");
  assert.equal(vars.JIRA_BASE_URL, undefined);
  assert.match(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).scripts["test:pipeline"], /--import \.\/pipeline\/test\/env\.mjs/);
});

test("capacity: stories in flight from the Dev Hub's allowance, the staging regression's time, and a month's cost", () => {
  const dev = capacity.plan({ devhub: { activeMax: 3, dailyMax: 6, activeUsed: 1 }, team: { devs: 2 }, ui: { tests: 38 } });
  assert.equal(dev.orgs.inFlightMaxBetween, 1, "between releases, 3 active orgs: staging, one held elsewhere, one story");
  assert.equal(dev.orgs.inFlightMax, 0, "while a release is in UAT its stand-in holds the third slot");
  assert.match(dev.advice.join(" "), /with staging and 1 held outside the pipeline that is 1 story in flight between releases, 0 while a release is in UAT \(its scratch stand-in takes a slot\), not 2\. Move the Dev Hub to an Enterprise or Unlimited org/);
  // 30 Oct (#418, #426): staging and UAT's stand-in were both live on a 3-slot Dev Hub, so one story fitted, not two
  const overlap = capacity.plan({ devhub: { activeMax: 3, dailyMax: 6 }, team: { devs: 2 } });
  assert.equal(overlap.orgs.inFlightMax, 1);
  assert.equal(overlap.orgs.inFlightMaxBetween, 2);
  assert.equal(overlap.orgs.activeNeeded, 4, "staging, UAT's stand-in and two stories");
  assert.match(capacity.report(overlap), /2 wanted, 1 possible while a release is in UAT \(2 between releases\)/);
  // the team fits between releases: no bigger Dev Hub, only the UAT stand-in's slot and how to free it
  const fits = overlap.advice.join(" ");
  assert.doesNotMatch(fits, /Enterprise or Unlimited/);
  assert.match(fits, /While a release is in UAT its scratch stand-in takes a slot: 1 of the 2 stories waits \(waiting:org\)\. UAT on a sandbox \(SF_UAT_USERNAME\) frees it\./);
  // a UAT sandbox: no stand-in, so nothing is said about UAT
  const sandboxed = capacity.plan({ devhub: { activeMax: 3, dailyMax: 6 }, team: { devs: 3 }, uatSandbox: true });
  assert.equal(sandboxed.orgs.inFlightMax, 2);
  assert.doesNotMatch(sandboxed.advice.join(" ") + capacity.report(sandboxed), /while a release is in UAT|stand-in/);
  assert.match(sandboxed.advice.join(" "), /with staging that is 2 stories in flight, not 3\. Move the Dev Hub/);
  assert.match(capacity.report(sandboxed), /3 wanted, 2 possible \(3 active/);
  // the new orgs a day count UAT's stand-in only when it is a scratch org
  assert.equal(capacity.plan({ team: { devs: 1, sprintDays: 2 } }).orgs.dailyNeeded, 2, "a story every 2 days, staging and UAT's stand-in per 2-day sprint");
  assert.equal(capacity.plan({ team: { devs: 1, sprintDays: 2 }, uatSandbox: true }).orgs.dailyNeeded, 1, "no stand-in with a UAT sandbox");
  // --in-use is what other projects hold, never the pipeline's own staging or UAT (those are counted already)
  assert.match(readFileSync(new URL("../bin/pipe.mjs", import.meta.url), "utf8"), /--in-use N \(active orgs other projects hold; not this pipeline's staging, UAT or story orgs\)/);
  assert.equal(dev.ui.minutes, 22.2, "38 tests at 35 s, one browser");
  assert.match(dev.advice.join(" "), /grows about 1\.5 min with every story/);
  const ent = capacity.plan({ devhub: { activeMax: 40, dailyMax: 80 }, team: { devs: 10, storiesPerSprint: 30 }, ui: { tests: 20 }, uatSandbox: true });
  assert.equal(ent.orgs.inFlightMax, 39);
  assert.equal(ent.orgs.atRelease, 1, "a UAT sandbox takes no scratch org");
  assert.deepEqual(ent.advice, ["The defaults carry this load."]);
  assert.ok(ent.cost.monthlyMinutes > dev.cost.monthlyMinutes);
  assert.match(capacity.report(dev), /## Pipeline capacity[\s\S]*once per release/);
  const every = capacity.plan({ devhub: { activeMax: 3 }, team: { devs: 2, storiesPerSprint: 5 }, ui: { tests: 38 }, uiPolicy: "every" });
  assert.ok(every.cost.monthlyMinutes > capacity.plan({ devhub: { activeMax: 3 }, team: { devs: 2, storiesPerSprint: 5 }, ui: { tests: 38 } }).cost.monthlyMinutes);
  assert.match(every.advice.join(" "), /saves about 89 min a sprint/);
  assert.deepEqual(capacity.countSpecs("e2e-missing"), { tests: 0 });
});

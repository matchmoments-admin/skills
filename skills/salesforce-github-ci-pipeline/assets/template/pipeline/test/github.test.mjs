// Pipeline tests: github (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
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
import { jiraTracker, githubTracker, adfToText, tracker as makeTracker } from "../src/tracker.mjs";
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


test("Jira adapter: reads a story, comments and transitions to Done (mocked REST)", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(`${init.method} ${url.replace("https://acme.atlassian.net", "")}`);
    const json = (b) => ({ ok: true, status: 200, json: async () => b });
    if (url.endsWith("/transitions") && init.method === "GET")
      return json({ transitions: [{ id: "11", name: "In Progress", to: { statusCategory: { key: "indeterminate" } } }, { id: "31", name: "Done", to: { statusCategory: { key: "done" } } }] });
    if (url.includes("/issue/LIFE-123?"))
      return json({ key: "LIFE-123", fields: { summary: "Tier field", status: { statusCategory: { key: "new" } }, labels: ["feature"],
        description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Acceptance criteria" }] }, { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Gold needs Industry" }] }] }] }] } } });
    return { ok: true, status: 204, json: async () => null };
  };
  const t = jiraTracker({ fetch, base: "https://acme.atlassian.net", email: "ci@acme.test", token: "t" });
  const s = await t.story("LIFE-123");
  assert.equal(s.title, "Tier field");
  assert.equal(s.state, "OPEN");
  assert.match(s.body, /Acceptance criteria[\s\S]*- Gold needs Industry/);
  await t.done("LIFE-123", "Shipped");
  assert.deepEqual(calls.slice(1), ["POST /rest/api/3/issue/LIFE-123/comment", "GET /rest/api/3/issue/LIFE-123/transitions", "POST /rest/api/3/issue/LIFE-123/transitions"]);
  assert.throws(() => jiraTracker({ fetch, base: "", email: "", token: "" }), /JIRA_BASE_URL/);
});

test("TRACKER=jira from the repository's settings: JIRA_BASE_URL rides in PIPELINE_VARS, the login comes from the workflow's secrets", async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push(`${init.method} ${url}`); return { ok: true, status: 200, json: async () => ({ key: "LIFE-7", fields: { summary: "Tier", status: { statusCategory: { key: "new" } }, labels: [] } }) }; };
  const vars = JSON.stringify({ TRACKER: "jira", JIRA_BASE_URL: "https://acme.atlassian.net/" });
  const t = makeTracker({ fetch }, { PIPELINE_VARS: vars, JIRA_EMAIL: "ci@acme.test", JIRA_API_TOKEN: "t" });
  assert.equal(t.name, "jira");
  assert.equal((await t.story("LIFE-7")).url, "https://acme.atlassian.net/browse/LIFE-7");
  assert.deepEqual(calls, ["GET https://acme.atlassian.net/rest/api/3/issue/LIFE-7?fields=summary,description,status,labels"]);
  // the secrets missing (a workflow that never got them): the error says which and where they go
  assert.throws(() => makeTracker({ fetch }, { PIPELINE_VARS: vars }), /JIRA_EMAIL and JIRA_API_TOKEN.*secrets/);
  assert.throws(() => makeTracker({ fetch }, { PIPELINE_VARS: JSON.stringify({ TRACKER: "jira" }), JIRA_EMAIL: "e", JIRA_API_TOKEN: "t" }), /JIRA_BASE_URL.*variable/);
  assert.equal(makeTracker({ gh: () => null }, {}).name, "github", "unset: GitHub Issues, no Jira login needed");
});

const jiraSetup = new URL("../../.claude/skills/salesforce-github-ci-pipeline/scripts/jira-setup.sh", import.meta.url).pathname;
test("the skill's jira-setup.sh checks the login, the project and its statuses, sets nothing, and prints the commands (a fake curl)", { skip: !existsSync(new URL("../../.claude/skills/salesforce-github-ci-pipeline/", import.meta.url)) && "the pipeline skill is not vendored here" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync: read } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const script = jiraSetup;
  const bin = mkdtempSync(`${tmpdir()}/jira-setup-`);
  // the fake curl answers from FAKE_JIRA ({path: [code, body]}), writes -o's file, prints -w's code, logs each call
  writeFileSync(`${bin}/curl`, `#!/usr/bin/env node
const a = process.argv.slice(2), fs = require("fs"), r = JSON.parse(process.env.FAKE_JIRA);
const url = a.find((x) => /^https?:/.test(x)), path = url.replace(/^https?:\\/\\/[^/]+/, "");
fs.appendFileSync(process.env.FAKE_LOG, (a.includes("-u") ? "auth " : "") + path + "\\n");
const [code, body] = r[path] || [404, {}];
if (a.includes("-o")) fs.writeFileSync(a[a.indexOf("-o") + 1], JSON.stringify(body));
if (a.includes("-w")) process.stdout.write(String(code));
`);
  chmodSync(`${bin}/curl`, 0o755);
  const statuses = (names) => [{ name: "Story", statuses: names.map((n) => ({ name: n, statusCategory: { key: n === "Done" ? "done" : "indeterminate" } })) }];
  const ok = { "/rest/api/3/myself": [200, { emailAddress: "ci@acme.test" }], "/rest/api/3/project/LIFE": [200, { key: "LIFE", name: "Lifecycle" }],
    "/rest/api/3/project/LIFE/statuses": [200, statuses(["To Do", "In Progress", "AI Build", "Done"])] };
  const run = (fake, extra = {}) => spawnSync("bash", [script, "acme/app", "https://acme.atlassian.net", "LIFE"], { encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_JIRA: JSON.stringify(fake), FAKE_LOG: `${bin}/log`, JIRA_EMAIL: "ci@acme.test", JIRA_API_TOKEN: "s3cret-token", ...extra } });
  const good = run(ok);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /gh variable set TRACKER -R acme\/app --body jira/);
  assert.match(good.stdout, /gh variable set JIRA_BASE_URL -R acme\/app --body https:\/\/acme\.atlassian\.net/);
  assert.match(good.stdout, /gh secret set JIRA_EMAIL -R acme\/app/);
  assert.match(good.stdout, /gh secret set JIRA_API_TOKEN -R acme\/app/);
  assert.match(good.stdout, /POST https:\/\/api\.github\.com\/repos\/acme\/app\/dispatches/);
  for (const t of ["jira-start", "jira-implement", "jira-sprint-start", "jira-release-cut"]) assert.match(good.stdout, new RegExp(`"event_type":"${t}"`), t);
  assert.doesNotMatch(good.stdout + good.stderr, /s3cret-token/, "the token is never printed");
  assert.ok(read(`${bin}/log`, "utf8").split("\n").filter(Boolean).every((l) => l.startsWith("auth ")), "every call logs in");
  // a refused login, a missing project, a workflow without "In Progress": each fails and says what to fix
  const bad = run({ ...ok, "/rest/api/3/myself": [401, {}] });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /login refused/i);
  const noProject = run({ ...ok, "/rest/api/3/project/LIFE": [404, {}] });
  assert.notEqual(noProject.status, 0);
  assert.match(noProject.stdout + noProject.stderr, /project LIFE/);
  const noStart = run({ ...ok, "/rest/api/3/project/LIFE/statuses": [200, statuses(["To Do", "Done"])] });
  assert.notEqual(noStart.status, 0);
  assert.match(noStart.stdout + noStart.stderr, /In Progress/);
  assert.match(noStart.stdout + noStart.stderr, /AI Build.*only with AI_IMPLEMENT/);
  const noLogin = run(ok, { JIRA_API_TOKEN: "" });
  assert.notEqual(noLogin.status, 0);
  assert.match(noLogin.stdout + noLogin.stderr, /JIRA_EMAIL and JIRA_API_TOKEN/);
});

test("GitHub adapter: carry over removes the milestone; sprint stories map to keys", async () => {
  const calls = [];
  const gh = (args) => { calls.push(args.join(" ")); return args[1] === "list" ? [{ number: 2, title: "Urgent", state: "OPEN" }] : null; };
  const t = githubTracker({ gh, repo: "o/r" });
  await t.carry("2", "w41", "carried");
  assert.deepEqual(calls, ["issue comment 2 --body carried", "issue edit 2 --remove-milestone --remove-label in-sprint"]);
  assert.deepEqual(await t.sprintStories("w41"), [{ key: "2", title: "Urgent", state: "OPEN" }]);
  assert.equal(adfToText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }] }] }).trim(), "a\nb");
});

test("gh output: JSON is parsed, plain text (a comment URL) is returned as text", async () => {
  const { parseJson } = await import("../src/io.mjs");
  assert.deepEqual(parseJson("warning line\n{\"a\":1}"), { a: 1 });
  assert.throws(() => parseJson("https://github.com/o/r/issues/2#issuecomment-1"), /no JSON/);
});

test("board: stage follows the story; moving a card adds it and sets Status", async () => {
  assert.equal(board.stageOf({}), "Building");
  assert.equal(board.stageOf({ pr: { state: "OPEN" } }), "In review");
  assert.equal(board.stageOf({ pr: { state: "OPEN" }, approved: true }), "Approved");
  assert.equal(board.stageOf({ pr: { state: "MERGED", baseRefName: "release/w" } }), "In staging");
  assert.equal(board.stageOf({ pr: { state: "MERGED", baseRefName: "main" } }), "Live");
  assert.equal(board.stageOf({ pr: { state: "MERGED", baseRefName: "release/w" }, shipped: true }), "Live");
  const calls = [];
  const graphql = async (q, v) => {
    calls.push(v);
    if (q.includes("organization")) return { organization: { projectV2: { id: "P", field: { id: "F", options: board.STAGES.map((n, i) => ({ id: `o${i}`, name: n })) } } } };
    if (q.includes("addProjectV2ItemById")) return { addProjectV2ItemById: { item: { id: "I" } } };
    return {};
  };
  assert.deepEqual(await board.moveCard({ graphql, org: "o", project: "3", issueNodeId: "N", stage: "In staging" }), { item: "I", stage: "In staging" });
  assert.deepEqual(calls[2], { p: "P", i: "I", f: "F", o: "o4" });
});

test("code host: one call per fact per process, errors as a status, verdicts linked to the run", () => {
  const { io, calls } = fakeGitHub();
  const h = codeHost({ io, env: { GH_REPO: "o/r", GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "5" } });
  assert.equal(h.runUrl, "https://github.com/o/r/actions/runs/5");
  assert.equal(h.openRelease(), "release/w45");
  h.openRelease(); h.storyPr("issue-84"); h.storyPr("issue-84");
  assert.equal(calls.filter((c) => /matching-refs/.test(c)).length, 1);
  assert.equal(calls.filter((c) => c === "pr list --head").length, 1);
  assert.deepEqual(h.api("GET", "repos/o/r/missing"), { status: 404, message: "gh api failed: gh: Not Found (HTTP 404)" });
  const check = h.checkRun("abc", "Salesforce tests");
  check.update({ title: "x" }, "success");
  assert.ok(calls.includes("PATCH repos/o/r/check-runs/7"));
  assert.deepEqual(codeHost({ io, env: { GH_REPO: "o/r" } }).checkRun(null, "x").update(), undefined, "no commit: a no-op check");
});

test("the GitHub tracker finds a marked comment once, then edits it directly", async () => {
  const calls = [];
  const t = githubTracker({ repo: "o/r", gh: (a) => { calls.push(a.slice(0, 3).join(" ")); return null; }, ghPages: (p) => { calls.push(`list ${p}`); return [{ id: 11, body: "<!-- mark --> old" }]; } });
  await t.card(84, "new 1", "<!-- mark -->");
  await t.card(84, "new 2", "<!-- mark -->");
  assert.equal(calls.filter((c) => c.startsWith("list")).length, 1);
  assert.equal(calls.filter((c) => c === "api -X PATCH").length, 2);
});

test("the GitHub tracker lists an issue's comments once per refresh (plan, card before, card), and again after a write or 20 s", async () => {
  let lists = 0, t0 = 0;
  const t = githubTracker({ repo: "o/r", now: () => t0, gh: () => null, ghPages: () => { lists++; return [{ id: 11, body: "<!-- mark --> old", user: { login: "a" } }]; } });
  await t.comments(84); await t.prior(84, "<!-- mark -->"); await t.card(84, "new", "<!-- mark -->");
  assert.equal(lists, 1, "one list for the three reads");
  await t.comments(84);
  assert.equal(lists, 2, "the card write drops what was read");
  await t.comments(84); t0 += 21e3; await t.comments(84);
  assert.equal(lists, 3, "stale after 20 s");
  await t.comment(84, "hi"); await t.comments(84);
  assert.equal(lists, 4, "a comment drops it too");
  await t.comments(85);
  assert.equal(lists, 5, "per issue");
});

test("actions: commands and ticked boxes name the same actions; only write access, never a bot", () => {
  assert.deepEqual(actions.command("/uat-fail the totals are wrong\nmore"), { id: "uat-fail", arg: "the totals are wrong" });
  assert.deepEqual(actions.command("/SHIP"), { id: "ship", arg: "" });
  assert.equal(actions.command("ship it please"), null);
  const card = actions.checklist(["ship", "review"]).join("\n");
  assert.deepEqual(actions.ticked(card, card.replace("- [ ] 🚀", "- [x] 🚀")), ["ship"]);
  assert.deepEqual(actions.ticked(card, card), [], "an edit that ticks nothing does nothing");
  assert.deepEqual(actions.ticked(card.replace("- [ ] 🚀", "- [x] 🚀"), card.replace("- [ ] 🚀", "- [x] 🚀")), [], "already ticked: not a new tick");
  assert.deepEqual(actions.allowed(["build", "start", "fix"], { implement: true }), ["build", "start"]);
  assert.equal(actions.mayAct({ login: "dev", type: "User", permission: "write" }), true);
  for (const bad of [{ login: "dev", type: "User", permission: "read" }, { login: "__owner__-pipeline[bot]", type: "Bot", permission: "admin" }]) assert.equal(actions.mayAct(bad), false);
});

test("check runs are updated when their title changes, at most once a minute; the result always", () => {
  const sent = [];
  let t = 0;
  const io = { run: (c, a, o) => { if (a[2] === "POST") return JSON.stringify({ id: 9 }); sent.push(JSON.parse(o.input)); return ""; } };
  const check = codeHost({ io, env: { GH_REPO: "o/r" }, now: () => t }).checkRun("sha", "Salesforce tests");
  for (let i = 0; i < 8; i++) { t += 15e3; check.update({ title: `Running: ${Math.floor(i / 4)}` }); }
  check.update({ title: "Passed" }, "success");
  assert.equal(sent.length, 3, "two progress updates in two minutes, then the result");
  assert.equal(sent.at(-1).conclusion, "success");
});

test("the code host finds a release branch's open PR once, and forgets a PR's facts after work starts on it (27 Oct review)", () => {
  let lists = 0, views = 0;
  const io = { gh: (a) => {
    if (a[0] === "pr" && a[1] === "list") { lists++; return [{ number: 296 }]; }
    if (a[0] === "pr" && a[1] === "view") { views++; return { number: 5, headRefOid: "h", headRefName: "issue-5", baseRefName: "release/w", state: "OPEN", commits: [] }; }
    return [];
  }, ghPages: () => [], run: () => "{}", git: () => "" };
  const host = codeHost({ io, env: { GH_REPO: "o/r", PIPELINE_EVENTS: "off" } });
  assert.equal(host.releasePrOf("origin/release/2027-w01"), 296);
  assert.equal(host.releasePrOf("release/2027-w01"), 296);
  assert.equal(lists, 1, "origin/ is the same branch: asked once");
  assert.equal(host.releasePrOf(null), null);
  host.prFacts(5); host.prFacts(5);
  assert.equal(views, 1, "facts are gathered once per process");
  host.forget(5); host.prFacts(5);
  assert.equal(views, 2, "after forget, the next card reads fresh facts");
});

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
  // the fake curl answers from FAKE_JIRA ({path: [code, body]}; code 0: the network failed, as curl prints 000 and
  // exits 7), writes -o's file, prints -w's code, and logs each call's argv and whether --netrc-file holds the login
  writeFileSync(`${bin}/curl`, `#!/usr/bin/env node
const a = process.argv.slice(2), fs = require("fs"), r = JSON.parse(process.env.FAKE_JIRA);
const url = a.find((x) => /^https?:/.test(x)), path = url.replace(/^https?:\\/\\/[^/]+/, "");
const nf = a.includes("--netrc-file") ? a[a.indexOf("--netrc-file") + 1] : null;
const login = nf && (fs.statSync(nf).mode & 0o777) === 0o600 && /machine acme\\.atlassian\\.net login ci@acme\\.test password s3cret-token/.test(fs.readFileSync(nf, "utf8"));
fs.appendFileSync(process.env.FAKE_LOG, (login ? "auth " : "") + path + " argv:" + a.join(" ") + "\\n");
const [code, body] = r[path] || [404, {}];
if (a.includes("-o")) fs.writeFileSync(a[a.indexOf("-o") + 1], JSON.stringify(body));
if (a.includes("-w")) process.stdout.write(code === 0 ? "000" : String(code));
process.exit(code === 0 ? 7 : 0);
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
  assert.match(good.stdout, /"jira-release-cut","client_payload":\{"version":"\{\{version\.name\}\}"\}/, "release-cut checks the version is the open sprint's");
  assert.doesNotMatch(good.stdout + good.stderr, /s3cret-token/, "the token is never printed");
  const calls = read(`${bin}/log`, "utf8").split("\n").filter(Boolean);
  assert.ok(calls.every((l) => l.startsWith("auth ")), "every call logs in, from a netrc file only its owner can read");
  assert.ok(calls.every((l) => !l.includes("s3cret-token")), "the token is never on curl's command line (ps shows it)");
  const offline = run({ ...ok, "/rest/api/3/myself": [0, {}] });
  assert.notEqual(offline.status, 0);
  assert.match(offline.stdout, /HTTP 000\)/, "a network failure reads HTTP 000, once");
  // without jq the checks cannot read Jira's answers: it says so before calling Jira
  const { symlinkSync } = await import("node:fs");
  const bare = mkdtempSync(`${tmpdir()}/jira-bare-`);
  for (const t of ["node", "bash", "mktemp", "rm", "cat", "chmod", "grep", "dirname"]) { const w = spawnSync("which", [t], { encoding: "utf8" }).stdout.trim(); if (w) symlinkSync(w, `${bare}/${t}`); }
  symlinkSync(`${bin}/curl`, `${bare}/curl`);
  const noJq = run(ok, { PATH: bare });
  assert.notEqual(noJq.status, 0);
  assert.match(noJq.stdout + noJq.stderr, /needs jq/);
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

test("API count (#422, review of #434): every gh call is counted where it runs, per token and per budget (REST, GraphQL), each page of a paginated read once", async () => {
  const { counted } = await import("../src/io.mjs");
  const raw = {
    gh: (args) => (args.includes("--paginate") ? [[1, 2], [3], [4]] : {}),
    run: () => "{}",
    sf: () => ({}), git: () => "",
  };
  const io = counted(raw, { token: () => "actions-token" });
  io.gh(["api", "repos/o/r/compare/a...b"]);                    // REST
  io.gh(["api", "graphql", "-f", "query=query{viewer{login}}"]); // GraphQL
  io.gh(["pr", "view", "9", "--json", "number"]);              // gh's own commands: GraphQL
  io.gh(["issue", "comment", "9", "--body", "x"]);              // GraphQL
  io.gh(["workflow", "run", "gate.yml", "--ref", "main"]);      // REST: the workflow looked up, then dispatched
  assert.deepEqual(io.ghPages("repos/o/r/pulls/1/reviews"), [1, 2, 3, 4]);   // 3 pages: 3 REST
  io.run("gh", ["api", "-X", "PUT", "repos/o/r/contents/x", "--input", "-"], { input: "{}" });   // REST
  io.run("sf", ["org", "list"]);   // not GitHub
  io.sf(["org", "list"]); io.git(["status"]);
  io.gh(["api", "repos/o/r/branches/x"], { env: { GH_TOKEN: "app-installation-token" } });   // another token: the App's
  io.gh(["api", "repos/o/r/branches/x"], { env: { GH_TOKEN: "actions-token" } });           // the job's own token
  assert.deepEqual(io.usage(), { actions: { rest: 8, graphql: 3 }, app: { rest: 1, graphql: 0 } });
  io.count("app", "graphql");   // a call made outside gh (the App's GraphQL for the board, by fetch)
  assert.equal(io.usage().app.graphql, 1);
  // a step that acts as the App (pipeline-identity sets GH_TOKEN to the App's token and PIPELINE_TOKEN_IS_APP): its calls are the App's
  const asApp = counted(raw, { token: () => "t", jobIsApp: () => true });
  asApp.gh(["api", "x"]);
  assert.deepEqual(asApp.usage(), { actions: { rest: 0, graphql: 0 }, app: { rest: 1, graphql: 0 } });
});

test("API meter (#422, review of #434): at exit, the counts go in one api event with the hour's total from one rate_limit read, only when the process made calls; one attempt, never a blocking retry", async () => {
  const { counted } = await import("../src/io.mjs");
  {
    const sent = [], notes = [];
    let reads = 0, conflict = false;
    const raw = {
      gh: (args) => { if (args.join(" ") === "api rate_limit") { reads++; return { resources: { core: { limit: 1000, used: 417, reset: 1793361600 }, graphql: { limit: 1000, used: 52, reset: 1793361600 } } }; } return {}; },
      run: (cmd, args, o) => {
        if (args[2] === "PUT") { if (conflict) throw new Error("gh api -X PUT failed: HTTP 409: is at x but expected y"); sent.push(JSON.parse(Buffer.from(JSON.parse(o.input).content, "base64").toString())); }
        return "{}";
      },
    };
    const env = { GH_REPO: "o/r", GITHUB_RUN_ID: "77", GITHUB_WORKFLOW: "ci" };
    let slept = 0;
    const make = (e = env) => { const io = counted(raw, { token: () => "t" }); return { io, host: codeHost({ io, env: e, log: (s) => notes.push(s), sleep: () => slept++ }) }; };

    // a process that made calls: one event at exit, its own write counted, the window's totals read once
    let { io, host } = make();
    const meter = host.meter("finish ci", { pr: 12 });
    assert.equal(reads, 0, "nothing read when the meter starts");
    io.gh(["api", "repos/o/r/compare/a...b"]); io.gh(["pr", "view", "12"]);
    const used = meter.stop();
    assert.equal(reads, 1, "one rate_limit read, at exit");
    assert.equal(sent.length, 1);
    const e = sent[0];
    assert.deepEqual([e.kind, e.command, e.pr, e.rest, e.graphql, e.coreUsed, e.coreLimit, e.coreReset, e.graphqlUsed, e.run, e.workflow],
      ["api", "finish ci", 12, 2, 1, 417, 1000, "2026-10-30T12:00:00.000Z", 52, "77", "ci"], "the event's own PUT is one of the 2 REST");
    assert.equal(used.rest, 2);
    assert.equal(e.appRest, undefined, "no App-token calls: no App fields");

    // a conflict on the metrics branch: dropped with a notice, no retry, no sleep
    ({ io, host } = make());
    conflict = true;
    const m2 = host.meter("x");
    io.gh(["api", "x"]);
    m2.stop();
    assert.equal(slept, 0, "no blocking retry at exit");
    assert.match(notes.join("\n"), /api counts not recorded \(409\)/);
    conflict = false;

    // a process that made no calls: no read, no event
    const before = [reads, sent.length];
    ({ io, host } = make());
    assert.equal(host.meter("settings").stop(), null);
    assert.deepEqual([reads, sent.length], before);

    // off outside Actions, with the event log off, or API_METER=off
    for (const off of [{ GH_REPO: "o/r" }, { ...env, PIPELINE_EVENTS: "off" }, { ...env, API_METER: "off" }]) {
      ({ io, host } = make(off));
      const m = host.meter("x");
      io.gh(["api", "x"]);
      assert.equal(m.stop(), null);
    }
    assert.deepEqual([reads, sent.length], before);
  }
});

// the pipeline App's installation token, as GitHub mints it: the token, its permissions and its expiry (fake)
const ALL_READS = { actions: "write", checks: "read", contents: "write", issues: "write", metadata: "read", pull_requests: "write", statuses: "read" };
const fakeMint = (permissions = ALL_READS) => {
  const calls = [];
  const mint = (creds) => { calls.push(creds.appId); return { token: `app-token-${calls.length}`, permissions }; };
  return { mint, calls };
};
const APP = { PIPELINE_APP_ID: "1", PIPELINE_APP_PRIVATE_KEY: "pem" };

test("App-token reads (#427): with APP_TOKEN_READS on, every read is sent with the pipeline App's token, minted on the first read, and every write stays on the Actions token; off is today's", async () => {
  const { world, REPO } = await import("./sim.mjs");
  const setup = () => {
    const w = world();
    w.story("84");
    const head = w.push("issue-84", ["force-app/main/default/classes/A.cls"]);
    w.pr(90, { head: "issue-84", base: "main" });
    w.status(head, "pipeline/ai-review", "success", "AI-REVIEW: PASS");
    return { w, head };
  };
  const step = (w, head, env, m = fakeMint()) => {
    const notes = [];
    const host = codeHost({ io: w.io, env: { GH_REPO: REPO, GITHUB_RUN_ID: "1", PIPELINE_EVENTS: "off", ...env }, mintApp: m.mint, log: (s) => notes.push(s) });
    w.state.tokens.length = 0;
    // writes alone (a status, a check run, a dispatch, an event-log PUT): nothing minted
    host.status(head, "pipeline/ui-test", "success", "passed");
    host.checkRun(head, "Salesforce tests").update({ title: "done" }, "success");
    host.dispatch("gate.yml", { pr: 90 });
    host.api("PUT", "repos/o/r/contents/x", { a: 1 });
    const mintedByWrites = m.calls.length;
    // then the reads a stage's finish makes: the facts and the PR, the code host's lookups, a GET through api()
    host.prFacts(90); host.storyPr("issue-84"); host.openRelease(); host.releasePrOf("release/w"); host.checkRuns(head); host.workflowRuns("ci.yml");
    host.api("GET", "repos/o/r/branches/issue-84");
    host.prFacts(91 - 1);
    return { notes, mintedByWrites, mints: m.calls.length, tokens: [...w.state.tokens] };
  };
  const isWrite = (c) => / -X (POST|PATCH|PUT|DELETE) | -f |^gh workflow run /.test(c);

  // on, with the App's key in the step: minted lazily, once; reads on the App, writes on the Actions token
  let { w, head } = setup();
  const on = step(w, head, { APP_TOKEN_READS: "true", ...APP });
  assert.equal(on.mintedByWrites, 0, "a process that only writes mints nothing");
  assert.equal(on.mints, 1, "minted once, on the first read");
  const reads = on.tokens.filter(([, c]) => !isWrite(c)), writes = on.tokens.filter(([, c]) => isWrite(c));
  assert.ok(reads.length >= 11, `the facts read, the lookups and api GET (${reads.length})`);
  assert.deepEqual(reads.filter(([t]) => t !== "app-token-1"), [], "every read on the App's token, api() GETs too");
  assert.equal(writes.length, 5, "status, check run created and completed, dispatch, event PUT");
  assert.deepEqual(writes.filter(([t]) => t !== "actions"), [], "every write on the Actions token");

  // off (the default): exactly today, nothing minted, every call on the Actions token
  ({ w, head } = setup());
  const off = step(w, head, { ...APP });
  assert.equal(off.mints, 0);
  assert.deepEqual(off.tokens.filter(([t]) => t !== "actions"), []);

  // on, but no App key in this step: the Actions token, and the notice once per process however many reads
  ({ w, head } = setup());
  const bare = step(w, head, { APP_TOKEN_READS: "true" });
  assert.equal(bare.notes.filter((n) => /credentials are not in this step/.test(n)).length, 1);
  assert.deepEqual(bare.tokens.filter(([t]) => t !== "actions"), []);

  // the App lacks a permission a read needs (statuses before the admin step): never a silent degrade. A ::warning::
  // naming it, and every read on the Actions token
  ({ w, head } = setup());
  const { statuses, ...noStatuses } = ALL_READS;
  const missing = step(w, head, { APP_TOKEN_READS: "true", ...APP }, fakeMint(noStatuses));
  assert.equal(missing.notes.filter((n) => /^::warning::.*statuses/.test(n)).length, 1, missing.notes.join("\n"));
  assert.deepEqual(missing.tokens.filter(([t]) => t !== "actions"), []);

  // a token that cannot be minted: a ::warning::, the Actions token, never a failed step
  ({ w, head } = setup());
  const broken = step(w, head, { APP_TOKEN_READS: "true", ...APP }, { mint: () => { throw new Error("App not installed on o/r"); }, calls: [] });
  assert.match(broken.notes.join("\n"), /::warning::.*App not installed/);
  assert.deepEqual(broken.tokens.filter(([t]) => t !== "actions"), []);
});

test("App-token reads (#427): the token is minted again before its hour ends, and a 401 on the App's token is read again once on the Actions token", () => {
  let t = 0;
  const m = fakeMint();
  const sent = [];
  let reject = null;   // the token GitHub refuses (401), as an expired or revoked one
  const io = {
    gh: (args, o = {}) => { const tok = o.env?.GH_TOKEN || "actions"; sent.push([tok, args.join(" ")]); if (tok === reject) throw new Error("gh api repos/o/r failed: HTTP 401: Bad credentials"); return { ok: tok }; },
    ghPages: (path, key, o = {}) => { const tok = o.env?.GH_TOKEN || "actions"; sent.push([tok, path]); if (tok === reject) throw new Error("gh api --paginate failed: HTTP 401: Bad credentials"); return [tok]; },
    run: (cmd, args, o = {}) => { const tok = o.env?.GH_TOKEN || "actions"; sent.push([tok, args.join(" ")]); if (tok === reject) throw new Error("gh api -X GET failed: HTTP 401: Bad credentials"); return JSON.stringify({ ok: tok }); },
  };
  const host = codeHost({ io, env: { GH_REPO: "o/r", APP_TOKEN_READS: "true", ...APP }, mintApp: m.mint, now: () => t, log: () => {} });
  host.workflowRuns("a.yml");
  t = 49 * 60e3; host.workflowRuns("b.yml");
  assert.equal(m.calls.length, 1, "still fresh at 49 minutes");
  t = 51 * 60e3; host.workflowRuns("c.yml");
  assert.equal(m.calls.length, 2, "minted again past 50 minutes (it lives an hour)");
  assert.equal(sent.at(-1)[0], "app-token-2");

  // GitHub refuses the App's token: each kind of read is retried once on the Actions token, and the next read mints anew
  reject = "app-token-2";
  sent.length = 0;
  assert.deepEqual(host.api("GET", "repos/o/r/branches/x"), { ok: "actions" });
  assert.deepEqual(sent.map(([tok]) => tok), ["app-token-2", "actions"]);
  reject = "app-token-3";
  sent.length = 0;
  assert.deepEqual(host.checkRuns("sha"), ["actions"], "the page read again on the Actions token");
  assert.deepEqual(sent.map(([tok]) => tok), ["app-token-3", "actions"]);
  reject = "app-token-4";
  sent.length = 0;
  assert.deepEqual(host.workflowRuns("d.yml"), []);
  assert.deepEqual(sent.map(([tok]) => tok), ["app-token-4", "actions"]);
  assert.equal(m.calls.length, 4, "each refusal drops the token: the next read mints a new one");
});

test("API count with App-token reads (#427): reads are counted on the App's token and writes on the Actions token; the App's hour is read on its own token, only when it was used", async () => {
  const { counted } = await import("../src/io.mjs");
  const window = (used, limit) => ({ core: { limit, used, reset: 1793361600 }, graphql: { limit: 1000, used: 0, reset: 1793361600 } });
  const rateReads = [];
  const puts = [];
  const raw = {
    gh: (args, o = {}) => {
      const tok = o.env?.GH_TOKEN || "job";
      if (args.join(" ") === "api rate_limit") { rateReads.push(tok); return { resources: tok === "job" ? window(104, 1000) : window(2030, 5000) }; }
      return { workflow_runs: [] };
    },
    run: (cmd, args, o) => { if (args[2] === "PUT") puts.push(JSON.parse(Buffer.from(JSON.parse(o.input).content, "base64").toString())); return "{}"; },
  };
  const env = { GH_REPO: "o/r", GITHUB_RUN_ID: "9", APP_TOKEN_READS: "true", ...APP };
  const m = fakeMint();
  let host = codeHost({ io: counted(raw, { token: () => "job", jobIsApp: () => false }), env, mintApp: m.mint });
  let meter = host.meter("finish review", { pr: 90 });
  host.workflowRuns("x.yml");                                  // a read: the App's token
  host.status("sha", "pipeline/ai-review", "success", "ok");   // a write: the Actions token
  const used = meter.stop();
  assert.deepEqual([used.rest, used.graphql, used.appRest, used.appGraphql], [2, 0, 1, 0], "the status and the event's own write; one read on the App");
  assert.deepEqual([used.coreUsed, used.appCoreUsed, used.appCoreLimit, used.appCoreReset], [104, 2030, 5000, "2026-10-30T12:00:00.000Z"]);
  assert.deepEqual(rateReads, ["job", "app-token-1"], "each token's hour read on its own token, once, at exit");
  assert.equal(puts[0].appRest, 1);

  // a process that read nothing: no App token, no App reading, no App fields
  rateReads.length = 0;
  host = codeHost({ io: counted(raw, { token: () => "job", jobIsApp: () => false }), env, mintApp: m.mint });
  meter = host.meter("x");
  host.status("sha", "pipeline/ai-review", "success", "ok");
  assert.equal(meter.stop().appRest, undefined);
  assert.deepEqual(rateReads, ["job"]);
  assert.equal(m.calls.length, 1, "minted only by the process that read");
});

test("a gh call is a read only when it provably changes nothing (#427): default deny, joined flag forms included", async () => {
  const { isRead } = await import("../src/github.mjs");
  for (const r of [["pr", "view", "9", "--json", "x"], ["pr", "list", "--head", "b"], ["issue", "view", "4"], ["api", "repos/o/r/compare/a...b"], ["api", "--paginate", "--slurp", "repos/o/r/pulls/1/reviews"],
    ["api", "-X", "GET", "repos/o/r/branches/x"], ["api", "-XGET", "x"], ["api", "--method", "GET", "x"], ["api", "--method=get", "x"], ["api", "rate_limit"], ["api", "x", "--jq", ".a"]])
    assert.equal(isRead(r), true, r.join(" "));
  for (const wr of [["api", "repos/o/r/statuses/s", "-f", "state=success"], ["api", "-X", "PATCH", "repos/o/r/issues/comments/1", "-f", "body=x"], ["api", "-X", "PUT", "x", "--input", "-"],
    ["api", "--method=POST", "x"], ["api", "-XPOST", "x"], ["api", "-XPATCH", "x"], ["api", "--method", "DELETE", "x"], ["api", "x", "--input=body.json"], ["api", "x", "-fstate=ok"], ["api", "x", "-Fn=1"],
    ["api", "x", "--field=a=1"], ["api", "x", "--raw-field", "a=1"], ["api", "x", "-X"], ["api", "graphql", "-f", "query=mutation{}"], ["api", "graphql", "-F", "n=1"], ["api", "-H", "X-HTTP-Method-Override: DELETE", "x"],
    ["pr", "edit", "9", "--add-label", "x"], ["pr", "comment", "9", "--body", "x"], ["issue", "comment", "4", "--body", "x"], ["workflow", "run", "x.yml"], ["pr", "merge", "9"], ["label", "create", "x"], ["pr", "view", "9", "--web"], []])
    assert.equal(isRead(wr), false, wr.join(" "));
});


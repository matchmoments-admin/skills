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

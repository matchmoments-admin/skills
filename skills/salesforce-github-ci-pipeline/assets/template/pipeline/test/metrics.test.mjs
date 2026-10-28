// Pipeline tests: metrics (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
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

test("close-out is safe to re-run and closes PRs still aimed at the shipped release branch", async () => {
  const done = [], closed = [];
  const tracker = { story: async (k) => ({ state: k === "1" ? "CLOSED" : "OPEN" }), done: async (k) => done.push(k), carry: async () => {}, closeSprint: async () => {} };
  const gh = (args) => (args[1] === "list" ? [{ number: 40, headRefName: "issue-5" }] : args[1] === "close" ? (closed.push(args[2]), null) : null);
  const { apply } = await import("../src/closeout.mjs");
  await apply({ sprint: "w", ship: ["1", "3"], carry: [], hotfix: [], deleteOrgs: [], deleteBranch: "release/w" },
    { tag: "v1", tracker, orgs: { remove: () => true }, git: (args) => (args[0] === "ls-remote" ? null : ""), gh, log: () => {} });
  assert.deepEqual(done, ["3"]);       // story 1 was already closed by an earlier run
  assert.deepEqual(closed, ["40"]);
  // git cannot delete it: the API does, and a branch that survives both is reported, never silent
  const calls = [], logs = [];
  let alive = true;
  const git = (args) => (args[0] === "ls-remote" ? (alive ? "sha refs/heads/release/w" : null) : null);
  const gh2 = (args) => { calls.push(args.join(" ")); if (args.includes("DELETE")) alive = false; return []; };
  await apply({ sprint: "w", ship: [], carry: [], hotfix: [], deleteOrgs: [], deleteBranch: "release/w" }, { tag: "v1", tracker, orgs: { remove: () => true }, git, gh: gh2, log: (m) => logs.push(m) });
  assert.ok(calls.some((c) => c.includes("-X DELETE") && c.endsWith("git/refs/heads/release/w")));
  assert.ok(logs.includes("deleted release/w"));
});

test("close-out counts what is in the shipped SHA and not in the release before it, wherever main has moved since", async () => {
  const inside = { m1: [SHA], m2: [SHA, "v2026.10.04-8"], m3: [] };   // m3 merged after the shipped SHA
  const git = (args) => {
    if (args[0] === "merge-base") return inside[args[2]]?.includes(args[3]) ? "" : null;
    if (args[0] === "for-each-ref") return "";
    return "";
  };
  const gh = () => [{ number: 1, headRefName: "issue-1", mergeCommit: { oid: "m1" } }, { number: 2, headRefName: "issue-2", mergeCommit: { oid: "m2" } }, { number: 3, headRefName: "issue-3", mergeCommit: { oid: "m3" } }];
  const f = await closeout.gather({ gh, git }, { sprintStories: async () => [] }, { sha: SHA, previous: "v2026.10.04-8" });
  assert.deepEqual(f.mergedIntoMain.map((p) => p.number), [1]);
});

test("events: what happened and where, one new file each; a token that cannot write turns recording off, quietly", () => {
  const e = events.event("tests", { story: "84", ok: true, empty: "", none: null }, { GITHUB_RUN_ID: "9", GITHUB_WORKFLOW: "ci", GITHUB_JOB: "apex" }, new Date("2026-10-05T10:11:12.345Z"));
  assert.deepEqual(e, { v: 1, at: "2026-10-05T10:11:12.345Z", kind: "tests", story: "84", ok: true, run: "9", workflow: "ci", job: "apex" });
  assert.equal(events.pathOf(e, "abc"), "events/2026/10/05/20261005T101112345Z-9-tests-abc.json");
  assert.throws(() => events.event("nonsense"), /Unknown event kind/);
  const puts = [];
  let reply = [{ status: 409 }, {}];
  const rec = events.recorder({ api: (m, p, b) => { puts.push(p); return reply.shift(); }, repo: "o/r", env: {}, sleep: () => {} });
  assert.equal(rec("gate", { pr: 1 }), true);
  assert.equal(puts.length, 2, "a 409 (the branch moved) is retried");
  reply = [{ status: 403 }];
  const notes = [];
  const ro = events.recorder({ api: () => reply.shift(), repo: "o/r", env: {}, log: (m) => notes.push(m) });
  assert.equal(ro("gate", {}), false);
  assert.equal(ro("gate", {}), false, "no second call after a 403");
  assert.equal(notes.length, 1);
});

test("event log: DORA to production, rollbacks as failures, what PRs waited on, org-hours and AI cost", () => {
  const ev = (at, kind, d) => ({ at: `2026-10-0${at}`, kind, ...d });
  const log = [
    ev("1T00:00:00Z", "stage", { story: "84", what: "creating the branch", state: "running" }),
    ev("1T01:00:00Z", "org", { action: "created", org: "issue-84" }),
    ev("1T02:00:00Z", "gate", { pr: 90, mergeable: false, reasons: ['check "deploy and Apex tests (scratch org)" is pending', "no sign-off (approve it, or comment /ship)"] }),
    ev("1T03:00:00Z", "gate", { pr: 90, mergeable: false, reasons: ['check "static checks (no org)" is pending'] }),
    ev("1T03:00:00Z", "gate", { pr: 91, mergeable: false, reasons: ['check "x" is pending'] }),
    ev("1T04:00:00Z", "tests", { story: "84", mode: "relevant", ok: true, seconds: 240 }),
    ev("1T05:00:00Z", "org", { action: "deleted", org: "issue-84" }),
    ev("1T06:00:00Z", "stage", { story: "84", what: "CI (deploy or tests)", state: "failed" }),
    ev("2T00:00:00Z", "agent", { role: "fix", pr: 90, usd: 0.4, turns: 20, minutes: 6 }),
    ev("2T01:00:00Z", "agent", { role: "fix", pr: 90, usd: 0.6, turns: 30, minutes: 8 }),
    ev("2T02:00:00Z", "verdict", { context: "pipeline/ai-review", state: "failure", pr: 90 }),
    ev("2T03:00:00Z", "verdict", { context: "pipeline/ai-review", state: "success", pr: 90 }),
    ev("3T00:00:00Z", "release", { tag: "v1", sprint: "w45", shipped: ["84"], hotfixes: [] }),
    ev("3T12:00:00Z", "stage", { story: "95", what: "starting", state: "running" }),
    ev("4T00:00:00Z", "release", { tag: "v2", sprint: null, shipped: [], hotfixes: ["95"] }),
    ev("5T00:00:00Z", "rollback", { tag: "v1" }),
    ev("5T01:00:00Z", "lane", { lane: "org-issue-84", waitedSeconds: 600 }),
  ];
  const s = events.summarize(log, { days: 7 });
  assert.equal(s.dora.leadTimeHours, 48);                   // started 1st 00:00, in production 3rd 00:00
  assert.equal(s.dora.changeFailureRate, 100);              // 1 hotfix release + 1 rollback over 2 releases
  assert.equal(s.dora.timeToRestoreHours, 12);
  assert.deepEqual(s.gateWaits[0], { reason: "check X is pending", prs: 2 });
  assert.equal(s.stages.orgs.orgHours, 4);
  assert.equal(s.stages.lanes.totalMinutes, 10);
  assert.deepEqual(s.failedStages, [{ what: "CI (deploy or tests)", n: 1 }]);
  assert.deepEqual([s.ai.byRole.fix.runs, s.ai.totalUsd, s.ai.medianFixRounds, s.ai.passedFirstReview], [2, 1, 2, 0]);
  const md = events.toMarkdown(s);
  for (const want of ["story started to in production) | 48 h", "1 hotfix, 1 rollback", "check X is pending | 2", "| fix | 2 | $1.00"]) assert.ok(md.includes(want), want);
});

test("the event log is read with one git cat-file --batch, sizes in bytes (non-ASCII safe)", () => {
  const a = Buffer.from('{"kind":"gate","why":"→ ok"}'), b = Buffer.from('{"kind":"org"}');
  const out = Buffer.concat([Buffer.from(`aaa blob ${a.length}\n`), a, Buffer.from("\n"), Buffer.from(`bbb blob ${b.length}\n`), b, Buffer.from("\n")]);
  assert.deepEqual(events.parseBatch(out).map((t) => JSON.parse(t).kind), ["gate", "org"]);
});

test("the event log is read from a real metrics branch (fetch, ls-tree, one cat-file --batch), only inside the window", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { io } = await import("../src/io.mjs");
  const root = mkdtempSync(`${tmpdir()}/log-`);
  const g = (dir, ...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  execFileSync("git", ["init", "-q", "--bare", `${root}/remote.git`]);
  g(root, "init", "-q", "w"); const w = `${root}/w`;
  const put = (p, e) => { mkdirSync(`${w}/${p.split("/").slice(0, -1).join("/")}`, { recursive: true }); writeFileSync(`${w}/${p}`, JSON.stringify(e) + "\n"); };
  put("events/2026/10/05/a-1-gate-x.json", { kind: "gate", at: "2026-10-05T10:00:00Z", why: "→ waiting" });
  put("events/2026/10/05/b-1-agent-y.json", { kind: "agent", at: "2026-10-05T11:00:00Z", role: "fix", usd: 0.5 });
  put("events/2026/08/01/c-1-org-z.json", { kind: "org", at: "2026-08-01T00:00:00Z" });
  g(w, "checkout", "-q", "-b", "metrics"); g(w, "add", "."); g(w, "commit", "-qm", "events"); g(w, "remote", "add", "origin", `${root}/remote.git`); g(w, "push", "-q", "origin", "metrics");
  g(root, "clone", "-q", `${root}/remote.git`, "reader");
  const here = process.cwd();
  process.chdir(`${root}/reader`);
  try {
    const got = events.readLog(io, { days: 7, now: new Date("2026-10-06T00:00:00Z") });
    assert.deepEqual(got.map((e) => e.kind).sort(), ["agent", "gate"]);
    assert.equal(got.find((e) => e.kind === "gate").why, "→ waiting");
  } finally { process.chdir(here); }
});

test("UI evidence is in the event log and the weekly metrics", () => {
  const at = "2026-10-07T09:30:00Z";
  const s = events.summarize([{ kind: "evidence", at, story: "134", shots: 2, rejected: 0, kb: 28 }, { kind: "evidence", at, story: "135", shots: 0, rejected: 3, kb: 0 }], { days: 7 });
  assert.deepEqual(s.stages.evidence, { posts: 1, shots: 2, rejected: 3, medianKbPerShot: 14, totalKb: 28 });
  assert.match(events.toMarkdown(s), /\| UI evidence \| 1 posts, 2 screenshots \(3 refused\); median 14 KB each, 28 KB in all \|/);
  assert.doesNotThrow(() => events.event("evidence", { story: "1", shots: 1 }));
});

test("round 1: spec revisions reach the story; Where keeps the whole Solution; Accept anyway needs a reason; release notes mention UAT", async () => {
  assert.match(specs.revisedNote(125), /Spec #125 was revised\. Its decisions bind this story/);
  const t = specs.storyFromSpec({ spec: 1, title: "Spec: x", text: "### Solution\nManagers see two things:\n- the count\n- the amount\n### User stories\n1. As a manager, I want y\n" });
  assert.match(t.where, /- the count\n- the amount/);
  const r = actions.perform("review-ok", "", { number: 9, isPr: true, pr: { headRefOid: "abc1234" } }, "pm", { host: { status: () => { throw new Error("no reason: no status"); } } });
  assert.match(r.said, /say why in a comment: `\/review-ok <why>`/);
  const notes = await closeout.releaseNotes({ gh: () => [] }, { sprintStories: async () => [{ key: "143", title: "Story: x", state: "OPEN" }] }, "2026-w46");
  assert.match(notes, /- #143 Story: x\n/);
  assert.doesNotMatch(notes, /\[OPEN\]/);
});

test("delivery record: the AI review is found on the commit it judged when later commits only changed the spec (story #166); only trusted statuses and counted approvals", async () => {
  const { gatherDelivery } = await import("../src/closeout.mjs");
  process.env.GH_REPO = "o/r";
  const R = "repos/o/r";
  const data = {
    "issue view 166": { title: "Story", body: "### Approver\n\n@alice\n", createdAt: "2026-10-08T00:00:00Z" },
    "pr list issue-166": [{ number: 176, headRefName: "issue-166", headRefOid: "spec2", createdAt: "2026-10-08T06:00:00Z", mergedAt: "2026-10-09T00:00:00Z" }],
    "pr view": { number: 176, state: "MERGED", baseRefName: "release/2026-w47", headRefName: "issue-166", headRefOid: "spec2", author: { login: "alice" },
      commits: [{ oid: "code", committedDate: "2026-10-08T07:00:00Z", authors: [{ login: "alice" }] }, { oid: "spec1", committedDate: "2026-10-08T08:30:00Z", authors: [{ login: "github-actions[bot]" }, { login: "claude" }] },
        { oid: "spec2", committedDate: "2026-10-08T08:40:00Z", authors: [{ login: "github-actions[bot]" }, { login: "claude" }] }] },
    [`${R}/commits/spec2/statuses?per_page=100`]: [{ context: "pipeline/ui-test", state: "success", created_at: "2026-10-08T09:00:00Z", creator: BOT },
      { context: "pipeline/sign-off", state: "success", description: "Signed off by @alice", created_at: "2026-10-08T12:00:00Z", creator: BOT }],
    [`${R}/commits/spec1/statuses?per_page=100`]: [],
    [`${R}/commits/code/statuses?per_page=100`]: [{ context: "pipeline/ai-review", state: "success", description: "AI review passed", created_at: "2026-10-08T08:00:00Z", creator: BOT }],
    [`${R}/compare/code...spec2`]: { status: "ahead", files: [{ filename: "e2e/story-166.spec.ts" }] },
  };
  const io = deliveryIo(data);
  const saved = process.env.PIPELINE_VARS;   // CI passes the repository's own settings: this test sets its own
  process.env.PIPELINE_VARS = "{}";
  try {
  const d = gatherDelivery("166", io, { tag: "v1", sprint: "2026-w47", repo: "o/r" });
  assert.equal(d.review.state, "success");
  assert.equal(d.review.text, "AI review passed");
  assert.equal(d.lastPusher, "alice", "Claude's spec commits are not a person's push");
  assert.equal(d.approved.by, "alice", "APPROVERS unset: anyone's sign-off counts");
  // with APPROVERS set, alice pushed the latest change: her own sign-off was refused by the gate, so the record names nobody
  process.env.PIPELINE_VARS = JSON.stringify({ APPROVERS: "alice,bob" });
  assert.equal(gatherDelivery("166", io, { tag: "v1", sprint: "2026-w47", repo: "o/r" }).approved, null, "a refused approver is never recorded");
  // ...but once the gate recorded the approval it accepted as it merged, a later APPROVERS change does not rewrite it (E17)
  data[`${R}/commits/spec2/statuses?per_page=100`].push({ context: "pipeline/approval", state: "success", description: "@alice (ticked Sign off, 2026-10-08T12:00Z)", created_at: "2026-10-08T12:01:00Z", creator: BOT });
  assert.deepEqual(gatherDelivery("166", io, { tag: "v1", sprint: "2026-w47", repo: "o/r" }).approved, { by: "alice", how: "ticked Sign off", at: "2026-10-08T12:00:00Z" });
  data[`${R}/commits/spec2/statuses?per_page=100`].pop();
  process.env.PIPELINE_VARS = "{}";
  // a review status posted by anyone but the pipeline does not count
  data[`${R}/commits/code/statuses?per_page=100`][0].creator = { login: "mallory" };
  assert.equal(gatherDelivery("166", io, { tag: "v1", sprint: "2026-w47", repo: "o/r" }).review, null, "untrusted status creator");
  data[`${R}/commits/code/statuses?per_page=100`][0].creator = BOT;
  // code changed after the review (never reviewed): the earlier review does not count for it
  data[`${R}/compare/code...spec2`] = { status: "ahead", files: [{ filename: "e2e/story-166.spec.ts" }, { filename: "force-app/main/default/classes/X.cls" }] };
  assert.equal(gatherDelivery("166", io, { tag: "v1", sprint: "2026-w47", repo: "o/r" }).review, null);
  } finally { if (saved === undefined) delete process.env.PIPELINE_VARS; else process.env.PIPELINE_VARS = saved; }
});

test("delivery record (enterprise D): the shipped story's trail, read from GitHub, as one table and one JSON line; an overrule keeps its full reason", async () => {
  const { gatherDelivery, deliveryRecord, apply, DELIVERY_MARK } = await import("../src/closeout.mjs");
  process.env.GH_REPO = "o/r";
  const R = "repos/o/r";
  const reason = "THIS_YEAR is valid SOQL and CI passed; the reviewer misread the date literal, which the Salesforce docs list as a valid filter for CreatedDate";
  const data = {
    "issue view 166": { title: "Story: Regional Sales dashboard", body: "### Approver\n\n@alice\n", createdAt: "2026-10-08T00:00:00Z" },
    "pr list issue-166": [{ number: 180, headRefName: "issue-166", headRefOid: "h180", createdAt: "2026-10-08T06:00:00Z", mergedAt: "2026-10-09T00:00:00Z" }],
    "pr view": { number: 180, state: "MERGED", baseRefName: "release/2026-w47", headRefName: "issue-166", headRefOid: "h180", author: { login: "bob" },
      commits: [{ oid: "h180", committedDate: "2026-10-08T07:00:00Z", authors: [{ login: "bob" }] }] },
    [`${R}/commits/h180/statuses?per_page=100`]: [
      { context: "pipeline/ai-review", state: "success", description: `AI review overruled by @alice: ${reason}`.slice(0, 139), created_at: "2026-10-08T08:00:00Z", creator: BOT },
      { context: "pipeline/ui-test", state: "success", target_url: "https://github.com/o/r/issues/166#issuecomment-9", created_at: "2026-10-08T08:30:00Z", creator: BOT },
      { context: "pipeline/sign-off", state: "success", description: "Signed off by @alice", created_at: "2026-10-08T12:00:00Z", creator: BOT }],
    [`${R}/issues/180/comments?per_page=100`]: [{ body: `✋ @alice accepted this change over the AI review on \`abc1234\`: ${reason}. A new push needs a review again.` }],
    "pr list release/2026-w47": [{ number: 181, headRefOid: "r181", mergedAt: "2026-10-10T00:00:00Z" }],
    [`${R}/commits/r181/statuses?per_page=100`]: [{ context: "pipeline/uat", state: "success", description: "Signed off in UAT by @carol", created_at: "2026-10-09T20:00:00Z", creator: BOT }],
    [`${R}/commits/r181/check-runs?per_page=100&check_name=Production%20validation`]: { check_runs: [{ name: "Production validation", conclusion: "success", output: { summary: "**Check-only deploy to production** `0AfAB000001xyz` with **RunRelevantTests**." } }] },
  };
  const io = deliveryIo(data);
  const saved = process.env.PIPELINE_VARS;
  process.env.PIPELINE_VARS = "{}";   // CI passes the repository's own APPROVERS: this trail has none
  let d;
  try { d = gatherDelivery("166", io, { tag: "v2026.10.10-1", sprint: "2026-w47", now: new Date("2026-10-10T01:00:00Z"), repo: "o/r" }); }
  finally { if (saved === undefined) delete process.env.PIPELINE_VARS; else process.env.PIPELINE_VARS = saved; }
  assert.equal(d.approver, "alice");
  assert.deepEqual(d.approved, { by: "alice", at: "2026-10-08T12:00:00Z", how: "ticked Sign off" });
  assert.equal(d.lastPusher, "bob");
  assert.equal(d.review.overruledBy, "alice");
  assert.equal(d.review.reason, reason, "the full reason, not the 139-character status");
  assert.equal(d.ui.url, "https://github.com/o/r/issues/166#issuecomment-9");
  assert.equal(d.uat, "carol");
  assert.equal(d.validation, "0AfAB000001xyz");
  const md = deliveryRecord(d);
  assert.match(md, /\| Approved by \| @alice \(ticked Sign off, 2026-10-08 12:00 UTC\) \|/);
  assert.match(md, /\| AI review \| overruled by @alice: THIS_YEAR is valid SOQL.*CreatedDate \|/);
  assert.match(md, /\| lead time \(story opened → in production\) \| 48 \|/);
  const json = JSON.parse(md.match(/<!-- delivery: (.*) -->/)[1]);
  assert.equal(json.hours["PR opened → approved"], 6);
  // apply writes it once per shipped story, through the tracker's marked comment (re-running updates it)
  const cards = [];
  const tracker = { story: async () => ({ state: "OPEN" }), done: async () => {}, carry: async () => {}, closeSprint: async () => {}, card: async (k, body, mark) => cards.push([k, mark, body]) };
  await apply({ sprint: "2026-w47", ship: ["166"], carry: [], hotfix: [], deleteOrgs: [], deleteBranch: null }, { tag: "v1", tracker, orgs: { remove: () => {} }, git: () => "", ...io, log: () => {} });
  assert.equal(cards.length, 1);
  assert.equal(cards[0][1], DELIVERY_MARK);
});

test("every event a module records is a known kind, and no payload sets the envelope's own fields (shape was never logged; Jev's run was overwritten)", async () => {
  const { isKind, RESERVED, event } = await import("../src/events.mjs");
  const { readdirSync } = await import("node:fs");
  const dir = new URL("../src/", import.meta.url);
  const files = [...readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => new URL(f, dir)), ...readdirSync(new URL("org/", dir)).map((f) => new URL(`org/${f}`, dir)),
    new URL("../bin/pipe.mjs", import.meta.url), ...readdirSync(new URL("../bin/commands/", import.meta.url)).map((f) => new URL(`../bin/commands/${f}`, import.meta.url))];
  const calls = files.flatMap((u) => [...readFileSync(u, "utf8").matchAll(/\brecord\??\.?\(?\s*"([a-z]+)",\s*\{([^}]*)\}/g)].map((m) => ({ file: u.pathname.split("/pipeline/")[1], kind: m[1], keys: [...m[2].matchAll(/(?:^|,)\s*([a-zA-Z]+)\s*(?::|,|$)/g)].map((k) => k[1]) })));
  assert.ok(calls.length > 20, `found the record() calls (${calls.length})`);
  for (const c of calls) {
    assert.ok(isKind(c.kind), `${c.file}: record("${c.kind}") is not a known kind (events.mjs KINDS)`);
    assert.deepEqual(c.keys.filter((k) => RESERVED.includes(k)), [], `${c.file}: record("${c.kind}") sets an envelope field`);
  }
  assert.throws(() => event("jev", { run: true }), /envelope's own field/);
});

test("the event log's tip keeps the readers' window: old days leave the tip in one fast-forward commit; a moved branch is retried", () => {
  const T = { root: [{ path: "METRICS.md", type: "blob", sha: "mmd" }, { path: "events", type: "tree", sha: "ev" }],
    ev: [{ path: "2026", type: "tree", sha: "y26" }], y26: [{ path: "03", type: "tree", sha: "m03" }, { path: "10", type: "tree", sha: "m10" }],
    m03: [{ path: "01", type: "tree", sha: "d0301" }, { path: "31", type: "tree", sha: "d0331" }], m10: [{ path: "27", type: "tree", sha: "d1027" }],
    d0301: [{ path: "a.json", type: "blob" }, { path: "b.json", type: "blob" }], d0331: [{ path: "c.json", type: "blob" }], d1027: [{ path: "d.json", type: "blob" }] };
  const calls = [];
  let tip = "t1", patches = 0;
  const api = (m, path, body) => {
    calls.push([m, path, body]);
    if (m === "GET" && path.endsWith("/git/ref/heads/metrics")) return { object: { sha: tip } };
    if (m === "GET" && /git\/commits\//.test(path)) return { tree: { sha: "root" } };
    if (m === "GET" && /git\/trees\//.test(path)) return { tree: T[path.split("/").pop()] || [] };
    if (m === "POST" && path.endsWith("/git/trees")) return { sha: "newtree" };
    if (m === "POST" && path.endsWith("/git/commits")) return { sha: "c2" };
    if (m === "PATCH") { if (patches++ === 0) { tip = "t2"; return { status: 422, message: "not a fast forward" }; } return {}; }
    return {};
  };
  const n = events.pruneLog({ api, repo: "o/r", keepDays: 180, now: new Date("2026-10-28T00:00:00Z") });   // cutoff 2026-05-01
  assert.equal(n, 3, "every file of March, none of October");
  const tree = calls.filter(([m, p]) => m === "POST" && p.endsWith("/git/trees")).at(-1)[2];
  assert.deepEqual(tree.tree.map((e) => [e.path, e.sha]), [["events/2026/03/01/a.json", null], ["events/2026/03/01/b.json", null], ["events/2026/03/31/c.json", null]]);
  assert.equal(tree.base_tree, "root");
  const patch = calls.filter(([m]) => m === "PATCH");
  assert.equal(patch.length, 2, "the branch moved under it: read the new tip, try again");
  assert.equal(patch.every(([, , b]) => b.force === false), true, "never forced: a concurrent event is never lost");
  assert.deepEqual(calls.filter(([m, p]) => m === "POST" && p.endsWith("/git/commits")).map(([, , b]) => b.parents), [["t1"], ["t2"]]);
  assert.equal(events.pruneLog({ api: (m, p) => (m === "GET" && /trees\//.test(p) ? { tree: (T[p.split("/").pop()] || []).filter((e) => e.path !== "03") } : api(m, p)), repo: "o/r", now: new Date("2026-10-28T00:00:00Z") }), 0, "nothing old: no commit");
  assert.throws(() => events.pruneLog({ api, repo: "o/r", keepDays: 30 }), /shorter than the AI budget/);
});

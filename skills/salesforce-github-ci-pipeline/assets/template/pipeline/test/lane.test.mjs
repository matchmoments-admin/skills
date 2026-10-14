// Pipeline tests: lane (split from the one test file on 14 Oct; shared fakes in ./helpers.mjs).
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

test("lane: one holder at a time; the next waits its turn and is never dropped; only the holder releases", () => {
  const f = fakeRefs();
  let t = 0;
  const mk = (run, job) => lane({ api: f.api, repo: "o/r", holder: { run, job, sha: "base" }, now: () => t, sleep: (ms) => { t += ms; }, log: () => {} });
  const a = mk("1", "ci"), b = mk("2", "ai-fix");
  assert.equal(a.acquire("org-issue-12"), true);
  assert.equal(a.acquire("org-issue-12"), true, "a retried step that already holds it");
  assert.throws(() => b.acquire("org-issue-12", { timeoutMinutes: 1, pollSeconds: 20 }), /still busy after 1 minutes \(run 1\)/);
  assert.equal(b.release("org-issue-12"), false, "not the holder");
  assert.equal(a.release("org-issue-12"), true);
  assert.equal(b.acquire("org-issue-12"), true);
});

test("lane: a holder whose run finished (crashed, cancelled) is taken over, by exactly one waiter", () => {
  const f = fakeRefs({ runs: { 1: "completed" } });
  const mk = (run) => lane({ api: f.api, repo: "o/r", holder: { run, job: "j", sha: "base" }, now: () => 0, sleep: () => {}, log: () => {} });
  mk("1").acquire("org-staging");
  const stale = f.refs["refs/locks/org-staging"];
  assert.equal(mk("2").acquire("org-staging"), true);
  assert.match(f.commits[f.refs["refs/locks/org-staging"]].message, /"run":"2"/);
  // a second waiter that saw the same stale holder loses the fast-forward race
  const loser = f.api("PATCH", "repos/o/r/git/refs/locks/org-staging", { sha: f.api("POST", "repos/o/r/git/commits", { message: "{}", tree: "T", parents: [stale] }).sha, force: false });
  assert.equal(loser.status, 422);
});

test("lane park (#236): busy, the job parks and gives its runner back; the same kind twice is dropped; a release between looks is caught", () => {
  const f = fakeRefs();
  let t = 1000;
  const waits = [];
  const mk = (run, job) => lane({ api: f.api, repo: "o/r", holder: { run, job, sha: "base" }, now: () => t++, sleep: () => {}, log: () => {}, onWait: (h) => waits.push(h.run) });
  const realApi = f.api;
  f.api = (m, path, body) => (/actions\/jobs\/22$/.test(path) ? { run_id: 2, name: "fix", status: "completed", run_attempt: 1 }
    : /actions\/runs\/2$/.test(path) && m === "GET" ? { path: ".github/workflows/ai-fix.yml", event: "workflow_dispatch", run_attempt: 1, status: "completed" } : realApi(m, path, body));
  const ui = mk("1", "write#1"), fix = mk("2", "fix#1"), fix2 = mk("3", "fix#1");
  assert.deepEqual(ui.park("org-issue-9", { kind: "write", jobId: "11" }), { held: true }, "free: held at once");
  const p = fix.park("org-issue-9", { kind: "fix", jobId: "22" });
  assert.equal(p.parked, true);
  assert.equal(p.waitingFor.run, "1");
  assert.deepEqual(waits, ["1"], "the card says who holds the org");
  assert.deepEqual(fix.waiters("org-issue-9").map((w) => [w.kind, w.run, w.jobId]), [["fix", "2", "22"]]);
  assert.equal(fix2.park("org-issue-9", { kind: "fix", jobId: "33" }).dropped, true, "a second fix while one waits");
  assert.equal(fix.waiters("org-issue-9").length, 1);
  assert.equal(fix.free("org-issue-9"), false, "the holder is still running");
  ui.release("org-issue-9");
  assert.equal(fix.free("org-issue-9"), true);
  // the holder lets go between the first look and the waiter ref: the second look takes the lane, no stray waiter
  const g = fakeRefs();
  const a = lane({ api: g.api, repo: "o/r", holder: { run: "5", job: "ci#1", sha: "base" }, now: () => 0, sleep: () => {}, log: () => {} });
  a.acquire("org-x");
  const racy = (m, path, body) => { const r = g.api(m, path, body); if (m === "POST" && path.endsWith("/git/refs") && body.ref.includes("lane-waits")) a.release("org-x"); return r; };
  const b = lane({ api: racy, repo: "o/r", holder: { run: "6", job: "fix#1", sha: "base" }, now: () => 0, sleep: () => {}, log: () => {} });
  assert.deepEqual(b.park("org-x", { kind: "fix", jobId: "7" }), { held: true });
  assert.equal(b.waiters("org-x").length, 0);
});

test("lane: a claim's time is when it was claimed, not when the waiting began (a 44-minute wait once left a 106-minute TTL)", () => {
  const f = fakeRefs();
  let t = 0;
  const first = lane({ api: f.api, repo: "o/r", holder: { run: "1", job: "ci#1", sha: "base" }, now: () => t, sleep: () => {}, log: () => {} });
  first.acquire("org-staging");
  const second = lane({ api: f.api, repo: "o/r", holder: { run: "2", job: "staging#1", sha: "base" }, now: () => t, sleep: (ms) => { t += ms; if (t > 44 * 60e3) first.release("org-staging"); }, log: () => {} });
  second.acquire("org-staging", { timeoutMinutes: 60 });
  const at = Date.parse(JSON.parse(f.commits[f.refs["refs/locks/org-staging"]].message).at);
  assert.ok(at > 44 * 60e3, `claimed at ${at / 60e3} min`);
});

test("lane wake (#236): real parked jobs of free lanes are re-run once their run has ended; a forged waiter never is", () => {
  const f = fakeRefs({ runs: { 1: "completed" } });
  const runs = { 2: { path: ".github/workflows/ai-fix.yml", event: "workflow_dispatch", run_attempt: 1, st: ["in_progress", "completed"] },
    3: { path: ".github/workflows/ui-test.yml", event: "workflow_dispatch", run_attempt: 1, st: ["completed"] },
    4: { path: ".github/workflows/release.yml", event: "workflow_dispatch", run_attempt: 1, st: ["completed"] } };
  const jobs = { 22: { run_id: 2, name: "fix", status: "completed", run_attempt: 1 }, 33: { run_id: 3, name: "write", status: "completed", run_attempt: 1 },
    44: { run_id: 4, name: "fix", status: "completed", run_attempt: 1 }, 55: { run_id: 5, name: "run", status: "completed", run_attempt: 1 } };
  const calls = [];
  const api = (m, path, body) => {
    let x;
    if (m === "GET" && (x = /actions\/runs\/(\d+)$/.exec(path)) && runs[x[1]]) { const r = runs[x[1]]; return { ...r, status: r.st.length > 1 ? r.st.shift() : r.st[0] }; }
    if (m === "GET" && (x = /actions\/jobs\/(\d+)$/.exec(path))) return jobs[x[1]] || { status: 404 };
    if (m === "POST" && path.includes("/actions/jobs/")) { calls.push(path.split("/")[5]); return {}; }
    return f.api(m, path, body);
  };
  const claim = (run) => f.api("POST", "repos/o/r/git/commits", { message: JSON.stringify({ run, job: "ci#1" }), tree: "T", parents: [] }).sha;
  f.api("POST", "repos/o/r/git/refs", { ref: "refs/locks/org-x", sha: claim("1") });   // its run has ended: free to take over
  f.api("POST", "repos/o/r/git/refs", { ref: "refs/locks/org-busy", sha: claim("9") });   // still running
  for (const r of ["org-x/5-fix-2-22", "org-x/6-write-3-33", "org-x/7-fix-4-44", "org-x/8-run-5-55", "org-busy/1-run-3-33"]) f.api("POST", "repos/o/r/git/refs", { ref: `refs/lane-waits/${r}`, sha: "base" });
  const l = lane({ api, repo: "o/r", holder: {}, now: () => 5, sleep: () => {}, log: () => {} });
  let t = 0, slept = 0;
  const woken = wakeAll({ api, repo: "o/r", l, sleep: () => { slept++; t += 15e3; }, now: () => t });
  assert.deepEqual(woken.map((w) => w.jobId), ["22", "33"], "every real waiter of the free lane, oldest first");
  assert.deepEqual(calls, ["22", "33"], "a release job (forged ref) and an unknown job are never re-run");
  assert.equal(slept, 1, "waited for the parked run to end");
  assert.deepEqual(Object.keys(f.refs).filter((r) => r.includes("lane-waits")), ["refs/lane-waits/org-busy/1-run-3-33"], "forged refs removed; the busy lane's waiter stays");
  assert.equal(waiterJob(api, "o/r", { kind: "fix", run: "2", jobId: "33" }), "bad", "a job of another run");
  jobs[22].run_attempt = 1; runs[2].run_attempt = 2;
  assert.equal(waiterJob(api, "o/r", { kind: "fix", run: "2", jobId: "22" }), "bad", "its run was re-run since");
  const list = { jobs: [{ id: 1, status: "completed", runner_name: "r1" }, { id: 2, status: "in_progress", runner_name: "r2" }, { id: 3, status: "in_progress", runner_name: "r3" }] };
  assert.equal(jobId({ api: () => list, repo: "o/r", env: { GITHUB_RUN_ID: "1", RUNNER_NAME: "r2" } }), "2");
  assert.equal(jobId({ api: () => ({ status: 403 }), repo: "o/r", env: { RUNNER_NAME: "r2" } }), null, "unknown: the job waits the old way");
});

test("lane: a holder is stale by its own attempt, so a re-run of its run does not revive a dead claim", () => {
  const f = fakeRefs();
  const api = (m, path, body) => (m === "GET" && /actions\/runs\/7\/attempts\/1$/.test(path) ? { status: "completed" } : m === "GET" && /actions\/runs\/7$/.test(path) ? { status: "in_progress" } : f.api(m, path, body));
  lane({ api, repo: "o/r", holder: { run: "7", job: "write#1", sha: "base" }, now: () => 0, sleep: () => {}, log: () => {} }).acquire("org-y");
  const run2 = lane({ api, repo: "o/r", holder: { run: "7", job: "run#2", sha: "base" }, now: () => 0, sleep: () => {}, log: () => {} });
  assert.equal(run2.free("org-y"), true);
  assert.deepEqual(run2.park("org-y", { kind: "run", jobId: "70" }), { held: true }, "taken over from the dead attempt");
});

test("lane: a claim that cannot be written is said and retried, never mistaken for waiting; five in a row fail", () => {
  const f = fakeRefs();
  const logs = [];
  const mk = () => lane({ api: f.api, repo: "o/r", holder: { run: "9", job: "ci", sha: "gone" }, now: () => 0, sleep: () => {}, log: (m) => logs.push(m) });
  f.failClaims(2);
  assert.equal(mk().acquire("org-staging"), true);
  assert.equal(logs.filter((m) => /could not write the claim \(422: tree not found\)/.test(m)).length, 2);
  mk().release("org-staging");
  f.failClaims(9);
  assert.throws(() => mk().acquire("org-staging"), /5 times in a row/);
});

test("lane: a waiting poll is one read of the lock (holder read once, its run checked every few minutes)", () => {
  const f = fakeRefs();
  let t = 0, calls = [];
  const api = (m, p, b) => { calls.push(`${m} ${p.split("/").slice(3).join("/")}`); return f.api(m, p, b); };
  const mk = (run) => lane({ api, repo: "o/r", holder: { run, job: "j", sha: "base" }, now: () => t, sleep: (ms) => { t += ms; }, log: () => {} });
  mk("1").acquire("org-issue-1");
  calls = [];
  assert.throws(() => mk("2").acquire("org-issue-1", { timeoutMinutes: 10, pollSeconds: 30 }));
  const polls = calls.filter((c) => c === "GET git/refs/locks/org-issue-1").length;
  assert.ok(polls >= 5 && polls <= 10, `polled ${polls} times in 10 minutes: backing off to 3 minutes keeps many waiters inside the API limit`);
  assert.ok(calls.length <= polls + 8, `${calls.length} calls for ${polls} polls`);
  assert.equal(calls.filter((c) => c.startsWith("POST")).length, 0, "no claim commit while the lane is busy");
});

test("clarity: a carried-over story says how to pick it up again; a waiting job puts 'waiting for the org' on the card", () => {
  const f = { ...open(fixture(23)), ai: {}, statuses: [], reviews: [] };
  const closed = storyCard({ key: "2", repoUrl: "https://github.com/o/r", branch: "issue-2", base: "release/w45", pr: { ...f.pr, state: "CLOSED" }, facts: f });
  assert.match(closed, /To work on it again, tick \*\*Start\*\*/);
  assert.match(closed, /act:start/);
  const fr = fakeRefs();
  const waits = [];
  let t = 0;
  const mk = (run, onWait) => lane({ api: fr.api, repo: "o/r", holder: { run, job: "ci#1", sha: "base" }, now: () => t, sleep: (ms) => { t += ms; }, onWait });
  mk("1").acquire("org-issue-2");
  assert.throws(() => mk("2", (h) => waits.push(h.job)).acquire("org-issue-2", { timeoutMinutes: 5 }));
  assert.deepEqual(waits, ["ci#1"], "said once per holder");
});

// Scenarios: real journeys replayed on the simulated code host (sim.mjs), with every invariant (invariants.mjs) checked
// after each step. A bug where two modules disagree (the card and /uat-pass, the gate and the journey) fails here, not
// in a live run. Cross-module behaviour is tested here first; unit tests stay for one module's own rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, rng } from "./sim.mjs";
import { violations, finish, observe, actAs, nextDeps } from "./invariants.mjs";
import { next } from "../src/journey.mjs";
import { finish as finishStage, reconcile } from "../src/finish.mjs";
import { STATUS } from "../src/gate.mjs";

process.env.PIPELINE_BOTS = "github-actions,__owner__-pipeline";
process.env.APPROVERS = "boss,deputy";
process.env.UAT_ENABLED = "true";
process.env.UAT_TESTERS = JSON.stringify({ tester: {} });
const ENV = { UAT_ENABLED: "true" };

/** Each step's name and the invariants that broke after it. */
async function play(w, pr, steps, env = ENV) {
  const broke = [];
  for (const [name, step] of steps) {
    await step();
    if (!w.state.prs[pr()]) continue;
    for (const v of await violations(w, pr(), env)) broke.push(`${name} -> ${v}`);
  }
  return broke;
}
const all = async (w, opts) => { let r; while ((r = w.take())) await finish(w, r, { env: ENV, ...opts }); };

/** finish() and reconcile() on the simulated world, as `pipe` wires them. */
const stageDeps = (w, env = ENV, cards = { refreshPr: async () => {} }) => {
  const d = nextDeps(w, env);
  return { host: d.host, gh: w.io.gh, cards, next: (after, pr) => next(after, pr, nextDeps(w, env)), record: () => {} };
};

/** A sprint with one story merged into its release branch, CI and staging passed, and the release PR not open yet. */
function sprint() {
  const w = world();
  w.branch("release/2027-w01");
  return w;
}

test("release 2027-w01 (#293) replayed: a spec fix during UAT redeploys UAT, nobody is called early, /uat-pass works", async () => {
  const w = sprint();
  const REL = 296;
  const steps = [
    ["the story merges into the sprint", async () => { w.push("release/2027-w01", ["force-app/main/default/lwc/followUp/followUp.js", "e2e/story-293.spec.ts", "data/seed/stories/293/plan.json"], { by: "github-actions" }); }],
    ["CI and staging pass", () => all(w)],
    ["the release PR opens", async () => { w.pr(REL, { head: "release/2027-w01", base: "main", author: "__owner__-pipeline" }); await next("release-pr", REL, nextDeps(w, ENV)); }],
    ["UAT deploys and the UI regression runs", () => all(w)],
    ["a person pushes a one-line spec fix to the release", async () => { w.push("release/2027-w01", ["e2e/story-293.spec.ts"], { by: "maintainer", headline: "Spec: tomorrow is 3 days out" }); }],
    ["CI and staging run on the fix", () => all(w)],
    ["the tester signs off in UAT", async () => { const r = await actAs(w, REL, "tester", "/uat-pass"); assert.ok(r.done, r.text); }],
    ["the approver approves", async () => { w.approve(REL, "boss"); }],
  ];
  const broke = await play(w, () => REL, steps);
  assert.deepEqual(broke, []);
  const o = observe(w, REL, ENV);
  assert.equal(o.decision.mergeable, true, o.decision.reasons.join("; "));
});

test("the two-person rule: a sign-off by the person who pushed the latest change does not count", async () => {
  const w = sprint();
  w.story("301", { approver: "boss" });
  w.push("issue-301", ["force-app/main/default/classes/A.cls"], { by: "dev", from: "release/2027-w01" });
  w.pr(31, { head: "issue-301", base: "release/2027-w01" });
  await all(w);
  w.approve(31, "dev");
  assert.match(observe(w, 31).decision.reasons.join(), /approval does not count/);
  w.approve(31, "boss");
  assert.deepEqual(await violations(w, 31), []);
  assert.equal(observe(w, 31).decision.mergeable, true);
});

test("fuzz: random pushes, runs, sign-offs and approvals on a release keep every invariant", async () => {
  const seeds = Number(process.env.FUZZ_SEEDS || 60);
  for (let seed = 1; seed <= seeds; seed++) {
    const r = rng(seed), w = sprint(), REL = 296, log = [];
    w.push("release/2027-w01", ["force-app/main/default/lwc/a/a.js"], { by: "github-actions" });
    await all(w);
    w.pr(REL, { head: "release/2027-w01", base: "main", author: "__owner__-pipeline" });
    await next("release-pr", REL, nextDeps(w, ENV));
    const moves = [
      ["push a spec", () => w.push("release/2027-w01", ["e2e/a.spec.ts"], { by: "dev" })],
      ["push Salesforce code", () => w.push("release/2027-w01", ["force-app/main/default/classes/B.cls"], { by: "github-actions" })],
      ["push docs", () => w.push("release/2027-w01", ["docs/x.md"], { by: "github-actions" })],
      ["finish a run", () => finish(w, w.take(), { env: ENV })],
      ["a run fails", () => finish(w, w.take(), { env: ENV, outcome: "failure" })],
      ["finish every run", () => all(w)],
      ["/uat-pass", () => actAs(w, REL, "tester", "/uat-pass")],
      ["/uat (redeploy)", () => actAs(w, REL, "tester", "/uat")],
      ["boss approves", () => w.approve(REL, "boss")],
      ["GitHub drops a run's event, then the janitor reconciles", async () => { await finish(w, w.take(), { env: ENV, drop: true }); if (!w.state.inflight.length) await reconcile(stageDeps(w)); }],
    ];
    for (let i = 0; i < 15; i++) {
      const [name, move] = moves[Math.floor(r() * moves.length)];
      await move();
      log.push(name);
      const broke = await violations(w, REL, ENV);
      assert.deepEqual(broke, [], `seed ${seed}, after: ${log.join(" > ")}`);
    }
  }
});

test("a story with the AI review and Claude's UI test: the UI test's own spec push reads as running, then it signs off and merges", async () => {
  const w = world({ aiReview: true }), AI = { ...ENV, AI_REVIEW: "true", AI_UI_TEST: "true", AI_AUTO_CHAIN: "true" };
  w.branch("release/2027-w01");
  w.story("301", { approver: "boss" });
  const one = () => finish(w, w.take(), { env: AI });
  const steps = [
    ["Claude builds the story and opens its PR", async () => { w.push("issue-301", ["force-app/main/default/lwc/followUp/followUp.js"], { by: "claude", from: "release/2027-w01" }); w.pr(31, { head: "issue-301", base: "release/2027-w01", author: "__owner__-pipeline" }); }],
    ["CI passes", one],
    ["the AI review passes, so Claude's UI test starts", one],
    ["the UI test pushes its spec", one],
    ["CI passes on the spec commit", () => finish(w, w.take((r) => r.workflow === "ci.yml"), { env: AI })],
    ["the UI test passes on its spec commit", one],
    ["the approver signs off", async () => { const r = await actAs(w, 31, "boss", "/ship"); assert.ok(r.done, r.text); }],
  ];
  assert.deepEqual(await play(w, () => 31, steps, AI), []);
  assert.deepEqual(w.state.inflight.map((r) => r.workflow), ["gate.yml"]);   // the sign-off starts the gate
  const o = observe(w, 31, AI);
  assert.equal(o.decision.mergeable, true, o.decision.reasons.join("; "));
});

test("the stuck check works: a dropped workflow_run after the spec fix leaves UAT owed with nothing to start it", async () => {
  const w = sprint(), REL = 296;
  w.push("release/2027-w01", ["force-app/main/default/lwc/a/a.js"], { by: "github-actions" });
  await all(w);
  w.pr(REL, { head: "release/2027-w01", base: "main", author: "__owner__-pipeline" });
  await next("release-pr", REL, nextDeps(w, ENV));
  await all(w);
  w.push("release/2027-w01", ["e2e/a.spec.ts"], { by: "dev" });
  await all(w, { drop: true });   // GitHub dropped the staging run's workflow_run event (13 Oct): nothing chains
  assert.match((await violations(w, REL, ENV)).join(), /2: stuck/);
});

test("fuzz: random pushes, runs and sign-offs on a story with every AI step keep every invariant", async () => {
  const seeds = Number(process.env.FUZZ_SEEDS || 60), AI = { ...ENV, AI_REVIEW: "true", AI_UI_TEST: "true", AI_AUTO_CHAIN: "true" };
  for (let seed = 1; seed <= seeds; seed++) {
    const r = rng(seed * 7919), w = world({ aiReview: true }), log = [];
    w.branch("release/2027-w01");
    w.story("301", { approver: "boss" });
    w.push("issue-301", ["force-app/main/default/lwc/a/a.js"], { by: "claude", from: "release/2027-w01" });
    w.pr(31, { head: "issue-301", base: "release/2027-w01", author: "__owner__-pipeline" });
    const moves = [
      ["a person pushes code", () => w.push("issue-301", ["force-app/main/default/lwc/a/a.js"], { by: "dev" })],
      ["a person pushes a spec", () => w.push("issue-301", ["e2e/story-301.spec.ts"], { by: "dev" })],
      ["finish a run", () => finish(w, w.take(), { env: AI })],
      ["a run fails", () => finish(w, w.take(), { env: AI, outcome: "failure" })],
      ["finish every run", () => all(w, { env: AI })],
      ["/ship by the approver", () => actAs(w, 31, "boss", "/ship")],
      ["/ship by the pusher", () => actAs(w, 31, "dev", "/ship")],
    ];
    for (let i = 0; i < 15; i++) {
      const [name, move] = moves[Math.floor(r() * moves.length)];
      await move();
      log.push(name);
      assert.deepEqual(await violations(w, 31, AI), [], `seed ${seed}, after: ${log.join(" > ")}`);
    }
  }
});

test("finish: the verdict first, then the gate, the card and what is owed next, always in that order", async () => {
  const w = world({ aiReview: true }), AI = { ...ENV, AI_REVIEW: "true", AI_UI_TEST: "true", AI_AUTO_CHAIN: "true" };
  w.branch("release/2027-w01");
  w.story("301", { approver: "boss" });
  const sha = w.push("issue-301", ["force-app/main/default/lwc/a/a.js"], { by: "claude", from: "release/2027-w01" });
  w.pr(31, { head: "issue-301", base: "release/2027-w01", author: "__owner__-pipeline" });
  await finish(w, w.take((r) => r.workflow === "ci.yml"), { env: AI });
  w.take((r) => r.workflow === "ai-review.yml");
  const actAsBoss = await actAs(w, 31, "boss", "/ship");   // signed off before the review ended: the review's finish merges it
  assert.ok(actAsBoss.done);
  w.state.calls.length = 0; w.state.inflight.length = 0;
  const order = [];
  w.acting({ event: "workflow_run", branch: "main", workflow: "ai-review.yml" });
  await finishStage("review", { pr: 31, sha, outcome: "pass" }, stageDeps(w, AI, { refreshPr: async () => order.push("card") }));
  const calls = w.state.calls.map((c) => (/statuses\//.test(c) ? "status" : /workflow run gate\.yml/.test(c) ? "gate" : /workflow run/.test(c) ? "next" : null)).filter(Boolean);
  assert.deepEqual([calls.indexOf("status"), calls.indexOf("gate")].every((i) => i >= 0), true, w.state.calls.join("\n"));
  assert.ok(calls.indexOf("status") < calls.indexOf("gate"), "the verdict is on the commit before the gate reads it");
  assert.deepEqual(order, ["card"]);
  assert.equal(w.state.inflight.at(-1).workflow, "ui-test.yml", "then what is owed: Claude's UI test (the change is UI-facing)");
  assert.deepEqual(await violations(w, 31, AI), []);
});

test("reconcile: a dropped workflow_run is caught on the next tick, once; a PR with a run going is left alone", async () => {
  const w = sprint(), REL = 296;
  w.push("release/2027-w01", ["force-app/main/default/lwc/a/a.js"], { by: "github-actions" });
  await all(w);
  w.pr(REL, { head: "release/2027-w01", base: "main", author: "__owner__-pipeline" });
  await next("release-pr", REL, nextDeps(w, ENV));
  await all(w);
  w.push("release/2027-w01", ["e2e/a.spec.ts"], { by: "dev" });
  await all(w, { drop: true });
  assert.match((await violations(w, REL, ENV)).join(), /2: stuck/);
  const first = await reconcile(stageDeps(w));
  assert.deepEqual(first.find((x) => x.pr === REL).started, ["uat-deploy.yml"], "the staging run did the UI regression itself; UAT is what the dropped event never started");
  assert.deepEqual(await reconcile(stageDeps(w)), [{ pr: REL, skipped: "a run is going" }], "what it started is running: the next tick starts nothing");
  await all(w);
  assert.deepEqual(await violations(w, REL, ENV), []);
  assert.deepEqual((await reconcile(stageDeps(w))).find((x) => x.pr === REL).started, [], "nothing owed once UAT has the head");
});

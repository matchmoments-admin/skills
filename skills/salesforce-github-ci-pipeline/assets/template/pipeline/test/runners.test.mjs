// The CI runners against one contract (contracts/ci-runner.contract.mjs): GitHub Actions over recorded gh calls, and
// the fake the policy tests use, so the fake cannot drift from what a real runner does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ciRunnerContract } from "./contracts/ci-runner.contract.mjs";
import { fakeRunner } from "./fakes/runner.mjs";
import { actionsRunner, ACTIONS_JOBS } from "../src/runners/github-actions.mjs";
import { JOBS } from "../src/jobs.mjs";

/** GitHub Actions on a recorded repository: gh calls are kept, and the runs API answers from `runs`. */
function actions({ runs = {} }) {
  const calls = [];
  const workflowOf = (file) => Object.keys(ACTIONS_JOBS).find((j) => ACTIONS_JOBS[j].workflow === file);
  const api = (method, path) => {
    const m = path.match(/actions\/workflows\/([^/]+)\/runs\?(.*)$/);
    if (!m) return {};
    const dispatchedOnly = /event=workflow_dispatch/.test(m[2]);
    const list = (runs[workflowOf(m[1])] || []).filter((r) => !dispatchedOnly || r.dispatched);
    return { workflow_runs: list.map((r) => ({ id: r.id, display_title: r.title, status: r.active ? "in_progress" : "completed", conclusion: r.active ? null : r.conclusion, created_at: r.createdAt, event: r.dispatched ? "workflow_dispatch" : "push" })) };
  };
  const runner = actionsRunner({ io: { gh: (a) => calls.push(a) }, api, repo: "o/r", repoUrl: "https://github.com/o/r", env: { GITHUB_RUN_ID: "42" } });
  const started = () => calls.map((a) => {
    if (a[0] === "workflow") {
      const inputs = {}; for (let i = 0; i < a.length; i++) if (a[i] === "-f") { const [k, ...v] = a[i + 1].split("="); inputs[k] = v.join("="); }
      return [workflowOf(a[2]), inputs, a[a.indexOf("--ref") + 1]];
    }
    const type = a.find((x) => x.startsWith("event_type=")).slice("event_type=".length);
    const inputs = Object.fromEntries(a.filter((x) => x.startsWith("client_payload[")).map((x) => { const [k, ...v] = x.split("="); return [k.slice(15, -1), v.join("=")]; }));
    return [Object.keys(ACTIONS_JOBS).find((j) => ACTIONS_JOBS[j].event === type), inputs, "main"];
  });
  return { runner, started };
}

ciRunnerContract("GitHub Actions", actions);
ciRunnerContract("fake", ({ runs }) => { const r = fakeRunner({ runs }); return { runner: r, started: () => r.started }; });

test("GitHub Actions: every job has a way to start, and nothing else does", () => {
  assert.deepEqual(Object.keys(ACTIONS_JOBS).sort(), Object.keys(JOBS).sort());
});

test("GitHub Actions: a job started from a run with no actions: write goes as a repository_dispatch event", () => {
  const calls = [];
  const runner = actionsRunner({ io: { gh: (a) => calls.push(a.join(" ")) }, api: () => ({}), repo: "o/r", env: {} });
  runner.start("lane-wake");
  runner.start("issue-start", { key: "7", labels: "feature" });
  assert.deepEqual(calls, ["api repos/o/r/dispatches -f event_type=lane-freed", "api repos/o/r/dispatches -f event_type=jira-start -f client_payload[key]=7 -f client_payload[labels]=feature"]);
});

test("GitHub Actions: a run list it cannot read fails, never reads as no runs (the fix-round limit is counted from it)", () => {
  const runner = actionsRunner({ io: { gh: () => null }, api: () => ({ status: 403, message: "Resource not accessible by integration" }), repo: "o/r", env: {} });
  assert.throws(() => runner.runs("ai-fix", { dispatched: true }), /could not list ai-fix\.yml's runs \(403\)/);
});

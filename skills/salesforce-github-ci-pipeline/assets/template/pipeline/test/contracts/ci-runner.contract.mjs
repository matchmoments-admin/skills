// The CiRunner contract: what policy may rely on from any CI runner (runners/). Each adapter's test calls this with a
// factory: make({ runs }) -> { runner, started() }. runs: { [job]: [{ id, title, active, conclusion, createdAt,
// dispatched }] } is the runner's history; started() lists the jobs it was asked to start as [job, inputs, ref].
import { test } from "node:test";
import assert from "node:assert/strict";
import { JOBS } from "../../src/jobs.mjs";

export function ciRunnerContract(name, make) {
  test(`${name}: starts every job the pipeline names, on main unless a ref is given, with its inputs`, () => {
    const { runner, started } = make({});
    for (const job of Object.keys(JOBS)) runner.start(job, { pr: "7" });
    runner.start("staging", {}, { ref: "release/2027-w05" });
    const got = started();
    assert.deepEqual(got.map(([job]) => job), [...Object.keys(JOBS), "staging"]);
    assert.deepEqual(got.find(([job]) => job === "gate"), ["gate", { pr: "7" }, "main"]);
    assert.deepEqual(got.at(-1), ["staging", {}, "release/2027-w05"]);
  });

  test(`${name}: refuses a job that does not exist, instead of starting nothing`, () => {
    const { runner } = make({});
    assert.throws(() => runner.start("gate.yml"), /no such job: gate\.yml/);
  });

  test(`${name}: lists a job's runs in one shape: active or finished with a conclusion; dispatched ones when asked`, () => {
    const fix = [
      { id: 3, title: "ai-fix PR #9", active: true, conclusion: null, createdAt: "2026-11-10T03:00:00Z", dispatched: true },
      { id: 2, title: "ai-fix PR #9", active: false, conclusion: "failure", createdAt: "2026-11-10T02:00:00Z", dispatched: true },
      { id: 1, title: "ai-fix PR #9", active: false, conclusion: "success", createdAt: "2026-11-10T01:00:00Z", dispatched: false },
    ];
    const { runner } = make({ runs: { "ai-fix": fix } });
    const strip = ({ dispatched, ...r }) => r;
    assert.deepEqual(runner.runs("ai-fix"), fix.map(strip));
    assert.deepEqual(runner.runs("ai-fix", { dispatched: true }).map((r) => r.id), [3, 2]);
    assert.deepEqual(runner.runs("release"), []);
  });

  test(`${name}: names its own run, so a job can leave itself out of its history`, () => {
    const { runner } = make({});
    assert.equal(typeof runner.runId, "string");
    assert.ok(runner.runId.length > 0);
    assert.equal(typeof runner.agentRan(1), "boolean");
    assert.doesNotThrow(() => runner.publish({ outputs: { a: "1" }, summary: "done" }));
  });
}

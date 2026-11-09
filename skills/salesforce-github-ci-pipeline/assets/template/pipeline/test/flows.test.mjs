// Retired Flows (pipeline/src/org/flows.mjs): a Flow committed Obsolete or Draft is switched off after a deploy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retiredFlows, flowsMethods } from "../src/org/flows.mjs";
import { sfFrom } from "../src/io.mjs";

const flow = (status) => `<Flow><start><object>Case</object><triggerType>RecordBeforeSave</triggerType></start><status>${status}</status></Flow>`;
const recorded = (name) => readFileSync(new URL(`./fixtures/sf/${name}.json`, import.meta.url), "utf8");

function source(files) {
  const dir = mkdtempSync(join(tmpdir(), "flows-"));
  mkdirSync(join(dir, "main/default/flows"), { recursive: true });
  for (const [name, status] of Object.entries(files)) writeFileSync(join(dir, `main/default/flows/${name}.flow-meta.xml`), flow(status));
  return dir;
}

/** sf over recorded stdout: FlowDefinition queries answer from `active` (names still active), PATCH switches one off. */
function orgWith(active) {
  const ids = Object.fromEntries([...active].map((n, i) => [n, `300A${i}`]));
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args);
    if (args[0] === "api") {
      const id = args.find((a) => a.includes("/FlowDefinition/")).split("/").pop();
      assert.deepEqual(JSON.parse(readFileSync(args[args.indexOf("-b") + 1].slice(1), "utf8")), { Metadata: { activeVersionNumber: 0 } });
      active.delete(Object.keys(ids).find((n) => ids[n] === id));
      return recorded("rest-patch-flowdefinition");
    }
    const asked = [...args.find((a) => a.startsWith("SELECT")).matchAll(/'(\w+)'/g)].map((m) => m[1]);
    return JSON.stringify({ status: 0, result: { records: asked.filter((n) => active.has(n)).map((n) => ({ Id: ids[n], DeveloperName: n })) } });
  };
  return { calls, sf: sfFrom(run) };
}

test("retiredFlows: the Flows a source commits Obsolete or Draft, never an Active one", () => {
  const files = { "f/A.flow-meta.xml": flow("Obsolete"), "f/B.flow-meta.xml": flow("Active"), "f/C.flow-meta.xml": flow("Draft"), "f/D.trigger": "trigger D on Case (before insert) {}" };
  assert.deepEqual(retiredFlows(Object.keys(files), (p) => files[p]), ["A", "C"]);
});

test("retireFlows: switches off a retired Flow still active in the org (the deploy left it running), and a repeat does nothing", () => {
  const dir = source({ Case_Default_Web_Priority: "Obsolete", Lead_Set_Hot_Rating: "Active" });
  try {
    const org = orgWith(new Set(["Case_Default_Web_Priority", "Lead_Set_Hot_Rating"]));
    const logs = [];
    const m = flowsMethods({ sf: org.sf, log: (l) => logs.push(l) });
    assert.deepEqual(m.retireFlows("issue-9", dir), ["Case_Default_Web_Priority"]);
    assert.match(org.calls.find((a) => a[0] === "api").find((a) => a.startsWith("/services/")), /^\/services\/data\/v67\.0\/tooling\/sobjects\/FlowDefinition\/300A0$/);
    assert.ok(!org.calls.some((a) => a.join(" ").includes("Lead_Set_Hot_Rating") && a[0] === "api"), "an Active Flow is never touched");
    assert.match(logs[0], /switched off in issue-9 .*Case_Default_Web_Priority/);
    const before = org.calls.length;
    assert.deepEqual(m.retireFlows("issue-9", dir), []);
    assert.equal(org.calls.length - before, 1, "a repeat is one query");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("retireFlows: no retired Flow in the source means no call to the org; one that stays active fails loudly", () => {
  const none = source({ Lead_Set_Hot_Rating: "Active" });
  const stuck = source({ Case_Default_Web_Priority: "Obsolete" });
  try {
    const org = orgWith(new Set());
    assert.deepEqual(flowsMethods({ sf: org.sf, log: () => {} }).retireFlows("devhub", none), []);
    assert.equal(org.calls.length, 0);
    const stubborn = sfFrom((cmd, args) => (args[0] === "api" ? recorded("rest-patch-flowdefinition")
      : JSON.stringify({ status: 0, result: { records: [{ Id: "300A0", DeveloperName: "Case_Default_Web_Priority" }] } })));
    assert.throws(() => flowsMethods({ sf: stubborn, log: () => {} }).retireFlows("devhub", stuck), /Case_Default_Web_Priority still active in devhub/);
  } finally { rmSync(none, { recursive: true, force: true }); rmSync(stuck, { recursive: true, force: true }); }
});

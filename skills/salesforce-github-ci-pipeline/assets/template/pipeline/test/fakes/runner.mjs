// A CiRunner that runs nothing: it records each job started, and answers runs from what a test gives it.
import { job } from "../../src/jobs.mjs";

export function fakeRunner({ runs = {}, agentRan = () => true, runId = "1", runUrl = "u" } = {}) {
  const started = [];
  return {
    started, runId, runUrl,
    start(name, inputs = {}, { ref = "main" } = {}) { started.push([job(name), inputs, ref]); },
    runs: (name, { dispatched = false } = {}) => (runs[job(name)] || []).filter((r) => !dispatched || r.dispatched).map(({ dispatched: _, ...r }) => r),
    agentRan,
    publish() {},
  };
}
